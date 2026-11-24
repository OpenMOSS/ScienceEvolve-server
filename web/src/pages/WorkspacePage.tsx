import { MainAssistancePanel } from "../components/MainAssistancePanel";
import { WorkflowGateRuns } from "../components/workflow-canvas/WorkflowGateRuns";
import { SearchTreePanel } from "../components/SearchTree";
import { artifactRelativeResourceUrl } from "../artifact-html";
import { getArtifactHtmlPreviewUrl } from "../api";
import {
  traceDataString,
  traceDataStrings,
  isThoughtEvent,
  isToolEvent,
  thoughtSummary,
  toolCommand,
  toolLabel
} from "../trace-model";
import { currentScopedGroupRun, scopedGroupDisplayState, scopedNodeDisplayState, scopedRosterMembers } from "../scoped-runtime";
import { readCachedProjectList, cacheProjectDetail } from "../project-list-cache";
import { applyLiveRuntimeSnapshot, mergeProjectSnapshot } from "../project-runtime";
import { WorkspacePreview } from "../components/WorkspacePreview";
import { createProjectRefreshScheduler } from "../project-refresh";
import { acceptedGitHandoff, projectResultSelection } from "../project-results";
import { resolvePerformanceMetrics, useProjectPerformance } from "../project-performance";
import { projectLifecycleState, runtimeDisplayState } from "../../../server/src/internal/shared/project-runtime-status.js";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import ReactMarkdown from "react-markdown";
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
  Maximize2,
  FileText,
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
  getQueue,
  projectAction,
  respondToUserIntervention,
  updateProjectAgentConfigs,
  updateProjectCollaborationGroup,
  type CollaborationGroupUpdate
} from "../api";
import {
  AgentIcon,
  Brand,
  Button,
  EmptyState,
  ErrorPanel,
  OverallProgressBar,
  PageLoader,
  StatusBadge
} from "../components/Common";
import { ProjectInteractionComposer } from "../components/ProjectInteractionComposer";
import { AgentCallGraph } from "../components/AgentCallGraph";
import { ScionTabs } from "../components/ScionTabs";
import { ProjectStopDialog } from "../components/ProjectStopDialog";
import { canStopProject, usesCollaborationScheduler } from "../project-status";
import { WorkflowAdjustmentEditor } from "../components/WorkflowAdjustmentEditor";
import { AgentToolRecommendation } from "../components/AgentToolRecommendation";
import { ProjectAuthorizationNotice } from "../components/ProjectAuthorizationNotice";
import { ProjectServiceFailureNotice } from "../components/ProjectServiceFailureNotice";
import { withProjectAuthorizationWaiting } from "../lib";
import { AgentPromptPanels } from "../components/workflow-canvas/AgentPromptPanels";
import { readCachedResource } from "../resource-cache";
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
  harnessSupportsPurpose,
  humanFileSize,
  isAgentTemplate,
  isLarkSkill,
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
  Project,
  GatewayRecord,
  HarnessCatalogEntry,
  QueueSnapshot,
  SkillDefinition,
  DisplaySelection,
  FixedMcpDefinition,
  HandoffRecord,
  InvocationPerformance,
  ScopedExecution
} from "../types";
import { useProjectEvents } from "../useProjectEvents";
import { PerformanceMetrics } from "../components/PerformanceMetrics";
import { DEFAULT_TRACE_DISPLAY_LIMIT, TraceView } from "./WorkspaceTrace";
import { ProjectExplainerPanel } from "./ProjectExplainerPanel";

export { buildTraceEntries } from "../trace-model";
export type { TraceEntry } from "../trace-model";
export { AgentActivityCard, TraceView } from "./WorkspaceTrace";
export { ProjectExplainerPanel } from "./ProjectExplainerPanel";

type CollaborationGroupUpdateIntent =
  | Omit<Extract<CollaborationGroupUpdate, { action: "rename" }>, "requestId">
  | Omit<Extract<CollaborationGroupUpdate, { action: "dissolve" }>, "requestId">;

type CenterTab = "trace" | "artifacts" | "results";
const ARTIFACT_PAGE_SIZE = 100;
const ARTIFACT_DIRECTORY_PAGE_SIZE = 50;

export function isProjectSnapshotRefreshEvent(event: Pick<AgentEvent, "type" | "data">): boolean {
  const type = event.type.toLowerCase().replaceAll("_", ".");
  if (type === "workflow.adjustment.transitioned" || event.data?.sourceType === "workflow.adjustment.transitioned") {
    const transition = event.data?.transition;
    return typeof transition === "object" && transition !== null && "status" in transition && transition.status === "applied";
  }
  return (
    type.startsWith("workflow.node.") ||
    type === "workflow.reconfigured" ||
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
      jsonl: "application/x-ndjson",
      bib: "text/x-bibtex",
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
    mediaType === "application/x-ndjson" ||
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
  if (phase.endsWith(":preparing-skills")) return "正在准备选中的 Skills";
  if (phase.endsWith(":preparing-context")) return "正在准备调用上下文";
  if (phase === "harness-recovery-required") return "Agent 启动失败，等待修复后继续";
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


function displayAgentName(agent?: AgentName): string {
  return agent === SYSTEM_CONTROLLER_AGENT ? "main" : agent ?? "";
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
    if (node.kind === "gate") return [];
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
          <button
            type="button"
            className="agent-model-edit-trigger"
            onClick={onEditModels}
            aria-label="编辑 Agent 模型、Prompt、Skills 与 MCP"
          >
            <Cpu size={13} />
            编辑配置
          </button>
          {usesCollaborationScheduler(project) && project.status === "draft" && !project.configurationLocked && (
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
          const reasoningLabel = config?.gatewaySnapshot?.reasoning?.label
            ?? config?.gatewayReasoningOption
            ?? "Provider 默认";
          const hasMetrics = Boolean(metrics.current || metrics.average || metrics.latestToken);
          return (
            <details
              className={`roster-agent roster-standalone roster-${state} ${project.currentAgent === agent ? "current" : ""}`}
              key={agent}
            >
              <summary className="roster-standalone-summary">
                <span className={`roster-agent-icon agent-${meta.color}`}>
                  <AgentIcon role={role} size={16} />
                  {state === "running" && <i />}
                </span>
                <span className="roster-agent-copy">
                  <span className="roster-agent-heading">
                    <strong>{agent}</strong>
                    <span className={`run-state run-state-${state}`}>
                      {runtimeNodeLabel(state)}
                    </span>
                  </span>
                  <span className="roster-agent-model">{config?.model || "未配置模型"}</span>
                  <small>
                    {agent === SYSTEM_CONTROLLER_AGENT ? "Main" : role} · {executionCount} 次执行
                    {progress?.queuePosition ? ` · 队列 #${progress.queuePosition}` : ""}
                  </small>
                </span>
                <ChevronRight className="roster-standalone-chevron" size={15} aria-hidden="true" />
              </summary>
              <div className="roster-agent-detail">
                <dl className="roster-agent-settings">
                  <div><dt>网关思考强度</dt><dd>{reasoningLabel}</dd></div>
                  {config?.skills.length ? <div>
                    <dt>Skills</dt>
                    <dd><ul>{config.skills.map(skill => <li key={skill}>{skill}</li>)}</ul></dd>
                  </div> : null}
                </dl>
                {config?.reasoningMigrationWarning && <p className="field-error">
                  {config.reasoningMigrationWarning}
                </p>}
                {hasMetrics && <PerformanceMetrics
                  performance={metrics.current}
                  averageFallback={metrics.average}
                  latestToken={metrics.latestToken}
                  hideInactiveSpeed
                  compact
                />}
              </div>
            </details>
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

export function AgentModelEditor({
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
      disabled={saving}
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
                    <AgentPromptPanels agentId={role} agent={{ ...recommendationAgents[role],
                      harness: project.agents[role].harness ?? catalogDefaultHarnessId(harnesses) }}
                      mainSystemPrompt={mainSystemPrompt} />
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

function ArtifactViewer({
  projectId,
  artifact,
  loading,
  error,
  onClose,
  onExpand,
  expanded = false,
  onVariantChange
}: {
  projectId: string;
  artifact?: Artifact | ArtifactContent;
  loading: boolean;
  error: string;
  onClose?: () => void;
  onExpand?: () => void;
  expanded?: boolean;
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
          {onExpand && <button onClick={onExpand} title={expanded ? "还原阅读" : "放大阅读"}><Maximize2 size={16} /></button>}
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
                a: ({ children, href, title }) => (
                  <a href={href ? artifactRelativeResourceUrl(projectId, artifact, href) : href} title={title} target="_blank" rel="noreferrer">
                    {children}
                  </a>
                ),
                img: ({ src, alt, title }) => <img src={src ? artifactRelativeResourceUrl(projectId, artifact, src) : src} alt={alt} title={title} />
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
          <iframe title={artifact.name} src={hasContent ? getArtifactHtmlPreviewUrl(projectId, artifact) : undefined} className="artifact-media-frame" />
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
        artifactPreviewKind(artifact) !== "html" &&
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
  const viewerOpen = Boolean(selected || contentLoading || contentError);
  const rows = searching ? artifacts : directoryEntries;

  return (
    <div className={`artifacts-layout ${viewerOpen ? "viewer-open" : ""}`}>
      <div className="artifact-list">
        <div className="artifact-list-toolbar">
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
          <span className="artifact-list-count">
            {searching ? `在 ${fileCount} 份文件中搜索` : `${directoryTotal} 项`}
            {hasMore && ` · 已加载 ${loadedCount}`}
          </span>
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
        </div>
        {pageLoading && loadedCount === 0 ? (
          <PageLoader label={searching ? "正在搜索研究产物…" : "正在读取当前文件夹…"} />
        ) : rows.length ? (
          rows.map(entry => {
            const folder = "type" in entry && entry.type === "directory";
            const canPreview = folder || isPreviewableArtifact(entry);
            const parent = searching && entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : "";
            const meta = [
              !folder && entry.size !== undefined ? humanFileSize(entry.size) : "",
              entry.updatedAt ? formatRelativeTime(entry.updatedAt) : "",
              !folder ? entry.workspaceLabel : "",
              !folder && (entry.variants?.length ?? 0) > 1 ? `${entry.variants!.length} 个来源` : ""
            ].filter(Boolean).join(" · ");
            return (
              <button
                type="button"
                className={`artifact-entry-row${folder ? " artifact-directory-row" : selected?.path === entry.path ? " active" : ""}`}
                onClick={() => folder ? onDirectoryChange(entry.path) : void openArtifact(entry)}
                key={"type" in entry ? artifactDirectoryEntryKey(entry as ArtifactDirectoryEntry) : artifactKey(entry)}
                title={folder ? `打开文件夹 ${entry.path}` : `${canPreview ? "预览" : "下载"} ${entry.path}`}
              >
                <span className={`file-kind file-${folder ? "directory" : entry.kind}`}>
                  {folder ? <Folder size={15} /> : entry.kind === "latex" ? <FileCode2 size={15} /> : <FileText size={15} />}
                </span>
                <span className="artifact-entry-name">
                  <strong>{entry.name}</strong>
                  {parent && <small className="artifact-file-path">{parent}</small>}
                </span>
                {meta && <small className="artifact-file-meta">{meta}</small>}
                {canPreview ? <ChevronRight size={14} aria-hidden="true" /> : <Download size={14} aria-hidden="true" />}
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
      {viewerOpen && <ArtifactViewer
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
      />}
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
  const hasFiles = items.length > 0;
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
  const [readingExpanded, setReadingExpanded] = useState(false);
  const readerRef = useRef<HTMLDivElement>(null);
  const readingSourceRef = useRef<string>();
  readingSourceRef.current = selectedArtifact ? `${projectId}:${artifactKey(selectedArtifact)}` : undefined;
  const readingTextRef = useRef(false);
  readingTextRef.current = !!selectedArtifact && ["markdown", "json", "csv", "text"].includes(artifactPreviewKind(selectedArtifact));
  const readingPositionRef = useRef<{
    source?: string; outer: HTMLElement; document: HTMLElement; outerTop: number; documentTop: number;
    offset: number; innerScrolls: boolean; height: number; text: boolean; closingOffset?: number;
  }>();
  const closeReading = () => {
    const position = readingPositionRef.current;
    const documentPanel = readerRef.current?.querySelector<HTMLElement>(".artifact-document");
    if (position && documentPanel && readingTextRef.current) {
      if (position.source !== readingSourceRef.current) {
        Object.assign(position, { source: readingSourceRef.current, text: true, offset: 0,
          documentTop: 0, innerScrolls: false, outerTop: 0 });
      }
      position.document = documentPanel;
      position.closingOffset = documentPanel.scrollTop;
    }
    setReadingExpanded(false);
  };
  const toggleReading = () => {
    if (readingExpanded) { closeReading(); return; }
    const reader = readerRef.current;
    const outer = reader?.closest<HTMLElement>(".final-results-view");
    const documentPanel = reader?.querySelector<HTMLElement>(".artifact-document");
    if (reader && outer && documentPanel) {
      readingPositionRef.current = {
        source: readingSourceRef.current, outer, document: documentPanel, outerTop: outer.scrollTop, documentTop: documentPanel.scrollTop,
        offset: documentPanel.scrollTop + Math.max(0, outer.getBoundingClientRect().top - documentPanel.getBoundingClientRect().top),
        innerScrolls: documentPanel.scrollHeight > documentPanel.clientHeight,
        height: reader.closest("section")?.getBoundingClientRect().height ?? reader.getBoundingClientRect().height,
        text: readingTextRef.current
      };
    }
    setReadingExpanded(true);
  };

  useEffect(() => setReadingExpanded(false), [projectId, hasFiles]);

  useEffect(() => {
    if (!readingExpanded || !readerRef.current) return;
    const reader = readerRef.current;
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    const inactiveElements: { element: HTMLElement; inert: boolean }[] = [];
    for (let child: HTMLElement = reader; child.parentElement; child = child.parentElement) {
      for (const sibling of child.parentElement.children) {
        if (sibling !== child && sibling instanceof HTMLElement) {
          inactiveElements.push({ element: sibling, inert: sibling.inert });
          sibling.inert = true;
        }
      }
      if (child.parentElement === document.body) break;
    }
    document.body.style.overflow = "hidden";
    reader.focus({ preventScroll: true });
    const position = readingPositionRef.current;
    if (position?.text && position.source === readingSourceRef.current) position.document.scrollTop = position.offset;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeReading();
      } else if (event.key === "Tab") {
        const controls = [...reader.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), iframe, [tabindex="0"]'
        )].filter(element => !element.closest("[hidden]"));
        const first = controls[0];
        const last = controls.at(-1);
        if (event.shiftKey && (document.activeElement === first || document.activeElement === reader)) {
          event.preventDefault();
          (last ?? reader).focus();
        } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === reader)) {
          event.preventDefault();
          (first ?? reader).focus();
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    const frameDocuments = new Set<Document>();
    const onFrameKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onKeyDown(event);
      if (event.key !== "Tab" || event.shiftKey || event.defaultPrevented) return;
      const frameDocument = event.currentTarget as Document;
      const controls = [...frameDocument.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')]
        .filter(element => !element.closest("[hidden]"));
      const readerControls = [...reader.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), iframe, [tabindex="0"]')];
      if ((!controls.length || frameDocument.activeElement === controls.at(-1)) &&
        frameDocument.defaultView?.frameElement === readerControls.at(-1)) {
        event.preventDefault();
        (readerControls[0] ?? reader).focus();
      }
    };
    const bindFrame = (frame: HTMLIFrameElement) => {
      const frameDocument = frame.contentDocument;
      if (!frameDocument || frameDocuments.has(frameDocument)) return;
      frameDocuments.add(frameDocument);
      frameDocument.addEventListener("keydown", onFrameKeyDown);
    };
    const onFrameLoad = (event: Event) => {
      if (event.target instanceof HTMLIFrameElement) bindFrame(event.target);
    };
    reader.querySelectorAll("iframe").forEach(bindFrame);
    reader.addEventListener("load", onFrameLoad, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      reader.removeEventListener("load", onFrameLoad, true);
      for (const frameDocument of frameDocuments) frameDocument.removeEventListener("keydown", onFrameKeyDown);
      document.body.style.overflow = previousOverflow;
      for (const { element, inert } of inactiveElements) element.inert = inert;
      const returnFocus = previousFocus instanceof HTMLElement && previousFocus.isConnected
        ? previousFocus : reader.querySelector<HTMLButtonElement>('[title="放大阅读"]');
      returnFocus?.focus({ preventScroll: true });
      if (position) {
        const sameText = position.text && position.source === readingSourceRef.current;
        const offset = position.closingOffset ?? position.offset;
        if (sameText) position.document.scrollTop = position.innerScrolls ? offset : position.documentTop;
        const documentStart = position.outer.scrollTop + position.document.getBoundingClientRect().top - position.outer.getBoundingClientRect().top;
        position.outer.scrollTop = sameText && !position.innerScrolls && offset !== position.offset
          ? documentStart + offset : position.outerTop;
      }
    };
  }, [readingExpanded]);

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
    if (!["markdown", "json", "csv", "html", "text"].includes(previewKind)) {
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
  }, [projectId, selectedItem]);

  const lastCompletedNode = usesCollaborationScheduler(project) && project.status === "completed"
    ? (project.nodeRuns ?? []).filter(node => node.status === "completed" && Number.isFinite(Date.parse(node.completedAt ?? "")))
      .sort((left, right) => Date.parse(right.completedAt!) - Date.parse(left.completedAt!))[0]
    : undefined;
  const finalMainNode = lastCompletedNode?.node.kind === "agent" && lastCompletedNode.node.agentId === SYSTEM_CONTROLLER_AGENT
    ? lastCompletedNode : undefined;
  const mainOutput = finalMainNode?.output;
  const handoff = typeof mainOutput === "string" && mainOutput.trim() && finalMainNode?.completedAt
    ? { agent: SYSTEM_CONTROLLER_AGENT, markdown: mainOutput, excerpt: mainOutput.replace(/\s+/g, " ").trim().slice(0, 240), updatedAt: finalMainNode.completedAt }
    : project.latestHandoff ?? acceptedGitHandoff(project);
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
              <StatusBadge status={project.status} phase={project.phase} runtime={project.runtime} />
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
            <section className={`final-result-files ${expandedSections.files ? "expanded" : "collapsed"}`}
              style={readingExpanded ? { minHeight: readingPositionRef.current?.height } : undefined}>
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
                <div ref={readerRef} className={`final-result-section-body final-result-files-body${readingExpanded ? " is-expanded-reader" : ""}`}
                  role={readingExpanded ? "dialog" : undefined} aria-modal={readingExpanded ? true : undefined}
                  aria-label={readingExpanded ? "最终结果放大阅读" : undefined} tabIndex={readingExpanded ? -1 : undefined}>
                  {readingExpanded && <div className="final-result-reader-head">
                    <strong>最终结果</strong>
                    <button type="button" className="button" onClick={closeReading} aria-label="关闭放大阅读"><X size={17} />关闭</button>
                  </div>}
                  <div className="final-result-file-tabs" role="tablist" aria-label="最终结果文件">
                    {items.map((item, index) => (
                      <button
                        type="button"
                        key={item.artifactId ?? `${item.agent}:${item.path}`}
                        className={(selectedItem?.artifactId ?? `${selectedItem?.agent}:${selectedItem?.path}`) === (item.artifactId ?? `${item.agent}:${item.path}`) ? "active" : ""}
                        onClick={() => setSelectedItem({ ...item })}
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
                    onExpand={toggleReading}
                    expanded={readingExpanded}
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
          <Button type="button" variant="ghost" data-size="small" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
            {expanded ? "收起" : "展开"}
          </Button>
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

export function WorkspacePage({
  projectId,
  onBack
}: {
  projectId: string;
  onBack: () => void;
}) {
  const [sourceProject, setProject] = useState<Project | undefined>(() => readCachedResource<Project>(`project:${projectId}`));
  const card = useMemo(() => readCachedProjectList()?.projects.find(row => row.id === projectId), [projectId]);
  const [projectLoading, setProjectLoading] = useState(() => !readCachedResource(`project:${projectId}`));
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
  const centerPanelRef = useRef<HTMLElement>(null);
  const selectTabFromBottom = (next: CenterTab) => {
    setTab(next);
    centerPanelRef.current?.scrollIntoView({ block: "start", inline: "nearest" });
  };
  const [interaction, setInteraction] = useState<"request" | "explainer">();
  const interactionDrawer = useRef<HTMLElement>(null);
  const interactionTrigger = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(() => {
    if (interaction) interactionDrawer.current?.querySelector<HTMLButtonElement>(
      '[data-active-panel="true"] .project-interaction-close'
    )?.focus({ preventScroll: true });
  }, [interaction]);
  const closeInteraction = () => {
    setInteraction(undefined);
    interactionTrigger.current?.focus({ preventScroll: true });
  };
  const [inspectorView, setInspectorView] = useState<"calls" | "context">("calls");
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
  const [chosenInputMode, chooseInputMode] = useState<"chat" | "wait" | "interrupt">();
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
  const liveRuntime = eventStream.live.projectId === projectId ? eventStream.live.runtime : undefined;
  const detailBehindCard = sourceProject?.id === projectId && mergeProjectSnapshot(card, sourceProject) !== sourceProject;
  const project = useMemo(() => {
    if (sourceProject?.id !== projectId) return undefined;
    const detail = liveRuntime ? applyLiveRuntimeSnapshot(sourceProject, liveRuntime) : sourceProject;
    return withProjectAuthorizationWaiting(detailBehindCard && card?.overallProgress
      ? { ...detail, overallProgress: card.overallProgress }
      : detail);
  }, [card, detailBehindCard, projectId, sourceProject, liveRuntime]);
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
  const workflowAdjustmentEventRevision = useMemo(() => events.reduce((latest, event) => {
    const source = typeof event.data?.sourceType === "string" ? event.data.sourceType : event.type;
    return source.startsWith("workflow.adjustment.") || event.type === "workflow.reconfigured"
      ? Math.max(latest, event.seq) : latest;
  }, 0), [events]);
  const recentOperationalEvents = useMemo(
    () => events.slice(-DEFAULT_TRACE_DISPLAY_LIMIT),
    [events]
  );

  useEffect(() => {
    if (sourceProject?.id === projectId) cacheProjectDetail(sourceProject);
  }, [sourceProject, projectId]);

  const fetchProjectSnapshot = useCallback(async () => {
    const request = ++projectRequestRef.current;
    try {
      const result = await getProject(projectId);
      if (request !== projectRequestRef.current) return;
      setProject((current) => mergeProjectSnapshot(current, result));
      setProjectError("");
    } catch (reason) {
      if (request === projectRequestRef.current) setProjectError(reason instanceof Error && reason.name === "TimeoutError"
        ? "项目详情请求超时" : reason instanceof Error ? reason.message : "项目加载失败");
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
  const projectUserInputMode = chosenInputMode ?? (project?.status === "running" && !project.archivedAt ? "chat" : "wait");
  const selectInputMode = (mode: typeof projectUserInputMode) => {
    chooseInputMode(mode);
    projectUserInputRequestId.current = undefined;
    setProjectUserInputNotice("");
    setProjectUserInputError("");
  };
  const loadProject = useCallback(() => getProjectRefresh().refresh(), [getProjectRefresh]);
  const scheduleProjectRefresh = useCallback(() => getProjectRefresh().schedule(), [getProjectRefresh]);

  useEffect(() => {
    if (liveRuntime || detailBehindCard) scheduleProjectRefresh();
  }, [liveRuntime?.stateRevision, detailBehindCard, scheduleProjectRefresh]);

  const awaitingMainReply = project?.mainConversation?.some(item => item.status === "queued" || item.status === "processing");
  useEffect(() => {
    if (!awaitingMainReply) return;
    const refresh = () => { if (document.visibilityState === "visible") scheduleProjectRefresh(); };
    const timer = window.setInterval(refresh, 2000);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", refresh); };
  }, [awaitingMainReply, scheduleProjectRefresh]);
  useEffect(() => {
    chooseInputMode(undefined);
    projectUserInputRequestId.current = undefined;
    setProjectUserInput("");
    setProjectUserInputNotice("");
    setProjectUserInputError("");
  }, [projectId]);

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
    const cached = readCachedResource<Project>(`project:${projectId}`);
    setProject(current => current?.id === projectId ? current : cached);
    setProjectLoading(!cached);
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
  }, [loadProject]);

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
    if (tab === "artifacts" && publishedArtifactKeyRef.current !== undefined && publishedArtifactKeyRef.current !== publishedArtifactKey) scheduleArtifactSummaryRefresh();
    publishedArtifactKeyRef.current = publishedArtifactKey;
  }, [publishedArtifactKey, scheduleArtifactSummaryRefresh, tab]);
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
    if (tab === "artifacts" && unseen.some((event) => {
      const type = event.type.toLowerCase();
      return type.includes("artifact") || type.includes("file");
    })) {
      scheduleArtifactSummaryRefresh();
    }
  }, [events, scheduleArtifactSummaryRefresh, scheduleProjectRefresh, tab]);

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
    const restartsCompletedProject = projectUserInputMode !== "chat" && project?.status === "completed";
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
      setProject(current => mergeProjectSnapshot(current, updated));
      setProjectUserInput("");
      chooseInputMode(undefined);
      projectUserInputRequestId.current = undefined;
      setProjectUserInputNotice(
        projectUserInputMode === "chat" ? "消息已保存，可在对话记录中查看 Main 的接收状态和答复。" : restartsCompletedProject
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

  const traceProject = project ?? card;
  const traceView = traceProject && eventStream.live.projectId === projectId ? (
    <TraceView key={projectId} events={events} liveStreams={eventStream.live.streams} liveEvents={eventStream.live.events}
      project={traceProject} connection={connection} totalEventCount={totalEventCount}
      hasOlder={eventStream.hasOlder ?? false} historyLoading={eventStream.historyLoading ?? false}
      historyError={eventStream.historyError ?? ""} onLoadOlder={eventStream.loadOlder} />
  ) : null;

  if (!project && (projectLoading || card)) {
    return <WorkspacePreview project={card} onBack={onBack} error={projectError}
      onRetry={() => { setProjectError(""); void loadProject(); }}>{traceView}</WorkspacePreview>;
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
  const canCancel = canStopProject(project);
  const canAddProjectUserInput = ![
    "cancelled",
    "cancelling",
    "stopped",
    "failed"
  ].includes(project.status);
  const pendingProjectUserInputs = (project.userInputs ?? []).filter(
    (input) => input.status === "pending"
  );
  const canExplain = workflowHarnessCatalog.some((item) => item.available && harnessSupportsPurpose(item, "explainer"));
  const performanceProject = { ...project, performance: performanceResults };
  const metrics = resolvePerformanceMetrics(performanceResults, livePerformance, project.status);

  return (
    <main className="workspace-page">
      <div className="workspace-sticky-top">
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
                <StatusBadge status={project.status} phase={project.phase} runtime={project.runtime} />
                <small title="项目资料和运行统计的最近更新时间">记录更新于 {formatRelativeTime(project.updatedAt)}</small>
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

        <div className="workspace-progress-strip">
          <div className="workspace-progress-primary">
            <OverallProgressBar
              progress={project.overallProgress}
              label={<>
                <small className="workspace-progress-phase-label">当前阶段</small>{" "}
                {project.runtime?.waiting?.reason || displayPhase(project.phase)}
              </>}
            />
          </div>
          <div className="workspace-performance-summary" role="region" aria-label="当前输出性能">
            <PerformanceMetrics
              performance={metrics.current}
              averageFallback={metrics.average}
              latestToken={metrics.latestToken}
              hideInactiveSpeed
              showApproximation={false}
              compact
            />
          </div>
          <div className="workspace-phase-meta">
            <span>
              <small>任务步数</small>
              <strong>Turn {project.turn}</strong>
            </span>
            {project.queuedAgent && !waitingForUser && (
              <span>
                <small>
                  {project.status === "interrupted"
                    ? "恢复断点"
                    : "队列"}
                </small>
                <strong title={displayAgentName(project.queuedAgent)}>
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
          <div className="project-interaction-actions" role="group" aria-label="项目操作">
            <button type="button" aria-expanded={interaction === "request"} aria-controls="workspace-user-request"
              onClick={event => {
                interactionTrigger.current = event.currentTarget;
                setInteraction(current => current === "request" ? undefined : "request");
              }}>
              <MessageSquareText size={16} aria-hidden="true" />补充科研需求
              {pendingProjectUserInputs.length > 0 && <span>{pendingProjectUserInputs.length} 待投递</span>}
            </button>
            {canExplain && <button type="button" aria-expanded={interaction === "explainer"} aria-controls="workspace-project-explainer"
              onClick={event => {
                interactionTrigger.current = event.currentTarget;
                setInteraction(current => current === "explainer" ? undefined : "explainer");
              }}>
              <Bot size={16} aria-hidden="true" />项目解说
            </button>}
          </div>
        </div>
      </div>

        <aside className="project-interaction-drawer" aria-label="项目操作面板" ref={interactionDrawer}
          data-view={interaction} hidden={!interaction || (interaction === "explainer" && !canExplain)}
          onKeyDown={event => {
            if (event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing) return;
            const config = event.currentTarget.querySelector('[data-active-panel="true"] .project-explainer-runtime-config[data-open="true"]');
            if (config && event.target instanceof Node && config.contains(event.target)) {
              config.querySelector<HTMLButtonElement>(".project-explainer-config-close")?.click();
              return;
            }
            closeInteraction();
          }}>
          <div id="workspace-user-request" data-active-panel={interaction === "request"} hidden={interaction !== "request"}>
            <section
              className="project-request-panel project-interaction-surface"
              aria-label="项目主动需求输入"
            >
            <div className="project-explainer-heading">
              <div>
                <span className="project-explainer-icon"><MessageSquareText size={18} aria-hidden="true" /></span>
                <span><strong>补充科研需求</strong><small>发送给 Main</small></span>
              </div>
              <button type="button" className="project-interaction-close" aria-label="关闭项目面板" title="关闭" onClick={closeInteraction}><X size={17} /></button>
            </div>
            <div className="project-request-body">
                {canAddProjectUserInput && <p className="project-request-context">
                  {projectUserInputMode === "chat"
                    ? "消息发送给 Main，当前 Agent 继续工作。"
                    : projectUserInputMode === "interrupt"
                    ? "保存当前断点与部分输出后，由 Main 接管。"
                    : project.status === "completed"
                    ? "输入会保留在当前项目并由 main 重新启动科研流程。历史结果仍可查看，main 会根据新的需求重新安排工作。"
                    : project.status === "running" && project.currentAgent === SYSTEM_CONTROLLER_AGENT
                      ? "输入会先持久化，当前 main 完成后直接进入新一轮工作上下文（包含该输入）；不会中断正在进行的调用。"
                      : "输入会保存在当前科研任务中，不中断正在工作的 Agent；当前调用完成后进入新一轮工作上下文，并在下一次 main 调度时作为用户上下文送达。"}
                </p>}
                {pendingProjectUserInputs.length > 0 && (
                  <details className="project-request-queue" aria-label="待投递用户需求">
                    <summary>待投递 {pendingProjectUserInputs.length} 条</summary>
                    <ul>
                      {pendingProjectUserInputs.map((input) => (
                        <li className="project-interaction-user-message" key={input.id}>{input.message}</li>
                      ))}
                    </ul>
                  </details>
                )}
          {Boolean(project.mainConversation?.length) && (
            <section aria-label="与 Main 的对话记录">
              <ul>{project.mainConversation!.map(item => <li key={item.id}>
                <p><strong>你</strong>　{item.message}</p>
                <small>{item.status === "replied" ? "Main 已回复" : item.status === "unknown" ? "处理结果未确认"
                  : item.status === "failed" ? "处理失败" : item.receivedAt ? "Main 已收到" : "已保存，等待 Main 接收"}
                  {item.status === "unknown" || item.status === "failed" ? item.receivedAt ? " · Main 已收到" : " · 接收未确认" : ""}
                </small>
                {item.reply && <p><strong>Main</strong>　{item.reply}</p>}
                {item.error && <p>{item.error}</p>}
              </li>)}</ul>
            </section>
          )}
                {canAddProjectUserInput ? (
                  <form className="project-interaction-form" onSubmit={submitProjectUserInput}>
                    <ProjectInteractionComposer
                      textarea={{
                        "aria-label": projectUserInputMode === "chat" ? "发给 Main 的消息" : "补充要求、调整方向或添加约束",
                        value: projectUserInput,
                        onChange: (event) => {
                          if (event.target.value) chooseInputMode(projectUserInputMode);
                          setProjectUserInput(event.target.value);
                          if (projectUserInputError) setProjectUserInputError("");
                          if (projectUserInputNotice) setProjectUserInputNotice("");
                        },
                        rows: 3,
                        maxLength: 100_000,
                        placeholder: projectUserInputMode === "chat" ? "例如：当前实验做到哪一步了？" : "例如：新增一个消融实验，并优先比较不同训练数据规模下的表现。"
                      }}
                      options={
                        <fieldset
                          className="project-request-modes"
                          aria-label="主动需求处理模式"
                          disabled={projectUserInputLoading || project.status === "interrupting"}
                        >
                          {(project.status === "running" && !project.archivedAt || projectUserInputMode === "chat") && (
                            <label>
                              <input type="radio" name="project-user-input-mode" value="chat" checked={projectUserInputMode === "chat"}
                                disabled={project.status !== "running" || Boolean(project.archivedAt)} onChange={() => selectInputMode("chat")} />
                              <span>与 Main 对话</span>
                            </label>
                          )}
                          <label>
                            <input
                              type="radio"
                              name="project-user-input-mode"
                              value="wait"
                              checked={projectUserInputMode === "wait"}
                              onChange={() => selectInputMode("wait")}
                            />
                            <span>等待当前 Agent 完成</span>
                          </label>
                          <label data-interrupt>
                            <input
                              type="radio"
                              name="project-user-input-mode"
                              value="interrupt"
                              checked={projectUserInputMode === "interrupt"}
                              onChange={() => selectInputMode("interrupt")}
                              disabled={!(project.status === "running" && Boolean(project.currentAgent))}
                            />
                            <span>立即中断当前 Agent</span>
                          </label>
                        </fieldset>
                      }
                      action={<Button
                        type="submit"
                        variant="primary"
                        icon={<Send size={16} />}
                        loading={projectUserInputLoading}
                        disabled={!projectUserInput.trim() || projectUserInputLoading ||
                          projectUserInputMode === "chat" && (project.status !== "running" || Boolean(project.archivedAt))}
                      >
                        {projectUserInputMode === "chat" ? "发送给 Main" : "提交给 main"}
                      </Button>}
                    />
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
          </div>
          {canExplain && <div id="workspace-project-explainer" data-active-panel={interaction === "explainer"} hidden={interaction !== "explainer"}>
            <ProjectExplainerPanel projectId={projectId} active={interaction === "explainer"} onClose={closeInteraction} />
          </div>}
        </aside>

      {Boolean(project.mainAssistance?.length) && <MainAssistancePanel records={project.mainAssistance!} />}
      {project.searchTree && <SearchTreePanel projectId={project.id} />}
      {Boolean(project.orchestration.gates?.length) && <WorkflowGateRuns runs={project.workflowGates ?? []} />}

      {project.status === "interrupted" && !project.interruptionSnapshot && (
        <section className="checkpoint-recovery-banner" aria-label="项目断点恢复">
          <span className="checkpoint-recovery-icon">
            <RotateCcw size={21} />
          </span>
          <div>
            <strong>
              {project.phase === "harness-recovery-required" ? "Agent 启动失败，需要处理" : project.queuedAgent
                ? `${agentMeta(
                    project.queuedAgent,
                    agentTemplateFor(project.orchestration, project.queuedAgent)
                  ).name}运行时被中断`
                : "科研流程运行时被中断"}
            </strong>
            <p>
              {project.phase === "harness-recovery-required"
                ? `自动重试已停止，原任务和会话已保留。${project.error || "请检查 Agent 配置或会话后继续。"}`
                : "已完成步骤、Agent 交接消息和研究产物均已保存。恢复后会重新运行中断 Agent，并继续原有科研流程。"}
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

      <ProjectServiceFailureNotice project={project} />
      <ProjectAuthorizationNotice project={project} />
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
        <section className="workspace-checkpoint-notice" aria-labelledby="workspace-checkpoint-title">
          <div className="workspace-checkpoint-heading">
            <FolderOpen size={17} aria-hidden="true" />
            <h2 id="workspace-checkpoint-title">可恢复工作区文件</h2>
            <span className="workspace-checkpoint-status">未验收</span>
          </div>
          <p>文件保存在共享工作区，尚未正式交付。清单包含文件路径和校验值。</p>
          <ul className="workspace-checkpoint-list">
            {project.workspaceCheckpoints.filter((entry) => entry.fileCount > 0).slice(-3).reverse().map((entry) => (
              <li key={entry.id}>
                <a href={`/api/projects/${encodeURIComponent(project.id)}/checkpoints/${encodeURIComponent(entry.id)}`} target="_blank" rel="noreferrer">
                  <FileText size={14} aria-hidden="true" />
                  <span className="workspace-checkpoint-agent">{entry.agent}</span>
                  <span className="workspace-checkpoint-count">{entry.fileCount} 个文件</span>
                  {entry.incomplete && <span className="workspace-checkpoint-status">清单不完整</span>}
                  <span className="workspace-checkpoint-link">查看清单 <ChevronRight size={14} aria-hidden="true" /></span>
                </a>
              </li>
            ))}
          </ul>
        </section>
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

        <section ref={centerPanelRef} className={`workspace-panel workspace-center ${tab === "trace" ? "workspace-center-trace" : ""}`}>
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
          {tab === "trace" ? traceView : tab === "artifacts" ? (
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

        <section className="workspace-inspector" aria-label="项目监控">
          <ScionTabs label="项目监控视图" value={inspectorView} onChange={setInspectorView} tabs={[
            { value: "calls", label: <><GitBranch size={15} aria-hidden="true" />调用轨迹</>,
              content: <AgentCallGraph project={project} events={timelineEvents} harnesses={workflowHarnessCatalog} runtime={workflowRuntime}
                hasOlder={eventStream.timelineHasOlder} historyLoading={eventStream.timelineHistoryLoading}
                historyError={eventStream.timelineHistoryError} onLoadOlder={eventStream.loadOlderTimeline} /> },
            { value: "context", label: <><Gauge size={15} aria-hidden="true" />运行详情</>,
              content: <ContextPanel project={performanceProject} events={recentOperationalEvents} eventCount={totalEventCount}
                artifactCount={artifactSummary?.total ?? 0} queue={queue} queueError={queueError} livePerformance={livePerformance} /> }
          ]} />
        </section>
      </div>

      <nav className="mobile-workspace-nav" aria-label="项目内容导航">
        <button type="button" aria-current={tab === "trace" ? "true" : undefined} onClick={() => selectTabFromBottom("trace")}>
          <Activity size={18} />轨迹
        </button>
        <button type="button" aria-current={tab === "artifacts" ? "true" : undefined} onClick={() => selectTabFromBottom("artifacts")}>
          <FolderOpen size={18} />产物
        </button>
        <button type="button" aria-current={tab === "results" ? "true" : undefined} onClick={() => selectTabFromBottom("results")}>
          <Gauge size={18} />结果
        </button>
      </nav>

      {cancelOpen && (
        <ProjectStopDialog
          title={project.title}
          loading={actionLoading === "cancel"}
          onCancel={() => setCancelOpen(false)}
          onConfirm={() => void doAction("cancel")}
        />
      )}
      {modelEditorOpen && (
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
      {workflowAdjustmentOpen && <WorkflowAdjustmentEditor key={project.id} project={project} eventRevision={workflowAdjustmentEventRevision} gateways={recommendationGateways}
        harnesses={workflowHarnessCatalog} skills={skillOptions} mcpDirectory={mcpDirectory} onAddSkill={addSkillCandidate}
        onWorkflowApplied={scheduleProjectRefresh} onClose={() => setWorkflowAdjustmentOpen(false)} />}
      {groupEditorOpen && usesCollaborationScheduler(project) && (
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
