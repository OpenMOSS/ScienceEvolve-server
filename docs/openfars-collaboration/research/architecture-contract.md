# Architecture, identity and compatibility research

[← Back to README](../../../README.md) · [中文首页](../../../README_zh-CN.md)

Research date: 2026-09-22 UTC
Baseline: `da25bdc4b264ef3bdd9bf1a6d140fba6c58d9ab2`
Scope: R0. No product code was changed during this research.

## Gate decision

R0 is **PASS and frozen for implementation** after independent re-audit. The v2 contract is in `../contracts/v2-contract.md`, three serialized examples exist, every known consumer is mapped, and migration/fail-closed behavior is explicit. The baseline product has not implemented that contract; a research PASS is not a product-acceptance claim.

The rejected baseline assumption is `AgentName == configured identity == routable node == execution`. v2 keeps the registry for compatibility but treats Agent, outer node, node run, group run, task, execution, invocation, PR and operation as separate logical identities. Existing names are stable locked ids in the first implementation; display labels may vary without changing branch/worktree/history ids.

## Selected shape

The least disruptive compatible representation adds `orchestration.schemaVersion: 2` and `collaborations[]`. `agents[]` remains the complete configuration registry, including group members. A shared selector derives outer nodes: Main, ungrouped Agents and collaborations. That selector—not a UI filter—is used by route validation, Main candidates, input/termination, layout, runtime and reconfiguration.

This representation was selected over replacing `agents[]` with parallel registry/node maps because it permits lossless v1 normalization and narrows the migration surface. It still preserves logical identity separation in runtime records. No runtime behavior may infer group membership or completion from coordinates or labels.

The frozen contract deliberately contains no goal prompt, selectable leader, nested group, member mirror node, group/member migration action or Main completion approval. `termination.agent` retains its legacy field name but is a v2 outer-node id. This avoids an unrelated wire break while validation changes its semantics.

## Leader and routing decision table

| Entry | Leader persisted for the group run |
| --- | --- |
| ordinary Agent directly routes to group | that source Agent |
| Main selects or directly activates group | Main |
| project input directly targets group | Main |
| group G routes to group H | Main, for both fixed and selected routes |

An acting coordinator after leader failure is a separate audited field and epoch. A leader has management capabilities and never a delivery/final-integration execution or PR. Member completion updates only the group. Group completion commits one route emission; it does not invoke `complete_project`. Existing normal-Agent weak-edge `decisionBy`, finish and termination behavior remains unchanged.

## Consumer audit

| Chain | Baseline coupling and required change |
| --- | --- |
| `server/src/types.ts` / `web/src/types.ts` | Route targets and active runtime are Agent/single-invocation typed. Add optional v2 configuration and normalized runtime records while preserving v1 reads. |
| `server/src/agent-orchestration.ts` | `canonicalizeMainRoutes` fans out to every Agent. It must use the outer-node selector and never reinsert members. |
| `server/src/validation.ts` | Create, draft, preset and orchestration schemas assume every Agent is a node. One validator must enforce membership, route and Git invariants at all entry points. |
| saved task / preset stores | Existing envelopes already use their own schema version. Orchestration version is independent; malformed legacy data gets a diagnostic instead of silent loss. |
| `server/src/orchestrator.ts` | Project loop and queue store one current Agent/invocation. Keep one active outer node but move group member executions to scoped records. |
| `server/src/agent-scheduler.ts` | `(projectId, kind)` ownership blocks a second same-project worker. Lease by execution and persist per-Agent FIFO/management purpose. |
| `server/src/storage.ts` | Project-wide invocation snapshots can erase sibling work. Use short scoped CAS records and append-only facts; see `state-recovery.md`. |
| control MCP/bridge | Candidates and revalidation name one Agent/invocation; terminal group action is absent. Add node/run/task/execution/epoch scope and a group-finalize action distinct from project completion. |
| workflow reconfiguration | Base hash is useful but does not freeze an active group revision. Store immutable run snapshots and reject edits affecting an active/unintegrated group. |
| event hub / app API / SSE | Extend envelopes with run/execution ownership; preserve global sequence and deduplicate request/event ids. |
| NewProject, editor, canvas, presets/drafts | Use the same v2 validator and outer-node selector. Group members are embedded rows, not geometric/routable nodes. |
| runtime canvas / Workspace / event hooks | Aggregate explicit member records; one member cannot overwrite a sibling. Git controls are read-only. |

The end-to-end dependency is:

```text
create / saved task / preset / dynamic proposal
  -> shared normalization + validation
  -> immutable workflow revision
  -> active NodeRun / optional GroupRun
  -> tasks + executions + operations
  -> scoped state/event/outbox commits
  -> API snapshot + SSE replay
  -> canvas/runtime/Git read-only projections
```

## v1 normalization and safe rollback

An orchestration with no v2 version is parsed strictly as v1 and normalized in memory with no collaborations and Git disabled. Agent order, routes, input/termination, decision plans, permissions, canvas, sessions, usage and artifacts are preserved. It is written as v2 only on an ordinary authorized save. Existing running v1 projects stay on the serial path until a safe boundary; there is no Git migration button or automatic repository creation.

Writers validate then emit v2. Old software that cannot understand v2 must reject it rather than omit collaborations and expose members as ordinary nodes. A rollout therefore uses an expand/contract sequence: dual reader, v2 writer, group feature. A rollback target must retain the dual reader. A group-bearing v2 state cannot be losslessly downgraded to the original v1 schema; it is frozen read-only rather than truncated.

Each node/group run retains its workflow/member/leader snapshot. Editing a completed group affects future runs only. The affected group remains locked through final-PR resolution, not merely until member processes finish.

## State and idempotency rules

- One project `activeNodeRunId` enforces serial outer execution.
- `activationRequestId` replay returns the same NodeRun; a deliberate repeat uses a new request and run.
- Retry remains in an execution lineage; handoff creates a new execution and ownership epoch.
- A group run holds a member snapshot, original leader, acting coordinator and coordinator epoch.
- Every external side effect has operation id, payload hash, expected head/base/epoch and observed remote fact.
- Final completion, immutable output and unique route-outbox record commit together.
- Events carry workflow and run/execution scope. Global event sequence is ordering, not a CAS token.

## Validation cases frozen before implementation

Valid cases include a lossless legacy workflow, an ordinary Git-enabled Agent task, input directly activating a taskless group, ordinary Agent→group, and group→group serial routing with Main as the second leader.

Invalid cases include duplicate group/Agent ids, Main membership, fewer than two members, one member in two groups, unknown member, nested group reference, member input/termination/route source/target, missing outer route target, group with Git off, active-group membership/topology edit, leader-owned delivery execution, and group completion through `complete_project`.

## Evidence and limitations

The frozen examples are:

- `../contracts/examples/legacy-serial.json`
- `../contracts/examples/git-agent-task.json`
- `../contracts/examples/collaboration-run.json`

`node docs/openfars-collaboration/contracts/validate-contract-examples.mjs`
completed 24/24 cross-record checks. It explicitly deep-compares the legacy Agent
definitions, input, routes, decision plans, intervention policy and termination;
verifies separate NodeRun and GroupRun identities; checks the ordinary Git task
contract; links every task, execution and PR; and checks member-only final
integration plus the group-branch-to-main final PR. The
validator SHA-256 is
`e9535e483e1817092266023071814595bedee06625686109008230ef211f035b`;
the result `/tmp/openfars-r0-contract-evidence.json` has SHA-256
`2ee69c3e91e7f2d63f0a6552f10ec83c51bb9dffd76f74e3ad118329085a45b8`.

Targeted baseline contract/runtime/canvas suites covered 19 files and 260 passing tests. They establish the old serial behavior to preserve; they do not prove v2. Implementation must add migration, identity, validation, concurrency, event and UI fixtures. R0 depends on R2 for real provider facts and on R1/R4 for native-process/permission enforcement, but no unresolved contract choice requires changing confirmed product behavior.
