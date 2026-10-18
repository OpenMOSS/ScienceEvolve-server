# Adding a Harness

[← Back to README](../README.md#configuration) · [Harness overview](../harness/README_en.md) · **English** | [简体中文](adding-a-harness.md)

ScienceEvolve registers code-level Adapters rather than loading arbitrary third-party plugins from requests or disk. Implement an Adapter with its own `HarnessDescriptor` and register that object once through `additionalAdapters` at the application composition root. Registry, Catalog, Gateway matrix, and frontend derive their metadata from the descriptor. Orchestrator, Project Explainer, Protocol Router, and React pages should not change or add Harness-ID branches.

## 1. Declare capabilities and metadata

The Adapter's `descriptor` is its sole registration payload. The table in `registry.ts` maintains bundled Harnesses only; extension Adapters do not duplicate metadata there.

- Use a unique, safe lowercase `id` of 1–64 characters.
- Declare label, Adapter version, native protocol, executable environment variables, and default command.
- Explicitly declare supported `workflow`, `explainer`, and `probe` purposes. Only Adapters enforcing strict read-only behavior may declare `explainer`.
- Production Adapters must support durable sessions and official structured events. Capability fields must match the implementation.
- Extensions cannot declare `default: true`; the production Registry already has exactly one default.

`capabilities.explainerInputFormats` declares actual read-only Explainer input formats: `text`, `image`, and/or `pdf`. It must include `text` with no duplicates. Omission means text only. Uploading/staging a binary does not prove model access to its content. Recommendations use this metadata to flag unreadable attachments rather than infer capability from Harness names. Declaring a format does not replace actual validation on the target gateway/model.

Registry validates ID uniqueness, descriptor conflicts, purpose/capability consistency, and required durable-session/official-event support. Catalog automatically publishes a frontend-safe projection, excluding executable paths, environment-variable names, and route internals. Frontend choices, labels, availability reasons, and native protocols come from Catalog rather than new page-level Harness constants.

## 2. Implement the Adapter

Add an implementation of `HarnessAdapter` in `server/src/harness-runtime/adapters/`:

1. Resolve the executable and generate its fingerprint.
2. Compile shared `InvocationSpec` into native CLI arguments, allowed environment additions, and temporary configuration.
3. Implement native session creation, resume-ID validation, and compatibility-period dual-write conversion of legacy IDs. Shared `SessionCoordinator` and SessionRef validators own persisted schema, Harness, Adapter version, generation, and durable consistency. The Adapter owns native ID format only.
4. Launch CLI processes only through `context.processHost`, the Facade-bound `InvocationProcessHost` for the current invocation. It owns cancellation, process-tree/marker lifecycle, authoritative environment boundaries, and invocation recovery budgets. Adapters must not construct/retain `CommonProcessHost`, call `recoveryBudget.startAttempt`, or spawn directly. The shared host counts each native launch. Pi's MCP bridge is the sole explicit Adapter subprocess exception, with an allowlisted environment rather than all of `process.env`.
5. Consume official CLI JSONL, stream-json, or SDK events through `OfficialEventBridge`.
6. Shallow-map official fields to assistant, tool, usage, activity, and diagnostic events.

`LaunchPlan` requires an absolute executable path, current invocation workspace as cwd, current SessionRef, bounded logs, and shared-runtime-generated environment. Adapter-specific nonsensitive keys belong in `adapterEnvironmentKeys`. The shared host checks Gateway tokens, control capabilities, project/Agent identity, and workspace paths individually. Adapters cannot override or leak host credentials.

Do not infer tool calls from natural language/stderr, replay model tool calls, execute model-selected tools independently, or store hidden reasoning. Tool previews use shared redaction and the 40,000-character limit. Broken official event channels fail with stable errors.

All invocations receive a read-only Inbox mirror inside the workspace and a `Memory.md` path from the shared input layer. Adapters see a reduced invocation view without authoritative Inbox paths in `messages/`, raw Gateway credentials, other Agents' configuration, or host Skill paths. Mirrors are not authoritative recovery/dispatch evidence. Main is permanently durable; Workers follow `sessionPersistence`. Failed resume can create a next generation only within the same Harness.

If a CLI lacks native user-input events, optionally implement `readNativeNotification`. Bounded checks of the current Agent, cwd, and exact durable session's visible native user input return `NativeInputHistoryEvidence`: relative path, actual byte offset, line digest, and time. Native parsing stays inside the Adapter; it cannot inspect other host sessions or hidden reasoning. Facade connects this capability to receipt gates. Missing/mismatched evidence or an invocation that did not legitimately resume cannot auto-acknowledge notifications.

## 3. Register once at the composition root

Pass the Adapter in `additionalAdapters` when creating the Facade:

```ts
const runner = new HarnessRuntimeFacade({
  // Other shared runtime options...
  additionalAdapters: [new ExampleAdapter(exampleOptions)]
});
```

This is the sole production registration point. Do not separately modify Registry, Gateway Acceptance, business callers, or frontend, or select parameters outside Adapters by Harness ID. The `adapters` option replaces all built-ins for isolated contract tests only. Production extensions use `additionalAdapters` and preserve built-ins. Facade creates one `CommonProcessHost` and injects a bound `InvocationProcessHost` per invocation.

## 4. Satisfy the real smoke contract

Every production Adapter selectable for workflows must also support `probe`. Adapters with other purposes only do not enter the default Gateway smoke matrix. Shared smoke creates an isolated temporary project/workspace and starts the actual CLI through Facade's public `runSmoke`. The CLI must use a native read-only tool to read a fixed sentinel. Checks require official `tool.started`/`tool.completed` events with the same call ID and a final handoff containing the sentinel. Route probes establish protocol connectivity only and cannot replace Adapter smoke.

Cache identity includes:

- Harness ID and Adapter version.
- Executable fingerprint.
- Model and Gateway ID/revision/protocol.
- Native protocol and Router compatibility version.

## 5. Add official-event fixtures and contract tests

Add redacted official-event fixtures in `server/tests/fixtures/harness-events/`. Use synthetic IDs, paths, inputs, and outputs only; exclude user prompts, credentials, actual paths, and hidden chain of thought.

Connect the Adapter to the shared assertions in `harness-runtime-contract.ts`, covering at least:

- Stable call IDs across tool started → updated/result → completed/failed.
- Assistant handoff, usage, activity heartbeat, broken event streams, empty results.
- Durable create/resume, ephemeral execution, replacement generations within one Harness.
- Actual Main/Worker reading of Inbox and `Memory.md`.
- No weakening of workspace/compute/yolo prompts or native CLI permissions.
- Cancellation, abnormal exit, log limits, redaction, truncation, orphan cleanup.
- Sentinel smoke actually launching the target CLI.

Register a fifth test Adapter through `additionalAdapters` and verify coexistence with all four built-ins. Catalog, Gateway matrix, configuration validation, and canonical UI must work automatically without business branches. Directly test Facade's public `runSmoke`, beyond Adapter calls or fake route probes. After removing the test Adapter, historical projects using its ID must show unavailable rather than silently substitute the default.

For `explainer`, add real negative-boundary tests: reads inside the snapshot succeed; reads of the original workspace, sibling directories, user directories, system files, and symlink escapes fail, as do all writes. A prompt saying read-only or a mode permitting unrestricted filesystem reads is insufficient. If enforcement is unavailable, remove the purpose from Catalog and fail closed.

Architecture guards must retain these rules: only `harness-runtime/runtime.ts` constructs `CommonProcessHost`; concrete Adapters/Codex CLI drivers neither record recovery budgets directly nor retain the general host; no Adapter imports `node:child_process` except the Pi MCP bridge; business code contains no literal Harness-ID branches.

## 6. Validate

Run standard offline checks first:

```bash
npm run typecheck
npm test
npm run build
npm run acceptance:gateway:plan
```

Live Gateway Acceptance makes external requests and incurs costs. Run `npm run acceptance:gateway` only with explicit authorization and a confirmed target gateway/model. Use isolated ports and data directories rather than the running port-4310 project's data.
