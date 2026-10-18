# OpenFARS collaboration implementation task board

[← Back to README](../../README.md) · [中文首页](../../README_zh-CN.md)

Updated: 2026-09-24 UTC

Original code baseline: `da25bdc4b264ef3bdd9bf1a6d140fba6c58d9ab2`

Research checkpoint: `49cebbc238cf23b6df80c46bfad24df1c1c7b4de`

Original collaboration source checkpoint: `d45e7dcbaa1f96a05f56dfca2cf409d0cef31e65`

GitHub account/canvas extension checkpoint: pending final local commit

Contract: `openfars-collaboration-v2.0`

Product rules P01–P22 are unchanged. R0–R8 research gates passed before
implementation and remain historical evidence rather than a claim that the
then-baseline code already had these features. The original collaboration
source is complete; the current account/canvas extension has passed its
development-tree gates and awaits its final local commit and exact-commit
visual repetition.

| Package / gate | State | Integrated evidence | Remaining work |
| --- | --- | --- | --- |
| C / R0 contract | integrated + verified | `33a9c2c`, `1ee1978`; v2 identities, outer-node projection, v1 normalization, validation and taskless-group contract consumers. | Final full-suite repetition only. |
| G / R2–R3 Git | integrated + local/provider tests verified; final live gate blocked | `5eb551c`, `225d16e`, `da591d3` and recovery hardening; local Git/provider suites pass. The `d45e7dc` live run retained a private repo but stopped at an uncertain initial push. | Obtain explicit authorization for external fixture push/PR mutations, then rerun real Git on final SHA. |
| H / R1–R4 Harness | integrated + verified | `456dd21` through resident/recovery fixes; four real native resident probes and 36-cell filesystem matrix exist. | Repeat resident and filesystem gates on final SHA. |
| S / R5–R6 state/runtime | integrated + verified | `c2164d3`, `61859f8` and recovery sequence through `199e8b8`; concurrency, stop proof, handoff, recovery, cancellation and once-only routing tests. | Final full server suite. |
| F/V / R7 UI | integrated + verified | `e83005a`, `6ef7224`, edit-lock fixes and `d45e7dc`; all 13 product-tree screenshots were opened and inspected. | Repeat capture on docs-descendant final SHA. |
| C/F/V / R8 research | PASS | Research index, product/UI comparison, architecture, Git, Harness/permission, state/recovery and evidence ledgers committed at `49cebbc`; independent audit recorded GO before code edits. | None; preserve as historical pre-implementation evidence. |
| I final integration | source complete; release gate pending | `d45e7dc`; `diff --check`, typecheck, build, full server (833 pass/3 skip), AWS credential selection (108), focused web rerun (35), full web (313), resident, filesystem and visual (13/13) pass. | Commit docs and repeat exact-SHA gates; real Git additionally needs explicit external-mutation authorization. |
| A GitHub accounts / canvas modes | implementation + development acceptance complete | Multi-account OAuth/token store, pinned project identity, account-scoped Git, canvas modes and collaboration action; typecheck/build pass, server 883 pass/3 skip, web 339/339, affected post-visual 48/48, three real-app images personally inspected. | Commit locally, confirm clean, recapture the three extension images with the exact commit in the external manifest. Live OAuth is deployment validation; push/PR remains user-deferred. |

## Final source closure delivered at `d45e7dc`

- Authorized Main→collaboration routing can be taskless; ordinary targets and
  finish behavior cannot use that exception.
- A >50-task group prompt retains the current task and as much live FIFO work
  as fits; dependency closure and newest terminal history fill only remaining
  capacity. Long journals use exact recovery lookups rather than capped scans.
- Git-on Inbox is server-owned and outside worktrees. Checkpoints use a fresh
  private index, forbid `.scienceevolve` in the frozen tree, preserve legitimate
  merge parents and clean only matching merge pseudorefs.
- Collaboration state, management memory and diagnostics share a credential
  vocabulary that includes AWS access-id/secret forms; persisted credential
  material is rejected and diagnostics are redacted/bounded.
- Current-coordinator management memory is prioritized and provenance-labelled
  `branch@commit:path`.
- Artifact publications are append-only; persisted displays and display reads
  require the exact immutable artifact/commit pair and fail closed on missing,
  mismatched or ambiguous bindings. General browsing may uniquely select one
  accepted publication by a single selector.
- Resume, completion continuation and intervention response schedule after the
  currently settling run, closing the acknowledged-continuation race.

## Final release checklist

- [ ] Commit this documentation refresh and record the exact final SHA.
- [ ] Confirm the final repository is clean and dependency symlinks are not
  tracked.
- [ ] PASS `npm run typecheck`, `npm run test:server`, `npm run test:web`, and
  `npm run build` on that SHA.
- [ ] Obtain explicit authorization for the real private GitHub fixture push
  and PR mutations; then PASS real Git/GitHub on the final SHA. Do not retry the
  retained external repository without that authority.
- [ ] PASS four-Harness resident and filesystem authority acceptance with the
  final SHA in each manifest.
- [ ] Capture and personally inspect all 13 screenshots again with that SHA in
  `openfars-final-visual-manifest.json`.
- [ ] Make no repository edit after the final acceptance run.

Until every unchecked item is complete, the implementation is source-complete
but the final release acceptance is not complete.
