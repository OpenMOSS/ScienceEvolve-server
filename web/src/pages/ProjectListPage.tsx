import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { agentPermissionLabel as permissionLabel } from "../../../server/src/internal/shared/agent-permission-metadata.js";
import {
  Archive,
  ArchiveRestore,
  AlertTriangle,
  ArrowRight,
  BrainCircuit,
  CheckCircle2,
  Clock3,
  Coins,
  Database,
  Download,
  Eye,
  FolderKanban,
  ListTree,
  MessageSquareText,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Save,
  Send,
  Settings2,
  Sparkles,
  TimerReset,
  Trash2,
  Upload,
  Users
} from "lucide-react";
import {
  archiveProjects,
  createSavedResearchTask,
  createProject,
  createUserSkill,
  createAgentConfigPreset,
  deleteAgentConfigPreset,
  deleteArchivedProject,
  deleteArchivedProjects,
  deleteSavedResearchTask,
  downloadAgentConfigPreset,
  downloadWorkflowSource,
  importAgentConfigPreset,
  getAgentConfigPresets,
  getCatalog,
  getGitHubAccounts,
  getProjects,
  getQueue,
  getSavedResearchTasks,
  projectAction,
  saveProjectAgentConfigPreset,
  updateAgentConfigPreset
} from "../api";
import {
  AgentBadge,
  AgentIcon,
  Button,
  EmptyState,
  ErrorPanel,
  OverallProgressBar,
  PageLoader,
  StatusBadge
} from "../components/Common";
import { SaveAgentConfigDialog } from "../components/SaveAgentConfigDialog";
import { OrchestrationTemplateEditor } from "../components/OrchestrationTemplateEditor";
import { GitHubAccountSelector } from "../components/GitHubAccountSelector";
import { WorkflowCanvasEditor } from "../components/WorkflowCanvasEditor";
import { WorkflowPresetPreview } from "../components/WorkflowPresetPreview";
import {
  agentMeta,
  normalizeAgentOrchestration,
  normalizeAgents,
  agentMcpServerKey,
  agentOrchestrationError,
  agentRuntimeConfigurationErrors,
  agentRuntimeConfigurationWarnings,
  agentTemplateFor,
  applyCatalogDefaultHarness,
  applyCatalogDefaultHarnessToNewAgents,
  applyCatalogDefaultGateway,
  applyCatalogDefaultGatewayToNewAgents,
  catalogDefaultHarnessId,
  cloneAgentOrchestration,
  cloneAgentsConfig,
  orchestrationWithoutGit,
  createBlankWorkflow,
  DEFAULT_AGENT_ORCHESTRATION,
  DEFAULT_AGENTS,
  formatTokenCount,
  formatRelativeTime,
  isLarkSkill,
  migrateLegacyAgentReasoning,
  projectResourcesPayload,
  SYSTEM_CONTROLLER_AGENT
} from "../lib";
import {
  type AgentConfigPreset,
  type AgentMcpServer,
  type AgentOrchestrationTemplate,
  type ProjectMcpDefinitions,
  type ProjectSkillDefinitions,
  type AgentsConfig,
  type Project,
  type ProjectStatus,
  type QueueSnapshot,
  type SavedResearchTask,
  type SkillDefinition,
  type FixedMcpDefinition,
  type GatewayRecord,
  type GitHubAccountRecord,
  type HarnessCatalogEntry
} from "../types";
import { workflowOuterNodes } from "../components/workflow-canvas/core/workflow-nodes";
import { cacheProjectOverview, readCachedProjectOverview } from "../project-overview-cache";
import {
  cacheProjectList,
  cacheProjectQueue,
  readCachedProjectList,
  readCachedProjectQueue
} from "../project-list-cache";

type ProjectStatusCategory = "active" | "attention" | "stopping" | "terminal";
type Filter = "all" | ProjectStatusCategory;

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "全部项目" },
  { id: "active", label: "进行中" },
  { id: "attention", label: "待处理" },
  { id: "stopping", label: "停止中" },
  { id: "terminal", label: "已结束" }
];

const PROJECT_STATUS_CATEGORIES = {
  draft: "attention",
  queued: "active",
  running: "active",
  retrying: "active",
  interrupting: "stopping",
  interrupted: "attention",
  pausing: "stopping",
  paused: "attention",
  cancelling: "stopping",
  cancelled: "terminal",
  stopping: "stopping",
  stopped: "terminal",
  completed: "terminal",
  failed: "terminal"
} as const satisfies Record<ProjectStatus, ProjectStatusCategory>;

const FILTER_EMPTY_STATES: Record<Filter, { title: string; description: string }> = {
  all: {
    title: "没有匹配的项目",
    description: "换一个关键词或筛选条件试试。"
  },
  active: {
    title: "没有正在推进的项目",
    description: "已暂停项目会归入“待处理”，不会计入正在推进。"
  },
  attention: {
    title: "没有待处理项目",
    description: "当前没有已暂停或等待恢复的项目。"
  },
  stopping: {
    title: "没有正在停止的项目",
    description: "当前没有正在暂停、中断或取消的项目。"
  },
  terminal: {
    title: "没有已结束项目",
    description: "完成、失败、停止或取消的项目会显示在这里。"
  }
};

export function classifyProjectStatus(status: ProjectStatus): ProjectStatusCategory {
  return PROJECT_STATUS_CATEGORIES[status];
}

const PROJECT_PAGE_SIZE = 12;

function displayAgentName(agent?: string): string {
  return agent === SYSTEM_CONTROLLER_AGENT ? "Main Agent" : agent ?? "main";
}

function matchesFilter(project: Project, filter: Filter): boolean {
  if (filter === "all") return true;
  return classifyProjectStatus(project.status) === filter;
}

function compareProjectsByStartedAtDescending(
  left: Project,
  right: Project
): number {
  const leftStartedAt = Date.parse(left.createdAt ?? "");
  const rightStartedAt = Date.parse(right.createdAt ?? "");
  const leftTime = Number.isFinite(leftStartedAt)
    ? leftStartedAt
    : Number.NEGATIVE_INFINITY;
  const rightTime = Number.isFinite(rightStartedAt)
    ? rightStartedAt
    : Number.NEGATIVE_INFINITY;
  if (leftTime !== rightTime) return rightTime - leftTime;
  return right.id.localeCompare(left.id);
}

function quickTitle(requirement: string): string {
  const normalized = requirement.trim().replace(/\s+/g, " ");
  const firstSentence = normalized.split(/[。！？.!?\n]/, 1)[0]?.trim();
  const title = firstSentence || normalized;
  return title.length > 72 ? `${title.slice(0, 71)}…` : title;
}

function ProjectCard({
  project,
  batchMode,
  selected,
  selectable,
  selectionReason,
  onToggleSelected,
  onOpen,
  onPause,
  onResume,
  onArchive,
  onDelete,
  onSaveConfig
}: {
  project: Project;
  batchMode: boolean;
  selected: boolean;
  selectable: boolean;
  selectionReason?: string;
  onToggleSelected: () => void;
  onOpen: () => void;
  onPause: () => Promise<void>;
  onResume: () => Promise<void>;
  onArchive: () => Promise<void>;
  onDelete: () => void;
  onSaveConfig: (title: string) => Promise<string>;
}) {
  const [lifecycleAction, setLifecycleAction] = useState<
    "pause" | "resume" | undefined
  >();
  const [lifecycleError, setLifecycleError] = useState("");
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState("");
  const [saveConfigOpen, setSaveConfigOpen] = useState(false);
  const [configSaveNotice, setConfigSaveNotice] = useState("");
  const statusCategory = classifyProjectStatus(project.status);
  const waitingForUser =
    project.status === "paused" &&
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
    statusCategory === "active";
  const canStart =
    !project.archivedAt &&
    !waitingForUser &&
    !mainRecoveryRequired &&
    !gatewayRecoveryRequired &&
    (statusCategory === "attention" || statusCategory === "stopping") &&
    ["paused", "pausing", "interrupted"].includes(project.status);
  const currentAgentRole = project.currentAgent
    ? agentTemplateFor(project.orchestration, project.currentAgent)
    : undefined;
  const queuedAgentRole = project.queuedAgent
    ? agentTemplateFor(project.orchestration, project.queuedAgent)
    : undefined;

  const changeLifecycle = async (action: "pause" | "resume") => {
    setLifecycleAction(action);
    setLifecycleError("");
    try {
      if (action === "pause") await onPause();
      else await onResume();
    } catch (reason) {
      setLifecycleError(
        reason instanceof Error
          ? reason.message
          : action === "pause"
            ? "项目暂停失败"
            : "项目启动失败"
      );
    } finally {
      setLifecycleAction(undefined);
    }
  };

  const archive = async () => {
    setArchiving(true);
    setArchiveError("");
    try {
      await onArchive();
    } catch (reason) {
      setArchiveError(
        reason instanceof Error ? reason.message : "项目归档操作失败"
      );
    } finally {
      setArchiving(false);
    }
  };

  return (
    <article
      className={`project-card-shell project-status-${statusCategory} ${project.status === "interrupted" ? "recoverable" : ""} ${waitingForUser ? "needs-user" : ""} ${mainRecoveryRequired || gatewayRecoveryRequired ? "needs-main-recovery" : ""} ${project.archivedAt ? "archived" : ""} ${batchMode ? "batch-mode" : ""} ${selected ? "selected" : ""}`}
      data-status-category={statusCategory}
    >
      {batchMode && (
        <label
          className={`project-batch-selector ${selectable ? "" : "disabled"}`}
          title={selectionReason}
        >
          <input
            type="checkbox"
            checked={selected}
            disabled={!selectable}
            onChange={onToggleSelected}
            aria-label={`选择项目 ${project.title}`}
          />
          <span>{selectable ? (selected ? "已选择" : "选择") : selectionReason}</span>
        </label>
      )}
      <button type="button" className="project-card" onClick={onOpen}>
        <div className="project-card-top">
          <StatusBadge status={project.status} runtime={project.runtime} />
          {project.archivedAt && (
            <span className="project-archived-badge">
              <Archive size={12} />已归档
            </span>
          )}
          <span
            className="project-updated"
            title={project.createdAt ? `启动时间：${project.createdAt}` : undefined}
          >
            {project.createdAt
              ? `启动于 ${formatRelativeTime(project.createdAt)}`
              : "启动时间未记录"}
          </span>
        </div>
        <div className="project-task-id">
          <span>任务 ID</span>
          <code>{project.id}</code>
        </div>
        <h3>{project.title}</h3>
        <p className="project-requirement">
          {project.requirement || "该项目尚未补充研究需求。"}
        </p>
        <OverallProgressBar progress={project.overallProgress} compact />
        <div className="project-card-context">
          <span className="cycle-chip">第 {project.cycle} 轮</span>
          <span
            className="project-token-total"
            title={`累计 ${formatTokenCount(project.tokenUsage?.totalTokens)} tokens；每 10 分钟更新`}
          >
            <Coins size={14} />
            <strong>{formatTokenCount(project.tokenUsage?.totalTokens)}</strong>
            <small>tokens</small>
          </span>
          {waitingForUser && (
            <span className="project-agent-state project-user-needed">
              <MessageSquareText size={14} />
              <small>流程等待用户回复</small>
            </span>
          )}
          {mainRecoveryRequired && (
            <span className="project-agent-state project-main-recovery-needed">
              <AlertTriangle size={14} />
              <small>Main 等待恢复</small>
            </span>
          )}
          {gatewayRecoveryRequired && (
            <span className="project-agent-state project-main-recovery-needed">
              <AlertTriangle size={14} />
              <small>网关异常，等待重试</small>
            </span>
          )}
          {!waitingForUser && statusCategory === "active" && project.currentAgent && (
            <span className="project-agent-state">
              <AgentBadge
                name={project.currentAgent}
                role={currentAgentRole ?? project.currentAgent}
                subtle
              />
              <small>执行中</small>
            </span>
          )}
          {!waitingForUser && statusCategory === "active" && project.queuedAgent && (
            <span className="project-agent-state project-agent-queued">
              <AgentBadge
                name={project.queuedAgent}
                role={queuedAgentRole ?? project.queuedAgent}
                subtle
              />
              <small>
                {project.runtime?.waiting?.reason ?? (project.status === "interrupted"
                  ? "等待断点恢复"
                  : project.queuePosition
                    ? `队列 #${project.queuePosition}${project.queueDepth ? ` / ${project.queueDepth}` : ""}`
                    : "等待资源")}
              </small>
            </span>
          )}
          {statusCategory === "stopping" && (
            <span className="project-agent-state project-agent-stopping">
              <Clock3 size={14} />
              <small>正在停止</small>
            </span>
          )}
          {statusCategory === "attention" &&
            !waitingForUser &&
            !mainRecoveryRequired &&
            !gatewayRecoveryRequired && (
              <span className="project-agent-state project-agent-attention">
                <AlertTriangle size={14} />
                <small>等待处理</small>
              </span>
            )}
          {statusCategory === "active" && !project.currentAgent && !project.queuedAgent ? (
            <span className="muted-label">{project.runtime?.waiting?.reason ?? "等待调度"}</span>
          ) : null}
        </div>
        <div className="project-card-footer">
          <div className="agent-stack" aria-label="项目智能体">
            {workflowOuterNodes(project.orchestration).slice(0, 6).map(
              (definition, index) => {
                const role = definition.definition?.template ?? "general";
                const meta = agentMeta(definition.id, role);
                return (
                <span
                  className={`agent-stack-item agent-${meta.color}`}
                  style={{ zIndex: 10 - index }}
                  key={definition.id}
                  title={definition.collaboration ? `${definition.displayName} · ${definition.collaboration.memberAgentIds.length} 名成员` : `${definition.id} · ${role}`}
                >
                  {definition.collaboration ? "组" : definition.id.slice(0, 1).toUpperCase()}
                </span>
                );
              }
            )}
            {workflowOuterNodes(project.orchestration).length > 6 && (
              <span className="agent-stack-more">
                +{workflowOuterNodes(project.orchestration).length - 6}
              </span>
            )}
          </div>
          <span className="open-project">
            打开工作台 <ArrowRight size={15} />
          </span>
        </div>
      </button>
      {waitingForUser && project.userIntervention && (
        <div className="project-user-intervention-strip">
          <span>
            <MessageSquareText size={18} />
            <span>
              <strong>需要用户介入</strong>
              <small>{project.userIntervention.message}</small>
            </span>
          </span>
          <Button
            variant="primary"
            icon={<ArrowRight size={15} />}
            onClick={onOpen}
          >
            查看并回复
          </Button>
        </div>
      )}
      {mainRecoveryRequired && (
        <div className="project-main-recovery-strip" role="alert">
          <span>
            <AlertTriangle size={18} />
            <span>
              <strong>Main 自动重试后仍未成功</strong>
              <small>恢复时继续原持久 thread，不修改项目配置。</small>
            </span>
          </span>
          <Button
            variant="primary"
            icon={<RefreshCw size={15} />}
            loading={lifecycleAction === "resume"}
            onClick={() => void changeLifecycle("resume")}
          >
            恢复 Main
          </Button>
        </div>
      )}
      {gatewayRecoveryRequired && (
        <div className="project-main-recovery-strip" role="alert">
          <span>
            <AlertTriangle size={18} />
            <span>
              <strong>网关工具参数连续异常</strong>
              <small>已自动更换一次 Session；重试会保留项目上下文与现有成果。</small>
            </span>
          </span>
          <Button
            variant="primary"
            icon={<RefreshCw size={15} />}
            loading={lifecycleAction === "resume"}
            onClick={() => void changeLifecycle("resume")}
          >
            重新尝试
          </Button>
        </div>
      )}
      {!mainRecoveryRequired && !gatewayRecoveryRequired && <div
        className="project-config-strip"
        role="group"
        aria-label={`项目 ${project.id} Agent 配置`}
      >
        <span>
          <Settings2 size={17} />
          <span>
            <strong>完整 Agent 配置</strong>
            <small>
              {configSaveNotice ||
                "保存 Prompt、Skills、MCP、模型、思考深度与运行参数"}
            </small>
          </span>
        </span>
        <Button
          variant="secondary"
          icon={<Save size={15} />}
          onClick={() => setSaveConfigOpen(true)}
          aria-label={`保存项目 ${project.id} 的 Agent 配置`}
        >
          保存配置
        </Button>
      </div>}
      {(canPause || canStart) && (
        <div
          className={`project-lifecycle-strip ${
            project.status === "interrupted"
              ? "recover"
              : canPause
                ? "pause"
                : "start"
          }`}
          role="group"
          aria-label={`项目 ${project.id} 运行控制`}
        >
          <span>
            {project.status === "interrupted" ? (
              <TimerReset size={17} />
            ) : canPause ? (
              <Pause size={17} />
            ) : (
              <Play size={17} />
            )}
            <span>
              <strong>
                {project.status === "interrupted"
                  ? `已保存到 ${displayAgentName(project.queuedAgent)} 断点`
                  : canPause
                    ? project.currentAgent
                      ? "项目正在运行"
                      : "项目正在等待调度"
                    : project.status === "pausing"
                      ? "项目正在安全暂停"
                      : "项目已暂停"}
              </strong>
              <small>
                {project.status === "interrupted"
                  ? "启动后重新运行该 Agent 并继续全流程"
                  : canPause
                    ? project.currentAgent
                      ? "暂停将在当前 Agent 到达安全边界后生效"
                      : "暂停后将从当前 Agent 队列中撤出"
                    : project.status === "pausing"
                      ? "启动可撤销暂停并继续当前科研流程"
                      : "启动后从保存状态继续科研流程"}
              </small>
            </span>
          </span>
          <Button
            variant={canPause ? "secondary" : "primary"}
            icon={
              project.status === "interrupted" ? (
                <TimerReset size={15} />
              ) : canPause ? (
                <Pause size={15} />
              ) : (
                <Play size={15} />
              )
            }
            loading={Boolean(lifecycleAction)}
            onClick={() =>
              void changeLifecycle(canPause ? "pause" : "resume")
            }
            aria-label={`${canPause ? "暂停" : "启动"}项目 ${project.id}`}
          >
            {canPause
              ? "暂停项目"
              : project.status === "interrupted"
                ? "启动并恢复"
                : "启动项目"}
          </Button>
        </div>
      )}
      {(project.archivedAt || project.status === "cancelled" || project.status === "completed" || (project.status === "paused" && project.git?.enabled)) && (
        <div className="project-archive-strip">
          <span>
            {project.archivedAt ? <ArchiveRestore size={17} /> : <Archive size={17} />}
            <span>
              <strong>{project.archivedAt ? "项目已归档" : project.status === "completed" ? "项目已完成，可安全归档" : project.status === "paused" ? "项目已暂停，可归档保留现场" : "已取消，可安全归档"}</strong>
              <small>
                {project.archivedAt
                  ? `归档于 ${formatRelativeTime(project.archivedAt)}`
                  : "归档只会从默认列表隐藏，不会删除轨迹与产物"}
              </small>
            </span>
          </span>
          {!batchMode && (
            <div className="project-archive-actions">
              <Button
                variant="secondary"
                icon={project.archivedAt ? <ArchiveRestore size={15} /> : <Archive size={15} />}
                loading={archiving}
                onClick={() => void archive()}
              >
                {project.archivedAt ? "取消归档" : "归档项目"}
              </Button>
              {project.archivedAt && (
                <Button
                  variant="danger"
                  icon={<Trash2 size={15} />}
                  onClick={onDelete}
                >
                  永久删除
                </Button>
              )}
            </div>
          )}
        </div>
      )}
      {lifecycleError && (
        <span className="project-lifecycle-error" role="alert">
          {lifecycleError}
        </span>
      )}
      {archiveError && (
        <span className="project-archive-error" role="alert">
          {archiveError}
        </span>
      )}
      {saveConfigOpen && (
        <SaveAgentConfigDialog
          projectId={project.id}
          projectTitle={project.title}
          onClose={() => setSaveConfigOpen(false)}
          onSave={async (title) => {
            const presetName = await onSaveConfig(title);
            setConfigSaveNotice(`${presetName} 已保存到配置库`);
          }}
        />
      )}
    </article>
  );
}

function ConfigPresetLibrary({
  presets,
  harnesses,
  gateways,
  onImport,
  onDownload,
  onDelete,
  onRename
}: {
  presets: AgentConfigPreset[];
  harnesses: HarnessCatalogEntry[];
  gateways: GatewayRecord[];
  onImport: (filename: string, text: string) => Promise<AgentConfigPreset>;
  onDownload: (preset: AgentConfigPreset) => void;
  onDelete: (preset: AgentConfigPreset) => Promise<void>;
  onRename: (preset: AgentConfigPreset, name: string) => Promise<void>;
}) {
  const [deletingId, setDeletingId] = useState("");
  const [renamingId, setRenamingId] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const importInput = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState("");
  const [preview, setPreview] = useState<AgentConfigPreset>();

  const importWorkflow = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || importing) return;
    setImportError("");
    if (!/\.json$/i.test(file.name) || file.size > 1_000_000) {
      setImportError("请选择不超过 1 MB 的 workflow.json 文件");
      return;
    }
    setImporting(true);
    try {
      const text = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("读取 workflow.json 失败"));
        reader.onload = () => resolve(String(reader.result ?? ""));
        reader.readAsText(file, "utf-8");
      });
      setPreview(await onImport(file.name, text));
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "导入 Workflow 失败");
    } finally {
      setImporting(false);
    }
  };

  const deletePreset = async (preset: AgentConfigPreset) => {
    if (preset.builtin) return;
    const confirmed = window.confirm(
      preset.importSource
        ? `确定删除 SDK Workflow“${preset.name}”吗？只删除已导入的可视化记录，不影响原始文件或任何课题。`
        : `确定删除配置“${preset.name}”吗？\n\n这是 Workflow 配置。配置删除后，已经使用它的项目副本不受影响，但将无法再更新或覆盖该配置；如需继续保存为可复用配置，请使用“另存为新配置”。`
    );
    if (!confirmed) return;
    setDeletingId(preset.id);
    setDeleteError("");
    try {
      await onDelete(preset);
      if (preview?.id === preset.id) setPreview(undefined);
    } catch (error) {
      setDeleteError(
        error instanceof Error ? error.message : "删除配置失败，请稍后重试。"
      );
    } finally {
      setDeletingId("");
    }
  };

  const renamePreset = async (preset: AgentConfigPreset) => {
    if (preset.builtin || renamingId) return;
    const name = window.prompt("重命名 Workflow 配置", preset.name)?.trim();
    if (!name || name === preset.name) return;
    setRenamingId(preset.id);
    setDeleteError("");
    try {
      await onRename(preset, name);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "重命名配置失败，请稍后重试。");
    } finally {
      setRenamingId("");
    }
  };

  return (
    <aside className="config-preset-library" aria-label="已有 Agent 配置">
      <header>
        <span>
          <Database size={16} />
          Agent 配置预设
        </span>
        <small>{presets.length} 项</small>
      </header>
      <div className="workflow-library-import">
        <button type="button" className="button button-secondary" disabled={importing} onClick={() => importInput.current?.click()}>
          <Upload size={15} />{importing ? "正在导入…" : "导入 SDK workflow.json"}
        </button>
        <input ref={importInput} className="workflow-json-file-input" type="file" accept=".json,application/json" aria-label="导入 SDK Workflow 文件" onChange={(event) => void importWorkflow(event)} />
        <small>导入后可预览原文，也可在快速发起中载入副本并配置网页网关。</small>
        {importError && <span className="config-preset-delete-error" role="alert">{importError}</span>}
      </div>
      <div className="config-preset-library-list">
        {presets.length ? (
          presets.map((preset) => {
            const agentCount = preset.orchestration.agents.length;
            const pathCount = 1 + Object.values(preset.orchestration.routes ?? {}).reduce((total, routes) => total + routes.length, 0);
            const mcpAssignmentCount = Object.values(preset.agents).reduce((total, config) => total + config.mcpServers.length, 0);
            return (
              <article key={preset.id}>
                <div>
                  <strong title={preset.name}>{preset.name} {preset.builtin && <em className="config-preset-builtin">系统默认</em>}</strong>
                  {preset.importSource && <small>SDK 导入 · 原文保留</small>}
                  <small>{agentCount} 个 Agent · {pathCount} 条路径</small>
                  <small>{mcpAssignmentCount} 个 MCP 绑定</small>
                  <small>更新时间：{preset.updatedAt ? formatRelativeTime(preset.updatedAt) : "系统内置"}</small>
                  {!preset.builtin && <small>来源：{preset.importSource?.filename ?? preset.sourceProjectTitle ?? preset.sourceProjectId ?? "未知项目"}</small>}
                </div>
                <div className="config-preset-actions">
                  <button type="button" onClick={() => setPreview(preset)} aria-label={`查看 Workflow ${preset.name}`} title="查看 Workflow"><Eye size={15} /></button>
                  <button
                    type="button"
                    onClick={() => preset.importSource ? downloadWorkflowSource(preset) : onDownload(preset)}
                    aria-label={`下载配置 ${preset.name}`}
                    title="下载 JSON"
                  >
                    <Download size={15} />
                  </button>
                  {!preset.builtin && (
                    <>
                      {!preset.importSource && <button
                        type="button"
                        onClick={() => void renamePreset(preset)}
                        disabled={Boolean(deletingId || renamingId)}
                        aria-label={`重命名配置 ${preset.name}`}
                        title="重命名配置"
                      >
                        <Pencil size={15} />
                      </button>}
                    <button
                      type="button"
                      className="config-preset-delete"
                      onClick={() => void deletePreset(preset)}
                      disabled={Boolean(deletingId)}
                      aria-label={`删除配置 ${preset.name}`}
                      title="删除配置"
                    >
                      <Trash2 size={15} />
                    </button>
                    </>
                  )}
                </div>
              </article>
            );
          })
        ) : (
          <p>暂无已保存配置</p>
        )}
      </div>
      {deleteError && (
        <span className="config-preset-delete-error" role="alert">
          {deleteError}
        </span>
      )}
      <small>保存与下载相互独立；下载不会修改配置库。</small>
      {preview && <WorkflowPresetPreview preset={preview} harnesses={harnesses} gateways={gateways} onClose={() => setPreview(undefined)} />}
    </aside>
  );
}

function SavedResearchTaskLibrary({
  tasks,
  loading,
  warning,
  startBlockedReason,
  startBlockedReasonForTask,
  startWarningForTask,
  onEdit,
  onDelete,
  onStart,
  onOpenProject
}: {
  tasks: SavedResearchTask[];
  loading: boolean;
  warning: string;
  startBlockedReason?: string;
  startBlockedReasonForTask?: (task: SavedResearchTask) => string;
  startWarningForTask?: (task: SavedResearchTask) => string;
  onEdit: (task: SavedResearchTask) => void;
  onDelete: (task: SavedResearchTask) => Promise<void>;
  onStart: (task: SavedResearchTask) => Promise<Project>;
  onOpenProject: (projectId: string) => void;
}) {
  const [expandedId, setExpandedId] = useState("");
  const [deletingId, setDeletingId] = useState("");
  const [startingId, setStartingId] = useState("");
  const [actionError, setActionError] = useState("");
  const [startedProject, setStartedProject] = useState<Project>();

  const deleteTask = async (task: SavedResearchTask) => {
    const confirmed = window.confirm(
      `确定删除已保存任务“${task.title}”吗？\n\n删除不会影响由它启动的科研项目。`
    );
    if (!confirmed) return;
    setDeletingId(task.id);
    setActionError("");
    try {
      await onDelete(task);
      if (expandedId === task.id) setExpandedId("");
    } catch (reason) {
      setActionError(
        reason instanceof Error ? reason.message : "删除已保存任务失败"
      );
    } finally {
      setDeletingId("");
    }
  };

  const startTask = async (task: SavedResearchTask) => {
    if (startingId || deletingId) return;
    setStartingId(task.id);
    setActionError("");
    setStartedProject(undefined);
    try {
      const project = await onStart(task);
      if (!project.id) throw new Error("任务已提交，但服务未返回项目 ID");
      setStartedProject(project);
    } catch (reason) {
      setActionError(
        reason instanceof Error ? reason.message : "已保存科研任务启动失败"
      );
    } finally {
      setStartingId("");
    }
  };

  return (
    <section className="saved-task-library" aria-label="已保存科研任务">
      <div className="saved-task-library-heading">
        <div>
          <span className="section-kicker">Reusable research briefs</span>
          <h2>保存任务</h2>
          <p>保存任务内容与完整 Agent 配置，按需修改并作为新课题再次启动。</p>
        </div>
        <span className="saved-task-count">
          <Save size={15} /> {tasks.length} 项
        </span>
      </div>

      {warning && (
        <div className="saved-task-warning" role="status">
          已保存任务暂不可用：{warning}
        </div>
      )}
      {startBlockedReason && !actionError && (
        <div className="saved-task-warning" role="alert">
          已保存任务暂不能启动：{startBlockedReason}
        </div>
      )}
      {actionError && (
        <div className="saved-task-warning" role="alert">
          {actionError}
        </div>
      )}
      {startedProject && (
        <div className="saved-task-started" role="status">
          <CheckCircle2 size={16} />
          <span>
            已启动新项目 <code>{startedProject.id}</code>
          </span>
          <button
            type="button"
            onClick={() => onOpenProject(startedProject.id)}
          >
            打开项目 <ArrowRight size={14} />
          </button>
        </div>
      )}

      {loading ? (
        <PageLoader label="正在读取已保存科研任务…" />
      ) : tasks.length ? (
        <div className="saved-task-list">
          {tasks.map((task) => {
            const expanded = expandedId === task.id;
            const taskStartBlockedReason = startBlockedReason || startBlockedReasonForTask?.(task) || "";
            const taskStartWarning = startWarningForTask?.(task) || "";
            const models = new Set(
              Object.values(task.agents).map((config) => config.model)
            ).size;
            const skillAssignments = Object.values(task.agents).reduce(
              (total, config) =>
                total +
                config.skills.length +
                config.autoSkills.length,
              0
            );
            const mcpAssignments = Object.values(task.agents).reduce(
              (total, config) => total + config.mcpServers.length,
              0
            );
            const outerNodes = workflowOuterNodes(task.orchestration);
            const agentCount = outerNodes.length;
            return (
              <article className={expanded ? "expanded" : ""} key={task.id}>
                <div className="saved-task-main-row">
                  <div className="saved-task-copy">
                    <span>
                      <strong>{task.title}</strong>
                      <small>更新于 {formatRelativeTime(task.updatedAt)}</small>
                    </span>
                    <p>{task.requirement}</p>
                    <div className="saved-task-metrics">
                      <span>{agentCount} 外层节点</span>
                      <span>Git {task.git?.enabled ? "开启" : "关闭"}</span>
                      <span>{models} 种模型</span>
                      <span>{skillAssignments} 个 Skill 绑定</span>
                      <span>{mcpAssignments} 个 MCP 绑定</span>
                    </div>
                    {taskStartBlockedReason && (
                      <small className="saved-task-start-blocked" role="status">
                        启动前检查未通过：{taskStartBlockedReason}
                      </small>
                    )}
                    {taskStartWarning && (
                      <small className="saved-task-start-blocked" role="status">
                        网关连接验证未通过，允许启动：{taskStartWarning}
                      </small>
                    )}
                  </div>
                  <div className="saved-task-actions" role="group">
                    <button
                      type="button"
                      onClick={() => setExpandedId(expanded ? "" : task.id)}
                      aria-expanded={expanded}
                      aria-label={`${expanded ? "收起" : "查看"}任务 ${task.title}`}
                    >
                      <Eye size={15} /> {expanded ? "收起" : "查看"}
                    </button>
                    <button
                      type="button"
                      onClick={() => onEdit(task)}
                      aria-label={`编辑任务 ${task.title}`}
                    >
                      <Pencil size={15} /> 编辑
                    </button>
                    <button
                      type="button"
                      className="saved-task-start"
                      onClick={() => void startTask(task)}
                      disabled={Boolean(startingId || deletingId)}
                      title={taskStartBlockedReason || undefined}
                      aria-label={`启动任务 ${task.title}`}
                    >
                      {startingId === task.id ? (
                        <RefreshCw className="spin" size={15} />
                      ) : (
                        <Play size={15} />
                      )}
                      启动
                    </button>
                    <button
                      type="button"
                      className="saved-task-delete"
                      onClick={() => void deleteTask(task)}
                      disabled={Boolean(startingId || deletingId)}
                      aria-label={`删除任务 ${task.title}`}
                    >
                      <Trash2 size={15} /> 删除
                    </button>
                  </div>
                </div>
                {expanded && (
                  <div className="saved-task-detail">
                    <div>
                      <strong>完整科研需求</strong>
                      <p>{task.requirement}</p>
                      <details className="saved-task-orchestration">
                        <summary>Agent 编排模板</summary>
                        <pre>{JSON.stringify(task.orchestration, null, 2)}</pre>
                      </details>
                    </div>
                    <div className="saved-task-agent-grid">
                      {(task.orchestration.collaborations ?? []).map((group) => <div className="saved-task-collaboration-summary" key={group.id}><strong>{group.displayName}</strong><small>协作组 · {group.memberAgentIds.length} 名成员</small><span>{group.memberAgentIds.join(" · ")}</span></div>)}
                      {task.orchestration.agents.map((definition) => {
                        const config = task.agents[definition.name];
                        const role = agentTemplateFor(task.orchestration, definition.name);
                        const meta = agentMeta(definition.name, role);
                        return (
                          <details key={definition.name}>
                            <summary
                              aria-label={`查看${definition.name}完整配置`}
                            >
                              <span className={`agent-${meta.color}`}>
                                <AgentIcon role={role} size={15} />
                              </span>
                              <span>
                                <strong>{definition.name}</strong>
                                <small>{definition.name === SYSTEM_CONTROLLER_AGENT ? "Main Agent" : `Worker · ${role}`}</small>
                                <code>{config.model}</code>
                                <small>
                                  {config.gatewaySnapshot?.reasoning?.label ?? config.gatewayReasoningOption ?? "Provider 默认"} · 固定 {config.skills.length} ·
                                  自动 {config.autoSkills.length} · MCP {config.mcpServers.length}
                                </small>
                              </span>
                            </summary>
                            <div className="saved-task-agent-config-detail">
                              <div className="saved-task-runtime-values">
                                <span>权限：{permissionLabel(config.permission)}</span>
                                <span>联网：{config.webSearch ? "开启" : "关闭"}</span>
                              </div>
                              <section>
                                <strong>Prompt</strong>
                                <pre>{config.instructions || "未设置"}</pre>
                              </section>
                              <section>
                                <strong>固定 Skills</strong>
                                <div className="saved-task-config-values">
                                  {config.skills.length
                                    ? config.skills.map((skill) => (
                                        <code key={skill}>{skill}</code>
                                      ))
                                    : <small>无</small>}
                                </div>
                              </section>
                              <section>
                                <strong>自动 Skills</strong>
                                <div className="saved-task-config-values">
                                  {config.autoSkills.length
                                    ? config.autoSkills.map((skill) => (
                                        <code key={skill}>{skill}</code>
                                      ))
                                    : <small>无</small>}
                                </div>
                              </section>
                              <section>
                                <strong>MCP</strong>
                                <div className="saved-task-config-values">
                                  {config.mcpServers.length
                                    ? config.mcpServers.map((server) => (
                                        <code key={agentMcpServerKey(server)}>
                                          {server.name} · {"project" in server ? `project:${server.project}` : server.url}
                                        </code>
                                      ))
                                    : <small>无</small>}
                                </div>
                              </section>
                            </div>
                          </details>
                        );
                      })}
                    </div>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      ) : (
        <EmptyState
          icon={<Save size={25} />}
          title="还没有保存任务"
          description="可在快速发起区或新课题页面保存任务副本，不会立即启动 Agent。"
        />
      )}
    </section>
  );
}

function QueueBoard({
  queue,
  queueError,
  projects,
  refreshing,
  onRefresh
}: {
  queue?: QueueSnapshot;
  queueError: string;
  projects: Project[];
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const titleById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.title])),
    [projects]
  );
  const roleNames = useMemo(
    () => ["main", "worker"] as const,
    [queue]
  );
  const queuedCount = queue
    ? roleNames.reduce(
        (total, role) => total + (queue[role]?.queued.length ?? 0),
        0
      )
    : 0;
  const displayedCapacity = queue?.worker?.capacity ?? 10;
  return (
    <section className="queue-board" aria-label="Agent 队列看板">
      <div className="queue-board-heading">
        <div>
          <span className="section-kicker">Agent scheduling</span>
          <h2>Agent 队列看板</h2>
          <p>
            按实际调用显示 Main / Leader 与 Worker。{queue ? `共享队列每类最多 ${displayedCapacity} 个任务，` : ""}协作项目使用各自的并发限制。
          </p>
        </div>
        <div className="queue-board-meta">
          <span>
            <ListTree size={15} />
            {queue ? `${queuedCount} 个等待任务` : "等待任务数量未读取"}
          </span>
          <Button
            variant="ghost"
            icon={<RefreshCw size={15} />}
            loading={refreshing}
            onClick={onRefresh}
          >
            刷新
          </Button>
        </div>
      </div>
      {queueError && (
        <div className="queue-board-warning" role="status">
          队列快照暂不可用：{queueError}
          {queue && "；当前显示最近一次成功读取的快照。"}
        </div>
      )}
      <div className="queue-role-grid">
        {roleNames.map((role) => {
          const roleQueue = queue?.[role];
          const meta = agentMeta(role, role === "main" ? "main" : "general");
          const capacity = roleQueue?.capacity ?? 10;
          const activeIds = roleQueue?.activeProjectIds ?? [];
          const activeTasks = roleQueue?.activeTasks ?? activeIds.map(projectId => ({ id: projectId, projectId, agentId: undefined, state: "running" as const }));
          const recovering = roleQueue?.recoveringTasks ?? [];
          const projectPools = roleQueue?.pools?.filter(pool => pool.scope === "project") ?? [];
          const minimumCapacity = Math.min(...projectPools.map(pool => pool.capacity));
          const maximumCapacity = Math.max(...projectPools.map(pool => pool.capacity));
          return (
            <article className={`queue-role-card agent-${meta.color}`} key={role}>
              <div className="queue-role-head">
                <span><AgentIcon role={role === "main" ? "main" : "general"} size={17} /></span>
                <div>
                  <strong>{role === "main" ? "Main / Leader" : meta.shortName}</strong>
                  <small>
                    {roleQueue ? `${projectPools.length ? `${activeTasks.length} 个调用中` : `${activeTasks.length}/${capacity} 槽占用`} · ${roleQueue.queued.length} 个排队` : "状态未读取"}
                  </small>
                  {!!projectPools.length && <small>{projectPools.length} 个项目队列 · 单项目并发上限 {minimumCapacity === maximumCapacity ? minimumCapacity : `${minimumCapacity}–${maximumCapacity}`}</small>}
                </div>
              </div>
              <div className="queue-active-task">
                <span
                  className={
                    activeTasks.length ? "queue-live-dot" : "queue-idle-dot"
                  }
                />
                <div>
                  <small>
                    {activeTasks.length ? `${activeTasks.length} 个任务正在执行`
                      : !roleQueue ? "等待队列快照" : projectPools.length ? "当前没有执行中的调用" : `${capacity} 个共享槽位空闲`}
                  </small>
                  {activeTasks.slice(0, 3).map((task) => (
                    <span className="queue-active-project" key={task.id}>
                      <strong>{titleById.get(task.projectId) ?? task.projectId}</strong>
                      {task.agentId && <small>{task.agentId} · {task.state === "starting" ? "正在启动" : "调用中"}</small>}
                      <code>{task.projectId}</code>
                    </span>
                  ))}
                  {activeTasks.length > 3 && (
                    <small>另有 {activeTasks.length - 3} 个运行任务</small>
                  )}
                  {!!recovering.length && <small>{recovering.length} 个调用等待恢复</small>}
                  {recovering.slice(0, 3).map(task => <span className="queue-active-project" key={task.id}>
                    <strong>{titleById.get(task.projectId) ?? task.projectId}</strong><small>{task.agentId ?? "Agent"} · 等待恢复</small>
                  </span>)}
                  {recovering.length > 3 && <small>另有 {recovering.length - 3} 个调用等待恢复</small>}
                </div>
              </div>
              {roleQueue?.queued.length ? (
                <div className="queue-waiting-list">
                  {roleQueue.queued.slice(0, 3).map((item) => (
                    <div key={item.id ?? item.projectId}>
                      <span>#{item.position}</span>
                      <p>
                        <strong>{titleById.get(item.projectId) ?? item.projectId}</strong>
                        {(item.agentId || item.reason) && <small>{[item.agentId, item.reason].filter(Boolean).join(" · ")}</small>}
                        {item.enteredAt && <small>
                          <Clock3 size={11} />
                          {formatRelativeTime(item.enteredAt)}
                        </small>}
                      </p>
                    </div>
                  ))}
                  {roleQueue.queued.length > 3 && (
                    <small>另有 {roleQueue.queued.length - 3} 个任务</small>
                  )}
                </div>
              ) : (
                <div className="queue-empty-slot">{roleQueue ? "没有等待任务" : "等待任务数量未读取"}</div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

export function ProjectListPage({
  onCreate,
  onOpen,
  onEditSavedTask,
  quickDraft
}: {
  onCreate: () => void;
  onOpen: (id: string) => void;
  onEditSavedTask?: (id: string) => void;
  quickDraft?: {
    requirement: string;
    onRequirementChange: (value: string) => void;
  };
}) {
  const [cachedProjectList] = useState(readCachedProjectList);
  const [projects, setProjects] = useState<Project[]>(cachedProjectList?.projects ?? []);
  const [cachedOverview] = useState(readCachedProjectOverview);
  const [hasProjectSnapshot, setHasProjectSnapshot] = useState(Boolean(cachedProjectList));
  const [loading, setLoading] = useState(!cachedProjectList);
  const [error, setError] = useState("");
  const [refreshWarning, setRefreshWarning] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [queue, setQueue] = useState<QueueSnapshot | undefined>(readCachedProjectQueue);
  const [queueError, setQueueError] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [showArchived, setShowArchived] = useState(false);
  const [visibleProjectLimit, setVisibleProjectLimit] = useState(PROJECT_PAGE_SIZE);
  const [archiveNotice, setArchiveNotice] = useState("");
  const [batchMode, setBatchMode] = useState(false);
  const [selectedProjectIds, setSelectedProjectIds] = useState<Set<string>>(
    () => new Set()
  );
  const [batchConfirmationOpen, setBatchConfirmationOpen] = useState(false);
  const [batchConfirmation, setBatchConfirmation] = useState("");
  const [batchRunning, setBatchRunning] = useState(false);
  const [managementFailures, setManagementFailures] = useState<
    Array<{ projectId: string; error: string }>
  >([]);
  const [deleteTarget, setDeleteTarget] = useState<Project>();
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [singleDeleteRunning, setSingleDeleteRunning] = useState(false);
  const [localQuickRequirement, setLocalQuickRequirement] = useState("");
  const quickRequirement = quickDraft?.requirement ?? localQuickRequirement;
  const setQuickRequirement = quickDraft?.onRequirementChange ?? setLocalQuickRequirement;
  const [quickSubmitting, setQuickSubmitting] = useState(false);
  const [quickError, setQuickError] = useState("");
  const [quickCreated, setQuickCreated] = useState<Project>();
  const [quickSaving, setQuickSaving] = useState(false);
  const [quickConfigSaving, setQuickConfigSaving] = useState(false);
  const [workflowSaveRevision, setWorkflowSaveRevision] = useState(0);
  const [quickSaveNotice, setQuickSaveNotice] = useState("");
  const [quickCanvasOpen, setQuickCanvasOpen] = useState(false);
  const [quickGitEnabled, setQuickGitEnabled] = useState(false);
  const [githubAccounts, setGithubAccounts] = useState<GitHubAccountRecord[]>([]);
  const [githubAccountsLoading, setGithubAccountsLoading] = useState(true);
  const [quickGithubAccountId, setQuickGithubAccountId] = useState<string>();
  const [quickExpandedGroupIds, setQuickExpandedGroupIds] = useState<Set<string>>(new Set());
  const [quickAdvancedOpen, setQuickAdvancedOpen] = useState(false);
  const [quickSaveMenuOpen, setQuickSaveMenuOpen] = useState(false);
  const [quickNewConfigDialogOpen, setQuickNewConfigDialogOpen] = useState(false);
  const [quickNewConfigName, setQuickNewConfigName] = useState("");
  const [quickNewConfigBlank, setQuickNewConfigBlank] = useState(false);
  const [configPresets, setConfigPresets] = useState<AgentConfigPreset[]>([]);
  const [mcpDirectory, setMcpDirectory] = useState<FixedMcpDefinition[]>([]);
  const [gateways, setGateways] = useState<GatewayRecord[]>([]);
  const [harnesses, setHarnesses] = useState<HarnessCatalogEntry[]>([]);
  const [defaultHarnessId, setDefaultHarnessId] = useState<string>();
  const [runtimeCatalogState, setRuntimeCatalogState] = useState<
    "loading" | "ready" | "failed" | "invalid"
  >("loading");
  const [runtimeCatalogError, setRuntimeCatalogError] = useState("");
  const [defaultGatewayId, setDefaultGatewayId] = useState<string>();
  const catalogGatewayRef = useRef<{
    defaultGatewayId?: string;
    gateways: GatewayRecord[];
    defaultHarnessId?: string;
    harnesses: HarnessCatalogEntry[];
  }>();
  const quickPresetIdRef = useRef("default");
  const quickImportedPresetRef = useRef(false);
  const [quickSkills, setQuickSkills] = useState<SkillDefinition[]>([]);
  const [quickPresetId, setQuickPresetId] = useState("default");
  const [quickWorkflowName, setQuickWorkflowName] = useState("未命名流程");
  const [quickOrchestration, setQuickOrchestration] =
    useState<AgentOrchestrationTemplate>(() =>
      cloneAgentOrchestration(DEFAULT_AGENT_ORCHESTRATION)
    );
  const [quickAgents, setQuickAgents] = useState<AgentsConfig>(() =>
    cloneAgentsConfig(DEFAULT_AGENTS)
  );
  const [quickSkillDefinitions, setQuickSkillDefinitions] = useState<ProjectSkillDefinitions>({});
  const [quickMcpDefinitions, setQuickMcpDefinitions] = useState<ProjectMcpDefinitions>({});
  const [configPresetWarning, setConfigPresetWarning] = useState("");
  const [savedTasks, setSavedTasks] = useState<SavedResearchTask[]>([]);
  const [savedTasksLoading, setSavedTasksLoading] = useState(true);
  const [savedTasksWarning, setSavedTasksWarning] = useState("");
  const loadInFlight = useRef(false);
  const queueLoadInFlight = useRef(false);
  const projectRequestRef = useRef(0);
  const hasProjectSnapshotRef = useRef(Boolean(cachedProjectList));
  const projectsRef = useRef(projects);
  const pageActiveRef = useRef(true);
  const lastTokenRefreshAt = useRef(cachedProjectList?.tokenRefreshedAt ?? 0);

  useEffect(() => {
    quickPresetIdRef.current = quickPresetId;
    const preset = configPresets.find((item) => item.id === quickPresetId);
    quickImportedPresetRef.current = Boolean(preset?.importSource);
  }, [quickPresetId, configPresets]);

  useEffect(() => {
    if (!gateways.length || !Object.values(quickAgents).some(
      (config) => config.legacyReasoningEffort || config.reasoningEffort
    )) return;
    setQuickAgents((current) => migrateLegacyAgentReasoning(current, gateways));
  }, [gateways, quickAgents]);

  useEffect(() => {
    if (!gateways.length) return;
    setSavedTasks((current) => {
      let changed = false;
      const next = current.map((task) => {
        const agents = migrateLegacyAgentReasoning(task.agents, gateways);
        if (agents === task.agents) return task;
        changed = true;
        return { ...task, agents };
      });
      return changed ? next : current;
    });
  }, [gateways, savedTasks]);

  const load = useCallback(async (initial = false, refreshTokens = false) => {
    if (!pageActiveRef.current) return;
    const requests: Promise<void>[] = [];
    // Cached cards stay visible during refresh. Project and queue requests
    // have separate locks so a slow queue cannot hold up the list or its polls.
    if (!loadInFlight.current) {
      const request = ++projectRequestRef.current;
      loadInFlight.current = true;
      if (initial && !hasProjectSnapshotRef.current) setLoading(true);
      setRefreshing(true);
      requests.push(
        getProjects(true).then((incoming) => {
          if (!pageActiveRef.current || request !== projectRequestRef.current) return;
          const updateTokenSnapshot = initial || refreshTokens;
          const current = projectsRef.current;
          const usageByProject = new Map(
            current.map((project) => [project.id, project.tokenUsage])
          );
          const next = updateTokenSnapshot || current.length === 0
            ? incoming
            : incoming.map((project) => ({
                ...project,
                tokenUsage: usageByProject.get(project.id) ?? project.tokenUsage
              }));
          if (updateTokenSnapshot) lastTokenRefreshAt.current = Date.now();
          projectsRef.current = next;
          hasProjectSnapshotRef.current = true;
          cacheProjectList(next, lastTokenRefreshAt.current);
          setProjects(next);
          setHasProjectSnapshot(true);
          setLoading(false);
          setError("");
          setRefreshWarning("");
        }).catch((reason: unknown) => {
          if (!pageActiveRef.current || request !== projectRequestRef.current) return;
          const message = reason instanceof Error ? reason.message : "无法连接项目服务";
          if (hasProjectSnapshotRef.current) setRefreshWarning(message);
          else setError(message);
          setLoading(false);
        }).finally(() => {
          if (request !== projectRequestRef.current) return;
          loadInFlight.current = false;
          if (pageActiveRef.current) setRefreshing(queueLoadInFlight.current);
        })
      );
    }
    if (!queueLoadInFlight.current) {
      queueLoadInFlight.current = true;
      setRefreshing(true);
      requests.push(
        getQueue().then((snapshot) => {
          if (!pageActiveRef.current) return;
          cacheProjectQueue(snapshot);
          setQueue(snapshot);
          setQueueError("");
        }).catch((reason: unknown) => {
          if (!pageActiveRef.current) return;
          setQueueError(reason instanceof Error ? reason.message : "队列快照加载失败");
        }).finally(() => {
          queueLoadInFlight.current = false;
          if (pageActiveRef.current) setRefreshing(loadInFlight.current);
        })
      );
    }
    await Promise.allSettled(requests);
  }, []);

  const publishProjectMutation = useCallback((update?: (current: Project[]) => Project[]) => {
    if (!pageActiveRef.current) return;
    // A GET started before a confirmed mutation must never restore deleted
    // cards or overwrite the cache with the previous archive/status snapshot.
    ++projectRequestRef.current;
    loadInFlight.current = false;
    if (update) {
      const next = update(projectsRef.current);
      projectsRef.current = next;
      hasProjectSnapshotRef.current = true;
      cacheProjectList(next, lastTokenRefreshAt.current);
      setProjects(next);
      setHasProjectSnapshot(true);
      setLoading(false);
      setError("");
    }
    setRefreshing(queueLoadInFlight.current);
  }, []);

  useEffect(() => {
    pageActiveRef.current = true;
    void load(true, true);
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      const tokenUsageIsStale =
        Date.now() - lastTokenRefreshAt.current >= 10 * 60_000;
      void load(false, tokenUsageIsStale);
    };
    const statusTimer = window.setInterval(refresh, 5_000);
    const tokenTimer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load(false, true);
    }, 10 * 60_000);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("openfars:saved-tasks-changed", refresh);
    return () => {
      pageActiveRef.current = false;
      window.clearInterval(statusTimer);
      window.clearInterval(tokenTimer);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("openfars:saved-tasks-changed", refresh);
    };
  }, [load]);

  useEffect(() => {
    let active = true;
    getAgentConfigPresets(true)
      .then((presets) => {
        if (!active) return;
        setConfigPresets(presets);
        const defaultPreset = presets.find((preset) => preset.id === "default");
        if (defaultPreset) {
          setQuickOrchestration(
            cloneAgentOrchestration(defaultPreset.orchestration)
          );
          const catalog = catalogGatewayRef.current;
          setQuickAgents(catalog
            ? applyCatalogDefaultGateway(
                applyCatalogDefaultHarness(cloneAgentsConfig(defaultPreset.agents), catalog.harnesses, catalog.defaultHarnessId),
                catalog.defaultGatewayId,
                catalog.gateways
              )
            : cloneAgentsConfig(defaultPreset.agents));
          setQuickWorkflowName(defaultPreset.name);
          setQuickSkillDefinitions(structuredClone(defaultPreset.skillDefinitions ?? {}));
          setQuickMcpDefinitions(structuredClone(defaultPreset.mcpDefinitions ?? {}));
        }
        setConfigPresetWarning("");
      })
      .catch((reason) => {
        if (!active) return;
        setConfigPresetWarning(
          reason instanceof Error ? reason.message : "Agent 配置预设加载失败"
        );
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    void getCatalog().then((catalog) => {
      if (!active) return;
      setMcpDirectory(Array.isArray(catalog.mcpDirectory) ? catalog.mcpDirectory : []);
      setQuickSkills((catalog.skills ?? []).filter((skill) => !isLarkSkill(skill)));
      setGateways(Array.isArray(catalog.gateways) ? catalog.gateways : []);
      setHarnesses(Array.isArray(catalog.harnesses) ? catalog.harnesses : []);
      setDefaultHarnessId(catalog.defaultHarnessId);
      const runtimeCatalogComplete =
        Array.isArray(catalog.gateways) && Array.isArray(catalog.harnesses);
      setRuntimeCatalogState(runtimeCatalogComplete ? "ready" : "invalid");
      setRuntimeCatalogError(runtimeCatalogComplete
        ? ""
        : "服务返回的运行目录不完整（缺少 Harness 或网关目录）");
      const gatewayCatalog = {
        defaultGatewayId: catalog.defaultGatewayId,
        gateways: Array.isArray(catalog.gateways) ? catalog.gateways : [],
        defaultHarnessId: catalog.defaultHarnessId,
        harnesses: Array.isArray(catalog.harnesses) ? catalog.harnesses : []
      };
      catalogGatewayRef.current = gatewayCatalog;
      setDefaultGatewayId(catalog.defaultGatewayId);
      // A catalog response may race with preset loading or a user's choice.
      // Only the system-default workflow receives the system default gateway;
      // a saved preset/task remains an explicit, user-owned configuration.
      if (quickPresetIdRef.current === "default") {
        setQuickAgents((current) => applyCatalogDefaultGateway(
          applyCatalogDefaultHarness(current, gatewayCatalog.harnesses, gatewayCatalog.defaultHarnessId),
          gatewayCatalog.defaultGatewayId,
          gatewayCatalog.gateways
        ));
      } else if (!quickImportedPresetRef.current) {
        setQuickAgents((current) => applyCatalogDefaultHarness(
          current, gatewayCatalog.harnesses, gatewayCatalog.defaultHarnessId
        ));
      }
    }).catch((reason) => {
      if (!active) return;
      setRuntimeCatalogState("failed");
      setRuntimeCatalogError(
        reason instanceof Error ? reason.message : "Catalog 请求失败"
      );
    });
    return () => { active = false; };
  }, []);

  const refreshGitHubAccounts = useCallback(async () => {
    setGithubAccountsLoading(true);
    try {
      const catalog = await getGitHubAccounts();
      setGithubAccounts(catalog.accounts);
      setQuickGithubAccountId((selected) => selected
        ?? catalog.defaultAccountId
        ?? catalog.accounts.find((account) => account.status === "ready")?.id);
    } catch {
      setGithubAccounts([]);
    } finally {
      setGithubAccountsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshGitHubAccounts();
    const refreshOnReturn = () => {
      if (window.location.hash.replace(/^#/, "").split("?", 1)[0] === "/projects") {
        void refreshGitHubAccounts();
      }
    };
    window.addEventListener("hashchange", refreshOnReturn);
    return () => window.removeEventListener("hashchange", refreshOnReturn);
  }, [refreshGitHubAccounts]);

  useEffect(() => {
    let active = true;
    getSavedResearchTasks()
      .then((tasks) => {
        if (!active) return;
        setSavedTasks(tasks);
        setSavedTasksWarning("");
      })
      .catch((reason) => {
        if (!active) return;
        setSavedTasksWarning(
          reason instanceof Error ? reason.message : "已保存科研任务加载失败"
        );
      })
      .finally(() => {
        if (active) setSavedTasksLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const quickPreset = configPresets.find(
    (preset) => preset.id === quickPresetId
  );
  const defaultRoleTemplates =
    configPresets.find((preset) => preset.id === "default")?.agents ??
    DEFAULT_AGENTS;
  const quickOrchestrationError = agentOrchestrationError(quickOrchestration, quickGitEnabled);
  const quickGitRequiredByCollaborations = (quickOrchestration.collaborations?.length ?? 0) > 0;
  const quickGithubAccountReady = !quickGitEnabled || githubAccounts.some(
    (account) => account.id === quickGithubAccountId && account.status === "ready"
  );
  const quickRuntimeConfigErrors = agentRuntimeConfigurationErrors(
    quickOrchestration,
    quickAgents,
    gateways,
    harnesses,
    runtimeCatalogState === "ready"
  );
  const quickRuntimeConfigWarnings = agentRuntimeConfigurationWarnings(
    quickOrchestration,
    quickAgents,
    gateways,
    harnesses
  );
  const runtimeCatalogBlocker = runtimeCatalogState === "ready"
    ? catalogDefaultHarnessId(harnesses, defaultHarnessId)
      ? gateways.length > 0
        ? ""
        : "运行目录已加载，但服务端没有可用的全局网关。"
      : "运行目录已加载，但服务端没有可用的 Workflow Harness。"
    : runtimeCatalogState === "loading"
      ? "运行目录仍在加载，暂不能启动项目。"
      : runtimeCatalogState === "invalid"
        ? `运行目录尚未就绪，暂不能启动项目：${runtimeCatalogError}`
        : `运行目录加载失败，暂不能启动项目：${runtimeCatalogError}`;
  const savedTaskStartBlocker = (task: SavedResearchTask): string =>
    [
      agentOrchestrationError(task.orchestration, task.git?.enabled === true),
      task.git?.enabled && !githubAccounts.some(
        (account) => account.id === task.git?.accountId && account.status === "ready"
      ) ? "请编辑任务并选择一个授权正常的 GitHub 账号" : "",
      ...agentRuntimeConfigurationErrors(
        task.orchestration,
        task.agents,
        gateways,
        harnesses,
        runtimeCatalogState === "ready"
      )
    ].filter(Boolean).join("；");
  const savedTaskStartWarning = (task: SavedResearchTask): string =>
    agentRuntimeConfigurationWarnings(
      task.orchestration,
      task.agents,
      gateways,
      harnesses
    ).join("；");

  const applyQuickPreset = (presetId: string) => {
    setQuickPresetId(presetId);
    const preset = configPresets.find((item) => item.id === presetId);
    const nextOrchestration = preset?.importSource
      ? normalizeAgentOrchestration(preset.orchestration)
      : cloneAgentOrchestration(preset?.orchestration ?? DEFAULT_AGENT_ORCHESTRATION);
    setQuickOrchestration(nextOrchestration);
    const nextAgents = preset?.importSource
      ? normalizeAgents(preset.agents, nextOrchestration)
      : cloneAgentsConfig(preset?.agents ?? DEFAULT_AGENTS);
    setQuickAgents(presetId === "default"
      ? applyCatalogDefaultGateway(
          applyCatalogDefaultHarness(nextAgents, harnesses, defaultHarnessId),
          catalogGatewayRef.current?.defaultGatewayId ?? defaultGatewayId,
          catalogGatewayRef.current?.gateways ?? gateways
        )
      : preset?.importSource ? nextAgents : applyCatalogDefaultHarness(nextAgents, harnesses, defaultHarnessId));
    setQuickSkillDefinitions(structuredClone(preset?.skillDefinitions ?? {}));
    setQuickMcpDefinitions(structuredClone(preset?.mcpDefinitions ?? {}));
    setQuickWorkflowName(preset?.name ?? "未命名流程");
  };

  const setQuickGitMode = (enabled: boolean) => {
    if (!enabled && quickGitRequiredByCollaborations) return;
    if (!enabled) {
      try { setQuickOrchestration(orchestrationWithoutGit(quickOrchestration)); }
      catch (error) { setQuickError(error instanceof Error ? error.message : "当前 Workflow 无法关闭 Git 机制"); return; }
    }
    setQuickGitEnabled(enabled);
    setQuickError("");
    if (!enabled) return;
    const readyAccounts = githubAccounts.filter((account) => account.status === "ready");
    if (!readyAccounts.length) {
      window.location.hash = "/github-accounts";
      return;
    }
    if (!readyAccounts.some((account) => account.id === quickGithubAccountId)) {
      setQuickGithubAccountId(
        readyAccounts.find((account) => account.isDefault)?.id ?? readyAccounts[0]?.id
      );
    }
  };

  const addQuickSkill = async (title: string, content: string) => {
    if (title.trim().toLowerCase().startsWith("lark")) {
      throw new Error("Lark Skills 不在科研 Agent 的候选范围内");
    }
    const skill = await createUserSkill(title, content);
    if (isLarkSkill(skill)) {
      throw new Error("Lark Skills 不在科研 Agent 的候选范围内");
    }
    setQuickSkills((current) =>
      current.some((item) => item.id === skill.id) ? current : [...current, skill]
    );
    return skill;
  };

  const quickAvailableSkills = useMemo(() => [
    ...quickSkills,
    ...Object.keys(quickSkillDefinitions).map((name) => ({
      id: `project:${name}`,
      name,
      description: "当前 Workflow 的版本化 Project Skill",
      category: "项目 Skill"
    }))
  ], [quickSkillDefinitions, quickSkills]);

  const quickMcpOptions = useMemo(() => {
    const byKey = new Map<string, AgentMcpServer>();
    for (const server of mcpDirectory) {
      byKey.set(agentMcpServerKey(server), server);
    }
    for (const name of Object.keys(quickMcpDefinitions)) {
      const server: AgentMcpServer = { name, project: name };
      byKey.set(agentMcpServerKey(server), server);
    }
    for (const definition of quickOrchestration.agents) {
      for (const server of quickAgents[definition.name]?.mcpServers ?? []) {
        byKey.set(agentMcpServerKey(server), server);
      }
    }
    return [...byKey.values()];
  }, [mcpDirectory, quickAgents, quickMcpDefinitions, quickOrchestration.agents]);

  const submitQuickTask = async (event: FormEvent) => {
    event.preventDefault();
    if (quickSubmitting || quickSaving || quickConfigSaving) return;
    const requirement = quickRequirement.trim();
    const errors = [
      requirement.length < 10 && "请至少输入 10 个字符，说明研究目标与期望成果",
      runtimeCatalogBlocker,
      quickOrchestrationError && `Workflow：${quickOrchestrationError}`,
      !quickGithubAccountReady && "请选择一个授权正常的 GitHub 账号",
      ...quickRuntimeConfigErrors
    ].filter(Boolean);
    if (errors.length) {
      setQuickError(`启动前检查未通过：${errors.join("；")}`);
      return;
    }
    setQuickSubmitting(true);
    setQuickError("");
    setQuickSaveNotice("");
    setQuickCreated(undefined);
    try {
      const project = await createProject({
        title: quickTitle(requirement),
        requirement,
        agents: cloneAgentsConfig(quickAgents),
        orchestration: cloneAgentOrchestration(quickOrchestration),
        git: { enabled: quickGitEnabled, ...(quickGitEnabled ? { provider: "github" as const, accountId: quickGithubAccountId } : {}) },
        ...projectResourcesPayload(quickSkillDefinitions, quickMcpDefinitions)
      });
      if (!project.id) throw new Error("任务已提交，但服务未返回任务 ID");
      setQuickCreated(project);
      setQuickRequirement("");
      publishProjectMutation((current) => [project, ...current.filter((item) => item.id !== project.id)]);
      await load(false);
    } catch (reason) {
      setQuickError(reason instanceof Error ? reason.message : "任务提交失败");
    } finally {
      setQuickSubmitting(false);
    }
  };

  const saveQuickTask = async () => {
    const requirement = quickRequirement.trim();
    if (requirement.length < 10) {
      setQuickError("请至少输入 10 个字符，说明研究目标与期望成果。");
      return;
    }
    if (quickOrchestrationError) {
      setQuickError(quickOrchestrationError);
      return;
    }
    setQuickSaving(true);
    setQuickError("");
    setQuickSaveNotice("");
    try {
      const task = await createSavedResearchTask({
        title: quickTitle(requirement),
        requirement,
        agents: cloneAgentsConfig(quickAgents),
        orchestration: cloneAgentOrchestration(quickOrchestration),
        git: { enabled: quickGitEnabled, ...(quickGitEnabled ? { provider: "github" as const, accountId: quickGithubAccountId } : {}) },
        ...projectResourcesPayload(quickSkillDefinitions, quickMcpDefinitions)
      });
      setSavedTasks((current) => [
        task,
        ...current.filter((item) => item.id !== task.id)
      ]);
      setQuickSaveNotice(`“${task.title}”已保存，可在下方任务列表中编辑或启动。`);
      setWorkflowSaveRevision((revision) => revision + 1);
    } catch (reason) {
      setQuickError(
        reason instanceof Error ? reason.message : "研究任务副本保存失败"
      );
    } finally {
      setQuickSaving(false);
    }
  };

  const saveQuickWorkflow = async (action: "update" | "project" | "new", name?: string) => {
    setQuickSaveMenuOpen(false);
    if (action === "project") {
      await saveQuickTask();
      return;
    }
    const preset = configPresets.find((item) => item.id === quickPresetId);
    if (action === "update") {
      if (!preset || preset.builtin || preset.importSource) {
        setQuickError("系统默认配置及 SDK 导入原文不能覆盖更新，请选择另存为新配置");
        return;
      }
      if (!window.confirm(`确定覆盖更新 Workflow 配置“${preset.name}”吗？\n\n这会影响之后载入它的新项目，已经启动的项目不会改变。`)) return;
    }
    if (action === "new" && !name?.trim()) return;
    const blank = action === "new" && quickNewConfigBlank;
    const blankWorkflow = blank ? createBlankWorkflow() : undefined;
    const workflowAgents = blankWorkflow
      ? applyCatalogDefaultGateway(
          applyCatalogDefaultHarness(blankWorkflow.agents, harnesses, defaultHarnessId),
          defaultGatewayId,
          gateways
        )
      : quickAgents;
    const workflowOrchestration = blankWorkflow?.orchestration ?? quickOrchestration;
    const workflowSkillDefinitions = blankWorkflow ? {} : quickSkillDefinitions;
    const workflowMcpDefinitions = blankWorkflow ? {} : quickMcpDefinitions;
    const workflowName = (action === "new" ? name ?? "" : quickWorkflowName).trim() || preset?.name || "未命名流程";
    setQuickConfigSaving(true);
    setQuickError("");
    setQuickSaveNotice("");
    try {
      const saved = action === "update"
        ? await updateAgentConfigPreset(preset!.id, {
            name: workflowName,
            agents: cloneAgentsConfig(workflowAgents),
            orchestration: cloneAgentOrchestration(workflowOrchestration),
            ...projectResourcesPayload(workflowSkillDefinitions, workflowMcpDefinitions)
          })
        : await createAgentConfigPreset({
            name: workflowName,
            agents: cloneAgentsConfig(workflowAgents),
            orchestration: cloneAgentOrchestration(workflowOrchestration),
            ...projectResourcesPayload(workflowSkillDefinitions, workflowMcpDefinitions)
          });
      setConfigPresets((items) => action === "update"
        ? items.map((item) => item.id === saved.id ? saved : item)
        : [saved, ...items.filter((item) => item.id !== saved.id)]);
      setQuickPresetId(saved.id);
      setQuickAgents(cloneAgentsConfig(saved.agents));
      setQuickOrchestration(cloneAgentOrchestration(saved.orchestration));
      setQuickSkillDefinitions(structuredClone(saved.skillDefinitions ?? {}));
      setQuickMcpDefinitions(structuredClone(saved.mcpDefinitions ?? {}));
      setQuickWorkflowName(saved.name);
      setQuickNewConfigBlank(false);
      setQuickSaveNotice(action === "update" ? `${saved.name} 已更新` : `${saved.name} 已保存并载入当前 Workflow`);
      setWorkflowSaveRevision((revision) => revision + 1);
    } catch (reason) {
      setQuickError(reason instanceof Error ? reason.message : "Workflow 配置保存失败");
    } finally {
      setQuickConfigSaving(false);
    }
  };

  const openQuickNewConfigDialog = (blank = false) => {
    setQuickSaveMenuOpen(false);
    setQuickNewConfigBlank(blank);
    setQuickNewConfigName(blank ? "新建 Workflow" : `${quickPreset?.name ?? "Workflow"} 副本`);
    setQuickNewConfigDialogOpen(true);
  };

  const quickSavedFlows = useMemo(() => configPresets.map((preset) => ({
    id: preset.id,
    name: preset.name,
    builtin: preset.builtin,
    readOnly: Boolean(preset.importSource),
    agentCount: preset.orchestration.agents.length,
    pathCount: 1 + Object.values(preset.orchestration.routes ?? {}).reduce((total, routes) => total + routes.length, 0),
    updatedAt: preset.updatedAt
  })), [configPresets]);

  const renameQuickSavedFlow = async (id: string) => {
    const preset = configPresets.find((item) => item.id === id);
    if (!preset || preset.builtin || preset.importSource) return;
    const name = window.prompt("重命名 Workflow 配置", preset.name)?.trim();
    if (!name || name === preset.name) return;
    try {
      const updated = await updateAgentConfigPreset(preset.id, {
        name,
        agents: cloneAgentsConfig(preset.agents),
        orchestration: cloneAgentOrchestration(preset.orchestration),
        ...projectResourcesPayload(preset.skillDefinitions, preset.mcpDefinitions)
      });
      setConfigPresets((items) => items.map((item) => item.id === updated.id ? updated : item));
      if (quickPresetId === updated.id) setQuickWorkflowName(updated.name);
      setQuickSaveNotice(`${updated.name} 已重命名`);
    } catch (reason) {
      setQuickError(reason instanceof Error ? reason.message : "重命名配置失败");
    }
  };

  const deleteQuickSavedFlow = async (id: string) => {
    const preset = configPresets.find((item) => item.id === id);
    if (!preset || preset.builtin || !window.confirm(`确定删除配置“${preset.name}”吗？`)) return;
    try {
      await deleteAgentConfigPreset(id);
      const remaining = configPresets.filter((item) => item.id !== id);
      setConfigPresets(remaining);
      if (quickPresetId === id) {
        const fallback = remaining.find((item) => item.id === "default") ?? remaining[0];
        setQuickPresetId(fallback?.id ?? "default");
        const fallbackAgents = cloneAgentsConfig(fallback?.agents ?? DEFAULT_AGENTS);
        setQuickAgents(fallback?.id === "default"
          ? applyCatalogDefaultGateway(
              applyCatalogDefaultHarness(fallbackAgents, harnesses, defaultHarnessId),
              catalogGatewayRef.current?.defaultGatewayId ?? defaultGatewayId,
              catalogGatewayRef.current?.gateways ?? gateways
            )
          : fallbackAgents);
        setQuickOrchestration(cloneAgentOrchestration(fallback?.orchestration ?? DEFAULT_AGENT_ORCHESTRATION));
        setQuickSkillDefinitions(structuredClone(fallback?.skillDefinitions ?? {}));
        setQuickMcpDefinitions(structuredClone(fallback?.mcpDefinitions ?? {}));
        setQuickWorkflowName(fallback?.name ?? "未命名流程");
      }
    } catch (reason) {
      setQuickError(reason instanceof Error ? reason.message : "删除配置失败");
    }
  };

  const visibleProjects = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return projects
      .filter(
        (project) =>
          (showArchived
            ? Boolean(project.archivedAt)
            : !project.archivedAt && matchesFilter(project, filter)) &&
          (!keyword ||
            project.title.toLowerCase().includes(keyword) ||
            project.requirement.toLowerCase().includes(keyword))
      )
      .sort(compareProjectsByStartedAtDescending);
  }, [filter, projects, search, showArchived]);

  useEffect(() => {
    setVisibleProjectLimit(PROJECT_PAGE_SIZE);
    setSelectedProjectIds(new Set());
    setBatchConfirmationOpen(false);
    setBatchConfirmation("");
    setManagementFailures([]);
  }, [filter, search, showArchived]);

  const displayedProjects = visibleProjects.slice(0, visibleProjectLimit);

  const selectableVisibleProjects = displayedProjects.filter((project) =>
    showArchived
      ? Boolean(project.archivedAt)
      : project.status === "cancelled" || project.status === "completed" || (project.status === "paused" && Boolean(project.git?.enabled))
  );
  const allVisibleSelected = selectableVisibleProjects.length > 0 &&
    selectableVisibleProjects.every((project) => selectedProjectIds.has(project.id));
  const selectedProjects = projects.filter((project) =>
    selectedProjectIds.has(project.id)
  );

  const leaveBatchMode = () => {
    setBatchMode(false);
    setSelectedProjectIds(new Set());
    setBatchConfirmationOpen(false);
    setBatchConfirmation("");
  };

  const toggleProjectSelection = (projectId: string) => {
    setSelectedProjectIds((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  const toggleAllVisible = () => {
    setSelectedProjectIds((current) => {
      const next = new Set(current);
      if (allVisibleSelected) {
        for (const project of selectableVisibleProjects) next.delete(project.id);
      } else {
        for (const project of selectableVisibleProjects) next.add(project.id);
      }
      return next;
    });
  };

  const runBatchManagement = async () => {
    if (!selectedProjectIds.size) return;
    setBatchRunning(true);
    setManagementFailures([]);
    try {
      const result = showArchived
        ? await deleteArchivedProjects([...selectedProjectIds], "永久删除")
        : await archiveProjects([...selectedProjectIds]);
      const succeeded = new Set(
        result.results.filter((item) => item.ok).map((item) => item.projectId)
      );
      const failures = result.results
        .filter((item) => !item.ok)
        .map((item) => ({
          projectId: item.projectId,
          error: item.error || "操作失败"
        }));
      setManagementFailures(failures);
      if (showArchived) {
        publishProjectMutation((current) => current.filter((project) => !succeeded.has(project.id)));
      } else {
        const updated = new Map(
          result.results.flatMap((item) => item.ok && item.project
            ? [[item.projectId, item.project] as const]
            : [])
        );
        publishProjectMutation((current) => current.map((project) => updated.get(project.id) ?? project));
      }
      setArchiveNotice(
        `${showArchived ? "永久删除" : "归档"}完成：成功 ${result.successCount} 个，失败 ${result.failureCount} 个。`
      );
      setSelectedProjectIds(new Set(failures.map((item) => item.projectId)));
      setBatchConfirmationOpen(false);
      setBatchConfirmation("");
    } catch (reason) {
      setManagementFailures([{
        projectId: "批量请求",
        error: reason instanceof Error ? reason.message : "批量操作失败"
      }]);
    } finally {
      setBatchRunning(false);
    }
  };

  const runSingleDelete = async () => {
    if (!deleteTarget || deleteConfirmation !== deleteTarget.title) return;
    setSingleDeleteRunning(true);
    setManagementFailures([]);
    try {
      await deleteArchivedProject(deleteTarget.id, deleteConfirmation);
      publishProjectMutation((current) => current.filter((project) => project.id !== deleteTarget.id));
      setArchiveNotice(`项目“${deleteTarget.title}”已永久删除。`);
      setDeleteTarget(undefined);
      setDeleteConfirmation("");
    } catch (reason) {
      setManagementFailures([{
        projectId: deleteTarget.id,
        error: reason instanceof Error ? reason.message : "项目删除失败"
      }]);
    } finally {
      setSingleDeleteRunning(false);
    }
  };

  const currentProjects = projects.filter((project) => !project.archivedAt);
  const overview = useMemo(() => {
    if (!hasProjectSnapshot) return cachedOverview;
    const current = projects.filter((project) => !project.archivedAt);
    const statusCounts = current.reduce<Record<ProjectStatusCategory, number>>((counts, project) => {
      counts[classifyProjectStatus(project.status)] += 1;
      return counts;
    }, { active: 0, attention: 0, stopping: 0, terminal: 0 });
    return { total: current.length, archived: projects.length - current.length, statusCounts,
      totalCycles: current.reduce((sum, project) => sum + project.cycle, 0) };
  }, [cachedOverview, hasProjectSnapshot, projects]);
  const archivedCount = overview?.archived ?? 0;
  const statusCounts = overview?.statusCounts;

  useEffect(() => {
    if (hasProjectSnapshot && overview) cacheProjectOverview(overview);
  }, [hasProjectSnapshot, overview]);

  return (
    <main className="projects-page">
      <section className="projects-hero">
        <div className="hero-copy">
          <span className="eyebrow">
            <Sparkles size={15} />
            从问题到结果，持续自主推进
          </span>
          <h1>
            让科研智能体
            <span>协作完成可验证的研究结果</span>
          </h1>
          <p>
            编排任意通用 Worker。每一步有迹可循，流程根据全局证据安排下一步、用户介入或结束。
          </p>
          <Button
            variant="primary"
            icon={<Plus size={18} />}
            onClick={onCreate}
            className="hero-action"
          >
            发起新课题
          </Button>
        </div>
        <div className="hero-system-card" aria-hidden="true">
          <div className="orbit orbit-one" />
          <div className="orbit orbit-two" />
          <span className="system-node system-node-main">
            <BrainCircuit size={25} />
          </span>
          <span className="system-node system-node-idea">构思</span>
          <span className="system-node system-node-run">实验</span>
          <span className="system-node system-node-worker">Worker</span>
          <span className="system-node system-node-review">结果</span>
          <div className="system-card-caption">
            <span className="pulse-dot" />
            流程正在协调全局
          </div>
        </div>
      </section>

      <section className="overview-strip" aria-label="项目统计" aria-busy={loading || refreshing}>
        <div>
          <FolderKanban size={20} />
          <span>
            <strong>{overview?.total ?? "—"}</strong>
            全部课题
          </span>
        </div>
        <div aria-label={`正在推进 ${statusCounts?.active ?? "—"}`}>
          <TimerReset size={20} />
          <span>
            <strong>{statusCounts?.active ?? "—"}</strong>
            正在推进
          </span>
        </div>
        <div aria-label={`待处理 ${statusCounts?.attention ?? "—"}`}>
          <AlertTriangle size={20} />
          <span>
            <strong>{statusCounts?.attention ?? "—"}</strong>
            待处理
          </span>
        </div>
        <div aria-label={`正在停止 ${statusCounts?.stopping ?? "—"}`}>
          <Clock3 size={20} />
          <span>
            <strong>{statusCounts?.stopping ?? "—"}</strong>
            正在停止
          </span>
        </div>
        <div aria-label={`已结束 ${statusCounts?.terminal ?? "—"}`}>
          <CheckCircle2 size={20} />
          <span>
            <strong>{statusCounts?.terminal ?? "—"}</strong>
            已结束
          </span>
        </div>
        <div>
          <Sparkles size={20} />
          <span>
            <strong>{overview?.totalCycles ?? "—"}</strong>
            累计迭代
          </span>
        </div>
      </section>

      <div className="quick-task-row">
        <section className="quick-task-section">
          <div className="quick-task-copy">
            <span className="section-kicker">Continuous intake</span>
            <h2>快速发起研究任务</h2>
            <p>直接描述需求并选择 Agent 配置预设；提交后可继续输入下一条。</p>
            <span className="quick-default-note">
              <Users size={15} />
              {quickPreset?.name ?? "系统默认配置"} · {quickOrchestration.agents.length} 个科研智能体
            </span>
          </div>
          <form className="quick-task-form" onSubmit={submitQuickTask} noValidate>
            <label className="quick-config-preset">
              <span>
                <Settings2 size={14} /> Agent 配置预设
              </span>
              <select
                value={quickPresetId}
                onChange={(event) => applyQuickPreset(event.target.value)}
                aria-label="快速启动 Agent 配置"
              >
                {!configPresets.some((preset) => preset.id === "default") && (
                  <option value="default">系统默认配置</option>
                )}
                {configPresets.map((preset) => (
                  <option value={preset.id} key={preset.id}>
                    {preset.name}
                    {preset.sourceProjectId
                      ? ` · ${preset.sourceProjectId.slice(-8)}`
                      : ""}
                  </option>
                ))}
              </select>
              <small>
                默认使用当前系统配置；保存及导入的配置会出现在这里。
              </small>
            </label>
            {quickPreset?.importSource && <p role="status">已载入 SDK Workflow 的可编辑副本，原文不变。启动采用网页端调度规则（包括 Main 路由与会话约束），不保证与 SDK CLI 等价；请配置每个 Agent 的网页网关，并检查 Skills、MCP。修改后可另存为新配置。</p>}
            <div className="quick-workflow-preview">
              <WorkflowCanvasEditor
                orchestration={quickOrchestration}
                agents={quickAgents}
                compact
                workflowName={quickWorkflowName}
                onWorkflowNameChange={setQuickWorkflowName}
                savedFlows={quickSavedFlows}
                skills={quickAvailableSkills}
                onAddSkill={addQuickSkill}
                mcpOptions={quickMcpOptions}
                mcpDirectory={mcpDirectory}
                gateways={gateways}
                harnesses={harnesses}
                gitEnabled={quickGitEnabled}
                onGitEnabledChange={setQuickGitMode}
                githubAccounts={githubAccounts}
                githubAccountId={quickGithubAccountId}
                githubAccountsLoading={githubAccountsLoading}
                onGitHubAccountChange={(accountId) => { setQuickGithubAccountId(accountId); setQuickError(""); }}
                expandedGroupIds={quickExpandedGroupIds}
                onExpandedGroupIdsChange={setQuickExpandedGroupIds}
                activeSavedFlowId={quickPresetId}
                onLoadSavedFlow={applyQuickPreset}
                onRenameSavedFlow={(id) => void renameQuickSavedFlow(id)}
                onDeleteSavedFlow={(id) => void deleteQuickSavedFlow(id)}
                onCreateSavedFlow={() => openQuickNewConfigDialog(true)}
                onSaveSavedFlow={(id) => { if (id === quickPresetId) void saveQuickWorkflow("update"); }}
                onDownload={() => { if (quickPreset) downloadAgentConfigPreset(quickPreset); }}
                saveRevision={workflowSaveRevision}
                onOrchestrationChange={(value) => {
                  setQuickOrchestration(value);
                  if (quickError) setQuickError("");
                }}
                onAgentsChange={(value) => {
                  setQuickAgents((current) => applyCatalogDefaultHarnessToNewAgents(
                    current,
                    applyCatalogDefaultGatewayToNewAgents(current, value, defaultGatewayId, gateways),
                    harnesses,
                    defaultHarnessId
                  ));
                  if (quickError) setQuickError("");
                }}
                onOpenTextEditor={() => setQuickCanvasOpen(true)}
              />
              <button type="button" className="workflow-text-editor-entry" onClick={() => setQuickAdvancedOpen(true)}>
                <Settings2 size={15} /> 高级配置
              </button>
            </div>
            <label className={`quick-git-opt-in ${quickGitEnabled ? "is-enabled" : ""}`}>
              <span><strong>启用 Git 机制</strong><small>{quickGitEnabled && quickGitRequiredByCollaborations ? "当前 Workflow 包含协作组，请先移除所有协作组再关闭 Git 机制。" : "使用 Git 管理代码与研究产物，支持独立 Agent 和协作组执行。"}</small></span>
              <input type="checkbox" role="switch" aria-label="快速发起启用 Git 机制" checked={quickGitEnabled} disabled={quickGitEnabled && quickGitRequiredByCollaborations} title={quickGitEnabled && quickGitRequiredByCollaborations ? "请先移除所有协作组再关闭 Git 机制" : undefined} onChange={(event) => setQuickGitMode(event.target.checked)} />
              <b>{quickGitEnabled ? "已开启" : "未开启"}</b>
            </label>
            {quickGitEnabled && <GitHubAccountSelector accounts={githubAccounts} selectedAccountId={quickGithubAccountId} loading={githubAccountsLoading} onChange={(accountId) => { setQuickGithubAccountId(accountId); setQuickError(""); }} />}
            <label>
              <span className="sr-only">研究任务需求</span>
              <textarea
                value={quickRequirement}
                onChange={(event) => {
                  setQuickRequirement(event.target.value);
                  if (quickError) setQuickError("");
                  if (quickSaveNotice) setQuickSaveNotice("");
                }}
                onKeyDown={(event) => {
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
                placeholder="描述研究问题、数据约束、评价指标和期望产物…"
                rows={4}
                maxLength={8000}
                aria-invalid={Boolean(quickError)}
              />
            </label>
            <div className="quick-task-actions">
              <span>{quickRequirement.trim().length.toLocaleString()} / 8,000</span>
              <small>⌘ / Ctrl + Enter 提交</small>
              <div className="workflow-save-menu-wrap">
                <Button
                  type="button"
                  variant="secondary"
                  icon={<Save size={16} />}
                  loading={quickConfigSaving}
                  onClick={() => setQuickSaveMenuOpen((open) => !open)}
                  aria-haspopup="menu"
                  aria-expanded={quickSaveMenuOpen}
                >
                  保存
                </Button>
                {quickSaveMenuOpen && <div className="workflow-save-menu" role="menu">
                  <button type="button" role="menuitem" disabled={!quickPreset || quickPreset.builtin || Boolean(quickPreset.importSource) || quickConfigSaving} onClick={() => void saveQuickWorkflow("update")}><strong>更新当前配置</strong><small>{quickPreset?.importSource ? "SDK 原文不可覆盖，请另存为新配置" : quickPreset?.builtin ? "系统默认配置不可覆盖" : "覆盖当前可复用 Workflow 配置"}</small></button>
                  <button type="button" role="menuitem" disabled={quickRequirement.trim().length < 10 || quickSaving || Boolean(quickOrchestrationError)} onClick={() => void saveQuickWorkflow("project")}><strong>仅本次项目使用</strong><small>保存当前项目副本，不修改配置库</small></button>
                  <button type="button" role="menuitem" disabled={quickConfigSaving} onClick={() => openQuickNewConfigDialog()}><strong>另存为新配置</strong><small>创建可复用配置并切换到它</small></button>
                </div>}
              </div>
              <Button
                type="button"
                variant="secondary"
                icon={<Save size={16} />}
                loading={quickSaving}
                disabled={quickRequirement.trim().length < 10 || Boolean(quickOrchestrationError)}
                onClick={() => void saveQuickTask()}
              >
                保存研究任务副本
              </Button>
              <Button
                type="submit"
                variant="primary"
                icon={<Send size={17} />}
                loading={quickSubmitting}
                disabled={quickSaving || quickConfigSaving}
              >
                提交并继续
              </Button>
            </div>
            {quickError && <span className="quick-task-error" role="alert">{quickError}</span>}
            {!quickError && quickRuntimeConfigErrors.length > 0 && (
              <span className="quick-task-error" role="alert">
                启动前配置检查未通过：{quickRuntimeConfigErrors.join("；")}
              </span>
            )}
            {quickRuntimeConfigWarnings.length > 0 && (
              <span className="quick-task-error" role="alert">
                网关连接验证未通过，允许启动：{quickRuntimeConfigWarnings.join("；")}
              </span>
            )}
            {!quickError && runtimeCatalogBlocker && (
              <span className="quick-task-error" role={runtimeCatalogState === "loading" ? "status" : "alert"}>
                {runtimeCatalogBlocker} 仍可保存研究任务副本，稍后再启动。
              </span>
            )}
            {quickSaveNotice && (
              <span className="quick-task-save-notice" role="status">
                <CheckCircle2 size={15} /> {quickSaveNotice}
              </span>
            )}
            {configPresetWarning && (
              <span className="quick-task-warning">
                配置预设暂不可用，将使用系统默认配置：{configPresetWarning}
              </span>
            )}
            {quickCreated && (
              <div className="quick-task-success" role="status">
                <CheckCircle2 size={17} />
                <span>
                  已创建 <code>{quickCreated.id}</code>，可继续提交下一条需求。
                </span>
                <button type="button" onClick={() => onOpen(quickCreated.id)}>
                  查看任务 <ArrowRight size={14} />
                </button>
              </div>
            )}
          </form>
        </section>
        <ConfigPresetLibrary
          presets={configPresets}
          harnesses={harnesses}
          gateways={gateways}
          onImport={async (filename, text) => {
            const imported = await importAgentConfigPreset(filename, text);
            setConfigPresets((current) => [imported, ...current.filter((item) => item.id !== imported.id)]);
            return imported;
          }}
          onDownload={downloadAgentConfigPreset}
          onRename={async (preset, name) => {
            const updated = await updateAgentConfigPreset(preset.id, {
              name,
              agents: cloneAgentsConfig(preset.agents),
              orchestration: cloneAgentOrchestration(preset.orchestration),
              ...projectResourcesPayload(preset.skillDefinitions, preset.mcpDefinitions)
            });
            setConfigPresets((current) => current.map((item) => item.id === updated.id ? updated : item));
            setQuickSaveNotice(`${updated.name} 已重命名`);
          }}
          onDelete={async (preset) => {
            await deleteAgentConfigPreset(preset.id);
            setConfigPresets((current) =>
              current.filter((item) => item.id !== preset.id)
            );
            setQuickPresetId((current) =>
              current === preset.id ? "default" : current
            );
            if (quickPresetId === preset.id) {
              const defaultPreset = configPresets.find(
                (item) => item.id === "default"
              );
              setQuickOrchestration(
                cloneAgentOrchestration(
                  defaultPreset?.orchestration ??
                    DEFAULT_AGENT_ORCHESTRATION
                )
              );
              setQuickSkillDefinitions(structuredClone(defaultPreset?.skillDefinitions ?? {}));
              setQuickMcpDefinitions(structuredClone(defaultPreset?.mcpDefinitions ?? {}));
              const fallbackAgents = cloneAgentsConfig(defaultPreset?.agents ?? DEFAULT_AGENTS);
              setQuickAgents(defaultPreset
                ? applyCatalogDefaultGateway(
                    applyCatalogDefaultHarness(fallbackAgents, harnesses, defaultHarnessId),
                    catalogGatewayRef.current?.defaultGatewayId ?? defaultGatewayId,
                    catalogGatewayRef.current?.gateways ?? gateways
                  )
                : fallbackAgents);
            }
          }}
        />
      </div>

      {quickCanvasOpen && (
        <div className="workflow-canvas-dialog" role="dialog" aria-modal="true" aria-label="编辑快速发起 Workflow">
          <div className="workflow-canvas-dialog-backdrop" aria-hidden="true" />
          <div className="workflow-canvas-dialog-panel">
            <div className="workflow-canvas-dialog-head">
              <div><strong>编辑当前 Workflow</strong><small>快速发起任务使用当前项目上下文，修改会立即同步预览。</small></div>
              <button type="button" onClick={() => setQuickCanvasOpen(false)} aria-label="关闭 Workflow 编辑器">×</button>
            </div>
            <div className="workflow-canvas-dialog-scroll">
              <WorkflowCanvasEditor
                orchestration={quickOrchestration}
                agents={quickAgents}
                onOrchestrationChange={(value) => { setQuickOrchestration(value); setQuickError(""); }}
                onAgentsChange={(value) => { setQuickAgents((current) => applyCatalogDefaultHarnessToNewAgents(current, applyCatalogDefaultGatewayToNewAgents(current, value, defaultGatewayId, gateways), harnesses, defaultHarnessId)); setQuickError(""); }}
                workflowName={quickWorkflowName}
                onWorkflowNameChange={setQuickWorkflowName}
                savedFlows={quickSavedFlows}
                skills={quickAvailableSkills}
                onAddSkill={addQuickSkill}
                mcpOptions={quickMcpOptions}
                mcpDirectory={mcpDirectory}
                gateways={gateways}
                harnesses={harnesses}
                gitEnabled={quickGitEnabled}
                onGitEnabledChange={setQuickGitMode}
                githubAccounts={githubAccounts}
                githubAccountId={quickGithubAccountId}
                githubAccountsLoading={githubAccountsLoading}
                onGitHubAccountChange={(accountId) => { setQuickGithubAccountId(accountId); setQuickError(""); }}
                expandedGroupIds={quickExpandedGroupIds}
                onExpandedGroupIdsChange={setQuickExpandedGroupIds}
                activeSavedFlowId={quickPresetId}
                onLoadSavedFlow={applyQuickPreset}
                onRenameSavedFlow={(id) => void renameQuickSavedFlow(id)}
                onDeleteSavedFlow={(id) => void deleteQuickSavedFlow(id)}
                onCreateSavedFlow={() => openQuickNewConfigDialog(true)}
                onSaveSavedFlow={(id) => { if (id === quickPresetId) void saveQuickWorkflow("update"); }}
                onDownload={() => { if (quickPreset) downloadAgentConfigPreset(quickPreset); }}
                saveRevision={workflowSaveRevision}
                onSave={() => { setQuickCanvasOpen(false); setQuickSaveMenuOpen(true); }}
                onClose={() => setQuickCanvasOpen(false)}
                saving={quickSaving || quickConfigSaving}
              />
            </div>
          </div>
        </div>
      )}

      {quickAdvancedOpen && (
        <div className="workflow-modal-backdrop" role="presentation">
          <section className="workflow-modal workflow-advanced-config" role="dialog" aria-modal="true" aria-labelledby="quick-advanced-heading">
            <div className="workflow-modal-heading">
              <span className="workflow-modal-icon"><Settings2 size={18} /></span>
              <div><strong id="quick-advanced-heading">高级配置</strong><p>编辑文字版 Workflow 及快速启动使用的 Agent 配置。</p></div>
              <button type="button" className="icon-button" onClick={() => setQuickAdvancedOpen(false)} aria-label="关闭高级配置">×</button>
            </div>
            <div className="workflow-text-editor-section">
              <div className="workflow-text-editor-heading"><span><ListTree size={15} /> 文字版 Workflow 编排</span><small>与缩略画布共享同一份数据</small></div>
              <OrchestrationTemplateEditor
                value={quickOrchestration}
                agents={quickAgents}
                roleTemplates={defaultRoleTemplates}
                onChange={(value) => { setQuickOrchestration(value); setQuickError(""); }}
                onAgentsChange={(value) => { setQuickAgents((current) => applyCatalogDefaultHarnessToNewAgents(current, applyCatalogDefaultGatewayToNewAgents(current, value, defaultGatewayId, gateways), harnesses, defaultHarnessId)); setQuickError(""); }}
              />
            </div>
            <div className="workflow-modal-actions"><button type="button" onClick={() => setQuickAdvancedOpen(false)}>完成</button></div>
          </section>
        </div>
      )}

      {quickNewConfigDialogOpen && (
        <div className="workflow-modal-backdrop" role="presentation">
          <section className="workflow-modal" role="dialog" aria-modal="true" aria-labelledby="quick-new-config-heading">
            <div className="workflow-modal-heading">
              <span className="workflow-modal-icon"><Save size={18} /></span>
              <div>
                <strong id="quick-new-config-heading">另存为新 Workflow 配置</strong>
                <p>创建新的可复用配置，当前快速发起上下文会自动切换到它。</p>
              </div>
            </div>
            <label className="workflow-modal-field">
              <span>Workflow 配置名称</span>
              <input value={quickNewConfigName} onChange={(event) => setQuickNewConfigName(event.target.value)} autoFocus maxLength={160} aria-label="Workflow 配置名称" />
            </label>
            <div className="workflow-modal-actions">
              <button type="button" onClick={() => setQuickNewConfigDialogOpen(false)} disabled={quickConfigSaving}>取消</button>
              <button type="button" className="primary" disabled={!quickNewConfigName.trim() || quickConfigSaving} onClick={() => { const name = quickNewConfigName.trim(); setQuickNewConfigDialogOpen(false); void saveQuickWorkflow("new", name); }}>{quickConfigSaving ? "保存中…" : "保存新配置"}</button>
            </div>
          </section>
        </div>
      )}

      <SavedResearchTaskLibrary
        tasks={savedTasks}
        loading={savedTasksLoading}
        warning={savedTasksWarning}
        startBlockedReason={runtimeCatalogBlocker}
        startBlockedReasonForTask={savedTaskStartBlocker}
        startWarningForTask={savedTaskStartWarning}
        onEdit={(task) => onEditSavedTask?.(task.id)}
        onDelete={async (task) => {
          await deleteSavedResearchTask(task.id);
          setSavedTasks((current) =>
            current.filter((item) => item.id !== task.id)
          );
        }}
        onStart={async (task) => {
          if (runtimeCatalogBlocker) throw new Error(runtimeCatalogBlocker);
          const taskBlocker = savedTaskStartBlocker(task);
          if (taskBlocker) throw new Error(taskBlocker);
          const project = await createProject({
            sourceSavedTaskId: task.id,
            title: task.title,
            requirement: task.requirement,
            agents: cloneAgentsConfig(task.agents),
            orchestration: cloneAgentOrchestration(task.orchestration),
            git: task.git ?? { enabled: false },
            ...projectResourcesPayload(task.skillDefinitions, task.mcpDefinitions)
          });
          publishProjectMutation((current) => [project, ...current.filter((item) => item.id !== project.id)]);
          await load(false);
          return project;
        }}
        onOpenProject={onOpen}
      />

      <QueueBoard
        queue={queue}
        queueError={queueError}
        projects={currentProjects}
        refreshing={refreshing}
        onRefresh={() => void load(false, true)}
      />

      <section className="projects-section">
        <div className="section-heading">
          <div>
            <span className="section-kicker">Research portfolio</span>
            <h2>科研项目</h2>
            <small className="token-refresh-note">
              <Coins size={13} /> Token 消耗每 10 分钟更新
            </small>
          </div>
          <div className="project-heading-actions">
            <Button
              variant={showArchived ? "primary" : "secondary"}
              icon={showArchived ? <ArchiveRestore size={17} /> : <Archive size={17} />}
              onClick={() => {
                setShowArchived((value) => !value);
                setArchiveNotice("");
                leaveBatchMode();
              }}
            >
              {showArchived ? "返回当前项目" : `已归档（${overview?.archived ?? "—"}）`}
            </Button>
            <Button
              variant={batchMode ? "primary" : "secondary"}
              icon={<CheckCircle2 size={17} />}
              onClick={() => batchMode ? leaveBatchMode() : setBatchMode(true)}
            >
              {batchMode ? "退出批量管理" : "批量管理"}
            </Button>
            <Button variant="secondary" icon={<Plus size={17} />} onClick={onCreate}>
              新建项目
            </Button>
          </div>
        </div>

        {batchMode && (
          <div className="project-batch-bar" role="region" aria-label="批量管理项目">
            <label>
              <input
                type="checkbox"
                checked={allVisibleSelected}
                disabled={!selectableVisibleProjects.length}
                onChange={toggleAllVisible}
              />
              全选当前页面中的可{showArchived ? "删除" : "归档"}项目
            </label>
            <span>
              已选择 <strong>{selectedProjectIds.size}</strong> 个
              {!showArchived && ` · 已完成或已取消项目可归档`}
            </span>
            <Button
              variant={showArchived ? "danger" : "primary"}
              icon={showArchived ? <Trash2 size={15} /> : <Archive size={15} />}
              disabled={!selectedProjectIds.size}
              onClick={() => {
                setBatchConfirmation(showArchived ? "" : "确认归档");
                setBatchConfirmationOpen(true);
              }}
            >
              {showArchived ? "永久删除所选" : "归档所选"}
            </Button>
          </div>
        )}

        <div className="project-toolbar">
          {showArchived ? (
            <span className="archive-view-label">
              <Archive size={15} />
              已归档项目不会进入 Agent 队列，数据仍完整保留
            </span>
          ) : (
            <div className="filter-tabs" role="tablist" aria-label="筛选项目">
              {FILTERS.map((item) => (
                <button
                  key={item.id}
                  className={filter === item.id ? "active" : ""}
                  onClick={() => setFilter(item.id)}
                  role="tab"
                  aria-selected={filter === item.id}
                >
                  {item.label}
                </button>
              ))}
            </div>
          )}
          <label className="search-field">
            <Search size={17} />
            <span className="sr-only">搜索项目</span>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索课题或关键词"
            />
          </label>
        </div>

        {refreshWarning && (
          <div className="projects-refresh-warning">
            <RefreshCw size={14} />
            自动刷新失败：{refreshWarning}
          </div>
        )}
        {archiveNotice && (
          <div className="projects-archive-notice" role="status">
            <CheckCircle2 size={15} />
            {archiveNotice}
          </div>
        )}
        {managementFailures.length > 0 && (
          <div className="project-management-failures" role="alert">
            <strong>以下项目未完成操作：</strong>
            <ul>
              {managementFailures.map((failure) => (
                <li key={failure.projectId}>
                  <code>{failure.projectId}</code>
                  <span>{failure.error}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {loading ? (
          <PageLoader label="正在整理科研项目…" />
        ) : error ? (
          <ErrorPanel
            message={error}
            action={
              <Button variant="secondary" onClick={() => void load(true)}>
                重新加载
              </Button>
            }
          />
        ) : visibleProjects.length ? (
          <>
          <div className="project-grid">
            {displayedProjects.map((project) => (
              <ProjectCard
                project={project}
                batchMode={batchMode}
                selected={selectedProjectIds.has(project.id)}
                selectable={showArchived || project.status === "cancelled" || project.status === "completed" || (project.status === "paused" && Boolean(project.git?.enabled))}
                selectionReason={showArchived
                  ? undefined
                  : project.status === "cancelled" || project.status === "completed" || (project.status === "paused" && project.git?.enabled)
                    ? undefined
                    : "已完成、已取消或已暂停的 Git 项目可归档"}
                onToggleSelected={() => toggleProjectSelection(project.id)}
                onOpen={() => onOpen(project.id)}
                onPause={async () => {
                  await projectAction(project.id, "pause");
                  publishProjectMutation();
                  await load(false);
                }}
                onResume={async () => {
                  await projectAction(project.id, "resume");
                  publishProjectMutation();
                  await load(false);
                }}
                onArchive={async () => {
                  const restoring = Boolean(project.archivedAt);
                  await projectAction(
                    project.id,
                    restoring ? "unarchive" : "archive"
                  );
                  publishProjectMutation((current) => current.map((item) => item.id === project.id
                    ? { ...item, archivedAt: restoring ? undefined : new Date().toISOString() }
                    : item));
                  setArchiveNotice(
                    restoring
                      ? `项目 ${project.id} 已取消归档。`
                      : `项目 ${project.id} 已归档，轨迹与产物均已保留。`
                  );
                  await load(false);
                }}
                onDelete={() => {
                  setDeleteTarget(project);
                  setDeleteConfirmation("");
                  setManagementFailures([]);
                }}
                onSaveConfig={async (title) => {
                  const preset = await saveProjectAgentConfigPreset(
                    project.id,
                    title
                  );
                  setConfigPresets((current) => {
                    const next = [
                      ...current.filter((item) => item.id !== preset.id),
                      preset
                    ];
                    return [
                      ...next.filter((item) => item.builtin),
                      ...next
                        .filter((item) => !item.builtin)
                        .sort((left, right) =>
                          (right.updatedAt ?? "").localeCompare(
                            left.updatedAt ?? ""
                          )
                        )
                    ];
                  });
                  return preset.name;
                }}
                key={project.id}
              />
            ))}
          </div>
          {displayedProjects.length < visibleProjects.length && (
            <div className="project-grid-more">
              <p>
                已显示 <strong>{displayedProjects.length}</strong> / {visibleProjects.length} 个项目
                <span>分批呈现可保持列表浏览与筛选流畅</span>
              </p>
              <Button
                variant="secondary"
                onClick={() => setVisibleProjectLimit((current) => current + PROJECT_PAGE_SIZE)}
              >
                再显示 {Math.min(PROJECT_PAGE_SIZE, visibleProjects.length - displayedProjects.length)} 个
              </Button>
            </div>
          )}
          </>
        ) : showArchived ? (
          <EmptyState
            icon={<Archive size={27} />}
            title={archivedCount ? "没有匹配的已归档项目" : "还没有归档项目"}
            description={
              archivedCount
                ? "换一个关键词继续搜索。"
                : "已完成或已取消的项目会显示归档按钮，归档不会删除任何数据。"
            }
          />
        ) : currentProjects.length ? (
          <EmptyState
            icon={<Search size={26} />}
            title={search.trim() ? FILTER_EMPTY_STATES.all.title : FILTER_EMPTY_STATES[filter].title}
            description={search.trim()
              ? FILTER_EMPTY_STATES.all.description
              : FILTER_EMPTY_STATES[filter].description}
          />
        ) : (
          <EmptyState
            icon={<BrainCircuit size={28} />}
            title="从一个值得研究的问题开始"
            description="输入课题方向并配置智能体，Idea Agent 会立即开始形成研究方案。"
            action={
              <Button variant="primary" icon={<Plus size={17} />} onClick={onCreate}>
                创建第一个项目
              </Button>
            }
          />
        )}
      </section>

      {batchConfirmationOpen && (
        <div className="workflow-modal-backdrop" role="presentation">
          <section
            className="workflow-modal project-management-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="batch-project-action-heading"
          >
            <div className="workflow-modal-heading">
              <span className="workflow-modal-icon">
                {showArchived ? <Trash2 size={18} /> : <Archive size={18} />}
              </span>
              <div>
                <strong id="batch-project-action-heading">
                  {showArchived ? "永久删除已归档项目" : "批量归档项目"}
                </strong>
                <p>
                  将逐项处理 {selectedProjects.length} 个项目；某一项失败不会阻止其他项目。
                  {showArchived && " 删除后状态、轨迹、Session、工作区、产物和原始数据均无法恢复。"}
                </p>
              </div>
            </div>
            {showArchived && (
              <label className="workflow-modal-field">
                <span>输入“永久删除”确认</span>
                <input
                  value={batchConfirmation}
                  onChange={(event) => setBatchConfirmation(event.target.value)}
                  autoFocus
                  aria-label="批量删除确认词"
                />
              </label>
            )}
            <div className="workflow-modal-actions">
              <button
                type="button"
                onClick={() => setBatchConfirmationOpen(false)}
                disabled={batchRunning}
              >
                取消
              </button>
              <button
                type="button"
                className={showArchived ? "danger" : "primary"}
                disabled={
                  batchRunning ||
                  !selectedProjects.length ||
                  (showArchived && batchConfirmation !== "永久删除")
                }
                onClick={() => void runBatchManagement()}
              >
                {batchRunning ? "处理中…" : showArchived ? "永久删除" : "确认归档"}
              </button>
            </div>
          </section>
        </div>
      )}

      {deleteTarget && (
        <div className="workflow-modal-backdrop" role="presentation">
          <section
            className="workflow-modal project-management-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-project-heading"
          >
            <div className="workflow-modal-heading">
              <span className="workflow-modal-icon"><Trash2 size={18} /></span>
              <div>
                <strong id="delete-project-heading">永久删除已归档项目</strong>
                <p>
                  这会永久删除项目的全部状态、轨迹、Session、工作区、产物和原始数据，无法恢复。
                </p>
              </div>
            </div>
            <label className="workflow-modal-field">
              <span>输入项目名称“{deleteTarget.title}”确认</span>
              <input
                value={deleteConfirmation}
                onChange={(event) => setDeleteConfirmation(event.target.value)}
                autoFocus
                aria-label="项目名称确认"
              />
            </label>
            <div className="workflow-modal-actions">
              <button
                type="button"
                onClick={() => {
                  setDeleteTarget(undefined);
                  setDeleteConfirmation("");
                }}
                disabled={singleDeleteRunning}
              >
                取消
              </button>
              <button
                type="button"
                className="danger"
                disabled={singleDeleteRunning || deleteConfirmation !== deleteTarget.title}
                onClick={() => void runSingleDelete()}
              >
                {singleDeleteRunning ? "删除中…" : "永久删除"}
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
