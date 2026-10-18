# OpenFARS collaboration contract v2

[← Back to README](../../../README.md) · [中文首页](../../../README_zh-CN.md)

Contract version: `openfars-collaboration-v2.0`
Freeze status: frozen after independent R0 re-audit on 2026-09-22 UTC
Compatibility baseline: `da25bdc4b264ef3bdd9bf1a6d140fba6c58d9ab2`

## Identity and configuration

`AgentId`, `WorkflowNodeId`, `NodeRunId`, `GroupRunId`, `TaskId`, `ExecutionId`, `InvocationId`, `PullRequestId` and `OperationId` are different stable identities even when some are represented as strings. Display names and canvas positions are never identities.

The existing flat `agents` array remains the configuration registry. v2 adds `schemaVersion: 2` and `collaborations`; the set of routable outer nodes is `main`, every Agent not in a collaboration, and every collaboration id. A collaboration member remains in the Agent registry for model/Harness configuration but is absent from outer input, routes, termination, Main candidates and canvas geometry.

```ts
type NodeRef =
  | { kind: "agent"; nodeId: WorkflowNodeId; agentId: AgentId }
  | { kind: "collaboration"; nodeId: WorkflowNodeId; groupId: string };

interface CollaborationNode {
  id: string;
  displayName: string;
  memberAgentIds: AgentId[];
  renamePolicy: "editable" | "locked";
}

interface AgentOrchestrationTemplateV2 {
  schemaVersion: 2;
  agents: AgentDefinition[];
  collaborations: CollaborationNode[];
  input: { source: "input"; target: WorkflowNodeId };
  routes: Record<WorkflowNodeId, WorkflowEdge[]>;
  decisionPlans: Record<WorkflowNodeId, string>;
  allowUserIntervention: boolean;
  allowMainReconfiguration?: boolean;
  termination: {
    /* legacy field name; v2 value is an outer node id */
    agent: WorkflowNodeId;
    condition: string;
    decisionBy: "main";
    automatic: boolean;
  };
  resultFormat?: ResultFormat;
  canvas?: WorkflowCanvasLayout;
}
```

There is deliberately no `goalPrompt`, `leaderMode`, parent group, member mirror node or migration switch. Group input may contain only the current-state snapshot; `optionalTask` is optional.

Taskless activation is an explicit authority property, not a globally optional
route assignment. Each Main route turn carries `candidates` plus
`tasklessRouteTargets`, a duplicate-free subset computed from the current v2
workflow. A `route_to_agent` action may omit `assignment` only when its exact
target is in that subset (a collaboration node). Ordinary targets require a
non-empty assignment. `finish` is not a taskless target, and project completion
continues to use its separately authorized terminal action. The subset is
serialized into resident discovery/turn control and revalidated by the durable
state transaction so a model, stale resident or forged bridge payload cannot
widen it.

## Git configuration and public state

```ts
interface ProjectGitInput {
  enabled: boolean;
  provider?: "github";
  repositoryName?: string;
}

interface ProjectGitState {
  enabled: boolean;
  status:
    | "disabled" | "authorizing" | "creating_repository"
    | "initializing_local" | "pushing_main" | "ready"
    | "waiting_for_github" | "failed";
  provider?: "github";
  repository?: {
    owner: string;
    name: string;
    htmlUrl: string;
    private: true;
    defaultBranch: "main";
    localPath: string;
  };
  initialization?: {
    operationId: OperationId;
    attempt: number;
    completedSteps: string[];
    error?: string;
  };
}
```

Omitted `git` means `{ enabled: false, status: "disabled" }`. Git mode is immutable after creation. A group with Git disabled is rejected before execution. Public state never contains credentials or authorization tokens.

## Runtime records

```ts
interface NodeRun {
  id: NodeRunId;
  node: NodeRef;
  workflowRevision: number;
  activationRequestId: string;
  inputSnapshotRef: string;
  optionalTask?: string;
  sourceNodeRunId?: NodeRunId;
  sourceAgentId?: AgentId;
  activatedByAgentId: AgentId;
  status: "preparing" | "queued" | "coordinating" | "running" | "integrating" |
    "paused" | "blocked" | "cancelled" | "failed" | "completed";
  routeEmissionId?: string;
}

interface GroupRun {
  id: GroupRunId;
  nodeRunId: NodeRunId;
  memberSnapshot: AgentId[];
  leaderAgentId: AgentId;
  actingCoordinatorId?: AgentId;
  coordinatorEpoch: number;
  baseCommit: string;
  groupBranch: string;
  integrationTarget: "main";
  integrationOwnerExecutionId?: ExecutionId;
  finalPullRequestId?: PullRequestId;
  taskIds: TaskId[];
  status: "preparing" | "coordinating" | "running" | "integrating" |
    "paused" | "blocked" | "cancelled" | "failed" | "completed";
}

interface WorkTask {
  id: TaskId;
  nodeRunId: NodeRunId;
  groupRunId?: GroupRunId;
  assignment: string;
  assigneeAgentId?: AgentId;
  dependencyTaskIds: TaskId[];
  queueOrdinal: number;
  currentExecutionId?: ExecutionId;
  status: "pending" | "assigned" | "working" | "waiting" |
    "continuation_pending" | "succeeded" | "failed" | "cancelled";
}

interface MemberExecution {
  id: ExecutionId;
  nodeRunId: NodeRunId;
  groupRunId?: GroupRunId;
  taskId: TaskId;
  agentId: AgentId;
  purpose: "delivery" | "final-integration";
  ownershipEpoch: number;
  status: "queued" | "working" | "waiting_authorization" |
    "waiting_review" | "pr_open" | "resolving" | "merged" |
    "stop_requested" | "stopped" | "superseded" |
    "succeeded" | "failed" | "cancelled";
  executionBranch: string;
  worktreePath: string;
  pullRequestId?: PullRequestId;
  invocationId?: InvocationId;
  sessionId?: string;
  predecessorExecutionId?: ExecutionId;
  successorExecutionId?: ExecutionId;
  failureReason?: string;
}

interface PullRequestRecord {
  id: PullRequestId;
  providerNumber: number;
  htmlUrl: string;
  head: string;
  base: string;
  ownerExecutionId: ExecutionId;
  status: "open" | "conflicted" | "closed" | "merged" | "unknown";
  mergeCommitSha?: string;
  observedAt: string;
}
```

The project has at most one `activeNodeRunId`; that node run may own several active member executions. A new intentional activation uses a new node-run id. Replaying the same `activationRequestId` returns the existing run.

The durable task journal is not truncated for model context. When a member is
assigned work, at most 50 task records are rendered into that prompt: the
current task first, then as much nonterminal FIFO work as the remaining
capacity permits; if capacity remains, the current task's transitive dependency
closure is added, followed by newest terminal history. The selected records are finally rendered in stable
`queueOrdinal`, id order. Recovery/event fact lookup is exact and unbounded by
the presentation window; regressions cover journals beyond 100k/125k events.

## Events and operations

Every collaboration event adds the following optional envelope fields to the existing project event shape: `eventId`, `requestId`, `workflowRevision`, `nodeId`, `nodeRunId`, `groupRunId`, `agentId`, `taskId`, `executionId`, `invocationId`, `ownershipEpoch`, `coordinatorEpoch`. Global `seq` remains monotonic and is used for SSE replay. No credential is stored in an event.

Credential-free durability is enforced recursively before collaboration state,
events or management memory are serialized. Credential-shaped keys are
normalized across case, `_` and `-`; free text detects and redacts the matching
assignment forms plus Bearer/Basic authorization, GitHub tokens, `sk-` tokens,
credential-bearing URLs, PEM private keys, `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY`, and raw `AKIA`/`ASIA` access identifiers. Detection
rejects a durable payload; diagnostics apply the same vocabulary and a size
bound. A rejected value is not made acceptable by nesting or renaming it to a
case/separator variant.

Provider/Git operations are persisted before I/O:

```ts
interface OperationRecord {
  id: OperationId;
  kind: "repository.create" | "git.push" | "pull.create" |
    "pull.merge" | "pull.close" | "memory.commit";
  payloadHash: string;
  status: "prepared" | "observed" | "finalized" | "uncertain" | "failed";
  ownerExecutionId?: ExecutionId;
  ownershipEpoch?: number;
  expectedHead?: string;
  expectedBase?: string;
  remoteFact?: Record<string, unknown>;
}
```

Same id/same payload is replay-safe; same id/different payload is rejected. Completion creates one durable route-outbox row in the same short transaction. Outbox delivery is retryable and downstream activation deduplicates the route identity.

## Leader derivation

| Activation | Temporary leader |
| --- | --- |
| ordinary Agent directly selects a group by strong or autonomous configured route | source Agent |
| Main selects or directly activates a group | Main |
| project input targets a group | Main |
| group G routes to group H, whether fixed or Main-selected | Main |

`leaderAgentId` records the original role; `actingCoordinatorId` records temporary Main substitution after leader failure. `coordinatorEpoch` allows exactly one manager. A leader gets management capabilities only and never owns a delivery/final-integration execution or PR.

## State transitions

Group: `preparing -> coordinating -> running -> integrating -> completed`; `paused`, `blocked` and `cancelled` are explicit branches. Member task/execution and PR states remain separate. Opening a PR or native process exit cannot mark success; the required PR must be observed merged. A member result updates only the group. Final PR merge plus leader completion decision commits group completion and the unique route emission without a Main approval state.

Handoff requires confirmed stop, matching task current execution, matching ownership/coordinator epochs and an eligible successor. It increments the epoch and links two executions; if stop cannot be confirmed, no successor writer begins. Main failure freezes assignment, routing and merge while permitting read-only remote reconciliation.

Resume, completed-project continuation and intervention response are durable
before scheduling. If the current project-run promise is still settling, the
replacement dispatch is chained to that exact promise and is admitted only
after the old run leaves the active-run map. The duplicate-run fence therefore
cannot silently discard an acknowledged continuation.

## Permission and path contract

Each execution receives canonical `readRoot`, `writeRoots`, `executionWorktree`, `ownedMemoryPath` and service-Git capabilities. All tiers may read files under the real service-user directory subject to OS permissions. `workspace` writes only its worktree/owned memory; `compute` writes this project's execution worktrees; `yolo` uses the service user's OS reach and is explicitly not described as protecting the control plane. Realpath and nearest-existing-ancestor checks are preflight diagnostics only: non-yolo writes are enforced by a deny-by-default host sandbox or descriptor-relative broker that holds the authorized root, rejects symlink/mount escape and atomically replaces files so hard-link aliases cannot mutate an external inode. Raw Adapter write/shell surfaces are disabled or made read-only when they cannot express the same authority. Business cwd is always `git-worktrees/<executionId>`.

The shared Git directory is never an Agent write root. All branch, ref, index and
worktree administration goes through a trusted fixed-operation Git service that
validates project, execution, branch and ownership epoch. An unavailable or only
partially enforced Adapter/host combination fails closed for workspace/compute;
it does not fall back to a prompt restriction.

Business memory is `agent-memory/<agentId>/Memory.md` and travels in the task PR. Management memory is service-committed to a management branch and supplied as a provenance-labelled snapshot. A leader snapshot prioritizes the current coordinator, then includes at most 32 entries under a 16,000-character total/2,000-character per-entry bound. A delivery assignment receives only that Agent's own management entry, bounded to 4,000 characters. Every entry names its immutable `branch@commit:path`, and the prompt says it is read-only coordination context that must not be copied into the business repository. Git-off v1 projects keep the existing workspace/memory behavior.

For Git-on business invocations, the authoritative Inbox and its staged mirror
are server-owned runtime inputs outside the execution worktree. `.scienceevolve/` is
reserved and ignored from repository creation. A checkpoint rejects a tracked,
unignored, non-directory or symlinked reserved path. It builds the business
tree in a new service-private `GIT_INDEX_FILE`, explicitly excludes
`.scienceevolve`, verifies the frozen tree contains no reserved path, uses
`commit-tree` with all required parents, and advances the branch with CAS. It
clears only merge pseudorefs matching the committed merge and performs shared
index cleanup without a cancelled caller signal. A concurrent worker update to
the shared index cannot enter that service checkpoint.

This is a commit-tree integrity boundary, not whole-UID confinement. A
same-UID/yolo worker that directly invokes Git can create an unreachable object
in the shared object database; OpenFARS does not claim otherwise. The trusted
checkpoint never hashes the reserved Inbox and never references it from the
accepted commit.

The final-integration execution is owned by a delivery member, never the leader.
It owns the group-to-`main` PR whose head is the group branch. The group branch is
checked out only in that integration execution's retained worktree while it is
active; routine member-PR integration is performed by the trusted Git service
without a second checkout. If the final PR conflicts, a separate member-owned
repair execution/branch submits a PR back to the group branch before the final PR
is retried.

## Immutable artifact and display contract

A Git-on artifact publication is append-only. Its stable id is derived from the
owner execution, ownership epoch, merged PR, accepted base/head commit and
normalized path; publishing the same Agent/path from a later accepted commit
creates another record rather than retargeting the old record.

```ts
interface GitArtifactSource {
  executionId: ExecutionId;
  ownershipEpoch: number;
  commitSha: string;
  pullRequestId: PullRequestId;
  acceptedBase: string;
  worktreePath: string;
}

interface DisplayItem {
  agent: AgentId;
  path: string;
  title?: string;
  artifactId: string;
  commitSha: string;
}
```

An unbound `select_display` proposal is resolved exactly once, during action
acceptance, to an accepted merged publication. The persisted display always
contains both `artifactId` and `commitSha`, and the display UI forwards that
pair. A missing display selector, a mismatched or zero/multiple-match pair, a
changed PR head/base, a non-regular Git tree entry, or mutable-workspace
fallback fails closed. The general artifact-browsing API may use one selector
when it identifies exactly one accepted publication; that is not a persisted
display binding and cannot retarget a display. Legacy Git-on displays without
the immutable pair are untrusted until Main selects a current accepted
publication again. Git-off legacy workspace display behavior is unchanged.

## v1 migration and rollback-read policy

An object without `schemaVersion: 2` is read as v1 and normalized in memory to v2 with `collaborations: []` and Git disabled. Agent order, routes, decision plans, termination, canvas layout, permission and existing runtime behavior are preserved. It is written back only during an ordinary authorized save; there is no online Git migration and no migration button.

Readers tolerate absent new runtime fields. Writers emit v2 only after full validation. A server version that does not understand v2 must reject it with a schema-version diagnostic; it must not drop groups and execute members as outer Agents. Historical node/group runs keep their immutable workflow snapshot across later edits.

## Validation invariants

- Agent names and group ids are unique in the shared node namespace; `input` and `finish` are reserved.
- Main is never a group member. A non-Main Agent belongs to at most one group. A group has at least two known members.
- No route, input or termination target/source may name a member; all name outer nodes or `finish` where allowed.
- A collaboration cannot contain another collaboration and cannot run with Git disabled.
- Main dispatch candidates are outer nodes only.
- The affected group is uneditable from activation through final-PR terminal resolution.
- Normal-node `decisionBy`, finish and termination behavior is unchanged; group completion never calls `complete_project`.

## Candidate examples and executable check

- `examples/legacy-serial.json`: missing Git/v2 fields normalizes losslessly to Git-off serial behavior.
- `examples/git-agent-task.json`: one ordinary delivery execution and a real PR directly to `main`.
- `examples/collaboration-run.json`: group members exist only in the group, concurrent executions target the group branch, and a member-owned final PR targets `main`.

`node validate-contract-examples.mjs` parses and cross-links all three examples,
including distinct node/group identities, ordinary task records, every execution
and PR owner, and the fully serialized final-integration task/execution/PR. The
contract was frozen after the independent R0 re-audit accepted all 24
executable checks on 2026-09-22 UTC.
