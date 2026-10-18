import { ArrowLeft, Eye, FileText, Github, Globe2, LockKeyhole, Pencil, Plus, Settings2, Trash2, X } from "lucide-react";
import { useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type FocusEvent, type RefObject } from "react";
import type {
  AgentConfig,
  CollaborationNode,
  AgentHarness,
  AgentDefinition,
  AgentMcpServer,
  AgentOrchestrationTemplate,
  AgentTemplate,
  FixedMcpDefinition,
  GatewayRecord,
  GitHubAccountRecord,
  GitRepositoryVisibility,
  HarnessCatalogEntry,
  SkillDefinition,
  WorkflowCanvasEdgeLayout,
  WorkflowEdge,
  WorkflowLoop,
  ScopedCollaboration
} from "../../types";
import type { CanvasEdge, CanvasNode } from "./core/canvas-model";
import type { CanvasLayoutGraphMode } from "./core/canvas-layout";
import { McpServerControl } from "../McpServerControl";
import { ExperimentMcpControl } from "../ExperimentMcpControl";
import { AgentToolRecommendation } from "../AgentToolRecommendation";
import type { AgentToolSelection } from "../../api";
import { CreateSkillDialog } from "../CreateSkillDialog";
import {
  agentMeta,
  catalogDefaultHarnessId,
  gatewayCombinationTestState,
  gatewayHarnessTestState,
  gatewayModelTestOptions,
  gatewayReasoningOptionIsValid,
  gatewayReasoningOptions,
  harnessOptionsForPurpose,
  isAgentIdentifier,
  protocolLabel
} from "../../lib";
import { workflowLoopMembers } from "../../../../server/src/internal/shared/workflow-loop-validation.js";
import { collaborationMemberRefs, workflowOuterNodes } from "./core/workflow-nodes";
import { AGENT_PERMISSION_METADATA as PERMISSION_META } from "../../../../server/src/internal/shared/agent-permission-metadata.js";

import { CanvasTextDraftContext } from "./CanvasTextDraftContext";

const RESULT_FORMAT_PRESETS = ["论文", "代码", "Markdown 文件", "图片", "表格", "其他"] as const;

export interface CanvasInspectorProps {
  node?: CanvasNode;
  agent?: AgentConfig;
  definition?: AgentDefinition;
  orchestration: AgentOrchestrationTemplate;
  readOnly?: boolean;
  harnessConstraint?: { harnessId: string; reason: string };
  skills?: SkillDefinition[];
  onAddSkill?: (title: string, content: string) => Promise<SkillDefinition>;
  mcpOptions?: AgentMcpServer[];
  mcpDirectory?: FixedMcpDefinition[];
  gateways?: GatewayRecord[];
  harnesses?: HarnessCatalogEntry[];
  edges?: CanvasEdge[];
  allEdges?: CanvasEdge[];
  layoutMode?: CanvasLayoutGraphMode;
  selectedEdge?: CanvasEdge;
  scopeKind?: "root" | "collaboration";
  onSelectProblemNode?: (id: string) => void;
  onRemoveAgent?: () => void;
  onAgentPatch?: (patch: Partial<AgentConfig>) => void;
  toolRecommendationApplyNotice?: string;
  onDescriptionChange?: (description: string) => void;
  onRenameAgent?: (name: string) => void;
  onRenameValidityChange?: (invalid: boolean) => void;
  onTemplateChange?: (template: AgentTemplate) => void;
  newEdgeKind?: "strong" | "weak";
  onNewEdgeKindChange?: (kind: "strong" | "weak") => void;
  onInputTargetChange?: (target: string) => void;
  onTerminationAgentChange?: (target: string) => void;
  onTerminationConditionChange?: (condition: string) => void;
  onDecisionPlanChange?: (value: string) => void;
  onSessionPersistenceChange?: (enabled: boolean) => void;
  onWeakDecisionByChange?: (decisionBy: "main" | "agent") => void;
  onEdgeKindChange?: (id: string, kind: WorkflowEdge["kind"]) => void;
  onEdgeTargetChange?: (id: string, target: string) => void;
  onAddConnection?: (source: string, target: string, kind: "strong" | "weak") => void;
  onEdgeLayoutChange?: (id: string, patch: Partial<WorkflowCanvasEdgeLayout>) => void;
  onEdgeRemove?: (id: string) => void;
  onLoopChange?: (loopId: string, patch: Partial<WorkflowLoop>) => void;
  onAddMcp?: (name: string, url: string) => AgentMcpServer | Promise<AgentMcpServer>;
  onToggleMcp?: (server: AgentMcpServer, enabled: boolean) => void;
  collaboration?: CollaborationNode;
  /** Present when the inspector is editing an Agent hidden inside a collaboration node. */
  collaborationParent?: CollaborationNode;
  collaborationLocked?: boolean;
  collaborationLockReason?: string;
  onCollaborationChange?: (value: CollaborationNode) => void;
  scopedCollaboration?: ScopedCollaboration;
  onScopedCollaborationChange?: (value: ScopedCollaboration) => void;
  onDissolveCollaboration?: (group: CollaborationNode) => void;
  onEnterCollaboration?: (groupId: string) => void;
  onEditCollaborationMember?: (agentId: string) => void;
  onReturnToCollaboration?: () => void;
  onOrchestrationChange?: (value: AgentOrchestrationTemplate) => void;
  gitEnabled?: boolean;
  onGitEnabledChange?: (enabled: boolean) => void;
  githubAccounts?: GitHubAccountRecord[];
  githubAccountId?: string;
  githubAccountsLoading?: boolean;
  gitRepositoryName?: string;
  gitRepositoryVisibility?: GitRepositoryVisibility;
  onGitRepositoryConfigure?: () => void;
}

export function CanvasInspector({
  node, agent, definition, orchestration, readOnly = false, harnessConstraint, skills = [], mcpOptions, mcpDirectory = [], edges = [], selectedEdge, scopeKind = "root",
  allEdges = [], layoutMode = "directed", onSelectProblemNode,
  gateways = [], harnesses = [],
  onRemoveAgent, onAgentPatch, toolRecommendationApplyNotice, onDescriptionChange, onRenameAgent, onRenameValidityChange,
  newEdgeKind = "strong", onNewEdgeKindChange,
  onTerminationAgentChange, onTerminationConditionChange, onDecisionPlanChange,
  onSessionPersistenceChange, onWeakDecisionByChange, onEdgeKindChange,
  onEdgeTargetChange, onAddConnection, onEdgeLayoutChange, onEdgeRemove,
  onLoopChange, onAddMcp, onToggleMcp, onAddSkill,
  collaboration, collaborationParent, collaborationLocked = false,
  collaborationLockReason, onCollaborationChange, scopedCollaboration, onScopedCollaborationChange, onDissolveCollaboration, onEnterCollaboration, onEditCollaborationMember,
  onReturnToCollaboration, onOrchestrationChange,
  gitEnabled = false, onGitEnabledChange, githubAccounts = [], githubAccountId,
  githubAccountsLoading = false, gitRepositoryName = "", gitRepositoryVisibility = "private",
  onGitRepositoryConfigure
}: CanvasInspectorProps) {
  if (selectedEdge) {
    return <ConnectionInspector edge={selectedEdge} orchestration={orchestration} scopeKind={scopeKind} readOnly={readOnly} onKindChange={onEdgeKindChange} onLayoutChange={onEdgeLayoutChange} onRemove={onEdgeRemove} onLoopChange={onLoopChange} />;
  }
  if (!node) {
    const businessEdges = allEdges.filter((edge) => !edge.fixed && edge.source !== "input");
    const inputTarget = allEdges.find((edge) => edge.source === "input")?.target;
    const finishAgent = allEdges.find((edge) => edge.target === "finish")?.source;
    const warnings: Array<{ message: string; nodeId?: string }> = [];
    if (!inputTarget) warnings.push({ message: "用户输入尚未连接", nodeId: "input" });
    if (!finishAgent) warnings.push({ message: "结束节点尚未连接", nodeId: "finish" });
    const outerNodes = workflowOuterNodes(orchestration);
    for (const definition of outerNodes) {
      // allEdges includes the implicit semantic termination connection used
      // by legacy projects, so a valid finish owner is not reported as a
      // dead end merely because its old route array omitted `finish`.
      if (definition.id !== "main" && !allEdges.some((edge) => edge.source === definition.id)) {
        warnings.push({ message: `${definition.displayName} 没有后续路径`, nodeId: definition.id });
      }
    }
    const firstProblem = warnings.find((warning) => warning.nodeId)?.nodeId;
    const globalReadOnly = readOnly || !onOrchestrationChange;
    const commitGlobal = (update: (draft: AgentOrchestrationTemplate) => void) => {
      if (globalReadOnly) return;
      const draft = structuredClone(orchestration);
      update(draft);
      onOrchestrationChange?.(draft);
    };
    const resultFormat = orchestration.resultFormat ?? { presets: [], custom: "" };
    const gitLocked = gitEnabled && (orchestration.collaborations?.length ?? 0) > 0;
    const selectedGitHubAccount = githubAccounts.find((account) => account.id === githubAccountId);
    return <aside className="inspector" aria-label="Workflow 全局摘要">
      <header className="inspector-header"><div className="inspector-title"><h2>流程设置</h2><p><span>流程概览</span> · 全局行为与交付方式</p></div></header>
      <div className="inspector-body workflow-overview">
        <div className="workflow-overview-grid" aria-label="流程摘要">
          <div><strong>{outerNodes.length}</strong><span>外层节点</span></div>
          <div><strong>{businessEdges.length}</strong><span>业务边</span></div>
        </div>
        <dl className="workflow-overview-details">
          <div><dt>输入目标</dt><dd>{inputTarget ? edgeTitle(inputTarget) : "未连接"}</dd></div>
          <div><dt>终止外层节点</dt><dd>{finishAgent ? edgeTitle(finishAgent) : "未连接"}</dd></div>
          <div><dt>布局模式</dt><dd>{layoutMode === "main-dispatch" ? "Main 调度中心" : "有向分层流程"}</dd></div>
        </dl>
        <section className={`workflow-overview-checks ${warnings.length ? "has-warnings" : "is-valid"}`}>
          <div><strong>{warnings.length ? `${warnings.length} 项需要检查` : "配置检查通过"}</strong><span>{warnings.length ? "优先处理以下问题" : "输入、路径与结束节点完整"}</span></div>
          {warnings.slice(0, 3).map((warning) => <p key={warning.message}>{warning.message}</p>)}
          {firstProblem && <button type="button" onClick={() => onSelectProblemNode?.(firstProblem)}>选择有问题节点</button>}
        </section>
        <section className="canvas-global-settings" aria-label="Workflow 全局设置">
          <div className="canvas-global-setting-heading"><strong>结果形式</strong><small>可多选并补充自然语言要求</small></div>
          <div className="canvas-result-presets" role="group" aria-label="画布结果形式">
            {RESULT_FORMAT_PRESETS.map((preset) => {
              const checked = resultFormat.presets.includes(preset);
              return <label className={checked ? "is-selected" : ""} key={preset}>
                <input type="checkbox" checked={checked} disabled={globalReadOnly} onChange={() => commitGlobal((draft) => {
                  const current = draft.resultFormat ?? { presets: [], custom: "" };
                    draft.resultFormat = {
                      ...current,
                      none: undefined,
                      presets: current.presets.includes(preset)
                      ? current.presets.filter((item) => item !== preset)
                      : [...current.presets, preset]
                  };
              })} />
              <span>{preset}</span>
            </label>;
            })}
          </div>
          <label className={`canvas-result-option${resultFormat.none ? " is-selected" : ""}`}>
            <input type="checkbox" checked={resultFormat.none === true} disabled={globalReadOnly} onChange={(event) => commitGlobal((draft) => {
              const current = draft.resultFormat ?? { presets: [], custom: "" };
              draft.resultFormat = event.target.checked
                ? { presets: [], custom: "", none: true }
                : { presets: [...(current.presets ?? [])], custom: current.custom ?? "" };
            })} />
            <span>无需额外成果</span>
          </label>
          <label className="canvas-result-custom"><span>补充交付要求</span><textarea aria-label="画布结果形式补充说明" rows={3} maxLength={20_000} disabled={globalReadOnly} value={resultFormat.custom} onChange={(event) => commitGlobal((draft) => {
            draft.resultFormat = { presets: [...resultFormat.presets], custom: event.target.value, none: undefined };
          })} /></label>
          <label className="canvas-setting-switch">
            <span><strong>用户介入</strong><small>允许 Main 暂停并请求人工决策</small></span>
            <input type="checkbox" role="switch" aria-label="画布允许用户介入" checked={orchestration.allowUserIntervention !== false} disabled={globalReadOnly} onChange={(event) => commitGlobal((draft) => { draft.allowUserIntervention = event.target.checked; })} />
          </label>
          <label className="canvas-setting-switch">
            <span><strong>Main 自动调整 Workflow</strong><small>运行中允许 Main 修改编排</small></span>
            <input type="checkbox" role="switch" aria-label="画布允许 Main 自动调整 Workflow" checked={orchestration.allowMainReconfiguration === true} disabled={globalReadOnly} onChange={(event) => commitGlobal((draft) => { draft.allowMainReconfiguration = event.target.checked; })} />
          </label>
          <label className="canvas-setting-switch">
            <span><strong>启用 Git 机制</strong><small>{gitLocked ? "当前 Workflow 包含协作组，请先移除所有协作组再关闭 Git 机制。" : "使用 Git 管理代码与研究产物，支持独立 Agent 和协作组执行。"}</small></span>
            <input type="checkbox" role="switch" aria-label="画布启用 Git 机制" checked={gitEnabled} disabled={readOnly || !onGitEnabledChange || gitLocked} onChange={(event) => { if (!readOnly && !gitLocked) onGitEnabledChange?.(event.target.checked); }} />
          </label>
          {gitEnabled && (
            <div className="canvas-git-repository-summary">
              <div className="canvas-git-repository-summary-head">
                <span><Github size={14} /><strong>GitHub 仓库设置</strong></span>
                <button type="button" disabled={readOnly || !onGitRepositoryConfigure} onClick={onGitRepositoryConfigure}><Settings2 size={13} />配置</button>
              </div>
              <dl>
                <div><dt>账号</dt><dd>{githubAccountsLoading ? "加载中…" : selectedGitHubAccount?.login ?? "未选择"}</dd></div>
                <div><dt>仓库</dt><dd>{gitRepositoryName.trim() || "自动生成"}</dd></div>
                <div><dt>可见性</dt><dd>{gitRepositoryVisibility === "private" ? <><LockKeyhole size={12} />Private</> : <><Globe2 size={12} />Public</>}</dd></div>
              </dl>
            </div>
          )}
        </section>
        <p className="workflow-overview-hint">选择节点可编辑局部属性；点击左侧“流程设置”可随时返回。</p>
      </div>
    </aside>;
  }
  if (collaboration) {
    const locked = readOnly || collaborationLocked;
    const refs = collaborationMemberRefs(orchestration, collaboration);
    const scoped = orchestration.schemaVersion === 3;
    return <aside className="inspector" aria-label="协作组属性面板">
      <header className="inspector-header">
        <div className="inspector-title"><h2>{collaboration.displayName}</h2><p>协作组 · 单一外层节点</p></div>
      </header>
      <div className="inspector-body collaboration-inspector">
        {collaborationLocked && <div className="fixed-note collaboration-lock-note" role="status"><strong>运行中不可编辑</strong><span>{collaborationLockReason ?? "协作组及最终 PR 尚未进入整体终态。历史运行记录不会回写。"}</span></div>}
        <section className="form-section">
          <h3 className="section-title"><span>组信息</span><small>{scoped ? `${refs.length} 个直接节点` : `${refs.length} 名成员`}</small></h3>
          <label><span>组 ID</span><input aria-label="协作组 ID" value={collaboration.id} disabled /></label>
          <label><span>显示名称</span><input aria-label="协作组显示名称" value={collaboration.displayName} maxLength={64} disabled={locked || collaboration.renamePolicy === "locked"} onChange={(event) => onCollaborationChange?.({ ...collaboration, displayName: event.target.value })} /></label>
          {collaboration.renamePolicy === "locked" && <small>该组显示名称由策略锁定。</small>}
          {orchestration.schemaVersion === 3 && scopedCollaboration && <label><span>弱边决策者</span><select aria-label="协作组弱边决策者" value={scopedCollaboration.decisionBy ?? "main"} disabled={locked} onChange={(event) => onScopedCollaborationChange?.({ ...scopedCollaboration, decisionBy: event.target.value as "main" | "agent" })}><option value="main">Main 选择</option><option value="agent">协作组自身选择（{scopedCollaboration.leaderAgentId}）</option></select><small>组完成后外层弱边由指定协调者正式选择。</small></label>}
        </section>
        <section className="form-section collaboration-member-editor">
          <h3 className="section-title"><span>{scoped ? "直接节点引用" : "成员"}</span><small>{refs.length} {scoped ? "个" : "名"}</small></h3>
          <p className="edge-type-help">{scoped ? "直接节点引用 Agent 或子协作组；Agent 的原范围节点、连线和 session 保留。" : "成员作为组内执行单元，不生成外层连线；选择成员可修改它的运行配置。"}</p>
          {orchestration.schemaVersion === 3 && <button type="button" className="primary-button" onClick={() => onEnterCollaboration?.(collaboration.id)}>进入组内 Workflow</button>}
          <ul className="collaboration-member-summary" aria-label="协作组成员">
            {refs.map((ref) => {
              const memberId = ref.kind === "agent" ? ref.agentId : ref.groupId;
              const member = ref.kind === "agent" ? orchestration.agents.find((entry) => entry.name === memberId) : undefined;
              return <li key={ref.nodeId}>
                <span className="collaboration-member-copy"><strong>{memberId}</strong><small>{scoped ? `${ref.kind === "agent" ? "Agent" : "协作组"} · ${ref.nodeId}` : member?.description ?? "组内 Agent"}</small></span>
                {orchestration.schemaVersion !== 3 && <button type="button" onClick={() => onEditCollaborationMember?.(memberId)} disabled={!onEditCollaborationMember} aria-label={`${locked ? "查看" : "编辑"}组内 Agent ${memberId}`}>{locked ? <Eye size={12} /> : <Pencil size={12} />}{locked ? "查看" : "编辑"}</button>}
              </li>;
            })}
          </ul>
        </section>
        <EdgeInspector sourceId={collaboration.id} edges={edges} orchestration={orchestration} readOnly={locked} newEdgeKind={newEdgeKind} onNewEdgeKindChange={onNewEdgeKindChange} allowFinish={collaboration.id === orchestration.termination.agent} onAddConnection={onAddConnection} onKindChange={onEdgeKindChange} onTargetChange={onEdgeTargetChange} onLayoutChange={onEdgeLayoutChange} onRemove={onEdgeRemove} />
        {orchestration.schemaVersion !== 3 && <section className="form-section collaboration-danger-zone">
          <h3 className="section-title"><span>解除协作关系</span><small>保留 Agent 与历史</small></h3>
          <p className="edge-type-help">成员将恢复为外层 Agent；Git 分支、PR、commit、产物和历史运行记录不会删除。</p>
          <button type="button" className="danger-button" disabled={locked || !onDissolveCollaboration} onClick={() => onDissolveCollaboration?.(collaboration)}><Trash2 size={13} />解散协作组</button>
        </section>}
      </div>
    </aside>;
  }
  const title = node.kind === "input" ? "用户输入" : node.kind === "finish" ? "结束" : node.name === "main" ? "Main Agent" : node.name;
  const typeLabel = node.kind === "agent"
    ? (collaborationParent ? `${collaborationParent.displayName} · 组内 Agent` : node.name === "main" ? "Main Agent · 系统节点" : "Agent 配置")
    : node.kind === "input"
      ? "工作流起点 · 只能创建出边"
      : "工作流终止节点 · 只能接收入边";
  const ordinaryWeakCount = node.kind === "agent"
    ? edges.filter((edge) => edge.kind === "weak" && !edge.fixed && edge.target !== "finish").length
    : 0;
  const decisionEnabled = node.kind === "agent" && node.name !== "main" && ordinaryWeakCount >= 2;
  const storedDecisionBy = node.kind === "agent" ? agent?.decisionBy : undefined;
  const effectiveDecisionBy = decisionEnabled && storedDecisionBy === "agent" ? "agent" : "main";
  const sessionEnabled = node.kind === "agent" && node.name !== "main"
    ? Boolean(agent?.sessionPersistence)
    : true;
  const roleDescription = node.kind === "agent"
    ? definition?.description ?? (node.name === "main"
      ? "理解目标、协调上下文，并在每轮选择一个外层节点。"
      : agentMeta(node.name, definition?.template ?? "general").description)
    : "";
  const selectedGateway = node.kind === "agent" ? gateways.find((gateway) => gateway.id === agent?.gatewayId) : undefined;
  const selectedHarnessId = agent?.harness
    ?? catalogDefaultHarnessId(harnesses)
    ?? "";
  const harnessOptions = harnessOptionsForPurpose(harnesses, "workflow", selectedHarnessId);
  const selectedHarness = node.kind === "agent" ? harnessOptions.find((item) => item.id === selectedHarnessId) : undefined;
  const capabilities = selectedHarness?.capabilities;
  const webSearchSupported = capabilities?.webSearch !== false;
  const skillsSupported = capabilities?.skills !== false;
  const autoSkillsSupported = skillsSupported && capabilities?.autoSkills !== false;
  const mcpSupported = capabilities?.mcp !== false;
  const permissionOptions: AgentConfig["permission"][] = capabilities?.permissionPrompts === undefined
    ? Object.keys(PERMISSION_META) as AgentConfig["permission"][]
    : capabilities?.permissionPrompts ?? [];
  const permissionSupported = permissionOptions.includes(agent?.permission ?? "workspace");
  const durableSessionSupported = capabilities?.durableSession !== false;
  const reasoningOptions = gatewayReasoningOptions(selectedGateway, agent?.model ?? "");
  const modelSelectionError = node.kind === "agent" && selectedGateway && agent
    ? !agent.model.trim()
      ? "切换网关后需要重新选择 model"
      : !selectedGateway.models.includes(agent.model)
        ? "当前 model 不在所选网关的模型列表中，请重新选择"
        : ""
    : "";
  const combinationTest = node.kind === "agent" && selectedGateway && agent &&
    agent.model.trim() && selectedGateway.models.includes(agent.model)
    ? gatewayCombinationTestState(
        selectedGateway,
        selectedHarnessId,
        agent.model,
        harnesses,
        agent.gatewayReasoningOption
      )
    : undefined;
  const testedModelOptions = selectedGateway
    ? gatewayModelTestOptions(selectedGateway, selectedHarnessId, harnesses)
    : [];
  const failedModelOptions = testedModelOptions.filter((option) => option.test.status === "failed");
  const addConnection = onAddConnection ?? (onEdgeTargetChange
    ? (source: string, target: string, kind: "strong" | "weak") => {
      onEdgeTargetChange(source, `__canvas_add__${kind}__${target}`);
    }
    : undefined);
  return <aside className="inspector" aria-label="Agent 属性面板">
    <header className="inspector-header">
      {collaborationParent && <button type="button" className="collaboration-member-back" onClick={onReturnToCollaboration} aria-label={`返回协作组 ${collaborationParent.displayName}`}><ArrowLeft size={15} /></button>}
      <div className="inspector-title"><h2>{title}</h2><p>{typeLabel}</p></div>
      {node.kind === "agent" && node.name !== "main" && !collaborationParent && <button type="button" className="node-remove" onClick={onRemoveAgent} disabled={readOnly} title="从画布删除 Agent" aria-label="从画布删除 Agent"><Trash2 size={15} /></button>}
    </header>
    {node.kind === "agent" && agent && (
      <div className="inspector-body">
        {collaborationParent && collaborationLocked && <div className="fixed-note collaboration-lock-note" role="status"><strong>运行中不可编辑</strong><span>{collaborationLockReason ?? "协作组及最终 PR 尚未进入整体终态。历史运行记录不会回写。"}</span></div>}
        <section className="form-section" aria-labelledby="canvas-basic-heading">
          <h3 id="canvas-basic-heading" className="section-title">基本信息</h3>
          <div className="form-grid">
            <label><span>名称</span>{node.name === "main" ? <input aria-label="Agent 名称" value="Main Agent" disabled /> : <AgentNameInput key={node.name} name={node.name} names={orchestration.agents.map((entry) => entry.name)} onCommit={(value) => onRenameAgent?.(value)} onValidityChange={onRenameValidityChange} disabled={readOnly} />}</label>
          </div>
          {collaborationParent && <p className="collaboration-member-context">{orchestration.schemaVersion === 3
            ? `这里引用的是同一个 Agent；修改后，外层及其他协作组中的 ${node.name} 引用也会使用新配置。`
            : `该 Agent 保留在“${collaborationParent.displayName}”内部；名称和运行配置修改会同步到协作组。`}</p>}
          <div className="canvas-runtime-config-grid" aria-label="Agent 运行配置">
            <label><span>Harness</span><select aria-label={`${node.name} Harness`} value={selectedHarnessId} onChange={(event) => onAgentPatch?.({ harness: event.target.value as AgentHarness })} disabled={readOnly || !!harnessConstraint || !harnessOptions.length} title={harnessConstraint?.reason}>{harnessOptions.map((item) => <option value={item.id} key={item.id} disabled={!item.available}>{item.label}{item.available ? "" : " · 不可用"}</option>)}</select>{harnessConstraint && <small>{harnessConstraint.reason}</small>}{harnessConstraint && selectedHarnessId !== harnessConstraint.harnessId && !readOnly && <button type="button" onClick={() => onAgentPatch?.({ harness: harnessConstraint.harnessId })}>恢复原会话 Harness</button>}{selectedHarness && !selectedHarness.available && <small className="field-error harness-availability-error" role="alert">{selectedHarness.availabilityReason ?? "服务端未找到该 Harness 的可执行入口"}</small>}</label>
            <label><span>全局网关</span><select aria-label={`${node.name}全局网关`} value={agent.gatewayId ?? ""} onChange={(event) => {
              const gateway = gateways.find((item) => item.id === event.target.value);
              onAgentPatch?.({
                gatewayId: gateway?.id,
                model: gateway && !gateway.models.includes(agent.model) ? "" : agent.model,
                ...(gatewayReasoningOptionIsValid(
                  gateway,
                  gateway && !gateway.models.includes(agent.model) ? "" : agent.model,
                  agent.gatewayReasoningOption
                ) ? {} : { gatewayReasoningOption: undefined })
              });
            }} disabled={readOnly}><option value="">选择已保存网关</option>{gateways.map((gateway) => {
              const state = gatewayHarnessTestState(gateway, selectedHarnessId, harnesses);
              return <option value={gateway.id} key={gateway.id}>{gateway.name} · {state.status === "passed" ? "有已验证 model" : state.status === "failed" ? "连接验证失败" : "当前 Harness 未验证"}</option>;
            })}</select></label>
            <label><span>model</span>{selectedGateway ? <select value={agent.model} onChange={(event) => {
              const model = event.target.value;
              onAgentPatch?.({
                model,
                ...(gatewayReasoningOptionIsValid(selectedGateway, model, agent.gatewayReasoningOption)
                  ? {}
                  : { gatewayReasoningOption: undefined })
              });
            }} aria-label={`${node.name} model`} aria-invalid={Boolean(modelSelectionError)} disabled={readOnly}><option value="" disabled>请选择网关 model</option>{testedModelOptions.map(({ model, test }) => <option value={model} key={model} title={test.error}>{model} · {test.status === "passed" ? "已验证" : test.status === "failed" ? "验证失败" : "未验证"}</option>)}</select> : <DraftInput key={node.name} draftPath={["agents", node.name, "model"]} value={agent.model} onCommit={(value) => onAgentPatch?.({ model: value, gatewayReasoningOption: undefined })} ariaLabel={`${node.name} model`} disabled={readOnly} />}{modelSelectionError && <small className="field-error" role="alert">{modelSelectionError}</small>}{failedModelOptions.length > 0 && <small className="field-error gateway-disabled-models">以下 model 验证失败，仍可选择并启动：{failedModelOptions.map(({ model, test }) => `${model}${test.error ? `（${test.error}）` : ""}`).join("；")}</small>}</label>
            {(reasoningOptions.length > 0 || agent.gatewayReasoningOption) && <label><span>网关思考强度</span><select value={agent.gatewayReasoningOption ?? ""} onChange={(event) => onAgentPatch?.({ gatewayReasoningOption: event.target.value || undefined })} aria-label={`${node.name}网关思考强度`} disabled={readOnly}><option value="">模型 / 网关默认（不发送字段）</option>{agent.gatewayReasoningOption && !reasoningOptions.some((option) => option.id === agent.gatewayReasoningOption) && <option value={agent.gatewayReasoningOption} disabled>{agent.gatewayReasoningOption} · 已失效</option>}{reasoningOptions.map((option) => <option value={option.id} key={option.id}>{option.label} · {option.value}</option>)}</select></label>}
          </div>
          <div className="canvas-derived-route" role="status"><span>协议与路由</span><strong>{selectedGateway ? protocolLabel(selectedGateway.protocol) : "选择网关后显示"}</strong><small>{selectedGateway && selectedHarness?.nativeProtocol && selectedHarness.nativeProtocol !== selectedGateway.protocol ? `已启用自动路由：${protocolLabel(selectedHarness.nativeProtocol)} → ${protocolLabel(selectedGateway.protocol)}` : selectedGateway && selectedHarness?.nativeProtocol ? "直连" : selectedGateway ? "Harness 目录待确认" : "尚未推导"}</small>{combinationTest?.status !== undefined && combinationTest.status !== "passed" && <small className="field-error gateway-combination-error" role="alert">{combinationTest.status === "failed" ? `当前 Harness / 网关 / model 组合验证失败${combinationTest.error ? `：${combinationTest.error}` : ""}；仍可启动，但运行可能失败。` : "当前 Harness / 网关 / model 组合尚未验证；仍可启动，但运行可能失败。"}</small>}</div>
          <label><span>职责说明</span><DraftTextarea key={node.name} draftPath={["orchestration", "agents", String(orchestration.agents.findIndex(item => item.name === node.name)), "description"]} value={roleDescription} onCommit={(value) => onDescriptionChange?.(value)} rows={3} maxLength={180} disabled={readOnly} /></label>
        </section>
        <section className="form-section"><h3 className="section-title"><FileText size={14} />Agent 指令</h3><DraftTextarea key={node.name} draftPath={["agents", node.name, "instructions"]} value={agent.instructions} onCommit={(value) => onAgentPatch?.({ instructions: value })} rows={4} maxLength={20_000} disabled={readOnly} agentId={node.name} onToolsPatch={onAgentPatch} toolApplyNotice={toolRecommendationApplyNotice} /></section>
        <section className="form-section agent-runtime-section">
          <h3 className="section-title"><span>Skill</span><small><SkillCount agent={agent} /> 项</small></h3>
          <SkillCollection
            agent={agent}
            agentName={node.name}
            catalog={skills}
            disabled={readOnly || !skillsSupported}
            autoSkillsSupported={autoSkillsSupported}
            onAddSkill={onAddSkill}
            onChange={(fixedSkills, autoSkills) => onAgentPatch?.({ skills: fixedSkills, autoSkills })}
          />
          {!skillsSupported && <p className="runtime-help field-error">当前 Harness 不支持 Skills</p>}
          {skillsSupported && !autoSkillsSupported && <p className="runtime-help field-error">当前 Harness 不支持 Auto Skills，仅可固定加载</p>}
        </section>
        <section className="form-section agent-runtime-section canvas-mcp-section">
          <h3 className="section-title"><span>MCP 工具</span><small>{agent.mcpServers.length + (agent.experimentMcp ? 1 : 0)} 项</small></h3>
          {onAddMcp && onToggleMcp
            ? <McpServerControl className="canvas-mcp-control" agentName={node.name} selected={agent.mcpServers} options={mcpOptions ?? agent.mcpServers} systemOptions={mcpDirectory} onAdd={onAddMcp} onToggle={onToggleMcp} disabled={readOnly || !mcpSupported} />
            : <small>未配置 MCP</small>}
          {!mcpSupported && <p className="runtime-help field-error">当前 Harness 不支持 MCP</p>}
          <ExperimentMcpControl agentName={node.name} selected={agent.experimentMcp === true}
            disabled={readOnly || !mcpSupported || !onAgentPatch}
            onChange={(experimentMcp) => onAgentPatch?.({ experimentMcp })} />
        </section>
        <section className="form-section agent-runtime-section permission-section">
          <h3 className="section-title"><span>运行权限</span><small>{permissionOptions.length} 档可选</small></h3>
          <label className="permission-field">
            <span>权限级别</span>
            <select aria-label={`${node.name}运行权限`} value={agent.permission} onChange={(event) => onAgentPatch?.({ permission: event.target.value as AgentConfig["permission"] })} disabled={readOnly || !permissionOptions.length}>
              {!permissionSupported && <option value={agent.permission} disabled>{PERMISSION_META[agent.permission]?.label ?? agent.permission} · 当前 Harness 不支持</option>}
              {permissionOptions.map((permission) => <option value={permission} key={permission}>{PERMISSION_META[permission].label}</option>)}
            </select>
          </label>
          {permissionOptions.length < Object.keys(PERMISSION_META).length && <p className="runtime-help field-error">{permissionOptions.length ? `当前 Harness 仅支持：${permissionOptions.map((permission) => PERMISSION_META[permission].label).join("、")}` : "当前 Harness 未声明可用的权限模式"}</p>}
          <p className="runtime-help permission-description">{PERMISSION_META[agent.permission]?.description ?? PERMISSION_META.workspace.description}</p>
          {agent.permission === "yolo" && <div className="permission-warning is-yolo"><strong>{PERMISSION_META.yolo.label}</strong><span>{PERMISSION_META.yolo.description}</span></div>}
          {agent.permission === "compute" && <div className="permission-warning is-compute"><strong>{PERMISSION_META.compute.label}</strong><span>Skill 和业务 MCP 单独配置，当前角色仍按自己的授权执行。</span></div>}
          <label className="inspector-toggle"><span><Globe2 size={13} />Web Search</span><input type="checkbox" aria-label={`${node.name} Web Search`} checked={agent.webSearch} onChange={(event) => onAgentPatch?.({ webSearch: event.target.checked })} disabled={readOnly || !webSearchSupported} /><strong>{!webSearchSupported ? "当前 Harness 不支持" : agent.webSearch ? "开启" : "关闭"}</strong></label>
        </section>
        {!collaborationParent && <EdgeInspector sourceId={node.name} edges={edges} orchestration={orchestration} readOnly={readOnly} mainEdge={node.name === "main"} newEdgeKind={newEdgeKind} onNewEdgeKindChange={onNewEdgeKindChange} allowFinish={node.name === orchestration.termination.agent} onAddConnection={addConnection} onKindChange={onEdgeKindChange} onTargetChange={onEdgeTargetChange} onLayoutChange={onEdgeLayoutChange} onRemove={onEdgeRemove} />}
        {node.name !== "main" && !collaborationParent && <section className="form-section weak-choice-prompt"><h3 className="section-title"><span>弱边决策</span><small>{ordinaryWeakCount} 条普通弱边</small></h3><label><span>选择说明（提供给决策者）</span><DraftTextarea key={node.name} draftPath={["orchestration", "decisionPlans", node.name]} value={orchestration.decisionPlans[node.name] ?? ""} onCommit={(value) => onDecisionPlanChange?.(value)} rows={4} maxLength={600} placeholder="可选：说明如何在候选路径之间选择。" disabled={readOnly} /></label><div className="decision-toggle" role="group" aria-label="弱边决策者"><div className="decision-toggle-heading"><span>由谁选择下一步</span><strong className="decision-current">{decisionEnabled ? effectiveDecisionBy === "agent" ? "当前 Agent 选择" : "Main Agent 选择" : "至少需要两条弱边"}</strong></div><div className="decision-segmented"><DecisionOption value="main" label="Main Agent" active={effectiveDecisionBy === "main"} disabled={readOnly || !decisionEnabled} onChange={onWeakDecisionByChange} /><DecisionOption value="agent" label="当前 Agent" active={effectiveDecisionBy === "agent"} disabled={readOnly || !decisionEnabled} onChange={onWeakDecisionByChange} /></div></div><p>{decisionEnabled ? "同一 Agent 的全部普通弱边共用一个决策者；当前设置只保存于画布数据。" : "添加第二条普通弱边后即可选择决策者。"}</p></section>}
        {node.name !== "main" && collaborationParent && orchestration.schemaVersion === 3 && <section className="form-section weak-choice-prompt"><h3 className="section-title"><span>弱边决策</span><small>{ordinaryWeakCount} 条组内普通弱边</small></h3><div className="decision-toggle" role="group" aria-label="组内弱边决策者"><div className="decision-toggle-heading"><span>由谁选择下一步</span><strong className="decision-current">{decisionEnabled ? effectiveDecisionBy === "agent" ? "当前 Agent 选择" : "组内 Leader 选择" : "至少需要两条弱边"}</strong></div><div className="decision-segmented"><DecisionOption value="main" label="组内 Leader" active={effectiveDecisionBy === "main"} disabled={readOnly || !decisionEnabled} onChange={onWeakDecisionByChange} /><DecisionOption value="agent" label="当前 Agent" active={effectiveDecisionBy === "agent"} disabled={readOnly || !decisionEnabled} onChange={onWeakDecisionByChange} /></div></div><p>{decisionEnabled ? `“组内 Leader”指 ${collaborationParent.displayName} 的 Leader；当前 Agent 选项由 ${node.name} 自己正式回执。` : "添加第二条组内普通弱边后即可选择决策者。"}</p></section>}
        <section className="form-section session-setting"><h3 className="section-title"><span>运行</span><small>{node.name === "main" ? "系统设置" : "当前子 Agent"}</small></h3>{node.name === "main" ? <div className="fixed-note main-selector-note">Main Agent 始终使用持续 session，不能关闭。</div> : <><label className={`session-card ${sessionEnabled ? "is-enabled" : ""}`}><input className="session-input" type="checkbox" checked={sessionEnabled} onChange={(event) => onSessionPersistenceChange?.(event.target.checked)} aria-label="持续 session" disabled={readOnly || !durableSessionSupported} /><span className="session-card-copy"><strong>持续 session</strong><small>{durableSessionSupported ? "在同一流程的多轮调用中复用该 Agent 的会话。" : "当前 Harness 不支持持续 session。"}</small></span><span className="session-card-control" aria-hidden="true"><span className="session-state">{durableSessionSupported ? sessionEnabled ? "已开启" : "未开启" : "不支持"}</span><span className="session-switch"><i /></span></span></label><p className="session-card-note">仅保存前端配置，不会在此处创建或恢复 thread。</p></>}</section>
      </div>
    )}
    {node.kind === "input" && <div className="inspector-body"><EdgeInspector edges={edges} orchestration={orchestration} readOnly={readOnly} inputEdge onTargetChange={onEdgeTargetChange} onLayoutChange={onEdgeLayoutChange} onRemove={onEdgeRemove} /><div className="fixed-note">用户输入始终存在且不能删除，最多连接一个目标；目标可以是 Main、普通 Agent 或协作组外层节点。新建画布默认可以暂时不连接。</div></div>}
    {node.kind === "finish" && <div className="inspector-body"><section className="form-section"><h3 className="section-title"><span>终止入口</span><small>{edges.length} / 1</small></h3>{edges.length ? <div className="edge-list">{edges.map((edge) => <div className="edge-row termination-row" key={edge.id}><span className="edge-row-copy"><strong>{edgeTitle(edge.source)}</strong><small>终止候选</small></span><span className="edge-row-fixed">终止候选</span><button className="edge-delete edge-delete-button" type="button" onClick={() => onEdgeRemove?.(edge.id)} disabled={readOnly || edge.fixed} aria-label={`删除 ${edge.source} 到 ${edge.target} 连线`} title="删除连接"><Trash2 size={13} /><span>删除连接</span></button></div>)}</div> : <p className="edge-list-empty">尚未连接。请从一个外层节点的连接点拖线到结束节点。</p>}<label className="termination-agent-picker"><span>结束节点</span><select value={orchestration.canvas?.connections?.termination === false ? "" : orchestration.termination.agent} onChange={(event) => onTerminationAgentChange?.(event.target.value)} disabled={readOnly}><option value="">未连接</option>{workflowOuterNodes(orchestration).map((entry) => { const blocked = entry.id !== orchestration.termination.agent && (orchestration.routes[entry.id] ?? []).some((edge) => edge.kind === "strong"); return <option value={entry.id} key={entry.id} disabled={blocked}>{entry.displayName}{blocked ? " · 已有强边" : ""}</option>; })}</select></label><p className="edge-type-help">结束节点只能有弱出边；更换来源会保持结束节点唯一入边。</p></section><section className="form-section termination-condition-section"><h3 className="section-title"><span>终止验收条件</span><small>结束节点专属</small></h3><label><span>结果满足什么标准后才允许结束工作流</span><textarea value={orchestration.termination.condition} onChange={(event) => onTerminationConditionChange?.(event.target.value)} rows={5} maxLength={240} disabled={readOnly} /></label><p className="edge-type-help">这里负责最终结果验收，不负责选择下一步节点；终止候选边进入这里后先判断该条件，不满足时回到源节点的普通后续路径。</p></section><div className="fixed-note termination-note">结束节点始终存在且不能删除，可以自由移动；它不能创建任何出边。</div></div>}
  </aside>;
}

function AgentNameInput({ name, names, onCommit, onValidityChange, disabled }: {
  name: string;
  names: readonly string[];
  onCommit: (value: string) => void;
  onValidityChange?: (invalid: boolean) => void;
  disabled: boolean;
}) {
  const [draft, setDraft] = useState(name);
  const valid = (value: string) => {
    const trimmed = value.trim();
    return isAgentIdentifier(trimmed) && trimmed !== "main"
      && (trimmed === name || !names.includes(trimmed));
  };
  const invalid = draft !== name && !valid(draft);
  useEffect(() => () => onValidityChange?.(false), [onValidityChange]);
  return <>
    <input aria-label="Agent 名称" value={draft} maxLength={32} aria-invalid={invalid} disabled={disabled}
      onChange={(event) => { const value = event.target.value; setDraft(value); onValidityChange?.(!valid(value)); }}
      onBlur={() => { if (valid(draft) && draft.trim() !== name) onCommit(draft.trim()); }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") { setDraft(name); onValidityChange?.(false); }
      }} />
    {invalid && <small className="field-error" role="alert">请输入唯一且有效的 Agent 名称后再保存</small>}
  </>;
}

function DraftInput({ value, onCommit, ariaLabel, disabled, draftPath }: { draftPath?: string[]; value: string; onCommit: (value: string) => void; ariaLabel: string; disabled: boolean }) {
  const field = useDraftText(value, onCommit, undefined, draftPath);
  return <input ref={(element) => { field.element.current = element; }} value={field.draft} onChange={(event) => field.setDraft(event.target.value)} onBlur={field.onBlur} aria-label={ariaLabel} disabled={disabled} />;
}

function DraftTextarea({ value, onCommit, rows, maxLength, placeholder, disabled, agentId, onToolsPatch, toolApplyNotice, draftPath }: {
  value: string;
  onCommit: (value: string) => void;
  rows: number;
  maxLength: number;
  placeholder?: string;
  disabled: boolean;
  agentId?: string;
  onToolsPatch?: (selection: AgentToolSelection) => void;
  toolApplyNotice?: string;
  draftPath?: string[];
}) {
  const recommendation = useRef<HTMLDivElement | null>(null);
  const field = useDraftText(value, onCommit, agentId ? recommendation : undefined, draftPath);
  const textarea = <textarea ref={(element) => { field.element.current = element; }} value={field.draft} onChange={(event) => field.setDraft(event.target.value)} onBlur={field.onBlur} rows={rows} maxLength={maxLength} placeholder={placeholder} disabled={disabled} />;
  if (!agentId) return textarea;
  return <><label><span className="sr-only">Agent 指令</span>{textarea}</label>
    <div ref={recommendation}><AgentToolRecommendation agentId={agentId} instructions={field.draft} disabled={disabled || !onToolsPatch} onApply={onToolsPatch} applyNotice={toolApplyNotice} /></div></>;
}

function useDraftText(value: string, onCommit: (value: string) => void, recommendation?: RefObject<HTMLElement | null>, draftPath?: string[]) {
  const persistence = useContext(CanvasTextDraftContext);
  const key = draftPath ? JSON.stringify(draftPath) : undefined;
  const saved = key ? persistence?.drafts[key] : undefined;
  const [draft, setLocalDraft] = useState(saved?.value ?? value);
  const setDraft = (text: string) => {
    setLocalDraft(text);
    if (draftPath) persistence?.update(draftPath, text);
  };
  const element = useRef<HTMLElement | null>(null);
  const lastCommitted = useRef<string | null>(null);
  useEffect(() => { setLocalDraft(saved?.value ?? value); lastCommitted.current = null; }, [value, key]);
  useEffect(() => { if (key && saved?.value === value) persistence?.remove(key); }, [key, saved?.value, value]);
  const commit = () => {
    if (element.current?.closest("[hidden]") || draft === value || lastCommitted.current === draft) return;
    lastCommitted.current = draft;
    onCommit(draft);
  };
  const defersCommit = (target: EventTarget | null) => {
    if (!recommendation || !(target instanceof Node)) return false;
    if (recommendation.current?.contains(target)) return true;
    // A shared-tool confirmation covers this editor. Its actions must not
    // submit the background instruction draft or replace the pending tool edit.
    const modal = target instanceof Element ? target.closest('[role="dialog"][aria-modal="true"]') : null;
    return Boolean(modal && element.current && !modal.contains(element.current));
  };
  const onBlur = (event: FocusEvent<HTMLElement>) => { if (!defersCommit(event.relatedTarget)) commit(); };
  useEffect(() => {
    if (draft === value) return;
    const commitBeforeSelection = (event: PointerEvent) => {
      if (!element.current?.contains(event.target as Node) && !defersCommit(event.target)) commit();
    };
    window.addEventListener("pointerdown", commitBeforeSelection, true);
    return () => window.removeEventListener("pointerdown", commitBeforeSelection, true);
  }, [draft, value, onCommit, recommendation]);
  return { draft, setDraft, element, onBlur };
}

function ConnectionInspector({ edge, orchestration, scopeKind, readOnly, onKindChange, onLayoutChange, onRemove, onLoopChange }: {
  edge: CanvasEdge;
  orchestration: AgentOrchestrationTemplate;
  scopeKind: "root" | "collaboration";
  readOnly: boolean;
  onKindChange?: (id: string, kind: WorkflowEdge["kind"]) => void;
  onLayoutChange?: (id: string, patch: Partial<WorkflowCanvasEdgeLayout>) => void;
  onRemove?: (id: string) => void;
  onLoopChange?: (loopId: string, patch: Partial<WorkflowLoop>) => void;
}) {
  const termination = edge.target === "finish" || edge.kind === "termination";
  const input = edge.source === "input";
  const loop = edge.loop && edge.loop.role !== "exit"
    ? orchestration.loops?.find((item) => item.id === edge.loop?.id)
    : undefined;
  const loopMembers = new Set(loop ? workflowLoopMembers(orchestration, loop) : []);
  const exitOptions = orchestration.agents.filter((agent) => !loopMembers.has(agent.name));
  const ports: CanvasEdge["sourcePort"][] = ["top", "right", "bottom", "left"];
  return <aside className="inspector" aria-label="连接属性面板">
    <header className="inspector-header"><div className="inspector-title"><h2>{loop ? "Loop 配置" : termination ? "结束连接" : "连接配置"}</h2><p>{loop ? `已选中整个 Loop · ${loop.id}` : edge.fixed ? "系统固定连线" : termination ? scopeKind === "collaboration" ? "连接结束协作组" : "终止候选" : input ? scopeKind === "collaboration" ? "进入协作组 · 并行入口" : "输入连接" : edge.kind === "strong" ? "强边" : "弱边"}</p></div></header>
    <div className="inspector-body">
      <section className="form-section"><h3 className="section-title">连接方向</h3><div className="selected-edge-route"><strong>{edgeTitle(edge.source, scopeKind)}</strong><span>→</span><strong>{edgeTitle(edge.target, scopeKind)}</strong></div></section>
      <section className="form-section"><h3 className="section-title">连接点</h3><div className="form-grid"><label><span>起点连接点</span><select value={edge.sourcePort} disabled={readOnly || edge.fixed} onChange={(event) => onLayoutChange?.(edge.id, { sourcePort: event.target.value as CanvasEdge["sourcePort"], sourcePortPinned: true })}>{ports.map((port) => <option value={port} key={port}>{port}</option>)}</select></label><label><span>终点连接点</span><select value={edge.targetPort} disabled={readOnly || edge.fixed} onChange={(event) => onLayoutChange?.(edge.id, { targetPort: event.target.value as CanvasEdge["targetPort"], targetPortPinned: true })}>{ports.map((port) => <option value={port} key={port}>{port}</option>)}</select></label></div><p className="edge-type-help">可分别调整连线两端使用的连接点。</p></section>
      {!edge.fixed && !termination && !input && !loop && <section className="form-section"><h3 className="section-title">连接类型</h3><div className="edge-type-toggle inspector-edge-type"><button type="button" className={`edge-type-button ${edge.kind === "strong" ? "active" : ""}`} onClick={() => onKindChange?.(edge.id, "strong")} disabled={readOnly}>强边</button><button type="button" className={`edge-type-button ${edge.kind === "weak" ? "active" : ""}`} onClick={() => onKindChange?.(edge.id, "weak")} disabled={readOnly}>弱边</button></div><p className="edge-type-help">强边一定执行；弱边由源 Agent 根据弱边选择 Prompt 决定下一步。</p></section>}
      {loop && <section className="form-section loop-config-section"><h3 className="section-title">循环批次</h3><p className="edge-type-help">成员路径：{[...workflowLoopMembers(orchestration, loop), loop.to].join(" → ")}</p><div className="form-grid"><label><span>Loop ID</span><DraftInput value={loop.id} onCommit={(id) => onLoopChange?.(loop.id, { id: id.trim() })} ariaLabel="Loop ID" disabled={readOnly} /></label><label><span>每批迭代数</span><input type="number" min={1} max={1_000_000} step={1} value={loop.maxIterations} aria-label="Loop 每批迭代数" disabled={readOnly} onChange={(event) => onLoopChange?.(loop.id, { maxIterations: Number(event.target.value) })} /></label><label><span>批次退出目标</span><select value={loop.exitTo} aria-label="Loop 批次退出目标" disabled={readOnly} onChange={(event) => onLoopChange?.(loop.id, { exitTo: event.target.value })}>{exitOptions.map((agent) => <option value={agent.name} key={agent.name}>{edgeTitle(agent.name, scopeKind)}</option>)}</select></label></div><p className="edge-type-help">返回边：{loop.from} → {loop.to}。本批达到上限时沿只读虚线前往 {loop.exitTo}。虚线不会写入普通 routes。</p></section>}
      <section className="form-section"><h3 className="section-title">连接语义</h3><div className={`fixed-note ${termination || edge.kind === "weak" || loop ? "selector-note" : ""}`}>{loop ? "循环返回边：运行时按批次计数；达到上限后只沿虚拟退出边离开循环组。" : edge.fixed ? "该固定边由系统管理。" : termination ? scopeKind === "collaboration" ? "连接到结束协作组；需要等待所有必要路径和 Git 集成。" : "终止候选边：结果先进入终止闸门，由终止验收条件判断是否结束。" : input ? scopeKind === "collaboration" ? "组入口的所有并行边一起激活各自目标。" : "用户研究需求从该连接进入 Workflow。" : edge.kind === "strong" ? "强边为必经执行路径。" : "弱边是由决策者选择的候选路径。"}</div></section>
      {edge.fixed ? <div className="fixed-note main-selector-note">该边不能删除、移动、改目标或改为强边。</div> : <button type="button" className="edge-remove-button" onClick={() => onRemove?.(edge.id)} disabled={readOnly}>{loop ? "删除所选强边并拆开 Loop" : "删除连接"}</button>}
    </div>
  </aside>;
}

function edgeTitle(id: string, scopeKind: "root" | "collaboration" = "root"): string {
  if (id === "input") return scopeKind === "collaboration" ? "进入协作组" : "用户输入";
  if (id === "finish") return scopeKind === "collaboration" ? "结束协作组" : "结束";
  if (id === "main") return "Main Agent";
  return id;
}

function DecisionOption({ value, label, active, disabled, onChange }: { value: "main" | "agent"; label: string; active: boolean; disabled: boolean; onChange?: (value: "main" | "agent") => void }) {
  return <button type="button" className={`decision-option ${active ? "is-active" : ""}`} aria-pressed={active} disabled={disabled} title={disabled ? "至少需要两条普通弱边" : undefined} onClick={() => onChange?.(value)}><span className="decision-option-mark" aria-hidden="true" /><span>{label}</span></button>;
}

function SkillCount({ agent }: { agent: AgentConfig }): number {
  return new Set([...agent.skills, ...agent.autoSkills]).size;
}

function SkillCollection({ agent, agentName, catalog, disabled, autoSkillsSupported, onAddSkill, onChange }: { agent: AgentConfig; agentName: string; catalog: SkillDefinition[]; disabled: boolean; autoSkillsSupported: boolean; onAddSkill?: (title: string, content: string) => Promise<SkillDefinition>; onChange: (skills: string[], autoSkills: string[]) => void }) {
  const [selectedSkill, setSelectedSkill] = useState("");
  const [skillDialogOpen, setSkillDialogOpen] = useState(false);
  const [skillNotice, setSkillNotice] = useState("");
  const selected = useMemo(() => {
    const byId = new Map<string, "fixed" | "auto">();
    for (const skill of agent.skills) byId.set(skill, "fixed");
    for (const skill of agent.autoSkills) if (!byId.has(skill)) byId.set(skill, "auto");
    return [...byId.entries()].map(([skill, mode]) => ({ skill, mode }));
  }, [agent.autoSkills, agent.skills]);
  const catalogById = useMemo(() => new Map(catalog.map((skill) => [skill.id, skill])), [catalog]);
  const available = catalog.filter((skill) => !selected.some((entry) => entry.skill === skill.id));
  const addSkill = () => {
    if (!selectedSkill || agent.skills.includes(selectedSkill) || agent.autoSkills.includes(selectedSkill)) return;
    onChange([...agent.skills, selectedSkill], agent.autoSkills);
    setSelectedSkill("");
  };
  const addCustomSkill = async (title: string, content: string) => {
    if (!onAddSkill) throw new Error("当前画布未配置 Skill 创建能力");
    const skill = await onAddSkill(title, content);
    onChange([...agent.skills, skill.id], agent.autoSkills);
    setSkillNotice(`${skill.name} 已创建并固定加载。`);
    return skill;
  };
  return <>
    <div className="runtime-list inspector-skill-list">{selected.length ? selected.map(({ skill, mode }) => { const definition = catalogById.get(skill); return <div className="runtime-list-row skill-runtime-row inspector-skill-row" key={skill}><span className="runtime-row-copy" title={definition?.description || skill}><strong>{definition?.name ?? skill}</strong>{definition?.description && <small>{definition.description}</small>}</span><select value={mode} disabled={disabled} aria-label={`${definition?.name ?? skill}加载方式`} onChange={(event) => { const nextMode = event.target.value as "fixed" | "auto"; if (nextMode === "auto" && !autoSkillsSupported) return; const fixedSkills = agent.skills.filter((item) => item !== skill); const autoSkills = agent.autoSkills.filter((item) => item !== skill); (nextMode === "fixed" ? fixedSkills : autoSkills).push(skill); onChange(fixedSkills, autoSkills); }}><option value="fixed">固定加载</option><option value="auto" disabled={!autoSkillsSupported}>自动选择</option></select><button type="button" className="runtime-remove-button" aria-label={`移除 Skill ${definition?.name ?? skill}`} title="移除 Skill" disabled={disabled} onClick={() => onChange(agent.skills.filter((item) => item !== skill), agent.autoSkills.filter((item) => item !== skill))}><X size={13} /></button></div>; }) : <p className="runtime-empty">尚未配置 Skill</p>}</div>
    <div className="runtime-add-row inspector-skill-add"><select value={selectedSkill} onChange={(event) => setSelectedSkill(event.target.value)} aria-label="添加 Skill" disabled={disabled || !available.length}><option value="">添加 Skill…</option>{available.map((skill) => <option value={skill.id} key={skill.id}>{skill.name}</option>)}</select><button type="button" className="runtime-add-button" onClick={addSkill} disabled={disabled || !selectedSkill}><Plus size={12} />添加</button></div>
    {onAddSkill && <><button type="button" className="runtime-create-button" onClick={() => { setSkillNotice(""); setSkillDialogOpen(true); }} disabled={disabled}><Plus size={12} />新增 Skill</button>{skillNotice && <p className="runtime-help user-skill-feedback success" role="status">{skillNotice}</p>}</>}
    <p className="runtime-help">固定加载会在每次调用时加载；自动选择仅在任务需要时启用。</p>
    {skillDialogOpen && onAddSkill && <CreateSkillDialog agentName={agentName} onClose={() => setSkillDialogOpen(false)} onCreate={addCustomSkill} />}
  </>;
}

function EdgeInspector({ sourceId, edges, orchestration, readOnly, inputEdge = false, mainEdge = false, newEdgeKind = "strong", onNewEdgeKindChange, allowFinish: _allowFinish = false, onAddConnection, onKindChange: _onKindChange, onTargetChange: _onTargetChange, onLayoutChange: _onLayoutChange, onRemove }: { sourceId?: string; edges: CanvasEdge[]; orchestration: AgentOrchestrationTemplate; readOnly: boolean; inputEdge?: boolean; mainEdge?: boolean; newEdgeKind?: "strong" | "weak"; onNewEdgeKindChange?: (kind: "strong" | "weak") => void; allowFinish?: boolean; onAddConnection?: (source: string, target: string, kind: "strong" | "weak") => void; onKindChange?: (id: string, kind: WorkflowEdge["kind"]) => void; onTargetChange?: (id: string, target: string) => void; onLayoutChange?: (id: string, patch: Partial<WorkflowCanvasEdgeLayout>) => void; onRemove?: (id: string) => void }) {
  const sectionTitle = inputEdge ? "输入出口" : mainEdge ? "固定调度路由" : "出边";
  const countLabel = mainEdge ? `${edges.filter((edge) => edge.fixed).length} 个外层候选` : `${edges.length} 条`;
  const terminationExists = edges.some((edge) => edge.target === "finish" || edge.kind === "termination");
  const existingTargets = useMemo(() => new Set(edges.map((edge) => edge.target)), [edges]);
  const targetOptions = useMemo(
    () => sourceId
      ? workflowOuterNodes(orchestration)
          .filter((entry) => entry.id !== sourceId)
          .map((entry) => ({ name: entry.id, displayName: entry.displayName }))
      : [],
    [orchestration, sourceId]
  );
  const firstAvailableTarget = targetOptions.find((entry) => !existingTargets.has(entry.name))?.name ?? targetOptions[0]?.name ?? "";
  const hasAvailableTarget = targetOptions.some((entry) => !existingTargets.has(entry.name));
  const [selectedTarget, setSelectedTarget] = useState("");
  const effectiveTarget = targetOptions.some((entry) => entry.name === selectedTarget && !existingTargets.has(entry.name))
    ? selectedTarget
    : firstAvailableTarget;
  const effectiveNewEdgeKind = terminationExists ? "weak" : newEdgeKind;
  return <section className="form-section edge-section"><h3 className="section-title"><span>{sectionTitle}</span><small>{countLabel}</small></h3>{!inputEdge && !mainEdge && <><div className="connection-kind-picker"><span>新连接</span><div className="edge-type-toggle"><button type="button" className={`edge-type-button ${effectiveNewEdgeKind === "strong" ? "active" : ""}`} aria-pressed={effectiveNewEdgeKind === "strong"} disabled={readOnly || terminationExists} onClick={() => onNewEdgeKindChange?.("strong")}>强边</button><button type="button" className={`edge-type-button ${effectiveNewEdgeKind === "weak" ? "active" : ""}`} aria-pressed={effectiveNewEdgeKind === "weak"} disabled={readOnly} onClick={() => onNewEdgeKindChange?.("weak")}>弱边</button></div></div><p className="edge-type-help">连接请直接从画布端口拖出；也可以从下方选择目标添加连接。</p>{sourceId && <div className="connection-editor"><label className="sr-only" htmlFor="connection-target">连接目标</label><select id="connection-target" aria-label="连接目标" value={effectiveTarget} onChange={(event) => setSelectedTarget(event.target.value)} disabled={readOnly || !targetOptions.length}><option value="" disabled>选择目标 Agent</option>{targetOptions.map((entry) => <option value={entry.name} key={entry.name} disabled={existingTargets.has(entry.name)}>{entry.name}{existingTargets.has(entry.name) ? " · 已连接" : ""}</option>)}</select><button id="add-connection-from-inspector" className="connection-action" type="button" onClick={() => effectiveTarget && onAddConnection?.(sourceId, effectiveTarget, effectiveNewEdgeKind)} disabled={readOnly || !effectiveTarget || !hasAvailableTarget || !onAddConnection}><Plus size={14} />添加连接</button></div>}</>}{edges.length ? <div className="edge-list">{edges.map((edge) => { const fixed = edge.fixed; const termination = edge.target === "finish" || edge.kind === "termination"; const loopExit = edge.loop?.role === "exit"; const loopReturn = edge.loop?.role === "return"; return <div className={`edge-row ${termination ? "termination-row" : ""} ${fixed ? "edge-row-system-fixed" : "has-delete-action"}`} key={edge.id} style={{ "--edge-color": loopReturn ? "#6d55b6" : loopExit ? "#247b8a" : fixed ? "#607968" : termination ? "#a65365" : edge.kind === "weak" ? "#b56a17" : "#25714e" } as CSSProperties}><span className="edge-row-copy"><strong>{edgeTitle(edge.target)}</strong><small>{loopReturn ? `循环返回 · ${edge.loop?.id}` : loopExit ? `批次退出 · ${edge.loop?.id}` : fixed ? "固定调度" : termination ? "终止候选" : edge.kind === "weak" ? "弱边 · 可选" : "强边 · 必经"}</small></span><span className={`edge-row-kind ${termination || loopExit ? "edge-row-fixed" : ""}`}>{loopReturn ? "Loop 返回边" : loopExit ? "Loop 虚拟边 · 只读" : fixed ? "系统固定 · 只读" : termination ? "终止候选" : edge.kind === "weak" ? "弱边 · 可选" : "强边 · 必经"}</span>{fixed ? <span className="edge-row-fixed main-dispatch-fixed">锁定</span> : <button className="edge-delete edge-delete-button" type="button" onClick={() => onRemove?.(edge.id)} disabled={readOnly} aria-label={`删除到 ${edgeTitle(edge.target)} 的连接`} title="删除连接"><Trash2 size={13} /><span>删除连接</span></button>}</div>; })}</div> : <p className="edge-list-empty">暂无连接，请从画布连接点拖线创建。</p>}{mainEdge && <div className="fixed-note main-selector-note">系统自动覆盖当前全部普通子 Agent；静态图允许多条固定边，运行时每轮只选择一个目标。</div>}</section>;
}
