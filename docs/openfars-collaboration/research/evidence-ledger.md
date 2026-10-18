# Research evidence ledger

[← Back to README](../../../README.md) · [中文首页](../../../README_zh-CN.md)

Research date: 2026-09-22 UTC
Read-only product baseline: `da25bdc4b264ef3bdd9bf1a6d140fba6c58d9ab2`

This ledger pins the evidence reviewed before product implementation. `/tmp`
artifacts are retained diagnostic records, not shipped product inputs. A PASS
below means implementation feasibility/research sufficiency unless the row
explicitly describes the baseline product. The baseline product does not yet
implement collaboration, resident leases or the permission broker.

| Gate | Final result | Reproduction/evidence pin | Independent review |
| --- | --- | --- | --- |
| R0 | PASS; contract frozen | `contracts/validate-contract-examples.mjs` `e9535e483e1817092266023071814595bedee06625686109008230ef211f035b`; evidence `2ee69c3e91e7f2d63f0a6552f10ec83c51bb9dffd76f74e3ad118329085a45b8`; 24/24 | Deep legacy compatibility, Git-ready collaboration example and all task/execution/PR links accepted. |
| R1 | PASS research; baseline FAIL | final report `3b6a72b587e9e8e66c0bb982533311a7b59dd3c12b6b658375aa9c515a70f5e5`; Codex `1126924261d09390ffad483a043e5c9f22c0a1fcd2b0dd555c9d1149c3576a00`; Claude `b39028814954e8fd48b371aae0a84f937dfb0650076409c2f7597940026a5da7`; Pi `c74246519b4e7aec33c0b1a3bb57d6ecb92f059f5256ad04983b367e8a655cba`; DSH `917ca0b8c164abbc625cea14ad6822e32e0b6c3349c79158e573742405229966` | Four native PID/two-turn/pause/crash paths accepted. DSH SDK native resume is unsupported; new-session durable rehydrate was proven and must remain labelled as such. |
| R2 | PASS | live gate `9d95013f6427d994d0c80ec30355a95905c5ab048c7d1793871b9c89a677562b` / evidence `927a434f88b38cb03a8c6976bfc77138bde12450b6f719573bff2fcbb5e5b1ae`; retry gate `dcbe3ce94991200be6880def5eb73a86b9213bd98dc99cd65c59b318bc7bdf3c` / evidence `bf2b0465467d07fe17193539a41e64fe121f2053e125789365606286e63ec81a` | Two retained private repositories prove create/push/PR/merge/reconcile and same-repository initialization retry. No workflow file or Actions endpoint was used. |
| R3 | PASS | basic gate `0045c835412ef1161bb317582015dc7f6d6ba421b28a411154410207dffeb447` / evidence `ddeabcfadb21fc9d0bd8fd11fd8e9f15c9a3e9aed9602884556a12bef8814012`; extended gate `18b36b20a09a1478efce061214a231ad29127eb302d4e4938de856e740bfee37` / evidence `e7c4dc3c57342b950385c13c9e8282457b40fda8bacf6a631c43807324686d1f` | Conflict ownership, report/memory PR, cancellation, stale epoch, final repair and replay/no-op accepted. |
| R4 | PASS research; baseline FAIL | immutable manifest `0ee69901dd7e55676ed0552a3c51bfd7bfae32a4ad34180248b0009356a2710c`; descriptor evidence `41660674b2fdf32b777f006c050416e06a486fb2368e688ddf45cdb0cda0592a`; Adapter evidence `e63fcb96af69a7aeecf48b15a020db3812f4aaa39bdf770bc46a9480e4d729a3`; provider frames `bb2e8b29579cf6c8252cf41e04b66ab29f1090b2df52a63ebcdde9f5f89c662c` | Descriptor 23/23 and four-Adapter 24/24 accepted. Product must still test Codex patch on a working sandbox, actual service-user root and same-device bind mounts. |
| R5 | PASS research | actual-GPFS script `b303d3b31b75eecc82a84660695d9ee0e5cc1174ffd4b6420461e2d39c2384e2`; immutable evidence `19908a731a1d4dbe80b6ba5476c087dacd503ecd9a36a22d9d04bd2f356bd642`; 13/13 | DELETE/FULL, service lease epoch, PR preservation, scoped recovery, uncertain merge reconciliation and crash rollback accepted for one writer service/host. |
| R6 | PASS research | v3 probe `3b9369ccaa2ac2b9a7fc44ea955c43ea9e3e66162431140184479fe7c49a6364`; immutable evidence `fb7b1b701602a9e4c41ea98a32b0c43ba881427b69e3bbeade9fe1095a4da355`; report `a9cdaa047766475e36e914f2ed251e41cb33395fa73d48b55e93f6271607c6a0`; 20/20, 52 events | Independent rerun accepted all-member recovery/exhaustion, pending→failed, canonical `main`, merged-PR ordering, fencing and unique routing. |
| R7 | PASS research | `research/validate-fixtures.mjs` `ccdcf8adde57af049901edc22172cc2f10c6eca370904ee6a1deb463a9d7b6a5`; evidence `27b1d7c5d249cf47619fdb0d4b1ed867af7e36654a0352c5fc77a21ce01b6a9c`; v2 fixture `81c6d2ac65a2475a347b7834c6389705c113faa71058ea2930bf0967ed5b7187`; legacy fixture `d10384fd68667fbffe55f06287d643b4abdc4daec5e16a1dc4b819a13ccb4cba`; 58/58 | Semantic/layout parity, Main system edges, deep legacy compatibility, read-only Git and capacity warning accepted. Real screenshots remain implementation acceptance. |
| R8 | PASS research; implementation released | `product-ui-references.md` `09148b97521218f3dea4d21678006363ff76e2dfa0d6ce812a97b5acbee765cf`; contract `ab4f1818ec141779507f9caa505dacb23c75800bedbd54825505788e10dea685` | Independent source-coverage audit accepted expansion/collapse, group-only ports and stable endpoints, compact/full semantic parity, layered error/wait status and immutable continuation/handoff history. No blocking source-claim overreach remained. |

R8 is a documented sufficiency judgment over these gates plus
`product-ui-references.md`; it has no separate executable artifact. The final
cross-document audit passed, and `index.md` plus `task-board.md` record the
release decision: **信息充分，可进入实施。**
