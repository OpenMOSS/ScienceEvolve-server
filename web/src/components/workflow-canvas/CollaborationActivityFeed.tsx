import { Check, CircleDot, CircleStop, GitCommitHorizontal, GitMerge, GitPullRequest, ListChecks, Pause, Play, TriangleAlert } from "lucide-react";
import { useMemo } from "react";
import type { AgentEvent, Project } from "../../types";
import {
  buildCollaborationActivities,
  buildFailureAttemptTimeline,
  type CollaborationActivityItem
} from "./core/collaboration-activity";

const ICONS: Record<CollaborationActivityItem["kind"], typeof CircleDot> = {
  group: Play,
  task: ListChecks,
  execution: CircleDot,
  commit: GitCommitHorizontal,
  pull_request: GitPullRequest,
  merge: GitMerge,
  pause: Pause,
  stop: CircleStop,
  finish: Check,
  failure: TriangleAlert
};

function readableTime(value: string | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

export function CollaborationActivityFeed({
  project,
  events = [],
  collaborationId,
  groupRunId,
  limit = 8,
  emptyText = "等待协作组产生执行动作。"
}: {
  project: Project;
  events?: readonly AgentEvent[];
  collaborationId?: string;
  groupRunId?: string;
  limit?: number;
  emptyText?: string;
}) {
  const activities = useMemo(() => buildCollaborationActivities(project, events)
    .filter((activity) => (
      groupRunId ? activity.groupRunId === groupRunId
        : collaborationId ? activity.collaborationId === collaborationId
          : true
    ))
    .slice(-limit)
    .reverse(), [collaborationId, events, groupRunId, limit, project]);

  if (!activities.length) return <p className="collaboration-activity-empty">{emptyText}</p>;
  return <ol className="collaboration-activity-feed" aria-label="协作组最近动作">
    {activities.map((activity) => {
      const Icon = ICONS[activity.kind];
      const link = activity.pullRequestUrl ?? activity.commitUrl;
      return <li className={`activity-${activity.kind} activity-${activity.state ?? "waiting"}`} key={activity.id}>
        <span className="collaboration-activity-icon"><Icon size={13} /></span>
        <span className="collaboration-activity-copy">
          <strong>{link ? <a href={link} target="_blank" rel="noreferrer">{activity.title}</a> : activity.title}</strong>
          {activity.description && <small title={activity.description}>{activity.description}</small>}
          <em>{activity.agentId ? `${activity.agentId} · ` : ""}{readableTime(activity.occurredAt)}</em>
        </span>
      </li>;
    })}
  </ol>;
}

export function FailureAttemptHistory({
  project,
  limit = 20
}: {
  project: Project;
  limit?: number;
}) {
  const completeTimeline = useMemo(
    () => buildFailureAttemptTimeline(project),
    [project]
  );
  if (!completeTimeline.length) return null;
  const timeline = completeTimeline.slice(-limit);
  const latestByOperation = new Map<string, (typeof completeTimeline)[number]>();
  for (const item of completeTimeline) {
    latestByOperation.set(`${item.attempt.scope}\0${item.attempt.operation}`, item);
  }
  const unresolved = project.failureSummary?.unresolvedFailures ??
    [...latestByOperation.values()].filter((item) => item.attempt.status === "failed").length;

  return <section className="failure-attempt-history" aria-label="失败与重试历史">
    <header>
      <div>
        <h3>失败与重试历史</h3>
        <small>每次尝试均为不可覆盖的耐久记录</small>
      </div>
      <strong data-state={unresolved > 0 ? "failed" : "healthy"}>
        {unresolved > 0 ? `${unresolved} 项待恢复` : "当前已恢复"}
      </strong>
    </header>
    {completeTimeline.length > timeline.length && <p>
      显示最近 {timeline.length} / {completeTimeline.length} 次尝试
    </p>}
    <ol>
      {timeline.map((item) => {
        const failed = item.attempt.status === "failed";
        const Icon = failed ? TriangleAlert : Check;
        return <li
          key={item.id}
          data-status={item.attempt.status}
          data-retry={item.retry ? "true" : "false"}
        >
          <span className="failure-attempt-icon"><Icon size={13} /></span>
          <div className="failure-attempt-copy">
            <div>
              <strong>{item.title}</strong>
              <em>第 {item.ordinal} 次尝试</em>
            </div>
            <code>{item.attempt.scope} / {item.attempt.operation}</code>
            <p>{item.attempt.redactedMessage}</p>
            <small>
              <time dateTime={item.occurredAt}>{readableTime(item.occurredAt)}</time>
              {item.attempt.agentId ? ` · ${item.attempt.agentId}` : ""}
              {failed ? ` · ${item.attempt.retryable ? "可重试" : "不可重试"}` : ""}
            </small>
            <details>
              <summary>诊断详情</summary>
              <dl>
                <div><dt>Attempt</dt><dd>{item.attempt.attemptId}</dd></div>
                <div><dt>Error code</dt><dd>{item.attempt.errorCode ?? "—"}</dd></div>
                <div><dt>Cause</dt><dd>{item.attempt.causeClass}</dd></div>
                {item.attempt.invocationId && <div><dt>Invocation</dt><dd>{item.attempt.invocationId}</dd></div>}
                {item.attempt.ownershipEpoch !== undefined && <div><dt>Epoch</dt><dd>{item.attempt.ownershipEpoch}</dd></div>}
              </dl>
            </details>
          </div>
        </li>;
      })}
    </ol>
  </section>;
}
