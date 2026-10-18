# OpenFARS collaboration integration log

[← Back to README](../../README.md) · [中文首页](../../README_zh-CN.md)

Updated: 2026-09-24 UTC

Integration owner: root Agent

Contract: `openfars-collaboration-v2.0`

Research checkpoint: `49cebbc238cf23b6df80c46bfad24df1c1c7b4de`

Original collaboration source checkpoint: `d45e7dcbaa1f96a05f56dfca2cf409d0cef31e65`

GitHub account/canvas extension checkpoint: pending final local commit

The original collaboration packages are integrated. The current worktree also
adds the user-requested GitHub account authority and canvas-wide project mode
controls; this is a product extension rather than a documentation-only
descendant. Its implementation and development-tree acceptance are recorded
below and require one final local commit plus exact-commit visual repetition.

## Package integration record

| Package | Integrated checkpoints | Delivered boundary |
| --- | --- | --- |
| C — contract/compatibility | `33a9c2c`, `1ee1978` | v2 node/group identities, canonical outer-node projection, v1 Git-off normalization, validation, saved-task/preset round-trip and unchanged ordinary routing/termination. |
| G — Git/provider/memory | `5eb551c`, `225d16e`, `da591d3` plus recovery fixes through `199e8b8` | Private-repository lifecycle, fixed credential-helper composition, retained branches/worktrees, operation reconciliation, exact provider merge facts, conflict-owner repair, business/management memory and read-only projection. |
| H — resident Harness/authority | `456dd21`, `e1448d9`, `e3de68d`, `0505dfd`, `54846ad`, `ef4b58a` | Resident Codex/Claude Code/DSH/pi adapters, rotating turn authority, management-only leader, filesystem broker, durable launch/stop identity, pause/resume and stop-confirmed recovery. |
| S — durable collaboration runtime | `c2164d3`, `61859f8`, `d3cf7b9`, `393fbb8`, `cd8a828`, `c85298b`, `7c3dd08` and later restart/recovery fixes | Single active outer node, concurrent group members, FIFO tasks, short SQLite transactions, ownership/coordinator fencing, failure handoff, cancellation settlement, bounded Main/all-member recovery and once-only route emission. |
| F/V — UI/SSE/read-only Git | `e83005a`, `6ef7224`, `d620cc6`, `142916f` | Native group editor/runtime card, compact/full parity, edit lock through final PR, member/attempt details, read-only Git/PR panel, SSE reconnect/replay and responsive states. |
| I — final source closure | `d45e7dc` | Taskless Main→group routing, >50 assignment context and >125k history regressions, server-owned Inbox/private Git index, credential-free durability including AWS forms, current-coordinator management memory, immutable artifact/display binding, settling-run continuation and visual CSS correction. |
| A — GitHub accounts / canvas settings | pending final local commit | Multi-account OAuth library, encrypted server-only tokens, immutable per-project identity binding, account-scoped Git credentials, result/intervention/Main/Git controls in the canvas, preserved drafts and redesigned collaboration action. |

## Final closure invariants

- A Main route may omit `assignment` only when the exact target is in its
  server-derived taskless collaboration allow-list. Ordinary targets and
  `finish` retain their assignment/completion rules through MCP, resident
  serialization and durable revalidation.
- Group assignment context is bounded to 50 records and prioritizes the current
  task, as much live FIFO work as fits, then dependency closure and newest
  terminal history while capacity remains. Exact recovery scans remain correct
  beyond 100k/125k events.
- Git-on Inbox content is staged under the server-owned invocation runtime, not
  inside a delivery worktree. `.scienceevolve` is ignored and forbidden from a
  checkpoint tree; the service builds commits through a fresh private index,
  validates the frozen tree, creates the commit and advances the branch by CAS.
- Durable collaboration payloads reject credential-shaped keys or values;
  trace paths redact the same vocabulary, including underscore/hyphen/case
  variants, Bearer/Basic, GitHub and `sk-` tokens, credential URLs, PEM keys,
  AWS key assignments and raw `AKIA`/`ASIA` IDs.
- Artifact publication is append-only and identifies execution, epoch, PR,
  accepted base, head commit and path. A persisted display is bound by exact
  `artifactId + commitSha`; missing, mismatched or ambiguous display reads fail
  closed, while general browsing may use one selector for one accepted record.
- Resume, a completed-project continuation and an intervention response that
  become visible before the current run's `finally` block are scheduled only
  after that exact settling promise, preventing the duplicate-run fence from
  dropping an acknowledged continuation.

## Executed source-checkpoint evidence

- `d45e7dc`: `git diff --check`, `npm run typecheck`, and `npm run build` PASS.
- `d45e7dc`: credential/AWS focused server selection PASS, 3 files and 108
  tests; web timeout follow-up PASS, 2 files and 35 tests; full web PASS, 27
  files and 313 tests.
- `d45e7dc`: full server PASS, 60 passed files plus 1 skipped file; 833
  passed tests plus 3 environment-gated skips, duration 52.39s. The focused
  private-index suite also passed 13/13.
- `d45e7dc`: real built-app visual program produced all 13 required PNGs. The
  root Agent opened each image and recorded a PASS conclusion in
  `acceptance/frontend-visual.md`.
- `d45e7dc`: native resident PASS for four Harnesses × three turns and
  filesystem matrix PASS for all 12 Harness/tier cases. The current-source real
  Git run created and retained a private repository but reported FAIL at initial push
  because the sandbox credential helper could not acquire its read-only
  storage lock; it created no PR and emitted no false completion. An
  unsandboxed rerun was rejected because external fixture push/PR mutation has
  not been explicitly authorized. The older `199e8b8` real Git PASS is
  development evidence, not a substitute for the final gate.

## 2026-09-24 extension evidence

- Full server regression PASS: 65 passed files plus 1 skipped file; 883 passed
  tests plus 3 existing environment-gated skips.
- Full web regression PASS: 29 files and 339/339 tests. Server/web typecheck and
  production build PASS. After visual review changed the canvas switch styling,
  the affected 48 canvas tests and production web rebuild passed again.
- The real built application produced the three account/canvas PNGs listed in
  `acceptance/frontend-visual.md`. Each image was opened at original detail;
  the first canvas capture exposed square-looking switches, which were fixed,
  rebuilt, recaptured and reopened. The external manifest reports no browser
  errors or horizontal overflow.
- Live OAuth/repository mutation was intentionally not performed. Provider
  flow and failure/recovery behavior are covered with deterministic tests; a
  real OAuth App login remains deployment validation, while push/PR stays
  deferred by the user.

## Remaining integration step

Create the final local extension commit (without push or PR), confirm a clean
worktree, then repeat the three extension screenshots so their external
manifest names that exact commit and records `sourceWorktreeDirty: false`. The
real Git step still requires explicit user authorization because it pushes
fixture content and creates/merges PRs in an external GitHub repository; it is
not part of this local-validation handoff and must remain visibly deferred. Do
not edit the repository after the exact-commit visual repetition; a product
change requires a new commit and recapture.
