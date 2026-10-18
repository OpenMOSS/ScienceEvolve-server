# Backend test evidence

[← Back to README](../../../README.md) · [中文首页](../../../README_zh-CN.md)

Updated: 2026-09-24 UTC

Source checkpoint: **PASS**.

Final exact-SHA repetition: **NOT_RUN**.

This ledger separates commands actually executed during
integration from the mandatory final run. Product source is committed at
`d45e7dcbaa1f96a05f56dfca2cf409d0cef31e65`; only these acceptance documents
remain uncommitted. Therefore the source-tree results below are real but must
not be presented as the future final release commit's results.

## Meaningful test coverage added

| Test area | Representative files | Behavior covered |
| --- | --- | --- |
| Contract and compatibility | `collaboration-contract.test.ts`, `orchestrator-main.test.ts`, `workflow-reconfiguration.test.ts` | v1 Git-off serial behavior, outer-node projection, illegal membership/routes, taskless group targets, ordinary route/finish assignment rules, group completion versus project completion. |
| Durable state and recovery | `collaboration-state.test.ts`, `collaboration-runtime-integration.test.ts` | FIFO claims, group concurrency, short-transaction rollback isolation, route/outbox dedupe, >100k exact history lookup, >50 prompt selection, stop proof, handoff, cancellation, Main/leader recovery, authorization loss, settling-run continuation. |
| Local Git and provider | `collaboration-git-local.test.ts`, `collaboration-git-provider.test.ts`, `collaboration-git-credential.test.ts` | retained worktrees, owner conflict repair, private checkpoint index, `.scienceevolve` exclusion, Inbox isolation, merge parents/pseudoref cleanup, initialization retry, uncertain provider responses, exact merge SHA and epoch fencing. |
| Resident Harness and permissions | `resident-adapter-factory.test.ts`, `process-host.test.ts`, `invocation-inputs.test.ts`, `official-event-bridge.test.ts` | four-adapter resident authority, management-only leader, server-owned Inbox, rotating turn capability, stop/recovery identity, filesystem authority, credential-free official events. |
| Credentials and durable payloads | `codex-runner.test.ts`, `collaboration-state.test.ts` | structured and textual rejection/redaction for key spelling variants, Bearer/Basic, GitHub tokens, `sk-`, credential URLs, PEM keys, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and raw `AKIA`/`ASIA` identifiers. |
| Artifacts and UI API boundary | `storage-workspace.test.ts`, `collaboration-runtime-integration.test.ts`, web `api.test.ts` and `lib.test.ts` | append-only Git publications, exact `artifactId + commitSha` persisted-display binding, no mutable workspace fallback, missing/mismatched/ambiguous display rejection, and unique single-selector general artifact browsing. |

## Commands actually run during closure

| Command / run | Result | Scope and qualification |
| --- | --- | --- |
| `npm run test:server` on `d45e7dc` | PASS: 60 passed files, 1 skipped file; 833 passed tests, 3 skipped (836 total) | Full server regression including AWS credential and private-index closure; duration 52.39s. The three skipped tests are existing opt-in native-compaction gates. |
| `npm run test -w server -- tests/collaboration-git-local.test.ts` | PASS: 13/13 focused cases | Latest private-index implementation: stale private index/lock exclusion, forced shared-index staging race, ignore-removal race without a secret object from the service checkpoint, merge-parent and pseudoref cleanup, and symlink fail-closed. |
| Focused group-chain/runtime selection from `collaboration-runtime-integration.test.ts` | PASS | Agent-led group, final integration and Main-led downstream group after removal of a credential-shaped fixture string. |
| `npm run typecheck` on `d45e7dc` | PASS | Server and web TypeScript checks on the committed product source. |
| `npm run build` on `d45e7dc` | PASS | Production web and server build on the committed product source. |
| `npm run test -w server -- tests/codex-runner.test.ts tests/collaboration-state.test.ts tests/official-event-bridge.test.ts` on `d45e7dc` | PASS: 3 files; 108/108 | Final AWS/key-variant detector, recursive durable-state rejection, redacted traces and official-event boundary. |
| Focused web timeout follow-up on `d45e7dc` | PASS: 2 files; 35/35 | `canvas-scale.test.ts` and `NewProjectPage.test.tsx` pass in a quiet run. |
| `npm run test:web` on `d45e7dc` | PASS: 27 files; 313/313 | Full web regression including the checkbox CSS source tree. |
| Earlier `npm run test:web` under concurrent heavy load | FAIL: 25/27 files; 305/313, 8 timeouts plus worker RPC timeout | The 526.83s run timed out under simultaneous CPU/GPFS-heavy jobs. It is retained here rather than hidden; the quiet focused and full green reruns above close it. |

Source-checkpoint external acceptance also produced:

- `openfars-final-resident-adapter-acceptance-latest.json`: PASS at `d45e7dc`,
  all four installed Harnesses (Codex, Claude Code, pi and DSH), three turns
  each.
- `openfars-resident-filesystem-matrix-latest.json`: PASS at `d45e7dc`, all 12
  Harness/tier cases, 36 write cells and 12 service-user read cells.
- `openfars-final-visual-manifest.json`: all 13 images at `d45e7dc`, followed by
  personal inspection recorded in `frontend-visual.md`.
- `openfars-final-real-git-acceptance-latest.json`: FAIL at `d45e7dc` during
  initial `main` push. The sandbox credential helper could not acquire its
  read-only credential-storage lock; the state correctly stopped with an
  uncertain push, no execution/PR and no false completion. It retained the
  private repository
  `https://github.com/Zyrrick/openfars-retained-acceptance-2026-09-23t19-30-09-c4a5f0554f`
  and local evidence. An unsandboxed rerun would externally push fixture data
  and create/merge PRs; escalation was rejected because the user has not
  explicitly authorized that external mutation. It must not be described as a
  product PASS or silently retried.

The credential changes that add AWS structured keys, assignments, and raw
access IDs are covered by both the final full server run and this successful
focused command:

```bash
npm run test -w server -- \
  tests/codex-runner.test.ts \
  tests/collaboration-state.test.ts \
  tests/official-event-bridge.test.ts
```

The web timeout follow-up was:

```bash
npm run test -w web -- \
  src/components/workflow-canvas/core/canvas-scale.test.ts \
  src/pages/NewProjectPage.test.tsx
npm run test:web
```

The quiet focused and full web reruns passed. If another final run encounters
similar saturation, record and remove that interference before interpreting a
timeout; environmental diagnosis alone is never a waiver.

## 2026-09-24 GitHub account/canvas extension checkpoint

This extension is additive to the collaboration acceptance above. Its current
development-tree evidence is real but was collected before the final local
commit, so the external visual manifest must be repeated after that commit.

Meaningful new/changed coverage:

| Area | Test files | Covered behavior |
| --- | --- | --- |
| Account authority | `github-accounts.test.ts` | OAuth state + PKCE S256 + exact `repo` scope, callback-origin pinning, concurrent multi-account persistence, idempotent reauthorization, encrypted plaintext absence and `0600` files, selected-account refresh, revoked/mismatched identity, login rename, cancelled/under-scoped grants and corrupt-store fail-closed behavior. |
| Provider/project binding | `collaboration-git-provider.test.ts`, `orchestrator-collaboration-api.test.ts`, `collaboration-runtime-integration.test.ts` | Numeric provider identity before mutation, credential-free project binding, requested repository name/visibility and binding retained in every initialization checkpoint, Private/Public provider creation, same binding on retry, and accountless legacy projects pausing without ambient credentials. |
| HTTP/config/public boundary | `project-management-api.test.ts`, `config.test.ts`, web `api.test.ts` | Server-only OAuth configuration, credential-free/no-store account catalog, disabled login before setup, account action normalization and no token fields. |
| Account and canvas UI | `GitHubAccountManagementPage.test.tsx`, `App.navigation.test.tsx`, `NewProjectPage.test.tsx`, `ProjectListPage.test.tsx`, `CanvasInspector.test.tsx`, `WorkflowCanvasEditor.test.tsx` | Multiple account status/actions, OAuth popup callback, preserved drafts across account-library navigation, no-account routing, selected account plus repository name/visibility in launch/saved tasks, all project modes editable in the canvas, the repository-settings popup, and the redesigned collaboration action. |

Commands actually run on the integrated development tree:

| Command | Result |
| --- | --- |
| Focused server account/provider/orchestrator/API/config selection | PASS: 5 files, 39/39 tests. |
| Focused accountless production-runtime case | PASS: 1 selected test (57 unrelated cases skipped by the filter). |
| Focused web API/account/canvas/new-project/project-list selection | PASS: 6 files, 137/137 tests. |
| Focused navigation/canvas selection | PASS: 2 files, 41/41 tests. |
| `npm run typecheck` | PASS for server and web. |
| `npm run test:server` | PASS: 65 passed files, 1 skipped file; 883 passed tests, 3 existing environment-gated skips (886 total). |
| `npm run test:web` | PASS: 29 files, 339/339 tests. |
| `npm run build` | PASS for the production web and server bundles. |
| Post-visual CSS follow-up (`CanvasInspector` + `WorkflowCanvasEditor`) | PASS: 2 files, 48/48 tests; production web rebuild PASS. |

No live GitHub login, repository creation, push or PR mutation was performed.
The OAuth/provider unit tests use a deterministic fake provider, while the
browser visual fixture uses encrypted local account records. These prove the
local authority, persistence, API and UI behavior, not live-provider
acceptance. A live account login remains an operator validation step after a
real OAuth App is configured; it must not be conflated with the user-deferred
push/PR gate.

## Mandatory final exact-SHA gate

After all source and documentation edits are committed, capture `FINAL_SHA`
from the clean repository and run, without editing the repository afterward:

```bash
npm run typecheck
npm run test:server
npm run test:web
npm run build
```

Then run the real private-Git, four-native-Harness resident, 36-cell filesystem
authority, and browser visual acceptance programs with
`OPENFARS_ACCEPTANCE_SHA=$FINAL_SHA` (or the visual script's
`--expected-sha`). Result-bearing manifests must report `PASS` and every
manifest must carry the same full `FINAL_SHA`; the visual manifest must list
all 13 files and hashes. The authoritative final artifacts live outside Git
under:

- `/inspire/qb-ilm2/project/cq-scientific-cooperation-zone/w26212/temp/openfars-final-real-git-acceptance-latest.json`
- `/inspire/qb-ilm2/project/cq-scientific-cooperation-zone/w26212/temp/openfars-final-resident-adapter-acceptance-latest.json`
- `/inspire/qb-ilm2/project/cq-scientific-cooperation-zone/w26212/temp/openfars-resident-filesystem-matrix-latest.json`
- `/inspire/qb-ilm2/project/cq-scientific-cooperation-zone/w26212/temp/openfars-final-visual-manifest.json`

Older manifests prove development checkpoints only. In particular, the real
Git PASS at `199e8b8` must not replace the failed current-source live run or be
relabelled as evidence for the future final commit. Completion of the final
real Git gate is blocked on explicit authorization to push fixture content and
create/merge PRs in the retained external GitHub repository.
