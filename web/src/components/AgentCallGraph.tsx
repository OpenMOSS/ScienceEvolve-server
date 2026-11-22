import { memo, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { formatClock, SYSTEM_CONTROLLER_AGENT } from "../lib";
import type { AgentEvent, AgentName, HarnessCatalogEntry, Project } from "../types";
import { WorkflowCanvasRuntime } from "./workflow-canvas/WorkflowCanvasRuntime";
import { Button } from "./Common";
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

export const AgentCallGraph = memo(function AgentCallGraph({
  project,
  events,
  harnesses,
  runtime,
  hasOlder = false,
  historyLoading = false,
  historyError = "",
  onLoadOlder
}: {
  project: Project;
  events: AgentEvent[];
  harnesses?: ReadonlyArray<Pick<HarnessCatalogEntry, "id" | "label">>;
  runtime?: WorkflowRuntimeState;
  hasOlder?: boolean;
  historyLoading?: boolean;
  historyError?: string;
  onLoadOlder?: () => Promise<void>;
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
      <div className="agent-call-graph-scroll">
        <div className="agent-call-runtime-map" data-runtime-ledger="true">
          <WorkflowCanvasRuntime project={project} events={events} harnesses={harnesses} runtime={runtime} />
        </div>

        <h2 className="agent-call-ledger-title">调用记录</h2>
        <div className="agent-call-page-row">
          <span>{calls.length ? `${pageStart + 1}–${pageStart + visibleCalls.length} / ${calls.length}` : "尚无调用"}{hasOlder && calls.length > 0 && "（已加载）"}</span>
          <div>
            {hasOlder && <Button type="button" variant="ghost" data-size="small" disabled={historyLoading} onClick={() => { void onLoadOlder?.(); }}>
              {historyLoading ? "正在加载…" : "加载更早调用"}
            </Button>}
            <button type="button" data-component="icon-button" data-variant="ghost" data-size="normal" title="查看上一组调用"
              aria-label="查看上一组调用" disabled={page === 0} onClick={() => goToPage(page - 1)}><ChevronLeft size={15} data-slot="icon-svg" aria-hidden="true" /></button>
            <small>{page + 1} / {latestPage + 1}</small>
            <button type="button" data-component="icon-button" data-variant="ghost" data-size="normal" title="查看下一组调用"
              aria-label="查看下一组调用" disabled={page === latestPage} onClick={() => goToPage(page + 1)}><ChevronRight size={15} data-slot="icon-svg" aria-hidden="true" /></button>
          </div>
        </div>
        {historyError && <p role="alert">{historyError}</p>}

        {visibleCalls.length > 0 && (
          <div className="agent-call-sequence" aria-label="调用记录">
            {visibleCalls.map((call, index) => {
              const number = pageStart + index + 1;
              const current = isAgentInvocationActive(call, project, calls);
              return (
                <div className={current ? "current" : ""} key={call.id}>
                  <span className="agent-call-sequence-number">{number}</span>
                  <strong className="agent-call-sequence-name">{agentLabel(call.role)}</strong>
                  {current && <i>运行中</i>}
                  <time dateTime={call.ts} title={call.invocationId}>{formatClock(call.ts)}</time>
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

      </div>
    </aside>
  );
});
