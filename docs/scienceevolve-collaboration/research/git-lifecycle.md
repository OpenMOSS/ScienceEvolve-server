# R2/R3 Git and GitHub gate evidence

[← Back to README](../../../README.md) · [中文首页](../../../README_zh-CN.md)

Date: 2026-09-22 UTC
Baseline: `da25bdc4b264ef3bdd9bf1a6d140fba6c58d9ab2`

## Authorization and live provider result (R2)

The installed Git credential helper returned a GitHub credential without printing it. An authenticated `GET /user` returned 200. The response advertised `read:user, repo, user:email, workflow`; only `repo` operations were exercised. No Actions API or workflow file was used.

The isolated live test created and retained the private repository [openfars-r2-gate-20260922-f07dfeda](https://github.com/Zyrrick/openfars-r2-gate-20260922-f07dfeda). It then:

1. initialized local `main` and pushed commit `e02856c55c3eef3238e7afa6eb891d17d8a63166`;
2. pushed `executions/r2-gate` at `9d977223eec4670a4b1390f66ee982b67fdc539a`;
3. opened [PR #1](https://github.com/Zyrrick/openfars-r2-gate-20260922-f07dfeda/pull/1) to `main` (HTTP 201);
4. observed `mergeable: true`, requested a merge with the expected head SHA, intentionally treated the mutation result as uncertain, then fetched the PR and confirmed `merged: true` with merge commit `2f45e5659a6d6ba85c59910720a68752a767392f`;
5. repeated the merge request and received the same successful semantic result, demonstrating why the local completion event must be deduplicated;
6. checked an invalid credential and received 401, the required authorization-loss signal.

Machine evidence was written to `/tmp/openfars-r2-evidence.json`. The test repository is intentionally retained; nothing was deleted or force-pushed. R2 is PASS for this environment's authenticated-user provider. The product must not assume every future credential has the same scopes and must verify before initialization.

The initialization retry probe created and retained a second private repository,
[openfars-r2-init-retry-20260922-c0d91406](https://github.com/Zyrrick/openfars-r2-init-retry-20260922-c0d91406).
It persisted the returned repository id `1382153885`, injected a crash after the
successful create and before local initialization, then resumed by querying that
exact owner/name instead of issuing another create. It next pushed
`main@e7ebde50d9d212bd40abc8348155de13d27a35c5`, discarded the successful push
response, and recovered by reading the remote ref. A complete replay resolved the
same repository id and commit. All assertions passed and no Actions/workflow
endpoint or workflow file was used. The `requestedOAuthScopes` field in the
temporary evidence is the product's target scope contract, not a claim that the
pre-existing test credential lacks its already observed extra `workflow` scope.

## Local branch/worktree/conflict result (R3)

The `/tmp` prototype created `main@69ab39a7adcf6fe80fb55523553203e8540101b5`, `groups/run-1`, and two distinct worktrees/branches (`executions/exec-a`, `executions/exec-b`). Both members changed the same line from the same group base.

- A merged first into the group.
- B's group merge exited 1 with `shared.txt` unresolved.
- The platform did not select ours/theirs. B merged the current group into B's own worktree, saw the same conflict, resolved it to preserve both contributions and committed the resolution.
- The resolved B branch merged into the group, then the group merged to `main`.
- Repeating the final merge returned `Already up to date`; `groups/run-1` was an ancestor of `main`.

Machine evidence was written to `/tmp/openfars-r3-evidence.json`. This validates ref/worktree isolation and owner resolution. Provider-side identity and uncertainty are covered by R2 rather than mocked here.

An extended local gate then exercised the remaining lifecycle states in one
retained fixture:

- a report PR changed both `report.md` and
  `agent-memory/analyst/Memory.md`, proving that a non-code task and its business
  memory still have meaningful Git delivery;
- a real child process was sent `SIGTERM` and its exit was observed before a
  successor branch/worktree was created from the failed execution; an incremented
  ownership epoch rejected the predecessor writer;
- a cancelled execution kept its branch, commit and worktree, was represented as
  a closed/unmerged PR, and was not an ancestor of `main`;
- an intentional final `main`/group conflict failed without an automatic strategy;
  a member-owned integrator repair branch resolved it, merged back into the group,
  and only then allowed the group-to-`main` merge;
- replaying the final merge was `Already up to date`; replaying the same operation
  id returned its prior fact, while a different payload for that id was rejected.

Every assertion in `/tmp/openfars-r3-extended-evidence.json` is true. This is a
local Git state-machine probe; live provider create/PR/merge/reconciliation remains
the independent R2 evidence rather than being replaced by a mock.

## Reproduction ledger

All probes ran against baseline `da25bdc4b264ef3bdd9bf1a6d140fba6c58d9ab2`
with Git 2.43.0 and Node 24.20.0. Commands were:

```text
node /tmp/openfars-r2-gate.mjs
node /tmp/openfars-r2-init-retry-gate.mjs
node /tmp/openfars-r3-gate.mjs
node /tmp/openfars-r3-extended-gate.mjs
```

| Artifact | SHA-256 |
| --- | --- |
| `/tmp/openfars-r2-gate.mjs` | `9d95013f6427d994d0c80ec30355a95905c5ab048c7d1793871b9c89a677562b` |
| `/tmp/openfars-r2-evidence.json` | `927a434f88b38cb03a8c6976bfc77138bde12450b6f719573bff2fcbb5e5b1ae` |
| `/tmp/openfars-r2-init-retry-gate.mjs` | `dcbe3ce94991200be6880def5eb73a86b9213bd98dc99cd65c59b318bc7bdf3c` |
| `/tmp/openfars-r2-init-retry-evidence.json` | `bf2b0465467d07fe17193539a41e64fe121f2053e125789365606286e63ec81a` |
| `/tmp/openfars-r3-gate.mjs` | `0045c835412ef1161bb317582015dc7f6d6ba421b28a411154410207dffeb447` |
| `/tmp/openfars-r3-evidence.json` | `ddeabcfadb21fc9d0bd8fd11fd8e9f15c9a3e9aed9602884556a12bef8814012` |
| `/tmp/openfars-r3-extended-gate.mjs` | `18b36b20a09a1478efce061214a231ad29127eb302d4e4938de856e740bfee37` |
| `/tmp/openfars-r3-extended-evidence.json` | `e7c4dc3c57342b950385c13c9e8282457b40fda8bacf6a631c43807324686d1f` |

The live repositories and GPFS-side evidence databases are intentionally retained.
Temporary fixtures are diagnostic copies; the commands, versions, identities,
remote URLs, commit facts, assertions and content hashes above are the durable
review record.

## State-machine implications

- Every remote mutation carries an `operationId`, expected head/base and owner execution. The operation is recorded before the network call.
- Timeout or lost response transitions to `reconciling`, not directly to retry; a read of repository/PR facts decides the next step.
- `merged` is a remote fact; `succeeded` is committed only once after that fact and cannot be inferred from process exit or model prose.
- A conflicting member remains `resolving` and owns a new resolution execution/commit. The shared group branch is not modified by an automatic content strategy.
- Git initialization is step-journaled. A failed step keeps the remote and local repository and resumes in place.
- Authorization 401/403 becomes `waiting_for_github`; it is not a merge conflict and never triggers creation of a replacement repository.

R2: **PASS**. R3: **PASS**. Limits: external organization rules and every possible GitHub authorization product were not tested; the selected user-credential path was tested end-to-end, and the provider must surface other repository rules as blockers.
