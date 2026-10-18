# Frontend visual acceptance

[← Back to README](../../../README.md) · [中文首页](../../../README_zh-CN.md)

Updated: 2026-09-24 UTC

Product-tree capture and personal inspection: **PASS**.

Final exact-SHA repetition: **NOT_RUN**.

The browser program drives the real built OpenFARS server and web application
with controlled project records. Those records are fixtures for deterministic
UI states; they do not substitute for the separate real GitHub and native
Harness gates. Every final image and the visual manifest must name the same
clean final commit used by the backend gates.

## Required final image set

All files are written to
`/inspire/qb-ilm2/project/cq-scientific-cooperation-zone/w26212/temp`.

| # | Filename | Viewport | Required state and inspection focus |
| --- | --- | --- | --- |
| 01 | `openfars-final-01-create-git-off-diagnostic-1440x960.png` | 1440×960 | Creation form with Git off and a collaboration diagnostic; start is blocked, copy is visible, no migration switch. |
| 02 | `openfars-final-02-create-group-dialog-1440x960.png` | 1440×960 | Group creation dialog; native-size member checkboxes align with their labels and do not inherit full-width field styling. |
| 03 | `openfars-final-03-editor-full-expanded-1720x1080.png` | 1720×1080 | Full editor with expanded group; members are inside one outer card, group-only ports/edges remain readable, inspector is the single configuration source. |
| 04 | `openfars-final-04-editor-compact-1440x1000.png` | 1440×1000 | Compact projection of the same workflow; member rows are suppressed without changing group identity, routes or saved expansion preference. |
| 05 | `openfars-final-05-runtime-overview-1600x1000.png` | 1600×1000 | Runtime group overview; one active outer node, member states and group phase are distinct and readable. |
| 06 | `openfars-final-06-runtime-group-wait-continuation-1720x1080.png` | 1720×1080 | Unresolved PR/wait plus continued work; current owner and predecessor attempt remain distinguishable without overlap. |
| 07 | `openfars-final-07-runtime-final-integration-1720x1080.png` | 1720×1080 | Final-integration execution and final PR to `main`; group remains locked and no downstream-complete approval state is invented. |
| 08 | `openfars-final-08-git-pr-readonly-1440x1000.png` | 1440×1000 | Git/PR detail; repository, head/base, owner, state and link are visible, with no merge/revert/delete/cleanup control. |
| 09 | `openfars-final-09-git-init-failed-retry-1440x900.png` | 1440×900 | Initialization failure retains facts and offers in-place retry with an actionable, credential-free diagnostic. |
| 10 | `openfars-final-10-sse-reconnecting-1440x900.png` | 1440×900 | The `正在重连` transport state is in the captured viewport while durable workflow/member state remains unchanged. |
| 11 | `openfars-final-11-mobile-runtime-390x844.png` | 390×844 | Mobile runtime; primary status and controls remain usable, secondary detail stacks, and no horizontal page overflow occurs. |
| 12 | `openfars-final-12-ac27-group-editor-final-pr-locked-1440x960.png` | 1440×960 | All member work is terminal but final PR is unresolved; current group editing is visibly locked. |
| 13 | `openfars-final-13-ac27-group-editor-terminal-editable-1440x960.png` | 1440×960 | Final PR is terminal/merged; current group is editable while historical run facts remain unchanged. |

## Product-tree capture and inspection findings

The real built application was captured from source commit
`d45e7dcbaa1f96a05f56dfca2cf409d0cef31e65` after correcting the earlier
checkbox and reconnect-capture defects. The capture program SHA-256 was
`dc36b5c995f378504a55eba90ee3acd96d6897be78a8dba335733aa6871f32ee`.
Its manifest is
`/inspire/qb-ilm2/project/cq-scientific-cooperation-zone/w26212/temp/openfars-final-visual-manifest.json`.
All 13 PNGs were then opened at full detail by the root Agent; the observed
conclusions were:

| # | Personal inspection conclusion |
| --- | --- |
| 01 | Git-off collaboration diagnostic is clearly visible and the invalid start is not presented as runnable. |
| 02 | Member checkboxes are compact (about 16px), label-aligned, selected `c`/`d` and unavailable `a`/`b` are unambiguous. |
| 03 | Expanded topology and read-only group membership are clean, with stable group-only connections and no desktop overflow. |
| 04 | Compact workflow section remains clean and represents the same group topology. |
| 05 | Runtime overview clearly separates the active group phase and member facts. |
| 06 | Leader, FIFO, failure, waiting and continuation facts are simultaneously visible without losing provenance. |
| 07 | Member merge, final-PR conflict and final-integration facts are readable and distinct. |
| 08 | Branch, worktree, commit, PR, check and diff facts are visible as read-only information; no forbidden mutation control is shown. |
| 09 | Failed initialization and same-`operationId` retry/retained state are visible. |
| 10 | Orange `正在重连` is inside the viewport while the durable snapshot and trace remain visible. |
| 11 | The 390×844 modal is contained, provides the lateral-view hint and has no page-level horizontal overflow. |
| 12 | AC27 edit controls are locked while the final PR remains nonterminal. |
| 13 | The current group becomes editable after terminal resolution while the historical state remains present. |

This is valid product-tree visual evidence for AC32. It is still called a
pre-final run because the acceptance documents have not yet been committed;
the final repository commit will be a documentation-only descendant of
`d45e7dc`. The same program must be repeated against that exact descendant so
the manifest SHA matches every other release gate. The controlled
`github.example.test` records prove UI/storage/API/SSE rendering only, not real
GitHub or native Harness behavior; those claims remain in their separate
acceptance manifests.

## 2026-09-24 account library and canvas-settings extension

The real production build was launched against a fresh data directory with
three controlled, encrypted local account records (two ready and one expired).
No OAuth provider, repository, push or PR mutation was performed. The browser
program exercised the public account API and real React UI, asserted zero
horizontal page overflow and no browser errors, then captured these files in
the user-required temp directory:

| Filename | Viewport | Exercised state | Personal image inspection |
| --- | --- | --- | --- |
| `openfars-github-account-library-1440x960.png` | 1440×960 | Three accounts, default marker, ready/expired states, verify/default/remove/reauthorize actions and enabled “login new account”. | Opened at original detail: hierarchy and two-column cards are balanced; the third expired card is visibly distinct; all status text and actions are fully visible with no clipping, overlap or credential value. |
| `openfars-canvas-global-settings-1720x1080.png` | 1720×1080 | Full real canvas; paper + Markdown result formats, custom delivery text, user intervention, Main workflow reconfiguration, Git enabled and `bob-lab` selected. The redesigned collaboration section exposes a labelled “新建” action. | Opened after the first capture, corrected square-looking switches, rebuilt and recaptured, then opened again: all settings and the selected account fit in one inspector viewport; final switches are horizontal and state-readable; canvas nodes/edges remain unobscured; the collaboration action is clear; no overflow or truncation blocks use. |
| `openfars-github-login-required-1440x900.png` | 1440×900 | Empty account catalog with configured OAuth and enabled “登录 GitHub” action. | Opened at original detail: the required-login state is centered and explicit; both the hero action and empty-state action are visible; no blank-error or disabled-login ambiguity remains. |

The companion manifest is
`/inspire/qb-ilm2/project/cq-scientific-cooperation-zone/w26212/temp/openfars-github-canvas-visual-manifest.json`.
It records image hashes, viewport/state assertions, the source HEAD, whether the
tree was dirty, fixture provenance and browser errors. The development capture
correctly records a dirty tree. After the final local commit, the same program
must overwrite these three files once more so the authoritative external
manifest reports that commit and `sourceWorktreeDirty: false`; no repository
file is edited after that repetition.

## Final execution protocol

1. Commit every source and documentation change. Confirm a clean worktree and
   capture the full `FINAL_SHA`.
2. Run `npm run build` for that commit.
3. Create a fresh server data directory and select an unused local port; do not
   reuse data or a server process from a preliminary capture.
4. Execute:

   ```bash
   node /tmp/openfars-final-visual-acceptance.mjs \
     --expected-sha "$FINAL_SHA" \
     --data-dir "$FRESH_DATA_DIR" \
     --repo /inspire/qb-ilm2/project/cq-scientific-cooperation-zone/w26212/openfars \
     --port "$UNUSED_PORT" \
     --output-dir /inspire/qb-ilm2/project/cq-scientific-cooperation-zone/w26212/temp \
     --overwrite
   ```

5. Require the script to report all 13 captures, the expected dimensions,
   visible reconnect state, bounded checkbox size/alignment, and no desktop
   horizontal overflow.
6. Open every PNG at full detail. Inspect card/edge geometry, labels, status
   meaning, buttons, selected/locked state, overflow, clipping, overlap,
   responsive stacking and absence of forbidden Git controls. A manifest or
   screenshot command alone is not inspection.
7. Require
   `/inspire/qb-ilm2/project/cq-scientific-cooperation-zone/w26212/temp/openfars-final-visual-manifest.json`
   to contain the exact `FINAL_SHA`, all 13 filenames, byte counts and SHA-256
   hashes. Preserve the images and manifest without editing the repository
   afterward.

If any assertion or visual check fails, fix the product or capture setup,
commit the correction, and repeat all final-SHA gates. Do not replace a missing
state with a static mockup or crop away the problem.
