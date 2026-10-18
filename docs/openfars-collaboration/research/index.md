# Research index and gate ledger

[← Back to README](../../../README.md) · [中文首页](../../../README_zh-CN.md)

Research date: 2026-09-22 UTC
Read-only code baseline: `da25bdc4b264ef3bdd9bf1a6d140fba6c58d9ab2`

No OpenFARS product source was changed before these reports were created. Temporary experiments were confined to `/tmp`; the R2 remote experiment used a new private audit repository and intentionally retained it as required by the specification.

| Gate | Owner | Status | Baseline SHA | Evidence | Current limitation | Reviewer |
| --- | --- | --- | --- | --- | --- | --- |
| R0 architecture/compatibility | C | PASS | `da25bdc4b264ef3bdd9bf1a6d140fba6c58d9ab2` | `architecture-contract.md`; contract validator 24/24; independent audit | Contract frozen; implementation still must make every consumer conform. | independent audit + root |
| R1 resident process/pause | H | PASS | `da25bdc4b264ef3bdd9bf1a6d140fba6c58d9ab2` | `harness-permissions.md`; four native lifecycle probes; independent audit | Research feasibility only; baseline product remains one-shot. DSH SDK native resume is unsupported, with explicit durable rehydrate proven. | independent audit + root |
| R2 GitHub authorization/lifecycle | G | PASS | `da25bdc4b264ef3bdd9bf1a6d140fba6c58d9ab2` | `git-lifecycle.md`; two retained private repository links | Existing OAuth credential includes an unused `workflow` scope; the product flow must request only documented minimum scopes. | root |
| R3 local Git/PR state | G | PASS | `da25bdc4b264ef3bdd9bf1a6d140fba6c58d9ab2` | `git-lifecycle.md`; basic and extended evidence hashes | Local state-machine evidence does not replace the independent live R2 provider proof. | root |
| R4 permissions/memory | H | PASS | `da25bdc4b264ef3bdd9bf1a6d140fba6c58d9ab2` | `harness-permissions.md`; descriptor 23/23; four-Adapter 24/24; independent audit | Research feasibility only; integrated product must cover Codex apply, actual service-user root and same-device mount crossing. | independent audit + root |
| R5 concurrent persistence/recovery | S | PASS | `da25bdc4b264ef3bdd9bf1a6d140fba6c58d9ab2` | `state-recovery.md`; actual-GPFS matrix 13/13; immutable evidence pin | One writer service/host only; multi-host failover requires external transactional storage. | independent audit + root |
| R6 scheduling/handoff | S/H | PASS | `da25bdc4b264ef3bdd9bf1a6d140fba6c58d9ab2` | `state-recovery.md`; v3 executable fault probe 20/20; independent rerun | Prototype proves scheduling/handoff design; four-Harness native lifecycle remains R1. | independent audit + root |
| R7 UI/compatibility | F/V | PASS | `da25bdc4b264ef3bdd9bf1a6d140fba6c58d9ab2` | `ui-code-map.md`; v2/legacy executable fixtures 58/58; independent audit | Integrated real-app screenshots remain implementation acceptance, not research evidence. | independent audit + root |
| R8 product/UI references | C/F/V | PASS | `da25bdc4b264ef3bdd9bf1a6d140fba6c58d9ab2` | `product-ui-references.md`; independent R8 source-coverage audit | Integrated status behavior and real-app screenshots remain implementation acceptance, not research evidence. | independent audit + root |

Every R0-R8 gate has concrete evidence, the contract examples are frozen, and the final cross-document/source audit found no blocking claim or product-rule gap. **信息充分，可进入实施。** A future missing or externally blocked implementation acceptance item remains visible and must never be converted to PASS by a mock.

## 2026-09-24 account/canvas extension review

The multi-account GitHub login, immutable project-account binding and canvas
global-settings extension was reviewed against current official GitHub OAuth,
token, identity, repository/scope and Primer/editor guidance. Sources, observed
facts, alternatives, decisions, affected modules and limitations are recorded
in `product-ui-references.md` under “2026-09-24 extension”. The review found
sufficient information to implement without changing P01-P22: user OAuth with
exact `repo` scope is retained, tokens remain server-only, numeric provider ID
is the identity boundary, and the existing canvas inspector remains the single
editor pattern. Live OAuth/provider acceptance still depends on a configured
deployment and is not inferred from fake-provider tests.
