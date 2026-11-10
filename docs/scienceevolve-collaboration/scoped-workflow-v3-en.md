# Workflows inside collaboration groups (v3)

[← Back to README](../../README.md#tutorial) · **English** | [简体中文](scoped-workflow-v3.md)

2026-09-30: production project entry points are connected. This guide describes v3. The v2 contract, research notes, and historical acceptance reports in this directory retain their original version-specific meaning and do not define v3 limitations.

## Usage

When creating a project, enable Git collaboration, select a valid GitHub account, and verify the selected Harness/gateway/model combination. Create a collaboration group on the canvas, select an existing Agent as Leader, and reference existing Agents as business nodes inside the group. This does not delete their outer Agent nodes or edges. Open the group node to edit its internal Workflow using the same edge, Loop, and layout tools. Use breadcrumbs or “返回父图” (return to parent graph) to navigate upward.

The root canvas's group properties panel can also select a destination and add outgoing edges, reusing drag-edge validation and undo. Runtime-locked groups remain uneditable. Editing outer edges does not change the internal graph or shared Agent configuration.

When saving and reloading nested configurations, Main's fixed routing follows explicit root Agent references and top-level groups. Shared parent/child membership does not change that projection. Child groups are not additional root destinations; invalid fixed edges remain rejected.

A group entry can start multiple parallel paths, such as 1→2→3, 4, and 5. Only the group entry can fan out in parallel. Internal paths retain strong-edge, weak-edge, and Loop semantics. A child group is a composite node and expands its entry paths only when executed. Group completion waits for required paths and their Git integration; no separate Join node is needed.

The running view reuses the same live canvas at the root and in every group. Selecting an Agent shows execution counts and its shared configuration. Counts within a group use the current execution batch for that reference; retry epochs do not double count or borrow state from other scopes or historical parent batches. All groups expose child nodes and navigation through the same right-side details panel.

Position, zoom, and pan persist per scope and affect display only. New layouts submitted by Main/Leader take precedence. Live node/edge changes and selected paths use the same rendering flow. Switching scope does not rebuild the canvas, and delayed clicks from an old scope cannot act on identically named references in the new one.

## Identity, capabilities, and queues

- All references share one Agent configuration, session, and fixed execution directory. Saving Agent settings inside a group warns that all references are affected; graph edges and layouts are independent.
- Valid arrivals for the same Agent execute serially in FIFO order. Different Agents may run concurrently. Failure blocks that Agent's queue and dependent successors, while independent paths under other identities continue.
- Main manages the root graph. Leaders manage only their own scope and direct child-group proxies. Management turns do no business work. Main or another existing Agent may lead a group but cannot also be a business node inside that same group. Valid outer business nodes remain available.
- Graph changes use formal `workflow.json` proposals, current execution authority, capability checks, and atomic commits. Main's global switch and each Leader's group switch control separate scopes. Static identity or an enabled switch alone cannot authorize edits during another type of invocation. Leader proposals reuse Main validation and cannot change out-of-scope identities, authorization switches, or locked fields.
- If one identity leads multiple levels, management calls also queue instead of concurrently invoking the same session. Nesting cannot bypass the project's maximum of 10 Agents or capacity limits.

## Hierarchical Git delivery

Each business execution has its own branch/PR, with safe branch switching inside that Agent's fixed directory. Main's primary workspace stays on project main. Unfinished or uncommitted business evidence must not be forcibly reset. Member PRs merge into the direct group branch; a child group's final PR merges into its parent group branch; a root group's final PR merges into the project target branch. Outer business Agents also deliver through separate PRs to the project target.

Successors unlock only after precise provider merge evidence and local target synchronization are confirmed. Each successor starts from the latest confirmed commit of its integration branch and receives predecessor results from the current successful epoch. Old reports, unmerged results, and skipped work do not count as success. Once required paths reach Finish, the controlled runtime records real completion in `workflow-results/<groupRunId>.json`. It does not start an extra summarizing Worker or manufacture delivery when there are no business code changes.

## Recovery and compatibility

Business failures escalate from the group's Leader through parent Leaders, global Main, then the user. Only a turn with global Main authority may approve a skip. The same Main identity acting as a group Leader has no skip authority. Skipped work remains `skipped`, and the original Leader formally plans successors. Planning, weak routing, and final group delivery have separate persistent records; runtime status and the read-only PR tree show actual waiting reasons without fabricating business tasks.

Recovery first confirms the old native writer has stopped. Existing formal reports continue only with Git delivery. Merged but unsynchronized PRs need reconciliation rather than another model run. Existing business Agents resolve conflicts in their original directory, session, and preserved branch. Pause takes effect at native safe points. Cancellation persistently revokes authority, confirms shutdown, and closes precise unmerged PRs while preserving branches, directories, sessions, and historical merge facts.

The first report and bounded follow-up work by the original Agent must confirm workspace closure before binding a previously missing immutable report head. If Memory or business files remain unfinished, or observation fails, the system preserves the report, completion receipt, and actual follow-up return. The original Agent continues delivering its own files; the system neither commits on its behalf nor unbinds historical heads or resets follow-up budgets.

A follow-up invocation first checks actual Memory files, committed content, and Git state. A new physical call does not require repeating completed work records. A report head alone does not prove Memory was committed; real handoff evidence can provide the follow-up observation. If the Agent creates a new commit, even only for Memory, the new head must complete its own PR/merge/synchronization. An old PR does not cover it.

A read-only follow-up for a missing report head may explicitly inspect the original Agent's currently delivered PR. Inspecting historical PRs later in the same turn does not overwrite that observation. If the current PR is supplemental delivery after the original recovery PR, it must uniquely match the original execution/epoch's exact push, merge journal, local synchronization, and current checkout. Missing evidence leaves the head unbound, without repeated Git operations, replacing the original recovery PR, or rewriting reports, routing, completion receipts, or follow-up budgets. Already bound reports do not use this path.

New Git projects enter v3 before the first native invocation, even without groups. Main creating a group later does not change identity. Legacy flat groups in new projects may normalize into parallel entry paths. Existing v2 projects with native sessions retain v2 handling. Historical sessions are not automatically selected for migration, directories/sessions are not silently replaced, and v3 projects cannot downgrade to the old execution mode.

## Validation scope

Regression coverage includes real SQLite, the production coordinator, controlled native entry points, and formal MCP, plus real local Git with a fake HTTP provider. Actual Chromium checks of the shared editor can be repeated using the [browser acceptance guide](../../web/acceptance/README.md).

Controlled native/provider tests do not establish acceptance against real Gateways or GitHub. External pushes and PR acceptance require user authorization. The implementation described here does not change existing service environments or state directories.
