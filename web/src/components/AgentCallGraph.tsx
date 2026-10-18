import { memo, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, GitBranch } from "lucide-react";
import { agentTemplateFor, formatClock, SYSTEM_CONTROLLER_AGENT } from "../lib";
import type { AgentEvent, AgentName, HarnessCatalogEntry, Project } from "../types";
import { WorkflowCanvasRuntime } from "./workflow-canvas/WorkflowCanvasRuntime";
import type { WorkflowRuntimeState } from "./workflow-canvas/core/workflow-runtime";

import { buildAgentInvocations, isAgentInvocationActive } from "../agent-invocations";
export { buildAgentInvocations } from "../agent-invocations";

const CALLS_PER_PAGE = 10;

interface UserInterventionStep {
  seq: number;
  requestId: string;
  ts: string;
  respondedSeq?: number;
  respondedAt?: string;
}

interface ProactiveUserInputStep {
  seq: number;
  inputId: string;
  ts: string;
  targetMainInvocation?: number;
  preview?: string;
  deliveredSeq?: number;
  deliveredAt?: string;
  deliveredInvocationId?: string;
}

function normalizedType(event: AgentEvent): string {
  return event.type.toLowerCase().replaceAll("_", ".");
}

function eventDataString(event: AgentEvent, key: string): string {
  const value = event.data?.[key];
  return typeof value === "string" ? value : "";
}

function eventDataNumber(event: AgentEvent, key: string): number | undefined {
  const value = event.data?.[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(1, Math.floor(value));
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return Math.max(1, Number.parseInt(value, 10));
  }
  return undefined;
}

function eventDataStrings(event: AgentEvent, key: string): string[] {
  const value = event.data?.[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function buildUserInterventions(events: AgentEvent[]): UserInterventionStep[] {
  const interventions: UserInterventionStep[] = [];
  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    const type = normalizedType(event);
    if (type === "user.intervention.requested") {
      const requestId = eventDataString(event, "requestId") || `intervention-${event.seq}`;
      if (!interventions.some((item) => item.requestId === requestId)) {
        interventions.push({ seq: event.seq, requestId, ts: event.ts });
      }
      continue;
    }
    if (type !== "user.intervention.answered" && type !== "user.intervention.responded") continue;
    const requestId = eventDataString(event, "requestId");
    let matchingIndex = -1;
    for (let index = interventions.length - 1; index >= 0; index -= 1) {
      const intervention = interventions[index]!;
      if (intervention.respondedSeq !== undefined) continue;
      if (!requestId || intervention.requestId === requestId) {
        matchingIndex = index;
        break;
      }
    }
    if (matchingIndex >= 0) {
      interventions[matchingIndex] = {
        ...interventions[matchingIndex],
        respondedSeq: event.seq,
        respondedAt: event.ts
      };
    }
  }
  return interventions;
}

export function buildProactiveUserInputs(events: AgentEvent[]): ProactiveUserInputStep[] {
  const inputs: ProactiveUserInputStep[] = [];
  const byId = new Map<string, number>();
  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    const type = normalizedType(event);
    if (type === "user.input.queued") {
      const inputId = eventDataString(event, "inputId") || `input-${event.seq}`;
      if (byId.has(inputId)) continue;
      byId.set(inputId, inputs.length);
      inputs.push({
        seq: event.seq,
        inputId,
        ts: event.ts,
        targetMainInvocation: eventDataNumber(event, "targetMainInvocation"),
        preview: eventDataString(event, "preview") || undefined
      });
      continue;
    }
    if (type !== "user.input.delivered") continue;
    const deliveredInvocationId = eventDataString(event, "invocationId");
    for (const inputId of eventDataStrings(event, "inputIds")) {
      const inputIndex = byId.get(inputId);
      if (inputIndex === undefined) continue;
      inputs[inputIndex] = {
        ...inputs[inputIndex],
        deliveredSeq: event.seq,
        deliveredAt: event.ts,
        deliveredInvocationId: deliveredInvocationId || undefined
      };
    }
  }
  return inputs;
}

function agentLabel(agent: AgentName): string {
  return agent === SYSTEM_CONTROLLER_AGENT ? "Main Agent" : `${agent} Agent`;
}

function interventionStatus(step: UserInterventionStep): string {
  return step.respondedSeq === undefined ? "等待回复" : "已回复";
}

/**
 * The panel keeps the invocation ledger, but its upper visualization is now
 * the shared read-only runtime canvas. The former fixed 420px SVG topology is
 * intentionally not rendered here.
 */
export const AgentCallGraph = memo(function AgentCallGraph({
  project,
  events,
  harnesses,
  runtime
}: {
  project: Project;
  events: AgentEvent[];
  harnesses?: ReadonlyArray<Pick<HarnessCatalogEntry, "id" | "label">>;
  runtime?: WorkflowRuntimeState;
}) {
  const calls = useMemo(() => buildAgentInvocations(events, project), [events, project.executions, project.scopedExecutions]);
  const interventions = useMemo(() => buildUserInterventions(events), [events]);
  const proactiveInputs = useMemo(() => buildProactiveUserInputs(events), [events]);
  const latestPage = Math.max(0, Math.ceil(calls.length / CALLS_PER_PAGE) - 1);
  const [requestedPage, setRequestedPage] = useState<number | null>(null);
  const page = Math.min(requestedPage ?? latestPage, latestPage);
  const pageStart = page * CALLS_PER_PAGE;
  const visibleCalls = calls.slice(pageStart, pageStart + CALLS_PER_PAGE);

  const goToPage = (nextPage: number) => {
    const bounded = Math.max(0, Math.min(latestPage, nextPage));
    setRequestedPage(bounded === latestPage ? null : bounded);
  };

  return (
    <aside className="workspace-panel agent-call-graph-panel" role="region" aria-label="Agent 调用轨迹图">
      <div className="agent-call-graph-head">
        <div>
          <span className="agent-call-graph-icon"><GitBranch size={17} /></span>
          <div>
            <span>INVOCATION MAP</span>
            <h2>Agent 调用轨迹</h2>
          </div>
        </div>
        <span className="agent-call-svg-badge">WORKFLOW · LIVE</span>
      </div>

      <div className="agent-call-graph-scroll">
        <div className="agent-call-summary">
          <span><strong>{calls.length}</strong><small>总调用</small></span>
          <span><strong>{new Set(calls.map((call) => call.role)).size}</strong><small>已参与 Agent</small></span>
          <span><strong>{calls.length ? `#${calls.length}` : "—"}</strong><small>最新步骤</small></span>
        </div>

        <div className="agent-call-runtime-map" data-runtime-ledger="true">
          <WorkflowCanvasRuntime project={project} events={events} harnesses={harnesses} runtime={runtime} />
        </div>

        <div className="agent-call-page-row">
          <span>{calls.length ? `${pageStart + 1}–${pageStart + visibleCalls.length} / ${calls.length}` : "尚无调用"}</span>
          <div>
            <button type="button" aria-label="查看上一组调用" disabled={page === 0} onClick={() => goToPage(page - 1)}><ChevronLeft size={15} /></button>
            <small>{page + 1} / {latestPage + 1}</small>
            <button type="button" aria-label="查看下一组调用" disabled={page === latestPage} onClick={() => goToPage(page + 1)}><ChevronRight size={15} /></button>
          </div>
        </div>

        {visibleCalls.length > 0 && (
          <div className="agent-call-sequence" aria-label="调用记录">
            {visibleCalls.map((call, index) => {
              const number = pageStart + index + 1;
              const current = isAgentInvocationActive(call, project, calls);
              const group = project.scopedGroupRuns?.find(group => group.id === call.groupRunId);
              const purpose = call.kind === "management" ? "Leader 协调" : call.kind === "integration" ? "最终集成" : "组内任务";
              return (
                <div className={current ? "current" : ""} key={call.id}>
                  <span className="agent-call-sequence-number">{number}</span>
                  <span className="agent-call-sequence-copy">
                    <strong>{agentLabel(call.role)}</strong>
                    <span>模板：{agentTemplateFor(project.orchestration, call.role)}</span>
                    {call.groupRunId && <span>协作组：{group?.groupId ?? call.groupRunId} · {purpose}</span>}
                    <small title={call.invocationId}>
                      {call.cycle ? `Cycle ${call.cycle} · ` : ""}{formatClock(call.ts)} · {call.invocationId.slice(0, 12)}…
                    </small>
                  </span>
                  {current && <i>运行中</i>}
                </div>
              );
            })}
          </div>
        )}

        {(interventions.length > 0 || proactiveInputs.length > 0) && (
          <section className="agent-call-event-ledger" aria-label="用户介入与主动需求">
            <strong>用户介入与主动需求</strong>
            {interventions.map((intervention, index) => (
              <div key={intervention.requestId} className="agent-call-event-row">
                <span>U{index + 1}</span><span>用户介入 · {interventionStatus(intervention)}</span><small>{formatClock(intervention.ts)}</small>
              </div>
            ))}
            {proactiveInputs.map((input, index) => (
              <div key={input.inputId} className="agent-call-event-row">
                <span>R{index + 1}</span><span>{input.preview || "用户主动需求"} · {input.deliveredInvocationId ? "已进入流程" : "等待投递"}</span><small>{formatClock(input.ts)}</small>
              </div>
            ))}
          </section>
        )}

        <p className="agent-call-graph-note">
          编号按逻辑调用顺序生成，失败重试和中断恢复合并为同一次调用；用户介入与主动需求不占用 Agent 调用编号。
          上方 Workflow 画布只读展示当前项目配置拓扑及真实状态，路径顺序和调用次数以本记录为准。
        </p>
      </div>
    </aside>
  );
});
