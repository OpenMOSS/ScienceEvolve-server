# Concurrent state, recovery, scheduling and handoff research

[← Back to README](../../../README.md) · [中文首页](../../../README_zh-CN.md)

Research date: 2026-09-22 UTC
Code baseline: `da25bdc4b264ef3bdd9bf1a6d140fba6c58d9ab2`
Scope: R5 and R6. Product code was not changed for this research.

## Decision

R5 and R6 are **PASS after independent re-audit** with immutable evidence pins.
R5 ran on the actual GPFS mount; R6's focused v3 rerun confirmed the
auditor-requested never-started task transition without regressing the original
nineteen assertion groups. Design prose alone is not treated as evidence. Neither
status means the baseline product implements these invariants. Retaining the
existing project-wide snapshot rollback or project-wide worker lease is forbidden.

## Baseline findings

The current invocation journal stores a complete `stateBefore`, message-file list, and event/timeline lengths. Rollback and restart recovery delete later messages, truncate shared event streams and restore the whole project state. Two concurrent `beginInvocationCommit` calls can also both pass the asynchronous check-before-register window. The existing scheduler owns a worker slot by `(projectId, worker-kind)`, so capacity greater than one still rejects a second worker for the same group.

Relevant baseline symbols:

- `server/src/storage.ts`: `beginInvocationCommit`, commit/rollback, restart recovery, project mutation barrier.
- `server/src/agent-scheduler.ts`: kind pools, project ownership and FIFO waiter list.
- `server/src/types.ts`: one `currentAgent`, `queuedAgent`, `activeInvocationId` and `activeAgentExecution`.
- `server/src/orchestrator.ts`: one project loop/controller/telemetry slot and worker completion routing.
- `server/src/orchestration-control-bridge.ts`: useful per-call serialization and in-process duplicate protection, but no durable epoch fence.
- `server/src/workflow-reconfiguration.ts`: orchestration base hash but no immutable run revision or active-group edit lock.

## Reproduction evidence

The isolated probes are retained under `/tmp`:

| Artifact | SHA-256 | Observation |
| --- | --- | --- |
| `/tmp/openfars-r5-storage-probe.ts` | `105d965e15eaa710f2fac57f13fffc1ca87b43eca2455d09941ff3df2572df2e` | Sequential second begin is rejected; concurrent begins both fulfill; A rollback and restart recovery remove B's event/message and reset B's usage. |
| `/tmp/openfars-r6-scheduler-probe.ts` | `1b0455993fb21334b97bf6a34b7d7b6aa35a58655e1ee6f428a756dc6f595a92` | With worker capacity two, a second worker for the same project is rejected. Main and worker pools are separate, but an ordinary leader has no management lane. |

Observed storage state before A rollback was `eventSeq=1`, `totalTokens=37`, with B's event and message present. Afterwards it was `eventSeq=0`, `totalTokens=0`, with both B records absent. Restart recovery produced the same loss. A simultaneous A/B begin produced two journal directories.

An independent SQLite short-transaction prototype demonstrated the replacement semantics: A's stale revision update changed zero rows; after reread, the failed-execution patch changed one row while B's succeeded execution and event remained; inserting the same route key twice returned changes `[1, 0]`. JSON snapshots remain compatibility projections, not rollback authority.

The actual data directory reports `gpfs`, so SQLite WAL is rejected: WAL's shared-memory design is not appropriate for a network/distributed filesystem. A second probe ran two independent Node processes against a SQLite database on this exact GPFS mount using rollback-journal `DELETE`, `synchronous=FULL` and `busy_timeout=5000`. One `BEGIN IMMEDIATE` writer won revision 0, the other waited, observed revision 1 and changed zero rows; an intentionally exited uncommitted writer was fully rolled back. Evidence is `/tmp/openfars-r5-gpfs-sqlite-evidence.json`; probe SHA-256 is `6bfa30ec815fd8414fd4286b6af8196388f644660c3a3a3e73efc5208beca918`, and the retained database is `/inspire/qb-ilm2/project/cq-scientific-cooperation-zone/w26212/temp/openfars-r5-gpfs-f9b439c3-8ee9-4673-a710-8d0d51a0a362.sqlite`.

The complete matrix was then rerun with the selected configuration, rather than
extrapolated from the `/tmp` WAL prototype. The final retained GPFS database is
`/inspire/qb-ilm2/project/cq-scientific-cooperation-zone/w26212/temp/openfars-r5-full-0b8725fe-336c-4d84-9528-32ec8c4e22f6.sqlite`.
It verified all of the following in one run:

- two independent Node processes presented the current service owner/epoch and
  attempted revision-zero CAS; exactly one changed the row and the loser observed
  revision one;
- a live single-writer lease prevented a second service owner from starting;
  after the simulated outage/expiry the restarted service acquired and renewed
  epoch 2, while the old epoch's guarded mutation changed zero rows;
- B's success, message, 37 usage tokens and merged PR fact
  (`executions/B -> groups/7@b00b1e`), a cancellation, and Main's decision
  survived A's stale write and scoped failure recovery;
- a prepared merge operation survived service close/reopen and reconciled the
  external `merged@deadbeef` fact without replaying the mutation;
- duplicate route insertion changed rows `[1, 0]`, and an incremented ownership
  epoch rejected A's stale writer;
- an independent process presented the current writer epoch and exited 19 inside
  an uncommitted transaction; both its state overwrite and event rolled back;
- journal mode remained `delete`, synchronous was `FULL`, busy timeout was 5000,
  and `integrity_check` returned `ok` after restart and after the crash.

Command and durable reproduction record:

```text
OPENFARS_R5_EVIDENCE_PATH=/tmp/openfars-r5-gpfs-full-evidence-final-20260922.json \
  node --no-warnings /tmp/openfars-r5-gpfs-full-gate.mjs
```

| Artifact | SHA-256 |
| --- | --- |
| `/tmp/openfars-r5-gpfs-sqlite-evidence.json` | `b1c242b9eede32eab67c136665195ef37e4516bd9d4aa9ba1664bc60def4dc99` |
| `/tmp/openfars-r5-gpfs-full-gate.mjs` | `b303d3b31b75eecc82a84660695d9ee0e5cc1174ffd4b6420461e2d39c2384e2` |
| `/tmp/openfars-r5-gpfs-full-evidence-final-20260922.json` | `19908a731a1d4dbe80b6ba5476c087dacd503ecd9a36a22d9d04bd2f356bd642` |

The final evidence path is supplied explicitly so later audit reruns using the
default scratch path cannot overwrite the pinned record.

The selected first implementation is therefore Node's built-in SQLite with rollback-journal `DELETE`, full synchronous commits and short `BEGIN IMMEDIATE` transactions—not WAL. Startup verifies the effective journal mode, integrity, locking and a renewable single-writer service lease; a mismatch or provider/database failure pauses collaboration rather than falling back to unsafe JSON rollback. This gate is conditional on one writer service/host per data directory. Multi-host failover is unsupported and requires an external transactional database; this version does not silently claim it.

## Authoritative records

| Record | Required identity and invariants |
| --- | --- |
| `ProjectHead` | project id, monotonic state revision, workflow revision, at most one active outer `nodeRunId`. |
| `NodeRun` | immutable workflow snapshot; one invocation of a normal or group node; a retry request reuses it, a deliberate repeat creates another id. |
| `GroupRun` | node-run id, member snapshot, temporary leader identity, monotonic `coordinatorEpoch`, integration status. |
| `WorkTask` | stable task id, FIFO ordinal, assignee, status and current execution; at most one business task active for a member. |
| `Execution` | execution id, purpose, task, agent, `ownershipEpoch`, predecessor/successor, branch/worktree/PR and process lease. |
| `Operation` | unique operation id plus payload hash, expected local/remote facts and `prepared/observed/finalized/uncertain` status. |
| `Event` / `Usage` | unique id and complete node/group/task/execution/invocation ownership. They are append-only. |
| `RouteOutbox` | unique `nodeRunId`/route-emission id and `pending/delivered` state. Completion and outbox creation share one transaction. |

Every mutation is a short transaction: reread authoritative rows; validate project revision, active node run, workflow revision and applicable ownership/coordinator epochs; write the scoped patch, event and outbox/operation row; increment the revision; commit. Model calls, filesystem scans, native-process waits, local Git and provider calls occur outside the transaction. A conflict rereads and recomputes; it never restores a project snapshot.

## External-operation protocol

1. In a short transaction, record a deterministic `operationId`, payload hash and expected branch/head/base facts as `prepared`.
2. Release the transaction, then call local Git or the provider.
3. In a new short transaction, verify execution/ownership epoch and expected facts, then store the observed result.
4. If the response is lost or the service restarts, query the remote by deterministic repository, branch, head/base and marker before retrying.
5. The same operation id plus same payload returns the prior fact; the same id plus a different payload is rejected.

Remote success is never undone by local snapshot restoration. A merged PR is reconciled as merged even when the caller missed the response.

## Scheduling and process leases

- Scheduler ownership is `executionId`, not project id. The persistent task state decides eligibility.
- The single-outer-node rule is enforced by `ProjectHead.activeNodeRunId`; it is not approximated by denying a second worker.
- Different members in the active group may hold worker leases concurrently. A member may hold only one unfinished business lease; queued tasks are FIFO by ordinal or one atomic claim transaction.
- An unfinished execution keeps its native agent process and business lease while waiting for authorization, review, merge, conflict repair or management input.
- Main and a temporary leader use a separate management-purpose lane/reserved capacity. Management work does not convert the leader into a business worker and cannot create a leader delivery PR.
- Restart reconstructs eligible work from task/execution/operation records, not from an in-memory waiter queue.

## Failure handoff and fencing

An execution moves `working -> stop_requested -> stopped | failed | superseded`. Its task moves `working -> continuation_pending -> assigned(successor)`. A transfer transaction is allowed only when the original process has confirmed stop/no-write, the task still names the original execution, the ownership and coordinator epochs still match, and the successor has finished its own current task. It increments the ownership epoch and creates a successor execution linked to the predecessor.

If stop cannot be confirmed, the group enters `waiting_for_stop` and no successor writer starts. Late bridge calls, Git finalization and provider responses from the old execution are rejected by the durable ownership epoch. The failed member does not re-enter that group run.

Special cases remain distinct:

- all members failed: pause the node; Main may perform bounded recovery only; no leader delivery;
- ordinary leader failed: increment coordinator epoch and record Main as temporary acting coordinator;
- Main failed: freeze new assignment, routing and merge, persist safe facts, attempt bounded restart/reconciliation, otherwise await the user;
- final integrator failed: use the same stop/epoch/reconcile handoff, without adding a Main approval state.

## Dynamic-edit and routing rules

A node/group run stores an immutable workflow revision and member snapshot. The affected group cannot be edited from activation through final-PR resolution; member completion alone does not unlock it. Later edits create a new revision and never rewrite history. Normal nodes keep their existing `decisionBy`, finish and termination semantics.

Group completion and a single route-outbox record are committed together. Delivery can retry, but the route-emission identity is consumed once. A group member completion only updates its group; it never calls the ordinary `queueAgentAfterWorker` path and never invokes `complete_project`.

## Executable R6 fault-injection evidence

The final prototype was syntax-checked and run twice consecutively:

```text
node --check /tmp/openfars-r6-fault-scheduler-probe.mjs
OPENFARS_R6_EVIDENCE_PATH=/tmp/openfars-r6-fault-scheduler-final-v3.json \
  node /tmp/openfars-r6-fault-scheduler-probe.mjs
```

Both isolated runs returned `PASS`: 20 assertion groups and 52 ordered durable events. The
retained run proved one active outer node; two-process atomic FIFO claim; different
member concurrency and one-active-execution-per-member; two live worker PIDs plus
a separately heartbeating management PID; coordinator-epoch fencing; confirmed
stop before A-to-B continuation; B finishing its own task first; stale A rejection;
and no successor when stop is unconfirmed.

The revised run also exercised two distinct all-member-failure paths. In the
success path the stable management identity `main` recovered one member on the
first bounded attempt, created exactly one successor owner at ownership epoch 2,
and returned that owner on replay. In the exhaustion path two attempts created no
new owner and ended at `waiting_for_user_all_members_recovery_exhausted`. The
failure transaction changed formerly active tasks to `continuation_pending` and
the explicit never-started `task-X-never-started` from `pending`/no execution to
`failed`/no execution. A SQL assertion found no
`pending|assigned|working|waiting` task left in that group, while both claimed
tasks remained `continuation_pending`.

Every successful delivery/integration execution has its own PR row and ordered
events showing `pull_request.merged` before `execution.succeeded`: own delivery
`8 < 9`, handoff delivery `12 < 13`, and final integration `23 < 24`. A completion
decision after final merge but before final execution success was rejected. The
leader remained management-only, final integration added no Main approval state,
and transactional completion/outbox/downstream activation still deduplicated with
insertion counts `[1, 0]`. Persisted Agent IDs and event actor IDs use `main`;
`Main` appears only as a display name.

| Artifact | SHA-256 |
| --- | --- |
| `/tmp/openfars-r6-fault-scheduler-probe.mjs` | `3b9369ccaa2ac2b9a7fc44ea955c43ea9e3e66162431140184479fe7c49a6364` |
| `/tmp/openfars-r6-fault-scheduler-final-v3.json` | `fb7b1b701602a9e4c41ea98a32b0c43ba881427b69e3bbeade9fe1095a4da355` |
| `/tmp/openfars-r6-fault-scheduler-report.md` | `a9cdaa047766475e36e914f2ed251e41cb33395fa73d48b55e93f6271607c6a0` |

The retained database is
`/tmp/openfars-r6-fault-scheduler-4juN21/scheduler.sqlite`, using Node 24.20.0
and SQLite rollback journal `DELETE`, synchronous `FULL`, with integrity `ok`.
The real child processes establish lane availability, heartbeat and stop fencing;
they are inert Node processes rather than Harnesses. R1 separately owns the four
Harness lifecycle evidence, R2/R3 own real Git/GitHub, and R5 owns the GPFS storage
configuration.

The evidence writer uses exclusive create (`wx`) at the caller-supplied path;
the fixed final record therefore cannot be overwritten by a later audit rerun.

## Fault-injection matrix for implementation

| Scenario | Required assertion |
| --- | --- |
| A fails while B updates messages/events/usage/PR and Main decides | Recovering A preserves every B/Main fact and never truncates a shared stream. |
| Two executions commit the same revision | Exactly one CAS wins; loser rereads; no duplicate journal. |
| PR/merge succeeds but response/finalization is lost | Restart observes remote truth and neither duplicates the PR/merge nor route. |
| Same operation id is replayed | Same payload returns prior fact; different payload is rejected. |
| Completion crashes before or after delivery acknowledgement | Exactly one route identity exists and downstream is activated once. |
| Workers saturated by resident members | Different members run concurrently; same member stays FIFO; Main/leader management remains schedulable. |
| A fails while B works | B finishes its task before continuation; A never re-enters. |
| Stop times out or errors | No successor writer starts. |
| Old process/bridge/remote reply arrives after transfer | Epoch fence rejects every stale write/finalize. |
| Group is edited while working, PR-open or integrating | Edit is rejected; after whole-group completion a new revision may be saved. |
| SSE reconnects during concurrent telemetry | Every event retains execution ownership and global replay order. |

## Gate limitations

The baseline implementation deliberately fails these invariants and must be replaced before AC15–AC24, AC27–AC29 can pass. The prototypes establish the storage and scheduler direction; they do not substitute for product tests. Implementation must add maintainable concurrency, outbox, reconciliation and handoff tests on the integrated code.
