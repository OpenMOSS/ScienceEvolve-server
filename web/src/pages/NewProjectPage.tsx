import { FormEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Cable,
  Check,
  ChevronDown,
  CircleHelp,
  Cpu,
  FileText,
  Folder,
  Gauge,
  Globe2,
  Layers3,
  Lightbulb,
  LoaderCircle,
  Plus,
  RotateCcw,
  Rocket,
  Save,
  ShieldCheck,
  Sparkles,
  Settings2,
  WandSparkles,
  X
} from "lucide-react";
import {
  ApiError,
  createSavedResearchTask,
  createProject,
  createProjectInputUpload,
  uploadProjectInputFile,
  listProjectInputFiles,
  removeProjectInputFile,
  openProjectInputDirectory,
  createUserSkill,
  createAgentConfigPreset,
  deleteAgentConfigPreset,
  downloadAgentConfigPreset,
  getAgentConfigPresets,
  getCatalog,
  getGitHubAccounts,
  getSavedResearchTask,
  testGateway,
  updateSavedResearchTask,
  updateAgentConfigPreset
} from "../api";
import { AgentIcon, Button, ErrorPanel } from "../components/Common";
import { CreateSkillDialog } from "../components/CreateSkillDialog";
import { ConfigRecommendation } from "../components/ConfigRecommendation";
import { useExplainerDraftBridge } from "../components/ProjectExplainerAssistant";
import { RecommendationProvider } from "../components/RecommendationContext";
import { AgentToolRecommendation } from "../components/AgentToolRecommendation";
import { McpServerControl } from "../components/McpServerControl";
import { ExperimentMcpControl } from "../components/ExperimentMcpControl";
import { OrchestrationTemplateEditor } from "../components/OrchestrationTemplateEditor";
import { GitRepositorySettings, gitRepositoryNameError } from "../components/GitRepositorySettings";
import { WorkflowCanvasEditor } from "../components/WorkflowCanvasEditor";
import {
  agentMeta,
  agentMcpServerKey,
  agentOrchestrationError,
  agentRuntimeConfigurationErrors,
  agentRuntimeConfigurationWarnings,
  agentSkillMode,
  applyCatalogDefaultHarness,
  applyCatalogDefaultHarnessToNewAgents,
  applyCatalogDefaultGateway,
  applyCatalogDefaultGatewayToNewAgents,
  catalogDefaultHarnessId,
  cloneAgentOrchestration,
  cloneAgentsConfig,
  orchestrationWithoutGit,
  constrainAgentConfigToHarness,
  createBlankWorkflow,
  DEFAULT_AGENT_ORCHESTRATION,
  DEFAULT_AGENTS,
  DEFAULT_MODELS,
  gatewayCombinationTestState,
  gatewayHarnessTestState,
  gatewayModelTestOptions,
  gatewayReasoningOptionIsValid,
  gatewayReasoningOptions,
  harnessOptionsForPurpose,
  isAgentTemplate,
  isLarkSkill,
  protocolLabel,
  projectResourcesPayload,
  migrateLegacyAgentReasoning
} from "../lib";
import {
  type AgentConfig,
  type AgentName,
  type AgentMcpServer,
  type AgentConfigPreset,
  type AgentOrchestrationTemplate,
  type AgentTemplate,
  type AgentHarness,
  type AgentsConfig,
  type FixedMcpDefinition,
  type GatewayRecord,
  type GitHubAccountRecord,
  type GitRepositoryVisibility,
  type Catalog,
  type HarnessCatalogEntry,
  type ProjectMcpDefinitions,
  type ProjectSkillDefinitions,
  type SavedResearchTask,
  type SkillDefinition
} from "../types";
import { normalizeCanvasLayout } from "../components/workflow-canvas/core/canvas-layout";
import { AGENT_PERMISSION_METADATA, AGENT_PERMISSION_OPTIONS as PERMISSION_OPTIONS } from "../../../server/src/internal/shared/agent-permission-metadata.js";

function AgentConfigCard({
  agentName,
  template,
  index,
  config,
  models,
  gateways,
  harnesses,
  skills,
  skillsLoading,
  defaultPrompt,
  mainSystemPrompt,
  onModelChange,
  onHarnessChange,
  onGatewayChange,
  onGatewayReasoningOptionChange,
  onTestConnection,
  onPermissionChange,
  onWebSearchChange,
  onInstructionsChange,
  onAddSkill,
  onSetSkillMode,
  mcpOptions,
  mcpDirectory,
  onAddMcp,
  onToggleMcp,
  onExperimentMcpChange,
}: {
  agentName: AgentName;
  template: AgentTemplate | string;
  index: number;
  config: AgentConfig;
  models: string[];
  gateways: GatewayRecord[];
  harnesses: HarnessCatalogEntry[];
  skills: SkillDefinition[];
  skillsLoading: boolean;
  defaultPrompt: string;
  mainSystemPrompt?: string;
  onModelChange: (model: string) => void;
  onHarnessChange: (harness: AgentHarness) => void;
  onGatewayChange: (gatewayId: string | undefined) => void;
  onTestConnection: (
    gatewayId: string,
    model: string,
    harness: AgentHarness,
    gatewayReasoningOption?: string
  ) => Promise<void>;
  onGatewayReasoningOptionChange: (optionId: string | undefined) => void;
  onPermissionChange: (permission: AgentConfig["permission"]) => void;
  onWebSearchChange: (enabled: boolean) => void;
  onInstructionsChange: (instructions: string) => void;
  onAddSkill: (title: string, content: string) => Promise<SkillDefinition>;
  onSetSkillMode: (
    skillId: string,
    mode: "fixed" | "auto" | undefined
  ) => void;
  mcpOptions: AgentMcpServer[];
  mcpDirectory: FixedMcpDefinition[];
  onAddMcp: (name: string, url: string) => AgentMcpServer;
  onToggleMcp: (server: AgentMcpServer, enabled: boolean) => void;
  onExperimentMcpChange: (enabled: boolean) => void;
}) {
  const meta = agentMeta(agentName, template);
  const selectedSkillIds = [...config.skills, ...config.autoSkills];
  const selectedGateway = gateways.find((gateway) => gateway.id === config.gatewayId);
  const selectedHarnessId = config.harness
    ?? catalogDefaultHarnessId(harnesses)
    ?? "";
  const harnessOptions = harnessOptionsForPurpose(harnesses, "workflow", selectedHarnessId);
  const selectedHarness = harnessOptions.find((item) => item.id === selectedHarnessId);
  const capabilities = selectedHarness?.capabilities;
  const webSearchSupported = capabilities?.webSearch !== false;
  const skillsSupported = capabilities?.skills !== false;
  const autoSkillsSupported = skillsSupported && capabilities?.autoSkills !== false;
  const mcpSupported = capabilities?.mcp !== false;
  const permissionOptions = capabilities?.permissionPrompts === undefined
    ? PERMISSION_OPTIONS
    : PERMISSION_OPTIONS.filter((option) => capabilities?.permissionPrompts?.includes(option.value));
  const permissionSupported = permissionOptions.some((option) => option.value === config.permission);
  const availableModels = selectedGateway?.models.length ? selectedGateway.models : models;
  const reasoningOptions = gatewayReasoningOptions(selectedGateway, config.model);
  const testedModelOptions = selectedGateway
    ? gatewayModelTestOptions(selectedGateway, selectedHarnessId, harnesses)
    : [];
  const failedModelOptions = testedModelOptions.filter((option) => option.test.status === "failed");
  const nativeProtocol = selectedHarness?.nativeProtocol;
  const combinationTest = selectedGateway && config.model.trim() && selectedGateway.models.includes(config.model)
    ? gatewayCombinationTestState(
        selectedGateway,
        selectedHarnessId,
        config.model,
        harnesses,
        config.gatewayReasoningOption
      )
    : undefined;
  const [skillDialogOpen, setSkillDialogOpen] = useState(false);
  const [skillInputNotice, setSkillInputNotice] = useState("");
  const [connectionTesting, setConnectionTesting] = useState(false);
  const [connectionTestError, setConnectionTestError] = useState("");
  const [mobileAgentCard, setMobileAgentCard] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const disclosureTouchedRef = useRef(false);

  useEffect(() => {
    setConnectionTestError("");
  }, [config.gatewayId, config.harness, config.model, config.gatewayReasoningOption]);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia("(max-width: 720px)");
    const update = () => {
      setMobileAgentCard(query.matches);
      if (!disclosureTouchedRef.current) {
        setExpanded(!query.matches || agentName === "main");
      }
    };
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, [agentName]);

  const addSkill = async (title: string, content: string) => {
    setSkillInputNotice("");
    const skill = await onAddSkill(title, content);
    setSkillInputNotice(`${skill.name} 已保存并加入候选，请勾选后设置加载方式。`);
    return skill;
  };

  const runConnectionTest = async () => {
    if (!selectedGateway || !selectedHarness?.available || !config.model.trim() || !selectedGateway.models.includes(config.model)) return;
    setConnectionTesting(true);
    setConnectionTestError("");
    try {
      await onTestConnection(
        selectedGateway.id,
        config.model,
        selectedHarnessId,
        config.gatewayReasoningOption
      );
    } catch (reason) {
      setConnectionTestError(reason instanceof Error ? reason.message : "连通性测试失败");
    } finally {
      setConnectionTesting(false);
    }
  };

  return (
    <article className={`agent-config-card agent-config-${meta.color}`}>
      <div className="agent-config-head">
        <span className="config-sequence">{String(index + 1).padStart(2, "0")}</span>
        <span className={`agent-config-icon agent-${meta.color}`}>
          <AgentIcon role={template} size={20} />
        </span>
        <div>
          <h3>{meta.name}</h3>
          <p>模板：{template} · {meta.description}</p>
        </div>
        <div className="agent-config-head-actions">
          {agentName === "main" && <span className="required-tag">必需 · 不可删除</span>}
          <button type="button" className={`agent-gateway-test-button ${combinationTest?.status === "passed" ? "passed" : ""}`} disabled={connectionTesting || !selectedGateway || !selectedHarness?.available || !config.model.trim() || !selectedGateway.models.includes(config.model)} onClick={() => void runConnectionTest()} aria-label={`测试${meta.name}连通性`}>
            {connectionTesting ? <LoaderCircle className="spin" size={13} /> : combinationTest?.status === "passed" ? <Check size={13} /> : <Cable size={13} />}
            <span>{connectionTesting ? "正在测试" : combinationTest?.status === "passed" ? "已通过，重新测试" : "测试当前组合"}</span>
          </button>
        </div>
        <button
          type="button"
          className="agent-config-disclosure"
          aria-label={`${expanded ? "收起" : "展开"}${meta.name}配置`}
          aria-expanded={expanded}
          onClick={() => {
            disclosureTouchedRef.current = true;
            setExpanded((value) => !value);
          }}
        >
          <ChevronDown size={16} aria-hidden="true" />
        </button>
      </div>
      <div className="agent-config-body" hidden={mobileAgentCard && !expanded}>
      <div className="agent-config-fields">
        <label className="field">
          <span><Settings2 size={14} />Harness</span>
          <div className="select-wrap">
            <select
              value={selectedHarnessId}
              onChange={(event) => onHarnessChange(event.target.value as AgentHarness)}
              aria-label={`${meta.name} Harness`}
              disabled={!harnessOptions.length}
            >
              {harnessOptions.map((item) => (
                <option value={item.id} key={item.id} disabled={!item.available}>
                  {item.label}{item.available ? "" : " · 不可用"}
                </option>
              ))}
            </select>
            <ChevronDown size={15} />
          </div>
          {selectedHarness && !selectedHarness.available && (
            <small className="field-error harness-availability-error" role="alert">
              {selectedHarness.availabilityReason ?? "服务端未找到该 Harness 的可执行入口"}
            </small>
          )}
        </label>
        <label className="field">
          <span><Globe2 size={14} />全局网关</span>
          <div className="select-wrap">
            <select
              value={config.gatewayId ?? ""}
              onChange={(event) => onGatewayChange(event.target.value || undefined)}
              aria-label={`${meta.name}全局网关`}
            >
              <option value="">未选择（当前服务环境）</option>
              {gateways.map((gateway) => {
                const state = gatewayHarnessTestState(gateway, selectedHarnessId, harnesses);
                return (
                  <option key={gateway.id} value={gateway.id}>
                    {gateway.name} · {state.status === "passed" ? "有已验证 model" : state.status === "failed" ? "连接验证失败" : "当前 Harness 未验证"}
                  </option>
                );
              })}
            </select>
            <ChevronDown size={15} />
          </div>
        </label>
        <div className="field agent-gateway-route-field">
          <span><Cable size={14} />网关协议与路由</span>
          <div className="derived-route-field" aria-label={`${meta.name}网关协议与路由`}>
            <strong>{selectedGateway ? protocolLabel(selectedGateway.protocol) : "选择网关后显示"}</strong>
            <small>{selectedGateway && nativeProtocol && nativeProtocol !== selectedGateway.protocol ? `自动路由：${protocolLabel(nativeProtocol)} → ${protocolLabel(selectedGateway.protocol)}` : selectedGateway && nativeProtocol ? "直连" : selectedGateway ? "Harness 目录待确认" : "尚未推导"}</small>
          </div>
          {combinationTest?.status !== undefined && combinationTest.status !== "passed" && (
            <small className="field-error gateway-combination-error" role="alert">
              {combinationTest.status === "failed"
                ? `当前 Harness / 网关 / model 组合验证失败${combinationTest.error ? `：${combinationTest.error}` : ""}；仍可启动，但运行可能失败。`
                : "当前 Harness / 网关 / model 组合尚未验证；仍可启动，但运行可能失败。"}
            </small>
          )}
          {connectionTestError && <small className="field-error gateway-combination-error" role="alert">连通性测试失败：{connectionTestError}</small>}
        </div>
        <label className="field">
          <span>
            <ShieldCheck size={14} />
            运行权限
          </span>
          <div className="select-wrap">
            <select
              value={config.permission}
              onChange={(event) =>
                onPermissionChange(event.target.value as AgentConfig["permission"])
              }
              aria-label={`${meta.name}运行权限`}
              disabled={!permissionOptions.length}
            >
              {!permissionSupported && (
                <option value={config.permission} disabled>
                  {PERMISSION_OPTIONS.find((option) => option.value === config.permission)?.label ?? config.permission} · 当前 Harness 不支持
                </option>
              )}
              {permissionOptions.map((option) => (
                <option value={option.value} key={option.value}>{option.label}</option>
              ))}
            </select>
            <ChevronDown size={15} />
          </div>
          {permissionOptions.length < PERMISSION_OPTIONS.length && (
            <small className="field-error harness-capability-note">
              {permissionOptions.length
                ? `当前 Harness 仅支持：${permissionOptions.map((option) => option.label).join("、")}`
                : "当前 Harness 未声明可用的权限模式"}
            </small>
          )}
        </label>
        <label className="field">
          <span>
            <Cpu size={14} />
            模型
          </span>
          <div className="select-wrap">
            {selectedGateway ? (
              <select
                value={config.model}
                onChange={(event) => onModelChange(event.target.value)}
                aria-label={`${meta.name}模型`}
                aria-invalid={!config.model.trim() || !selectedGateway.models.includes(config.model)}
              >
                <option value="" disabled>请选择网关 model</option>
                {testedModelOptions.map(({ model, test }) => (
                  <option value={model} key={model} title={test.error}>
                    {model} · {test.status === "passed" ? "已验证" : test.status === "failed" ? "验证失败" : "未验证"}
                  </option>
                ))}
              </select>
            ) : (
              <>
                <input
                  list={`model-options-${agentName}`}
                  value={config.model}
                  onChange={(event) => onModelChange(event.target.value)}
                  placeholder="输入模型 ID"
                  aria-label={`${meta.name}模型`}
                />
                <datalist id={`model-options-${agentName}`}>
                  {availableModels.map((model) => (
                    <option value={model} key={model} />
                  ))}
                </datalist>
              </>
            )}
            <ChevronDown size={15} />
          </div>
          {failedModelOptions.length > 0 && (
            <small className="field-error gateway-disabled-models">
              以下 model 验证失败，仍可选择并启动：{failedModelOptions.map(({ model, test }) => `${model}${test.error ? `（${test.error}）` : ""}`).join("；")}
            </small>
          )}
        </label>
        {(reasoningOptions.length > 0 || config.gatewayReasoningOption) && <label className="field">
          <span>
            <Gauge size={14} />
            网关思考强度
          </span>
          <div className="select-wrap">
            <select
              value={config.gatewayReasoningOption ?? ""}
              onChange={(event) => onGatewayReasoningOptionChange(event.target.value || undefined)}
              aria-label={`${meta.name}网关思考强度`}
            >
              <option value="">模型 / 网关默认（不发送字段）</option>
              {config.gatewayReasoningOption && !reasoningOptions.some((option) => option.id === config.gatewayReasoningOption) && <option value={config.gatewayReasoningOption} disabled>{config.gatewayReasoningOption} · 已失效</option>}
              {reasoningOptions.map((option) => <option key={option.id} value={option.id}>
                {option.label} · {option.value}
              </option>)}
            </select>
            <ChevronDown size={15} />
          </div>
        </label>}
        <div className="field agent-runtime-field">
          <span>
            <Globe2 size={14} />
            Web Search
          </span>
          <label className="agent-binary-toggle">
            <input
              type="checkbox"
              checked={config.webSearch}
              onChange={(event) => onWebSearchChange(event.target.checked)}
              aria-label={`${meta.name} Web Search`}
              disabled={!webSearchSupported}
            />
            <i aria-hidden="true" />
            <strong>{!webSearchSupported ? "当前 Harness 不支持" : config.webSearch ? "开启" : "关闭"}</strong>
          </label>
        </div>
        <div className="field">
          <span>
            <Layers3 size={14} />
            Skills
          </span>
          <details className="skill-picker" aria-disabled={!skillsSupported}>
            <summary>
              <span>
                {!skillsSupported
                  ? "当前 Harness 不支持"
                  : selectedSkillIds.length
                  ? `已添加 ${selectedSkillIds.length} 项`
                  : skillsLoading
                    ? "正在载入技能…"
                    : "选择 Skills"}
              </span>
              <ChevronDown size={15} />
            </summary>
            <div className="skill-menu">
              <div className="user-skill-create-row">
                <button
                  type="button"
                  onClick={() => {
                    setSkillInputNotice("");
                    setSkillDialogOpen(true);
                  }}
                  disabled={!skillsSupported}
                >
                  <Plus size={14} />
                  添加新 Skill
                </button>
                <small>填写标题与内容，保存为 SKILL.md</small>
                {skillInputNotice && (
                  <small className="user-skill-feedback success" role="status">
                    {skillInputNotice}
                  </small>
                )}
              </div>
              {skills.length ? (
                skills.map((skill) => {
                  const mode = agentSkillMode(config, skill.id);
                  const checked = mode !== undefined;
                  return (
                    <div className="skill-option" key={skill.id}>
                      <label className="skill-option-check">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() =>
                            onSetSkillMode(skill.id, checked ? undefined : "fixed")
                          }
                          disabled={!skillsSupported}
                        />
                        <span className={`check-box ${checked ? "checked" : ""}`}>
                          {checked && <Check size={13} />}
                        </span>
                        <span>
                          <strong>{skill.name}</strong>
                          {skill.description && <small>{skill.description}</small>}
                        </span>
                      </label>
                      {checked && (
                        <select
                          className="skill-load-mode"
                          value={mode}
                          onChange={(event) =>
                            onSetSkillMode(
                              skill.id,
                              event.target.value as "fixed" | "auto"
                            )
                          }
                          aria-label={`${meta.name}${skill.name}加载方式`}
                          disabled={!skillsSupported}
                        >
                          <option value="fixed">固定加载</option>
                          <option value="auto" disabled={!autoSkillsSupported}>自动选择</option>
                        </select>
                      )}
                    </div>
                  );
                })
              ) : (
                <div className="skill-empty">后端暂未提供可用 Skills</div>
              )}
            </div>
          </details>
          {!skillsSupported && <small className="field-error harness-capability-note">当前 Harness 不支持 Skills</small>}
          {skillsSupported && !autoSkillsSupported && <small className="field-error harness-capability-note">当前 Harness 不支持 Auto Skills，仅可固定加载</small>}
        </div>
        <McpServerControl
          agentName={meta.name}
          selected={config.mcpServers}
          options={mcpOptions}
          systemOptions={mcpDirectory}
          className="agent-config-mcp-control"
          disabled={!mcpSupported}
          onAdd={onAddMcp}
          onToggle={onToggleMcp}
        />
        {!mcpSupported && <small className="field-error harness-capability-note">当前 Harness 不支持 MCP</small>}
        <ExperimentMcpControl agentName={agentName} selected={config.experimentMcp === true}
          disabled={!mcpSupported} onChange={onExperimentMcpChange} />
        {agentName === "main" && (
          <label className="field agent-prompt-field main-system-prompt-field">
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
              aria-label="Main 系统固定 Prompt"
              rows={7}
            />
            <small>该协议由系统强制注入，用户不能修改。</small>
          </label>
        )}
        <label className="field agent-prompt-field">
          <span className="agent-prompt-label">
            <span>
              <FileText size={14} />
              {agentName === "main" ? "用户自定义 Prompt" : "Agent Prompt"}
            </span>
            <button
              type="button"
              onClick={() => onInstructionsChange(defaultPrompt)}
              disabled={!defaultPrompt || config.instructions === defaultPrompt}
            >
              <RotateCcw size={13} />
              恢复自带 Prompt
            </button>
          </span>
          <textarea
            value={config.instructions}
            onChange={(event) => onInstructionsChange(event.target.value)}
            placeholder={defaultPrompt ? "输入该 Agent 的完整角色 Prompt" : "正在载入自带 Prompt…"}
            aria-label={`${meta.name}自定义 Prompt`}
            rows={7}
            maxLength={20_000}
          />
          <small>{config.instructions.length.toLocaleString()} / 20,000 字符</small>
        </label>
        <AgentToolRecommendation agentId={agentName} instructions={config.instructions} />
      </div>
      {selectedGateway && nativeProtocol && nativeProtocol !== selectedGateway.protocol && (
        <div className="inline-warning protocol-route-notice" role="status">
          <Cable size={16} />
          <span>已根据所选 harness 和网关协议自动启用本地路由</span>
        </div>
      )}
      {(config.permission === "compute" || config.permission === "yolo") && (
        <div className="inline-warning agent-runtime-warning">
          <AlertTriangle size={16} />
          <span>{AGENT_PERMISSION_METADATA[config.permission].description} Skill 和业务 MCP 单独配置。</span>
        </div>
      )}
      {selectedSkillIds.length > 0 && (
        <div className="selected-skills">
          {selectedSkillIds.map((skillId) => (
            <div className="selected-skill-chip" key={skillId}>
              <span>{skills.find((item) => item.id === skillId)?.name ?? skillId}</span>
              <em>
                {agentSkillMode(config, skillId) === "fixed" ? "固定" : "自动"}
              </em>
              <button
                type="button"
                onClick={() => onSetSkillMode(skillId, undefined)}
                title="移除 Skill"
                aria-label={`移除 ${skillId}`}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      </div>
      {skillDialogOpen && (
        <CreateSkillDialog
          agentName={meta.name}
          onClose={() => setSkillDialogOpen(false)}
          onCreate={addSkill}
        />
      )}
    </article>
  );
}

function GatewayReference({ gateways, defaultGatewayId }: {
  gateways: GatewayRecord[];
  defaultGatewayId?: string;
}) {
  // New projects reference shared gateways and can probe the exact combination
  // selected by an Agent. Editing, credentials and full-matrix validation stay
  // on the application-level /gateways resource page.
  return <section className="global-resource-panel gateway-reference-panel" aria-label="项目使用的全局网关">
    <div className="form-section-head">
      <span className="section-number">G</span>
      <div><h2>全局网关引用</h2><p>可在每个 Agent 中测试当前 Harness / 网关 / model 组合；新增、编辑、凭据和全部 Harness 验证请在应用级网关库完成。</p></div>
      <a className="button button-secondary" href="#/gateways">管理网关库</a>
    </div>
    {gateways.length ? <div className="gateway-reference-list">{gateways.map((gateway) => <div className="gateway-reference-card" key={gateway.id}>
      <span><strong>{gateway.name}</strong>{gateway.builtin && <em>系统预置</em>}{defaultGatewayId === gateway.id && <em>默认</em>}</span>
      <small>{protocolLabel(gateway.protocol)} · {gateway.models.length} 个 model · 默认 {gateway.defaultModel}</small>
      <b className={`gateway-test-state gateway-test-${gateway.test.status}`}>{gateway.test.status === "passed" ? "已验证" : gateway.test.status === "failed" ? "需复核" : "待验证"}</b>
    </div>)}</div> : <div className="gateway-empty">尚未配置全局网关，请先打开应用级网关库。</div>}
  </section>;
}

type InputFileMeta = { path: string; size: number; mtimeMs?: number };
type InputDisplayEntry = { key: string; name: string; folder: boolean; files: InputFileMeta[]; size: number };

function inputDisplayEntries(files: InputFileMeta[]): InputDisplayEntry[] {
  const grouped = new Map<string, InputDisplayEntry>();
  for (const file of files) {
    const slash = file.path.indexOf("/");
    const folder = slash >= 0;
    const name = folder ? file.path.slice(0, slash) : file.path;
    const key = `${folder ? "folder" : "file"}:${name}`;
    let entry = grouped.get(key);
    if (!entry) {
      entry = { key, name, folder, files: [], size: 0 };
      grouped.set(key, entry);
    }
    entry.files.push(file);
    entry.size += file.size;
  }
  return [...grouped.values()];
}

export function NewProjectPage({
  active = true,
  onBack,
  onCreated,
  savedTaskId
}: {
  active?: boolean;
  onBack: () => void;
  onCreated: (id: string) => void;
  savedTaskId?: string;
}) {
  const workflowStructureId = useId();
  const agentFormationId = useId();
  const [title, setTitle] = useState("");
  const [requirement, setRequirement] = useState("");
  const [inputDescription, setInputDescription] = useState("");
  const [inputFiles, setInputFiles] = useState<InputFileMeta[]>([]);
  const inputSessionStorageKey = `openfars-user-inputs:${savedTaskId ?? "new"}`;
  const [inputUploadId, setInputUploadId] = useState<string | undefined>(() => {
    try { return sessionStorage.getItem(inputSessionStorageKey) ?? undefined; }
    catch { return undefined; }
  });
  const inputSessionPromiseRef = useRef<Promise<string> | null>(inputUploadId ? Promise.resolve(inputUploadId) : null);
  const [inputBusy, setInputBusy] = useState(false);
  const inputBusyRef = useRef(false);
  const inputRefreshPromiseRef = useRef<Promise<void> | null>(null);
  const [inputError, setInputError] = useState("");
  const [inputOpenError, setInputOpenError] = useState("");
  const [showAllInputs, setShowAllInputs] = useState(false);
  const groupedInputs = useMemo(() => inputDisplayEntries(inputFiles), [inputFiles]);
  const projectFileInputRef = useRef<HTMLInputElement>(null);
  const projectFolderInputRef = useRef<HTMLInputElement | null>(null);
  const [agents, setAgents] = useState<AgentsConfig>(() =>
    cloneAgentsConfig(DEFAULT_AGENTS)
  );
  const [orchestration, setOrchestration] =
    useState<AgentOrchestrationTemplate>(() =>
      cloneAgentOrchestration(DEFAULT_AGENT_ORCHESTRATION)
    );
  const [skillDefinitions, setSkillDefinitions] = useState<ProjectSkillDefinitions>({});
  const [mcpDefinitions, setMcpDefinitions] = useState<ProjectMcpDefinitions>({});
  const [agentPrompts, setAgentPrompts] = useState<Record<string, string>>({});
  const [mainSystemPrompt, setMainSystemPrompt] = useState("");
  const [mcpDirectory, setMcpDirectory] = useState<FixedMcpDefinition[]>([]);
  const [skills, setSkills] = useState<SkillDefinition[]>([]);
  const [models, setModels] = useState<string[]>(DEFAULT_MODELS);
  const [gateways, setGateways] = useState<GatewayRecord[]>([]);
  const [harnesses, setHarnesses] = useState<NonNullable<Catalog["harnesses"]>>([]);
  const [defaultHarnessId, setDefaultHarnessId] = useState<string>();
  const [runtimeCatalogState, setRuntimeCatalogState] = useState<
    "loading" | "ready" | "failed" | "invalid"
  >("loading");
  const [runtimeCatalogError, setRuntimeCatalogError] = useState("");
  const [defaultGatewayId, setDefaultGatewayId] = useState<string>();
  const [skillsLoading, setSkillsLoading] = useState(true);
  const [skillsWarning, setSkillsWarning] = useState("");
  const [configPresets, setConfigPresets] = useState<AgentConfigPreset[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState("default");
  const [workflowName, setWorkflowName] = useState("未命名流程");
  const [configPresetWarning, setConfigPresetWarning] = useState("");
  const [editingTask, setEditingTask] = useState<SavedResearchTask>();
  const [savedTaskLoadError, setSavedTaskLoadError] = useState("");
  const [savingTask, setSavingTask] = useState(false);
  const [saveTaskError, setSaveTaskError] = useState("");
  const [saveTaskNotice, setSaveTaskNotice] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [touched, setTouched] = useState(false);
  const [canvasEditorOpen, setCanvasEditorOpen] = useState(false);
  const [gitEnabled, setGitEnabled] = useState(false);
  const [githubAccounts, setGithubAccounts] = useState<GitHubAccountRecord[]>([]);
  const [githubAccountsLoading, setGithubAccountsLoading] = useState(true);
  const [githubAccountId, setGithubAccountId] = useState<string>();
  const [gitRepositoryName, setGitRepositoryName] = useState("");
  const [gitRepositoryVisibility, setGitRepositoryVisibility] =
    useState<GitRepositoryVisibility>("private");
  const [expandedGroupIds, setExpandedGroupIds] = useState<Set<string>>(new Set());
  const [workflowDetailsExpanded, setWorkflowDetailsExpanded] = useState(false);
  const [agentFormationExpanded, setAgentFormationExpanded] = useState(false);
  const [agentFormationMounted, setAgentFormationMounted] = useState(false);
  const [saveMenuOpen, setSaveMenuOpen] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);
  const [workflowSaveRevision, setWorkflowSaveRevision] = useState(0);
  const [saveConfigError, setSaveConfigError] = useState("");
  const [updateConfigConfirmOpen, setUpdateConfigConfirmOpen] = useState(false);
  const [newConfigDialogOpen, setNewConfigDialogOpen] = useState(false);
  const [newConfigName, setNewConfigName] = useState("");
  const [newConfigBlank, setNewConfigBlank] = useState(false);
  const [leaveDialogOpen, setLeaveDialogOpen] = useState(false);
  const wasInactiveRef = useRef(false);

  useEffect(() => {
    let mounted = true;
    let currentCatalog: Catalog | undefined;
    void Promise.allSettled([
      getCatalog().then(catalog => { currentCatalog = catalog; return catalog; }),
      getAgentConfigPresets(),
      savedTaskId ? getSavedResearchTask(savedTaskId).then(task => {
        if (!mounted) return task;
        // The selected draft is usable independently of slower resource and
        // account directories. Later responses must not reset manual edits.
        setEditingTask(task);
        setTitle(task.title);
        setWorkflowName(task.title);
        setRequirement(task.requirement);
        setAgents(currentCatalog
          ? applyCatalogDefaultHarness(cloneAgentsConfig(task.agents), currentCatalog.harnesses ?? [], currentCatalog.defaultHarnessId)
          : cloneAgentsConfig(task.agents));
        applyAssistantWorkflow(task.orchestration, false);
        setSkillDefinitions(structuredClone(task.skillDefinitions ?? {}));
        setMcpDefinitions(structuredClone(task.mcpDefinitions ?? {}));
        setGitEnabled(task.git?.enabled ?? false);
        setGithubAccountId(task.git?.enabled ? task.git.accountId : undefined);
        setGitRepositoryName(task.git?.enabled ? task.git.repositoryName ?? "" : "");
        setGitRepositoryVisibility(task.git?.enabled ? task.git.repositoryVisibility ?? "private" : "private");
        setSelectedPresetId("saved-task");
        setSavedTaskLoadError("");
        return task;
      }).catch(error => {
        if (mounted) setSavedTaskLoadError(error instanceof Error ? error.message : "已保存科研任务加载失败");
        throw error;
      }) : Promise.resolve(undefined),
      getGitHubAccounts()
    ]).then(
      ([catalogResult, presetResult, savedTaskResult, githubAccountsResult]) => {
        if (!mounted) return;
        if (catalogResult.status === "fulfilled") {
          const catalog = catalogResult.value;
          setSkills(catalog.skills.filter((skill) => !isLarkSkill(skill)));
          if (catalog.models.length) setModels(catalog.models);
          setGateways(catalog.gateways ?? []);
          setHarnesses(catalog.harnesses ?? []);
          setDefaultHarnessId(catalog.defaultHarnessId);
          const runtimeCatalogComplete =
            Array.isArray(catalog.gateways) && Array.isArray(catalog.harnesses);
          setRuntimeCatalogState(runtimeCatalogComplete ? "ready" : "invalid");
          setRuntimeCatalogError(runtimeCatalogComplete
            ? ""
            : "服务返回的运行目录不完整（缺少 Harness 或网关目录）");
          setDefaultGatewayId(catalog.defaultGatewayId);
          setAgentPrompts(catalog.agentPrompts);
          setMainSystemPrompt(catalog.mainSystemPrompt ?? "");
          setMcpDirectory(catalog.mcpDirectory ?? []);
        } else {
          const message = catalogResult.reason instanceof Error
            ? catalogResult.reason.message
            : "Catalog 请求失败";
          setRuntimeCatalogState("failed");
          setRuntimeCatalogError(message);
          setSkillsWarning(
            `Catalog 加载失败：${message}`
          );
        }

        if (presetResult.status === "fulfilled") {
          setConfigPresets(presetResult.value);
          const defaultPreset = presetResult.value.find(
            (preset) => preset.id === "default"
          );
          if (defaultPreset && !savedTaskId) {
            const presetAgents = cloneAgentsConfig(defaultPreset.agents);
            setAgents(!savedTaskId && catalogResult.status === "fulfilled"
              ? applyCatalogDefaultGateway(
                  applyCatalogDefaultHarness(
                    presetAgents,
                    catalogResult.value.harnesses ?? [],
                    catalogResult.value.defaultHarnessId
                  ),
                  catalogResult.value.defaultGatewayId,
                  catalogResult.value.gateways ?? []
                )
              : presetAgents);
            setOrchestration(
              cloneAgentOrchestration(defaultPreset.orchestration)
            );
            setSkillDefinitions(structuredClone(defaultPreset.skillDefinitions ?? {}));
            setMcpDefinitions(structuredClone(defaultPreset.mcpDefinitions ?? {}));
            setWorkflowName(defaultPreset.name);
          } else if (!savedTaskId && catalogResult.status === "fulfilled") {
            setAgents((current) =>
              applyCatalogDefaultGateway(applyCatalogDefaultHarness(Object.fromEntries(
                Object.keys(current).map((agent) => [
                  agent,
                  {
                    ...current[agent],
                    instructions:
                      current[agent].instructions ||
                      catalogResult.value.agentPrompts[agent]
                  }
                ])
              ) as AgentsConfig, catalogResult.value.harnesses ?? [], catalogResult.value.defaultHarnessId), catalogResult.value.defaultGatewayId, catalogResult.value.gateways ?? [])
            );
          }
        } else {
          setConfigPresetWarning(
            presetResult.reason instanceof Error
              ? presetResult.reason.message
              : "Agent 配置预设加载失败"
          );
          if (!savedTaskId && catalogResult.status === "fulfilled") {
            setAgents((current) =>
              applyCatalogDefaultGateway(applyCatalogDefaultHarness(Object.fromEntries(
                Object.keys(current).map((agent) => [
                  agent,
                  {
                    ...current[agent],
                    instructions:
                      current[agent].instructions ||
                      catalogResult.value.agentPrompts[agent]
                  }
                ])
              ) as AgentsConfig, catalogResult.value.harnesses ?? [], catalogResult.value.defaultHarnessId), catalogResult.value.defaultGatewayId, catalogResult.value.gateways ?? [])
            );
          }
        }

        if (savedTaskResult.status === "fulfilled" && savedTaskResult.value) {
          if (catalogResult.status === "fulfilled") setAgents(current =>
            applyCatalogDefaultHarness(current, catalogResult.value.harnesses ?? [], catalogResult.value.defaultHarnessId));
        } else if (savedTaskResult.status === "rejected") {
          setSavedTaskLoadError(
            savedTaskResult.reason instanceof Error
              ? savedTaskResult.reason.message
              : "已保存科研任务加载失败"
          );
        }
        if (githubAccountsResult.status === "fulfilled") {
          setGithubAccounts(githubAccountsResult.value.accounts);
          setGithubAccountId((current) => current
            ?? githubAccountsResult.value.defaultAccountId
            ?? githubAccountsResult.value.accounts.find((account) => account.status === "ready")?.id);
        }
        setGithubAccountsLoading(false);
        setSkillsLoading(false);
      }
    );
    return () => {
      mounted = false;
    };
  }, [savedTaskId]);

  useEffect(() => {
    if (!gateways.length || !Object.values(agents).some(
      (config) => config.legacyReasoningEffort || config.reasoningEffort
    )) return;
    setAgents((current) => migrateLegacyAgentReasoning(current, gateways));
  }, [agents, gateways]);

  useEffect(() => {
    if (githubAccountId && githubAccounts.some(
      (account) => account.id === githubAccountId && account.status === "ready"
    )) return;
    if (githubAccountId) return;
    const fallback = githubAccounts.find((account) => account.isDefault && account.status === "ready")
      ?? githubAccounts.find((account) => account.status === "ready");
    if (fallback) setGithubAccountId(fallback.id);
  }, [githubAccountId, githubAccounts]);

  useEffect(() => {
    if (!active) {
      wasInactiveRef.current = true;
      return;
    }
    if (!wasInactiveRef.current) return;
    wasInactiveRef.current = false;

    let current = true;
    void getCatalog().then((catalog) => {
      if (!current) return;
      setGateways(catalog.gateways ?? []);
      setDefaultGatewayId(catalog.defaultGatewayId);
      setHarnesses(catalog.harnesses ?? []);
      setDefaultHarnessId(catalog.defaultHarnessId);
      if (catalog.models.length) setModels(catalog.models);
      const complete = Array.isArray(catalog.gateways) && Array.isArray(catalog.harnesses);
      setRuntimeCatalogState(complete ? "ready" : "invalid");
      setRuntimeCatalogError(complete
        ? ""
        : "服务返回的运行目录不完整（缺少 Harness 或网关目录）");
    }).catch((reason) => {
      if (!current) return;
      setRuntimeCatalogState("failed");
      setRuntimeCatalogError(reason instanceof Error ? reason.message : "Catalog 请求失败");
    });
    setGithubAccountsLoading(true);
    void getGitHubAccounts().then((catalog) => {
      if (!current) return;
      setGithubAccounts(catalog.accounts);
      setGithubAccountId((selected) => selected
        ?? catalog.defaultAccountId
        ?? catalog.accounts.find((account) => account.status === "ready")?.id);
    }).catch(() => {
      if (current) setGithubAccounts([]);
    }).finally(() => {
      if (current) setGithubAccountsLoading(false);
    });
    return () => { current = false; };
  }, [active]);

  const selectedPreset = configPresets.find(
    (preset) => preset.id === selectedPresetId
  );
  const defaultRoleTemplates =
    configPresets.find((preset) => preset.id === "default")?.agents ??
    DEFAULT_AGENTS;

  const applyPreset = (presetId: string) => {
    if (savingConfig || savingTask) return;
    setSelectedPresetId(presetId);
    setTouched(true);
    if (presetId === "saved-task" && editingTask) {
      setAgents(applyCatalogDefaultHarness(cloneAgentsConfig(editingTask.agents), harnesses, defaultHarnessId));
      setOrchestration(cloneAgentOrchestration(editingTask.orchestration));
      setSkillDefinitions(structuredClone(editingTask.skillDefinitions ?? {}));
      setMcpDefinitions(structuredClone(editingTask.mcpDefinitions ?? {}));
      setGitEnabled(editingTask.git?.enabled ?? false);
      setGithubAccountId(editingTask.git?.enabled ? editingTask.git.accountId : undefined);
      setGitRepositoryName(editingTask.git?.enabled ? editingTask.git.repositoryName ?? "" : "");
      setGitRepositoryVisibility(editingTask.git?.enabled ? editingTask.git.repositoryVisibility ?? "private" : "private");
      setWorkflowName(editingTask.title);
      return;
    }
    const preset = configPresets.find((item) => item.id === presetId);
    const presetAgents = cloneAgentsConfig(preset?.agents ?? DEFAULT_AGENTS);
    setAgents(presetId === "default"
      ? applyCatalogDefaultGateway(
          applyCatalogDefaultHarness(presetAgents, harnesses, defaultHarnessId),
          defaultGatewayId,
          gateways
        )
      : applyCatalogDefaultHarness(presetAgents, harnesses, defaultHarnessId));
    setOrchestration(
      cloneAgentOrchestration(
        preset?.orchestration ?? DEFAULT_AGENT_ORCHESTRATION
      )
    );
    setSkillDefinitions(structuredClone(preset?.skillDefinitions ?? {}));
    setMcpDefinitions(structuredClone(preset?.mcpDefinitions ?? {}));
    setWorkflowName(preset?.name ?? "未命名流程");
  };

  const setWorkflowOrchestration = (value: AgentOrchestrationTemplate) => {
    setTouched(true);
    setOrchestration((current) => {
      const next = cloneAgentOrchestration(value);
      next.canvas = normalizeCanvasLayout(next.canvas ?? current.canvas, next);
      return next;
    });
  };

  const applyAssistantWorkflow = (value: AgentOrchestrationTemplate, markTouched = true) => {
    const shape = (graph: AgentOrchestrationTemplate) => JSON.stringify({ agents: graph.agents, input: graph.input,
      routes: graph.routes, collaborations: graph.collaborations, scopedWorkflow: graph.scopedWorkflow });
    const arrange = markTouched ? shape(value) !== shape(orchestration) : !value.canvas;
    const next = cloneAgentOrchestration(value);
    next.canvas = normalizeCanvasLayout(arrange ? undefined : next.canvas ?? orchestration.canvas, next);
    if (markTouched) setTouched(true);
    setOrchestration(next);
    if (arrange) void import("../components/workflow-canvas/core/canvas-layout-plan").then(async ({ buildCanvasLayoutPlan }) => {
      const plan = await buildCanvasLayoutPlan({ kind: "layered", orchestration: next, layout: next.canvas, viewportSize: { width: 1000, height: 640 } });
      // A delayed layout may change presentation only while this exact graph
      // is still current; manual canvas edits always win.
      setOrchestration(current => current === next ? { ...current, canvas: { ...plan.layout, viewport: next.canvas!.viewport } } : current);
    }).catch(() => setSaveTaskNotice("助手配置已应用，可在画布中点击自动调整整理布局。"));
  };

  const gitRequiredByCollaborations = (orchestration.collaborations?.length ?? 0) > 0;
  const setGitMode = (enabled: boolean) => {
    if (!enabled && gitRequiredByCollaborations) return;
    if (!enabled) {
      try { setOrchestration(orchestrationWithoutGit(orchestration)); }
      catch (error) { setSaveTaskError(error instanceof Error ? error.message : "当前 Workflow 无法关闭 Git 机制"); return; }
    }
    setGitEnabled(enabled);
    setTouched(true);
    if (!enabled) return;
    const readyAccounts = githubAccounts.filter((account) => account.status === "ready");
    if (!readyAccounts.length) {
      window.location.hash = "/github-accounts";
      return;
    }
    if (!readyAccounts.some((account) => account.id === githubAccountId)) {
      setGithubAccountId(
        readyAccounts.find((account) => account.isDefault)?.id ?? readyAccounts[0]?.id
      );
    }
  };

  const titleValid = title.trim().length > 0;
  const requirementValid = requirement.trim().length >= 10;
  const agentsValid = orchestration.agents.every(
    (definition) => agents[definition.name]?.model.trim()
  );
  const runtimeConfigErrors = agentRuntimeConfigurationErrors(
    orchestration,
    agents,
    gateways,
    harnesses,
    runtimeCatalogState === "ready"
  );
  const runtimeConfigWarnings = agentRuntimeConfigurationWarnings(
    orchestration,
    agents,
    gateways,
    harnesses
  );
  const orchestrationError = agentOrchestrationError(orchestration, gitEnabled);
  const projectReferenceError = useMemo(() => {
    for (const definition of orchestration.agents) {
      const config = agents[definition.name];
      for (const skill of [...config.skills, ...config.autoSkills]) {
        if (skill.startsWith("project:") && !Object.hasOwn(skillDefinitions, skill.slice(8))) {
          return `${definition.name} 引用了未定义的 Project Skill：${skill}`;
        }
      }
      for (const server of config.mcpServers) {
        if (typeof server.project === "string" && !Object.hasOwn(mcpDefinitions, server.project)) {
          return `${definition.name} 引用了未定义的 Project MCP：${server.project}`;
        }
      }
    }
    return "";
  }, [agents, mcpDefinitions, orchestration.agents, skillDefinitions]);
  const collaborationGitReady = !gitRequiredByCollaborations || gitEnabled;
  const githubAccountReady = !gitEnabled || githubAccounts.some(
    (account) => account.id === githubAccountId && account.status === "ready"
  );
  const repositoryNameError = gitEnabled ? gitRepositoryNameError(gitRepositoryName) : "";
  const repositoryConfigurationReady = !gitEnabled || !repositoryNameError;
  const canSaveDraft = titleValid && requirementValid && agentsValid && collaborationGitReady &&
    repositoryConfigurationReady && !projectReferenceError;
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
  const startValidationErrors = [...new Set([
    savedTaskLoadError && `已保存任务加载失败：${savedTaskLoadError}`,
    !titleValid && "请输入项目名称",
    !requirementValid && "课题方向与具体要求至少需要 10 个字符",
    runtimeCatalogBlocker,
    orchestrationError && `Workflow：${orchestrationError}`,
    projectReferenceError,
    !collaborationGitReady && "当前 Workflow 包含协作组，请先启用 Git 机制",
    !githubAccountReady && "请选择一个授权正常的 GitHub 账号",
    repositoryNameError && `Git 仓库名称：${repositoryNameError}`,
    inputBusy && "课题附件正在上传或读取，请等待完成后再次启动",
    inputError && `课题附件：${inputError}`,
    ...orchestration.agents.filter(definition => !agents[definition.name]?.model.trim()).map(definition => `${definition.name} 尚未选择模型`),
    ...runtimeConfigErrors
  ].filter((message): message is string => Boolean(message)))];
  const requirementLength = requirement.trim().length;

  const configuredSkillCount = useMemo(
    () =>
      new Set(
        orchestration.agents.flatMap((definition) => [
          ...agents[definition.name].skills,
          ...agents[definition.name].autoSkills
        ])
      ).size,
    [agents, orchestration.agents]
  );
  const availableSkills = useMemo(() => [
    ...skills,
    ...Object.keys(skillDefinitions).map((name) => ({
      id: `project:${name}`,
      name,
      description: "当前 Workflow 的版本化 Project Skill",
      category: "项目 Skill"
    }))
  ], [skillDefinitions, skills]);
  const mcpOptions = useMemo(() => {
    const byKey = new Map<string, AgentMcpServer>();
    for (const server of mcpDirectory) {
      byKey.set(agentMcpServerKey(server), server);
    }
    for (const name of Object.keys(mcpDefinitions)) {
      const server: AgentMcpServer = { name, project: name };
      byKey.set(agentMcpServerKey(server), server);
    }
    for (const definition of orchestration.agents) {
      for (const server of agents[definition.name].mcpServers) {
        byKey.set(agentMcpServerKey(server), server);
      }
    }
    return [...byKey.values()];
  }, [agents, mcpDefinitions, mcpDirectory, orchestration.agents]);

  const harnessForAgent = (agent: AgentName): HarnessCatalogEntry | undefined => {
    const harnessId = agents[agent].harness
      ?? catalogDefaultHarnessId(harnesses, defaultHarnessId);
    return harnesses.find((item) => item.id === harnessId);
  };

  const updateModel = (agent: AgentName, model: string) => {
    setTouched(true);
    setAgents((current) => {
      const config = current[agent];
      const gateway = gateways.find((item) => item.id === config.gatewayId);
      return {
        ...current,
        [agent]: {
          ...config,
          model,
          ...(gatewayReasoningOptionIsValid(gateway, model, config.gatewayReasoningOption)
            ? {}
            : { gatewayReasoningOption: undefined })
        }
      };
    });
  };

  const updateHarness = (agent: AgentName, harness: AgentHarness) => {
    setTouched(true);
    const selectedHarness = harnesses.find((item) => item.id === harness);
    setAgents((current) => ({
      ...current,
      [agent]: constrainAgentConfigToHarness({
        ...current[agent],
        harness
      }, selectedHarness)
    }));
  };

  const updateAgentGateway = (agent: AgentName, gatewayId: string | undefined) => {
    setTouched(true);
    const gateway = gateways.find((item) => item.id === gatewayId);
    setAgents((current) => {
      const currentConfig = current[agent];
      const model = gateway && !gateway.models.includes(currentConfig.model)
        ? ""
        : currentConfig.model;
      return {
        ...current,
        [agent]: {
          ...currentConfig,
          gatewayId,
          model,
          ...(gatewayReasoningOptionIsValid(gateway, model, currentConfig.gatewayReasoningOption)
            ? {}
            : { gatewayReasoningOption: undefined })
        }
      };
    });
  };

  const updateGatewayReasoningOption = (agent: AgentName, optionId: string | undefined) => {
    setTouched(true);
    setAgents((current) => ({
      ...current,
      [agent]: { ...current[agent], gatewayReasoningOption: optionId }
    }));
  };

  const testAgentConnection = async (
    gatewayId: string,
    model: string,
    harness: AgentHarness,
    gatewayReasoningOption?: string
  ) => {
    const checked = gatewayReasoningOption
      ? await testGateway(gatewayId, model, harness, { gatewayReasoningOption })
      : await testGateway(gatewayId, model, harness);
    setGateways((current) => current.map((gateway) =>
      gateway.id === checked.id ? checked : gateway
    ));
  };

  const updateInstructions = (agent: AgentName, instructions: string) => {
    setTouched(true);
    setAgents((current) => ({
      ...current,
      [agent]: { ...current[agent], instructions }
    }));
  };

  const updatePermission = (
    agent: AgentName,
    permission: AgentConfig["permission"]
  ) => {
    const selectedHarness = harnessForAgent(agent);
    if (selectedHarness?.capabilities.permissionPrompts &&
        !selectedHarness.capabilities.permissionPrompts.includes(permission)) return;
    setTouched(true);
    setAgents((current) => ({
      ...current,
      [agent]: {
        ...current[agent],
        permission
      }
    }));
  };

  const updateWebSearch = (agent: AgentName, webSearch: boolean) => {
    const selectedHarness = harnessForAgent(agent);
    if (webSearch && selectedHarness?.capabilities.webSearch === false) return;
    setTouched(true);
    setAgents((current) => ({
      ...current,
      [agent]: { ...current[agent], webSearch }
    }));
  };

  const setSkillMode = (
    agent: AgentName,
    skillId: string,
    mode: "fixed" | "auto" | undefined
  ) => {
    const selectedHarness = harnessForAgent(agent);
    if (mode && selectedHarness?.capabilities.skills === false) return;
    if (mode === "auto" && selectedHarness?.capabilities.autoSkills === false) return;
    setTouched(true);
    setAgents((current) => {
      const skills = current[agent].skills.filter((item) => item !== skillId);
      const autoSkills = current[agent].autoSkills.filter(
        (item) => item !== skillId
      );
      if (mode === "fixed") skills.push(skillId);
      if (mode === "auto") autoSkills.push(skillId);
      return {
        ...current,
        [agent]: {
          ...current[agent],
          skills,
          autoSkills
        }
      };
    });
  };

  const addSkillCandidate = async (title: string, content: string) => {
    if (title.trim().toLowerCase().startsWith("lark")) {
      throw new Error("Lark Skills 不在科研 Agent 的候选范围内");
    }
    const skill = await createUserSkill(title, content);
    if (isLarkSkill(skill)) {
      throw new Error("Lark Skills 不在科研 Agent 的候选范围内");
    }
    setSkills((current) =>
      current.some((item) => item.id === skill.id)
        ? current
        : [...current, skill]
    );
    return skill;
  };

  const addMcpForRole = (
    agent: AgentName,
    name: string,
    url: string
  ): AgentMcpServer => {
    const selectedHarness = harnessForAgent(agent);
    if (selectedHarness?.capabilities.mcp === false) {
      throw new Error(`${selectedHarness.label} 不支持 MCP`);
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
      agents[agent].mcpServers.some(
        (server) => server.name.toLowerCase() === normalizedName.toLowerCase()
      )
    ) {
      throw new Error(`MCP 名称已存在：${normalizedName}`);
    }
    if (agents[agent].mcpServers.length >= 32) {
      throw new Error("每个 Agent 最多可配置 32 个 MCP");
    }
    const server = { name: normalizedName, url: normalizedUrl };
    setAgents((current) => ({
      ...current,
      [agent]: {
        ...current[agent],
        mcpServers: [...current[agent].mcpServers, server]
      }
    }));
    setTouched(true);
    return server;
  };

  const toggleMcpForRole = (
    agent: AgentName,
    server: AgentMcpServer,
    enabled: boolean
  ) => {
    const selectedHarness = harnessForAgent(agent);
    if (enabled && selectedHarness?.capabilities.mcp === false) return;
    setTouched(true);
    setAgents((current) => {
      const remaining = current[agent].mcpServers.filter(
        (item) =>
          enabled
            ? item.name.toLowerCase() !== server.name.toLowerCase()
            : agentMcpServerKey(item) !== agentMcpServerKey(server)
      );
      return {
        ...current,
        [agent]: {
          ...current[agent],
          mcpServers: enabled ? [...remaining, { ...server }] : remaining
        }
      };
    });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting || savingTask || savingConfig) return;
    setTouched(true);
    if (startValidationErrors.length) {
      setSubmitError(`启动前检查未通过：${startValidationErrors.join("；")}`);
      return;
    }
    setSubmitting(true);
    setSubmitError("");
    try {
      if (inputFiles.length) {
        if (inputFiles.length > 1000) throw new Error("最多上传 1000 个文件");
        if (inputFiles.some(({ size }) => size > 50 * 1024 * 1024)) throw new Error("单个文件不能超过 50 MiB");
        if (inputFiles.reduce((sum, { size }) => sum + size, 0) > 200 * 1024 * 1024) throw new Error("附件总量不能超过 200 MiB");
      }
      const project = await createProject({
        ...(assistant?.conversationId ? { explainerConversationId: assistant.conversationId } : {}),
        ...(editingTask?.id ? { sourceSavedTaskId: editingTask.id } : {}),
        title: title.trim(),
        requirement: requirement.trim(),
        inputUploadId,
        inputDescription: inputDescription.trim(),
        agents,
        orchestration: cloneAgentOrchestration(orchestration),
        git: {
          enabled: gitEnabled,
          ...(gitEnabled ? {
            provider: "github" as const,
            accountId: githubAccountId,
            repositoryName: gitRepositoryName,
            repositoryVisibility: gitRepositoryVisibility
          } : {})
        },
        ...projectResourcesPayload(skillDefinitions, mcpDefinitions)
      });
      if (!project.id) throw new Error("项目已创建，但服务未返回项目 ID");
      try { sessionStorage.removeItem(inputSessionStorageKey); } catch { /* Session storage may be unavailable. */ }
      onCreated(project.id);
    } catch (reason) {
      setSubmitError(reason instanceof Error ? reason.message : "项目创建失败");
    } finally {
      setSubmitting(false);
    }
  };

  const ensureInputSession = (): Promise<string> => {
    if (!inputSessionPromiseRef.current) {
      inputSessionPromiseRef.current = createProjectInputUpload().then((id) => {
        setInputUploadId(id);
        try { sessionStorage.setItem(inputSessionStorageKey, id); } catch { /* Temporary inputs remain available for this page. */ }
        return id;
      }).catch((error) => {
        inputSessionPromiseRef.current = null;
        throw error;
      });
    }
    return inputSessionPromiseRef.current;
  };

  const refreshInputFiles = async (id = inputUploadId, clearError = true): Promise<void> => {
    if (!id) return;
    if (!inputRefreshPromiseRef.current) {
      inputRefreshPromiseRef.current = listProjectInputFiles(id).then((files) => {
        setInputFiles(files);
        if (clearError) setInputError("");
      }).finally(() => { inputRefreshPromiseRef.current = null; });
    }
    await inputRefreshPromiseRef.current;
  };

  const addInputFiles = async (files: FileList | null, fromFolder: boolean) => {
    const selected = files ? Array.from(files, (file) => ({
      file,
      relativePath: fromFolder && file.webkitRelativePath ? file.webkitRelativePath : file.name
    })) : [];
    if (!selected.length || inputBusyRef.current) return;
    inputBusyRef.current = true;
    setInputBusy(true);
    setInputError("");
    try {
      if (inputRefreshPromiseRef.current) await inputRefreshPromiseRef.current.catch(() => undefined);
      const id = await ensureInputSession();
      for (const { file, relativePath } of selected) {
        await uploadProjectInputFile(id, relativePath, file);
      }
      await refreshInputFiles(id);
      setTouched(true);
    } catch (error) {
      setInputError(error instanceof Error ? error.message : "添加文件失败");
      const id = await inputSessionPromiseRef.current?.catch(() => undefined);
      if (id) await refreshInputFiles(id, false).catch(() => undefined);
    } finally { inputBusyRef.current = false; setInputBusy(false); }
  };

  const removeInputEntry = async (entry: InputDisplayEntry) => {
    if (!inputUploadId || inputBusyRef.current) return;
    inputBusyRef.current = true;
    setInputBusy(true);
    setInputError("");
    try {
      if (inputRefreshPromiseRef.current) await inputRefreshPromiseRef.current.catch(() => undefined);
      for (const file of entry.files) await removeProjectInputFile(inputUploadId, file.path);
      await refreshInputFiles(inputUploadId);
      setTouched(true);
    } catch (error) { setInputError(error instanceof Error ? error.message : "移除文件失败"); }
    finally { inputBusyRef.current = false; setInputBusy(false); }
  };

  const openInputsDirectory = async () => {
    if (inputBusyRef.current) return;
    inputBusyRef.current = true;
    setInputBusy(true);
    setInputOpenError("");
    try {
      if (inputRefreshPromiseRef.current) await inputRefreshPromiseRef.current.catch(() => undefined);
      const id = await ensureInputSession();
      try {
        await openProjectInputDirectory(id);
      } catch (error) {
        setInputOpenError(error instanceof Error ? error.message : "打开文件管理器失败");
      }
      await refreshInputFiles(id);
    } catch (error) { setInputError(error instanceof Error ? error.message : "读取文件列表失败"); }
    finally { inputBusyRef.current = false; setInputBusy(false); }
  };

  useEffect(() => {
    if (!inputUploadId) return;
    void refreshInputFiles(inputUploadId).catch((error) => {
      if (error instanceof ApiError && error.status === 404) {
        inputSessionPromiseRef.current = null;
        setInputUploadId(undefined);
        try { sessionStorage.removeItem(inputSessionStorageKey); } catch { /* Ignore unavailable storage. */ }
        setInputError("上次的临时 user_inputs 目录已过期，请重新添加文件。");
      } else setInputError(error instanceof Error ? error.message : "读取文件列表失败");
    });
  }, []);

  useEffect(() => {
    if (!inputUploadId || inputBusy) return;
    const refresh = () => {
      if (inputBusyRef.current) return;
      void refreshInputFiles(inputUploadId).catch((error) => setInputError(error instanceof Error ? error.message : "刷新文件失败"));
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [inputUploadId, inputBusy]);

  const saveTaskCopy = async (): Promise<boolean> => {
    setTouched(true);
    if (!canSaveDraft) return false;
    setSavingTask(true);
    setSaveTaskError("");
    setSaveTaskNotice("");
    const input = {
      title: title.trim(),
      requirement: requirement.trim(),
      agents: cloneAgentsConfig(agents),
      orchestration: cloneAgentOrchestration(orchestration),
      git: {
        enabled: gitEnabled,
        ...(gitEnabled ? {
          provider: "github" as const,
          accountId: githubAccountId,
          repositoryName: gitRepositoryName,
          repositoryVisibility: gitRepositoryVisibility
        } : {})
      },
      ...projectResourcesPayload(skillDefinitions, mcpDefinitions)
    };
    try {
      const task = editingTask
        ? await updateSavedResearchTask(editingTask.id, input)
        : await createSavedResearchTask(input);
      setEditingTask(task);
      let assistantNotice = "";
      try { await assistant?.bindDraft(task.id, input); } catch { assistantNotice = " 助手同步需要重新读取，已保存的草稿保留。"; }
      setSelectedPresetId("saved-task");
      setSaveTaskNotice(
        (savedTaskId
          ? "修改已保存，可从主页直接启动。"
        : "研究任务副本已保存到主页。后续修改可继续保存到该副本。") + assistantNotice
      );
      setTouched(false);
      setWorkflowSaveRevision((revision) => revision + 1);
      return true;
    } catch (reason) {
      setSaveTaskError(
        reason instanceof Error ? reason.message : "研究任务副本保存失败"
      );
      return false;
    } finally {
      setSavingTask(false);
    }
  };

  const performWorkflowSave = async (action: "update" | "project" | "new", name?: string) => {
    setSaveMenuOpen(false);
    setSavingConfig(true);
    setSaveConfigError("");
    try {
      if (action === "project") {
        await saveTaskCopy();
        return;
      }
      const currentPreset = configPresets.find((preset) => preset.id === selectedPresetId);
      const blank = action === "new" && newConfigBlank;
      const blankWorkflow = blank ? createBlankWorkflow() : undefined;
      const workflowAgents = blankWorkflow
        ? applyCatalogDefaultGateway(
            applyCatalogDefaultHarness(blankWorkflow.agents, harnesses, defaultHarnessId),
            defaultGatewayId,
            gateways
          )
        : agents;
      const workflowOrchestration = blankWorkflow?.orchestration ?? orchestration;
      const workflowSkillDefinitions = blankWorkflow ? {} : skillDefinitions;
      const workflowMcpDefinitions = blankWorkflow ? {} : mcpDefinitions;
      const workflowDisplayName = (action === "new" ? name ?? "" : workflowName).trim() || currentPreset?.name || "未命名流程";
      if (action === "update") {
        if (!currentPreset || currentPreset.builtin) throw new Error("系统默认配置不能覆盖更新，请选择另存为新配置");
        const updated = await updateAgentConfigPreset(currentPreset.id, {
          name: workflowDisplayName,
          agents: cloneAgentsConfig(workflowAgents),
          orchestration: cloneAgentOrchestration(workflowOrchestration),
          ...projectResourcesPayload(workflowSkillDefinitions, workflowMcpDefinitions)
        });
        setConfigPresets((items) => items.map((item) => item.id === updated.id ? updated : item));
        setAgents(cloneAgentsConfig(updated.agents));
        setOrchestration(cloneAgentOrchestration(updated.orchestration));
        setSkillDefinitions(structuredClone(updated.skillDefinitions ?? {}));
        setMcpDefinitions(structuredClone(updated.mcpDefinitions ?? {}));
        setWorkflowName(updated.name);
        setSaveTaskNotice(`${updated.name} 已更新`);
        setTouched(false);
        setWorkflowSaveRevision((revision) => revision + 1);
        return;
      }
      if (!name?.trim()) return;
      const created = await createAgentConfigPreset({
        name: workflowDisplayName,
        agents: cloneAgentsConfig(workflowAgents),
        orchestration: cloneAgentOrchestration(workflowOrchestration),
        ...projectResourcesPayload(workflowSkillDefinitions, workflowMcpDefinitions)
      });
      setConfigPresets((items) => [created, ...items.filter((item) => item.id !== created.id)]);
      setSelectedPresetId(created.id);
      setAgents(cloneAgentsConfig(created.agents));
      setOrchestration(cloneAgentOrchestration(created.orchestration));
      setSkillDefinitions(structuredClone(created.skillDefinitions ?? {}));
      setMcpDefinitions(structuredClone(created.mcpDefinitions ?? {}));
      setWorkflowName(created.name);
      setNewConfigBlank(false);
      setSaveTaskNotice(`${created.name} 已保存并载入当前编辑`);
      setTouched(false);
      setWorkflowSaveRevision((revision) => revision + 1);
    } catch (reason) {
      setSaveConfigError(reason instanceof Error ? reason.message : "Workflow 配置保存失败");
    } finally {
      setSavingConfig(false);
    }
  };

  const saveWorkflowAction = (action: "update" | "project" | "new") => {
    if (savingConfig || savingTask) return;
    setSaveConfigError("");
    if (action === "update") {
      const currentPreset = configPresets.find((preset) => preset.id === selectedPresetId);
      if (!currentPreset || currentPreset.builtin) {
        setSaveConfigError("系统默认配置不能覆盖更新，请选择另存为新配置");
        return;
      }
      setUpdateConfigConfirmOpen(true);
      return;
    }
    if (action === "new") {
      setNewConfigBlank(false);
      setNewConfigName(`${selectedPreset?.name ?? "Workflow"} 副本`);
      setNewConfigDialogOpen(true);
      return;
    }
    void performWorkflowSave(action);
  };

  const workflowSavedFlows = useMemo(() => configPresets.map((preset) => ({
    id: preset.id,
    name: preset.name,
    builtin: preset.builtin,
    agentCount: preset.orchestration.agents.length,
    pathCount: 1 + Object.values(preset.orchestration.routes ?? {}).reduce((total, routes) => total + routes.length, 0),
    updatedAt: preset.updatedAt
  })), [configPresets]);

  const renameWorkflowSavedFlow = async (id: string) => {
    const preset = configPresets.find((item) => item.id === id);
    if (!preset || preset.builtin) return;
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
      if (selectedPresetId === updated.id) setWorkflowName(updated.name);
      setSaveTaskNotice(`${updated.name} 已重命名`);
    } catch (reason) {
      setSaveConfigError(reason instanceof Error ? reason.message : "重命名配置失败");
    }
  };

  const deleteWorkflowSavedFlow = async (id: string) => {
    const preset = configPresets.find((item) => item.id === id);
    if (!preset || preset.builtin || !window.confirm(`确定删除配置“${preset.name}”吗？`)) return;
    try {
      await deleteAgentConfigPreset(id);
      const remaining = configPresets.filter((item) => item.id !== id);
      setConfigPresets(remaining);
      if (selectedPresetId === id) {
        const fallback = remaining.find((item) => item.id === "default") ?? remaining[0];
        setSelectedPresetId(fallback?.id ?? "default");
        const fallbackAgents = cloneAgentsConfig(fallback?.agents ?? DEFAULT_AGENTS);
        setAgents(fallback?.id === "default"
          ? applyCatalogDefaultGateway(
              applyCatalogDefaultHarness(fallbackAgents, harnesses, defaultHarnessId),
              defaultGatewayId,
              gateways
            )
          : applyCatalogDefaultHarness(fallbackAgents, harnesses, defaultHarnessId));
        setOrchestration(cloneAgentOrchestration(fallback?.orchestration ?? DEFAULT_AGENT_ORCHESTRATION));
        setSkillDefinitions(structuredClone(fallback?.skillDefinitions ?? {}));
        setMcpDefinitions(structuredClone(fallback?.mcpDefinitions ?? {}));
        setWorkflowName(fallback?.name ?? "未命名流程");
      }
    } catch (reason) {
      setSaveConfigError(reason instanceof Error ? reason.message : "删除配置失败");
    }
  };

  const openBlankWorkflowDialog = () => {
    setNewConfigBlank(true);
    setNewConfigName("新建 Workflow");
    setNewConfigDialogOpen(true);
  };

  const confirmLeave = () => {
    if (!touched) {
      onBack();
      return;
    }
    setLeaveDialogOpen(true);
  };

  const leaveAfterSave = async () => {
    const saved = await saveTaskCopy();
    if (!saved) return;
    setLeaveDialogOpen(false);
    onBack();
  };

  const discardAndLeave = () => {
    setLeaveDialogOpen(false);
    onBack();
  };

  const assistant = useExplainerDraftBridge({ active: active && !skillsLoading && !submitting && !savedTaskLoadError,
    key: savedTaskId ?? "new", taskId: editingTask?.id,
    draft: { title, requirement, agents, orchestration, git: { enabled: gitEnabled, ...(gitEnabled ? { provider: "github" as const,
      accountId: githubAccountId, repositoryName: gitRepositoryName, repositoryVisibility: gitRepositoryVisibility } : {}) },
      ...projectResourcesPayload(skillDefinitions, mcpDefinitions) },
    apply: (draft, taskId) => {
      setTitle(draft.title); setRequirement(draft.requirement); setAgents(cloneAgentsConfig(draft.agents));
      if (draft.orchestration) applyAssistantWorkflow(draft.orchestration);
      setSkillDefinitions(structuredClone(draft.skillDefinitions ?? {})); setMcpDefinitions(structuredClone(draft.mcpDefinitions ?? {}));
      setGitEnabled(draft.git?.enabled ?? false); setGithubAccountId(draft.git?.accountId);
      setGitRepositoryName(draft.git?.repositoryName ?? ""); setGitRepositoryVisibility(draft.git?.repositoryVisibility ?? "private");
      setSelectedPresetId("recommended"); setWorkflowName(draft.title || "助手配置");
      if (taskId) setEditingTask({ schemaVersion: 2, kind: "scienceevolve-saved-research-task", id: taskId,
        createdAt: editingTask?.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString(), ...draft,
        orchestration: draft.orchestration ?? orchestration });
    }
  });

  return (
    <main className="new-project-page">
      <div className="new-page-heading">
        <Button variant="ghost" icon={<ArrowLeft size={18} />} onClick={confirmLeave}>
          返回项目
        </Button>
        <div className="new-page-title">
          <span className="eyebrow">
            <WandSparkles size={15} />
            Create research
          </span>
          <h1>{savedTaskId ? "编辑已保存的科研任务" : "定义你的下一个科研课题"}</h1>
          <p>
            {savedTaskId
              ? "修改任务内容与完整 Agent 配置，保存后可从主页再次启动。"
              : "把研究意图说清楚，再按需编排任意数量与 Role 的智能体持续协作。"}
          </p>
        </div>
        <div className="new-page-actions">
          <Button
            type="button"
            variant="secondary"
            icon={<Save size={17} />}
            loading={savingTask}
            disabled={!canSaveDraft || savingConfig || Boolean(savedTaskLoadError)}
            onClick={() => void saveTaskCopy()}
          >
            保存课题
          </Button>
          <span className="draft-state">
            <span />
            {savedTaskId || editingTask ? "已保存任务" : "新项目"}
          </span>
          {saveTaskNotice && <small className="new-page-save-feedback">已保存到主页</small>}
          {saveTaskError && <small className="new-page-save-feedback is-error">保存失败，请查看下方提示</small>}
        </div>
      </div>

      <GatewayReference gateways={gateways} defaultGatewayId={defaultGatewayId} />

      <RecommendationProvider input={{ title, requirement, agents, orchestration, git: { enabled: gitEnabled } }}
        files={inputFiles} inputUploadId={inputUploadId} inputDescription={inputDescription}
        gateways={gateways} harnesses={harnesses} catalogVersion={JSON.stringify([availableSkills, mcpDirectory, mcpOptions])}
        disabled={!active || skillsLoading || savingTask || savingConfig || submitting || inputBusy || !!inputError || !!savedTaskLoadError || runtimeCatalogState !== "ready"}
        onApplyTools={(agentId, selection) => {
          setAgents(current => current[agentId] ? { ...current, [agentId]: { ...current[agentId], ...selection } } : current);
          setTouched(true);
        }}>
      <form onSubmit={submit} className="new-project-layout" noValidate>
        <div className="new-project-main">
          {savedTaskLoadError && (
            <ErrorPanel
              title="已保存科研任务加载失败"
              message={savedTaskLoadError}
            />
          )}
          <section className="form-section">
            <div className="form-section-head">
              <span className="section-number">01</span>
              <div>
                <h2>研究任务</h2>
                <p>一份清晰的任务说明会显著改善后续研究质量。</p>
              </div>
            </div>
            <div className="brief-fields">
              <label className="field field-large">
                <span>项目名称</span>
                <input
                  value={title}
                  onChange={(event) => {
                    setTitle(event.target.value);
                    setTouched(true);
                  }}
                  onBlur={() => setTouched(true)}
                  placeholder="例如：面向长文本推理的高效稀疏注意力机制"
                  aria-label="项目名称"
                  maxLength={120}
                  aria-invalid={touched && !titleValid}
                />
                {touched && !titleValid && (
                  <small className="field-error">请输入项目名称</small>
                )}
              </label>
              <label className="field field-large">
                <span>课题方向与具体要求</span>
                <textarea
                  value={requirement}
                  onChange={(event) => {
                    setRequirement(event.target.value);
                    setTouched(true);
                  }}
                  onBlur={() => setTouched(true)}
                  placeholder="描述研究背景、核心问题、可用数据、方法偏好、评价指标与期望成果。Idea Agent 会以此为起点形成研究方案…"
                  aria-label="课题方向与具体要求"
                  rows={8}
                  maxLength={8000}
                  aria-invalid={touched && !requirementValid}
                />
                <span className="textarea-meta">
                  {touched && !requirementValid ? (
                    <small className="field-error">请至少输入 10 个字符</small>
                  ) : (
                    <small>建议包含研究目标、约束和成功标准</small>
                  )}
                  <small>{requirementLength.toLocaleString()} / 8,000</small>
                </span>
              </label>
              <div className="project-inputs" aria-label="课题补充文件">
                <div>
                  <strong>补充文件与图片</strong>
                  <p>文件先放入本课题的临时 <code>user_inputs/</code>，创建时移入公共 workspace；项目内所有 Agent 均可读取。</p>
                </div>
                <div className="project-inputs-actions">
                  <button type="button" className="button button-secondary" onClick={() => projectFileInputRef.current?.click()} disabled={submitting || inputBusy}>选择文件或图片</button>
                  <button type="button" className="button button-secondary" onClick={() => projectFolderInputRef.current?.click()} disabled={submitting || inputBusy}>选择文件夹</button>
                  <button type="button" className="button button-secondary" onClick={() => void openInputsDirectory()} disabled={submitting || inputBusy}>打开目录</button>
                </div>
                <input ref={projectFileInputRef} className="project-inputs-picker" type="file" multiple aria-label="选择课题文件或图片" onChange={(event) => { void addInputFiles(event.target.files, false); event.target.value = ""; }} />
                <input ref={(input) => { projectFolderInputRef.current = input; if (input) input.setAttribute("webkitdirectory", ""); }} className="project-inputs-picker" type="file" multiple aria-label="选择课题文件夹" onChange={(event) => { void addInputFiles(event.target.files, true); event.target.value = ""; }} />
                {inputBusy && <small role="status">正在同步 user_inputs 文件…</small>}
                {inputError && <small className="field-error" role="alert">{inputError}</small>}
                {inputOpenError && <small className="field-error" role="alert">{inputOpenError}；可继续使用“选择文件或图片”或“选择文件夹”添加文件。</small>}
                {groupedInputs.length > 0 && <>
                  <ul className="project-inputs-list">{(showAllInputs ? groupedInputs : groupedInputs.slice(0, 5)).map((entry) => <li key={entry.key}>
                    {entry.folder && <Folder size={15} aria-hidden="true" />}
                    <span>{entry.name}{!entry.folder && /\.(?:png|jpe?g|gif|webp)$/i.test(entry.name) ? " · 图片" : ""}</span>
                    <small>{entry.folder ? `${entry.files.length} 个文件` : `${(entry.size / 1024).toFixed(1)} KiB`}</small>
                    <button type="button" aria-label={`移除 ${entry.name}`} onClick={() => void removeInputEntry(entry)} disabled={submitting || inputBusy}><X size={14} /></button>
                  </li>)}</ul>
                  {groupedInputs.length > 5 && <button type="button" className="project-inputs-expand" onClick={() => setShowAllInputs((value) => !value)}>{showAllInputs ? "收起文件列表" : `展开查看其余 ${groupedInputs.length - 5} 项`}</button>}
                </>}
                <label className="field">
                  <span>这些文件的用途（可选）</span>
                  <textarea value={inputDescription} onChange={(event) => setInputDescription(event.target.value)} placeholder="例如：参考图片用于界面风格；data/ 中的数据仅用于验证。" rows={2} maxLength={2000} disabled={submitting} />
                </label>
                <small>支持任意文件类型，包括图片；单文件 50 MiB，本次最多 1000 个文件、共 200 MiB。未创建课题的临时目录在 7 天无操作后清理。</small>
              </div>
              {assistant && <div className="config-recommendation"><Button type="button" variant="secondary" disabled={!active || skillsLoading || submitting}
                onClick={() => assistant.show("请结合当前课题与配置，帮我设计并优化整个 Workflow。可以先讨论要求，再直接修改草稿。") }><Sparkles size={16} />与助手设计 Workflow</Button>
                <small>与 Project Explainer 对话，修改会同步到文字版和画布。草稿由你查看后启动。</small></div>}
              <ConfigRecommendation
                key={savedTaskId ?? "new-task"}
                input={{ title, requirement, agents, orchestration, git: { enabled: gitEnabled } }}
                files={inputFiles}
                inputUploadId={inputUploadId}
                inputDescription={inputDescription}
                gateways={gateways}
                harnesses={harnesses}
                defaultGatewayId={defaultGatewayId}
                disabled={!active || skillsLoading || savingTask || savingConfig || submitting || inputBusy || !!inputError || !!savedTaskLoadError || runtimeCatalogState !== "ready"}
                recommendedApplied={selectedPresetId === "recommended"}
                onApply={(configuration) => {
                  setAgents(cloneAgentsConfig(configuration.agents));
                  setWorkflowOrchestration(configuration.orchestration);
                  setSelectedPresetId("recommended");
                  setWorkflowName("推荐配置");
                  setSaveTaskNotice("");
                }}
                onRestoreDefault={() => applyPreset("default")}
              />
            </div>
          </section>

          <section className="form-section">
            <div className="form-section-head">
              <span className="section-number">02</span>
              <div>
                <h2>Workflow</h2>
                <p>先查看 Workflow 缩略画布，再直接编辑独立的文字版编排。</p>
              </div>
            </div>
            <WorkflowCanvasEditor
              orchestration={orchestration}
              agents={agents}
              compact
              workflowName={workflowName}
              onWorkflowNameChange={setWorkflowName}
              savedFlows={workflowSavedFlows}
              skills={availableSkills}
              onAddSkill={addSkillCandidate}
              mcpOptions={mcpOptions}
              mcpDirectory={mcpDirectory}
              gateways={gateways}
              harnesses={harnesses}
              gitEnabled={gitEnabled}
              onGitEnabledChange={setGitMode}
              githubAccounts={githubAccounts}
              githubAccountId={githubAccountId}
              githubAccountsLoading={githubAccountsLoading}
              onGitHubAccountChange={(accountId) => { setGithubAccountId(accountId); setTouched(true); }}
              gitRepositoryName={gitRepositoryName}
              gitRepositoryVisibility={gitRepositoryVisibility}
              onGitRepositoryNameChange={(name) => { setGitRepositoryName(name); setTouched(true); }}
              onGitRepositoryVisibilityChange={(visibility) => { setGitRepositoryVisibility(visibility); setTouched(true); }}
              expandedGroupIds={expandedGroupIds}
              onExpandedGroupIdsChange={setExpandedGroupIds}
              activeSavedFlowId={selectedPresetId}
              onLoadSavedFlow={applyPreset}
              onRenameSavedFlow={(id) => void renameWorkflowSavedFlow(id)}
              onDeleteSavedFlow={(id) => void deleteWorkflowSavedFlow(id)}
              onCreateSavedFlow={openBlankWorkflowDialog}
              onSaveSavedFlow={(id) => { if (id === selectedPresetId) void performWorkflowSave("update"); }}
              onDownload={() => { if (selectedPreset) downloadAgentConfigPreset(selectedPreset); }}
              onOrchestrationChange={setWorkflowOrchestration}
              onAgentsChange={(value) => { setAgents((current) => applyCatalogDefaultHarnessToNewAgents(current, applyCatalogDefaultGatewayToNewAgents(current, value, defaultGatewayId, gateways), harnesses, defaultHarnessId)); setTouched(true); }}
              saveRevision={workflowSaveRevision}
              onOpenTextEditor={() => setCanvasEditorOpen(true)}
            />
            <div className="workflow-text-editor-section" aria-label="文字版 Workflow 编排">
              <div className="workflow-text-editor-heading">
                <span><FileText size={15} /> 文字版 Workflow 编排</span>
                <small>与上方缩略画布共享同一份编排数据</small>
                <button
                  type="button"
                  className="section-collapse-toggle"
                  aria-label={`${workflowDetailsExpanded ? "收起" : "展开"}文字版 Workflow 编排`}
                  aria-controls={workflowStructureId}
                  aria-expanded={workflowDetailsExpanded}
                  onClick={() => setWorkflowDetailsExpanded((expanded) => !expanded)}
                >
                  {workflowDetailsExpanded ? "收起详情" : "展开详情"}
                  <ChevronDown size={15} />
                </button>
              </div>
              <OrchestrationTemplateEditor
                value={orchestration}
                agents={agents}
                roleTemplates={defaultRoleTemplates}
                onChange={setWorkflowOrchestration}
                onAgentsChange={(value) => { setAgents((current) => applyCatalogDefaultHarnessToNewAgents(current, applyCatalogDefaultGatewayToNewAgents(current, value, defaultGatewayId, gateways), harnesses, defaultHarnessId)); setTouched(true); }}
                structureExpanded={workflowDetailsExpanded}
                structureId={workflowStructureId}
              />
            </div>
            {orchestrationError && (
              <div className="inline-warning orchestration-error">
                <CircleHelp size={16} />
                {orchestrationError}
              </div>
            )}
          </section>

          {canvasEditorOpen && (
            <div className="workflow-canvas-dialog" role="dialog" aria-modal="true" aria-label="编辑 Workflow 画布">
              <div className="workflow-canvas-dialog-backdrop" aria-hidden="true" />
              <div className="workflow-canvas-dialog-panel">
                <div className="workflow-canvas-dialog-head">
                  <div><strong>编辑 Workflow 画布</strong><small>完整画布界面仅用于画布及其自身操作。</small></div>
                  <button type="button" onClick={() => setCanvasEditorOpen(false)} aria-label="关闭 Workflow 编辑器"><X size={17} /></button>
                </div>
                <div className="workflow-canvas-dialog-scroll">
                  <WorkflowCanvasEditor
                    orchestration={orchestration}
                    agents={agents}
                    workflowName={workflowName}
                    onWorkflowNameChange={setWorkflowName}
                    savedFlows={workflowSavedFlows}
                    skills={availableSkills}
                    onAddSkill={addSkillCandidate}
                    mcpOptions={mcpOptions}
                    mcpDirectory={mcpDirectory}
                    gateways={gateways}
                    harnesses={harnesses}
                    gitEnabled={gitEnabled}
                    onGitEnabledChange={setGitMode}
                    githubAccounts={githubAccounts}
                    githubAccountId={githubAccountId}
                    githubAccountsLoading={githubAccountsLoading}
                    onGitHubAccountChange={(accountId) => { setGithubAccountId(accountId); setTouched(true); }}
                    gitRepositoryName={gitRepositoryName}
                    gitRepositoryVisibility={gitRepositoryVisibility}
                    onGitRepositoryNameChange={(name) => { setGitRepositoryName(name); setTouched(true); }}
                    onGitRepositoryVisibilityChange={(visibility) => { setGitRepositoryVisibility(visibility); setTouched(true); }}
                    expandedGroupIds={expandedGroupIds}
                    onExpandedGroupIdsChange={setExpandedGroupIds}
                    activeSavedFlowId={selectedPresetId}
                    onLoadSavedFlow={applyPreset}
                    onRenameSavedFlow={(id) => void renameWorkflowSavedFlow(id)}
                    onDeleteSavedFlow={(id) => void deleteWorkflowSavedFlow(id)}
                    onCreateSavedFlow={openBlankWorkflowDialog}
                    onSaveSavedFlow={(id) => { if (id === selectedPresetId) void performWorkflowSave("update"); }}
                    onDownload={() => { if (selectedPreset) downloadAgentConfigPreset(selectedPreset); }}
                    onOrchestrationChange={setWorkflowOrchestration}
                    onAgentsChange={(value) => { setAgents((current) => applyCatalogDefaultHarnessToNewAgents(current, applyCatalogDefaultGatewayToNewAgents(current, value, defaultGatewayId, gateways), harnesses, defaultHarnessId)); setTouched(true); }}
                    saveRevision={workflowSaveRevision}
                    onSave={() => { setCanvasEditorOpen(false); setSaveMenuOpen(true); }}
                    onClose={() => setCanvasEditorOpen(false)}
                    saving={savingConfig || savingTask}
                  />
                </div>
              </div>
            </div>
          )}

          <section className="form-section project-git-section">
            <div className="form-section-head">
              <span className="section-number">03</span>
              <div><h2 id="project-git-heading">Git 机制</h2><p>管理项目版本与研究产物；协作组需要先启用 Git。</p></div>
            </div>
            <label className={`git-opt-in-card ${gitEnabled ? "is-enabled" : ""}`}>
              <span><strong>启用 Git 机制</strong><small>{gitEnabled && gitRequiredByCollaborations ? "当前 Workflow 包含协作组，请先移除所有协作组再关闭 Git 机制。" : "使用 Git 管理代码与研究产物，支持独立 Agent 和协作组执行。"}</small></span>
              <input type="checkbox" role="switch" aria-label="启用 Git 机制" checked={gitEnabled} disabled={gitEnabled && gitRequiredByCollaborations} title={gitEnabled && gitRequiredByCollaborations ? "请先移除所有协作组再关闭 Git 机制" : undefined} onChange={(event) => setGitMode(event.target.checked)} />
              <b>{gitEnabled ? "已开启" : "未开启"}</b>
            </label>
            {gitEnabled && (
              <div className="parallel-git-dependency">
                <header><Layers3 size={15} /><span><strong>Git 仓库配置</strong><small>项目启动时创建仓库，用于版本记录和成果提交。</small></span><b>必需</b></header>
                <GitRepositorySettings
                  accounts={githubAccounts}
                  selectedAccountId={githubAccountId}
                  accountsLoading={githubAccountsLoading}
                  repositoryName={gitRepositoryName}
                  visibility={gitRepositoryVisibility}
                  onAccountChange={(accountId) => { setGithubAccountId(accountId); setTouched(true); }}
                  onRepositoryNameChange={(name) => { setGitRepositoryName(name); setTouched(true); }}
                  onVisibilityChange={(visibility) => { setGitRepositoryVisibility(visibility); setTouched(true); }}
                />
              </div>
            )}
            {gitEnabled && !githubAccountReady && !githubAccountsLoading && <div className="inline-warning" role="alert"><AlertTriangle size={16} />请选择一个授权正常的 GitHub 账号后再启动项目。</div>}
            {gitEnabled && repositoryNameError && <div className="inline-warning" role="alert"><AlertTriangle size={16} />{repositoryNameError}</div>}
            {gitRequiredByCollaborations && !gitEnabled && <div className="inline-warning" role="alert"><AlertTriangle size={16} />当前 Workflow 包含协作组，请先启用 Git 机制再保存或启动。</div>}
          </section>

          <section className="form-section">
            <div className={`form-section-head agent-formation-head${agentFormationExpanded ? "" : " is-collapsed"}`}>
              <span className="section-number">04</span>
              <div>
                <h2>智能体编队</h2>
                <p>每位智能体使用独立模型、Skills 与 MCP，配置会随项目固化。</p>
              </div>
              <span className="agent-count">
                {orchestration.agents.length} agents
              </span>
              <button
                type="button"
                className="section-collapse-toggle"
                aria-label={`${agentFormationExpanded ? "收起" : "展开"}智能体编队`}
                aria-controls={agentFormationId}
                aria-expanded={agentFormationExpanded}
                  onClick={() => { setAgentFormationMounted(true); setAgentFormationExpanded((expanded) => !expanded); }}
              >
                {agentFormationExpanded ? "收起配置" : "展开配置"}
                <ChevronDown size={15} />
              </button>
            </div>
            <div className="agent-formation-content" id={agentFormationId} hidden={!agentFormationExpanded}>
            {agentFormationMounted && <>
            <div className="config-preset-picker">
              <label>
                <span>
                  <Settings2 size={15} /> Workflow 配置
                </span>
                <select
                  value={selectedPresetId}
                  onChange={(event) => applyPreset(event.target.value)}
                  aria-label="新项目 Agent 配置"
                >
                  {selectedPresetId === "recommended" && <option value="recommended">推荐配置（未保存）</option>}
                  {editingTask && (
                    <option value="saved-task">已保存任务当前配置</option>
                  )}
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
              </label>
              <span>
                <strong>
                  {selectedPresetId === "saved-task"
                    ? "已保存任务当前配置"
                    : selectedPresetId === "recommended" ? "推荐配置（未保存）"
                    : selectedPreset?.name ?? "系统默认配置"}
                </strong>
                <small>
                  {selectedPresetId === "saved-task"
                    ? "包含该任务保存时的完整 Agent 配置"
                    : selectedPreset?.sourceProjectId
                    ? `导出自 ${selectedPreset.sourceProjectTitle ?? selectedPreset.sourceProjectId}`
                    : "使用当前 ScienceEvolve 默认 Prompt、Skills 与运行参数"}
                </small>
              </span>
            </div>
            {configPresetWarning && (
              <div className="inline-warning">
                <CircleHelp size={16} />
                Workflow 配置暂不可用：{configPresetWarning}。当前使用系统默认配置。
              </div>
            )}
            {skillsWarning && (
              <div className="inline-warning">
                <CircleHelp size={16} />
                Skills 暂时不可用：{skillsWarning}。仍可编辑并保存研究任务副本。
              </div>
            )}
            {runtimeConfigErrors.length > 0 && (
              <div className="inline-warning runtime-preflight-errors" role="alert">
                <AlertTriangle size={16} />
                <span>
                  <strong>启动前配置检查未通过</strong>
                  {runtimeConfigErrors.map((error) => <small key={error}>{error}</small>)}
                </span>
              </div>
            )}
            {runtimeConfigWarnings.length > 0 && (
              <div className="inline-warning runtime-preflight-warnings" role="alert">
                <AlertTriangle size={16} />
                <span>
                  <strong>网关连接验证未通过，允许启动</strong>
                  {runtimeConfigWarnings.map((warning) => <small key={warning}>{warning}</small>)}
                </span>
              </div>
            )}
            <div className="agent-config-list">
              {orchestration.agents.map((definition, index) => {
                const template = definition.template ?? "general";
                return <AgentConfigCard
                  agentName={definition.name}
                  template={template}
                  index={index}
                  config={agents[definition.name]}
                  models={models}
                  gateways={gateways}
                  harnesses={harnesses}
                  skills={availableSkills}
                  skillsLoading={skillsLoading}
                  defaultPrompt={
                    (isAgentTemplate(template)
                      ? agentPrompts[template]
                      : undefined) ??
                    "Carry out the bounded task assigned by the workflow and return an ordinary Worker handoff."
                  }
                  mainSystemPrompt={definition.name === "main" ? mainSystemPrompt : undefined}
                  onModelChange={(model) => updateModel(definition.name, model)}
                  onHarnessChange={(harness) => updateHarness(definition.name, harness)}
                  onGatewayChange={(gatewayId) => updateAgentGateway(definition.name, gatewayId)}
                  onGatewayReasoningOptionChange={(optionId) =>
                    updateGatewayReasoningOption(definition.name, optionId)
                  }
                  onTestConnection={testAgentConnection}
                  onPermissionChange={(permission) =>
                    updatePermission(definition.name, permission)
                  }
                  onWebSearchChange={(enabled) =>
                    updateWebSearch(definition.name, enabled)
                  }
                  onInstructionsChange={(instructions) =>
                    updateInstructions(definition.name, instructions)
                  }
                  onAddSkill={addSkillCandidate}
                  onSetSkillMode={(skillId, mode) =>
                    setSkillMode(definition.name, skillId, mode)
                  }
                  mcpOptions={mcpOptions}
                  mcpDirectory={mcpDirectory}
                  onAddMcp={(name, url) =>
                    addMcpForRole(definition.name, name, url)
                  }
                  onToggleMcp={(server, enabled) =>
                    toggleMcpForRole(definition.name, server, enabled)
                  }
                  onExperimentMcpChange={(experimentMcp) => {
                    setTouched(true);
                    setAgents((current) => ({ ...current,
                      [definition.name]: { ...current[definition.name], experimentMcp }
                    }));
                  }}
                  key={definition.name}
                />;
              })}
            </div>
            </>}
            </div>
          </section>

          {submitError && <ErrorPanel title="项目启动失败" message={submitError} />}
          {!submitError && runtimeCatalogBlocker && (
            <div className="inline-warning" role={runtimeCatalogState === "loading" ? "status" : "alert"}>
              {runtimeCatalogBlocker} 仍可保存研究任务副本，稍后再启动。
            </div>
          )}
          {saveTaskError && (
            <ErrorPanel title="研究任务副本保存失败" message={saveTaskError} />
          )}
          {saveTaskNotice && (
            <div className="saved-task-form-notice" role="status">
              <Check size={16} /> {saveTaskNotice}
            </div>
          )}

          <div className="create-footer">
            <div className="create-summary">
              <ShieldCheck size={19} />
              <span>
                创建后首先启动{" "}
                <strong>{orchestration.input.target} 外层节点</strong>
                <small>后续调用由当前 Workflow 编排控制</small>
              </span>
            </div>
            <div className="create-footer-actions">
              <div className="workflow-save-menu-wrap">
                <Button
                  type="button"
                  variant="secondary"
                  icon={<Save size={17} />}
                  loading={savingConfig || savingTask}
                  disabled={!canSaveDraft || Boolean(savedTaskLoadError)}
                  onClick={() => setSaveMenuOpen((open) => !open)}
                  aria-haspopup="menu"
                  aria-expanded={saveMenuOpen}
                >
                  保存
                </Button>
                {saveMenuOpen && <div className="workflow-save-menu" role="menu">
                  <button type="button" role="menuitem" disabled={!selectedPreset || selectedPreset.builtin} onClick={() => void saveWorkflowAction("update")}><strong>更新当前配置</strong><small>{selectedPreset?.builtin ? "系统默认配置不可覆盖" : "覆盖当前可复用 Workflow 配置"}</small></button>
                  <button type="button" role="menuitem" onClick={() => void saveWorkflowAction("project")}><strong>仅本次项目使用</strong><small>保存当前项目副本，不修改配置库</small></button>
                  <button type="button" role="menuitem" onClick={() => void saveWorkflowAction("new")}><strong>另存为新配置</strong><small>创建可复用配置并切换到它</small></button>
                </div>}
              </div>
              <Button
                type="submit"
                variant="primary"
                icon={<Rocket size={18} />}
                loading={submitting}
                disabled={savingTask || savingConfig}
                className="create-button"
              >
                创建并启动研究
              </Button>
            </div>
          </div>
          {saveConfigError && <div className="inline-warning" role="alert">{saveConfigError}</div>}
        </div>

        <aside className="new-project-aside">
          <div className="aside-card workflow-preview">
            <span className="aside-label">自动工作流</span>
            <h3>按当前编排持续运行</h3>
            <div className="mini-flow">
              <div><span>1</span><strong>Input</strong><small>用户需求</small></div>
              <ArrowRight size={15} />
              <div><span>2</span><strong>{orchestration.input.target}</strong><small>首个 Agent</small></div>
              <ArrowRight size={15} />
              <div><span>3</span><strong>Loop</strong><small>配置路由</small></div>
            </div>
            <div className="review-gate">
              <ShieldCheck size={18} />
              <span>
                <strong>{orchestration.termination.agent} · {orchestration.termination.condition}</strong>
                <small>
                  所有 finish 候选都由 main 根据自然语言条件和全局证据判断是否结束
                </small>
              </span>
            </div>
          </div>

          <div className="aside-card config-overview">
            <span className="aside-label">当前配置</span>
            <div>
              <span><Sparkles size={16} /> 智能体</span>
              <strong>
                {orchestration.agents.length}
              </strong>
            </div>
            <div>
              <span><Cpu size={16} /> 模型</span>
              <strong>
                {new Set(orchestration.agents.map((entry) => agents[entry.name].model)).size}
              </strong>
            </div>
            <div>
              <span><Layers3 size={16} /> Skills</span>
              <strong>{configuredSkillCount}</strong>
            </div>
            <div>
              <span><Cable size={16} /> MCP</span>
              <strong>{mcpOptions.length}</strong>
            </div>
            <div>
              <span><Globe2 size={16} /> 全局网关</span>
              <strong>{gateways.length}{defaultGatewayId ? " · 已设默认" : ""}</strong>
            </div>
          </div>

          <div className="aside-tip">
            <Lightbulb size={18} />
            <p>
              <strong>写好任务说明</strong>
              提供数据来源、基线与评价指标，能帮助执行智能体更快形成可验证结果。
            </p>
          </div>

          <div className="aside-card output-note">
            <FileText size={18} />
            <span>
              <strong>共享工作区留痕</strong>
              <small>Agent 通过 Markdown 交接，文件直接保存在各自的共享工作区。</small>
            </span>
          </div>
        </aside>
      </form>
      </RecommendationProvider>
      {updateConfigConfirmOpen && (
        <div className="workflow-modal-backdrop" role="presentation">
          <section className="workflow-modal" role="dialog" aria-modal="true" aria-labelledby="workflow-update-heading">
            <div className="workflow-modal-heading">
              <span className="workflow-modal-icon"><AlertTriangle size={18} /></span>
              <div>
                <strong id="workflow-update-heading">覆盖 Workflow 配置？</strong>
                <p>这会永久更新“{selectedPreset?.name ?? "当前配置"}”，可能影响之后载入它的新项目。已经启动的项目不会改变。</p>
              </div>
            </div>
            <div className="workflow-modal-actions">
              <button type="button" onClick={() => setUpdateConfigConfirmOpen(false)}>取消</button>
              <button type="button" className="primary" onClick={() => { setUpdateConfigConfirmOpen(false); void performWorkflowSave("update"); }}>确认更新</button>
            </div>
          </section>
        </div>
      )}
      {newConfigDialogOpen && (
        <div className="workflow-modal-backdrop" role="presentation">
          <section className="workflow-modal" role="dialog" aria-modal="true" aria-labelledby="workflow-new-heading">
            <div className="workflow-modal-heading">
              <span className="workflow-modal-icon"><Save size={18} /></span>
              <div>
                <strong id="workflow-new-heading">另存为新 Workflow 配置</strong>
                <p>创建新的可复用配置，当前编辑会自动切换到新配置。</p>
              </div>
            </div>
            <label className="workflow-modal-field">
              <span>Workflow 配置名称</span>
              <input value={newConfigName} onChange={(event) => setNewConfigName(event.target.value)} autoFocus maxLength={160} aria-label="Workflow 配置名称" />
            </label>
            <div className="workflow-modal-actions">
              <button type="button" onClick={() => { setNewConfigDialogOpen(false); setNewConfigBlank(false); }}>取消</button>
              <button type="button" className="primary" disabled={!newConfigName.trim()} onClick={() => { const name = newConfigName.trim(); setNewConfigDialogOpen(false); void performWorkflowSave("new", name); }}>保存新配置</button>
            </div>
          </section>
        </div>
      )}
      {leaveDialogOpen && (
        <div className="workflow-modal-backdrop" role="presentation">
          <section className="workflow-modal" role="dialog" aria-modal="true" aria-labelledby="workflow-leave-heading">
            <div className="workflow-modal-heading">
              <span className="workflow-modal-icon"><AlertTriangle size={18} /></span>
              <div>
                <strong id="workflow-leave-heading">存在未保存修改</strong>
                <p>离开当前课题前选择如何处理本次 Workflow 和研究需求修改。</p>
              </div>
            </div>
            <div className="workflow-modal-actions workflow-leave-actions">
              <button type="button" onClick={() => setLeaveDialogOpen(false)} disabled={savingTask}>取消</button>
              <button type="button" className="danger" onClick={discardAndLeave} disabled={savingTask}>放弃修改并离开</button>
              <button type="button" className="primary" onClick={() => void leaveAfterSave()} disabled={savingTask || !canSaveDraft}>{savingTask ? "保存中…" : "保存并离开"}</button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
