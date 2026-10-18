import type { AgentEvent, Project } from "../../../types";
import {
  buildCollaborationActivities,
  type CollaborationDisplayState
} from "./collaboration-activity";
import type { WorkflowRuntimeState } from "./workflow-runtime";

export interface ExecutionPreviewStep {
  id: string;
  kind: "input" | "agent" | "route" | "user" | "finish" | "group" | "task" | "commit" | "pull_request" | "merge";
  seq: number;
  ts?: string;
  agent?: string;
  source?: string;
  target?: string;
  invocationId?: string;
  state?: CollaborationDisplayState | "interrupted";
  heading?: string;
  text?: string;
  rationale?: string;
  output?: string;
  artifacts?: Array<{ path: string; title: string }>;
  url?: string;
  commitSha?: string;
  pullRequestNumber?: number;
}

function activityStepKind(
  kind: import("./collaboration-activity").CollaborationActivityKind
): ExecutionPreviewStep["kind"] {
  switch (kind) {
    case "execution":
    case "failure":
    case "pause":
    case "stop":
      return "group";
    default:
      return kind;
  }
}

function value(event: AgentEvent, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const text = event.data?.[key];
    if (typeof text === "string" && text) return text;
  }
  return undefined;
}

/** Preserve original wording. Preview is bounded; it never generates a summary. */
export function previewText(text: string): string {
  return Array.from(text).slice(0, 1_000).join("");
}

export function buildExecutionPreview(
  project: Project,
  events: readonly AgentEvent[],
  runtime: WorkflowRuntimeState
): ExecutionPreviewStep[] {
  const steps: ExecutionPreviewStep[] = [{
    id: "input", kind: "input", seq: -1, ts: project.createdAt,
    text: project.requirement, target: project.orchestration.input.target
  }];
  const calls = new Map<string, ExecutionPreviewStep>();
  const latestByAgent = new Map<string, ExecutionPreviewStep>();
  const routes = new Map<string, ExecutionPreviewStep>();
  const seen = new Set<number>();
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  for (const event of ordered) {
    if (seen.has(event.seq)) continue;
    seen.add(event.seq);
    const type = event.type.toLowerCase().replaceAll("_", ".");
    const invocationId = value(event, "invocationId");
    const agent = event.agent;
    const call = invocationId ? calls.get(invocationId) : agent ? latestByAgent.get(agent) : undefined;
    if (["agent.started", "agent.run.started", "invocation.started"].includes(type) && agent) {
      const id = invocationId ?? `event-${event.seq}`;
      if (calls.has(id)) continue;
      const step: ExecutionPreviewStep = {
        id: `call-${id}`, kind: "agent", seq: event.seq, ts: event.ts,
        agent, invocationId, state: "running", source: value(event, "sourceAgent"), artifacts: []
      };
      calls.set(id, step);
      latestByAgent.set(agent, step);
      steps.push(step);
      continue;
    }
    if (type === "handoff.saved") {
      const output = value(event, "excerpt");
      if (call) call.output = output;
      else if (agent) {
        // Older logs can retain a handoff even when its start is missing.
        const id = invocationId ?? `event-${event.seq}`;
        const step: ExecutionPreviewStep = {
          id: `call-${id}`, kind: "agent", seq: event.seq, ts: event.ts,
          agent, invocationId, state: "waiting", output, artifacts: []
        };
        calls.set(id, step);
        latestByAgent.set(agent, step);
        steps.push(step);
      }
      continue;
    }
    if (call && ["agent.completed", "agent.run.completed", "invocation.completed", "agent.finished"].includes(type)) {
      call.state = "completed";
    } else if (call && ["agent.failed", "agent.run.failed", "invocation.failed"].includes(type)) {
      call.state = "failed";
    } else if (call && ["agent.interrupted", "agent.run.interrupted"].includes(type)) {
      call.state = "interrupted";
    }
    if (type === "artifact.published" && call) {
      const artifact = event.data?.artifact as Record<string, unknown> | undefined;
      if (artifact && typeof artifact.path === "string") {
        call.artifacts?.push({ path: artifact.path, title: typeof artifact.title === "string" ? artifact.title : artifact.path });
      }
    }
    if (type === "main.assignment.committed" || type === "route.queued") {
      const target = value(event, "nextAgent", "target") ?? (type === "route.queued" ? agent : undefined);
      const source = type === "main.assignment.committed" ? agent ?? "main" : value(event, "sourceAgent");
      if (!target) continue;
      const sourceId = type === "main.assignment.committed" ? invocationId : value(event, "sourceInvocationId");
      const key = `${sourceId ?? event.seq}:${source}:${target}`;
      const previous = routes.get(key);
      if (previous) continue;
      const step: ExecutionPreviewStep = {
        id: `route-${event.seq}`, kind: "route", seq: event.seq, ts: event.ts,
        source, target, text: value(event, "message", "decisionPlan"), rationale: value(event, "rationale")
      };
      routes.set(key, step);
      steps.push(step);
    }
    if (type === "user.input.queued") {
      const input = project.userInputs?.find((item) => item.id === value(event, "inputId"));
      steps.push({ id: `user-${event.seq}`, kind: "user", seq: event.seq, ts: event.ts,
        text: input?.message ?? value(event, "preview"), target: "main" });
    }
    if (type === "user.input.delivered") {
      steps.push({ id: `delivery-${event.seq}`, kind: "route", seq: event.seq, ts: event.ts,
        source: "user", target: agent ?? "main", text: "用户补充需求已传入本次调用。" });
    }
    if (type === "user.intervention.requested") {
      steps.push({ id: `request-${event.seq}`, kind: "user", seq: event.seq, ts: event.ts,
        source: agent, target: "user", text: value(event, "request", "message"), rationale: value(event, "rationale") });
    }
    if (type === "user.intervention.answered" || type === "user.intervention.responded") {
      const intervention = project.userIntervention;
      steps.push({ id: `answer-${event.seq}`, kind: "user", seq: event.seq, ts: event.ts,
        target: "main", text: value(event, "response") ?? (intervention?.id === value(event, "requestId") ? intervention?.response : undefined) ?? "用户已回复，流程继续。" });
    }
    if (type === "project.completed") {
      steps.push({ id: `finish-${event.seq}`, kind: "finish", seq: event.seq, ts: event.ts, text: "本次研究流程已完成。" });
    }
  }
  for (const step of calls.values()) {
    if (!step.output && project.latestHandoff && step.invocationId === project.latestHandoff.invocationId) {
      step.output = project.latestHandoff.excerpt;
    }
    if (step.state !== "running") continue;
    const projectStatus = project.runtime?.status ?? project.status;
    if (["pausing", "interrupting", "cancelling", "stopping"].includes(projectStatus)) step.state = "stopping";
    else if (["paused", "interrupted"].includes(projectStatus)) step.state = "paused";
    else if (["cancelled", "stopped"].includes(projectStatus)) step.state = "stopped";
    else if (projectStatus === "failed") step.state = "failed";
    else if (runtime.currentInvocationId !== step.invocationId || runtime.currentNodeId !== step.agent) step.state = "waiting";
  }
  const existing = new Set(steps.map((step) => step.id));
  for (const activity of buildCollaborationActivities(project, events)) {
    const kind = activityStepKind(activity.kind);
    if (kind === "finish" && activity.groupRunId) {
      // Group completion is a collaboration milestone, not project finish.
      const id = `collaboration-${activity.id}`;
      if (existing.has(id)) continue;
      existing.add(id);
      steps.push({
        id,
        kind: "group",
        seq: activity.seq,
        ts: activity.occurredAt,
        agent: activity.agentId,
        state: activity.state,
        heading: activity.title,
        text: activity.description,
        source: activity.collaborationId,
        target: activity.targetBranch
      });
      continue;
    }
    const id = `collaboration-${activity.id}`;
    if (existing.has(id)) continue;
    existing.add(id);
    steps.push({
      id,
      kind,
      seq: activity.seq,
      ts: activity.occurredAt,
      agent: activity.agentId,
      state: activity.state,
      heading: activity.title,
      text: activity.description,
      source: activity.sourceBranch ?? activity.collaborationId,
      target: activity.targetBranch,
      url: activity.pullRequestUrl ?? activity.commitUrl,
      commitSha: activity.commitSha,
      pullRequestNumber: activity.pullRequestNumber
    });
  }
  return steps.sort((left, right) => {
    if (left.kind === "input") return -1;
    if (right.kind === "input") return 1;
    const leftTime = left.ts ? Date.parse(left.ts) : Number.NaN;
    const rightTime = right.ts ? Date.parse(right.ts) : Number.NaN;
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
      return leftTime - rightTime;
    }
    return left.seq - right.seq;
  });
}
