import type {
  InvocationInputs,
  HarnessAdapter,
  HarnessEvent
} from "../src/harness-runtime/contracts.js";
import type { AgentRunRequest } from "../src/types.js";
import { TOOL_RESULT_PREVIEW_LIMIT } from "../src/harness-runtime/official-event-bridge.js";

export interface AdapterContractFixture {
  adapter: HarnessAdapter;
  probe: {
    model: string;
    reasoningEffort: "low" | "medium" | "high" | "xhigh";
  };
  sessionRequest: AgentRunRequest;
  sessionInputs: InvocationInputs;
  validNativeSessionId: string;
  expectedToolOutput: string;
  runOfficialFixture: () => Promise<HarnessEvent[]>;
}

/** Shared assertions every real Adapter and future fixture Adapter must satisfy. */
export async function exerciseAdapterContract(
  fixture: AdapterContractFixture
): Promise<void> {
  const { adapter } = fixture;
  if (!adapter.descriptor.capabilities.durableSession) {
    throw new Error(`${adapter.descriptor.id} must support durable sessions`);
  }
  if (!adapter.descriptor.capabilities.officialEvents) {
    throw new Error(`${adapter.descriptor.id} must expose official events`);
  }
  if (!adapter.descriptor.capabilities.toolEvents ||
    !adapter.descriptor.capabilities.toolResults ||
    !adapter.descriptor.capabilities.usageEvents) {
    throw new Error(`${adapter.descriptor.id} must expose tool/result/usage capabilities`);
  }
  if (!adapter.descriptor.purposes.includes("probe") || !fixture.probe.model.trim()) {
    throw new Error(`${adapter.descriptor.id} must expose a model-bound probe contract`);
  }
  const executable = await adapter.resolveExecutable();
  if (!executable) {
    throw new Error(`${adapter.descriptor.id} did not resolve its configured executable`);
  }
  const fingerprints = await Promise.all([
    adapter.fingerprint(executable),
    adapter.fingerprint(executable)
  ]);
  if (!fingerprints[0] || fingerprints[0] !== fingerprints[1]) {
    throw new Error(`${adapter.descriptor.id} emitted an unstable executable fingerprint`);
  }
  const durable = await adapter.createSession(
    fixture.sessionRequest,
    fixture.sessionInputs,
    7,
    true
  );
  const ephemeral = await adapter.createSession(
    fixture.sessionRequest,
    fixture.sessionInputs,
    7,
    false
  );
  for (const [expectedDurable, session] of [[true, durable], [false, ephemeral]] as const) {
    if (session.schemaVersion !== 1 ||
      session.harnessId !== adapter.descriptor.id ||
      session.adapterVersion !== adapter.descriptor.adapterVersion ||
      session.generation !== 7 ||
      session.durable !== expectedDurable ||
      !session.nativeId) {
      throw new Error(`${adapter.descriptor.id} violated the shared SessionRef contract`);
    }
  }
  if (!adapter.validateNativeSession?.(fixture.validNativeSessionId)) {
    throw new Error(`${adapter.descriptor.id} rejected its contract fixture native session ID`);
  }
  const durableFixture = { ...durable, nativeId: fixture.validNativeSessionId };
  const legacy = adapter.sessionToLegacyId?.(durableFixture);
  const resumed = legacy
    ? adapter.sessionFromLegacyId?.(legacy, durableFixture.generation, true)
    : undefined;
  if (!legacy || !resumed || resumed.nativeId !== fixture.validNativeSessionId ||
    resumed.harnessId !== adapter.descriptor.id || !resumed.durable) {
    throw new Error(`${adapter.descriptor.id} failed its durable legacy resume round trip`);
  }
  const events = await fixture.runOfficialFixture();
  const replayedEvents = await fixture.runOfficialFixture();
  if (events.length === 0) {
    throw new Error(`${adapter.descriptor.id} emitted no canonical events`);
  }
  if (new Set(events.map((event) => event.eventId)).size !== events.length) {
    throw new Error(`${adapter.descriptor.id} emitted duplicate canonical event IDs`);
  }
  events.forEach((event, index) => {
    if (event.schemaVersion !== 1 || event.harnessId !== adapter.descriptor.id) {
      throw new Error(`${adapter.descriptor.id} emitted an event outside its canonical envelope`);
    }
    if (event.seq !== index || !event.eventId.endsWith(`:${adapter.descriptor.id}:${index}`)) {
      throw new Error(`${adapter.descriptor.id} emitted unstable canonical sequencing`);
    }
    if (Number.isNaN(Date.parse(event.timestamp))) {
      throw new Error(`${adapter.descriptor.id} emitted an invalid canonical timestamp`);
    }
    if (event.tool?.outputPreview &&
      event.tool.outputPreview.length > TOOL_RESULT_PREVIEW_LIMIT) {
      throw new Error(`${adapter.descriptor.id} exceeded the tool preview limit`);
    }
    if (event.kind.startsWith("tool.") && event.tool?.status !== event.kind.slice("tool.".length)) {
      throw new Error(`${adapter.descriptor.id} emitted mismatched tool kind/status`);
    }
  });
  const stableProjection = (items: HarnessEvent[]) => items.map((event) => ({
    eventId: event.eventId,
    seq: event.seq,
    kind: event.kind,
    callId: event.tool?.callId
  }));
  if (JSON.stringify(stableProjection(events)) !== JSON.stringify(stableProjection(replayedEvents))) {
    throw new Error(`${adapter.descriptor.id} did not produce stable IDs/seq on fixture replay`);
  }
  const starts = events.filter((event) => event.kind === "tool.started");
  const updates = events.filter((event) => event.kind === "tool.updated");
  const finishes = events.filter((event) =>
    event.kind === "tool.completed" || event.kind === "tool.failed"
  );
  for (const start of starts) {
    const finish = finishes.find((event) => event.tool?.callId === start.tool?.callId);
    if (!start.tool?.callId || !finish) {
      throw new Error(`${adapter.descriptor.id} left tool ${start.tool?.callId} unfinished`);
    }
    if (finish.seq <= start.seq) {
      throw new Error(`${adapter.descriptor.id} completed a tool before it started`);
    }
    if (finish.tool?.outputPreview !== fixture.expectedToolOutput) {
      throw new Error(`${adapter.descriptor.id} did not expose the normalized sentinel result`);
    }
  }
  for (const update of updates) {
    const start = starts.find((event) => event.tool?.callId === update.tool?.callId);
    const finish = finishes.find((event) => event.tool?.callId === update.tool?.callId);
    if (!start || !finish || update.seq <= start.seq || update.seq >= finish.seq) {
      throw new Error(`${adapter.descriptor.id} emitted an unpaired tool update`);
    }
  }
  const handoffs = events.filter((event) =>
    event.kind === "assistant.message" && Boolean(event.message?.trim())
  );
  if (handoffs.length !== 1) {
    throw new Error(`${adapter.descriptor.id} must emit one final assistant handoff`);
  }
  const usage = events.filter((event) => event.kind === "usage");
  if (usage.length !== 1 || usage[0]?.usage?.protocol !== adapter.descriptor.nativeProtocol) {
    throw new Error(`${adapter.descriptor.id} must emit one native-protocol usage event`);
  }
  if (events.some((event) => event.kind === "activity" && (
    event.message !== undefined || event.sourceType !== undefined || event.tool !== undefined
  ))) {
    throw new Error(`${adapter.descriptor.id} attached a body to an activity heartbeat`);
  }
  if (/hidden reasoning|chain[- ]of[- ]thought|raw_reasoning/i.test(JSON.stringify(events))) {
    throw new Error(`${adapter.descriptor.id} exposed hidden reasoning`);
  }
}
