import { currentScopedGroupRun, scopedGroupDisplayState, scopedNodeDisplayState, scopedRosterMembers } from "../scoped-runtime";
import { applyLiveRuntimeSnapshot, mergeProjectSnapshot } from "../project-runtime";
import { createProjectRefreshScheduler } from "../project-refresh";
import { acceptedGitHandoff, projectResultSelection } from "../project-results";
import { resolvePerformanceMetrics, useProjectPerformance } from "../project-performance";
import { projectLifecycleState, runtimeDisplayState } from "../../../server/src/internal/shared/project-runtime-status.js";
import {
  type FormEvent,
  type KeyboardEvent,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import ReactMarkdown from "react-markdown";
import { ProjectExplainerReplyStatus, ProjectExplainerTrace } from "../components/ProjectExplainerTrace";
import { foldExplainerMessages, isExplainerConversationMessage, mergeExplainerMessages } from "../components/project-explainer-events";
import { agentPermissionLabel } from "../../../server/src/internal/shared/agent-permission-metadata.js";
import rehypeKatex from "rehype-katex";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Bot,
  BrainCircuit,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleStop,
  Clipboard,
  Clock3,
  CloudOff,
  Code2,
  Coins,
  Cpu,
  Download,
  Eye,
  FileCode2,
  FileText,
  Filter,
  Folder,
  FolderOpen,
  Gauge,
  GitBranch,
  Globe2,
  LoaderCircle,
  Inbox,
  Layers3,
  ListChecks,
  Menu,
  MessageSquareText,
  Pause,
  Play,
  Plus,
  Radio,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  ShieldCheck,
  TerminalSquare,
  X
} from "lucide-react";
import {
  addProjectUserInput,
  cancelProjectExplainer,
  createUserSkill,
  getArtifact,
  getDisplayedFile,
  getArtifactDirectory,
  getArtifactDownloadUrl,
  getArtifactViewUrl,
  getArtifactPage,
  getArtifactSummary,
  getCatalog,
  getProject,
  getProjectExplainerConfig,
  getProjectExplainerHistory,
  getQueue,
  projectAction,
  refreshGatewayModels,
  resetProjectExplainer,
  respondToUserIntervention,
  streamProjectExplainerQuestion,
  updateProjectExplainerConfig,
  updateProjectAgentConfigs,
  updateProjectCollaborationGroup,
  type CollaborationGroupUpdate
} from "../api";
import {
  AgentBadge,
  AgentIcon,
  Brand,
  Button,
  EmptyState,
  ErrorPanel,
  OverallProgressBar,
  PageLoader,
  StatusBadge
} from "../components/Common";
import { AgentCallGraph } from "../components/AgentCallGraph";
import { WorkflowAdjustmentEditor } from "../components/WorkflowAdjustmentEditor";
import { AgentToolRecommendation } from "../components/AgentToolRecommendation";
import { ExperimentMcpControl } from "../components/ExperimentMcpControl";
import { ExplainerRecommendationSettings, RecommendationProvider } from "../components/RecommendationContext";
import { CollaborationDissolutionPlanner } from "../components/workflow-canvas/CollaborationDissolutionPlanner";
import { collaborationProgress } from "../components/workflow-canvas/core/collaboration-activity";
import {
  buildGuidedDissolutionPlan,
  canRestoreCollaborationSnapshot,
  dissolutionPlanError
} from "../components/workflow-canvas/core/collaboration-dissolution";
import { buildWorkflowRuntimeState, runtimeNodeLabel, type WorkflowRuntimeState } from "../components/workflow-canvas/core/workflow-runtime";
import {
  lockedCollaborationIds,
  workflowOuterNodes
} from "../components/workflow-canvas/core/workflow-nodes";
import { CreateSkillDialog } from "../components/CreateSkillDialog";
import { McpServerControl } from "../components/McpServerControl";
import {
  agentMeta,
  agentTemplateFor,
  agentSkillMode,
  catalogDefaultHarnessId,
  DEFAULT_MODELS,
  formatClock,
  formatRelativeTime,
  formatTokenCount,
  agentMcpServerKey,
  gatewayCombinationTestState,
  gatewayHarnessTestState,
  gatewayModelTestOptions,
  harnessOptionsForPurpose,
  harnessSupportsPurpose,
  humanFileSize,
  isAgentTemplate,
  isLarkSkill,
  normalizeInvocationPerformance,
  protocolLabel,
  projectWaitingLabel,
  SYSTEM_CONTROLLER_AGENT
} from "../lib";
import type {
  AgentConfig,
  AgentEvent,
  AgentMcpServer,
  AgentName,
  CollaborationDissolutionPlan,
  Artifact,
  ArtifactCatalogPage,
  ArtifactCatalogSummary,
  ArtifactContent,
  ArtifactDirectoryEntry,
  ArtifactDirectoryPage,
  DisplayItem,
  ConnectionState,
  Project,
  ProjectExplainerEvent,
  ProjectExplainerRuntimeConfig,
  ProjectExplainerConfigInput,
  AgentHarness,
  GatewayRecord,
  HarnessCatalogEntry,
  Catalog,
  QueueSnapshot,
  SkillDefinition,
  DisplaySelection,
  FixedMcpDefinition,
  HandoffRecord,
  LiveAssistantStream,
  InvocationPerformance,
  PerformanceAggregate,
  ScopedExecution
} from "../types";
import { useProjectEvents } from "../useProjectEvents";

type CollaborationGroupUpdateIntent =
  | Omit<Extract<CollaborationGroupUpdate, { action: "rename" }>, "requestId">
  | Omit<Extract<CollaborationGroupUpdate, { action: "dissolve" }>, "requestId">;

type CenterTab = "trace" | "artifacts" | "results";
const TRACE_DISPLAY_LIMITS = [100, 500, 1_000, 2_000, 5_000] as const;
type TraceDisplayLimit = (typeof TRACE_DISPLAY_LIMITS)[number];
const DEFAULT_TRACE_DISPLAY_LIMIT: TraceDisplayLimit = 1_000;
const ARTIFACT_PAGE_SIZE = 100;
const ARTIFACT_DIRECTORY_PAGE_SIZE = 50;

export function isProjectSnapshotRefreshEvent(event: Pick<AgentEvent, "type">): boolean {
  const type = event.type.toLowerCase().replaceAll("_", ".");
  return (
    type.startsWith("workflow.node.") ||
    type.startsWith("collaboration.") ||
    type.startsWith("pull.request.") ||
    type.startsWith("git.initialization.") ||
    type === "invocation.performance" ||
    [
      "state",
      "status",
      "queued",
      "started",
      "completed",
      "finished",
      "failed",
      "review",
      "intervention",
      "input",
      "progress",
      "config",
      "accepted",
      "error"
    ].some((token) => type.includes(token))
  );
}

function artifactKey(artifact: Artifact): string {
  return JSON.stringify([
    artifact.workspaceId ?? null,
    artifact.id ?? null,
    artifact.commitSha ?? null,
    artifact.agent ?? "system",
    artifact.origin ?? "workspace",
    artifact.path
  ]);
}

function artifactDirectoryEntryKey(entry: ArtifactDirectoryEntry): string {
  return `${entry.type}:${entry.path}`;
}

type ArtifactPreviewKind =
  | "markdown"
  | "json"
  | "csv"
  | "html"
  | "text"
  | "image"
  | "pdf"
  | "audio"
  | "video"
  | "download";

function artifactMediaType(artifact: Pick<Artifact, "path" | "mediaType" | "kind">): string {
  if (artifact.mediaType) {
    return artifact.mediaType.split(";", 1)[0]!.trim().toLowerCase();
  }
  const extension = artifact.path.split(".").at(-1)?.toLowerCase() ?? "";
  return (
    {
      md: "text/markdown",
      markdown: "text/markdown",
      tex: "application/x-tex",
      json: "application/json",
      csv: "text/csv",
      tsv: "text/tab-separated-values",
      txt: "text/plain",
      log: "text/plain",
      py: "text/x-python",
      js: "text/javascript",
      mjs: "text/javascript",
      cjs: "text/javascript",
      ts: "text/typescript",
      yaml: "text/yaml",
      yml: "text/yaml",
      html: "text/html",
      htm: "text/html",
      svg: "image/svg+xml",
      pdf: "application/pdf",
      png: "image/png",
      apng: "image/apng",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
      avif: "image/avif",
      bmp: "image/bmp",
      ico: "image/x-icon",
      mp3: "audio/mpeg",
      wav: "audio/wav",
      ogg: "audio/ogg",
      oga: "audio/ogg",
      m4a: "audio/mp4",
      aac: "audio/aac",
      flac: "audio/flac",
      mp4: "video/mp4",
      webm: "video/webm",
      mov: "video/quicktime",
      m4v: "video/x-m4v",
      ogv: "video/ogg"
    }[extension] ?? (artifact.kind === "markdown" ? "text/markdown" : "application/octet-stream")
  );
}

function artifactPreviewKind(
  artifact: Pick<Artifact, "path" | "mediaType" | "kind">
): ArtifactPreviewKind {
  const mediaType = artifactMediaType(artifact);
  if (artifact.kind === "markdown" || mediaType === "text/markdown") return "markdown";
  if (mediaType === "application/json" || mediaType.endsWith("+json")) return "json";
  if (mediaType === "text/csv" || mediaType === "text/tab-separated-values") return "csv";
  if (mediaType === "text/html" || mediaType === "application/xhtml+xml") return "html";
  if (mediaType === "application/pdf") return "pdf";
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.startsWith("audio/")) return "audio";
  if (mediaType.startsWith("video/")) return "video";
  if (
    mediaType.startsWith("text/") ||
    mediaType.includes("javascript") ||
    mediaType.includes("typescript") ||
    mediaType.includes("x-tex") ||
    mediaType.includes("xml") ||
    mediaType.includes("yaml")
  ) return "text";
  return "download";
}

function displayItemArtifact(item: DisplayItem): Artifact {
  const artifact = {
    id: item.artifactId,
    path: item.path,
    name: item.title || item.path.split("/").at(-1) || item.path,
    kind: "text" as const,
    agent: item.agent,
    origin: "workspace" as const,
    commitSha: item.commitSha
  };
  const previewKind = artifactPreviewKind(artifact);
  return {
    ...artifact,
    kind: previewKind === "markdown" ? "markdown" : "text",
    mediaType: artifactMediaType(artifact)
  };
}

function displayItems(selection?: DisplaySelection): DisplayItem[] {
  if (!selection) return [];
  const seen = new Set<string>();
  return [selection.primary, ...selection.items].filter((item) => {
    const key = item.artifactId ?? `${item.agent}:${item.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function displayPhase(phase?: string): string {
  if (!phase) return "等待调度";
  if (phase === "collaboration:harness-recovery" || phase.endsWith(":gateway-retrying")) return "模型调用暂时失败，正在自动恢复原任务";
  if (phase.endsWith(":awaiting-experiment-result")) return "等待实验结果（系统监测中）";
  if (phase === "main-recovery-required") return "正在恢复 Main 的处理，恢复后会继续";
  if (phase === "main-recovery-failed") return "Main 处理暂时中断，可以继续恢复";
  if (phase === "gateway-recovery-required") return "网关工具参数异常，等待重新尝试";
  if (phase === "interrupting") return "正在保存中断状态并交给 Main";
  if (phase === "interrupted") return "已保存中断状态，等待恢复";
  if (!/^main(?::|$)/.test(phase)) {
    return phase;
  }
  const state = phase.split(":").at(-1)?.toLowerCase();
  if (state === "completed" || state === "finished") return "main 已完成";
  if (state === "failed" || state === "error") return "main 异常";
  if (state === "queued") return "main 排队中";
  if (state === "recovery-required") return "正在恢复 Main 的处理，恢复后会继续";
  if (state === "running") return "Main 正在评估当前结果并决定下一步";
  return "Main 处理中";
}

function displayProjectStatus(status: Project["status"], runtime?: Project["runtime"]): string {
  const labels: Record<Project["status"], string> = {
    queued: "排队中",
    running: "运行中",
    retrying: "重试中",
    interrupting: "中断中",
    interrupted: "等待恢复",
    pausing: "暂停中",
    paused: "已暂停",
    cancelling: "取消中",
    cancelled: "已取消",
    completed: "已完成",
    draft: "草稿",
    stopping: "停止中",
    stopped: "已停止",
    failed: "失败"
  };
  return projectWaitingLabel(status, runtime) ?? labels[status] ?? status;
}

function displayAgentName(agent?: AgentName): string {
  return agent === SYSTEM_CONTROLLER_AGENT ? "main" : agent ?? "";
}

function ConnectionBadge({ state }: { state: ConnectionState }) {
  const config = {
    live: { label: "实时连接", icon: <Radio size={13} /> },
    connecting: { label: "连接中", icon: <LoaderCircle className="spin" size={13} /> },
    reconnecting: {
      label: "正在重连",
      icon: <RefreshCw className="spin-slow" size={13} />
    },
    offline: { label: "连接断开", icon: <CloudOff size={13} /> }
  }[state];
  return (
    <span className={`connection-badge connection-${state}`}>
      {config.icon}
      {config.label}
    </span>
  );
}

function WorkflowRail({
  project,
  events,
  runtime: runtimeProp
}: {
  project: Project;
  events: AgentEvent[];
  runtime?: WorkflowRuntimeState;
}) {
  const runtime = runtimeProp ?? buildWorkflowRuntimeState(project, events);
  const recentPath = runtime.recentInvocationPath.slice(-5);
  const statusNode = runtime.currentNodeId ?? runtime.queuedNodeId;
  const statusLabel = statusNode ? runtimeNodeLabel(runtime.nodeStates[statusNode]) : "等待运行";
  return (
    <div className="workflow-rail">
      <div className="cycle-label">
        <GitBranch size={14} />
        <span className="cycle-label-copy">
          <strong>第 {project.cycle} 轮</strong>
          <small className={`workflow-rail-status status-${project.status}`}>
            {displayProjectStatus(project.status, project.runtime)}
          </small>
        </span>
      </div>
      <div className="workflow-rail-summary">
        <strong>{statusNode ? `${statusNode} · ${statusLabel}` : statusLabel}</strong>
        <span className="workflow-rail-live-meta">
          {project.currentAgent ? `${displayAgentName(project.currentAgent)} · ` : ""}
          {project.runtime?.waiting?.reason ?? displayPhase(project.phase)}
        </span>
        <span className="workflow-rail-path">
          {recentPath.length ? recentPath.map((entry, index) => <span key={`${entry.invocationId ?? entry.nodeId}-${index}`}>{index ? " → " : ""}{entry.nodeId}{entry.state === "completed" ? " ✓" : entry.state === "running" ? " ·" : ""}</span>) : "尚无实际路径"}
        </span>
      </div>
    </div>
  );
}

function formatLatency(milliseconds: number | undefined): string {
  if (milliseconds === undefined) return "—";
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`;
  return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 2 : 1)} s`;
}

function formatTokenSpeed(
  value: number | undefined,
  source: InvocationPerformance["tokenSource"] | PerformanceAggregate["tokenSource"],
  alwaysEstimated = false
): string {
  if (value === undefined) return "—";
  const approximate = alwaysEstimated || source !== "official";
  return `${approximate ? "≈" : ""}${value.toFixed(1)} tok/s`;
}

function PerformanceMetrics({
  performance,
  averageFallback,
  latestToken,
  compact = false
}: {
  performance?: InvocationPerformance;
  averageFallback?: InvocationPerformance | PerformanceAggregate;
  latestToken?: InvocationPerformance;
  compact?: boolean;
}) {
  const average = averageFallback?.averageTokensPerSecond ?? performance?.averageTokensPerSecond;
  const averageSource = averageFallback?.averageTokensPerSecond !== undefined
    ? averageFallback.tokenSource
    : performance?.tokenSource ?? "estimated";
  const fallbackLatency = averageFallback && "invocationId" in averageFallback
    ? averageFallback.firstTokenLatencyMs
    : undefined;
  const latency = latestToken?.firstTokenLatencyMs ?? performance?.firstTokenLatencyMs ?? fallbackLatency;
  return (
    <div className={`performance-metrics ${compact ? "compact" : ""}`}>
      <span title="最近一次实际测得的首 Token 延迟"><small>首 Token 延迟</small><strong>{formatLatency(latency)}</strong></span>
      <span>
        <small>当前速度</small>
        <strong>
          {performance?.status === "active" && performance.requestActive !== false && performance.streaming
            ? formatTokenSpeed(performance.currentTokensPerSecond, performance.tokenSource, true)
            : performance?.status === "active" && performance.requestActive !== false
              ? "非流式"
              : "—"}
        </strong>
      </span>
      <span><small>平均速度</small><strong>{formatTokenSpeed(average, averageSource)}</strong></span>
    </div>
  );
}

type ScopedRosterState = ReturnType<typeof scopedGroupDisplayState>;

interface ScopedRosterAgent {
  kind: "agent";
  nodeId: string;
  agentId: string;
  executionCount: number;
  state: ScopedRosterState;
  label: string;
}

interface ScopedRosterGroup {
  kind: "group";
  id: string;
  displayName: string;
  state: ScopedRosterState;
  phaseLabel: string;
  executionCount: number;
  pullRequestCount: number;
  entries: ScopedRosterEntry[];
}

type ScopedRosterEntry = ScopedRosterAgent | ScopedRosterGroup;

const SCOPED_ROSTER_STATE_LABELS: Partial<Record<ScopedRosterState, string>> = {
  running: "运行中",
  completed: "已完成",
  failed: "故障",
  paused: "已暂停",
  waiting: "等待执行"
};

function scopedRosterState(status: string | undefined): ScopedRosterState {
  if (status === "completed" || status === "succeeded" || status === "merged") return "completed";
  if (status === "failed" || status === "error") return "failed";
  if (status === "paused" || status === "cancelled" || status === "stopped" || status === "interrupted") return "paused";
  if (status === "running" || status === "retrying" || status === "integrating" || status === "coordinating" || status === "working") return "running";
  return "waiting";
}

function scopedRosterMemberState(executions: readonly ScopedExecution[], currentRunId?: string): ScopedRosterState {
  const current = currentRunId
    ? executions.filter((execution) => execution.groupRunId === currentRunId)
    : [];
  if (!current.length) return "waiting";
  const states = current.map((execution) => scopedRosterState(execution.status));
  if (states.includes("running")) return "running";
  if (states.includes("failed")) return "failed";
  if (states.includes("paused")) return "paused";
  if (states.includes("completed")) return "completed";
  return "waiting";
}

function scopedRosterPhaseLabel(group: ScopedRosterGroup, currentStatus?: string): string {
  if (group.state === "completed") return "已完成";
  if (group.state === "failed") return "故障";
  if (group.state === "paused") return "已暂停";
  if (group.state === "running") return currentStatus === "integrating" ? "最终集成中" : "运行中";
  return group.state === "waiting" ? "等待启动" : runtimeNodeLabel(group.state);
}

/** Build the v3 roster from scoped graph nodes and durable execution facts. */
function buildScopedRosterGroup(
  project: Project,
  groupId: string,
  ancestry: ReadonlySet<string> = new Set()
): ScopedRosterGroup | undefined {
  const contract = project.orchestration.scopedWorkflow;
  const definition = contract?.groups.find((group) => group.id === groupId);
  if (!definition || ancestry.has(groupId)) return undefined;
  const nextAncestry = new Set(ancestry);
  nextAncestry.add(groupId);
  const displayName = project.orchestration.collaborations?.find((group) => group.id === groupId)?.displayName ?? groupId;
  const runs = (project.scopedGroupRuns ?? []).filter((run) => run.groupId === groupId);
  const currentRun = currentScopedGroupRun(project, groupId);
  const runIds = new Set(runs.map((run) => run.id));
  const executionsById = new Map<string, ScopedExecution>();
  for (const execution of project.scopedExecutions ?? []) {
    if (runIds.has(execution.groupRunId)) executionsById.set(execution.id, execution);
  }
  const executions = [...executionsById.values()];
  const executionIds = new Set(executions.map((execution) => execution.id));
  const groupState = scopedGroupDisplayState(project, groupId);
  const members: ScopedRosterEntry[] = definition.workflow.nodes.flatMap((node): ScopedRosterEntry[] => {
    if (node.kind === "agent") {
      const memberExecutions = executions.filter((execution) => execution.agentId === node.agentId);
      // Keep recursive details and historical counts while sharing the same
      // current-arrival/lifecycle projection as the runtime canvases. Older
      // snapshots without arrival facts retain their execution-based fallback.
      const hasArrival = (project.scopedArrivals ?? []).some((arrival) =>
        arrival.groupRunId === currentRun?.id && arrival.targetNodeId === node.nodeId);
      const state = hasArrival
        ? scopedNodeDisplayState(project, groupId, node.nodeId)
        : projectLifecycleState(project, scopedRosterMemberState(memberExecutions, currentRun?.id));
      return [{
        kind: "agent" as const,
        nodeId: node.nodeId,
        agentId: node.agentId,
        executionCount: memberExecutions.length,
        state,
        label: SCOPED_ROSTER_STATE_LABELS[state] ?? runtimeNodeLabel(state)
      }];
    }
    const child = buildScopedRosterGroup(project, node.groupId, nextAncestry);
    return child ? [child] : [];
  });
  const pullRequestCount = (project.scopedPullRequests ?? [])
    .filter((pull) => executionIds.has(pull.ownerExecutionId)).length;
  const group: ScopedRosterGroup = {
    kind: "group",
    id: definition.id,
    displayName,
    state: groupState,
    phaseLabel: "",
    executionCount: executions.length,
    pullRequestCount,
    entries: members
  };
  group.phaseLabel = scopedRosterPhaseLabel(group, currentRun?.status);
  return group;
}

function ScopedRosterAgentView({
  project,
  member,
  nested = false
}: {
  project: Project;
  member: ScopedRosterAgent;
  nested?: boolean;
}) {
  const definition = project.orchestration.agents.find((entry) => entry.name === member.agentId);
  const config = project.agents[member.agentId];
  const meta = agentMeta(member.agentId, definition?.template ?? "general");
  const reasoningLabel = config?.gatewaySnapshot?.reasoning?.label ?? config?.gatewayReasoningOption ?? "Provider 默认";
  return <div className={`roster-scoped-member member-${member.state}`} data-member-agent={member.agentId}>
    <span className={`roster-agent-icon agent-${meta.color}`}><AgentIcon role={definition?.template ?? "general"} size={nested ? 14 : 16} />{member.state === "running" && <i />}</span>
    <span className="roster-scoped-member-copy">
      <strong>{member.agentId}</strong>
      <small>{member.agentId === SYSTEM_CONTROLLER_AGENT ? "Main Agent" : `Worker · ${definition?.template ?? "general"}`}</small>
      <small>{config?.model || "未配置模型"} · 网关思考强度 {reasoningLabel}</small>
      <span>执行 {member.executionCount} 次 · {member.label}</span>
      {config?.skills?.length ? <small className="roster-scoped-skills">Skill：{config.skills.slice(0, 3).join("、")}{config.skills.length > 3 ? ` +${config.skills.length - 3}` : ""}</small> : null}
    </span>
  </div>;
}

function ScopedRosterGroupView({
  project,
  group,
  runtime,
  nested = false
}: {
  project: Project;
  group: ScopedRosterGroup;
  runtime?: WorkflowRuntimeState;
  nested?: boolean;
}) {
  return <details className={`roster-scoped-group roster-${group.state} ${nested ? "roster-scoped-group-nested" : ""} ${runtime?.currentNodeId === group.id ? "current" : ""}`} open={nested || undefined} data-roster-group={group.id}>
    <summary>
      <span className="roster-agent-icon agent-violet">组{group.state === "running" && <i />}</span>
      <span className="roster-agent-copy">
        <strong>{group.displayName}</strong>
        <small>{group.entries.length} 个成员 · 共执行 {group.executionCount} 次{group.pullRequestCount ? ` · ${group.pullRequestCount} 个 PR` : ""}</small>
      </span>
      <span className={`run-state run-state-${group.state}`}>{group.phaseLabel}</span>
    </summary>
    <div className="roster-scoped-group-members">
      {group.entries.map((entry) => entry.kind === "agent"
        ? <ScopedRosterAgentView key={entry.nodeId} project={project} member={entry} nested={nested} />
        : <ScopedRosterGroupView key={entry.id} project={project} group={entry} runtime={runtime} nested />)}
      {!group.entries.length && <small className="roster-collaboration-more">尚无组内节点</small>}
    </div>
  </details>;
}

export function AgentRoster({
  project,
  runtime,
  livePerformance,
  onEditModels,
  onEditGroups
}: {
  project: Project;
  events: AgentEvent[];
  runtime?: WorkflowRuntimeState;
  livePerformance?: InvocationPerformance;
  onEditModels: () => void;
  onEditGroups: () => void;
}) {
  return (
    <aside className="workspace-panel agent-roster">
      <div className="panel-heading">
        <div>
          <span className="panel-kicker">Orchestration</span>
          <h2>智能体协作</h2>
        </div>
        <div className="agent-roster-heading-actions">
          <span className="agent-online-count">
            <span />
            {workflowOuterNodes(project.orchestration).length} 个外层节点
          </span>
          {project.status === "draft" && !project.configurationLocked && (
            <button
              type="button"
              className="agent-model-edit-trigger"
              onClick={onEditModels}
              aria-label="编辑 Agent 模型、Prompt、Skills 与 MCP"
            >
              <Cpu size={13} />
              编辑配置
            </button>
          )}
          {project.git?.enabled && project.status === "draft" && !project.configurationLocked && (
            <button
              type="button"
              className="agent-model-edit-trigger"
              onClick={onEditGroups}
              aria-label="编辑协作组配置"
            >
              <Layers3 size={13} />
              编辑协作组
            </button>
          )}
        </div>
      </div>
      <div className="agent-roster-list">
        {workflowOuterNodes(project.orchestration).map((outerNode) => {
          if (outerNode.collaboration) {
            const group = outerNode.collaboration;
            const scopedRoster = project.orchestration.schemaVersion === 3
              ? buildScopedRosterGroup(project, group.id)
              : undefined;
            if (scopedRoster) {
              return <ScopedRosterGroupView
                key={group.id}
                project={project}
                group={scopedRoster}
                runtime={runtime}
              />;
            }
            const scopedRun = project.orchestration.schemaVersion === 3
              ? currentScopedGroupRun(project, group.id)
              : undefined;
            const scopedExecutions = scopedRun
              ? (project.scopedExecutions ?? []).filter((execution) => execution.groupRunId === scopedRun.id)
              : [];
            const progress = project.orchestration.schemaVersion === 3 ? undefined : collaborationProgress(project, group);
            const scopedMembers = project.orchestration.schemaVersion === 3 ? scopedRosterMembers(project, group.id) : [];
            const state = project.orchestration.schemaVersion === 3
              ? scopedGroupDisplayState(project, group.id) : progress?.state ?? "waiting";
            const totalExecutions = project.orchestration.schemaVersion === 3
              ? scopedMembers.reduce((sum, member) => sum + member.executionCount, 0)
              : progress?.members.reduce((total, member) => total + member.executionCount, 0) ?? 0;
            const pullRequestCount = scopedRun
              ? (project.scopedPullRequests ?? []).filter((pull) => scopedExecutions.some((execution) => execution.id === pull.ownerExecutionId)).length
              : progress?.groupRun
                ? (project.pullRequests ?? []).filter((pull) => {
                    const execution = (project.executions ?? []).find((entry) => entry.id === pull.ownerExecutionId);
                    return execution?.groupRunId === progress.groupRun?.id;
                  }).length
                : 0;
            const phaseLabel = project.orchestration.schemaVersion === 3
              ? scopedRun ? runtimeNodeLabel(state) : "等待启动"
              : progress?.phaseLabel ?? "等待启动";
            return <details className={`roster-agent roster-collaboration roster-${state} ${runtime?.currentNodeId === group.id ? "current" : ""}`} key={group.id}>
              <summary>
                <span className="roster-agent-icon agent-violet">组{state === "running" && <i />}</span>
                <span className="roster-agent-copy">
                  <strong>{group.displayName}</strong>
                  <small>{project.orchestration.schemaVersion === 3 ? new Set(scopedMembers.map((member) => member.agentId)).size : group.memberAgentIds.length} 个 Agent · 共执行 {totalExecutions} 次{pullRequestCount ? ` · ${pullRequestCount} 个 PR` : ""}</small>
                </span>
                <span className={`run-state run-state-${state}`}>{phaseLabel}</span>
              </summary>
              <div className="roster-collaboration-members">
                {project.orchestration.schemaVersion === 3
                  ? scopedMembers.map((member) => <div className={`member-${member.state}`} key={member.key}><div className="roster-member-identity"><strong>{member.agentId}</strong><small>{member.scopeLabel}</small></div><span>执行 {member.executionCount} 次 · {runtimeNodeLabel(member.state)}</span></div>)
                  : progress?.members.map((member) => <div className={`member-${member.state}`} key={member.agentId}><strong>{member.agentId}</strong><span>执行 {member.executionCount} 次 · {member.label}</span></div>)}
              </div>
            </details>;
          }
          const definition = outerNode.definition!;
          const agent = definition.name;
          const role = definition.template ?? "general";
          const meta = agentMeta(agent, role);
          const progress = project.agentProgress[agent];
          const executionCount =
            runtime?.executionCounts[agent] ??
            progress?.executions ??
            progress?.runs ??
            0;
          const state = runtime?.nodeStates[agent] ?? runtimeDisplayState(progress?.state ?? "waiting");
          const metrics = resolvePerformanceMetrics(project.performance, livePerformance, project.status, agent);
          const config = project.agents[agent];
          const reasoningLabel = config.gatewaySnapshot?.reasoning?.label
            ?? config.gatewayReasoningOption
            ?? "Provider 默认";
          return (
            <div
              className={`roster-agent roster-${state} ${project.currentAgent === agent ? "current" : ""}`}
              key={agent}
            >
              <span className={`roster-agent-icon agent-${meta.color}`}>
                <AgentIcon role={role} size={18} />
                {state === "running" && <i />}
              </span>
              <div className="roster-agent-copy">
                <strong>{agent}</strong>
                <small>{agent === SYSTEM_CONTROLLER_AGENT ? "Main Agent" : `Worker · ${role}`}</small>
                <span>
                  {config.model || "未配置模型"} · 网关思考强度 {reasoningLabel}
                </span>
                {config.reasoningMigrationWarning && <small className="field-error">
                  {config.reasoningMigrationWarning}
                </small>}
                <small>
                  {executionCount} 次执行
                  {progress?.queuePosition
                    ? ` · 队列 #${progress.queuePosition}`
                    : ""}
                </small>
                <small className="roster-performance">
                  平均 {formatTokenSpeed(metrics.average?.averageTokensPerSecond, metrics.average?.tokenSource ?? "estimated")}
                  {metrics.current?.streaming && ` · 当前 ${formatTokenSpeed(metrics.current.currentTokensPerSecond, metrics.current.tokenSource, true)}`}
                </small>
              </div>
              <span className={`run-state run-state-${state}`}>
                {runtimeNodeLabel(state)}
              </span>
              <div className="roster-agent-detail">
                <p>{meta.description}</p>
                <div className="roster-progress-meta">
                  <strong>已执行 {executionCount} 次</strong>
                  {progress?.queuePosition && (
                    <span>队列 #{progress.queuePosition}</span>
                  )}
                </div>
                <PerformanceMetrics
                  performance={metrics.current}
                  averageFallback={metrics.average}
                  latestToken={metrics.latestToken}
                  compact
                />
                <div>
                  {config.skills.length ? (
                    <>
                      {config.skills.slice(0, 2).map((skill) => (
                        <span key={skill}>{skill}</span>
                      ))}
                      {config.skills.length > 2 && (
                        <span>+{config.skills.length - 2}</span>
                      )}
                    </>
                  ) : (
                    <small>未挂载额外 Skill</small>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}

function CollaborationGroupEditor({
  project,
  saving,
  error,
  notice,
  onClose,
  onApply
}: {
  project: Project;
  saving: boolean;
  error: string;
  notice: string;
  onClose: () => void;
  onApply: (input: CollaborationGroupUpdateIntent) => Promise<boolean>;
}) {
  const groups = project.orchestration.collaborations ?? [];
  const locked = useMemo(() => lockedCollaborationIds(project), [project]);
  const [draftNames, setDraftNames] = useState<Record<string, string>>(
    () => Object.fromEntries(groups.map((group) => [group.id, group.displayName]))
  );
  const [dissolvingGroupId, setDissolvingGroupId] = useState<string>();
  const [dissolutionPlans, setDissolutionPlans] = useState<Record<string, CollaborationDissolutionPlan>>(
    () => Object.fromEntries(groups.map((group) => [
      group.id,
      buildGuidedDissolutionPlan(
        project.orchestration,
        group,
        group.memberAgentIds[0]!,
        group.memberAgentIds.at(-1)!
      )
    ]))
  );

  return (
    <div
      className="modal-backdrop collaboration-group-dialog-backdrop"
      onMouseDown={() => {
        if (!saving) onClose();
      }}
    >
      <div
        className="collaboration-group-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="collaboration-group-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="agent-model-dialog-head">
          <div>
            <span className="panel-kicker">Collaboration Configuration</span>
            <h2 id="collaboration-group-dialog-title">编辑协作组</h2>
            <p>可修改显示名称或解散已结束的协作组。解散只创建新的 Workflow revision，Agent、Git 分支、PR、commit、产物和历史运行记录均会保留。</p>
          </div>
          <button
            type="button"
            className="dialog-close-button"
            onClick={onClose}
            disabled={saving}
            aria-label="关闭协作组配置"
          >
            <X size={18} />
          </button>
        </div>

        <div className="collaboration-group-edit-list">
          {groups.length === 0 && <p className="collaboration-group-empty">当前模板尚无协作组。</p>}
          {groups.map((group) => {
            const isLocked = locked.has(group.id);
            const policyLocked = group.renamePolicy === "locked";
            const draftName = draftNames[group.id] ?? group.displayName;
            const exactRestore = canRestoreCollaborationSnapshot(project.orchestration, group);
            const dissolution = dissolutionPlans[group.id] ?? buildGuidedDissolutionPlan(
              project.orchestration,
              group,
              group.memberAgentIds[0]!,
              group.memberAgentIds.at(-1)!
            );
            const topologyError = exactRestore
              ? undefined
              : dissolutionPlanError(project.orchestration, group, dissolution);
            return (
              <section className="collaboration-group-edit-card" key={group.id}>
                <div>
                  <strong>{group.displayName}</strong>
                  <small>{group.id} · {group.memberAgentIds.length} 名成员</small>
                </div>
                <label>
                  <span>显示名称</span>
                  <input
                    aria-label={`${group.id} 协作组显示名称`}
                    value={draftName}
                    maxLength={64}
                    disabled={saving || isLocked || policyLocked}
                    onChange={(event) => setDraftNames((current) => ({
                      ...current,
                      [group.id]: event.target.value
                    }))}
                  />
                </label>
                <Button
                  variant="secondary"
                  disabled={
                    saving || isLocked || policyLocked ||
                    !draftName.trim() || draftName.trim() === group.displayName
                  }
                  onClick={() => void onApply({
                    action: "rename",
                    groupId: group.id,
                    displayName: draftName.trim()
                  })}
                >
                  保存名称
                </Button>
                <Button
                  variant="danger"
                  disabled={saving || isLocked || policyLocked}
                  onClick={() => setDissolvingGroupId((current) => current === group.id ? undefined : group.id)}
                >
                  {dissolvingGroupId === group.id ? "取消解散" : "解散协作组"}
                </Button>
                {dissolvingGroupId === group.id && <div className="collaboration-dissolution-plan">
                  <strong>{exactRestore ? "可精确恢复成组前拓扑" : "旧协作组需要指定恢复路径"}</strong>
                  <p>{exactRestore
                    ? "将恢复各成员成组前的入边、出边、判定方案和画布位置。"
                    : "请逐条指定原入边、每个成员的出边，以及受影响的输入和终止节点；下方会实时校验解散后的拓扑。"}</p>
                  {exactRestore && <div className="collaboration-dissolution-mapping" aria-label={`${group.displayName} 成组前拓扑恢复预览`}>
                    <section><strong>恢复预览 · Workflow revision {group.formationSnapshot?.workflowRevision}</strong>
                      {Object.entries(group.formationSnapshot?.inboundRoutes ?? {}).map(([source, routes]) => <p key={source}>{source} → {routes.map((edge) => edge.target).join("、")}</p>)}
                      {group.memberAgentIds.map((member) => <p key={member}>{member} → {(group.formationSnapshot?.memberRoutes[member] ?? []).map((edge) => edge.target).join("、")}</p>)}
                      {group.formationSnapshot?.inputTarget && <p>用户输入 → {group.formationSnapshot.inputTarget}</p>}
                      {group.formationSnapshot?.terminationAgent && <p>终止 Agent → {group.formationSnapshot.terminationAgent}</p>}
                    </section>
                  </div>}
                  {!exactRestore && <CollaborationDissolutionPlanner
                    orchestration={project.orchestration}
                    group={group}
                    plan={dissolution}
                    disabled={saving}
                    onChange={(plan) => setDissolutionPlans((current) => ({ ...current, [group.id]: plan }))}
                  />}
                  <Button variant="danger" disabled={saving || Boolean(topologyError)} onClick={() => void (async () => {
                    if (!window.confirm(`确认解散「${group.displayName}」？Agent 和全部历史记录都会保留。`)) return;
                    const restoration = exactRestore
                      ? undefined
                      : dissolution;
                    const applied = await onApply({
                      action: "dissolve",
                      groupId: group.id,
                      expectedWorkflowRevision: project.workflowRevision ?? 1,
                      ...(restoration ? { restoration } : {})
                    });
                    if (applied) setDissolvingGroupId(undefined);
                  })()}>确认解散并创建新 Revision</Button>
                </div>}
                {isLocked && (
                  <small className="collaboration-group-lock" role="status">
                    运行中或最终 PR 尚未终结，当前组不可编辑。
                  </small>
                )}
                {policyLocked && !isLocked && (
                  <small className="collaboration-group-lock" role="status">该组名称由策略锁定。</small>
                )}
                <small className="collaboration-group-members">
                  成员：{group.memberAgentIds.join("、")}
                </small>
              </section>
            );
          })}
        </div>

        {error && <div className="agent-model-dialog-error" role="alert">{error}</div>}
        {notice && <div className="agent-model-dialog-success" role="status">{notice}</div>}
      </div>
    </div>
  );
}

type AgentRuntimeConfigDraft = {
  model: string;
  gatewayReasoningOption?: string | null;
  instructions: string;
  skills: string[];
  autoSkills: string[];
  mcpServers: AgentMcpServer[];
  experimentMcp: boolean;
  permission: AgentConfig["permission"];
  webSearch: boolean;
};

function AgentModelEditor({
  project,
  harnesses,
  gateways,
  models,
  skills,
  mcpDirectory,
  defaultPrompts,
  mainSystemPrompt,
  saving,
  error,
  notice,
  onClose,
  onAddSkill,
  onApply
}: {
  project: Project;
  harnesses: HarnessCatalogEntry[];
  gateways: GatewayRecord[];
  models: string[];
  skills: SkillDefinition[];
  mcpDirectory: FixedMcpDefinition[];
  defaultPrompts: Record<string, string>;
  mainSystemPrompt: string;
  saving: boolean;
  error: string;
  notice: string;
  onClose: () => void;
  onAddSkill: (title: string, content: string) => Promise<SkillDefinition>;
  onApply: (
    agents: Partial<Record<AgentName, AgentRuntimeConfigDraft>>
  ) => Promise<boolean>;
}) {
  const agentNames = project.orchestration.agents.map(
    (definition) => definition.name
  );
  const templateFor = (agent: AgentName) =>
    agentTemplateFor(project.orchestration, agent);
  const defaultPromptFor = (agent: AgentName): string => {
    const template = templateFor(agent);
    return (
      (isAgentTemplate(template) ? defaultPrompts[template] : undefined) ||
      `你是 ${agent} Agent。`
    );
  };
  const [draftModels, setDraftModels] = useState<Record<AgentName, string>>(
    () =>
      Object.fromEntries(
        agentNames.map((agent) => [agent, project.agents[agent].model])
      ) as Record<AgentName, string>
  );
  const [draftGatewayReasoningOptions, setDraftGatewayReasoningOptions] = useState<
    Record<AgentName, string | undefined>
  >(
    () => Object.fromEntries(agentNames.map((agent) => [
      agent,
      project.agents[agent].gatewayReasoningOption
    ])) as Record<AgentName, string | undefined>
  );
  const [draftPermissions, setDraftPermissions] = useState<
    Record<AgentName, AgentConfig["permission"]>
  >(
    () =>
      Object.fromEntries(
        agentNames.map((agent) => [agent, project.agents[agent].permission])
      ) as Record<AgentName, AgentConfig["permission"]>
  );
  const [draftWebSearch, setDraftWebSearch] = useState<Record<AgentName, boolean>>(
    () =>
      Object.fromEntries(
        agentNames.map((agent) => [agent, project.agents[agent].webSearch])
      ) as Record<AgentName, boolean>
  );
  const [draftExperimentMcp, setDraftExperimentMcp] = useState<Record<AgentName, boolean>>(
    () => Object.fromEntries(agentNames.map((agent) => [agent, project.agents[agent].experimentMcp === true]))
  );
  const [draftInstructions, setDraftInstructions] = useState<
    Record<AgentName, string>
  >(
    () =>
      Object.fromEntries(
        agentNames.map((agent) => [
          agent,
          project.agents[agent].instructions || defaultPromptFor(agent)
        ])
      ) as Record<AgentName, string>
  );
  const [draftSkills, setDraftSkills] = useState<Record<AgentName, string[]>>(
    () =>
      Object.fromEntries(
        agentNames.map((agent) => [agent, [...project.agents[agent].skills]])
      ) as Record<AgentName, string[]>
  );
  const [draftAutoSkills, setDraftAutoSkills] = useState<
    Record<AgentName, string[]>
  >(
    () =>
      Object.fromEntries(
        agentNames.map((agent) => [
          agent,
          [...project.agents[agent].autoSkills]
        ])
      ) as Record<AgentName, string[]>
  );
  const [draftMcpServers, setDraftMcpServers] = useState<
    Record<AgentName, AgentMcpServer[]>
  >(
    () =>
      Object.fromEntries(
        agentNames.map((agent) => [
          agent,
          project.agents[agent].mcpServers.map((server) => ({ ...server }))
        ])
      ) as Record<AgentName, AgentMcpServer[]>
  );
  const [selectedRoles, setSelectedRoles] = useState<AgentName[]>([]);
  // Planning sees the complete latest editor context. Only the Agent's
  // selected business tools are replaced; the system does not do its work.
  const recommendationAgents = useMemo(() => Object.fromEntries(
    Object.entries(project.agents).map(([agent, config]) => [agent, {
      ...config,
      model: draftModels[agent],
      gatewayReasoningOption: draftGatewayReasoningOptions[agent],
      instructions: draftInstructions[agent],
      skills: draftSkills[agent],
      autoSkills: draftAutoSkills[agent],
      mcpServers: draftMcpServers[agent],
      experimentMcp: draftExperimentMcp[agent],
      permission: draftPermissions[agent],
      webSearch: draftWebSearch[agent]
    }])
  ), [project.agents, draftModels, draftGatewayReasoningOptions, draftInstructions,
    draftSkills, draftAutoSkills, draftMcpServers, draftExperimentMcp, draftPermissions, draftWebSearch]);
  const [batchModel, setBatchModel] = useState("");
  const [skillDialogRole, setSkillDialogRole] = useState<AgentName>();
  const [skillInputNotices, setSkillInputNotices] = useState<
    Partial<Record<AgentName, string>>
  >({});
  const allSelected = selectedRoles.length === agentNames.length;
  const modelOptions = Array.from(
    new Set([
      ...models,
      ...agentNames.map((agent) => project.agents[agent].model)
    ].filter(Boolean))
  );
  const availableSkills = useMemo(() => {
    const byId = new Map(skills.map((skill) => [skill.id, skill]));
    for (const agent of agentNames) {
      for (const skillId of [
        ...draftSkills[agent],
        ...draftAutoSkills[agent]
      ]) {
        if (byId.has(skillId)) continue;
        const pathParts = skillId.split(/[\\/]/).filter(Boolean);
        const finalPart = pathParts[pathParts.length - 1];
        const name =
          finalPart?.toLowerCase() === "skill.md"
            ? pathParts[pathParts.length - 2] || skillId
            : pathParts.length > 1
              ? finalPart || skillId
              : skillId.split(":").pop() || skillId;
        byId.set(skillId, { id: skillId, name });
      }
    }
    return [...byId.values()];
  }, [draftSkills, draftAutoSkills, skills]);
  const availableMcpServers = useMemo(() => {
    const byKey = new Map<string, AgentMcpServer>();
    for (const server of mcpDirectory) {
      byKey.set(agentMcpServerKey(server), server);
    }
    for (const agent of agentNames) {
      for (const server of draftMcpServers[agent]) {
        byKey.set(agentMcpServerKey(server), server);
      }
    }
    return [...byKey.values()];
  }, [draftMcpServers, mcpDirectory]);
  const harnessForRole = (role: AgentName): HarnessCatalogEntry | undefined => {
    const harnessId = project.agents[role].harness ?? catalogDefaultHarnessId(harnesses);
    return harnesses.find((item) => item.id === harnessId);
  };
  const reasoningOptionsForRole = (role: AgentName, model = draftModels[role]) =>
    project.agents[role].gatewaySnapshot?.modelReasoning?.[model]?.options ?? [];

  useEffect(() => {
    setDraftInstructions((current) =>
      Object.fromEntries(
        agentNames.map((agent) => [
          agent,
          current[agent] || project.agents[agent].instructions || defaultPromptFor(agent)
        ])
      ) as Record<AgentName, string>
    );
  }, [defaultPrompts, project.agents]);

  const sameSkills = (left: string[], right: string[]) =>
    left.length === right.length &&
    left.every((skill, index) => skill === right[index]);

  const sameMcpServers = (
    left: AgentMcpServer[],
    right: AgentMcpServer[]
  ) =>
    left.length === right.length &&
    left.every(
      (server, index) =>
        agentMcpServerKey(server) === agentMcpServerKey(right[index]!)
    );

  const roleChanged = (role: AgentName) =>
    draftModels[role].trim() !== project.agents[role].model ||
    draftGatewayReasoningOptions[role] !== project.agents[role].gatewayReasoningOption ||
    draftInstructions[role].trim() !==
      (project.agents[role].instructions || defaultPromptFor(role)).trim() ||
    !sameSkills(draftSkills[role], project.agents[role].skills) ||
    !sameSkills(draftAutoSkills[role], project.agents[role].autoSkills) ||
    !sameMcpServers(draftMcpServers[role], project.agents[role].mcpServers) ||
    draftExperimentMcp[role] !== (project.agents[role].experimentMcp === true) ||
    draftPermissions[role] !== project.agents[role].permission ||
    draftWebSearch[role] !== project.agents[role].webSearch;

  const setDraftSkillMode = (
    role: AgentName,
    skillId: string,
    mode: "fixed" | "auto" | undefined
  ) => {
    const harness = harnessForRole(role);
    if (mode && harness?.capabilities.skills === false) return;
    if (mode === "auto" && harness?.capabilities.autoSkills === false) return;
    setDraftSkills((current) => {
      const next = current[role].filter((item) => item !== skillId);
      if (mode === "fixed") next.push(skillId);
      return { ...current, [role]: next };
    });
    setDraftAutoSkills((current) => {
      const next = current[role].filter((item) => item !== skillId);
      if (mode === "auto") next.push(skillId);
      return { ...current, [role]: next };
    });
  };

  const toggleRole = (role: AgentName) => {
    setSelectedRoles((current) =>
      current.includes(role)
        ? current.filter((item) => item !== role)
        : [...current, role]
    );
  };

  const toggleAll = () => {
    setSelectedRoles(allSelected ? [] : [...agentNames]);
  };

  const addSkillForRole = async (
    role: AgentName,
    title: string,
    content: string
  ) => {
    setSkillInputNotices((current) => ({ ...current, [role]: "" }));
    const skill = await onAddSkill(title, content);
    setSkillInputNotices((current) => ({
      ...current,
      [role]: `${skill.name} 已保存并加入候选，请勾选后设置加载方式。`
    }));
    return skill;
  };

  const addMcpForRole = (
    role: AgentName,
    name: string,
    url: string
  ): AgentMcpServer => {
    const harness = harnessForRole(role);
    if (harness?.capabilities.mcp === false) {
      throw new Error(`${harness.label} 不支持 MCP`);
    }
    const normalizedName = name.trim();
    const normalizedUrl = url.trim();
    const fixed = mcpDirectory.find(
      (entry) => entry.name.toLowerCase() === normalizedName.toLowerCase()
    );
    if (fixed && (fixed.name !== normalizedName || fixed.url !== normalizedUrl)) {
      throw new Error(`系统 MCP ${fixed.name} 的名称和 URL 不可修改`);
    }
    if (
      draftMcpServers[role].some(
        (server) => server.name.toLowerCase() === normalizedName.toLowerCase()
      )
    ) {
      throw new Error(`MCP 名称已存在：${normalizedName}`);
    }
    if (draftMcpServers[role].length >= 32) {
      throw new Error("每个 Agent 最多可配置 32 个 MCP");
    }
    const server = { name: normalizedName, url: normalizedUrl };
    setDraftMcpServers((current) => ({
      ...current,
      [role]: [...current[role], server]
    }));
    return server;
  };

  const toggleMcpForRole = (
    role: AgentName,
    server: AgentMcpServer,
    enabled: boolean
  ) => {
    const harness = harnessForRole(role);
    if (enabled && harness?.capabilities.mcp === false) return;
    setDraftMcpServers((current) => {
      const remaining = current[role].filter((item) =>
        enabled
          ? item.name.toLowerCase() !== server.name.toLowerCase()
          : agentMcpServerKey(item) !== agentMcpServerKey(server)
      );
      return {
        ...current,
        [role]: enabled ? [...remaining, { ...server }] : remaining
      };
    });
  };

  const applyOne = async (role: AgentName) => {
    const model = draftModels[role].trim();
    if (!model) return;
    await onApply({
      [role]: {
        model,
        gatewayReasoningOption: draftGatewayReasoningOptions[role] ?? null,
        instructions: draftInstructions[role].trim() || defaultPromptFor(role),
        skills: draftSkills[role],
        autoSkills: draftAutoSkills[role],
        mcpServers: draftMcpServers[role],
        experimentMcp: draftExperimentMcp[role],
        permission: draftPermissions[role],
        webSearch: draftWebSearch[role]
      }
    });
  };

  const applyBatch = async () => {
    const model = batchModel.trim();
    if (!model || selectedRoles.length === 0) return;
    const agents = Object.fromEntries(
      selectedRoles.map((role) => [
        role,
        {
          model,
          gatewayReasoningOption: reasoningOptionsForRole(role, model).some(
            (option) => option.id === draftGatewayReasoningOptions[role]
          ) ? draftGatewayReasoningOptions[role] : null,
          instructions: draftInstructions[role].trim() || defaultPromptFor(role),
          skills: draftSkills[role],
          autoSkills: draftAutoSkills[role],
          mcpServers: draftMcpServers[role],
          experimentMcp: draftExperimentMcp[role],
          permission: draftPermissions[role],
          webSearch: draftWebSearch[role]
        }
      ])
    ) as Partial<Record<AgentName, AgentRuntimeConfigDraft>>;
    const applied = await onApply(agents);
    if (!applied) return;
    setDraftModels((current) => ({
      ...current,
      ...Object.fromEntries(selectedRoles.map((role) => [role, model]))
    }));
    setDraftGatewayReasoningOptions((current) => ({
      ...current,
      ...Object.fromEntries(selectedRoles.map((role) => [
        role,
        reasoningOptionsForRole(role, model).some((option) => option.id === current[role])
          ? current[role]
          : undefined
      ]))
    }));
  };

  return (
    <RecommendationProvider
      input={{ projectId: project.id, title: project.title, requirement: project.requirement,
        agents: recommendationAgents, orchestration: project.orchestration, git: { enabled: project.git?.enabled === true } }}
      gateways={gateways} harnesses={harnesses}
      catalogVersion={JSON.stringify([skills, mcpDirectory])}
      disabled={saving || project.status !== "draft" || project.configurationLocked === true}
      onApplyTools={(agent, selection) => {
        if (!project.agents[agent]) return;
        setDraftSkills(current => ({ ...current, [agent]: selection.skills }));
        setDraftAutoSkills(current => ({ ...current, [agent]: selection.autoSkills }));
        setDraftMcpServers(current => ({ ...current, [agent]: selection.mcpServers }));
        setDraftExperimentMcp(current => ({ ...current, [agent]: selection.experimentMcp }));
      }}>
    <div
      className="modal-backdrop agent-model-dialog-backdrop"
      onMouseDown={() => {
        if (!saving) onClose();
      }}
    >
      <div
        className="agent-model-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-model-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="agent-model-dialog-head">
          <div>
            <span className="panel-kicker">Project Agent Configuration</span>
            <h2 id="agent-model-dialog-title">编辑 Agent 完整配置</h2>
            <p>
              每行可编辑模型、网关思考强度、完整 Prompt、Skills 与 MCP，并可单独应用。批量操作只替换已选 Agent 的模型；若新模型不支持原网关选项，会自动恢复模型默认值。
            </p>
          </div>
          <button
            type="button"
            className="dialog-close-button"
            onClick={onClose}
            disabled={saving}
            aria-label="关闭 Agent 配置编辑"
          >
            <X size={18} />
          </button>
        </div>

        <ExplainerRecommendationSettings />

        <div className="agent-model-batch-bar">
          <button
            type="button"
            className={`agent-model-select-all ${allSelected ? "active" : ""}`}
            onClick={toggleAll}
            disabled={saving}
          >
            <Check size={14} />
            {allSelected ? "取消全选" : "全选"}
          </button>
          <span>已选择 {selectedRoles.length} / {agentNames.length}</span>
          <label>
            <span>批量模型</span>
            <input
              list="project-agent-model-options"
              value={batchModel}
              onChange={(event) => setBatchModel(event.target.value)}
              placeholder="输入或选择模型 ID"
              aria-label="批量模型"
              disabled={saving}
            />
          </label>
          <button
            type="button"
            className="agent-model-apply-button"
            onClick={() => void applyBatch()}
            disabled={
              saving ||
              !batchModel.trim() ||
              selectedRoles.length === 0
            }
          >
            同时应用到已选
          </button>
        </div>

        <datalist id="project-agent-model-options">
          {modelOptions.map((model) => (
            <option value={model} key={model} />
          ))}
        </datalist>

        <div className="agent-model-edit-list">
          {agentNames.map((role) => {
            const template = templateFor(role);
            const meta = agentMeta(role, template);
            const selected = selectedRoles.includes(role);
            const changed = roleChanged(role);
            const skillConfig = {
              skills: draftSkills[role],
              autoSkills: draftAutoSkills[role]
            };
            const selectedSkillIds = [
              ...draftSkills[role],
              ...draftAutoSkills[role]
            ];
            const harness = harnessForRole(role);
            const capabilities = harness?.capabilities;
            const skillsSupported = capabilities?.skills !== false;
            const autoSkillsSupported = skillsSupported && capabilities?.autoSkills !== false;
            const mcpSupported = capabilities?.mcp !== false;
            const webSearchSupported = capabilities?.webSearch !== false;
            const allPermissions = ["workspace", "compute", "yolo"] as const;
            const permissionOptions: AgentConfig["permission"][] = capabilities?.permissionPrompts === undefined
              ? [...allPermissions]
              : allPermissions.filter((permission) => capabilities?.permissionPrompts?.includes(permission));
            const permissionSupported = permissionOptions.includes(draftPermissions[role]);
            const gatewayReasoningOptions = reasoningOptionsForRole(role);
            return (
              <div
                className={`agent-model-edit-row ${selected ? "selected" : ""}`}
                key={role}
              >
                <input
                  type="checkbox"
                  checked={selected}
                  onChange={() => toggleRole(role)}
                  aria-label={`选择${role}`}
                  disabled={saving}
                />
                <span className={`agent-config-icon agent-${meta.color}`}>
                  <AgentIcon role={template} size={18} />
                </span>
                <span className="agent-model-edit-copy">
                  <strong>
                    {role}
                    {changed && <em>已修改</em>}
                  </strong>
                  <small>模板：{template} · {meta.description}</small>
                </span>
                <label className="agent-runtime-config-control">
                  <span>模型</span>
                  <input
                    list="project-agent-model-options"
                    value={draftModels[role]}
                    onChange={(event) => {
                      const model = event.target.value;
                      setDraftModels((current) => ({ ...current, [role]: model }));
                      setDraftGatewayReasoningOptions((current) => ({
                        ...current,
                        [role]: reasoningOptionsForRole(role, model).some(
                          (option) => option.id === current[role]
                        ) ? current[role] : undefined
                      }));
                    }}
                    maxLength={200}
                    aria-label={`${role}模型`}
                    disabled={saving}
                  />
                </label>
                {(gatewayReasoningOptions.length > 0 || draftGatewayReasoningOptions[role]) && <label className="agent-runtime-config-control">
                  <span>网关思考强度</span>
                  <select
                    value={draftGatewayReasoningOptions[role] ?? ""}
                    onChange={(event) => setDraftGatewayReasoningOptions((current) => ({
                      ...current,
                      [role]: event.target.value || undefined
                    }))}
                    aria-label={`${role}网关思考强度`}
                    disabled={saving}
                  >
                    <option value="">模型 / 网关默认（不发送字段）</option>
                    {draftGatewayReasoningOptions[role] && !gatewayReasoningOptions.some((option) => option.id === draftGatewayReasoningOptions[role]) && <option value={draftGatewayReasoningOptions[role]} disabled>{draftGatewayReasoningOptions[role]} · 已失效</option>}
                    {gatewayReasoningOptions.map((option) => <option key={option.id} value={option.id}>
                      {option.label} · {option.value}
                    </option>)}
                  </select>
                </label>}
                <label className="agent-runtime-config-control">
                  <span>
                    <ShieldCheck size={13} />
                    运行权限
                  </span>
                  <select
                    value={draftPermissions[role]}
                    onChange={(event) =>
                      setDraftPermissions((current) => ({
                        ...current,
                        [role]: event.target.value as AgentConfig["permission"]
                      }))
                    }
                    aria-label={`${role}运行权限`}
                    disabled={saving || !permissionOptions.length}
                  >
                    {!permissionSupported && <option value={draftPermissions[role]} disabled>{draftPermissions[role]} · 当前 Harness 不支持</option>}
                    {permissionOptions.map((permission) => <option value={permission} key={permission}>{agentPermissionLabel(permission)}</option>)}
                  </select>
                  {permissionOptions.length < allPermissions.length && <small>{permissionOptions.length ? `当前 Harness 支持 ${permissionOptions.length} 档权限` : "当前 Harness 未声明可用权限"}</small>}
                </label>
                <div className="agent-runtime-config-control agent-runtime-web-search">
                  <span>
                    <Globe2 size={13} />
                    Web Search
                  </span>
                  <label className="agent-binary-toggle">
                    <input
                      type="checkbox"
                      checked={draftWebSearch[role]}
                      onChange={(event) =>
                        setDraftWebSearch((current) => ({
                          ...current,
                          [role]: event.target.checked
                        }))
                      }
                      aria-label={`${role} Web Search`}
                      disabled={saving || !webSearchSupported}
                    />
                    <i aria-hidden="true" />
                    <strong>{!webSearchSupported ? "当前 Harness 不支持" : draftWebSearch[role] ? "开启" : "关闭"}</strong>
                  </label>
                </div>
                <button
                  type="button"
                  className="agent-model-row-apply"
                  onClick={() => void applyOne(role)}
                  disabled={saving || !draftModels[role].trim() || !changed}
                >
                  {changed ? "应用到该 Agent" : "当前配置"}
                </button>
                <div className="agent-runtime-config-details">
                  <div className="agent-runtime-prompt-control">
                    {role === SYSTEM_CONTROLLER_AGENT && (
                      <div className="main-system-prompt-field">
                        <span className="agent-prompt-label">
                          <span>
                            <FileText size={14} />
                            系统固定 Prompt
                          </span>
                          <em>只读</em>
                        </span>
                        <textarea
                          value={mainSystemPrompt || "Main 的固定调度协议将在服务连接后显示。"}
                          readOnly
                          rows={7}
                          aria-label="Main 系统固定 Prompt"
                        />
                        <small>该协议由系统强制注入，用户不能修改。</small>
                      </div>
                    )}
                    <span className="agent-prompt-label">
                      <span>
                        <FileText size={14} />
                        完整 Agent Prompt
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          setDraftInstructions((current) => ({
                            ...current,
                            [role]: defaultPromptFor(role)
                          }))
                        }
                        disabled={
                          saving ||
                          !defaultPromptFor(role) ||
                          draftInstructions[role] === defaultPromptFor(role)
                        }
                      >
                        <RotateCcw size={13} />
                        恢复自带 Prompt
                      </button>
                    </span>
                    <textarea
                      value={draftInstructions[role]}
                      onChange={(event) =>
                        setDraftInstructions((current) => ({
                          ...current,
                          [role]: event.target.value
                        }))
                      }
                      rows={6}
                      maxLength={20_000}
                      aria-label={`${role}自定义 Prompt`}
                      disabled={saving}
                    />
                    <small>
                      {draftInstructions[role].length.toLocaleString()} / 20,000
                      字符
                    </small>
                    <AgentToolRecommendation agentId={role} instructions={draftInstructions[role]}
                      disabled={saving} applyNotice="已填入当前 Agent 的工具草稿，点击应用保存。" />
                  </div>

                  <div className="agent-runtime-side-controls">
                    <div className="agent-runtime-skills-control">
                      <span>
                        <Layers3 size={14} />
                        Skills
                      </span>
                      <details className="skill-picker" aria-disabled={!skillsSupported}>
                      <summary>
                        {!skillsSupported
                          ? "当前 Harness 不支持"
                          : selectedSkillIds.length
                          ? `已添加 ${selectedSkillIds.length} 项`
                          : "添加 Skill"}
                      </summary>
                      <div className="skill-menu">
                        <div className="user-skill-create-row">
                          <button
                            type="button"
                            onClick={() => {
                              setSkillInputNotices((current) => ({
                                ...current,
                                [role]: ""
                              }));
                              setSkillDialogRole(role);
                            }}
                            disabled={saving || !skillsSupported}
                          >
                            <Plus size={14} />
                            添加新 Skill
                          </button>
                          <small>填写标题与内容，保存为 SKILL.md</small>
                          {skillInputNotices[role] && (
                            <small
                              className="user-skill-feedback success"
                              role="status"
                            >
                              {skillInputNotices[role]}
                            </small>
                          )}
                        </div>
                        {availableSkills.length ? (
                          availableSkills.map((skill) => {
                            const mode = agentSkillMode(skillConfig, skill.id);
                            const checked = mode !== undefined;
                            return (
                              <div className="skill-option" key={skill.id}>
                                <label className="skill-option-check">
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    disabled={saving || !skillsSupported}
                                    onChange={() =>
                                      setDraftSkillMode(
                                        role,
                                        skill.id,
                                        checked ? undefined : "fixed"
                                      )
                                    }
                                  />
                                  <span
                                    className={`check-box ${checked ? "checked" : ""}`}
                                  >
                                    {checked && <Check size={13} />}
                                  </span>
                                  <span>
                                    <strong>{skill.name}</strong>
                                    {skill.description && (
                                      <small>{skill.description}</small>
                                    )}
                                  </span>
                                </label>
                                {checked && (
                                  <select
                                    className="skill-load-mode"
                                    value={mode}
                                    disabled={saving || !skillsSupported}
                                    onChange={(event) =>
                                      setDraftSkillMode(
                                        role,
                                        skill.id,
                                        event.target.value as "fixed" | "auto"
                                      )
                                    }
                                    aria-label={`${role}${skill.name}加载方式`}
                                  >
                                    <option value="fixed">固定加载</option>
                                    <option value="auto" disabled={!autoSkillsSupported}>自动选择</option>
                                  </select>
                                )}
                              </div>
                            );
                          })
                        ) : (
                          <div className="skill-empty">暂无可添加的 Skills</div>
                        )}
                      </div>
                      </details>
                      {!skillsSupported && <small>当前 Harness 不支持 Skills</small>}
                      {skillsSupported && !autoSkillsSupported && <small>当前 Harness 不支持 Auto Skills，仅可固定加载</small>}
                      {selectedSkillIds.length > 0 && (
                        <div className="selected-skills compact">
                          {selectedSkillIds.map((skillId) => (
                            <div className="selected-skill-chip" key={skillId}>
                              <span>
                                {availableSkills.find((item) => item.id === skillId)?.name ??
                                  skillId}
                              </span>
                              <em>
                                {agentSkillMode(skillConfig, skillId) === "fixed"
                                  ? "固定"
                                  : "自动"}
                              </em>
                              <button
                                type="button"
                                onClick={() =>
                                  setDraftSkillMode(role, skillId, undefined)
                                }
                                disabled={saving}
                                aria-label={`移除 ${skillId}`}
                              >
                                ×
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    <McpServerControl
                      agentName={meta.name}
                      selected={draftMcpServers[role]}
                      options={availableMcpServers}
                      systemOptions={mcpDirectory}
                      disabled={saving || !mcpSupported}
                      onAdd={(name, url) => addMcpForRole(role, name, url)}
                      onToggle={(server, enabled) =>
                        toggleMcpForRole(role, server, enabled)
                      }
                    />
                    {!mcpSupported && <small>当前 Harness 不支持 MCP</small>}
                    <ExperimentMcpControl agentName={role} selected={draftExperimentMcp[role]}
                      disabled={saving || !mcpSupported}
                      onChange={selected => setDraftExperimentMcp(current => ({ ...current, [role]: selected }))} />
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {skillDialogRole && (
          <CreateSkillDialog
            agentName={agentMeta(
              skillDialogRole,
              templateFor(skillDialogRole)
            ).name}
            onClose={() => setSkillDialogRole(undefined)}
            onCreate={(title, content) =>
              addSkillForRole(skillDialogRole, title, content)
            }
          />
        )}

        <p className="agent-model-effective-note">
          固定 Skill 会在每次调用中读取；自动 Skill 由 Agent 按任务选择；已启用 MCP 会在调用启动时连接。已经启动的调用保持启动时配置，新配置从下一次调用开始生效。
        </p>
        {notice && (
          <span className="agent-model-dialog-success" role="status">
            <CheckCircle2 size={14} />
            {notice}
          </span>
        )}
        {error && (
          <span className="agent-model-dialog-error" role="alert">
            {error}
          </span>
        )}
        <div className="dialog-actions">
          <Button
            type="button"
            variant="secondary"
            onClick={onClose}
            disabled={saving}
          >
            完成
          </Button>
        </div>
      </div>
    </div>
    </RecommendationProvider>
  );
}

interface CanonicalTraceEvent {
  schemaVersion: 1;
  eventId: string;
  invocationId: string;
  harnessId: string;
  kind: string;
  sourceType?: string;
  attempt?: number;
  itemId?: string;
  parentItemId?: string;
  message?: string;
  messageTruncated?: boolean;
  tool?: {
    callId: string;
    name: string;
    status: "started" | "updated" | "completed" | "failed";
    input?: unknown;
    outputPreview?: string;
    truncated?: boolean;
    isError?: boolean;
  };
  diagnostic?: {
    source?: string;
    level?: string;
    message?: string;
  };
}

function canonicalTraceEvent(event: AgentEvent): CanonicalTraceEvent | undefined {
  const value = event.data?.canonicalEvent;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    typeof record.eventId !== "string" ||
    typeof record.invocationId !== "string" ||
    typeof record.harnessId !== "string" ||
    typeof record.kind !== "string"
  ) return undefined;
  const rawTool = record.tool;
  const toolRecord = rawTool && typeof rawTool === "object" && !Array.isArray(rawTool)
    ? rawTool as Record<string, unknown>
    : undefined;
  const status = toolRecord?.status;
  const tool: CanonicalTraceEvent["tool"] = toolRecord &&
    typeof toolRecord.callId === "string" &&
    typeof toolRecord.name === "string" &&
    (status === "started" || status === "updated" || status === "completed" || status === "failed")
      ? {
          callId: toolRecord.callId,
          name: toolRecord.name,
          status,
          ...(toolRecord.input === undefined ? {} : { input: toolRecord.input }),
          ...(typeof toolRecord.outputPreview === "string" ? { outputPreview: toolRecord.outputPreview } : {}),
          ...(toolRecord.truncated === true ? { truncated: true } : {}),
          ...(toolRecord.isError === true ? { isError: true } : {})
        }
      : undefined;
  return {
    schemaVersion: 1,
    eventId: record.eventId,
    invocationId: record.invocationId,
    harnessId: record.harnessId,
    kind: record.kind,
    ...(typeof record.sourceType === "string" ? { sourceType: record.sourceType } : {}),
    ...(typeof record.attempt === "number" ? { attempt: record.attempt } : {}),
    ...(typeof record.itemId === "string" ? { itemId: record.itemId } : {}),
    ...(typeof record.parentItemId === "string"
      ? { parentItemId: record.parentItemId }
      : {}),
    ...(typeof record.message === "string" ? { message: record.message } : {}),
    ...(record.messageTruncated === true ? { messageTruncated: true } : {}),
    ...(tool ? { tool } : {}),
    ...(record.diagnostic && typeof record.diagnostic === "object" && !Array.isArray(record.diagnostic)
      ? { diagnostic: record.diagnostic as CanonicalTraceEvent["diagnostic"] }
      : {})
  };
}

function isDiagnosticTraceEvent(event: AgentEvent): boolean {
  const canonical = canonicalTraceEvent(event);
  if (canonical?.kind === "diagnostic" || event.data?.diagnostic === true) return true;
  const source = traceDataString(event, "diagnosticSource").toLowerCase();
  if (source === "proxy" || source === "cli" || source === "adapter") return true;
  const legacyKind = traceDataString(event, "kind").toLowerCase();
  const legacyItemType = traceDataString(event, "itemType").toLowerCase();
  if (legacyKind === "stderr" || legacyKind === "diagnostic" || legacyItemType === "diagnostic") {
    return true;
  }
  return /^protocol proxy\b/i.test(event.message);
}

function eventPresentation(event: AgentEvent): {
  title: string;
  icon: React.ReactNode;
  tone: string;
} {
  const type = event.type.toLowerCase();
  const traceKind =
    typeof event.data?.kind === "string" ? event.data.kind.toLowerCase() : "";
  const canonical = canonicalTraceEvent(event);
  if (canonical?.kind === "diagnostic") {
    return { title: "运行诊断", icon: <Activity size={16} />, tone: "neutral" };
  }
  if (canonical?.kind.startsWith("tool.")) {
    return { title: "工具调用", icon: <TerminalSquare size={16} />, tone: "tool" };
  }
  if (canonical?.kind === "assistant.message" || canonical?.kind === "assistant.delta") {
    return { title: "Agent 过程摘要", icon: <BrainCircuit size={16} />, tone: "neutral" };
  }
  if (type === "main.assignment.queued") {
    return { title: "Main 正在评估当前结果并决定下一步", icon: <GitBranch size={16} />, tone: "decision" };
  }
  if (type === "main.assignment.committed") {
    const target = traceDataString(event, "target");
    const message = event.message.toLowerCase();
    const title = target === "user" || message.includes("user intervention")
      ? "Main 正在等待用户处理"
      : target === "finish" || message.includes("completed")
        ? "Main 已确认项目完成"
        : `Main 已将下一步任务交给 ${target || "指定 Agent"}`;
    return { title, icon: <GitBranch size={16} />, tone: "decision" };
  }
  if (type === "workflow.reconfigured") {
    return { title: "Workflow 已重新配置", icon: <GitBranch size={16} />, tone: "decision" };
  }
  if (type.includes("error") || type.includes("failed")) {
    return { title: "运行异常", icon: <AlertTriangle size={16} />, tone: "error" };
  }
  if (type.includes("intervention")) {
    return {
      title: type.includes("answered") ? "用户已回复" : "等待用户介入",
      icon: <MessageSquareText size={16} />,
      tone: "decision"
    };
  }
  if (type.includes("user.input")) {
    return {
      title: type.includes("delivered")
        ? "用户需求已送达 main"
        : "用户新增科研需求",
      icon: <MessageSquareText size={16} />,
      tone: "decision"
    };
  }
  if (type.includes("artifact") || type.includes("file")) {
    return { title: "研究产物已写入", icon: <FileText size={16} />, tone: "artifact" };
  }
  if (traceKind === "stderr") {
    return { title: "运行诊断", icon: <AlertTriangle size={16} />, tone: "error" };
  }
  if (traceKind === "output") {
    return { title: "智能体输出", icon: <Activity size={16} />, tone: "neutral" };
  }
  if (traceKind === "tool") {
    return { title: "工具调用", icon: <TerminalSquare size={16} />, tone: "tool" };
  }
  if (type.includes("started") || type.includes("running")) {
    return { title: "智能体开始工作", icon: <Play size={15} />, tone: "running" };
  }
  if (type.includes("completed") || type.includes("finished")) {
    return { title: "阶段任务完成", icon: <CheckCircle2 size={16} />, tone: "success" };
  }
  if (type.includes("tool")) {
    return { title: "工具调用", icon: <TerminalSquare size={16} />, tone: "tool" };
  }
  if (type.includes("decision") || type.includes("state")) {
    return { title: "流程安排更新", icon: <GitBranch size={16} />, tone: "decision" };
  }
  return { title: "过程更新", icon: <Activity size={16} />, tone: "neutral" };
}

interface AgentActivityEntry {
  kind: "activity";
  id: string;
  event: AgentEvent;
  thought?: AgentEvent;
  tools: AgentEvent[];
  displayState?: "streaming" | "process" | "final" | "incomplete";
}

interface PlainTraceEntry {
  kind: "event";
  id: string;
  event: AgentEvent;
}

export type TraceEntry = AgentActivityEntry | PlainTraceEntry;

function traceDataString(event: AgentEvent, key: string): string {
  const value = event.data?.[key];
  return typeof value === "string" ? value : "";
}

function traceDataStrings(event: AgentEvent | undefined, key: string): string[] {
  const value = event?.data?.[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : [];
}

function isThoughtEvent(event: AgentEvent): boolean {
  const canonical = canonicalTraceEvent(event);
  if (canonical?.kind === "assistant.message") return true;
  if (event.type !== "agent.trace") return false;
  const kind = traceDataString(event, "kind").toLowerCase();
  const itemType = traceDataString(event, "itemType").toLowerCase();
  return (
    kind === "message" &&
    itemType === "agent_message"
  );
}

function isHiddenReasoningTraceEvent(event: AgentEvent): boolean {
  if (canonicalTraceEvent(event)?.kind === "activity") return true;
  if (event.type !== "agent.trace") return false;
  const kind = traceDataString(event, "kind").toLowerCase();
  const itemType = traceDataString(event, "itemType").toLowerCase();
  return kind === "reasoning" || [
    "reasoning",
    "thinking",
    "redacted_thinking"
  ].includes(itemType);
}

function isAssistantDeltaEvent(event: AgentEvent): boolean {
  return canonicalTraceEvent(event)?.kind === "assistant.delta";
}

function isToolEvent(event: AgentEvent): boolean {
  if (canonicalTraceEvent(event)?.kind.startsWith("tool.")) return true;
  return (
    event.type === "agent.trace" &&
    traceDataString(event, "kind").toLowerCase() === "tool"
  );
}

function thoughtSummary(message: string): string {
  const trimmed = message.trim();
  if (!trimmed.startsWith("{")) return trimmed;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    for (const key of ["summary", "assessment", "markdown"]) {
      if (typeof parsed[key] === "string" && parsed[key].trim()) {
        return parsed[key].trim();
      }
    }
  } catch {
    // Historical plain-text traces can start with a brace; show them unchanged.
  }
  return trimmed;
}

function toolCommand(event: AgentEvent): string {
  const canonical = canonicalTraceEvent(event);
  if (canonical?.tool?.input !== undefined) {
    return typeof canonical.tool.input === "string"
      ? canonical.tool.input
      : safeStructuredPreview(canonical.tool.input);
  }
  if (canonical?.tool?.name) return canonical.tool.name;
  const structured = traceDataString(event, "command");
  if (structured) return structured;
  const status = traceDataString(event, "status");
  if (status && event.message.endsWith(` · ${status}`)) {
    return event.message.slice(0, -(status.length + 3));
  }
  return event.message.replace(/ · (?:in_progress|completed|failed|item\.(?:started|completed))$/, "");
}

function toolLabel(event: AgentEvent): string {
  const canonical = canonicalTraceEvent(event);
  if (canonical?.tool?.name) return canonical.tool.name;
  const labels: Record<string, string> = {
    command_execution: "Shell 命令",
    mcp_tool_call: "MCP 工具",
    collab_tool_call: "协作工具",
    file_change: "文件修改",
    web_search: "网页搜索"
  };
  const itemType = traceDataString(event, "itemType");
  return labels[itemType] ?? "工具调用";
}

function toolStatus(event: AgentEvent): { label: string; tone: string } {
  const status = canonicalTraceEvent(event)?.tool?.status
    ?? traceDataString(event, "status").toLowerCase();
  if (status === "completed" || status === "item.completed") {
    return { label: "完成", tone: "completed" };
  }
  if (status === "failed") return { label: "失败", tone: "failed" };
  return { label: "运行中", tone: "running" };
}

function toolOutput(event: AgentEvent): { text: string; truncated: boolean } | undefined {
  const tool = canonicalTraceEvent(event)?.tool;
  if (tool?.outputPreview === undefined) return undefined;
  return {
    text: tool.outputPreview === "" ? "（空结果）" : tool.outputPreview,
    truncated: tool.truncated === true
  };
}

function safeStructuredPreview(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function mergeCanonicalToolEvents(previous: AgentEvent, next: AgentEvent): AgentEvent {
  const previousCanonical = canonicalTraceEvent(previous);
  const nextCanonical = canonicalTraceEvent(next);
  if (!previousCanonical?.tool || !nextCanonical?.tool) return next;
  return {
    ...next,
    message: next.message || previous.message,
    data: {
      ...(previous.data ?? {}),
      ...(next.data ?? {}),
      canonicalEvent: {
        ...previousCanonical,
        ...nextCanonical,
        tool: {
          ...previousCanonical.tool,
          ...nextCanonical.tool,
          // Some official result envelopes only carry the call ID. Their
          // mappers therefore use the canonical placeholder; never let that
          // erase the real name learned from the matching start event.
          name:
            nextCanonical.tool.name === "tool" && previousCanonical.tool.name !== "tool"
              ? previousCanonical.tool.name
              : nextCanonical.tool.name,
          input: nextCanonical.tool.input ?? previousCanonical.tool.input,
          outputPreview:
            nextCanonical.tool.outputPreview ?? previousCanonical.tool.outputPreview,
          truncated:
            nextCanonical.tool.truncated ?? previousCanonical.tool.truncated
        }
      }
    }
  };
}

function activityStreamKey(event: AgentEvent): string {
  const canonical = canonicalTraceEvent(event);
  const invocationId = canonical?.invocationId
    ?? traceDataString(event, "invocationId")
    ?? "legacy";
  const itemId = canonical?.kind.startsWith("tool.")
    ? canonical.parentItemId
    : canonical?.itemId;
  return `${event.agent ?? "system"}:${invocationId || "legacy"}:${itemId || "legacy"}`;
}

function appendAssistantDelta(previous: AgentEvent | undefined, next: AgentEvent): AgentEvent {
  if (!previous) return next;
  const previousCanonical = canonicalTraceEvent(previous);
  const nextCanonical = canonicalTraceEvent(next);
  if (!previousCanonical || !nextCanonical) return next;
  const message = `${previousCanonical.message ?? previous.message}${nextCanonical.message ?? next.message}`.slice(-200_000);
  return {
    ...next,
    message,
    data: {
      ...(next.data ?? {}),
      canonicalEvent: { ...nextCanonical, message }
    }
  };
}

export function buildTraceEntries(events: AgentEvent[]): TraceEntry[] {
  const entries: TraceEntry[] = [];
  const activeGroups = new Map<string, AgentActivityEntry>();
  const activeTools = new Map<
    string,
    { entry: AgentActivityEntry; index: number }
  >();
  const groupsByInvocation = new Map<string, AgentActivityEntry[]>();
  const completedInvocations = new Set<string>();

  const createActivity = (
    event: AgentEvent,
    thought?: AgentEvent
  ): AgentActivityEntry => {
    const canonical = canonicalTraceEvent(event);
    const itemKey = canonical?.kind.startsWith("tool.") ? canonical.tool?.callId : canonical?.itemId;
    const entry: AgentActivityEntry = {
      kind: "activity",
      // Durable rows replace ephemeral rows with a different timeline seq.
      // Keep the card mounted so an expanded tool result stays expanded.
      id: canonical && itemKey
        ? `activity-${JSON.stringify([event.agent, canonical.invocationId, canonical.attempt ?? 0,
            canonical.kind.startsWith("tool.") ? "tool" : "message", itemKey])}`
        : `activity-${event.seq}`,
      event,
      thought,
      tools: []
    };
    entries.push(entry);
    activeGroups.set(activityStreamKey(event), entry);
    const invocationId = canonical?.invocationId ?? traceDataString(event, "invocationId");
    if (invocationId) {
      const key = `${event.agent ?? "system"}:${invocationId}`;
      const groups = groupsByInvocation.get(key) ?? [];
      groups.push(entry);
      groupsByInvocation.set(key, groups);
    }
    return entry;
  };

  for (const event of events) {
    // Canonical activity and historical reasoning rows are heartbeats, not
    // display content. In particular, never fall through to EventCard where
    // a legacy raw reasoning message would become visible again.
    if (isHiddenReasoningTraceEvent(event)) continue;
    const streamKey = activityStreamKey(event);
    if (isAssistantDeltaEvent(event)) {
      const group = activeGroups.get(streamKey) ?? createActivity(event);
      group.thought = appendAssistantDelta(group.thought, event);
      continue;
    }
    if (isThoughtEvent(event)) {
      const group = activeGroups.get(streamKey);
      if (group) {
        group.thought = event;
        continue;
      }
      createActivity(event, event);
      continue;
    }
    if (isToolEvent(event)) {
      const canonical = canonicalTraceEvent(event);
      const itemId = canonical?.tool?.callId ?? traceDataString(event, "itemId");
      const status = canonical?.tool?.status ?? traceDataString(event, "status").toLowerCase();
      const legacyIdentity = `${streamKey}:${traceDataString(event, "itemType")}:${toolCommand(event)}`;
      const toolIdentity = itemId ? `${streamKey}:${itemId}` : legacyIdentity;
      const activeTool = activeTools.get(toolIdentity);
      if (activeTool) {
        activeTool.entry.tools[activeTool.index] = mergeCanonicalToolEvents(
          activeTool.entry.tools[activeTool.index]!,
          event
        );
        if (status === "completed" || status === "failed") {
          activeTools.delete(toolIdentity);
        }
        continue;
      }
      let group = activeGroups.get(streamKey);
      if (!group || (!canonical?.parentItemId && group.tools.length >= 4)) {
        group = createActivity(event);
      }
      const index = group.tools.push(event) - 1;
      if (status !== "completed" && status !== "failed") {
        activeTools.set(toolIdentity, { entry: group, index });
      }
      continue;
    }

    entries.push({ kind: "event", id: `event-${event.seq}`, event });
    if (event.type === "invocation.completed" || event.type === "agent.completed") {
      const invocationId = traceDataString(event, "invocationId");
      if (invocationId) completedInvocations.add(`${event.agent ?? "system"}:${invocationId}`);
    }
    if (
      event.type === "agent.started" ||
      event.type === "agent.completed" ||
      event.type === "agent.failed"
    ) {
      activeGroups.delete(streamKey);
    }
  }
  for (const [invocationKey, groups] of groupsByInvocation) {
    for (const group of groups) {
      const data = (group.thought ?? group.event).data ?? {};
      const canonical = canonicalTraceEvent(group.thought ?? group.event);
      if (data.incompleteOutput === true || canonical?.sourceType === "assistant.incomplete") {
        group.displayState = "incomplete";
      } else if (data.liveRole === "process" || group.tools.length > 0) {
        group.displayState = "process";
      } else if (data.livePhase === "streaming") {
        group.displayState = "streaming";
      } else if (data.liveRole === "final") {
        group.displayState = "final";
      }
    }
    if (completedInvocations.has(invocationKey)) {
      const finalGroup = [...groups].reverse().find((group) =>
        Boolean(group.thought) && group.displayState !== "incomplete"
      );
      if (finalGroup && finalGroup.displayState !== "process") {
        finalGroup.displayState = "final";
      }
    }
  }
  return entries;
}

export const AgentActivityCard = memo(function AgentActivityCard({
  entry,
  projectCycle
}: {
  entry: AgentActivityEntry;
  projectCycle: number;
}) {
  const event = entry.thought ?? entry.event;
  const canonical = canonicalTraceEvent(event);
  const data = event.data ?? {};
  const cycle =
    typeof data.cycle === "number" || typeof data.cycle === "string"
      ? String(data.cycle)
      : String(projectCycle);
  const heading = entry.displayState === "streaming"
    ? "Agent 正在输出"
    : entry.displayState === "final"
      ? "Agent 最终结果"
      : entry.displayState === "incomplete"
        ? "Agent 未完成输出"
        : "Agent 过程摘要";
  const thought = entry.thought
    ? thoughtSummary(entry.thought.message)
    : "本组工具调用前没有新的过程摘要。";
  return (
    <article className="trace-event trace-action-event">
      <div className="trace-axis">
        <span><BrainCircuit size={16} /></span>
        <i />
      </div>
      <div className="trace-body">
        <div className="trace-meta">
          <time>{formatClock(event.ts)}</time>
          <span>Cycle {cycle}</span>
          <span>#{event.seq}</span>
          {canonical?.harnessId && <span className="trace-harness-tag">{canonical.harnessId}</span>}
          {event.agent && <AgentBadge role={event.agent} subtle />}
        </div>
        <div className="agent-action-row">
          <section className="agent-thought-panel">
            <header>
              <BrainCircuit size={15} />
              <strong>{heading}</strong>
              {entry.displayState === "streaming" && <span className="agent-streaming-dot" />}
            </header>
            {entry.displayState === "streaming" ? (
              <p className="agent-streaming-text">{thought}</p>
            ) : (
              <div className="agent-message-markdown">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm, remarkMath]}
                  rehypePlugins={[rehypeSanitize, rehypeKatex]}
                >
                  {thought}
                </ReactMarkdown>
              </div>
            )}
            {canonical?.messageTruncated && (
              <div className="agent-message-truncated" role="note">
                正文展示已截断至 200,000 字符；完整内容已保存到同一调用的 Handoff，
                可从右侧评审卡或对应“交接已保存”轨迹进入。
              </div>
            )}
          </section>
          <section className="agent-tools-panel">
            <header>
              <TerminalSquare size={15} />
              <strong>工具调用</strong>
              <span>{entry.tools.length}</span>
            </header>
            {entry.tools.length ? (
              <div className="agent-tool-list">
                {entry.tools.map((tool, index) => {
                  const status = toolStatus(tool);
                  const command = toolCommand(tool);
                  const result = toolOutput(tool);
                  const canonicalTool = canonicalTraceEvent(tool)?.tool;
                  return (
                    <div className="agent-tool-item" key={canonicalTool?.callId ?? `${tool.seq}-${index}`} data-tool-status={canonicalTool?.status ?? status.tone}>
                      <div>
                        <strong>{toolLabel(tool)}</strong>
                        <span className={`tool-status tool-status-${status.tone}`}>
                          {status.label}
                        </span>
                      </div>
                      <code title={command}>{command || "等待工具详情"}</code>
                      {result && (
                        <details className="agent-tool-result">
                          <summary>
                            查看工具结果
                            {result.truncated && <span>已截断至 40,000 字符</span>}
                          </summary>
                          <pre>{result.text}</pre>
                        </details>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="agent-tools-empty">当前摘要后尚未调用工具。</p>
            )}
          </section>
        </div>
      </div>
    </article>
  );
}, (previous, next) => {
  if (previous.projectCycle !== next.projectCycle) return false;
  if (
    previous.entry.displayState !== next.entry.displayState ||
    previous.entry.event.seq !== next.entry.event.seq ||
    previous.entry.thought?.seq !== next.entry.thought?.seq ||
    previous.entry.thought?.message !== next.entry.thought?.message ||
    previous.entry.tools.length !== next.entry.tools.length
  ) {
    return false;
  }
  return previous.entry.tools.every((tool, index) => {
    const nextTool = next.entry.tools[index]!;
    if (tool === nextTool) return true;
    if (tool.seq !== nextTool.seq || tool.message !== nextTool.message) return false;
    const before = canonicalTraceEvent(tool)?.tool;
    const after = canonicalTraceEvent(nextTool)?.tool;
    return before?.name === after?.name && before?.status === after?.status &&
      before?.input === after?.input && before?.outputPreview === after?.outputPreview &&
      before?.truncated === after?.truncated && before?.isError === after?.isError;
  });
});

const EventCard = memo(function EventCard({ event, projectCycle }: { event: AgentEvent; projectCycle: number }) {
  const presentation = eventPresentation(event);
  const data = event.data ?? {};
  const detail =
    data.path ??
    data.tool ??
    data.toolName ??
    (event.type === "main.assignment.committed" ? data.target : undefined) ??
    data.band;
  const cycle =
    typeof data.cycle === "number" || typeof data.cycle === "string"
      ? String(data.cycle)
      : String(projectCycle);
  const performance = normalizeInvocationPerformance(data.performance);
  return (
    <article className={`trace-event trace-${presentation.tone}`}>
      <div className="trace-axis">
        <span>{presentation.icon}</span>
        <i />
      </div>
      <div className="trace-body">
        <div className="trace-meta">
          <time>{formatClock(event.ts)}</time>
          <span>Cycle {cycle}</span>
          <span>#{event.seq}</span>
        </div>
        <div className="trace-title-row">
          <strong>{presentation.title}</strong>
          {event.agent && <AgentBadge role={event.agent} subtle />}
        </div>
        <p>{event.message || "状态已更新，等待下一步调度。"}</p>
        {detail !== undefined && detail !== "" && (
          <span className="trace-detail">
            <Code2 size={13} />
            {String(detail)}
          </span>
        )}
        {performance && (
          <div className="trace-performance" aria-label="单次调用性能">
            <PerformanceMetrics performance={performance} />
            <small>
              Attempt {performance.attempt + 1} · 输出 {performance.outputTokens.toLocaleString()} tokens ·
              {performance.tokenSource === "official" ? " Provider usage" : " 本地估算"}
              {performance.streaming ? " · 真实流式" : " · 缓冲/非流式"}
            </small>
          </div>
        )}
      </div>
    </article>
  );
});

function liveAssistantEvent(stream: LiveAssistantStream, index: number): AgentEvent {
  const streaming = stream.phase === "streaming";
  return {
    seq: 9_000_000_000 + stream.attempt * 10_000 + index,
    type: "agent.trace",
    agent: stream.agent,
    message: stream.content,
    ts: stream.updatedAt,
    data: {
      kind: "message",
      invocationId: stream.invocationId,
      livePhase: stream.phase,
      liveRole: stream.role,
      canonicalEvent: {
        schemaVersion: 1,
        eventId: `${stream.invocationId}:live:${stream.attempt}:${stream.itemId}`,
        invocationId: stream.invocationId,
        harnessId: stream.harnessId,
        kind: streaming ? "assistant.delta" : "assistant.message",
        attempt: stream.attempt,
        itemId: stream.itemId,
        sourceType: "live.assistant",
        message: stream.content,
        ...(stream.truncated ? { messageTruncated: true } : {})
      }
    }
  };
}

function canScrollTraceHistory(container: HTMLElement | null, target: EventTarget | null): boolean {
  if (!container || container.scrollTop <= 0) return false;
  // Let an inner code/result panel consume its own scroll before treating
  // the gesture as navigation in the outer trace.
  for (let element = target instanceof Element ? target : null;
    element && element !== container; element = element.parentElement) {
    if (element.scrollTop > 0 && element.scrollHeight > element.clientHeight &&
      /^(auto|scroll)$/.test(window.getComputedStyle(element).overflowY)) return false;
  }
  return true;
}

export const TraceView = memo(function TraceView({
  events,
  liveStreams,
  liveEvents,
  project,
  connection,
  totalEventCount,
  hasOlder,
  historyLoading,
  historyError,
  onLoadOlder
}: {
  events: AgentEvent[];
  liveStreams: LiveAssistantStream[];
  liveEvents: AgentEvent[];
  project: Project;
  connection: ConnectionState;
  totalEventCount: number;
  hasOlder: boolean;
  historyLoading: boolean;
  historyError: string;
  onLoadOlder: () => Promise<void>;
}) {
  const [agentFilter, setAgentFilter] = useState<"all" | AgentName>("all");
  const [displayLimit, setDisplayLimit] = useState<TraceDisplayLimit>(
    DEFAULT_TRACE_DISPLAY_LIMIT
  );
  const [search, setSearch] = useState("");
  const [follow, setFollow] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(follow);
  const autoScrollRef = useRef(false);
  const scrollFrameRef = useRef<number | null>(null);
  const touchStartYRef = useRef<number | null>(null);

  useEffect(() => {
    followRef.current = follow;
  }, [follow]);

  const matchingEvents = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return events.filter(
      (event) =>
        !isHiddenReasoningTraceEvent(event) &&
        (agentFilter === "all" || event.agent === agentFilter) &&
        (!keyword ||
          event.message.toLowerCase().includes(keyword) ||
          event.type.toLowerCase().includes(keyword))
    );
  }, [agentFilter, events, search]);
  const matchingDiagnosticEvents = useMemo(
    () => matchingEvents.filter(isDiagnosticTraceEvent),
    [matchingEvents]
  );
  const matchingPrimaryEvents = useMemo(
    () => matchingEvents.filter((event) => !isDiagnosticTraceEvent(event)),
    [matchingEvents]
  );
  const diagnosticEvents = useMemo(
    () => matchingDiagnosticEvents.slice(-displayLimit),
    [displayLimit, matchingDiagnosticEvents]
  );
  const primaryEvents = useMemo(
    () => matchingPrimaryEvents.slice(-displayLimit),
    [displayLimit, matchingPrimaryEvents]
  );
  const liveAssistantEvents = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return liveStreams
      .filter((stream) =>
        (agentFilter === "all" || stream.agent === agentFilter) &&
        (!keyword || stream.content.toLowerCase().includes(keyword))
      )
      .map(liveAssistantEvent);
  }, [agentFilter, liveStreams, search]);
  const entries = useMemo(
    () => buildTraceEntries([
      ...primaryEvents,
      ...[...liveEvents, ...liveAssistantEvents].sort((left, right) =>
        left.ts.localeCompare(right.ts) || left.seq - right.seq
      )
    ]),
    [liveAssistantEvents, liveEvents, primaryEvents]
  );
  const visibleEventCount = primaryEvents.length + diagnosticEvents.length;
  const latestVisibleSeq = Math.max(
    primaryEvents.at(-1)?.seq ?? 0,
    diagnosticEvents.at(-1)?.seq ?? 0
  );
  // The live snapshot is sorted by timestamp, but more than one invocation
  // can be active at once. Looking only at the last stream misses a delta
  // that belongs to an older stream, and live tool events are not streams at
  // all. Track a compact version of every live item so any visible update can
  // keep the viewport pinned while follow mode is enabled.
  const liveStreamVersion = liveStreams
    .map((stream) =>
      [
        stream.invocationId,
        stream.attempt,
        stream.itemId,
        stream.phase,
        stream.role,
        stream.updatedAt,
        stream.content.length
      ].join(":"))
    .join("|");
  const liveEventVersion = liveEvents
    .map((event) =>
      [event.seq, event.ts, event.type, event.message.length].join(":")
    )
    .join("|");

  const scrollToBottom = useCallback(() => {
    if (!followRef.current || !scrollRef.current) return;
    if (scrollFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollFrameRef.current);
      scrollFrameRef.current = null;
    }

    autoScrollRef.current = true;
    let remainingFrames = 2;
    const settle = () => {
      const container = scrollRef.current;
      if (!container || !followRef.current) {
        autoScrollRef.current = false;
        scrollFrameRef.current = null;
        return;
      }

      container.scrollTop = Math.max(
        0,
        container.scrollHeight - container.clientHeight
      );
      if (remainingFrames > 0) {
        remainingFrames -= 1;
        scrollFrameRef.current = window.requestAnimationFrame(settle);
        return;
      }

      // Markdown/content-visibility can settle one frame after React has
      // committed. Do one final bottom assignment before releasing the
      // programmatic scroll guard.
      scrollFrameRef.current = window.requestAnimationFrame(() => {
        const latest = scrollRef.current;
        if (latest && followRef.current) {
          latest.scrollTop = Math.max(
            0,
            latest.scrollHeight - latest.clientHeight
          );
        }
        scrollFrameRef.current = null;
        autoScrollRef.current = false;
      });
    };

    scrollFrameRef.current = window.requestAnimationFrame(settle);
  }, []);

  const pauseFollowing = useCallback(() => {
    followRef.current = false;
    setFollow(false);
    if (scrollFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollFrameRef.current);
      scrollFrameRef.current = null;
    }
    autoScrollRef.current = false;
  }, []);

  const pauseForHistoryNavigation = useCallback((target: EventTarget | null) => {
    if (followRef.current && canScrollTraceHistory(scrollRef.current, target)) pauseFollowing();
  }, [pauseFollowing]);

  const keepFollowingAfterLayoutScroll = useCallback(() => {
    const container = scrollRef.current;
    // Focus restoration, scroll anchoring and viewport/content resizing also
    // emit scroll events. Only explicit navigation gestures may pause follow.
    if (!container || autoScrollRef.current || !followRef.current) return;
    if (container.scrollHeight - container.scrollTop - container.clientHeight > 1) scrollToBottom();
  }, [scrollToBottom]);

  const toggleFollow = useCallback(() => {
    setFollow((current) => {
      const next = !current;
      followRef.current = next;
      return next;
    });
  }, []);

  useEffect(() => {
    if (
      displayLimit > events.length &&
      hasOlder &&
      !historyLoading
    ) {
      void onLoadOlder();
    }
  }, [displayLimit, events.length, hasOlder, historyLoading, onLoadOlder]);

  useEffect(() => {
    if (!follow) {
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
      autoScrollRef.current = false;
      return;
    }
    if (!entries.length && !diagnosticEvents.length) return;
    scrollToBottom();
  }, [
    agentFilter,
    diagnosticEvents.length,
    displayLimit,
    entries.length,
    follow,
    liveEventVersion,
    liveStreamVersion,
    latestVisibleSeq,
    search,
    scrollToBottom
  ]);

  useEffect(() => {
    return () => {
      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
      }
      scrollFrameRef.current = null;
      autoScrollRef.current = false;
    };
  }, []);

  useEffect(() => {
    // ResizeObserver catches the delayed height change caused by streamed
    // Markdown and `content-visibility`, which can happen after the React
    // commit/effect that scheduled the initial scroll. Observe the viewport
    // too: opening a dialog or resizing the page can change its dimensions.
    const container = scrollRef.current;
    const content = container?.querySelector<HTMLElement>(".trace-list");
    if (!container || !content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (followRef.current) scrollToBottom();
    });
    observer.observe(content);
    observer.observe(container);
    return () => observer.disconnect();
  }, [
    entries.length,
    diagnosticEvents.length,
    liveEventVersion,
    liveStreamVersion,
    scrollToBottom
  ]);

  const loadedHistorySuffix =
    totalEventCount > events.length
      ? ` · 已加载 ${events.length.toLocaleString()} / 全部 ${totalEventCount.toLocaleString()}`
      : "";
  const allEventsSuffix =
    matchingEvents.length !== events.length
      ? ` · 当前已加载范围 ${events.length.toLocaleString()}`
      : loadedHistorySuffix;
  const eventCountLabel =
    matchingEvents.length > visibleEventCount
      ? `显示最新 ${visibleEventCount.toLocaleString()} / ${matchingEvents.length.toLocaleString()} 条${allEventsSuffix}`
      : `${visibleEventCount.toLocaleString()} 条事件${allEventsSuffix}`;

  return (
    <div className="trace-view">
      <div className="trace-toolbar">
        <div className="trace-status">
          <ConnectionBadge state={connection} />
          <span>{eventCountLabel}</span>
        </div>
        <div className="trace-tools">
          <label className="compact-search">
            <Search size={15} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索轨迹"
            />
          </label>
          <label className="compact-select">
            <Filter size={14} />
            <select
              value={agentFilter}
              onChange={(event) =>
                setAgentFilter(event.target.value as "all" | AgentName)
              }
              aria-label="按智能体筛选"
            >
              <option value="all">全部 Agent</option>
              {project.orchestration.agents.map((definition) => (
                <option value={definition.name} key={definition.name}>
                  {definition.name} · {agentTemplateFor(project.orchestration, definition.name)}
                </option>
              ))}
              {[...new Set((project.archivedAgentSessions ?? []).map(entry => entry.agentId))]
                .filter(agent => !project.orchestration.agents.some(definition => definition.name === agent))
                .map(agent => <option value={agent} key={agent}>{agent} · 已退役{project.archivedAgentSessions?.some(entry => entry.agentId === agent && entry.sessionCount > 0) ? "（原会话保留）" : ""}</option>)}
            </select>
          </label>
          <label
            className="compact-select trace-limit-select"
            title="控制前端显示的最新轨迹条数"
          >
            <Clock3 size={14} />
            <select
              value={displayLimit}
              onChange={(event) =>
                setDisplayLimit(
                  Number(event.target.value) as TraceDisplayLimit
                )
              }
              aria-label="显示最新轨迹条数"
            >
              {TRACE_DISPLAY_LIMITS.map((limit) => (
                <option value={limit} key={limit}>
                  最新 {limit.toLocaleString()} 条
                </option>
              ))}
            </select>
          </label>
          <button
            className={`follow-button ${follow ? "active" : ""}`}
            onClick={toggleFollow}
            aria-pressed={follow}
            title="自动跟随最新事件"
          >
            <Radio size={14} />
            跟随
          </button>
        </div>
      </div>
      {(hasOlder || historyError) && (
        <div className="trace-history-loader">
          {hasOlder && (
            <Button
              variant="ghost"
              loading={historyLoading}
              onClick={() => void onLoadOlder()}
            >
              加载更早 1,000 条轨迹
            </Button>
          )}
          {historyError && <span role="alert">{historyError}</span>}
        </div>
      )}
      <div
        className="trace-scroll"
        ref={scrollRef}
        role="region"
        aria-label="实时轨迹内容"
        tabIndex={0}
        onScroll={keepFollowingAfterLayoutScroll}
        onWheel={(event) => {
          if (!event.defaultPrevented && !event.ctrlKey && event.deltaY < 0) pauseForHistoryNavigation(event.target);
        }}
        onKeyDown={(event) => {
          if (event.defaultPrevented || event.altKey || event.metaKey ||
            (event.target instanceof Element && event.target.closest("input, textarea, select, button, a, summary, [contenteditable]:not([contenteditable='false'])"))) return;
          if (["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey)) pauseForHistoryNavigation(event.target);
        }}
        onTouchStart={(event) => { touchStartYRef.current = event.touches.length === 1 ? event.touches[0]?.clientY ?? null : null; }}
        onTouchMove={(event) => {
          if (event.touches.length !== 1) { touchStartYRef.current = null; return; }
          const currentY = event.touches[0]?.clientY;
          if (!event.defaultPrevented && currentY !== undefined && touchStartYRef.current !== null &&
            currentY > touchStartYRef.current + 4) pauseForHistoryNavigation(event.target);
        }}
        onTouchEnd={() => { touchStartYRef.current = null; }}
        onTouchCancel={() => { touchStartYRef.current = null; }}
        onPointerDown={(event) => {
          if (event.button !== 0 || event.pointerType !== "mouse" || event.target !== event.currentTarget) return;
          const container = event.currentTarget, bounds = container.getBoundingClientRect();
          const gutter = Math.max(12, container.offsetWidth - container.clientWidth);
          if (bounds.width > 0 && container.scrollHeight > container.clientHeight &&
            event.clientX >= bounds.right - gutter && followRef.current) pauseFollowing();
        }}
      >
        {entries.length || diagnosticEvents.length ? (
          <div className="trace-list">
            {entries.map((entry) => (
              entry.kind === "activity" ? (
                <AgentActivityCard
                  entry={entry}
                  projectCycle={project.cycle}
                  key={entry.id}
                />
              ) : (
                <EventCard
                  event={entry.event}
                  projectCycle={project.cycle}
                  key={entry.id}
                />
              )
            ))}
            {diagnosticEvents.length > 0 && (
              <details className="trace-diagnostics">
                <summary>
                  <Activity size={14} />
                  运行诊断
                  <span>{diagnosticEvents.length}</span>
                </summary>
                <div className="trace-diagnostic-list">
                  {diagnosticEvents.map((event) => (
                    <EventCard
                      event={event}
                      projectCycle={project.cycle}
                      key={`diagnostic-${event.seq}`}
                    />
                  ))}
                </div>
              </details>
            )}
            {connection === "live" && project.status === "running" && (
              <div className="trace-waiting">
                <span><i /><i /><i /></span>
                等待智能体的下一条更新
              </div>
            )}
          </div>
        ) : (
          <EmptyState
            icon={<Activity size={27} />}
            title={events.length ? "没有匹配的轨迹" : "等待第一条 Agent 轨迹"}
            description={
              events.length
                ? "调整搜索词或 Agent 筛选条件。"
                : "项目启动后，Idea Agent 的动作会实时出现在这里。"
            }
          />
        )}
      </div>
    </div>
  );
});

function ArtifactViewer({
  projectId,
  artifact,
  loading,
  error,
  onClose,
  onVariantChange
}: {
  projectId: string;
  artifact?: Artifact | ArtifactContent;
  loading: boolean;
  error: string;
  onClose?: () => void;
  onVariantChange?: (artifact: Artifact) => void;
}) {
  const [mode, setMode] = useState<"preview" | "source">("preview");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setMode("preview");
    setCopied(false);
  }, [artifact?.agent, artifact?.origin, artifact?.path, artifact?.workspaceId, artifact?.id, artifact?.commitSha]);

  const copy = async () => {
    if (!artifact || !("content" in artifact)) return;
    await navigator.clipboard.writeText(artifact.content);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const download = () => {
    if (!artifact) return;
    const url = getArtifactDownloadUrl(projectId, artifact);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = artifact.name;
    anchor.click();
  };

  if (loading) return <PageLoader label="正在读取研究产物…" />;
  if (error) return <ErrorPanel title="产物读取失败" message={error} />;
  if (!artifact) {
    return (
      <EmptyState
        icon={<FileText size={27} />}
        title="选择一份研究产物"
        description="可查看 Markdown 渲染结果或 LaTeX 原始源码。"
      />
    );
  }

  const previewKind = artifactPreviewKind(artifact);
  const canReadContent =
    previewKind === "markdown" ||
    previewKind === "json" ||
    previewKind === "csv" ||
    previewKind === "text";
  const hasContent = "content" in artifact;
  const resourceUrl = getArtifactViewUrl(projectId, artifact);
  const formattedContent =
    hasContent && previewKind === "json"
      ? (() => {
          try {
            return JSON.stringify(JSON.parse(artifact.content), null, 2);
          } catch {
            return artifact.content;
          }
        })()
      : hasContent
        ? artifact.content
        : "";
  return (
    <div className="artifact-viewer">
      <div className="artifact-viewer-head">
        <div>
          {artifact.kind === "latex" ? <FileCode2 size={18} /> : <FileText size={18} />}
          <span>
            <strong>{artifact.name}</strong>
            <small>{artifact.path}</small>
          </span>
        </div>
        <div className="artifact-head-actions">
          {artifact.variants && artifact.variants.length > 1 && onVariantChange && <label className="artifact-source-picker">
            文件来源
            <select aria-label="选择文件来源" value={artifactKey(artifact)} onChange={event => {
              const variant = artifact.variants?.find(item => artifactKey(item) === event.target.value);
              if (variant) onVariantChange({ ...variant, variants: artifact.variants });
            }}>
              {artifact.variants.map(variant => <option key={artifactKey(variant)} value={artifactKey(variant)}>
                {variant.workspaceLabel ?? (variant.commitSha ? "已发布版本" : "共享工作区")}{variant.commitSha ? ` · ${variant.agent ?? ""} · ${variant.commitSha.slice(0, 8)}` : ""}
              </option>)}
            </select>
          </label>}
          {previewKind === "markdown" && (
            <div className="mode-toggle">
              <button
                className={mode === "preview" ? "active" : ""}
                onClick={() => setMode("preview")}
              >
                <Eye size={14} /> 预览
              </button>
              <button
                className={mode === "source" ? "active" : ""}
                onClick={() => setMode("source")}
              >
                <Code2 size={14} /> 源码
              </button>
            </div>
          )}
          <button onClick={() => void copy()} title="复制内容" disabled={!hasContent}>
            {copied ? <Check size={16} /> : <Clipboard size={16} />}
          </button>
          <button onClick={download} title="下载产物"><Download size={16} /></button>
          {onClose && (
            <button onClick={onClose} title="关闭预览"><X size={17} /></button>
          )}
        </div>
      </div>
      <div className="artifact-document">
        {previewKind === "markdown" && mode === "preview" && hasContent ? (
          <div className="markdown-body">
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkMath]}
              rehypePlugins={[rehypeSanitize, rehypeKatex]}
              components={{
                a: ({ children, ...props }) => (
                  <a {...props} target="_blank" rel="noreferrer">
                    {children}
                  </a>
                )
              }}
            >
              {artifact.content}
            </ReactMarkdown>
          </div>
        ) : previewKind === "image" ? (
          <div className="artifact-media-preview">
            <img src={resourceUrl} alt={artifact.name} />
          </div>
        ) : previewKind === "pdf" ? (
          <iframe title={artifact.name} src={resourceUrl} className="artifact-media-frame" />
        ) : previewKind === "html" ? (
          <iframe title={artifact.name} src={resourceUrl} className="artifact-media-frame" sandbox="allow-same-origin" />
        ) : previewKind === "audio" ? (
          <div className="artifact-media-preview"><audio controls src={resourceUrl} /></div>
        ) : previewKind === "video" ? (
          <div className="artifact-media-preview"><video controls src={resourceUrl} /></div>
        ) : previewKind === "csv" && hasContent ? (
          <CsvPreview content={artifact.content} />
        ) : canReadContent && hasContent ? (
          <pre className={`source-code ${artifact.kind === "latex" ? "latex-source" : ""}`}>
            <code>{formattedContent}</code>
          </pre>
        ) : (
          <div className="artifact-download-placeholder">
            <FileText size={24} />
            <strong>该文件不适合直接预览</strong>
            <span>可以使用右上角下载按钮获取原文件。</span>
          </div>
        )}
      </div>
    </div>
  );
}

function CsvPreview({ content }: { content: string }) {
  const lines = content.split(/\r?\n/).filter((row) => row.trim().length > 0);
  const delimiter = lines.some((row) => row.includes("\t")) ? "\t" : ",";
  const rows = lines.map((row) => {
    const cells: string[] = [];
    let cell = "";
    let quoted = false;
    for (let index = 0; index < row.length; index += 1) {
      const character = row[index];
      if (character === '"') {
        if (quoted && row[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = !quoted;
        }
      } else if (character === delimiter && !quoted) {
        cells.push(cell.trim());
        cell = "";
      } else {
        cell += character;
      }
    }
    cells.push(cell.trim());
    return cells;
  });
  if (!rows.length) return <EmptyState icon={<FileText size={27} />} title="表格为空" description="文件没有可展示的行。" />;
  const [header, ...body] = rows;
  return (
    <div className="csv-preview">
      <table>
        <thead><tr>{header.map((cell, index) => <th key={index}>{cell}</th>)}</tr></thead>
        <tbody>{body.map((row, rowIndex) => <tr key={rowIndex}>{header.map((_, index) => <td key={index}>{row[index] ?? ""}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

function ArtifactsView({
  projectId,
  summary,
  artifacts,
  directoryEntries,
  directory,
  directoryTotal,
  onDirectoryChange,
  loading,
  pageLoading,
  hasMore,
  onLoadMore,
  query,
  onQueryChange,
  error
}: {
  projectId: string;
  summary?: ArtifactCatalogSummary;
  artifacts: Artifact[];
  directoryEntries: ArtifactDirectoryEntry[];
  directory: string;
  directoryTotal: number;
  onDirectoryChange: (directory: string) => void;
  loading: boolean;
  pageLoading: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  query: string;
  onQueryChange: (query: string) => void;
  error: string;
}) {
  const [selected, setSelected] = useState<Artifact | ArtifactContent>();
  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState("");
  const contentRequestRef = useRef(0);

  useEffect(() => {
    contentRequestRef.current++;
    setSelected(undefined);
    setContentLoading(false);
    setContentError("");
    return () => { contentRequestRef.current++; };
  }, [directory]);

  const openArtifact = async (artifact: Artifact) => {
    const requestId = ++contentRequestRef.current;
    setContentLoading(false);
    if (!isPreviewableArtifact(artifact)) {
      if (artifact.variants && artifact.variants.length > 1) {
        setContentError(""); setSelected(artifact); return;
      }
      const anchor = document.createElement("a");
      anchor.href = getArtifactDownloadUrl(projectId, artifact);
      anchor.download = artifact.name;
      anchor.click();
      return;
    }
    if (artifactPreviewKind(artifact) !== "markdown" &&
        artifactPreviewKind(artifact) !== "json" &&
        artifactPreviewKind(artifact) !== "csv" &&
        artifactPreviewKind(artifact) !== "text") {
      setContentError("");
      setSelected(artifact);
      return;
    }
    setContentLoading(true);
    setContentError("");
    setSelected(undefined);
    try {
      const content = await getArtifact(projectId, artifact);
      if (requestId === contentRequestRef.current) setSelected(content);
    } catch (reason) {
      if (requestId === contentRequestRef.current) setContentError(reason instanceof Error ? reason.message : "无法读取产物");
    } finally {
      if (requestId === contentRequestRef.current) setContentLoading(false);
    }
  };

  if (loading && !summary && pageLoading && !artifacts.length && !directoryEntries.length) {
    return <PageLoader label="正在读取研究产物目录…" />;
  }
  if (error) return <ErrorPanel title="产物列表加载失败" message={error} />;

  const fileCount = summary?.total ?? 0;
  const searching = Boolean(query.trim());
  const directorySegments = directory ? directory.split("/") : [];
  const loadedCount = searching ? artifacts.length : directoryEntries.length;

  return (
    <div className={`artifacts-layout ${selected || contentLoading || contentError ? "viewer-open" : ""}`}>
      <div className="artifact-list">
        <div className="artifact-list-head">
          <span>
            {searching
              ? `在 ${fileCount} 份文件中搜索`
              : `当前文件夹 ${directoryTotal} 项`}
          </span>
          <small>已加载 {loadedCount} · 当前项目文件与已发布产物</small>
        </div>
        <label className="artifact-path-search">
          <Search size={14} />
          <input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="搜索文件名或相对路径"
            aria-label="搜索项目文件"
            maxLength={200}
          />
          {query && (
            <button
              type="button"
              onClick={() => onQueryChange("")}
              title="清空文件搜索"
            >
              <X size={13} />
            </button>
          )}
        </label>
        {!searching && (
          <nav className="artifact-breadcrumb" aria-label="研究产物文件夹路径">
            <button
              type="button"
              className={!directory ? "active" : ""}
              onClick={() => onDirectoryChange("")}
            >
              <FolderOpen size={14} />
              项目文件
            </button>
            {directorySegments.map((segment, index) => {
              const target = directorySegments.slice(0, index + 1).join("/");
              return (
                <span key={target}>
                  <ChevronRight size={12} />
                  <button
                    type="button"
                    className={index === directorySegments.length - 1 ? "active" : ""}
                    onClick={() => onDirectoryChange(target)}
                    title={target}
                  >
                    {segment}
                  </button>
                </span>
              );
            })}
          </nav>
        )}
        {pageLoading && loadedCount === 0 ? (
          <PageLoader label={searching ? "正在搜索研究产物…" : "正在读取当前文件夹…"} />
        ) : searching && artifacts.length ? (
          artifacts.map((artifact) => {
            const canPreview = isPreviewableArtifact(artifact);
            return (
              <button
                className={selected?.path === artifact.path ? "active" : ""}
                onClick={() => void openArtifact(artifact)}
                key={artifactKey(artifact)}
              >
                <span className={`file-kind file-${artifact.kind}`}>
                  {artifact.kind === "latex" ? <FileCode2 size={18} /> : <FileText size={18} />}
                </span>
                <span>
                  <strong>{artifact.name}</strong>
                  <small className="artifact-file-path" title={artifact.path}>
                    {artifact.path}
                  </small>
                  <small className="artifact-file-meta">
                    {artifact.size !== undefined && `${humanFileSize(artifact.size)}`}
                    {artifact.updatedAt && ` · ${formatRelativeTime(artifact.updatedAt)}`}
                    {artifact.workspaceLabel && ` · ${artifact.workspaceLabel}`}
                    {artifact.variants && ` · ${artifact.variants.length} 个来源`}
                    {!canPreview && (artifact.variants && artifact.variants.length > 1 ? " · 选择来源后下载" : " · 点击下载")}
                  </small>
                </span>
                {canPreview ? <ChevronRight size={16} /> : <Download size={16} />}
              </button>
            );
          })
        ) : !searching && directoryEntries.length ? (
          directoryEntries.map((entry) => {
            if (entry.type === "directory") {
              return (
                <button
                  className="artifact-directory-row"
                  onClick={() => onDirectoryChange(entry.path)}
                  key={artifactDirectoryEntryKey(entry)}
                  title={`打开文件夹 ${entry.path}`}
                >
                  <span className="file-kind file-directory">
                    <Folder size={18} />
                  </span>
                  <span>
                    <strong>{entry.name}</strong>
                    <small className="artifact-file-path" title={entry.path}>
                      {entry.path}
                    </small>
                    <small className="artifact-file-meta">
                      文件夹
                      {entry.updatedAt && ` · ${formatRelativeTime(entry.updatedAt)}`}
                    </small>
                  </span>
                  <ChevronRight size={16} />
                </button>
              );
            }
            const canPreview = isPreviewableArtifact(entry);
            return (
              <button
                className={selected?.path === entry.path ? "active" : ""}
                onClick={() => void openArtifact(entry)}
                key={artifactDirectoryEntryKey(entry)}
              >
                <span className={`file-kind file-${entry.kind}`}>
                  {entry.kind === "latex" ? <FileCode2 size={18} /> : <FileText size={18} />}
                </span>
                <span>
                  <strong>{entry.name}</strong>
                  <small className="artifact-file-path" title={entry.path}>
                    {entry.path}
                  </small>
                  <small className="artifact-file-meta">
                    {entry.size !== undefined && humanFileSize(entry.size)}
                    {entry.updatedAt && ` · ${formatRelativeTime(entry.updatedAt)}`}
                    {entry.workspaceLabel && ` · ${entry.workspaceLabel}`}
                    {entry.variants && ` · ${entry.variants.length} 个来源`}
                    {!canPreview && (entry.variants && entry.variants.length > 1 ? " · 选择来源后下载" : " · 点击下载")}
                  </small>
                </span>
                {canPreview ? <ChevronRight size={16} /> : <Download size={16} />}
              </button>
            );
          })
        ) : (
          <div className="artifact-group-empty">
            {searching ? "没有匹配该路径的文件。" : "当前文件夹为空。"}
          </div>
        )}
        {hasMore && (
          <button
            className="artifact-load-more"
            onClick={onLoadMore}
            disabled={pageLoading}
          >
            {pageLoading ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}
            {pageLoading ? "正在加载…" : "加载更多"}
          </button>
        )}
      </div>
      <ArtifactViewer
        projectId={projectId}
        artifact={selected}
        loading={contentLoading}
        error={contentError}
        onVariantChange={artifact => void openArtifact(artifact)}
        onClose={() => {
          contentRequestRef.current++;
          setSelected(undefined);
          setContentLoading(false);
          setContentError("");
        }}
      />
    </div>
  );
}

const MAX_ARTIFACT_PREVIEW_BYTES = 5 * 1024 * 1024;

function isPreviewableArtifact(artifact: Artifact): boolean {
  if (
    artifact.size !== undefined &&
    artifact.size > MAX_ARTIFACT_PREVIEW_BYTES
  ) {
    return false;
  }
  return artifactPreviewKind(artifact) !== "download";
}

export function FinalResultsView({
  projectId,
  project
}: {
  projectId: string;
  project: Project;
}) {
  const selection = projectResultSelection(project);
  const items = displayItems(selection);
  const resultItemsKey = JSON.stringify(items);
  const publishedFallback = !project.display && !!selection;
  const [expandedSections, setExpandedSections] = useState({
    summary: true,
    report: true,
    files: true
  });
  const [selectedItem, setSelectedItem] = useState<DisplayItem | undefined>(
    items[0]
  );
  const [selectedArtifact, setSelectedArtifact] = useState<Artifact | ArtifactContent>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setSelectedItem(current => items.find(item => item.agent === current?.agent && item.path === current.path &&
      item.artifactId === current.artifactId && item.commitSha === current.commitSha) ?? items[0]);
  }, [
    projectId,
    resultItemsKey
  ]);

  useEffect(() => {
    let active = true;
    setLoading(false);
    setSelectedArtifact(undefined);
    setError("");
    if (!selectedItem) return;
    const artifact = displayItemArtifact(selectedItem);
    const previewKind = artifactPreviewKind(artifact);
    if (!["markdown", "json", "csv", "text"].includes(previewKind)) {
      setSelectedArtifact(artifact);
      return;
    }
    setLoading(true);
    void Promise.resolve(getDisplayedFile(projectId, selectedItem))
      .then((content) => {
        if (active) setSelectedArtifact({ ...artifact, ...content });
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : "结果文件读取失败");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [
    projectId,
    selectedItem?.agent,
    selectedItem?.path,
    selectedItem?.artifactId,
    selectedItem?.commitSha
  ]);

  const handoff = project.latestHandoff ?? acceptedGitHandoff(project);
  const hasResult = Boolean(handoff || items.length || project.displayError);
  const toggleSection = (section: keyof typeof expandedSections) => {
    setExpandedSections((current) => ({
      ...current,
      [section]: !current[section]
    }));
  };
  return (
    <div className="final-results-view">
      {!hasResult ? (
        <EmptyState
          icon={<Gauge size={27} />}
          title="暂无最终结果"
          description="项目完成后，流程选定的成果、Main 说明和最近一次 Agent 交接会显示在这里。"
        />
      ) : (
        <>
          <section className="final-result-summary">
            <button
              type="button"
              className="final-result-section-head final-result-section-toggle"
              aria-expanded={expandedSections.summary}
              onClick={() => toggleSection("summary")}
            >
              <div>
                <ChevronRight className={expandedSections.summary ? "expanded" : ""} size={17} />
                <span className="final-result-heading-copy">
                  <span className="section-kicker">项目结论</span>
                  <h2>{project.status === "completed" ? "项目已完成" : "当前结果"}</h2>
                </span>
              </div>
              <StatusBadge status={project.status} runtime={project.runtime} />
            </button>
            {expandedSections.summary && (
              <div className="final-result-section-body final-result-summary-body">
                {handoff ? (
                  <>
                    <p className="final-result-summary-text">{handoff.excerpt || "已保存最近一次 Agent 交接，请展开查看完整内容。"}</p>
                  </>
                ) : (
                  <p className="final-result-summary-text">当前暂无文字结论，请查看下方结果文件。</p>
                )}
              </div>
            )}
          </section>

          {handoff?.markdown && (
            <section className="final-result-report">
              <button
                type="button"
                className="final-result-section-head final-result-section-toggle"
                aria-expanded={expandedSections.report}
                onClick={() => toggleSection("report")}
              >
                <div>
                  <ChevronRight className={expandedSections.report ? "expanded" : ""} size={17} />
                  <FileText size={17} />
                  <strong>{handoff.agent === SYSTEM_CONTROLLER_AGENT ? "Main 最终说明" : "最近一次 Agent 交接"}</strong>
                </div>
                <small>{handoff.agent} · {formatRelativeTime(handoff.updatedAt)}</small>
              </button>
              {expandedSections.report && (
                <div className="final-result-section-body final-result-report-body">
                  <div className="final-result-markdown markdown-body">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm, remarkMath]}
                      rehypePlugins={[rehypeSanitize, rehypeKatex]}
                      components={{
                        a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer">{children}</a>
                      }}
                    >
                      {handoff.markdown}
                    </ReactMarkdown>
                  </div>
                </div>
              )}
            </section>
          )}

          {project.displayError && (
            <div className="final-result-warning" role="status">
              <AlertTriangle size={16} />
              <span>{project.displayError}</span>
            </div>
          )}
          {publishedFallback && <p className="final-result-warning" role="status">尚未指定最终展示清单，以下显示项目已发布的成果文件。</p>}

          {items.length > 0 && (
            <section className={`final-result-files ${expandedSections.files ? "expanded" : "collapsed"}`}>
              <button
                type="button"
                className="final-result-section-head final-result-section-toggle"
                aria-expanded={expandedSections.files}
                onClick={() => toggleSection("files")}
              >
                <div>
                  <ChevronRight className={expandedSections.files ? "expanded" : ""} size={17} />
                  <FolderOpen size={17} />
                  <strong>结果文件</strong>
                </div>
                <small>{items.length} 个{publishedFallback ? "已发布成果" : "最终结果"}文件</small>
              </button>
              {expandedSections.files && (
                <div className="final-result-section-body final-result-files-body">
                  <div className="final-result-file-tabs" role="tablist" aria-label="最终结果文件">
                    {items.map((item, index) => (
                      <button
                        type="button"
                        key={item.artifactId ?? `${item.agent}:${item.path}`}
                        className={(selectedItem?.artifactId ?? `${selectedItem?.agent}:${selectedItem?.path}`) === (item.artifactId ?? `${item.agent}:${item.path}`) ? "active" : ""}
                        onClick={() => setSelectedItem(item)}
                        role="tab"
                        aria-selected={(selectedItem?.artifactId ?? `${selectedItem?.agent}:${selectedItem?.path}`) === (item.artifactId ?? `${item.agent}:${item.path}`)}
                      >
                        {index === 0 && <strong>主结果</strong>}
                        <span>{item.title || item.path.split("/").at(-1) || item.path}</span>
                      </button>
                    ))}
                  </div>
                  <ArtifactViewer
                    projectId={projectId}
                    artifact={selectedArtifact}
                    loading={loading}
                    error={error}
                  />
                </div>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}

export function ReviewCard({
  handoff,
  project,
  events = []
}: {
  handoff?: HandoffRecord;
  project?: Project;
  events?: AgentEvent[];
}) {
  const latestAssignment = [...events]
    .reverse()
    .find((event) => event.type === "main.assignment.committed");
  const decisionMessage = latestAssignment ? traceDataString(latestAssignment, "message") : project?.latestAssignment?.message ?? "";
  const waitingLabel = project ? projectWaitingLabel(project.status, project.runtime) : undefined;
  const statusLabel = project?.userIntervention?.status === "pending"
    ? "等待用户"
    : project?.error
      ? "需要处理"
        : waitingLabel ? waitingLabel
        : project?.status === "running"
          ? "运行中"
        : project?.status === "queued" || project?.status === "retrying"
          ? "排队中"
          : project?.status === "completed"
            ? "已完成"
            : project?.status === "failed"
              ? "需要处理"
              : project?.status === "cancelled" || project?.status === "stopped"
                ? "已停止"
                : project?.status === "paused" || project?.status === "interrupted"
                  ? "已暂停"
                  : "等待结果";
  const activeRole = project?.currentAgent ?? project?.queuedAgent;
  const activeRoleLabel = activeRole && project?.orchestration
    ? agentMeta(activeRole, agentTemplateFor(project.orchestration, activeRole)).name
    : activeRole;
  const attentionMessage = project?.userIntervention?.status === "pending"
    ? project.userIntervention.message
    : project?.error;
  const activeTask = decisionMessage || (activeRoleLabel ? `正在推进 ${activeRoleLabel} 的当前任务。` : "");
  const showNextTask = !["completed", "failed", "cancelled", "stopped"].includes(
    project?.status ?? ""
  );
  const needsAttention = Boolean(attentionMessage);
  const resultTone = needsAttention
    ? "attention"
    : project?.status === "completed"
      ? "passed"
      : "";
  if (handoff) {
    return (
      <div className="review-card review-passed">
        <div className="review-card-head">
          <span className="review-icon"><ShieldCheck size={19} /></span>
          <div>
            <span>项目级摘要</span>
            <strong>项目进展</strong>
          </div>
          <span className={`gate-result ${resultTone}`}>
            {needsAttention ? <AlertTriangle size={14} /> : project?.status === "completed" ? <CheckCircle2 size={14} /> : null}
            {statusLabel}
          </span>
        </div>
        {attentionMessage && (
          <div className="review-attention" role="status">
            <AlertTriangle size={15} />
            <span>{attentionMessage}</span>
          </div>
        )}
        {project?.currentAgent && project.status === "running" && (
          <div className="review-progress-line">
            <span>当前执行</span>
            <strong>{activeRoleLabel}</strong>
          </div>
        )}
        <div className="review-progress-block">
          <span>最近完成</span>
          <p className="review-summary">{handoff.excerpt || "已完成一次 Agent 交接。"}</p>
        </div>
        {activeTask && showNextTask && (
          <div className="review-progress-block">
            <span>下一步</span>
            <p className="review-next-task">{activeTask}</p>
          </div>
        )}
        <details className="review-handoff-details">
          <summary>查看完整交接</summary>
          <div className="review-natural-language">
            <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeSanitize, rehypeKatex]}>
              {handoff.markdown}
            </ReactMarkdown>
          </div>
        </details>
      </div>
    );
  }
  return (
      <div className="review-card review-pending">
        <div className="review-card-head">
          <span className="review-icon"><ShieldCheck size={19} /></span>
          <div><span>项目级摘要</span><strong>项目进展</strong></div>
          <span className="gate-result">{statusLabel}</span>
        </div>
        {attentionMessage && (
          <div className="review-attention" role="status">
            <AlertTriangle size={15} />
            <span>{attentionMessage}</span>
          </div>
        )}
        {activeRole && (
          <div className="review-progress-line">
            <span>{project?.currentAgent ? "当前执行" : "等待执行"}</span>
            <strong>{activeRoleLabel}</strong>
          </div>
        )}
        {activeTask && showNextTask && (
          <div className="review-progress-block">
            <span>任务状态</span>
            <p className="review-next-task">{activeTask}</p>
          </div>
        )}
        <p>工作 Agent 完成后，这里会显示项目正在做什么、最近完成了什么以及下一步安排。</p>
      </div>
    );
}

function CurrentAgentActivityCard({
  project,
  events
}: {
  project: Project;
  events: AgentEvent[];
}) {
  const role = project.currentAgent ?? project.queuedAgent;
  if (!role) {
    return (
      <div
        className="context-card current-agent-activity current-agent-idle"
        role="region"
        aria-label="当前 Agent 工作信息"
      >
        <div className="context-card-head">
          <div><Inbox size={17} /><strong>当前 Agent</strong></div>
          <span>空闲</span>
        </div>
        <p>当前没有正在运行或排队的 Agent。</p>
      </div>
    );
  }
  const template = role === SYSTEM_CONTROLLER_AGENT
    ? "main"
    : agentTemplateFor(project.orchestration, role);
  const meta = agentMeta(role, template);

  const isRunning = project.currentAgent === role && project.status === "running";
  const interruption = project.interruptionSnapshot && project.interruptionSnapshot.agent === role
    ? project.interruptionSnapshot
    : undefined;
  const isInterrupting = project.status === "interrupting" && project.currentAgent === role;
  const started = isRunning
    ? [...events]
        .reverse()
        .find((event) => event.type === "agent.started" && event.agent === role)
    : undefined;
  const invocationId = started ? traceDataString(started, "invocationId") : "";
  const decision = [...events]
    .reverse()
    .find(
      (event) =>
        event.type === "main.assignment.committed" &&
        traceDataString(event, "target") === role
    );
  const relevantTraces = events.filter(
    (event) =>
      event.agent === role &&
      event.type === "agent.trace" &&
      (!invocationId || traceDataString(event, "invocationId") === invocationId)
  );
  const latestThought = [...relevantTraces].reverse().find(isThoughtEvent);
  const latestTool = [...relevantTraces].reverse().find(isToolEvent);
  const assignedTask =
    (started ? traceDataString(started, "assignedTask") : "") ||
    (decision ? traceDataString(decision, "message") : "") ||
    (project.latestAssignment?.target === role ? project.latestAssignment.message : "") ||
    (template === "idea"
      ? "把用户需求转化为首个严谨、可证伪的研究方案。"
      : role === SYSTEM_CONTROLLER_AGENT
        ? "审查全部已完成工作并决定下一个有边界的任务。"
        : `继续推进 ${role}（${template} 模板）的当前任务。`);
  const startedCriteria = traceDataStrings(started, "successCriteria");
  const successCriteria = startedCriteria.length
    ? startedCriteria
    : traceDataStrings(decision, "successCriteria").length
      ? traceDataStrings(decision, "successCriteria")
      : project.latestAssignment?.target === role
        ? project.latestAssignment.successCriteria
        : [];
  const inputSources = traceDataStrings(started, "inputSources");
  const fallbackSources = [
    "用户原始科研需求",
    "项目历史交接、评审与产物索引",
    role === SYSTEM_CONTROLLER_AGENT ? "当前项目状态与用户新增要求" : "流程最新安排"
  ];
  const waitingLabel = projectWaitingLabel(project.status, project.runtime);
  const stateLabel = isRunning
    ? "实时运行"
    : isInterrupting || interruption?.status === "requested" || interruption?.status === "interrupting"
      ? "中断中"
      : interruption?.status === "force-terminated"
        ? "已强制终止"
    : waitingLabel ? waitingLabel
    : project.status === "interrupted"
      ? "等待恢复"
      : project.status === "retrying"
        ? "等待重试"
        : project.status === "paused"
          ? "已暂停"
          : "排队中";
  const doing = isRunning
    ? latestThought
      ? thoughtSummary(latestThought.message)
      : latestTool
        ? `正在使用${toolLabel(latestTool)}：${toolCommand(latestTool)}`
        : "正在读取 Agent inbox 与项目上下文，准备执行任务。"
    : interruption?.partialOutput
      ? `中断时未完成内容：${interruption.partialOutput.slice(0, 260)}${interruption.partialOutput.length > 260 ? "…" : ""}`
      : waitingLabel ? project.runtime!.waiting!.reason
      : project.status === "interrupted"
      ? "上一次调用已中断，恢复后会从该 Agent 重新进入科研流程。"
      : project.status === "paused"
        ? "项目已暂停，等待用户或系统恢复。"
        : "正在等待共享角色槽位，尚未启动本次调用。";

  return (
    <div
      className="context-card current-agent-activity"
      role="region"
      aria-label="当前 Agent 工作信息"
    >
      <div className="current-agent-heading">
        <span className={`current-agent-icon agent-${meta.color}`}>
          <AgentIcon role={template} size={18} />
          {(isRunning || isInterrupting) && <i />}
        </span>
        <div>
          <small>当前 Agent</small>
          <strong>{meta.name}</strong>
          <small>模板：{template}</small>
        </div>
        <span className={`current-agent-state ${isRunning ? "active" : ""}`}>
          {stateLabel}
        </span>
      </div>

      <section className="agent-received-block">
        <header><Inbox size={15} /><strong>接收到的信息</strong></header>
        <span>当前任务</span>
        <p>{assignedTask}</p>
        <ul>
          {(inputSources.length ? inputSources : fallbackSources).map((source) => (
            <li key={source}>{source}</li>
          ))}
        </ul>
      </section>

      <section className="agent-doing-block">
        <header><BrainCircuit size={15} /><strong>正在做</strong></header>
        <p>{doing}</p>
        {latestTool && isRunning && (
          <div className="current-tool-line">
            <TerminalSquare size={13} />
            <span>{toolLabel(latestTool)}</span>
            <code title={toolCommand(latestTool)}>{toolCommand(latestTool)}</code>
          </div>
        )}
      </section>

      {interruption && (
        <section className="agent-interruption-mini" aria-label="中断快照摘要">
          <header><RotateCcw size={14} /><strong>中断快照</strong><span>{interruption.status === "interrupted" ? "已保存" : interruption.status === "force-terminated" ? "强制终止" : "保存中"}</span></header>
          <p>{interruption.partialHandoff || interruption.workspaceSummary || "已保存当前调用的恢复上下文。"}</p>
          {interruption.activeTools.length > 0 && <small>中断前工具：{interruption.activeTools.slice(-3).join("、")}</small>}
        </section>
      )}

      {successCriteria.length > 0 && (
        <details className="agent-success-criteria">
          <summary><ListChecks size={14} />验收条件（{successCriteria.length}）</summary>
          <ol>
            {successCriteria.map((criterion, index) => (
              <li key={`${index}-${criterion}`}>{criterion}</li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}

function ContextPanel({
  project,
  events,
  eventCount,
  artifactCount,
  queue,
  queueError,
  livePerformance
}: {
  project: Project;
  events: AgentEvent[];
  eventCount: number;
  artifactCount: number;
  queue?: QueueSnapshot;
  queueError: string;
  livePerformance?: InvocationPerformance;
}) {
  const [expanded, setExpanded] = useState(false);
  const queuedRole = project.queuedAgent;
  const queuedSchedulerKind = queuedRole
    ? queuedRole === SYSTEM_CONTROLLER_AGENT
      ? "main"
      : "worker"
    : undefined;
  const queuedItem = queuedRole
    ? queue?.[queuedSchedulerKind ?? "worker"]?.queued.find(
        (item) => item.projectId === project.id
      )
    : undefined;
  return (
    <aside className="workspace-context">
      <div className="context-card task-snapshot">
        <div className="context-card-head">
          <div><Bot size={17} /><strong>任务快照</strong></div>
          <span>Turn {project.turn}</span>
        </div>
        <code>{project.id}</code>
        <OverallProgressBar progress={project.overallProgress} compact />
        <div className="task-snapshot-phase">
          <span>当前阶段</span>
          <strong>{project.runtime?.waiting?.reason ?? displayPhase(project.phase)}</strong>
        </div>
        {queuedRole && (
          <div className="task-snapshot-queue">
            {project.status === "interrupted" ? (
              <RotateCcw size={14} />
            ) : (
              <Clock3 size={14} />
            )}
            <span>
              {displayAgentName(queuedRole)} · {queuedSchedulerKind === "main" ? "Main Agent" : "Worker"}
              {" · "}
              {project.status === "interrupted"
                ? "等待用户从断点恢复"
                : queuedItem?.position ?? project.queuePosition
                  ? `队列 #${queuedItem?.position ?? project.queuePosition}`
                  : "等待进入执行槽"}
            </span>
          </div>
        )}
        {queueError && !queue && (
          <small className="task-snapshot-warning">队列快照暂不可用</small>
        )}
      </div>
      <CurrentAgentActivityCard project={project} events={events} />
      <ProjectPerformanceCard project={project} livePerformance={livePerformance} />
      <TokenUsageCard project={project} />
      <RuntimeIntegrityCard project={project} />
      <ReviewCard
        project={project}
        events={events}
        handoff={project.latestHandoff}
      />
      <div className="context-card project-brief">
        <div className="context-card-head">
          <div><MessageSquareText size={17} /><strong>研究需求</strong></div>
          <button onClick={() => setExpanded((value) => !value)}>
            {expanded ? "收起" : "展开"}
          </button>
        </div>
        <p className={expanded ? "expanded" : ""}>
          {project.requirement || "暂无研究需求描述。"}
        </p>
      </div>
      <div className="context-card project-metrics">
        <div>
          <Activity size={17} />
          <span><strong>{eventCount}</strong><small>轨迹事件</small></span>
        </div>
        <div>
          <FileText size={17} />
          <span><strong>{artifactCount}</strong><small>研究产物</small></span>
        </div>
        <div>
          <RotateCcw size={17} />
          <span><strong>{project.cycle}</strong><small>当前轮次</small></span>
        </div>
      </div>
      {project.error && (
        <div className="context-error">
          <AlertTriangle size={17} />
          <span><strong>项目异常</strong><small>{project.error}</small></span>
        </div>
      )}
    </aside>
  );
}

function ProjectPerformanceCard({
  project,
  livePerformance
}: {
  project: Project;
  livePerformance?: InvocationPerformance;
}) {
  const aggregate = project.performance?.aggregate;
  const metrics = resolvePerformanceMetrics(project.performance, livePerformance, project.status);
  const latest = metrics.current ?? project.performance?.latest;
  return (
    <div
      className="context-card performance-summary-card"
      role="region"
      aria-label="模型输出性能"
    >
      <div className="context-card-head">
        <div><Gauge size={17} /><strong>输出性能</strong></div>
        <span>{latest?.agent ?? "等待调用"}</span>
      </div>
      <PerformanceMetrics performance={metrics.current} averageFallback={metrics.average} latestToken={metrics.latestToken} />
      <div className="performance-aggregate-note">
        {aggregate ? (
          <>
            <span>项目累计 {aggregate.invocations} 次成功调用</span>
            <span>输出 {aggregate.outputTokens.toLocaleString()} tokens</span>
            <span>
              {aggregate.tokenSource === "official"
                ? "累计速度采用 Provider usage"
                : aggregate.tokenSource === "mixed"
                  ? "累计速度混合 Provider usage 与本地估算"
                  : "累计速度为本地估算"}
            </span>
          </>
        ) : (
          <span>首个成功调用完成后生成项目累计指标。</span>
        )}
      </div>
    </div>
  );
}

function TokenUsageCard({ project }: { project: Project }) {
  const usage = project.tokenUsage;
  const totalTokens = usage?.totalTokens ?? 0;
  return (
    <div
      className="context-card token-usage-detail"
      role="region"
      aria-label="项目 Token 消耗"
    >
      <div className="context-card-head">
        <div>
          <Coins size={17} />
          <strong>Token 消耗</strong>
        </div>
        <span title={`${formatTokenCount(totalTokens)} tokens`}>
          {formatTokenCount(totalTokens)}
        </span>
      </div>
      <div className="token-usage-total">
        <strong>{formatTokenCount(totalTokens)}</strong>
        <span>项目累计 tokens</span>
        <small>
          {usage?.updatedAt
            ? `更新于 ${formatRelativeTime(usage.updatedAt)}`
            : "等待首次 Agent 调用完成"}
        </small>
      </div>
      <small className="token-usage-note">
        仅展示项目累计用量；Agent 分项由后端保留用于恢复和诊断。
      </small>
    </div>
  );
}

function RuntimeIntegrityCard({ project }: { project: Project }) {
  const mode = project.mainCapabilities?.controlMode;
  const loops = project.orchestration.loops ?? [];
  const usage = project.tokenUsage;
  const unknownRequests = usage?.unknownRequests ?? 0;
  const unverifiedArtifacts = (project.artifacts ?? []).filter(
    (artifact) => !artifact.sha256
  ).length;
  const verifiedArtifacts = (project.artifacts?.length ?? 0) - unverifiedArtifacts;
  return (
    <div
      className="context-card runtime-integrity-card"
      role="region"
      aria-label="运行合同与完整性"
    >
      <div className="context-card-head">
        <div><ShieldCheck size={17} /><strong>运行合同与完整性</strong></div>
        <span data-integrity-state={usage?.complete === true ? "complete" : "incomplete"}>
          {usage?.complete === true ? "账本完整" : "需要注意"}
        </span>
      </div>
      <dl className="runtime-integrity-list">
        <div>
          <dt>Main 控制</dt>
          <dd>{mode === "autonomous" ? "autonomous · 自主编排" : mode === "weak-branch" ? "weak-branch · 受限分支" : "等待 Main 权限快照"}</dd>
        </div>
        <div>
          <dt>Loop</dt>
          <dd>{loops.length > 0
            ? loops.map((loop) => `${loop.id}: B${project.loopBatches?.[loop.id] ?? 0} · ${(project.loopIterations?.[loop.id] ?? 0)}/${loop.maxIterations} · Σ${project.loopTotalIterations?.[loop.id] ?? 0}`).join("；")
            : "未配置 Loop"}</dd>
        </div>
        <div data-integrity-error={usage?.complete === false ? "true" : undefined}>
          <dt>Token ledger</dt>
          <dd>{usage?.complete === true
            ? "完整"
            : unknownRequests > 0
              ? `不完整 · ${unknownRequests} 个 Provider 请求 usage 未知`
              : "不完整 · 存在未逐项登记的历史请求"}</dd>
        </div>
        <div data-integrity-error={project.displayError || unverifiedArtifacts > 0 ? "true" : undefined}>
          <dt>Artifact</dt>
          <dd>{project.displayError
            ? project.displayError
            : unverifiedArtifacts > 0
              ? `${unverifiedArtifacts} 项旧 Artifact 未绑定 SHA-256，必须重新发布后才能视为已验证`
              : verifiedArtifacts > 0
                ? `${verifiedArtifacts} 项已绑定 SHA-256；读取与展示时重新校验`
                : "尚无已发布 Artifact"}</dd>
        </div>
      </dl>
    </div>
  );
}

function CancelDialog({
  title,
  loading,
  onCancel,
  onConfirm
}: {
  title: string;
  loading: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onCancel}>
      <div
        className="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cancel-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <span className="dialog-danger-icon"><CircleStop size={23} /></span>
        <h2 id="cancel-title">停止这个科研项目？</h2>
        <p>
          「{title}」的当前智能体进程将被终止。已经生成的轨迹与产物仍会保留。
        </p>
        <div className="dialog-actions">
          <Button variant="secondary" onClick={onCancel} disabled={loading}>继续运行</Button>
          <Button variant="danger" onClick={onConfirm} loading={loading}>确认停止</Button>
        </div>
      </div>
    </div>
  );
}

function mergeProjectExplainerEvent(
  current: ProjectExplainerEvent[],
  incoming: ProjectExplainerEvent
): ProjectExplainerEvent[] {
  return mergeExplainerMessages(current, incoming);
}

function foldProjectExplainerEvents(
  events: ProjectExplainerEvent[]
): ProjectExplainerEvent[] {
  return foldExplainerMessages(events)
    .filter(
      (event) =>
        !(
          event.kind === "reasoning" &&
          event.phase === "completed" &&
          !event.text
        )
    );
}

export function ProjectExplainerPanel({ projectId }: { projectId: string }) {
  const [events, setEvents] = useState<ProjectExplainerEvent[]>([]);
  const [runtimeConfig, setRuntimeConfig] = useState<ProjectExplainerRuntimeConfig>();
  const [configDraft, setConfigDraft] = useState<ProjectExplainerConfigInput>();
  const [runtimeCatalog, setRuntimeCatalog] = useState<Pick<Catalog, "gateways" | "harnesses" | "protocols" | "defaultHarnessId">>();
  const [configLoading, setConfigLoading] = useState(true);
  const [configSaving, setConfigSaving] = useState(false);
  const [refreshingGatewayId, setRefreshingGatewayId] = useState("");
  const [gatewayRefreshError, setGatewayRefreshError] = useState("");
  const [configError, setConfigError] = useState("");
  const [configNotice, setConfigNotice] = useState("");
  // Keep the running page compact; tests open the editor so field-level
  // validation remains directly exercisable without an extra click.
  const [configEditorOpen, setConfigEditorOpen] = useState(
    () => import.meta.env.MODE === "test"
  );
  const [question, setQuestion] = useState("");
  const [historyLoading, setHistoryLoading] = useState(true);
  const [streaming, setStreaming] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [remoteActive, setRemoteActive] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetNotice, setResetNotice] = useState("");
  const [error, setError] = useState("");
  const abortRef = useRef<AbortController>();
  const stopRequestedRef = useRef(false);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const historyRequestRef = useRef(0);
  const gatewayRefreshRequestRef = useRef(0);

  const loadRuntimeConfig = useCallback(async () => {
    try {
      const [config, catalog] = await Promise.all([
        getProjectExplainerConfig(projectId),
        getCatalog()
      ]);
      setRuntimeConfig(config);
      setConfigDraft({
        harness: config.harness,
        ...(config.gatewayId ? { gatewayId: config.gatewayId } : {}),
        model: config.model,
        reasoningEffort: config.reasoningEffort
      });
      setRuntimeCatalog({
        gateways: catalog.gateways ?? [],
        harnesses: catalog.harnesses ?? [],
        protocols: catalog.protocols ?? [],
        defaultHarnessId: catalog.defaultHarnessId
      });
      setConfigError("");
    } catch (reason) {
      setConfigError(reason instanceof Error ? reason.message : "Project Explainer 配置加载失败");
    } finally {
      setConfigLoading(false);
    }
  }, [projectId]);

  const loadHistory = useCallback(async () => {
    const requestId = ++historyRequestRef.current;
    try {
      const history = await getProjectExplainerHistory(projectId);
      if (requestId !== historyRequestRef.current) return;
      setEvents(current => foldProjectExplainerEvents(history.active ? [...history.events, ...current] : history.events));
      setRemoteActive(history.active);
      setError("");
    } catch (reason) {
      if (requestId !== historyRequestRef.current) return;
      setError(reason instanceof Error ? reason.message : "解说历史加载失败");
    } finally {
      if (requestId === historyRequestRef.current) setHistoryLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    setEvents([]);
    setQuestion("");
    setHistoryLoading(true);
    setStopping(false);
    setRemoteActive(false);
    setResetting(false);
    setResetNotice("");
    setError("");
    setRuntimeConfig(undefined);
    setConfigDraft(undefined);
    setRuntimeCatalog(undefined);
    setConfigLoading(true);
    setConfigSaving(false);
    gatewayRefreshRequestRef.current += 1;
    setRefreshingGatewayId("");
    setGatewayRefreshError("");
    setConfigError("");
    setConfigNotice("");
    stopRequestedRef.current = false;
    void loadHistory();
    void loadRuntimeConfig();
    return () => {
      historyRequestRef.current += 1;
      gatewayRefreshRequestRef.current += 1;
      stopRequestedRef.current = true;
      abortRef.current?.abort();
    };
  }, [loadHistory, loadRuntimeConfig]);

  useEffect(() => {
    if (!remoteActive || streaming) return;
    let inFlight = false;
    const refresh = () => {
      if (inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      void loadHistory().finally(() => { inFlight = false; });
    };
    const timer = window.setInterval(refresh, 2_000);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", refresh); };
  }, [loadHistory, remoteActive, streaming]);

  useEffect(() => {
    const receive = (event: Event) => {
      const detail = (event as CustomEvent).detail as { projectId?: string; source?: string; event?: ProjectExplainerEvent };
      if (detail.source !== "floating" || detail.projectId !== projectId || !detail.event) return;
      historyRequestRef.current += 1;
      setHistoryLoading(false); setRemoteActive(!detail.event.data?.turnComplete);
      setEvents(current => mergeProjectExplainerEvent(current, detail.event!));
    };
    const refresh = (event: Event) => {
      const detail = (event as CustomEvent).detail as { projectId?: string; source?: string; active?: boolean };
      if (detail.source === "panel" || detail.projectId !== projectId) return;
      if (detail.active === true) { setRemoteActive(true); return; }
      if (!streaming) { void loadHistory(); void loadRuntimeConfig(); }
    };
    window.addEventListener("openfars:explainer-event", receive); window.addEventListener("openfars:explainer-refresh", refresh);
    return () => { window.removeEventListener("openfars:explainer-event", receive); window.removeEventListener("openfars:explainer-refresh", refresh); };
  }, [projectId, loadHistory, loadRuntimeConfig, streaming]);

  useEffect(() => {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    transcript.scrollTop = transcript.scrollHeight;
  }, [events]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const message = question.trim();
    if (!message || streaming || stopping || remoteActive || resetting || !runtimeConfig?.available) return;
    const controller = new AbortController();
    abortRef.current = controller;
    stopRequestedRef.current = false;
    setStreaming(true);
    setError("");
    setResetNotice("");
    setQuestion("");
    window.dispatchEvent(new CustomEvent("openfars:explainer-refresh", { detail: { projectId, active: true, source: "panel" } }));
    try {
      await streamProjectExplainerQuestion(
        projectId,
        message,
        (incoming) => {
          if (stopRequestedRef.current) return;
          setEvents((current) => mergeProjectExplainerEvent(current, incoming));
          window.dispatchEvent(new CustomEvent("openfars:explainer-event", { detail: { projectId, event: incoming, source: "panel" } }));
        },
        controller.signal
      );
    } catch (reason) {
      if (!controller.signal.aborted) {
        setError(reason instanceof Error ? reason.message : "项目解说失败");
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = undefined;
      setStreaming(false);
      if (!stopRequestedRef.current) setStopping(false);
      void loadHistory();
      window.dispatchEvent(new CustomEvent("openfars:explainer-refresh", { detail: { projectId, active: false, source: "panel" } }));
    }
  };

  const stopConversation = async () => {
    if (!streaming || stopping || stopRequestedRef.current) return;
    const controller = abortRef.current;
    stopRequestedRef.current = true;
    setStopping(true);
    setError("");
    try {
      // The backend only resolves this request after the selected Harness process has exited.
      await cancelProjectExplainer(projectId);
      if (abortRef.current === controller) controller?.abort();
    } catch (reason) {
      // A failed request is not a confirmed cancellation, so continue rendering
      // the still-active stream and allow the user to retry.
      stopRequestedRef.current = false;
      setError(
        reason instanceof Error
          ? `无法确认解说已停止：${reason.message}`
          : "无法确认解说已停止"
      );
    } finally {
      setStopping(false);
    }
  };

  const resetConversation = async () => {
    if (streaming || stopping || remoteActive || resetting) return;
    historyRequestRef.current += 1;
    setResetting(true);
    setError("");
    setResetNotice("");
    try {
      await resetProjectExplainer(projectId);
      setEvents([]);
      setQuestion("");
      setRemoteActive(false);
      setHistoryLoading(false);
      setResetNotice("解说上下文已刷新，可以重新询问。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "解说上下文刷新失败");
    } finally {
      setResetting(false);
    }
  };

  const selectRuntimeGateway = (gatewayId: string) => {
    const requestId = ++gatewayRefreshRequestRef.current;
    const gateway = runtimeCatalog?.gateways?.find((item) => item.id === gatewayId);
    setGatewayRefreshError("");
    setConfigError("");
    setConfigNotice("");
    setConfigDraft((current) => current ? {
      ...current,
      ...(gateway ? { gatewayId: gateway.id } : { gatewayId: undefined }),
      model: gateway && gateway.models.includes(current.model) ? current.model : ""
    } : current);

    if (!gateway) {
      setRefreshingGatewayId("");
      return;
    }

    setRefreshingGatewayId(gateway.id);
    void refreshGatewayModels(gateway.id)
      .then((refreshed) => {
        if (requestId !== gatewayRefreshRequestRef.current) return;
        setRuntimeCatalog((current) => current ? {
          ...current,
          gateways: (current.gateways ?? []).map((item) =>
            item.id === refreshed.id ? refreshed : item
          )
        } : current);
        setConfigDraft((current) => current?.gatewayId === refreshed.id ? {
          ...current,
          model: refreshed.models.includes(current.model) ? current.model : ""
        } : current);
      })
      .catch((reason) => {
        if (requestId !== gatewayRefreshRequestRef.current) return;
        setGatewayRefreshError(
          reason instanceof Error
            ? `model 列表刷新失败：${reason.message}`
            : "model 列表刷新失败，请检查网关后重试"
        );
      })
      .finally(() => {
        if (requestId === gatewayRefreshRequestRef.current) setRefreshingGatewayId("");
      });
  };

  const saveRuntimeConfig = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!configDraft || configSaving) return;
    if (refreshingGatewayId) {
      setConfigError("正在刷新所选网关的 model 列表，请稍候");
      return;
    }
    if (gatewayRefreshError) {
      setConfigError("所选网关的 model 列表刷新失败，请重新选择网关后再保存");
      return;
    }
    const draftGateway = runtimeCatalog?.gateways?.find((gateway) => gateway.id === configDraft.gatewayId);
    if (!draftGateway || !configDraft.model.trim() || !draftGateway.models.includes(configDraft.model)) {
      setConfigError(!draftGateway
        ? "请选择已保存网关"
        : !configDraft.model.trim()
          ? "切换网关后需要重新选择 model"
          : "当前 model 不在所选网关的模型列表中，请重新选择");
      return;
    }
    if (!selectedHarnessCompatible) {
      setConfigError(
        selectedHarness?.availabilityReason ??
        "当前 Harness 不支持只读 Project Explainer。"
      );
      return;
    }
    setConfigSaving(true);
    setConfigError("");
    setConfigNotice("");
    const update = async (confirmHarnessSwitch = false) =>
      updateProjectExplainerConfig(projectId, {
        ...configDraft,
        ...(confirmHarnessSwitch ? { confirmHarnessSwitch: true } : {})
      });
    try {
      let updated: ProjectExplainerRuntimeConfig;
      try {
        updated = await update(false);
      } catch (reason) {
        const record = reason as { status?: number; details?: unknown };
        const details = record.details && typeof record.details === "object"
          ? record.details as Record<string, unknown>
          : {};
        if (
          record.status !== 409 ||
          details.code !== "explainer_harness_switch_confirmation_required" ||
          !window.confirm("当前回答会终止，已有历史将带入新会话。是否继续切换 harness？")
        ) throw reason;
        updated = await update(true);
      }
      setRuntimeConfig(updated);
      setGatewayRefreshError("");
      setConfigDraft({
        harness: updated.harness,
        ...(updated.gatewayId ? { gatewayId: updated.gatewayId } : {}),
        model: updated.model,
        reasoningEffort: updated.reasoningEffort
      });
      setConfigNotice(
        updated.harness !== runtimeConfig?.harness
          ? "已切换 harness 并重建底层会话，完整历史会带入下一次问答。"
          : "Project Explainer 配置已保存，将用于下一次问答。"
      );
      void loadHistory();
    } catch (reason) {
      setConfigError(reason instanceof Error ? reason.message : "Project Explainer 配置保存失败");
      if (runtimeConfig) {
        setConfigDraft({
          harness: runtimeConfig.harness,
          ...(runtimeConfig.gatewayId ? { gatewayId: runtimeConfig.gatewayId } : {}),
          model: runtimeConfig.model,
          reasoningEffort: runtimeConfig.reasoningEffort
        });
      }
    } finally {
      setConfigSaving(false);
    }
  };

  const selectedGateway: GatewayRecord | undefined = runtimeCatalog?.gateways?.find(
    (gateway) => gateway.id === configDraft?.gatewayId
  );
  const catalogHarnesses = runtimeCatalog?.harnesses ?? [];
  const explainerPurposeOptions = harnessOptionsForPurpose(
    catalogHarnesses,
    "explainer"
  );
  const compatibleExplainerHarnesses = explainerPurposeOptions.filter(
    (item) => item.available
  );
  const selectedHarnessId = configDraft?.harness
    ?? runtimeCatalog?.defaultHarnessId
    ?? compatibleExplainerHarnesses.find((item) => item.default)?.id
    ?? compatibleExplainerHarnesses[0]?.id
    ?? "";
  const harnessOptions = harnessOptionsForPurpose(
    catalogHarnesses,
    "explainer",
    selectedHarnessId
  );
  const selectedHarness = harnessOptions.find((item) => item.id === selectedHarnessId);
  const selectedHarnessCompatible = compatibleExplainerHarnesses.some(
    (item) => item.id === selectedHarnessId && item.available
  );
  const modelTestOptions = selectedGateway
    ? gatewayModelTestOptions(selectedGateway, selectedHarnessId, harnessOptions)
    : [];
  const failedModelOptions = modelTestOptions.filter((option) => option.test.status === "failed");
  const activeHarnessLabel = harnessOptions.find((item) => item.id === runtimeConfig?.harness)?.label
    ?? runtimeConfig?.harness
    ?? "Project Explainer";
  const routeNeeded = Boolean(
    selectedHarness?.nativeProtocol && selectedGateway && selectedHarness.nativeProtocol !== selectedGateway.protocol
  );
  const modelSelectionError = selectedGateway && configDraft
    ? !configDraft.model.trim()
      ? "切换网关后需要重新选择 model"
      : !selectedGateway.models.includes(configDraft.model)
        ? "当前 model 不在所选网关的模型列表中，请重新选择"
        : ""
    : "";
  const combinationTest = selectedGateway && selectedHarness && configDraft &&
    configDraft.model.trim() && selectedGateway.models.includes(configDraft.model)
    ? gatewayCombinationTestState(selectedGateway, selectedHarness.id, configDraft.model, harnessOptions)
    : undefined;
  const combinationTestWarning = combinationTest && combinationTest.status !== "passed"
    ? combinationTest.status === "failed"
      ? `当前 Harness / 网关 / model 组合验证失败${combinationTest.error ? `：${combinationTest.error}` : ""}；仍可使用，但运行可能失败。`
      : "当前 Harness / 网关 / model 组合尚未验证；仍可使用，但运行可能失败。"
    : "";
  const configDirty = Boolean(runtimeConfig && configDraft && (
    runtimeConfig.harness !== configDraft.harness ||
    runtimeConfig.gatewayId !== configDraft.gatewayId ||
    runtimeConfig.model !== configDraft.model ||
    runtimeConfig.reasoningEffort !== configDraft.reasoningEffort
  ));
  const configStateLabel = configSaving
    ? "保存中"
    : configError
      ? "保存失败"
      : configDirty
        ? "未保存修改"
        : configNotice
          ? "已保存"
          : runtimeConfig?.available
            ? runtimeConfig.validationWarning ? "未验证" : "可用"
            : "待配置";

  const handleQuestionKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const synthetic = event as KeyboardEvent<HTMLTextAreaElement> & { isComposing?: boolean };
    const native = event.nativeEvent as globalThis.KeyboardEvent & { which?: number };
    if (
      synthetic.isComposing ||
      native.isComposing ||
      native.keyCode === 229 ||
      native.which === 229 ||
      event.keyCode === 229 ||
      event.which === 229
    ) {
      // Prevent the form's native Enter submit while an IME owns the key.
      // Returning alone still lets jsdom/browsers perform implicit submit.
      event.preventDefault();
      return;
    }
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  };

  return (
    <section className="project-explainer-panel" aria-label="项目解说 Agent">
      <div className="project-explainer-heading">
        <div>
          <span className="project-explainer-icon"><Bot size={18} /></span>
          <span>
            <small>PROJECT EXPLAINER · {activeHarnessLabel}</small>
            <strong>询问这个科研项目</strong>
          </span>
        </div>
        <div className="project-explainer-heading-actions">
          <button
            type="button"
            className="project-explainer-reset"
            onClick={() => void resetConversation()}
            disabled={streaming || stopping || remoteActive || resetting || historyLoading}
            aria-label="刷新解说上下文"
            title="清空当前解说上下文并开始新会话"
          >
            <RefreshCw className={resetting ? "spin" : undefined} size={13} />
            刷新
          </button>
          <span className="project-explainer-policy">只读 · 无 Skills · 无 MCP</span>
        </div>
      </div>
      <div className="project-explainer-config-summary" aria-label="Project Explainer 当前运行配置">
        <div className="project-explainer-config-summary-copy">
          <span className="project-explainer-config-kicker">只读运行配置</span>
          <strong>{activeHarnessLabel} · {runtimeConfig?.model || configDraft?.model || "未选择 model"}</strong>
          <small>
            {selectedGateway?.name || "未选择全局网关"} · {selectedGateway ? protocolLabel(selectedGateway.protocol) : "等待路由"}
            {routeNeeded && selectedHarness?.nativeProtocol && selectedGateway ? ` · ${protocolLabel(selectedHarness.nativeProtocol)} → ${protocolLabel(selectedGateway.protocol)}` : ""}
          </small>
        </div>
        <span className={`project-explainer-config-state ${runtimeConfig?.available ? "available" : "pending"}`}>
          {configStateLabel}
        </span>
        <button
          type="button"
          className="project-explainer-config-open"
          onClick={() => setConfigEditorOpen(true)}
          aria-expanded={configEditorOpen}
          aria-controls="project-explainer-runtime-config"
        >
          切换配置
        </button>
      </div>
      {runtimeConfig?.validationWarning && <p className="project-explainer-config-warning" role="status">{runtimeConfig.validationWarning}</p>}
      <form
        id="project-explainer-runtime-config"
        className="project-explainer-runtime-config"
        data-open={configEditorOpen ? "true" : "false"}
        role="dialog"
        aria-modal="true"
        onSubmit={saveRuntimeConfig}
        aria-label="Project Explainer 运行配置"
      >
        <div className="project-explainer-runtime-heading">
          <span>
            <strong>只读运行配置</strong>
            <small>仅影响后续项目问答，不影响 Main/Worker 工作流</small>
          </span>
          <span className="project-explainer-runtime-heading-actions">
            <em className={runtimeConfig?.available ? "available" : "unavailable"}>
              {configStateLabel}
            </em>
            <button
              type="button"
              className="project-explainer-config-close"
              onClick={() => setConfigEditorOpen(false)}
              aria-label="关闭 Project Explainer 配置"
            >
              关闭
            </button>
          </span>
        </div>
        {configLoading || !configDraft ? (
          <div className="project-explainer-config-loading"><LoaderCircle className="spin" size={14} />正在加载配置…</div>
        ) : (
          <>
            <div className="project-explainer-runtime-grid">
              <label>
                <span>Harness</span>
                <select
                  aria-label="Project Explainer Harness"
                  value={configDraft.harness}
                  onChange={(event) => setConfigDraft((current) => current ? {
                    ...current,
                    harness: event.target.value as AgentHarness
                  } : current)}
                >
                  {harnessOptions.length ? harnessOptions.map((item) => (
                    <option key={item.id} value={item.id} disabled={!item.available}>
                      {item.label}{item.available ? "" : `（${item.availabilityReason ?? "不可用"}）`}
                    </option>
                  )) : <option value={configDraft.harness}>{configDraft.harness}</option>}
                </select>
              </label>
              <label>
                <span>全局网关</span>
                <select
                  aria-label="Project Explainer 全局网关"
                  value={configDraft.gatewayId ?? ""}
                  onChange={(event) => selectRuntimeGateway(event.target.value)}
                >
                  <option value="">请选择已保存网关</option>
                  {(runtimeCatalog?.gateways ?? []).map((gateway) => {
                    const state = gatewayHarnessTestState(gateway, selectedHarnessId, harnessOptions);
                    return (
                      <option key={gateway.id} value={gateway.id}>
                        {gateway.name} · {state.status === "passed" ? "有已验证 model" : state.status === "failed" ? "连接验证失败" : "当前 Harness 未验证"}
                      </option>
                    );
                  })}
                </select>
              </label>
              <div className="project-explainer-derived-route" aria-live="polite"><span>网关协议与路由</span><strong>{selectedGateway ? protocolLabel(selectedGateway.protocol) : "选择网关后显示"}</strong><small>{routeNeeded && selectedHarness?.nativeProtocol && selectedGateway ? `自动路由：${protocolLabel(selectedHarness.nativeProtocol)} → ${protocolLabel(selectedGateway.protocol)}` : selectedGateway && selectedHarness?.nativeProtocol ? "直连" : selectedGateway ? "Harness 目录待确认" : "尚未推导"}</small>{combinationTestWarning && <small className="project-explainer-config-warning" role="status">{combinationTestWarning}</small>}</div>
              <label>
                <span>Model</span>
                {selectedGateway ? (
                  <select
                    aria-label="Project Explainer Model"
                    value={configDraft.model}
                    disabled={Boolean(refreshingGatewayId)}
                    onChange={(event) => setConfigDraft((current) => current ? {
                      ...current,
                      model: event.target.value
                    } : current)}
                    aria-invalid={Boolean(modelSelectionError)}
                  >
                    <option value="" disabled>请选择网关 model</option>
                    {modelTestOptions.map(({ model, test }) => (
                      <option key={model} value={model} title={test.error}>
                        {model} · {test.status === "passed" ? "已验证" : test.status === "failed" ? "验证失败" : "未验证"}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    aria-label="Project Explainer Model"
                    value={configDraft.model}
                    disabled
                    aria-invalid={Boolean(modelSelectionError)}
                  />
                )}
                {refreshingGatewayId && (
                  <small className="project-explainer-config-loading" role="status">
                    <LoaderCircle className="spin" size={12} />正在刷新 model 列表…
                  </small>
                )}
                {gatewayRefreshError && <small className="field-error" role="alert">{gatewayRefreshError}</small>}
                {modelSelectionError && <small className="field-error" role="alert">{modelSelectionError}</small>}
                {failedModelOptions.length > 0 && <small className="project-explainer-config-warning">以下 model 验证失败，仍可选择并使用：{failedModelOptions.map(({ model, test }) => `${model}${test.error ? `（${test.error}）` : ""}`).join("；")}</small>}
              </label>
            </div>
            {routeNeeded && selectedHarness?.nativeProtocol && (
              <span className="project-explainer-route-notice">
                已根据所选 harness 和网关协议自动启用本地路由；可直接保存并尝试运行。
              </span>
            )}
            {runtimeConfig?.validationError && !runtimeConfig.available && (
              <span className="project-explainer-config-error" role="alert">{runtimeConfig.validationError}</span>
            )}
            {!compatibleExplainerHarnesses.length && (
              <span className="project-explainer-config-error" role="alert">
                当前服务端没有注册可用的只读 Project Explainer Harness。
              </span>
            )}
            {compatibleExplainerHarnesses.length > 0 && !selectedHarnessCompatible && (
              <span className="project-explainer-config-error" role="alert">
                {selectedHarness?.availabilityReason ?? "当前 Harness 不支持只读 Project Explainer。"}
              </span>
            )}
            <div className="project-explainer-runtime-actions">
              <small>运行期间可修改；URL 与 API key 只在全局网关库维护。</small>
              <Button type="submit" variant="secondary" loading={configSaving} disabled={configSaving || Boolean(refreshingGatewayId) || Boolean(gatewayRefreshError) || !selectedGateway || !selectedHarnessCompatible || Boolean(modelSelectionError)}>
                保存问答配置
              </Button>
            </div>
          </>
        )}
        {configError && <span className="project-explainer-config-error" role="alert">{configError}</span>}
        {configNotice && <span className="project-explainer-config-notice" role="status"><CheckCircle2 size={13} />{configNotice}</span>}
      </form>
      <div
        className="project-explainer-transcript"
        ref={transcriptRef}
        aria-live="polite"
        aria-label="项目解说对话"
      >
        {historyLoading && !events.length ? (
          <div className="project-explainer-empty">
            <LoaderCircle className="spin" size={20} />
            正在读取解说会话…
          </div>
        ) : events.length ? (
          events.filter(isExplainerConversationMessage).map((entry) => {
            if (entry.kind === "user") {
              return (
                <div className="project-explainer-message user" key={entry.id}>
                  <small>你</small>
                  <p>{entry.text}</p>
                </div>
              );
            }
            if (entry.kind === "assistant") {
              return (
                <div className="project-explainer-message assistant" key={entry.id}>
                  <small><Bot size={12} /> {activeHarnessLabel}</small>
                  <div className="markdown-body">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm, remarkMath]}
                      rehypePlugins={[rehypeSanitize, rehypeKatex]}
                    >
                      {entry.text || (streaming ? "…" : "")}
                    </ReactMarkdown>
                  </div>
                </div>
              );
            }
            if (["reasoning", "tool", "tool_output"].includes(entry.kind)) {
              const sameCall = (event: ProjectExplainerEvent) => event.turnId === entry.turnId && event.itemId === entry.itemId;
              if (entry.kind === "tool_output" && events.some(event => event.kind === "tool" && sameCall(event))) return null;
              return <ProjectExplainerTrace key={`${entry.turnId}:${entry.kind}:${entry.itemId ?? entry.id}`} event={entry}
                output={events.filter(event => event.kind === "tool_output" && sameCall(event)).at(-1)}
                active={(streaming || remoteActive) && entry.turnId === events.at(-1)?.turnId} />;
            }
            return (
              <div
                className={`project-explainer-status ${entry.kind}`}
                key={entry.id}
                role={entry.kind === "error" ? "alert" : undefined}
              >
                {entry.kind === "error" ? <AlertTriangle size={13} /> : <Activity size={12} />}
                {entry.text}
              </div>
            );
          })
        ) : (
          <div className="project-explainer-empty">
            <Bot size={24} />
            <strong>可直接询问项目现状、实验、论文或评审依据</strong>
            <small>所选解说 Agent 只能读取本项目 workspaces，不会修改科研文件或流程。</small>
          </div>
        )}
        <ProjectExplainerReplyStatus events={events} active={streaming || remoteActive} />
      </div>
      <form className="project-explainer-compose" onSubmit={submit}>
        <textarea
          value={question}
          onChange={(event) => {
            setQuestion(event.target.value);
            if (error) setError("");
            if (resetNotice) setResetNotice("");
          }}
          onKeyDown={handleQuestionKeyDown}
          rows={2}
          maxLength={50_000}
          disabled={streaming || stopping || remoteActive || resetting || !runtimeConfig?.available}
          placeholder={
            remoteActive
              ? "另一个页面中的解说正在回答…"
              : runtimeConfig && !runtimeConfig.available
                ? "请先修复并保存上方 Project Explainer 配置…"
              : "例如：当前实验做到哪一步？论文结论由哪些结果支持？"
          }
          aria-label="向项目解说 Agent 提问"
        />
        <div>
          <small>Enter 发送 · Shift+Enter 换行</small>
          {streaming || stopping ? (
            <Button
              type="button"
              variant="secondary"
              icon={<CircleStop size={15} />}
              loading={stopping}
              onClick={() => void stopConversation()}
              disabled={stopping}
            >
              {stopping ? "停止中" : "停止"}
            </Button>
          ) : (
            <Button
              type="submit"
              variant="primary"
              icon={<Send size={15} />}
              disabled={!question.trim() || stopping || remoteActive || resetting || !runtimeConfig?.available}
            >
              询问解说
            </Button>
          )}
        </div>
        {error && <span className="project-explainer-error" role="alert">{error}</span>}
        {resetNotice && (
          <span className="project-explainer-reset-notice" role="status">
            <CheckCircle2 size={13} />
            {resetNotice}
          </span>
        )}
      </form>
    </section>
  );
}

export function WorkspacePage({
  projectId,
  onBack
}: {
  projectId: string;
  onBack: () => void;
}) {
  const [project, setProject] = useState<Project>();
  const [projectLoading, setProjectLoading] = useState(true);
  const [projectError, setProjectError] = useState("");
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [artifactDirectoryEntries, setArtifactDirectoryEntries] = useState<
    ArtifactDirectoryEntry[]
  >([]);
  const [artifactDirectory, setArtifactDirectory] = useState("");
  const [artifactDirectoryTotal, setArtifactDirectoryTotal] = useState(0);
  const [artifactSummary, setArtifactSummary] = useState<ArtifactCatalogSummary>();
  const [artifactCatalogRevision, setArtifactCatalogRevision] = useState(0);
  const [artifactHasMore, setArtifactHasMore] = useState(false);
  const [artifactOffset, setArtifactOffset] = useState(0);
  const [artifactQuery, setArtifactQuery] = useState("");
  const [artifactSearchQuery, setArtifactSearchQuery] = useState("");
  const [artifactPageLoading, setArtifactPageLoading] = useState(false);
  const [artifactsLoading, setArtifactsLoading] = useState(true);
  const [artifactsError, setArtifactsError] = useState("");
  const [queue, setQueue] = useState<QueueSnapshot>();
  const [queueError, setQueueError] = useState("");
  const [tab, setTab] = useState<CenterTab>("trace");
  const [actionLoading, setActionLoading] = useState<
    "pause" | "resume" | "cancel" | undefined
  >();
  const [actionError, setActionError] = useState("");
  const [userResponse, setUserResponse] = useState("");
  const [userResponseLoading, setUserResponseLoading] = useState(false);
  const [userResponseError, setUserResponseError] = useState("");
  const [projectUserInput, setProjectUserInput] = useState("");
  const [projectUserInputLoading, setProjectUserInputLoading] = useState(false);
  const [projectUserInputError, setProjectUserInputError] = useState("");
  const [projectUserInputNotice, setProjectUserInputNotice] = useState("");
  const [projectUserInputMode, setProjectUserInputMode] = useState<"wait" | "interrupt">("wait");
  const projectUserInputRequestId = useRef<string>();
  const [modelOptions, setModelOptions] = useState<string[]>(DEFAULT_MODELS);
  const [workflowHarnessCatalog, setWorkflowHarnessCatalog] = useState<HarnessCatalogEntry[]>([]);
  const [recommendationGateways, setRecommendationGateways] = useState<GatewayRecord[]>([]);
  const [skillOptions, setSkillOptions] = useState<SkillDefinition[]>([]);
  const [agentPromptDefaults, setAgentPromptDefaults] = useState<Record<string, string>>({});
  const [mainSystemPrompt, setMainSystemPrompt] = useState("");
  const [mcpDirectory, setMcpDirectory] = useState<FixedMcpDefinition[]>([]);
  const [modelEditorOpen, setModelEditorOpen] = useState(false);
  const [workflowAdjustmentOpen, setWorkflowAdjustmentOpen] = useState(false);
  const [modelUpdateLoading, setModelUpdateLoading] = useState(false);
  const [modelUpdateError, setModelUpdateError] = useState("");
  const [modelUpdateNotice, setModelUpdateNotice] = useState("");
  const [groupEditorOpen, setGroupEditorOpen] = useState(false);
  const [groupUpdateLoading, setGroupUpdateLoading] = useState(false);
  const [groupUpdateError, setGroupUpdateError] = useState("");
  const [groupUpdateNotice, setGroupUpdateNotice] = useState("");
  const [cancelOpen, setCancelOpen] = useState(false);
  const [mobileMenu, setMobileMenu] = useState(false);
  const artifactRequestRef = useRef(0);
  const artifactSummaryRequestRef = useRef(0);
  const artifactFilterKeyRef = useRef("");
  const publishedArtifactKeyRef = useRef<string>();
  const processedEventSeqRef = useRef(0);
  const projectRequestRef = useRef(0);
  const projectRefreshRef = useRef<{ projectId: string; scheduler: ReturnType<typeof createProjectRefreshScheduler> }>();
  const artifactSummaryRefreshRef = useRef<{ projectId: string; scheduler: ReturnType<typeof createProjectRefreshScheduler> }>();
  const queueLoadInFlightRef = useRef(false);
  const eventStream = useProjectEvents(projectId);
  const { events, connection } = eventStream;
  const timelineEvents = eventStream.timelineEvents ?? events;
  const livePerformance = eventStream.live.projectId === projectId ? eventStream.live.performance : undefined;
  const performanceEvents = useMemo(() => eventStream.live.projectId === projectId ? timelineEvents : [],
    [projectId, eventStream.live.projectId, timelineEvents]);
  const performanceResults = useProjectPerformance(projectId, project?.id === projectId ? project.performance : undefined,
    performanceEvents, livePerformance);
  // Derive one immutable runtime overlay for all consumers.  The rail,
  // invocation map and canvas therefore cannot disagree about the current
  // node, candidate edges or retry state during an SSE update.
  const workflowRuntime = useMemo<WorkflowRuntimeState | undefined>(
    () => project ? buildWorkflowRuntimeState(project, timelineEvents) : undefined,
    [project, timelineEvents]
  );
  const totalEventCount = eventStream.totalEvents ?? events.length;
  const recentOperationalEvents = useMemo(
    () => events.slice(-DEFAULT_TRACE_DISPLAY_LIMIT),
    [events]
  );

  useEffect(() => {
    const runtime = eventStream.live.runtime;
    if (!runtime) return;
    setProject((current) => {
      if (!current || current.id !== projectId ||
        (current.runtime?.stateRevision ?? -1) > runtime.stateRevision) return current;
      return applyLiveRuntimeSnapshot(current, runtime);
    });
  }, [eventStream.live.runtime, projectId]);

  const fetchProjectSnapshot = useCallback(async () => {
    const request = ++projectRequestRef.current;
    try {
      const result = await getProject(projectId);
      if (request !== projectRequestRef.current) return;
      setProject((current) => mergeProjectSnapshot(current, result));
      setProjectError("");
    } catch (reason) {
      if (request === projectRequestRef.current) setProjectError(reason instanceof Error ? reason.message : "项目加载失败");
    } finally {
      if (request === projectRequestRef.current) setProjectLoading(false);
    }
  }, [projectId]);

  const getProjectRefresh = useCallback(() => {
    if (projectRefreshRef.current?.projectId !== projectId) {
      projectRefreshRef.current?.scheduler.dispose();
      projectRefreshRef.current = { projectId, scheduler: createProjectRefreshScheduler(fetchProjectSnapshot) };
    }
    return projectRefreshRef.current.scheduler;
  }, [projectId, fetchProjectSnapshot]);
  const loadProject = useCallback(() => getProjectRefresh().refresh(), [getProjectRefresh]);
  const scheduleProjectRefresh = useCallback(() => getProjectRefresh().schedule(), [getProjectRefresh]);

  useEffect(() => {
    if (!eventStream.live.runtime) return;
    scheduleProjectRefresh();
  }, [eventStream.live.runtime?.stateRevision, scheduleProjectRefresh]);

  const fetchArtifactSummary = useCallback(async () => {
    const requestId = ++artifactSummaryRequestRef.current;
    const summaryLoader = getArtifactSummary as unknown as
      | ((id: string, options: { scope: "project" }) => Promise<ArtifactCatalogSummary>)
      | undefined;
    try {
      if (typeof summaryLoader === "function") {
        const summary = await summaryLoader(projectId, { scope: "project" });
        if (requestId !== artifactSummaryRequestRef.current) return;
        setArtifactSummary(summary);
        setArtifactCatalogRevision(revision => revision + 1);
      }
      if (requestId === artifactSummaryRequestRef.current) setArtifactsError("");
    } catch (reason) {
      if (requestId === artifactSummaryRequestRef.current) setArtifactsError(reason instanceof Error ? reason.message : "产物加载失败");
    } finally {
      if (requestId === artifactSummaryRequestRef.current) setArtifactsLoading(false);
    }
  }, [projectId]);

  const getArtifactSummaryRefresh = useCallback(() => {
    if (artifactSummaryRefreshRef.current?.projectId !== projectId) {
      artifactSummaryRefreshRef.current?.scheduler.dispose();
      artifactSummaryRefreshRef.current = { projectId, scheduler: createProjectRefreshScheduler(fetchArtifactSummary) };
    }
    return artifactSummaryRefreshRef.current.scheduler;
  }, [projectId, fetchArtifactSummary]);
  const loadArtifactSummary = useCallback(() => getArtifactSummaryRefresh().refresh(), [getArtifactSummaryRefresh]);
  const scheduleArtifactSummaryRefresh = useCallback(() => getArtifactSummaryRefresh().schedule(), [getArtifactSummaryRefresh]);

  const loadArtifactSearchPage = useCallback(
    async (offset: number, append: boolean) => {
      const requestId = ++artifactRequestRef.current;
      setArtifactPageLoading(true);
      try {
        const pageLoader = getArtifactPage as unknown as
          | ((id: string, options: {
              scope: "project";
              offset: number;
              limit: number;
              query?: string;
            }) => Promise<ArtifactCatalogPage>)
          | undefined;
        const page =
          typeof pageLoader === "function"
            ? await pageLoader(projectId, {
                scope: "project",
                offset,
                limit: ARTIFACT_PAGE_SIZE,
                query: artifactSearchQuery
              })
            : (() => {
                throw new Error("paged artifact endpoint is unavailable");
              })();
        if (requestId !== artifactRequestRef.current) return;
        setArtifacts((current) => {
          if (!append) return page.artifacts;
          const merged = new Map(current.map((item) => [item.path, item]));
          for (const item of page.artifacts) merged.set(item.path, item);
          return [...merged.values()];
        });
        setArtifactOffset(page.offset + page.artifacts.length);
        setArtifactHasMore(page.hasMore);
        setArtifactsError("");
      } catch (reason) {
        if (requestId !== artifactRequestRef.current) return;
        setArtifactsError(
          reason instanceof Error ? reason.message : "产物加载失败"
        );
      } finally {
        if (requestId === artifactRequestRef.current) setArtifactPageLoading(false);
      }
    },
    [artifactSearchQuery, projectId]
  );

  const loadArtifactDirectory = useCallback(
    async (
      directory: string,
      offset: number,
      append: boolean
    ) => {
      const requestId = ++artifactRequestRef.current;
      setArtifactPageLoading(true);
      try {
        const pageLoader = getArtifactDirectory as unknown as
          | ((id: string, options: {
              scope: "project";
              directory: string;
              offset: number;
              limit: number;
            }) => Promise<ArtifactDirectoryPage>)
          | undefined;
        if (typeof pageLoader !== "function") {
          throw new Error("Artifact directory endpoint is unavailable");
        }
        const page = await pageLoader(projectId, {
          scope: "project",
          directory,
          offset,
          limit: ARTIFACT_DIRECTORY_PAGE_SIZE
        });
        if (requestId !== artifactRequestRef.current) return;
        setArtifactDirectoryEntries((current) => {
          if (!append) return page.entries;
          const merged = new Map(
            current.map((entry) => [artifactDirectoryEntryKey(entry), entry])
          );
          for (const entry of page.entries) {
            merged.set(artifactDirectoryEntryKey(entry), entry);
          }
          return [...merged.values()];
        });
        setArtifacts([]);
        setArtifactDirectory(page.directory);
        setArtifactDirectoryTotal(page.total);
        setArtifactOffset(
          page.hasMore
            ? page.offset + page.limit
            : page.offset + page.entries.length
        );
        setArtifactHasMore(page.hasMore);
        setArtifactsError("");
      } catch (reason) {
        if (requestId !== artifactRequestRef.current) return;
        setArtifactsError(
          reason instanceof Error ? reason.message : "产物文件夹加载失败"
        );
      } finally {
        if (requestId === artifactRequestRef.current) {
          setArtifactPageLoading(false);
        }
      }
    },
    [projectId]
  );

  const loadQueue = useCallback(async () => {
    if (queueLoadInFlightRef.current) return;
    queueLoadInFlightRef.current = true;
    try {
      const nextQueue = await getQueue();
      setQueue((current) =>
        current && JSON.stringify(current) === JSON.stringify(nextQueue)
          ? current
          : nextQueue
      );
      setQueueError("");
    } catch (reason) {
      setQueueError(reason instanceof Error ? reason.message : "队列快照加载失败");
    } finally {
      queueLoadInFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    setProjectLoading(true);
    artifactRequestRef.current += 1;
    publishedArtifactKeyRef.current = undefined;
    setArtifactsLoading(true);
    setArtifactSummary(undefined);
    setArtifacts([]);
    setArtifactDirectoryEntries([]);
    setArtifactDirectory("");
    setArtifactDirectoryTotal(0);
    setArtifactQuery("");
    setArtifactSearchQuery("");
    setArtifactOffset(0);
    setArtifactHasMore(false);
    void loadProject();
    void loadArtifactSummary();
  }, [loadArtifactSummary, loadProject]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setArtifactSearchQuery(artifactQuery.trim());
    }, 350);
    return () => window.clearTimeout(timer);
  }, [artifactQuery]);

  useEffect(() => {
    if (tab !== "artifacts") return;
    const filterKey = JSON.stringify([projectId, artifactDirectory, artifactSearchQuery]);
    if (artifactFilterKeyRef.current !== filterKey) {
      artifactFilterKeyRef.current = filterKey;
      setArtifacts([]);
      setArtifactDirectoryEntries([]);
      setArtifactOffset(0);
      setArtifactHasMore(false);
    }
    if (artifactSearchQuery) {
      void loadArtifactSearchPage(0, false);
    } else {
      void loadArtifactDirectory(artifactDirectory, 0, false);
    }
  }, [
    artifactDirectory,
    artifactSearchQuery,
    loadArtifactDirectory,
    loadArtifactSearchPage,
    artifactCatalogRevision,
    projectId,
    tab
  ]);

  // Publications arrive through both serial events and Git state projections.
  // Refresh the open browser as well, including files written between events.
  const publishedArtifactKey = JSON.stringify(project?.artifacts ?? []);
  useEffect(() => {
    if (publishedArtifactKeyRef.current !== undefined && publishedArtifactKeyRef.current !== publishedArtifactKey) scheduleArtifactSummaryRefresh();
    publishedArtifactKeyRef.current = publishedArtifactKey;
  }, [publishedArtifactKey, scheduleArtifactSummaryRefresh]);
  useEffect(() => {
    if (tab !== "artifacts") return;
    void loadArtifactSummary();
    const refresh = () => { if (document.visibilityState === "visible") scheduleArtifactSummaryRefresh(); };
    const timer = window.setInterval(refresh, 5000);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", refresh); };
  }, [tab, loadArtifactSummary, scheduleArtifactSummaryRefresh]);

  useEffect(() => {
    let active = true;
    void getCatalog()
      .then((catalog) => {
        if (!active) return;
        if (catalog.models.length > 0) setModelOptions(catalog.models);
        setWorkflowHarnessCatalog(catalog.harnesses ?? []);
        setRecommendationGateways(catalog.gateways ?? []);
        setSkillOptions(catalog.skills.filter((skill) => !isLarkSkill(skill)));
        setAgentPromptDefaults(catalog.agentPrompts);
        setMainSystemPrompt(catalog.mainSystemPrompt ?? "");
        setMcpDirectory(catalog.mcpDirectory ?? []);
      })
      .catch(() => {
        // The built-in suggestions remain available when catalog discovery fails.
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    void loadQueue();
    const refresh = () => {
      if (document.visibilityState === "visible") void loadQueue();
    };
    const timer = window.setInterval(refresh, 5_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [loadQueue]);

  useEffect(() => {
    const usageTimer = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadProject();
    }, 10 * 60_000);
    return () => window.clearInterval(usageTimer);
  }, [loadProject]);

  useEffect(() => {
    const unseen = events.filter((event) => event.seq > processedEventSeqRef.current);
    if (!unseen.length) return;
    processedEventSeqRef.current = Math.max(
      processedEventSeqRef.current,
      ...unseen.map((event) => event.seq)
    );
    // The SSE hook intentionally commits live events in batches. Inspect the
    // whole unseen suffix: a trailing trace event must never hide an earlier
    // durable state transition in the same React update.
    if (unseen.some(isProjectSnapshotRefreshEvent)) {
      scheduleProjectRefresh();
    }
    if (unseen.some((event) => {
      const type = event.type.toLowerCase();
      return type.includes("artifact") || type.includes("file");
    })) {
      scheduleArtifactSummaryRefresh();
    }
  }, [events, scheduleArtifactSummaryRefresh, scheduleProjectRefresh]);

  useEffect(() => {
    processedEventSeqRef.current = 0;
    return () => {
      projectRequestRef.current += 1;
      artifactSummaryRequestRef.current += 1;
      if (projectRefreshRef.current?.projectId === projectId) {
        projectRefreshRef.current.scheduler.dispose();
        projectRefreshRef.current = undefined;
      }
      if (artifactSummaryRefreshRef.current?.projectId === projectId) {
        artifactSummaryRefreshRef.current.scheduler.dispose();
        artifactSummaryRefreshRef.current = undefined;
      }
    };
  }, [projectId]);

  const doAction = async (action: "pause" | "resume" | "cancel") => {
    setActionLoading(action);
    setActionError("");
    try {
      await projectAction(projectId, action);
      await loadProject();
      if (action === "cancel") setCancelOpen(false);
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : "操作失败");
    } finally {
      setActionLoading(undefined);
    }
  };

  const submitUserResponse = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const message = userResponse.trim();
    if (!message) {
      setUserResponseError("请输入回复内容。");
      return;
    }
    setUserResponseLoading(true);
    setUserResponseError("");
    try {
      const updated = await respondToUserIntervention(projectId, message);
      setProject(updated);
      setUserResponse("");
      await loadProject();
    } catch (reason) {
      setUserResponseError(
        reason instanceof Error ? reason.message : "回复发送失败"
      );
    } finally {
      setUserResponseLoading(false);
    }
  };

  const submitProjectUserInput = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const message = projectUserInput.trim();
    if (!message) {
      setProjectUserInputError("请输入要补充的科研需求。");
      return;
    }
    setProjectUserInputLoading(true);
    setProjectUserInputError("");
    setProjectUserInputNotice("");
    const restartsCompletedProject = project?.status === "completed";
    const interruptingRunningAgent =
      projectUserInputMode === "interrupt" && project?.status === "running" && Boolean(project.currentAgent);
    const requestId = projectUserInputRequestId.current ?? (
      `ui-${typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`
    );
    projectUserInputRequestId.current = requestId;
    try {
      const updated = projectUserInputMode === "wait"
        ? await addProjectUserInput(projectId, message)
        : await addProjectUserInput(projectId, message, {
            mode: projectUserInputMode,
            requestId
          });
      setProject(updated);
      setProjectUserInput("");
      projectUserInputRequestId.current = undefined;
      setProjectUserInputNotice(
        restartsCompletedProject
          ? "需求已提交给 main，科研流程已重新启动；历史结果仍可查看。"
          : interruptingRunningAgent
            ? "需求已持久化，正在中断当前 Agent 并保存断点；完成后由 Main 接管。"
            : "需求已提交，当前 Agent 完成后将以包含该输入的新上下文重新启动，并将在下一次 main 调度时自动送达。"
      );
    } catch (reason) {
      setProjectUserInputError(
        reason instanceof Error ? reason.message : "主动需求提交失败"
      );
    } finally {
      setProjectUserInputLoading(false);
    }
  };

  const applyAgentConfigs = async (
    agents: Partial<Record<AgentName, AgentRuntimeConfigDraft>>
  ): Promise<boolean> => {
    setModelUpdateLoading(true);
    setModelUpdateError("");
    setModelUpdateNotice("");
    try {
      const updated = await updateProjectAgentConfigs(projectId, agents);
      setProject(updated);
      setModelUpdateNotice(
        `已更新 ${Object.keys(agents).length} 个 Agent 的模型、网关思考强度、Prompt、Skills 与 MCP；后续调用将使用新配置。`
      );
      return true;
    } catch (reason) {
      setModelUpdateError(
        reason instanceof Error ? reason.message : "Agent 配置保存失败"
      );
      return false;
    } finally {
      setModelUpdateLoading(false);
    }
  };

  const applyCollaborationGroupUpdate = async (
    input: CollaborationGroupUpdateIntent
  ): Promise<boolean> => {
    setGroupUpdateLoading(true);
    setGroupUpdateError("");
    setGroupUpdateNotice("");
    const requestId = `ui-workflow-${typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
    try {
      const updated = await updateProjectCollaborationGroup(projectId, {
        ...input,
        requestId
      });
      setProject(updated);
      setGroupUpdateNotice(
        input.action === "dissolve"
          ? `协作组已解散；Agent 与历史记录均已保留，后续运行使用 workflow revision ${updated.workflowRevision ?? "最新"}。`
          : `已更新协作组名称；后续运行使用 workflow revision ${updated.workflowRevision ?? "最新"}。`
      );
      return true;
    } catch (reason) {
      setGroupUpdateError(
        reason instanceof Error ? reason.message : "协作组配置保存失败"
      );
      return false;
    } finally {
      setGroupUpdateLoading(false);
    }
  };

  const addSkillCandidate = async (title: string, content: string) => {
    if (title.trim().toLowerCase().startsWith("lark")) {
      throw new Error("Lark Skills 不在科研 Agent 的候选范围内");
    }
    const skill = await createUserSkill(title, content);
    if (isLarkSkill(skill)) {
      throw new Error("Lark Skills 不在科研 Agent 的候选范围内");
    }
    setSkillOptions((current) =>
      current.some((item) => item.id === skill.id)
        ? current
        : [...current, skill]
    );
    return skill;
  };

  const openModelEditor = () => {
    setModelUpdateError("");
    setModelUpdateNotice("");
    setModelEditorOpen(true);
  };

  const openGroupEditor = () => {
    if (project && project.status !== "draft") { setWorkflowAdjustmentOpen(true); return; }
    setGroupUpdateError("");
    setGroupUpdateNotice("");
    setGroupEditorOpen(true);
  };

  if (projectLoading && !project) {
    return (
      <div className="workspace-loading">
        <Brand compact />
        <PageLoader label="正在进入科研工作台…" />
      </div>
    );
  }
  if (!project) {
    return (
      <main className="workspace-fatal">
        <Brand />
        <ErrorPanel
          title="无法打开项目"
          message={projectError || "未找到该科研项目"}
          action={<Button onClick={onBack}>返回项目列表</Button>}
        />
      </main>
    );
  }

  const waitingForUser =
    project.phase === "user-intervention-required" &&
    project.userIntervention?.status === "pending";
  const mainRecoveryRequired =
    project.status === "paused" &&
    project.phase === "main-recovery-required";
  const gatewayRecoveryRequired =
    project.status === "paused" &&
    project.phase === "gateway-recovery-required";
  const canPause =
    !mainRecoveryRequired &&
    ["running", "queued", "retrying"].includes(project.status);
  const canResume =
    !waitingForUser &&
    !mainRecoveryRequired &&
    ["paused", "pausing", "interrupted"].includes(project.status);
  const canCancel = !mainRecoveryRequired && [
    "running",
    "queued",
    "retrying",
    "interrupted",
    "pausing",
    "paused"
  ].includes(project.status);
  const canAddProjectUserInput = ![
    "cancelled",
    "cancelling",
    "stopped",
    "failed"
  ].includes(project.status);
  const pendingProjectUserInputs = (project.userInputs ?? []).filter(
    (input) => input.status === "pending"
  );
  const performanceProject = { ...project, performance: performanceResults };
  const metrics = resolvePerformanceMetrics(performanceResults, livePerformance, project.status);

  return (
    <main className="workspace-page">
      <header className="workspace-header">
        <div className="workspace-brand-zone">
          <button className="back-icon-button" onClick={onBack} title="返回项目列表">
            <ArrowLeft size={18} />
          </button>
          <Brand compact />
          <i />
          <div className="workspace-title">
            <h1>{project.title}</h1>
            <span>
              <StatusBadge status={project.status} runtime={project.runtime} />
              <small>更新于 {formatRelativeTime(project.updatedAt)}</small>
              <code>{project.id}</code>
            </span>
          </div>
        </div>
        <div
          id="workspace-action-controls"
          className={`workspace-controls ${mobileMenu ? "mobile-open" : ""}`}
        >
          {project.status !== "draft" && <Button variant="secondary" icon={<GitBranch size={16} />} onClick={() => setWorkflowAdjustmentOpen(true)}>查看与调整 Workflow</Button>}
          {mainRecoveryRequired && (
            <Button
              variant="primary"
              icon={<RefreshCw size={16} />}
              loading={actionLoading === "resume"}
              onClick={() => void doAction("resume")}
            >
              恢复 Main
            </Button>
          )}
          {canPause && (
            <Button
              variant="secondary"
              icon={<Pause size={16} />}
              loading={actionLoading === "pause"}
              onClick={() => void doAction("pause")}
            >
              暂停
            </Button>
          )}
          {canResume && (
            <Button
              variant="primary"
              icon={<Play size={16} />}
              loading={actionLoading === "resume"}
              onClick={() => void doAction("resume")}
            >
              {project.status === "interrupted"
                ? "从断点恢复"
                : project.status === "pausing"
                  ? "撤销暂停"
                  : "继续"}
            </Button>
          )}
          {canCancel && (
            <Button
              variant="ghost"
              icon={<CircleStop size={16} />}
              onClick={() => setCancelOpen(true)}
              className="stop-control"
            >
              停止
            </Button>
          )}
        </div>
        <button
          className="mobile-menu-button"
          onClick={() => setMobileMenu((value) => !value)}
          aria-label="项目控制"
          title="项目控制"
          aria-expanded={mobileMenu}
          aria-controls="workspace-action-controls"
        >
          <Menu size={20} />
        </button>
      </header>

      <WorkflowRail project={project} events={timelineEvents} runtime={workflowRuntime} />
      <div className="workspace-progress-strip">
        <OverallProgressBar progress={project.overallProgress} />
        <div className="workspace-performance-summary" role="region" aria-label="当前输出性能">
          <span>
            <small>输出性能</small>
            <strong>{metrics.current?.agent ?? project.currentAgent ?? performanceResults.latest?.agent ?? "等待调用"}</strong>
          </span>
          <PerformanceMetrics
            performance={metrics.current}
            averageFallback={metrics.average}
            latestToken={metrics.latestToken}
            compact
          />
        </div>
        <div className="workspace-phase-meta">
          <span>
            <small>当前阶段</small>
            <strong>{project.runtime?.waiting?.reason ?? displayPhase(project.phase)}</strong>
          </span>
          <span>
            <small>任务步数</small>
            <strong>Turn {project.turn}</strong>
          </span>
          {project.runtime?.primaryActivity && (
            <span title={project.runtime.primaryActivity.invocationId}>
              <small>活动调用</small>
              <strong>
                {project.runtime.primaryActivity.invocationId.slice(0, 12)}
                {project.runtime.activityStartedAt
                  ? ` · ${new Date(project.runtime.activityStartedAt).toLocaleTimeString()}`
                  : ""}
              </strong>
            </span>
          )}
          {project.queuedAgent && !waitingForUser && (
            <span>
              <small>
                {project.status === "interrupted"
                  ? "恢复断点"
                  : `${displayAgentName(project.queuedAgent)} 队列`}
              </small>
              <strong>
                {project.status === "interrupted"
                  ? displayAgentName(project.queuedAgent)
                  : project.queuePosition
                    ? `#${project.queuePosition}`
                    : "等待中"}
                {project.status !== "interrupted" && project.queueDepth
                  ? ` / ${project.queueDepth}`
                  : ""}
              </strong>
            </span>
          )}
        </div>
      </div>

      <div className="project-interaction-grid">
        <section
          className="project-user-input-panel"
          aria-label="项目主动需求输入"
        >
        <span className="project-user-input-icon">
          <MessageSquareText size={21} />
        </span>
        <div className="project-user-input-content">
          <div className="project-user-input-heading">
            <div>
              <span className="section-kicker main-kicker">用户主动需求 · main</span>
              <h2>新增科研需求</h2>
            </div>
            {pendingProjectUserInputs.length > 0 && (
              <span className="project-user-input-count">
                待投递 {pendingProjectUserInputs.length} 条
              </span>
            )}
          </div>
          <p>
            {project.status === "completed"
              ? "输入会保留在当前项目并由 main 重新启动科研流程。历史结果仍可查看，main 会根据新的需求重新安排工作。"
              : project.status === "running" && project.currentAgent === SYSTEM_CONTROLLER_AGENT
                ? "输入会先持久化，当前 main 完成后直接进入新一轮工作上下文（包含该输入）；不会中断正在进行的调用。"
                : "输入会保存在当前科研任务中，不中断正在工作的 Agent；当前调用完成后进入新一轮工作上下文，并在下一次 main 调度时作为用户上下文送达。"}
          </p>
          {pendingProjectUserInputs.length > 0 && (
            <div className="project-user-input-pending" aria-label="待投递用户需求">
              {pendingProjectUserInputs.slice(-3).map((input) => (
                <span key={input.id} title={input.message}>
                  {input.message}
                </span>
              ))}
            </div>
          )}
          {canAddProjectUserInput ? (
            <form onSubmit={submitProjectUserInput}>
              <label htmlFor="project-user-input">
                补充要求、调整方向或添加约束
              </label>
              <fieldset
                className="project-user-input-mode"
                aria-label="主动需求处理模式"
                disabled={projectUserInputLoading || project.status === "interrupting"}
              >
                <legend>送达方式</legend>
                <label className="project-user-input-mode-option mode-wait">
                  <input
                    type="radio"
                    name="project-user-input-mode"
                    value="wait"
                    checked={projectUserInputMode === "wait"}
                    onChange={() => setProjectUserInputMode("wait")}
                  />
                  <span className="project-user-input-mode-copy">
                    <span><strong>等待当前 Agent 完成</strong><em>推荐</em></span>
                    <small>保留当前调用，完成后唤起 Main</small>
                  </span>
                </label>
                <label className="project-user-input-mode-option mode-interrupt">
                  <input
                    type="radio"
                    name="project-user-input-mode"
                    value="interrupt"
                    checked={projectUserInputMode === "interrupt"}
                    onChange={() => setProjectUserInputMode("interrupt")}
                    disabled={!(project.status === "running" && Boolean(project.currentAgent))}
                  />
                  <span className="project-user-input-mode-copy">
                    <span><strong>立即中断当前 Agent</strong><em>立即接管</em></span>
                    <small>保存断点与部分输出，再由 Main 接管</small>
                  </span>
                </label>
              </fieldset>
              <div className="project-user-input-compose">
                <textarea
                  id="project-user-input"
                  value={projectUserInput}
                  onChange={(event) => {
                    setProjectUserInput(event.target.value);
                    if (projectUserInputError) setProjectUserInputError("");
                    if (projectUserInputNotice) setProjectUserInputNotice("");
                  }}
                  rows={3}
                  maxLength={100_000}
                  placeholder="例如：新增一个消融实验，并优先比较不同训练数据规模下的表现。"
                />
                <Button
                  type="submit"
                  variant="primary"
                  icon={<Send size={16} />}
                  loading={projectUserInputLoading}
                  disabled={!projectUserInput.trim()}
                >
                  提交给 main
                </Button>
              </div>
              <small>内容会持久化到项目记录；请勿输入密码、Token 或私钥。</small>
              {projectUserInputError && (
                <span className="project-user-input-error" role="alert">
                  {projectUserInputError}
                </span>
              )}
              {projectUserInputNotice && (
                <span className="project-user-input-notice" role="status">
                  <CheckCircle2 size={14} />
                  {projectUserInputNotice}
                </span>
              )}
            </form>
          ) : (
            <small>该科研任务已经结束，不能再添加待处理需求。</small>
          )}
        </div>
        </section>
        {workflowHarnessCatalog.some((item) => item.available && harnessSupportsPurpose(item, "explainer")) && (
          <ProjectExplainerPanel projectId={projectId} />
        )}
      </div>

      {project.status === "interrupted" && !project.interruptionSnapshot && (
        <section className="checkpoint-recovery-banner" aria-label="项目断点恢复">
          <span className="checkpoint-recovery-icon">
            <RotateCcw size={21} />
          </span>
          <div>
            <strong>
              {project.queuedAgent
                ? `${agentMeta(
                    project.queuedAgent,
                    agentTemplateFor(project.orchestration, project.queuedAgent)
                  ).name}运行时被中断`
                : "科研流程运行时被中断"}
            </strong>
            <p>
              已完成步骤、Agent 交接消息和研究产物均已保存。恢复后会重新运行中断
              Agent，并继续原有科研流程。
            </p>
            {project.interruptedAt && (
              <small>断点时间：{formatClock(project.interruptedAt)}</small>
            )}
          </div>
          <Button
            variant="primary"
            icon={<Play size={16} />}
            loading={actionLoading === "resume"}
            onClick={() => void doAction("resume")}
          >
            一键恢复科研流程
          </Button>
        </section>
      )}

      {mainRecoveryRequired && (
        <section
          className="checkpoint-recovery-banner main-recovery-banner"
          aria-label="Main 恢复"
        >
          <span className="checkpoint-recovery-icon">
            <AlertTriangle size={21} />
          </span>
          <div>
            <strong>Main 自动重试后仍未成功</strong>
            <p>
              项目已暂停。恢复会继续原有的持久 Main thread，并保留当前全局上下文与待处理决策；配置不会改变。
            </p>
            {project.error && <small>{project.error}</small>}
          </div>
          <Button
            variant="primary"
            icon={<RefreshCw size={16} />}
            loading={actionLoading === "resume"}
            onClick={() => void doAction("resume")}
          >
            恢复 Main
          </Button>
        </section>
      )}

      {gatewayRecoveryRequired && (
        <section
          className="checkpoint-recovery-banner main-recovery-banner"
          aria-label="网关恢复"
        >
          <span className="checkpoint-recovery-icon">
            <AlertTriangle size={21} />
          </span>
          <div>
            <strong>网关工具参数连续异常</strong>
            <p>
              系统已自动更换一次同 Harness Session，但网关仍返回了无法解析的工具参数，项目已安全暂停。重新尝试会保留项目上下文与现有成果，并从新的 Session 继续；若反复出现，请检查网关或模型服务。
            </p>
            {project.error && <small>{project.error}</small>}
          </div>
          <Button
            variant="primary"
            icon={<RefreshCw size={16} />}
            loading={actionLoading === "resume"}
            onClick={() => void doAction("resume")}
          >
            重新尝试
          </Button>
        </section>
      )}

      {waitingForUser && project.userIntervention && (
        <section
          className="user-intervention-banner"
          aria-label="用户介入请求"
        >
          <span className="user-intervention-icon">
            <MessageSquareText size={23} />
          </span>
          <div className="user-intervention-content">
            <span className="section-kicker main-kicker">需要用户处理 · main</span>
            <h2>科研流程需要用户介入</h2>
            <p className="user-intervention-message">
              {project.userIntervention.message}
            </p>
            {project.userIntervention.rationale && (
              <div className="user-intervention-rationale">
                <strong>为什么需要介入</strong>
                <p>{project.userIntervention.rationale}</p>
              </div>
            )}
            {project.userIntervention.successCriteria.length > 0 && (
              <div className="user-intervention-criteria">
                <strong>请确认以下事项</strong>
                <ul>
                  {project.userIntervention.successCriteria.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            )}
            <form onSubmit={submitUserResponse}>
              <label htmlFor="user-intervention-response">
                回复流程
              </label>
              <textarea
                id="user-intervention-response"
                value={userResponse}
                onChange={(event) => {
                  setUserResponse(event.target.value);
                  if (userResponseError) setUserResponseError("");
                }}
                rows={4}
                maxLength={100_000}
                placeholder="例如：我已在终端完成 GitHub 登录，请重新检查。"
              />
              <small>
                请在外部完成登录或授权；不要在这里粘贴密码、Token、API Key 或私钥。
              </small>
              {userResponseError && (
                <span className="user-intervention-error" role="alert">
                  {userResponseError}
                </span>
              )}
              <Button
                type="submit"
                variant="primary"
                icon={<Send size={16} />}
                loading={userResponseLoading}
                disabled={!userResponse.trim()}
              >
                回复并继续科研流程
              </Button>
            </form>
          </div>
        </section>
      )}

      {actionError && (
        <div className="workspace-action-error" role="alert">
          <AlertTriangle size={16} />
          <span>{actionError}</span>
          <button onClick={() => setActionError("")}><X size={15} /></button>
        </div>
      )}
      {modelUpdateNotice && (
        <div className="workspace-action-success" role="status">
          <CheckCircle2 size={16} />
          <span>{modelUpdateNotice}</span>
          <button onClick={() => setModelUpdateNotice("")} aria-label="关闭模型更新提示">
            <X size={15} />
          </button>
        </div>
      )}
      {projectError && (
        <div className="workspace-stale-warning">
          <CloudOff size={15} />
          项目快照更新失败：{projectError}。实时轨迹仍会继续尝试连接。
        </div>
      )}
      {queueError && (
        <div className="workspace-stale-warning">
          <CloudOff size={15} />
          队列快照更新失败：{queueError}。任务状态仍会继续实时更新。
        </div>
      )}

      {project.status === "cancelled" && project.cancelReason && (
        <div className="workspace-stale-warning" role="status">
          {project.overallProgress.label} · {project.cancellationSettledAt ? "取消已收尾" : "等待取消收尾"}
        </div>
      )}
      {["cancelled", "paused", "interrupted", "failed"].includes(project.status) && project.workspaceCheckpoints?.some((entry) => entry.fileCount > 0) && (
        <div className="workspace-stale-warning" role="status">
          <strong>可恢复工作区文件（未验收）</strong>
          <span>清单记录文件路径与校验值，文件仍位于共享工作区；这些文件不代表正式交付。</span>
          {project.workspaceCheckpoints.filter((entry) => entry.fileCount > 0).slice(-3).reverse().map((entry) => (
            <a key={entry.id} href={`/api/projects/${encodeURIComponent(project.id)}/checkpoints/${entry.id}`} target="_blank" rel="noreferrer">
              {entry.agent} · {entry.fileCount} 个文件{entry.incomplete ? "（清单不完整）" : ""} · 查看清单
            </a>
          ))}
        </div>
      )}
      <div className="workspace-layout">
        <AgentRoster
          project={performanceProject}
          events={timelineEvents}
          runtime={workflowRuntime}
          livePerformance={livePerformance}
          onEditModels={openModelEditor}
          onEditGroups={openGroupEditor}
        />

        <section className={`workspace-panel workspace-center ${tab === "trace" ? "workspace-center-trace" : ""}`}>
          <div className="center-tabs">
            <div role="tablist">
              <button
                className={tab === "trace" ? "active" : ""}
                onClick={() => setTab("trace")}
                role="tab"
                aria-selected={tab === "trace"}
              >
                <Activity size={16} />
                实时轨迹
                {totalEventCount > 0 && <span>{totalEventCount}</span>}
              </button>
              <button
                className={tab === "artifacts" ? "active" : ""}
                onClick={() => setTab("artifacts")}
                role="tab"
                aria-selected={tab === "artifacts"}
              >
                <FolderOpen size={16} />
                研究产物
                {(artifactSummary?.total ?? 0) > 0 && <span>{artifactSummary?.total}</span>}
              </button>
              <button
                className={tab === "results" ? "active" : ""}
                onClick={() => setTab("results")}
                role="tab"
                aria-selected={tab === "results"}
              >
                <Gauge size={16} />
                最终结果
                {projectResultSelection(project) && <span>{displayItems(projectResultSelection(project)).length}</span>}
              </button>
            </div>
          </div>
          {tab === "trace" ? (
            <TraceView
              events={events}
              liveStreams={eventStream.live.streams}
              liveEvents={eventStream.live.events}
              project={project}
              connection={connection}
              totalEventCount={totalEventCount}
              hasOlder={eventStream.hasOlder ?? false}
              historyLoading={eventStream.historyLoading ?? false}
              historyError={eventStream.historyError ?? ""}
              onLoadOlder={eventStream.loadOlder ?? (async () => undefined)}
            />
          ) : tab === "artifacts" ? (
            <ArtifactsView
              projectId={projectId}
              summary={artifactSummary}
              artifacts={artifacts}
              directoryEntries={artifactDirectoryEntries}
              directory={artifactDirectory}
              directoryTotal={artifactDirectoryTotal}
              onDirectoryChange={(directory) => {
                if (directory === artifactDirectory) return;
                artifactRequestRef.current += 1;
                setArtifactDirectory(directory);
                setArtifactDirectoryTotal(0);
                setArtifactDirectoryEntries([]);
                setArtifactOffset(0);
                setArtifactHasMore(false);
              }}
              loading={artifactsLoading}
              pageLoading={artifactPageLoading}
              hasMore={artifactHasMore}
              onLoadMore={() => {
                if (artifactSearchQuery) {
                  void loadArtifactSearchPage(artifactOffset, true);
                } else {
                  void loadArtifactDirectory(
                    artifactDirectory,
                    artifactOffset,
                    true
                  );
                }
              }}
              query={artifactQuery}
              onQueryChange={(query) => {
                artifactRequestRef.current += 1;
                setArtifactQuery(query);
                setArtifacts([]);
                setArtifactHasMore(false);
                if (!query.trim()) setArtifactSearchQuery("");
              }}
              error={artifactsError}
            />
          ) : (
            <FinalResultsView projectId={projectId} project={project} />
          )}
        </section>

        <AgentCallGraph project={project} events={timelineEvents} harnesses={workflowHarnessCatalog} runtime={workflowRuntime} />

        <ContextPanel
          project={performanceProject}
          events={recentOperationalEvents}
          eventCount={totalEventCount}
          artifactCount={artifactSummary?.total ?? 0}
          queue={queue}
          queueError={queueError}
          livePerformance={livePerformance}
        />
      </div>

      <nav className="mobile-workspace-nav">
        <button className={tab === "trace" ? "active" : ""} onClick={() => setTab("trace")}>
          <Activity size={18} />轨迹
        </button>
        <button className={tab === "artifacts" ? "active" : ""} onClick={() => setTab("artifacts")}>
          <FolderOpen size={18} />产物
        </button>
        <button className={tab === "results" ? "active" : ""} onClick={() => setTab("results")}>
          <Gauge size={18} />结果
        </button>
      </nav>

      {cancelOpen && (
        <CancelDialog
          title={project.title}
          loading={actionLoading === "cancel"}
          onCancel={() => setCancelOpen(false)}
          onConfirm={() => void doAction("cancel")}
        />
      )}
      {modelEditorOpen && project.status === "draft" && !project.configurationLocked && (
        <AgentModelEditor
          project={project}
          harnesses={workflowHarnessCatalog}
          gateways={recommendationGateways}
          models={modelOptions}
          skills={skillOptions}
          mcpDirectory={mcpDirectory}
          defaultPrompts={agentPromptDefaults}
          mainSystemPrompt={mainSystemPrompt}
          saving={modelUpdateLoading}
          error={modelUpdateError}
          notice={modelUpdateNotice}
          onClose={() => {
            if (!modelUpdateLoading) setModelEditorOpen(false);
          }}
          onAddSkill={addSkillCandidate}
          onApply={applyAgentConfigs}
        />
      )}
      {workflowAdjustmentOpen && <WorkflowAdjustmentEditor key={project.id} project={project} eventRevision={totalEventCount} gateways={recommendationGateways}
        harnesses={workflowHarnessCatalog} skills={skillOptions} mcpDirectory={mcpDirectory} onAddSkill={addSkillCandidate} onClose={() => setWorkflowAdjustmentOpen(false)} />}
      {groupEditorOpen && project.git?.enabled && (
        <CollaborationGroupEditor
          project={project}
          saving={groupUpdateLoading}
          error={groupUpdateError}
          notice={groupUpdateNotice}
          onClose={() => {
            if (!groupUpdateLoading) setGroupEditorOpen(false);
          }}
          onApply={applyCollaborationGroupUpdate}
        />
      )}
    </main>
  );
}
