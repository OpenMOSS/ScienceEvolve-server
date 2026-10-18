# UI, compatibility and acceptance code map

[← Back to README](../../../README.md) · [中文首页](../../../README_zh-CN.md)

Research date: 2026-09-22 UTC
Baseline: `da25bdc4b264ef3bdd9bf1a6d140fba6c58d9ab2`
Scope: R7 and the UI half of R8. Product code was not changed for this map.

## Decision

R7 is **PASS for implementation research after independent re-audit**. The existing canvas has a strong semantic/presentation boundary and can be extended without replacing it. The selected interaction is one outer group card with embedded, expandable member rows; routing ports belong only to the group card. Runtime Git and PR information is read-only. Existing v1 projects remain visually and behaviorally serial, with Git off. Product/UI acceptance remains intentionally unclaimed until the integrated real application is exercised and its screenshots are opened and inspected.

## Existing consumer map

| Surface | Current behavior | Required v2 change |
| --- | --- | --- |
| `web/src/types.ts` | Route targets and input/termination are Agent names; project runtime exposes one current Agent. | Mirror the shared node/group/run/task/execution/Git contracts exactly; keep optional fields for v1 reads. |
| `web/src/pages/NewProjectPage.tsx` | Owns Agent map, orchestration, preset/draft load, compact/full canvas, validation and create request. | Add explicit Git opt-in and group configuration; use shared validator; reject group+Git-off; never ask for leader/goal/mandatory group target. |
| `web/src/components/workflow-canvas/core/canvas-adapter.ts` | Maps every `orchestration.agents` entry to an outer card. | Map outer node definitions instead; exclude member Agents and emit one `kind: group` card containing member summaries. |
| `core/canvas-model.ts` | Node kinds are input/agent/finish. | Add group render metadata while keeping semantic data outside layout. Members are not independent `CanvasNode`s. |
| `core/canvas-layout.ts` and layout report/viewport files | Node ids drive coordinates, edge ports, routing and overlap checks. | Treat group id as the only geometric node. Group height may expand; measured size already flows through edge routing. Remove stale member coordinates during v2 normalization without altering v1 layouts. |
| `CanvasNodes.tsx` | Generic cards render badges, runtime state and outer ports. | Render group badge, aggregate state and expandable member rows. Hide member ports and edit/move affordances. Preserve keyboard selection and measured resize. |
| `CanvasInspector.tsx` | Inspector edits one Agent and edges whose targets are Agents. | Group inspector selects members, shows validation and read-only active-run lock; edge selectors use outer nodes only. |
| `WorkflowCanvasEditor.tsx` | Adds/removes/renames Agents and routes; compact/full modes share the model. | Add/remove group definitions and membership atomically; prevent member outer connections; block affected group edits until final integration resolves. |
| `core/workflow-runtime.ts` | Runtime is derived from events and one current/queued Agent. | Prefer explicit node/group/member execution fields; aggregate member states to the group and retain per-member detail across SSE replay. |
| `WorkflowCanvasRuntime.tsx` / `AgentCallGraph.tsx` | Read-only canvas and call details. | Show group aggregate plus member tasks/executions, resident/waiting/retrying/handoff states and PR facts. |
| `WorkspacePage.tsx` | Main project progress, events, artifacts and intervention surfaces. | Add read-only repository/branch/worktree/PR panels and diagnostics. No merge, revert, delete or cleanup buttons. |
| `web/src/api.ts` / event hooks | Project create/read/events use v1 shapes. | Serialize v2 create input; consume authoritative Git/runtime projections and execution-owned SSE fields. |
| presets, saved tasks and tests | Clone and round-trip v1 orchestration. | Preserve missing v2 fields and add v2 fixtures; never silently enable Git during load/migration. |

## Eight-Agent acceptance fixture

The canonical editor fixture has ordinary Agents `a` through `h`, with `a` and `b` assigned to group `research_group`. The outer semantic nodes are exactly `main`, `research_group`, `c`, `d`, `e`, `f`, `g`, `h` plus input/finish anchors. Neither `a` nor `b` appears as a canvas node, edge source, edge target, Main dispatch candidate or termination Agent. Expanded member rows inside `research_group` show both Agents and their configuration/status.

The fixture is exercised in compact and full layouts, preset/draft round trips, editor reload and runtime SSE reconstruction. Illegal fixture variants cover one member in two groups, member-to-outer edges, group nesting, duplicate group ids, missing members, Main membership, and a group while Git is disabled.

The frozen executable fixtures are `fixtures/eight-agent-v2.json` and
`fixtures/legacy-git-off-ui.json`; the validator is `validate-fixtures.mjs`. Running

```text
node docs/openfars-collaboration/research/validate-fixtures.mjs
```

produced 58/58 passing assertions. It proves the exact outer/canvas sets and Main
system fan-out in compact/full layouts; absence of member
geometry/routes/input/termination/Main candidates; eleven invalid mutations;
preset/draft/editor reload; explicit wait/failure/handoff labels; immutable
membership; SSE out-of-order replay and duplicate suppression; read-only Git
navigation with no rendered merge/revert/delete/cleanup action; retained history
plus a 98% capacity warning; and a separate legacy Git-off serial canvas whose
Agent config, permissions, routes, termination, decision plans and layout survive
normalization and all three round trips.

The v2 fixture SHA-256 is
`81c6d2ac65a2475a347b7834c6389705c113faa71058ea2930bf0967ed5b7187`;
the legacy fixture SHA-256 is
`d10384fd68667fbffe55f06287d643b4abdc4daec5e16a1dc4b819a13ccb4cba`;
the validator SHA-256 is
`ccdcf8adde57af049901edc22172cc2f10c6eca370904ee6a1deb463a9d7b6a5`;
the machine result `/tmp/openfars-r7-fixture-evidence.json` has SHA-256
`27b1d7c5d249cf47619fdb0d4b1ed867af7e36654a0352c5fc77a21ce01b6a9c`.
Integrated product tests must consume this same fixture instead of recreating a
weaker look-alike.

The capacity case is not an arbitrary threshold-only mock. During research,
`df -P /inspire/qb-ilm2/project/cq-scientific-cooperation-zone/w26212` reported
`98%` used (`25,937,575,936` blocks available as reported), so the frozen UI fixture uses the
observed percentage and requires a warning while preserving history and exposing
no automatic cleanup control.

## Interaction decisions

- Creation uses an explicit “Git collaboration” switch, default off. Off preserves all v1 behavior and creates no repository. A group requires it on.
- “Create collaboration group” asks only for display name/id and at least two member Agents. There is no leader chooser: the caller is the temporary leader at runtime. There is no group goal field and input may contain only shared current state.
- Collapsed cards show member count and aggregate status. Expanded cards show identity, assigned task summary, resident/waiting state, branch and PR status. Expansion changes presentation only.
- The group owns all incoming/outgoing edges. Attempts to connect a member are impossible in UI and rejected by the server.
- During `working`, `waiting`, `pr_open`, `integrating` or unresolved failure, the inspector explains why membership/topology is locked. It unlocks only after the entire run, including final PR, is terminal; history keeps its immutable snapshot.
- Completion immediately follows the configured fixed route or asks Main only when normal weak-edge choice requires it. No “awaiting Main approval” badge or button exists.
- Error/wait/handoff labels are explicit: waiting authorization, waiting review, conflict repair, stop requested, waiting for stop, continuation pending, reassigned and frozen by Main failure.
- Repository, branches, worktrees, commit SHA and PR URLs/statuses are links/text only. Product cleanup is never implied by hiding old records.

## Runtime aggregation contract

The SSE consumer deduplicates by event identity and orders by global sequence. Events carry `nodeRunId`, optional `groupRunId`, `taskId`, `executionId`, invocation id and Agent id. A member's latest execution status never overwrites a sibling. Group aggregate rules are deterministic: an unreconciled failure or freeze wins; otherwise integrating/PR-waiting wins; otherwise any running member means running; all member tasks complete but final PR pending means integrating; only final integration completion means completed.

Refresh uses the project snapshot as the base and replays newer events. An already successful execution remains successful when a later supplemental execution begins. Deliberate repeated node invocation uses a new node-run identity; replay of the same activation request does not duplicate it.

## Visual acceptance plan

The final integrated application—not a static mock—will be started against controlled backend fixture data. Screenshots saved under the user-requested `temp` directory must include:

1. create page, Git off, legacy compact canvas;
2. Git on, full canvas with the eight-Agent/two-member group collapsed;
3. the same group expanded and selected, proving members do not appear outside;
4. invalid configuration diagnostic and active-group edit lock;
5. runtime concurrent member progress and waiting/PR states;
6. read-only repository/member PR/final PR details;
7. failure stop/handoff state;
8. a narrow viewport sufficient to check clipping and overflow.

Each image is opened after capture and checked for routing alignment, text overflow, occlusion, selected/focus state, forbidden controls and status accuracy. Any affected screen is recaptured after a fix. Exact application SHA, viewport, fixture/provenance, steps and paths are recorded in `acceptance/frontend-visual.md`.

## Test targets

- Adapter/model tests: outer node set, group/member separation, group size/ports, legacy fixture unchanged.
- Editor/page tests: Git default off, valid group create/save, every invalid membership case, no leader/goal controls, compact/full/preset/draft parity.
- Runtime tests: concurrent members, supplemental execution, waiting PR, failure handoff, final PR completion, SSE duplicate/reconnect.
- Workspace tests: read-only Git details, absence of merge/revert/delete, active-group edit lock and meaningful provider diagnostics.
- Existing canvas geometry/layout and NewProjectPage regressions remain in the required suite.

## Known implementation risk

The mature layout code enumerates `orchestration.agents` in several modules. Changing only the adapter would leave hidden member coordinates, route validation and layout reports inconsistent. The implementation must introduce one shared outer-node selector and migrate all semantic consumers together; CSS-only grouping is explicitly insufficient.
