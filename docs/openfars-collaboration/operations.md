# Git-on collaboration operations

[← Back to README](../../README.md) · [中文首页](../../README_zh-CN.md)

This runbook covers the production operating boundary for OpenFARS Git-on
collaboration. It describes supported recovery and operator actions; it is not
an acceptance report.

For new Git-on projects, the current recursive scope model is v3. Its fixed
Agent-directory/session contract, nested graph editing, scoped Leader authority
and direct-parent PR delivery are documented in
[Scoped Workflow v3](scoped-workflow-v3.md). The legacy flat-group/task and
execution-owned-worktree descriptions below remain applicable to existing v2
projects; do not use them to migrate a running v2 project's native sessions.

## Supported deployment envelope

- Run exactly one OpenFARS writer service for a data directory, on one host.
  The collaboration authority is SQLite with a renewable service writer lease;
  multi-host writers and rolling active/active failover are unsupported.
- Run the server, web application, database schema, Harness adapters, and
  resident process protocol from the same OpenFARS build. Mixed-version rolling
  operation is unsupported.
- The Git provider in this release is GitHub for an authenticated user. Set up
  a GitHub OAuth App and configure `SCIENCEEVOLVE_GITHUB_OAUTH_CLIENT_ID`,
  either `SCIENCEEVOLVE_GITHUB_OAUTH_CLIENT_SECRET` or the safer
  `SCIENCEEVOLVE_GITHUB_OAUTH_CLIENT_SECRET_FILE`, and
  `SCIENCEEVOLVE_GITHUB_OAUTH_CALLBACK_URL`. The current authenticated-user flow
  requests `repo` for personal repository creation and repository/PR
  operations. OpenFARS does not request `workflow` or create GitHub Actions
  workflows.
- Codex, Claude Code, DSH, and pi are real resident Harness implementations.
  Each configured Harness binary, gateway, and model route must pass the
  product's validation before it is admitted to a project. DSH crash recovery
  uses durable transcript rehydration rather than claiming native same-session
  resume.
- Git branches, linked worktrees, commits, pull requests, and failed execution
  attempts are durable evidence. OpenFARS intentionally does not delete them
  automatically.

## Preflight

Before enabling Git-on collaboration:

1. Verify that the data directory and repository/worktree filesystem are on the
   supported single host, are writable by the service account, and have enough
   free bytes and inodes for retained history.
2. Verify that no other OpenFARS service owns or is trying to acquire the same
   SQLite writer lease. A second writer must fail closed; do not work around the
   lease by copying or editing the database.
3. Open the global GitHub account library, complete OAuth login, verify the
   authenticated identity and `repo` scope, and select that account when
   creating the project. Do not put a token in a project record, command line,
   URL, environment intended for a Harness, or checked-in configuration.
4. Verify Git/GitHub connectivity and any organization, branch-protection,
   status-check, review, or merge-queue rules that can block a merge.
5. Validate every selected Harness + gateway + model combination. A catalog
   entry or executable on `PATH` alone is not readiness evidence.
6. Configure alerts for filesystem bytes/inodes, SQLite or writer-lease errors,
   resident process growth, retained worktree count, open/conflicted PRs, and
   projects waiting on authorization or stop proof.

## Git-on initialization and retry

Initialization is a durable, idempotent operation. OpenFARS records the planned
operation, creates or observes the GitHub repository with the selected
visibility (Private by default), initializes the local repository, and
finalizes the same operation identity. If a response is
lost, recovery observes provider state before deciding whether another request
is needed.

If initialization pauses for GitHub authorization or an uncertain provider
response:

1. Inspect the read-only project Git facts and the GitHub repository directly.
2. In the global account library, reauthorize the same bound GitHub identity
   and verify its required scope. Do not select another account for an existing
   project.
3. Use Resume/retry on the existing project. This retries the same durable
   initialization in place and reconciles an already-created repository.
4. Do not delete and recreate the remote repository, remove the local
   repository, or edit the operation journal to force a fresh attempt.

OpenFARS does not delete a remote repository on retry, cancellation, failure,
or project restart. Destructive provider administration remains outside the
product recovery contract.

## Normal collaboration operation

A collaboration group has one management-only leader and one or more member
executions. Members work in execution-owned branches and linked worktrees.
Delivery PRs merge into the group branch; final integration owns the fenced
group branch and proposes the accepted result to `main`. Main and group leaders
do not receive a delivery worktree merely because they coordinate the run.

Main route authority contains two distinct server-derived lists: every legal
candidate and the subset of collaboration targets that may be activated with
only the current state. A `route_to_agent` call may omit `assignment` only for
an exact member of that taskless subset. An ordinary Agent target still needs a
non-empty assignment; `finish` and `complete_project` keep their separate
terminal rules. This exception is checked at tool discovery, resident turn
binding and durable action revalidation, not inferred from prompt text.

Long-lived groups keep the assignment prompt bounded. For a selected member
task the service includes, in order of priority, that current task, as much
nonterminal FIFO work in the current round as fits, then—only while capacity
remains—the current task's transitive dependency closure and newest terminal
history until the 50-record limit is full. Operators should not interpret a
capacity-omitted dependency or old terminal row as data loss; the durable
journal remains append-only, and exact recovery lookups are not limited by the
prompt window.

Management memory remains separate from business delivery. Leader input puts
the current coordinator's entry first and applies per-entry/total bounds; a
delivery member receives only its own bounded management entry. Every injected
entry identifies `branch@commit:path` and is labelled read-only coordination
context. If the expected provenance is absent or belongs to another Agent, do
not paste management history into a business worktree as a workaround.

Published Git-on artifacts are accepted only after the owning execution's PR is
observed merged. Their records bind the execution and ownership epoch to an
immutable commit, tree/blob path, PR, and accepted base. Artifact reads resolve
that Git object; they do not fall back to a mutable role workspace. Main may use
`select_display` only for already-published merged artifacts. At acceptance the
service resolves and persists both the opaque `artifactId` and `commitSha`.
Every later display UI read supplies that exact pair; a missing, mismatched or
ambiguous display binding fails closed rather than selecting a newer file with
the same Agent/path. General artifact browsing may use one selector only when
it resolves one accepted publication; it does not weaken or rewrite the
persisted display binding. Main management files and workflow proposals are
not business artifacts.

The collaboration UI is an observation surface. Repository, branch, worktree,
commit, PR, mergeability, blocker, attempt, and artifact views are read-only.
There are no OpenFARS UI actions for merge, revert, force-push, branch deletion,
worktree cleanup, or repository deletion. A link to GitHub leaves OpenFARS and
may expose actions allowed by that external account; those actions are governed
by GitHub, not by the OpenFARS UI contract.

## Inbox and checkpoint isolation

For a Git-on business execution, the authoritative Inbox is a server-owned
message and its invocation mirror is staged under the server runtime directory,
outside the delivery worktree. `.scienceevolve/` is reserved transient state and is
ignored from the initial repository. A checkpoint fails closed if that path is
already tracked, no longer ignored, is a symlink instead of the canonical
worktree directory, or appears in the frozen tree.

The service never commits through the worker's shared index. It creates a fresh
private index beneath the reserved transient directory, seeds it from the
observed execution head, stages business changes with an explicit `.scienceevolve`
exclusion, validates the resulting tree, creates a commit with the required
merge parent(s), and advances the execution branch with compare-and-swap. It
then clears only merge pseudorefs proven to belong to that commit and resets
the shared index in non-cancellable cleanup. Stale private index and lock files
are never reused.

Do not move an Inbox into a worktree, remove the ignore rule, replace
`.scienceevolve` with a link, or run service checkpoints by hand. The private-index
boundary guarantees that OpenFARS's checkpoint operation does not hash or
commit the Inbox and that a concurrent shared-index stage cannot enter its
tree. It does not make a same-UID, yolo-capable worker unable to invoke Git
itself: such a process can write an otherwise unreachable secret blob to the
shared object database even though the service will not reference it from a
commit. Operate trusted Harnesses, keep secrets out of worktrees, and treat
same-UID yolo as the disclosed containment limitation.

## Pause, resume, and cancel

### Pause

Pause is a safe-point operation. OpenFARS first lets an active model turn reach
its turn boundary, blocks new turns, and then pauses the resident processes.
Git/provider mutations already committed before the safe point remain durable.

- Do not treat an HTTP acknowledgement alone as proof that an in-flight turn
  was interrupted mid-token.
- A paused project keeps its resident identity, worktrees, branches, PRs, and
  sessions. It is not cleaned up or reassigned.
- Pause is an orchestration control, not an OS security boundary.

### Resume

Resume continues the same admitted authority where that is still safe. If the
service restarted or a resident was lost, recovery first stop-confirms the old
process authority and advances the relevant ownership/coordinator epoch before
opening another writer. A persisted authorization-stage output can continue its
Git operation without another model turn.

A Resume, completed-project continuation, or intervention reply may become
durable while the prior run promise is still unwinding. The scheduler attaches
the continuation to that exact settling promise and admits it only after the
old run has left the duplicate-run map. An acknowledged request must therefore
either start after settlement or remain durably diagnosable; operators should
not issue repeated Resume calls merely because the previous turn is still
closing.

Before resuming, clear the external cause: restore authorization, resolve a
provider policy blocker, restore capacity, or repair the configured Harness
route. Repeated Resume calls do not authorize bypassing a stop fence or stale
epoch.

### Cancel

Cancellation durably requests stop for every active execution and the group
coordinator, closes in-process residents, reconciles orphaned process groups,
and records stop confirmation before settling terminal state. Operators should
wait for the cancellation-settled state (or the API's settlement option) before
taking a storage snapshot or assuming writers are gone.

Cancellation does not delete branches, worktrees, commits, PRs, repositories,
or published artifacts. A remote PR may be closed or reconciled according to
the fenced state machine, but its history remains provider evidence.

## Failure and recovery runbook

| Condition | Expected behavior | Operator action |
| --- | --- | --- |
| GitHub authorization loss | The project pauses or the execution remains at a durable authorization boundary. Persisted model output and Git stage are retained. | Restore the credential/scope for the intended account, verify provider access, then Resume. Do not rerun or delete the execution manually. |
| Lost GitHub response | OpenFARS re-observes repository/PR/merge facts and reuses the durable operation id. | Check the read-only provider facts. If state remains uncertain, fix connectivity and Resume; do not create a replacement PR by hand. |
| Independent Main failure | Main authority is frozen. Recovery requires prior-process stop proof and is bounded; exhausted recovery pauses for operator intervention. | Correct the Harness/gateway/capacity fault, confirm only the current service version is running, and Resume. |
| Group leader failure | The old coordinator epoch is stop-confirmed before a fresh coordinator epoch opens. An eligible non-Main leader may be substituted by Main through the durable state transition. | Restore the failed Harness route if needed and observe the new coordinator epoch. Never start a second leader outside OpenFARS. |
| Member failure | The old execution epoch is fenced and stop-confirmed. Handoff/recovery preserves the old attempt and gives the successor a fresh writer epoch and durable provenance. | Fix the underlying fault and let Resume/recovery perform reassignment. Keep the predecessor branch/worktree/PR intact. |
| Merge conflict | The owning retained execution resolves the prepared conflict and pushes a new fenced checkpoint; OpenFARS never selects `ours`/`theirs` silently. | Inspect conflict/blocker facts. Restore the owner Harness or resolve external policy blockers, then Resume. |
| Service crash/restart | SQLite facts, launch provenance, process claims, markers, and provider observations are reconciled before a new writer opens. | Restart exactly one service using the same build and data directory. Do not delete runtime markers or launch claims to make recovery proceed. |
| Stop proof cannot be established | Ownership remains fenced and the project pauses/fails closed rather than opening a competing writer. | Investigate the process namespace, service account, `/proc` access, and retained claim/marker files. Escalate; do not edit the claim or advance epochs manually. |

The durable database is authoritative for ownership and provider facts. Files in
runtime directories are part of process reconciliation, not operator switches.
Manual SQLite updates, marker deletion, branch rewrites, and worktree removal
can invalidate recovery and are unsupported.

## Upgrade: drain and restart one version

Do not perform an in-place rolling upgrade with old and new OpenFARS services
overlapping on the same data directory.

1. Stop admission of new project work at the ingress/operator layer.
2. Let active turns reach a safe boundary. Allow projects to complete, or Pause
   them; use Cancel only when termination is intended. Wait for all requested
   cancellations and stop confirmations to settle.
3. Stop the sole writer service cleanly. Confirm that the old service no longer
   owns the writer lease and that no old-version server is being restarted by a
   supervisor.
4. If a backup is required, take a storage-consistent snapshot only after the
   writer is stopped. Keep the SQLite database, project state, repositories,
   linked worktrees, runtime evidence, and permissions together.
5. Deploy one internally consistent OpenFARS build (server, web assets, schema,
   Harness adapters, and resident protocol) and start exactly one writer.
6. Verify writer-lease acquisition and startup reconciliation before restoring
   admission. Resume paused projects gradually while watching authorization,
   stop-proof, resident, Git, and capacity alerts.

If the new version cannot reconcile state, stop it and investigate or restore a
consistent snapshot. Do not run the old and new versions concurrently as a
rollback technique.

## Credentials and diagnostic handling

- GitHub access/refresh tokens are held by the global account store, encrypted
  with AES-256-GCM in `github-accounts.json`; its local key is
  `github-accounts.key`. Both files are mode `0600`, must be backed up and
  restored together, and never belong in Git, support bundles, project JSON or
  the collaboration database. Project state contains only the local account
  id plus provider numeric identity/display metadata. Production Git receives
  an account-scoped resolver and never falls back to the service account's
  ambient credential helper.
- Gateway/API credentials are injected into the trusted invocation route and
  protected environment boundary. They must not be written to Inbox, Memory,
  artifact metadata, model-visible diagnostics, or Git commits.
- Durable collaboration payloads recursively reject credential-shaped field
  names and values. The shared vocabulary covers case and underscore/hyphen
  variants of authorization, password, secret/private key, credential, API
  key and access/refresh/id/auth token; Bearer/Basic values; GitHub and `sk-`
  tokens; credential-bearing URLs; PEM private keys; `AWS_ACCESS_KEY_ID` and
  `AWS_SECRET_ACCESS_KEY` assignments/fields; and raw 20-character `AKIA` or
  `ASIA` access IDs. Free-form traces redact the same forms and are bounded.
- A business report or management-memory update that resembles a credential is
  rejected before durability. Remove the value or replace it with a safe
  digest/reference and retry; do not weaken the detector or copy the value into
  a differently named field.
- Do not expose the OAuth Client Secret/account key through shell tracing or
  dump resident environments and `/proc/*/environ` into incident tickets.
- Treat logs, traces, SQLite exports, and support bundles as sensitive even
  though the application redacts credential values. Review a bundle before it
  leaves the operating environment.
- After credential rotation, validate the affected GitHub or gateway route and
  Resume the existing durable operation; do not replace project identity to
  work around authorization state.

## Process containment limitation

On Linux, the trusted resident supervisor durably records boot identity, PID
namespace, outer/inner PID and process-group identity, session identity, and
start ticks before it may spawn the native CLI. The native CLI is observed to
start as the supervisor's direct child in the same process group and session.
Stop recovery signals that claimed group and verifies that the exact scoped
authority is absent before ownership advances.

This is strong crash fencing for the trusted, cooperative CLI behavior used by
the four supported Harness adapters. It is **not whole-process-tree OS
isolation** when OpenFARS is deployed without a controlling cgroup (or an
equivalent external containment boundary). A non-cooperative CLI can call
`setsid`/`setpgid`, clear the OpenFARS authority environment, and thereby escape
both the original process group and the supplemental environment scan. Do not
claim that the current process-group proof contains hostile arbitrary child
processes.

Operate only trusted Harness binaries under a dedicated service account. If
hostile-code process-tree containment is a requirement, provide and validate an
external OS/container cgroup boundary and an incident-time way to terminate the
entire unit; that deployment control is outside the current OpenFARS resident
claim protocol.

## Retention and capacity

There is no automatic cleanup policy for collaboration Git evidence. Alert on:

- filesystem free bytes and inodes;
- repository object growth and linked-worktree count;
- retained execution branches and open/conflicted/closed PR count;
- SQLite size, integrity/startup errors, and writer-lease renewals;
- resident and descendant process count;
- projects paused for GitHub, user intervention, stop proof, or recovery limit;
- external GitHub checks, reviews, branch protection, merge queues, quotas, and
  rate limits.

Capacity pressure must pause admission before the filesystem is exhausted.
Manual archival or cleanup requires a separately reviewed procedure that
preserves every object referenced by durable execution, PR, artifact, display,
and recovery records. The current product does not provide that procedure or a
safe cleanup button.
