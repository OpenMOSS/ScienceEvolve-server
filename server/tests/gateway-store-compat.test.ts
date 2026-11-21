import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, expect, it, vi } from "vitest";
import { GatewayStore, type GatewayStoreOptions } from "../src/agent-runtime.js";
import { createApp } from "../src/app.js";
import { EventHub } from "../src/event-hub.js";
import { ensureGatewayReasoningDiscovery } from "../src/gateway-store-compat.js";
import type { Orchestrator } from "../src/orchestrator.js";
import { SkillCatalog } from "../src/skill-catalog.js";
import { ProjectStorage } from "../src/storage.js";

const roots: string[] = [];
const stores: GatewayStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map(store => store.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

// Reproduce the pre-discovery SDK's instance layout and missing API without
// depending on a sibling checkout or installing a historical runtime package.
function legacyStore(root: string, options: GatewayStoreOptions = {}): GatewayStore {
  const current = new GatewayStore(root, options);
  const prototype = Object.create(Object.prototype);
  for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(GatewayStore.prototype))) {
    if (name !== "scheduleReasoningDiscovery") Object.defineProperty(prototype, name, descriptor);
  }
  const state = Object.getOwnPropertyDescriptors(current);
  const legacy = Object.create(prototype, Object.fromEntries(
    ["root", "mutationTail", "fetchImpl", "resolveHostname", "timeoutMs", "adapterSmokeProbe"]
      .map(key => [key, state[key]])
  )) as GatewayStore;
  stores.push(legacy);
  return legacy;
}

async function fixture(options: GatewayStoreOptions = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-compat-")); roots.push(root);
  const eventHub = new EventHub(), storage = new ProjectStorage(root, eventHub);
  await storage.initialize();
  const store = legacyStore(root, options);
  expect(typeof store.scheduleReasoningDiscovery).toBe("undefined");
  const app = createApp({ orchestrator: {} as Orchestrator, storage, eventHub, gatewayStore: store,
    skills: new SkillCatalog([]), config: { modelSuggestions: [], maxEventHistory: 2 } });
  return { app, store };
}

const input = { name: "FNLP", url: "https://gateway.example/v1", apiKey: "private-fixture-key",
  protocol: "responses", models: ["model"], defaultModel: "model" };

it("upgrades an injected legacy store so save and refresh publish verified reasoning", async () => {
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (body.reasoning?.effort && !["low", "medium", "high"].includes(body.reasoning.effort)) {
      return Response.json({ error: { message: "Invalid reasoning.effort: expected 'low', 'medium', 'high'" } }, { status: 400 });
    }
    return Response.json({ output: [] });
  });
  const { app, store } = await fixture({ fetch: fetchImpl, resolveHostname: async () => ["93.184.216.34"] });
  const created = await request(app).post("/api/gateways").send(input).expect(201);
  const id = created.body.gateway.id as string;
  expect(JSON.stringify(created.body)).not.toContain(input.apiKey);
  await vi.waitFor(async () => expect((await store.get(id))?.reasoningDetection?.model?.status).toBe("verified"));
  await request(app).put(`/api/gateways/${id}`).send({ ...input, name: "FNLP updated" }).expect(200);
  const refreshed = await request(app).post(`/api/gateways/${id}/reasoning/refresh`).expect(200);
  expect(refreshed.body.gateway.name).toBe("FNLP updated");
  await vi.waitFor(async () => expect((await store.get(id))?.reasoningDiscovery).toBeUndefined());
  const listed = await request(app).get("/api/gateways").expect(200);
  expect(listed.body.gateways[0].reasoningDetection.model.status).toBe("verified");
  expect(JSON.stringify(listed.body)).not.toContain(input.apiKey);
  expect(fetchImpl).toHaveBeenCalled();
});

it("preserves identity, pending mutations, credentials and network/probe settings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gateway-compat-state-")); roots.push(root);
  const fetchImpl = vi.fn(), resolveHostname = vi.fn();
  const store = legacyStore(root, { fetch: fetchImpl, resolveHostname, testTimeoutMs: 1234 });
  const probe = { marker: "existing adapter" };
  Reflect.set(store, "adapterSmokeProbe", probe);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  Reflect.set(store, "mutationTail", pending);
  expect(ensureGatewayReasoningDiscovery(store)).toBe(store);
  expect(Reflect.get(store, "mutationTail")).toBe(pending);
  expect(Reflect.get(store, "fetchImpl")).toBe(fetchImpl);
  expect(Reflect.get(store, "resolveHostname")).toBe(resolveHostname);
  expect(Reflect.get(store, "timeoutMs")).toBe(1234);
  expect(Reflect.get(store, "adapterSmokeProbe")).toBe(probe);
  const saved = store.create({ ...input, autoReasoning: false });
  release();
  const gateway = await saved;
  expect((await store.scheduleReasoningDiscovery(gateway.id)).reasoningDiscovery).toBeUndefined();
  expect((await store.get(gateway.id))?.apiKey).toBe(input.apiKey);
  expect(fetchImpl).not.toHaveBeenCalled();
});

it("leaves an existing current store untouched and is idempotent", () => {
  const store = new GatewayStore("unused"); stores.push(store);
  const before = Object.getOwnPropertyDescriptors(store);
  expect(ensureGatewayReasoningDiscovery(store)).toBe(store);
  expect(ensureGatewayReasoningDiscovery(store)).toBe(store);
  expect(Object.getOwnPropertyDescriptors(store)).toEqual(before);
});

it("rejects an incompatible injected object before serving requests", () => {
  expect(() => ensureGatewayReasoningDiscovery({} as GatewayStore)).toThrow("missing storage root");
});
