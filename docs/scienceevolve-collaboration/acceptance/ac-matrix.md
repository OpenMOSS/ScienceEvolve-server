# AC01–AC33 acceptance matrix

[← Back to README](../../../README.md) · [中文首页](../../../README_zh-CN.md)

Updated: 2026-09-23 UTC

This is the functional-scenario ledger. `PASS` means the stated scenario has
actual test or acceptance evidence at the cited implementation checkpoint;
`NOT_RUN` means its required evidence has not yet been completed. It is not a
release verdict: after the closure diff and these documents are committed, the
root Agent must repeat the typecheck, both full suites, build, real Git,
resident, filesystem, and visual gates with one exact final commit in every
manifest. The final product source is committed at
`d45e7dcbaa1f96a05f56dfca2cf409d0cef31e65`; the only current worktree changes
are these acceptance documents. No row below claims that the future
documentation-descendant final-SHA gate has already passed.

| AC | Status | Executed evidence and limitation |
| --- | --- | --- |
| AC01 | PASS | `orchestrator-main.test.ts` runs a Git-off legacy workflow on the serial runner; contract normalization keeps omitted Git disabled. |
| AC02 | PASS | Contract/server tests reject Git-off groups and `WorkflowCanvasEditor.test.tsx` renders the matching diagnostic without a migration control. |
| AC03 | PASS | Contract and editor tests project the eight-Agent fixture as six ordinary outer nodes plus one group and exclude members from Main candidates. |
| AC04 | PASS | Contract validation rejects duplicate membership, nesting and member-facing outer routes; editor tests keep locked group topology consistent. |
| AC05 | PASS | Runtime integration proves an ordinary source becomes a management-only leader while the group is the sole active outer node and the leader owns no delivery PR. |
| AC06 | PASS | Runtime integration runs an agent-led group, waits for final integration, then activates the strong downstream group under Main. |
| AC07 | PASS | Runtime integration covers fixed group routing and Main-selected weak routing without a group-completion approval state. |
| AC08 | PASS | Main control scopes carry an allow-list of taskless collaboration targets; MCP, resident, runtime and durable revalidation accept omitted assignment only for those targets and still reject ordinary/finish misuse. |
| AC09 | PASS | Runtime integration runs group deliveries concurrently; member input contains shared state and bounded group assignment context while the outer active node remains the group. |
| AC10 | PASS | State/runtime tests preserve successful executions and add FIFO continuation work; the >50-task regression retains current work first, fills the remaining window with live FIFO peers, and adds dependency closure/newest terminal history only while capacity remains. |
| AC11 | NOT_RUN | Local product tests prove report checkpoint/PR gating, and an older `199e8b8` live run merged report PRs. The `d45e7dc` live rerun stopped at initial push, before any member PR, because the sandbox credential helper could not acquire its read-only storage lock; an unsandboxed GitHub rerun was not authorized. |
| AC12 | NOT_RUN | Runtime integration proves downstream gating, but the current-source live Git run did not reach member PRs. Final live evidence requires explicit authorization for the external push/PR workflow. |
| AC13 | NOT_RUN | An older checkpoint completed the member→group→`main` chain; the current-source live manifest is FAIL at initial push and contains no PR. It cannot be used as final chain evidence. |
| AC14 | NOT_RUN | Local Git tests prove owner conflict repair with no `ours`/`theirs`; current-source live GitHub conflict/repair evidence was not reached because external push/PR execution is not authorized outside the sandbox. |
| AC15 | PASS | `openfars-final-resident-adapter-acceptance-latest.json` at `d45e7dc` runs the four installed CLI programs (Codex/Claude Code/pi/DSH) against local providers for three resident turns each, including idle/pause/resume identity evidence; controlled runtime integration separately proves unresolved-PR worker lanes and management availability. This is explicit combined evidence, not one live GitHub PR-wait run. |
| AC16 | PASS | Runtime/state tests stop-confirm a failed member, retain its attempt and hand the task to a survivor at a fresh ownership epoch. |
| AC17 | PASS | Durable state and Git authority tests reject stale-epoch writes, commits and handoff actions after transfer. |
| AC18 | PASS | Runtime integration persists all-member pause, resumes within the bounded recovery policy and never turns the leader into a delivery member. |
| AC19 | PASS | Runtime integration stop-confirms a failed non-Main leader and opens one fresh Main coordinator epoch without double assignment. |
| AC20 | PASS | Runtime/state tests freeze independent Main mutation, reconcile stop/facts, retry within a durable bound and require intervention after exhaustion. |
| AC21 | NOT_RUN | The `d45e7dc` live run created and retained the private repository and operation id, then failed closed with an uncertain initial push. Retrying the external mutation outside the sandbox requires explicit authorization, so the complete live initialization/retry scenario is not run. |
| AC22 | NOT_RUN | Provider/runtime fault-injection tests pass lost-response reconciliation and dedupe, and older live evidence exists; the current-source live run did not get beyond initial push, so final live restart/merge reconciliation remains unauthorized and unrun. |
| AC23 | PASS | `collaboration-state.test.ts` injects an overlapping pre-commit rollback while a second connection commits and proves the committed events/usage survive. |
| AC24 | PASS | Runtime/state tests wait for exact stop proof, reconcile open/merged PR truth and retain branches, worktrees, commits and cancellation cause before settlement. |
| AC25 | PASS | Local Git tests put business memory in the delivery history and management memory on its own branch; runtime input prioritizes the current coordinator and labels each snapshot `branch@commit:path`. |
| AC26 | PASS | `openfars-resident-filesystem-matrix-latest.json` at `d45e7dc` passes all 12 Harness/tier cases (36 write cells plus 12 service-user reads) and records the yolo same-UID limitation. |
| AC27 | PASS | State and web tests keep a group locked through a pending final PR, unlock only after terminal merge, and preserve historical run snapshots. Final screenshots 12–13 remain part of AC32. |
| AC28 | PASS | State tests replay one activation by request identity, create a new run for a new request, and runtime/provider tests reuse durable operations without duplicate branches or work. |
| AC29 | PASS | Runtime canvas, API and SSE tests show member/PR facts, deduplicate replay after reconnect, and expose Git as read-only with no merge/revert/delete controls. Final visual repetition remains part of AC32. |
| AC30 | PASS | Contract/state/orchestrator tests keep ordinary `decisionBy`, `finish` and termination behavior separate from group completion; a group never uses `complete_project` as its completion mechanism. |
| AC31 | PASS | R0–R8 research and independent audits were committed at `49cebbc238cf23b6df80c46bfad24df1c1c7b4de` before product implementation; the task board records the implementation release decision. |
| AC32 | PASS | The real built application at source commit `d45e7dc` produced all 13 required images; the root Agent opened every PNG and recorded the layout/state conclusions in `frontend-visual.md`. The same capture must be repeated on the documentation-only final descendant so its manifest carries the release SHA. |
| AC33 | PASS | Meaningful normal, rejection, recovery, race, idempotency and Git tests exist. On `d45e7dc`, typecheck/build pass, full server passes 833 tests with 3 environment-gated skips, and full web passes 313/313; focused closure selections also pass. The docs-descendant release SHA still requires the prescribed repetition. |

## Final release gate

The release verdict becomes PASS only when all of the following point to the
same clean commit and report PASS:

1. `npm run typecheck`, `npm run test:server`, `npm run test:web`, and
   `npm run build`.
2. Real private-Git acceptance, four-Harness resident acceptance, and the
   36-cell filesystem authority matrix.
3. A fresh visual manifest containing all 13 named screenshots, followed by
   opening and inspecting every image.
4. No repository edit after that run. External acceptance manifests under
   `/inspire/qb-ilm2/project/cq-scientific-cooperation-zone/w26212/temp` are the
   final immutable-SHA evidence; this file intentionally does not predict their
   future commit value.

The real Git item is currently blocked on authority, not hidden as a test
success: the `d45e7dc` sandbox run retained a private repository but could not
push `main`, and an unsandboxed run would push fixture content and create/merge
external GitHub PRs. It may proceed only after explicit user authorization.
