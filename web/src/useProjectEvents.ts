import { useCallback, useEffect, useRef, useState } from "react";
import {
  eventStreamUrl,
  getProjectEventBootstrap,
  getProjectEventHistory
} from "./api";
import {
  mergeEvents,
  normalizeEvent,
  normalizeInvocationPerformance,
  normalizeProjectRuntimeProjection
} from "./lib";
import type {
  AgentEvent,
  ConnectionState,
  LiveAssistantStream,
  ProjectLiveSnapshot
} from "./types";

const INITIAL_EVENT_LIMIT = 1_000;
const HISTORY_PAGE_LIMIT = 1_000;
const LIVE_BATCH_MS = 120;

const NAMED_EVENTS = [
  "trace",
  "project_status_changed",
  "agent_run_started",
  "agent_trace",
  "agent_tool_call",
  "artifact_written",
  "agent_run_finished",
  "main_decision",
  "iteration_started",
  "error",
  "project.state",
  "agent.execution.started",
  "agent.execution.ended",
  "agent.started",
  "agent.run.started",
  "agent.trace",
  "agent.completed",
  "agent.failed",
  "agent.interrupted",
  "invocation.started",
  "invocation.completed",
  "invocation.failed",
  "invocation.performance",
  "agent.run.completed",
  "agent.run.failed",
  "agent.run.interrupted",
  "project.completed",
  "failure.attempt.recorded",
  "usage.persistence.failed",
  "workflow.reconfigured",
  "control.action.committed",
  "display.selected",
  "project.progress.updated",
  "handoff.saved",
  "session.resume_failed",
  "session.resume.failed",
  "session.replaced",
  "artifact.created",
  "artifact.published",
  "retry.scheduled",
  "project.accepted",
  "project.created",
  "project.status",
  "project.cancellation.settled",
  "workspace.checkpoint.saved",
  "agent.queued",
  "route.queued",
  "main.assignment.queued",
  "main.assignment.committed",
  "route.traversed",
  "session.started",
  "control.channel.unavailable",
  "artifact.written",
  "iteration.started",
  "user.intervention.requested",
  "user.intervention.answered",
  "user.intervention.responded",
  "user.input.queued",
  "user.input.delivered",
  "user.input.interrupt.requested",
  "user.input.interrupt.completed",
  "agent.interrupting",
  "workflow.node.started",
  "workflow.adjustment.submitted",
  "workflow.adjustment.transitioned",
  "workflow.node.updated",
  "workflow.node.completed",
  "workflow.node.failed",
  "collaboration.group.started",
  "collaboration.group.updated",
  "collaboration.group.completed",
  "collaboration.group.failed",
  "collaboration.task.created",
  "collaboration.task.assigned",
  "collaboration.task.updated",
  "collaboration.execution.queued",
  "collaboration.execution.started",
  "collaboration.execution.updated",
  "collaboration.execution.completed",
  "collaboration.execution.failed",
  "collaboration.route.emitted",
  "collaboration.main.frozen",
  "collaboration.main.recovered",
  "pull.request.observed",
  "pull.request.updated",
  "git.initialization.updated"
];

function isAgentTimelineEvent(event: AgentEvent): boolean {
  const type = event.type.toLowerCase().replaceAll("_", ".");
  return (
    type.startsWith("workflow.node.") ||
    type.startsWith("collaboration.group.") ||
    type.startsWith("collaboration.task.") ||
    type.startsWith("collaboration.execution.") ||
    type.startsWith("collaboration.route.") ||
    type.startsWith("collaboration.main.") ||
    type.startsWith("pull.request.") ||
    type.startsWith("git.initialization.") ||
    type === "agent.execution.started" ||
    type === "agent.execution.ended" ||
    type === "agent.started" ||
    type === "agent.run.started" ||
    type === "agent.completed" ||
    type === "agent.run.completed" ||
    type === "agent.failed" ||
    type === "agent.run.failed" ||
    type === "agent.interrupted" ||
    type === "agent.run.interrupted" ||
    type === "invocation.started" ||
    type === "invocation.completed" ||
    type === "invocation.failed" ||
    type === "invocation.performance" ||
    type === "session.started" ||
    type === "session.resume.failed" ||
    type === "session.replaced" ||
    type === "control.channel.unavailable" ||
    type === "project.completed" ||
    type === "handoff.saved" ||
    type === "artifact.published" ||
    type === "retry.scheduled" ||
    type === "user.intervention.requested" ||
    type === "user.intervention.answered" ||
    type === "user.intervention.responded" ||
    type === "user.input.queued" ||
    type === "user.input.delivered" ||
    type === "user.input.interrupt.requested" ||
    type === "user.input.interrupt.completed" ||
    type === "agent.interrupting" ||
    type === "agent.queued" ||
    type === "route.queued" ||
    type === "main.assignment.queued" ||
    type === "route.traversed" ||
    type === "main.assignment.committed"
  );
}

/** Collapse retry/reconnect copies of one Main business arrangement. */
function collapseBusinessAssignments(events: AgentEvent[]): AgentEvent[] {
  const ordered = [...events].sort((left, right) => left.seq - right.seq);
  const byKey = new Map<string, AgentEvent>();
  for (const event of ordered) {
    const type = event.type;
    if (type !== "main.assignment.queued" && type !== "main.assignment.committed") {
      byKey.set(`event:${event.seq}`, event);
      continue;
    }
    const key = String(
      event.data?.sourceInvocationId ??
      event.data?.sourceAgent ??
      event.data?.invocationId ??
      event.seq
    );
    const current = byKey.get(`assignment:${key}`);
    // A committed action is the user-facing record; a queued record remains
    // only while Main is genuinely waiting to make its choice.
    if (!current || (type === "main.assignment.committed" && current.type !== type)) {
      byKey.set(`assignment:${key}`, event);
    }
  }
  return [...byKey.values()].sort((left, right) => left.seq - right.seq);
}

export function useProjectEvents(
  projectId: string | undefined,
  enabled = true
): {
  events: AgentEvent[];
  timelineEvents: AgentEvent[];
  totalEvents: number;
  connection: ConnectionState;
  hasOlder: boolean;
  historyLoading: boolean;
  historyError: string;
  live: ProjectLiveSnapshot;
  loadOlder: () => Promise<void>;
  reset: () => void;
} {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [timelineEvents, setTimelineEvents] = useState<AgentEvent[]>([]);
  const [totalEvents, setTotalEvents] = useState(0);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [hasOlder, setHasOlder] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [live, setLive] = useState<ProjectLiveSnapshot>({
    projectId: projectId ?? "",
    streams: [],
    events: []
  });
  const [generation, setGeneration] = useState(0);
  const latestSeq = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout>>();
  const activeProjectId = useRef(projectId);

  useEffect(() => {
    activeProjectId.current = projectId;
    if (!projectId || !enabled) {
      setConnection("offline");
      return;
    }

    latestSeq.current = 0;
    setEvents([]);
    setTimelineEvents([]);
    setTotalEvents(0);
    setHasOlder(false);
    setHistoryLoading(false);
    setHistoryError("");
    setLive({ projectId, streams: [], events: [] });

    let source: EventSource | undefined;
    let disposed = false;
    let retryCount = 0;
    let bootstrapLastSeq = 0;
    let bootstrapTotalEvents = 0;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    const countedLiveSeqs = new Set<number>();
    const countedLiveEventIds = new Set<string>();
    const bootstrapEventIds = new Set<string>();
    const pendingEvents = new Map<number, AgentEvent>();

    const flush = () => {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = undefined;
      if (disposed || pendingEvents.size === 0) return;
      const batch = [...pendingEvents.values()].sort((left, right) => left.seq - right.seq);
      pendingEvents.clear();
      setEvents((current) => mergeEvents(current, batch));
      const timelineBatch = batch.filter(isAgentTimelineEvent);
      if (timelineBatch.length) {
        setTimelineEvents((current) => collapseBusinessAssignments(mergeEvents(current, timelineBatch)));
      }
      setTotalEvents(bootstrapTotalEvents + countedLiveSeqs.size);
    };

    const receive = (raw: string) => {
      try {
        const parsed = JSON.parse(raw) as unknown;
        const list = Array.isArray(parsed) ? parsed : [parsed];
        const normalized = list
          .map(normalizeEvent)
          .filter((event): event is AgentEvent => Boolean(event));
        if (!normalized.length) return;
        for (const event of normalized) {
          pendingEvents.set(event.seq, event);
          if (
            event.seq > bootstrapLastSeq &&
            !countedLiveSeqs.has(event.seq) &&
            (!event.eventId || (
              !bootstrapEventIds.has(event.eventId) &&
              !countedLiveEventIds.has(event.eventId)
            ))
          ) {
            countedLiveSeqs.add(event.seq);
            if (event.eventId) countedLiveEventIds.add(event.eventId);
          }
          latestSeq.current = Math.max(latestSeq.current, event.seq);
        }
        if (!flushTimer) flushTimer = setTimeout(flush, LIVE_BATCH_MS);
      } catch {
        // Keep the stream alive when a malformed diagnostic event is received.
      }
    };

    const receiveLive = (raw: string) => {
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const rawStreams = Array.isArray(parsed.streams) ? parsed.streams : [];
        const streams = rawStreams.flatMap((value): LiveAssistantStream[] => {
          if (!value || typeof value !== "object" || Array.isArray(value)) return [];
          const item = value as Record<string, unknown>;
          if (
            typeof item.projectId !== "string" ||
            typeof item.invocationId !== "string" ||
            typeof item.agent !== "string" ||
            typeof item.harnessId !== "string" ||
            typeof item.itemId !== "string" ||
            typeof item.content !== "string" ||
            typeof item.updatedAt !== "string" ||
            !Number.isSafeInteger(item.attempt) ||
            (item.phase !== "streaming" && item.phase !== "complete" && item.phase !== "incomplete") ||
            (item.role !== "active" && item.role !== "process" && item.role !== "final")
          ) return [];
          return [{
            ...(item as unknown as LiveAssistantStream),
            ...(item.truncated === true ? { truncated: true } : {})
          }];
        });
        const performance = normalizeInvocationPerformance(parsed.performance);
        const runtime = normalizeProjectRuntimeProjection(parsed.runtime);
        const events = Array.isArray(parsed.events)
          ? parsed.events.flatMap((value): AgentEvent[] => {
              const event = normalizeEvent(value);
              return event ? [event] : [];
            })
          : [];
        setLive((current) => {
          const snapshotProjectId = typeof parsed.projectId === "string" ? parsed.projectId : projectId;
          const sameProject = current.projectId === snapshotProjectId;
          // Text/tool updates often carry an unchanged runtime and measurement.
          // Preserve their references so a token cannot invalidate the workflow
          // projection or trigger a full-project refresh by itself.
          const stableRuntime = sameProject && runtime && current.runtime &&
            JSON.stringify(current.runtime) === JSON.stringify(runtime) ? current.runtime : runtime;
          const stablePerformance = sameProject && performance && current.performance &&
            JSON.stringify(current.performance) === JSON.stringify(performance) ? current.performance : performance;
          return {
            projectId: snapshotProjectId,
            streams,
            events,
            ...(stablePerformance ? { performance: stablePerformance } : {}),
            ...(stableRuntime ? { runtime: stableRuntime } : {})
          };
        });
      } catch {
        // A malformed ephemeral snapshot must not disturb durable history.
      }
    };

    const connect = () => {
      if (disposed) return;
      setConnection(retryCount ? "reconnecting" : "connecting");
      source = new EventSource(eventStreamUrl(projectId, latestSeq.current));

      const onEvent = (event: MessageEvent<string>) => receive(event.data);
      source.onmessage = onEvent;
      for (const type of NAMED_EVENTS) {
        source.addEventListener(type, onEvent as EventListener);
      }
      source.addEventListener("live.snapshot", ((event: MessageEvent<string>) => {
        receiveLive(event.data);
      }) as EventListener);

      source.onopen = () => {
        retryCount = 0;
        setConnection("live");
      };
      source.onerror = () => {
        source?.close();
        flush();
        if (disposed) return;
        retryCount += 1;
        setConnection("reconnecting");
        const delay = Math.min(1000 * 2 ** Math.min(retryCount, 4), 15000);
        retryTimer.current = setTimeout(connect, delay);
      };
    };

    void getProjectEventBootstrap(projectId, INITIAL_EVENT_LIMIT)
      .then((bootstrap) => {
        if (disposed) return;
        for (const event of [...bootstrap.events, ...bootstrap.timelineEvents]) {
          if (event.eventId) bootstrapEventIds.add(event.eventId);
        }
        const recentTimeline = bootstrap.events.filter(isAgentTimelineEvent);
        setEvents(bootstrap.events);
        setTimelineEvents(
          collapseBusinessAssignments(mergeEvents(bootstrap.timelineEvents, recentTimeline))
        );
        bootstrapLastSeq = bootstrap.lastSeq;
        bootstrapTotalEvents = bootstrap.totalEvents;
        latestSeq.current = bootstrap.lastSeq;
        setTotalEvents(bootstrap.totalEvents);
        setHasOlder(bootstrap.events.length < bootstrap.totalEvents);
      })
      .catch(() => {
        // The live stream remains authoritative when the initial snapshot is
        // temporarily unavailable.
      })
      .finally(() => {
        if (!disposed) connect();
      });

    return () => {
      disposed = true;
      source?.close();
      if (flushTimer) clearTimeout(flushTimer);
      if (retryTimer.current) clearTimeout(retryTimer.current);
    };
  }, [enabled, generation, projectId]);

  const loadOlder = useCallback(async () => {
    const requestedProjectId = projectId;
    const before = events[0]?.seq;
    if (
      !requestedProjectId ||
      !enabled ||
      !hasOlder ||
      historyLoading ||
      before === undefined
    ) {
      return;
    }
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const page = await getProjectEventHistory(
        requestedProjectId,
        before,
        HISTORY_PAGE_LIMIT
      );
      if (activeProjectId.current !== requestedProjectId) return;
      setEvents((current) => mergeEvents(current, page.events));
      setHasOlder(page.hasMore);
    } catch (reason) {
      if (activeProjectId.current !== requestedProjectId) return;
      setHistoryError(
        reason instanceof Error ? reason.message : "更早轨迹加载失败"
      );
    } finally {
      if (activeProjectId.current === requestedProjectId) {
        setHistoryLoading(false);
      }
    }
  }, [enabled, events, hasOlder, historyLoading, projectId]);

  const reset = () => {
    latestSeq.current = 0;
    setEvents([]);
    setTimelineEvents([]);
    setTotalEvents(0);
    setLive({ projectId: projectId ?? "", streams: [], events: [] });
    setGeneration((value) => value + 1);
  };

  return {
    events,
    timelineEvents,
    totalEvents,
    connection,
    hasOlder,
    historyLoading,
    historyError,
    live,
    loadOlder,
    reset
  };
}
