import type {
  AgentEvent,
  CollaborationNode,
  FailureAttempt,
  GroupRun,
  MemberExecution,
  Project,
  PullRequestRecord,
  WorkTask
} from "../../../types";

export type CollaborationActivityKind =
  | "group"
  | "task"
  | "execution"
  | "commit"
  | "pull_request"
  | "merge"
  | "pause"
  | "stop"
  | "finish"
  | "failure";

export type CollaborationDisplayState =
  | "running"
  | "paused"
  | "stopping"
  | "stopped"
  | "superseded"
  | "failed"
  | "completed"
  | "waiting";

export interface CollaborationActivityItem {
  id: string;
  kind: CollaborationActivityKind;
  seq: number;
  occurredAt?: string;
  collaborationId?: string;
  groupRunId?: string;
  executionId?: string;
  taskId?: string;
  agentId?: string;
  title: string;
  description?: string;
  commitSha?: string;
  commitUrl?: string;
  pullRequestId?: string;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
  sourceBranch?: string;
  targetBranch?: string;
  state?: CollaborationDisplayState;
  technicalDetails?: Record<string, string | number | boolean | undefined>;
}

export interface FailureAttemptTimelineItem {
  id: string;
  attempt: FailureAttempt;
  ordinal: number;
  retry: boolean;
  scopeLabel: string;
  title: string;
  occurredAt: string;
}

export interface CollaborationMemberProgress {
  agentId: string;
  task?: WorkTask;
  execution?: MemberExecution;
  pullRequest?: PullRequestRecord;
  executionCount: number;
  label: string;
  durationLabel?: string;
  state: CollaborationDisplayState;
}

export interface CollaborationProgressView {
  group: CollaborationNode;
  groupRun?: GroupRun;
  phaseLabel: string;
  state: CollaborationDisplayState;
  completedMembers: number;
  totalMembers: number;
  members: CollaborationMemberProgress[];
}

const EXECUTION_STATUS_LABELS: Record<MemberExecution["status"], string> = {
  queued: "排队中",
  working: "执行中",
  waiting_authorization: "等待 GitHub 授权",
  waiting_review: "准备提交 PR",
  pr_open: "PR 已创建",
  resolving: "解决冲突中",
  merged: "已合入协作组",
  stop_requested: "等待停止",
  stopped: "已停止",
  superseded: "已重新分配",
  succeeded: "已完成",
  failed: "执行失败",
  cancelled: "已取消"
};

export const COLLABORATION_STATE_LABELS: Record<CollaborationDisplayState, string> = {
  running: "执行中",
  paused: "已暂停",
  stopping: "正在停止",
  stopped: "已停止",
  superseded: "已重新分配",
  failed: "执行失败",
  completed: "已完成",
  waiting: "等待执行"
};

const STOPPING_PROJECT_STATUSES = new Set(["interrupting", "pausing", "cancelling", "stopping"]);
const PAUSED_PROJECT_STATUSES = new Set(["interrupted", "paused"]);

const FAILURE_SCOPE_LABELS: Record<FailureAttempt["scope"], string> = {
  git: "Git",
  resident: "Resident",
  tool: "工具",
  control: "控制动作",
  usage: "用量持久化",
  scheduler: "调度恢复"
};

/** Preserve every immutable attempt while labeling retries per scope/operation. */
export function buildFailureAttemptTimeline(project: Project): FailureAttemptTimelineItem[] {
  const ordered = (project.failureAttempts ?? [])
    .map((attempt, index) => ({ attempt, index }))
    .sort((left, right) => {
      const time = Date.parse(left.attempt.finishedAt) - Date.parse(right.attempt.finishedAt);
      return Number.isFinite(time) && time !== 0 ? time : left.index - right.index;
    });
  const counts = new Map<string, number>();
  const failures = new Map<string, number>();
  return ordered.map(({ attempt }) => {
    const key = `${attempt.scope}\0${attempt.operation}`;
    const ordinal = (counts.get(key) ?? 0) + 1;
    const priorFailures = failures.get(key) ?? 0;
    counts.set(key, ordinal);
    if (attempt.status === "failed") failures.set(key, priorFailures + 1);
    const retry = ordinal > 1 || priorFailures > 0;
    const scopeLabel = FAILURE_SCOPE_LABELS[attempt.scope];
    return {
      id: `failure-attempt:${attempt.attemptId}`,
      attempt,
      ordinal,
      retry,
      scopeLabel,
      title: attempt.status === "succeeded"
        ? retry ? `${scopeLabel} 重试成功` : `${scopeLabel} 尝试成功`
        : retry ? `${scopeLabel} 重试失败` : `${scopeLabel} 尝试失败`,
      occurredAt: attempt.finishedAt
    };
  });
}

function authoritativeProjectStatus(project: Project): Project["status"] {
  return project.runtime?.status ?? project.status;
}

function activityMatchesExecution(project: Project, execution: MemberExecution): boolean {
  const runtime = project.runtime;
  if (!runtime || runtime.status !== "running") return false;
  if (runtime.leaseState !== "recovering" && runtime.executionId === execution.id && runtime.groupRunId === execution.groupRunId &&
    (runtime.ownershipEpoch === undefined || runtime.ownershipEpoch === execution.ownershipEpoch)) return true;
  return runtime.activities.some((activity) =>
    activity.leaseState !== "recovering" &&
    activity.executionId === execution.id &&
    activity.groupRunId === execution.groupRunId &&
    (activity.ownershipEpoch === undefined || activity.ownershipEpoch === execution.ownershipEpoch)
  );
}

function activityMatchesGroup(project: Project, groupRun: GroupRun): boolean {
  const runtime = project.runtime;
  if (!runtime || runtime.status !== "running") return false;
  if (runtime.leaseState !== "recovering" && runtime.groupRunId === groupRun.id) return true;
  return runtime.activities.some((activity) => activity.leaseState !== "recovering" && activity.groupRunId === groupRun.id);
}

export function collaborationExecutionState(
  project: Project,
  execution: MemberExecution,
  pullRequest?: PullRequestRecord
): CollaborationDisplayState {
  if (execution.status === "superseded") return "superseded";
  if (execution.status === "stopped" || execution.status === "cancelled") return "stopped";
  if (execution.status === "failed") return "failed";
  if (execution.status === "succeeded" || execution.status === "merged" || pullRequest?.status === "merged") {
    return "completed";
  }
  if (execution.status === "stop_requested") return "stopping";

  const projectStatus = authoritativeProjectStatus(project);
  if (STOPPING_PROJECT_STATUSES.has(projectStatus)) return "stopping";
  if (PAUSED_PROJECT_STATUSES.has(projectStatus)) return "paused";
  if (projectStatus === "cancelled" || projectStatus === "stopped") return "stopped";
  if (projectStatus === "failed") return "failed";
  return activityMatchesExecution(project, execution) ? "running" : "waiting";
}

function textData(event: AgentEvent, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = event.data?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function numberData(event: AgentEvent, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = event.data?.[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function short(value: string | undefined, length = 8): string | undefined {
  return value ? value.slice(0, length) : undefined;
}

function compact(value: string | undefined, maximum = 140): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  return Array.from(normalized).slice(0, maximum).join("");
}

function elapsedLabel(start: string | undefined, end: string | undefined): string | undefined {
  if (!start) return undefined;
  const startAt = Date.parse(start);
  const endAt = end ? Date.parse(end) : Date.now();
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt < startAt) return undefined;
  const seconds = Math.max(1, Math.round((endAt - startAt) / 1_000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours} 小时 ${remainingMinutes} 分钟` : `${hours} 小时`;
}

function eventType(event: AgentEvent): string {
  return event.type.toLowerCase().replaceAll("_", ".");
}

function sourceType(event: AgentEvent): string {
  return (textData(event, "sourceType") ?? eventType(event)).toLowerCase().replaceAll("_", ".");
}

function groupIdentity(
  project: Project,
  groupRunId: string | undefined
): { groupRun?: GroupRun; collaborationId?: string } {
  if (!groupRunId) return {};
  const groupRun = (project.groupRuns ?? []).find((entry) => entry.id === groupRunId);
  const nodeRun = (project.nodeRuns ?? []).find((entry) => entry.id === groupRun?.nodeRunId);
  return { groupRun, collaborationId: nodeRun?.node.nodeId };
}

function latestGroupIdentity(project: Project): {
  groupRun?: GroupRun;
  groupRunId?: string;
  collaborationId?: string;
} {
  const activeNodeRun = project.activeNodeRunId
    ? (project.nodeRuns ?? []).find((run) => run.id === project.activeNodeRunId)
    : undefined;
  const groupRun = activeNodeRun
    ? (project.groupRuns ?? []).find((run) => run.nodeRunId === activeNodeRun.id)
    : (project.groupRuns ?? []).at(-1);
  const identity = groupIdentity(project, groupRun?.id);
  return { ...identity, groupRunId: groupRun?.id };
}

function associatedFacts(project: Project, event: AgentEvent) {
  let pullRequest = (project.pullRequests ?? []).find((pull) =>
    pull.id === textData(event, "pullRequestId", "pull_request_id")
  );
  const providerNumber = numberData(event, "providerNumber", "pullRequestNumber", "number");
  if (!pullRequest && providerNumber !== undefined) {
    pullRequest = (project.pullRequests ?? []).find((pull) => pull.providerNumber === providerNumber);
  }
  const executionId = event.executionId
    ?? textData(event, "executionId", "execution_id", "ownerExecutionId")
    ?? pullRequest?.ownerExecutionId;
  const execution = (project.executions ?? []).find((entry) => entry.id === executionId);
  const taskId = event.taskId ?? textData(event, "taskId", "task_id") ?? execution?.taskId;
  const task = (project.tasks ?? []).find((entry) => entry.id === taskId);
  const groupRunId = event.groupRunId
    ?? textData(event, "groupRunId", "group_run_id")
    ?? execution?.groupRunId
    ?? task?.groupRunId;
  const { groupRun, collaborationId } = groupIdentity(project, groupRunId);
  const agentId = event.agentId?.trim()
    || event.agent?.trim()
    || textData(event, "agentId", "agent_id")
    || execution?.agentId
    || task?.assigneeAgentId;
  return {
    pullRequest,
    execution,
    executionId,
    task,
    taskId,
    groupRun,
    groupRunId,
    collaborationId,
    agentId
  };
}

function pullState(event: AgentEvent, pull: PullRequestRecord | undefined): string {
  const explicit = textData(event, "status", "pullRequestStatus", "state")?.toLowerCase();
  const source = sourceType(event);
  if (source.includes("merged") || explicit === "merged") return "merged";
  if (source.includes("closed") || explicit === "closed") return "closed";
  if (source.includes("conflict") || explicit === "conflicted") return "conflicted";
  if (source.includes("created") || source.includes("opened") || explicit === "open") return "open";
  return explicit ?? pull?.status ?? "observed";
}

function addActivity(
  activities: Map<string, CollaborationActivityItem>,
  activity: CollaborationActivityItem
): void {
  const current = activities.get(activity.id);
  if (!current || activity.seq >= current.seq) activities.set(activity.id, activity);
}

function addFallbackActivity(
  activities: Map<string, CollaborationActivityItem>,
  activity: CollaborationActivityItem
): void {
  if (!activities.has(activity.id)) activities.set(activity.id, activity);
}

/**
 * Project collaboration facts are authoritative. Timeline events add ordering
 * and intermediate milestones, while fact fallbacks keep older projects
 * readable even when their historical event payloads were sparse.
 */
export function buildCollaborationActivities(
  project: Project,
  events: readonly AgentEvent[] = []
): CollaborationActivityItem[] {
  const activities = new Map<string, CollaborationActivityItem>();
  const ordered = [...events].sort((left, right) => left.seq - right.seq);

  for (const event of ordered) {
    const type = eventType(event);
    const source = sourceType(event);
    const facts = associatedFacts(project, event);
    const common = {
      seq: event.seq,
      occurredAt: event.ts,
      collaborationId: facts.collaborationId,
      groupRunId: facts.groupRunId,
      executionId: facts.executionId,
      taskId: facts.taskId,
      agentId: facts.agentId
    };

    if (type === "failure.attempt.recorded" || source === "failure.attempt.recorded") {
      const status = textData(event, "status") === "succeeded" ? "succeeded" : "failed";
      const scope = textData(event, "scope") ?? "runtime";
      const operation = textData(event, "operation") ?? "operation";
      const attemptId = textData(event, "attemptId") ?? event.eventId ?? String(event.seq);
      addActivity(activities, {
        id: `failure-attempt:${attemptId}`,
        kind: status === "succeeded" ? "finish" : "failure",
        ...common,
        title: status === "succeeded"
          ? `${scope}/${operation} 重试成功`
          : `${scope}/${operation} 尝试失败`,
        description: compact(textData(event, "redactedMessage") ?? event.message),
        state: status === "succeeded" ? "completed" : "failed",
        technicalDetails: {
          attemptId,
          scope,
          operation,
          errorCode: textData(event, "errorCode"),
          retryable: event.data?.retryable === true
        }
      });
      continue;
    }

    if (type === "collaboration.group.started" || source === "group.activated") {
      addActivity(activities, {
        id: `group:${facts.groupRunId ?? event.seq}:started`,
        kind: "group",
        ...common,
        title: "协作组开始执行",
        description: facts.groupRun
          ? `${facts.groupRun.memberSnapshot.length} 名成员等待分工与并行执行`
          : undefined,
        state: undefined
      });
      continue;
    }
    if (source.startsWith("group.paused") || (
      type === "project.status" && /\bpaused\b/i.test(event.message)
    )) {
      const identity = facts.groupRunId ? facts : latestGroupIdentity(project);
      addActivity(activities, {
        id: `group:${identity.groupRunId ?? event.seq}:paused:${event.eventId ?? event.seq}`,
        kind: "pause",
        ...common,
        collaborationId: identity.collaborationId,
        groupRunId: identity.groupRunId,
        title: "协作组已暂停",
        description: compact(event.message),
        state: "paused"
      });
      continue;
    }
    if (source === "group.cancellation.requested") {
      addActivity(activities, {
        id: `group:${facts.groupRunId ?? event.seq}:stopping:${event.eventId ?? event.seq}`,
        kind: "stop",
        ...common,
        title: "协作组正在停止",
        description: compact(event.message),
        state: "stopping"
      });
      continue;
    }
    if (source === "group.cancelled") {
      addActivity(activities, {
        id: `group:${facts.groupRunId ?? event.seq}:stopped:${event.eventId ?? event.seq}`,
        kind: "stop",
        ...common,
        title: "协作组已停止",
        description: compact(event.message),
        state: "stopped"
      });
      continue;
    }
    if (type === "collaboration.group.completed" || source === "group.completed") {
      addActivity(activities, {
        id: `group:${facts.groupRunId ?? event.seq}:completed`,
        kind: "finish",
        ...common,
        title: "协作组执行完成",
        description: compact(facts.groupRun?.output ?? event.message),
        state: "completed"
      });
      continue;
    }
    if (type === "collaboration.group.failed" || source.includes("group.failed")) {
      addActivity(activities, {
        id: `group:${facts.groupRunId ?? event.seq}:failed`,
        kind: "failure",
        ...common,
        title: "协作组执行失败",
        description: compact(facts.groupRun?.failureReason ?? event.message),
        state: "failed"
      });
      continue;
    }
    if (type === "collaboration.task.assigned" || source.includes("group.task.assigned")) {
      const assignedTaskIds = event.data?.taskIds;
      const taskIds = Array.isArray(assignedTaskIds)
        ? assignedTaskIds.filter((value): value is string => typeof value === "string")
        : [];
      if (!facts.task && taskIds.length) {
        for (const taskId of taskIds) {
          const task = (project.tasks ?? []).find((entry) => entry.id === taskId);
          if (!task) continue;
          const taskGroup = groupIdentity(project, task.groupRunId);
          addActivity(activities, {
            id: `task:${task.id}:assigned`,
            kind: "task",
            ...common,
            collaborationId: taskGroup.collaborationId,
            groupRunId: task.groupRunId,
            taskId: task.id,
            agentId: task.assigneeAgentId,
            title: task.assigneeAgentId ? `任务已分配给 ${task.assigneeAgentId}` : "协作任务已分配",
            description: compact(task.assignment),
            state: "waiting"
          });
        }
        continue;
      }
      addActivity(activities, {
        id: `task:${facts.taskId ?? event.seq}:assigned`,
        kind: "task",
        ...common,
        title: facts.agentId ? `任务已分配给 ${facts.agentId}` : "协作任务已分配",
        description: compact(facts.task?.assignment ?? textData(event, "assignment", "message")),
        state: "waiting"
      });
      continue;
    }
    if (type === "collaboration.execution.started" || source === "node.execution.started" || source === "execution.started") {
      addActivity(activities, {
        id: `execution:${facts.executionId ?? event.seq}:started`,
        kind: "execution",
        ...common,
        title: `${facts.agentId ?? "Agent"} 开始执行`,
        description: compact(facts.task?.assignment),
        state: undefined
      });
      continue;
    }
    if (type === "collaboration.execution.completed" || source === "execution.succeeded") {
      addActivity(activities, {
        id: `execution:${facts.executionId ?? event.seq}:completed`,
        kind: "execution",
        ...common,
        title: facts.execution?.purpose === "final-integration"
          ? `${facts.agentId ?? "Agent"} 完成最终集成`
          : `${facts.agentId ?? "Agent"} 完成成员任务`,
        description: compact(facts.execution?.output),
        state: "completed"
      });
      continue;
    }
    if (source === "group.final.integration.started" || source === "group.final_integration.started") {
      addActivity(activities, {
        id: `execution:${facts.executionId ?? facts.groupRunId ?? event.seq}:final-integration`,
        kind: "execution",
        ...common,
        title: `${facts.agentId ?? "Agent"} 开始最终集成`,
        description: "汇总成员交付并准备合入 main",
        state: undefined
      });
      continue;
    }
    const executionTransition = textData(event, "to", "status")?.toLowerCase();
    if (source === "execution.stop_requested" || executionTransition === "stop_requested") {
      addActivity(activities, {
        id: `execution:${facts.executionId ?? event.seq}:stopping:${event.eventId ?? event.seq}`,
        kind: "stop",
        ...common,
        title: `${facts.agentId ?? "Agent"} 正在停止执行`,
        description: compact(event.message),
        state: "stopping"
      });
      continue;
    }
    if (source === "execution.stop_confirmed" || executionTransition === "stopped") {
      addActivity(activities, {
        id: `execution:${facts.executionId ?? event.seq}:stopped:${event.eventId ?? event.seq}`,
        kind: "stop",
        ...common,
        title: `${facts.agentId ?? "Agent"} 已停止执行`,
        description: compact(event.message),
        state: "stopped"
      });
      continue;
    }
    if (executionTransition === "superseded") {
      addActivity(activities, {
        id: `execution:${facts.executionId ?? event.seq}:superseded:${event.eventId ?? event.seq}`,
        kind: "stop",
        ...common,
        title: `${facts.agentId ?? "Agent"} 的执行已重新分配`,
        description: compact(event.message),
        state: "superseded"
      });
      continue;
    }
    if (type === "collaboration.execution.failed" || source.includes("execution.failed")) {
      addActivity(activities, {
        id: `execution:${facts.executionId ?? event.seq}:failed`,
        kind: "failure",
        ...common,
        title: `${facts.agentId ?? "Agent"} 执行失败`,
        description: compact(facts.execution?.failureReason ?? event.message),
        state: "failed"
      });
      continue;
    }

    const commitSha = textData(event, "commitSha", "commit", "headSha");
    if (commitSha && (
      type === "artifact.published"
      || type.includes("checkpoint")
      || source.includes("checkpoint")
      || source.includes("commit")
    )) {
      const repositoryUrl = project.git?.repository?.htmlUrl?.replace(/\/+$/, "");
      addActivity(activities, {
        id: `commit:${commitSha}`,
        kind: "commit",
        ...common,
        title: `${facts.agentId ?? "Agent"} 提交 commit ${short(commitSha)}`,
        description: compact(facts.task?.assignment ?? textData(event, "title", "reason")),
        commitSha,
        commitUrl: repositoryUrl ? `${repositoryUrl}/commit/${commitSha}` : undefined,
        state: "completed",
        technicalDetails: { sourceType: source, eventId: event.eventId }
      });
      continue;
    }

    if (type.startsWith("pull.request.") || source.startsWith("pull.request.") || source.startsWith("pull_request.")) {
      const pull = facts.pullRequest;
      const status = pullState(event, pull);
      const number = pull?.providerNumber ?? numberData(event, "providerNumber", "pullRequestNumber");
      const pullId = pull?.id ?? textData(event, "pullRequestId") ?? `event-${event.seq}`;
      const merged = status === "merged";
      const failed = status === "conflicted";
      const stopped = status === "closed";
      const finalIntegration = facts.execution?.purpose === "final-integration" || pull?.base === "main";
      addActivity(activities, {
        id: `pr:${pullId}:${status}`,
        kind: merged ? "merge" : failed ? "failure" : stopped ? "stop" : "pull_request",
        ...common,
        pullRequestId: pull?.id,
        pullRequestNumber: number,
        pullRequestUrl: pull?.htmlUrl,
        sourceBranch: pull?.head ?? textData(event, "head"),
        targetBranch: pull?.base ?? textData(event, "base"),
        commitSha: merged ? pull?.mergeCommitSha : pull?.headSha,
        title: merged
          ? finalIntegration
            ? `PR #${number ?? "?"} 已合入 main`
            : `PR #${number ?? "?"} 已合入协作组分支`
          : failed
            ? `PR #${number ?? "?"} 合并受阻`
            : stopped
              ? `PR #${number ?? "?"} 已关闭`
              : `${facts.agentId ?? "Agent"} 提交 PR #${number ?? "?"}`,
        description: pull ? `${pull.head} → ${pull.base}` : undefined,
        state: merged ? "completed" : failed ? "failed" : stopped ? "stopped" : "completed",
        technicalDetails: { sourceType: source, pullRequestId: pull?.id }
      });
    }
  }

  // Authoritative fallbacks for old projects whose event payloads did not
  // retain Agent or PR associations.
  for (const groupRun of project.groupRuns ?? []) {
    const { collaborationId } = groupIdentity(project, groupRun.id);
    addFallbackActivity(activities, {
      id: `group:${groupRun.id}:started`,
      kind: "group",
      seq: Number.MAX_SAFE_INTEGER - 10_000,
      occurredAt: groupRun.startedAt,
      collaborationId,
      groupRunId: groupRun.id,
      title: "协作组开始执行",
      description: `${groupRun.memberSnapshot.length} 名成员参与本次协作`,
      state: undefined
    });
    if (["completed", "failed", "cancelled"].includes(groupRun.status)) {
      const failed = groupRun.status === "failed";
      const stopped = groupRun.status === "cancelled";
      addFallbackActivity(activities, {
        id: `group:${groupRun.id}:${failed ? "failed" : stopped ? "stopped" : "completed"}`,
        kind: failed ? "failure" : stopped ? "stop" : "finish",
        seq: Number.MAX_SAFE_INTEGER - 9_000,
        occurredAt: groupRun.completedAt ?? groupRun.updatedAt,
        collaborationId,
        groupRunId: groupRun.id,
        title: failed ? "协作组执行失败" : stopped ? "协作组已停止" : "协作组执行完成",
        description: compact(groupRun.failureReason ?? groupRun.output),
        state: failed ? "failed" : stopped ? "stopped" : "completed"
      });
    }
  }

  for (const task of project.tasks ?? []) {
    if (!task.groupRunId || !task.assigneeAgentId) continue;
    const { collaborationId } = groupIdentity(project, task.groupRunId);
    addFallbackActivity(activities, {
      id: `task:${task.id}:assigned`,
      kind: "task",
      seq: Number.MAX_SAFE_INTEGER - 8_000 + task.queueOrdinal,
      occurredAt: task.createdAt,
      collaborationId,
      groupRunId: task.groupRunId,
      taskId: task.id,
      agentId: task.assigneeAgentId,
      title: `任务已分配给 ${task.assigneeAgentId}`,
      description: compact(task.assignment),
      state: task.status === "failed" ? "failed" : task.status === "succeeded" ? "completed" : "waiting"
    });
  }

  for (const execution of project.executions ?? []) {
    if (!execution.groupRunId) continue;
    const { collaborationId } = groupIdentity(project, execution.groupRunId);
    if (execution.startedAt) {
      addFallbackActivity(activities, {
        id: `execution:${execution.id}:started`,
        kind: "execution",
        seq: Number.MAX_SAFE_INTEGER - 7_000,
        occurredAt: execution.startedAt,
        collaborationId,
        groupRunId: execution.groupRunId,
        executionId: execution.id,
        taskId: execution.taskId,
        agentId: execution.agentId,
        title: `${execution.agentId} 开始${execution.purpose === "final-integration" ? "最终集成" : "执行成员任务"}`,
        state: undefined
      });
    }
    if (["succeeded", "failed", "cancelled", "merged"].includes(execution.status)) {
      const failed = execution.status === "failed";
      addFallbackActivity(activities, {
        id: `execution:${execution.id}:${failed ? "failed" : "completed"}`,
        kind: failed ? "failure" : "execution",
        seq: Number.MAX_SAFE_INTEGER - 6_000,
        occurredAt: execution.completedAt ?? execution.updatedAt,
        collaborationId,
        groupRunId: execution.groupRunId,
        executionId: execution.id,
        taskId: execution.taskId,
        agentId: execution.agentId,
        title: failed
          ? `${execution.agentId} 执行失败`
          : execution.purpose === "final-integration"
            ? `${execution.agentId} 完成最终集成`
            : `${execution.agentId} 完成成员任务`,
        description: compact(execution.failureReason ?? execution.output),
        state: failed ? "failed" : "completed"
      });
    }
  }

  for (const pull of project.pullRequests ?? []) {
    const execution = (project.executions ?? []).find((entry) => entry.id === pull.ownerExecutionId);
    if (!execution?.groupRunId) continue;
    const { collaborationId } = groupIdentity(project, execution.groupRunId);
    const merged = pull.status === "merged";
    const failed = pull.status === "conflicted";
    const stopped = pull.status === "closed";
    addFallbackActivity(activities, {
      id: `pr:${pull.id}:${pull.status}`,
      kind: merged ? "merge" : failed ? "failure" : stopped ? "stop" : "pull_request",
      seq: Number.MAX_SAFE_INTEGER - 5_000 + pull.providerNumber,
      occurredAt: pull.observedAt,
      collaborationId,
      groupRunId: execution.groupRunId,
      executionId: execution.id,
      taskId: execution.taskId,
      agentId: execution.agentId,
      pullRequestId: pull.id,
      pullRequestNumber: pull.providerNumber,
      pullRequestUrl: pull.htmlUrl,
      sourceBranch: pull.head,
      targetBranch: pull.base,
      commitSha: merged ? pull.mergeCommitSha : pull.headSha,
      title: merged
        ? execution.purpose === "final-integration" || pull.base === "main"
          ? `PR #${pull.providerNumber} 已合入 main`
          : `PR #${pull.providerNumber} 已合入协作组分支`
        : failed
          ? `PR #${pull.providerNumber} 合并受阻`
          : stopped
            ? `PR #${pull.providerNumber} 已关闭`
            : `${execution.agentId} 提交 PR #${pull.providerNumber}`,
      description: `${pull.head} → ${pull.base}`,
      state: merged ? "completed" : failed ? "failed" : stopped ? "stopped" : "completed"
    });
  }

  // Keep the current authoritative projection separate from immutable event
  // milestones. It may disappear after resume; historical pause/stop events
  // above remain untouched and retain their original sequence and timestamp.
  for (const group of project.orchestration.collaborations ?? []) {
    const progress = collaborationProgress(project, group);
    if (!progress.groupRun || !["paused", "stopping"].includes(progress.state)) continue;
    addFallbackActivity(activities, {
      id: `group:${progress.groupRun.id}:projection:${progress.state}`,
      kind: progress.state === "paused" ? "pause" : "stop",
      seq: Number.MAX_SAFE_INTEGER - 1_000,
      occurredAt: project.updatedAt,
      collaborationId: group.id,
      groupRunId: progress.groupRun.id,
      title: progress.state === "paused" ? "协作组当前已暂停" : "协作组当前正在停止",
      description: progress.phaseLabel,
      state: progress.state,
      technicalDetails: {
        currentProjection: true,
        stateRevision: project.runtime?.stateRevision
      }
    });
  }

  return [...activities.values()].sort((left, right) => {
    const leftTime = left.occurredAt ? Date.parse(left.occurredAt) : Number.NaN;
    const rightTime = right.occurredAt ? Date.parse(right.occurredAt) : Number.NaN;
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
      return leftTime - rightTime;
    }
    return left.seq - right.seq;
  });
}

function latestMemberExecution(
  project: Project,
  executions: readonly MemberExecution[],
  tasks: readonly WorkTask[],
  agentId: string
): MemberExecution | undefined {
  const memberExecutions = executions.filter((entry) => entry.agentId === agentId);
  const activeExecutionIds = new Set([
    project.runtime?.executionId,
    ...(project.runtime?.activities ?? []).map((activity) => activity.executionId)
  ].filter((id): id is string => Boolean(id)));
  const currentExecutionIds = new Set(tasks
    .filter((task) => task.assigneeAgentId === agentId && task.currentExecutionId)
    .map((task) => task.currentExecutionId!));
  return memberExecutions.find((execution) => activeExecutionIds.has(execution.id))
    ?? memberExecutions.find((execution) => currentExecutionIds.has(execution.id))
    ?? [...memberExecutions].sort((left, right) =>
      left.ownershipEpoch - right.ownershipEpoch ||
      (left.updatedAt ?? left.startedAt ?? left.queuedAt ?? "")
        .localeCompare(right.updatedAt ?? right.startedAt ?? right.queuedAt ?? "")
    ).at(-1);
}

function groupDisplayState(
  project: Project,
  groupRun: GroupRun | undefined,
  members: readonly CollaborationMemberProgress[]
): CollaborationDisplayState {
  if (!groupRun) return "waiting";
  if (groupRun.status === "completed") return "completed";
  if (groupRun.status === "failed") return "failed";
  if (groupRun.status === "cancelled") return "stopped";

  const projectStatus = authoritativeProjectStatus(project);
  if (STOPPING_PROJECT_STATUSES.has(projectStatus) || members.some((member) => member.state === "stopping")) {
    return "stopping";
  }
  if (PAUSED_PROJECT_STATUSES.has(projectStatus) || groupRun.status === "paused" || groupRun.status === "blocked") {
    return "paused";
  }
  if (projectStatus === "cancelled" || projectStatus === "stopped") return "stopped";
  if (projectStatus === "failed") return "failed";
  if (activityMatchesGroup(project, groupRun) || members.some((member) => member.state === "running")) {
    return "running";
  }
  if (members.length > 0 && members.every((member) => member.state === "superseded")) {
    return "superseded";
  }
  return "waiting";
}

export function collaborationProgress(
  project: Project,
  group: CollaborationNode
): CollaborationProgressView {
  const nodeRuns = (project.nodeRuns ?? [])
    .filter((run) => run.node.kind === "collaboration" && run.node.nodeId === group.id);
  const nodeRunIds = new Set(nodeRuns.map((run) => run.id));
  const groupRuns = (project.groupRuns ?? []).filter((run) => nodeRunIds.has(run.nodeRunId));
  const activeNodeRun = nodeRuns.find((run) => run.id === project.activeNodeRunId);
  const groupRun = groupRuns.find((run) => run.id === project.runtime?.groupRunId)
    ?? groupRuns.find((run) => run.nodeRunId === activeNodeRun?.id)
    ?? groupRuns.at(-1);
  const executions = (project.executions ?? []).filter((execution) => execution.groupRunId === groupRun?.id);
  const tasks = (project.tasks ?? []).filter((task) => task.groupRunId === groupRun?.id);
  const pulls = project.pullRequests ?? [];
  const members = group.memberAgentIds.map((agentId): CollaborationMemberProgress => {
    const memberExecutions = executions.filter((entry) => entry.agentId === agentId);
    const execution = latestMemberExecution(project, executions, tasks, agentId);
    const task = tasks.find((entry) => entry.id === execution?.taskId)
      ?? tasks.filter((entry) => entry.assigneeAgentId === agentId).at(-1);
    const pullRequest = pulls.find((entry) => entry.id === execution?.pullRequestId)
      ?? pulls.filter((entry) => entry.ownerExecutionId === execution?.id).at(-1);
    const state = execution
      ? collaborationExecutionState(project, execution, pullRequest)
      : task?.status === "failed"
        ? "failed"
        : task?.status === "cancelled"
          ? "stopped"
          : "waiting";
    const terminal = ["completed", "failed", "stopped", "superseded"].includes(state);
    return {
      agentId,
      task,
      execution,
      pullRequest,
      executionCount: memberExecutions.length,
      label: state === "waiting"
        ? execution ? EXECUTION_STATUS_LABELS[execution.status] : task ? "等待执行" : "等待分工"
        : COLLABORATION_STATE_LABELS[state],
      ...(execution ? { durationLabel: elapsedLabel(
        execution.startedAt ?? execution.queuedAt,
        terminal ? execution.completedAt ?? execution.updatedAt : undefined
      ) } : {}),
      state
    };
  });
  const completedMembers = members.filter((member) => member.state === "completed").length;
  const state = groupDisplayState(project, groupRun, members);
  const phaseLabel = !groupRun
    ? "等待协作组启动"
    : state === "completed"
      ? "协作组已完成"
      : state === "failed"
        ? "协作组执行异常"
        : state === "paused"
          ? "协作组已暂停"
          : state === "stopping"
            ? "协作组正在停止"
            : state === "stopped"
              ? "协作组已停止"
              : state === "superseded"
                ? "协作执行已重新分配"
                : state === "running"
                  ? groupRun.status === "integrating"
                    ? "最终集成中"
                    : `${group.memberAgentIds.length} 个成员协作执行中`
                  : groupRun.status === "integrating"
                    ? "等待最终集成活动"
                    : executions.length
                      ? "等待下一项协作活动"
                      : "等待分配成员任务";
  return {
    group,
    groupRun,
    phaseLabel,
    state,
    completedMembers,
    totalMembers: group.memberAgentIds.length,
    members
  };
}
