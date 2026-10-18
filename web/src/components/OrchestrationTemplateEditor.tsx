import {
  ArrowRight,
  CircleHelp,
  Flag,
  GitBranch,
  LogIn,
  Plus,
  Sparkles,
  Trash2,
  Users,
  X
} from "lucide-react";
import { useMemo, useState } from "react";
import {
  agentMeta,
  cloneAgentOrchestration,
  cloneAgentsConfig,
  defaultAgentConfig,
  defaultDecisionPlan,
  isAgentIdentifier
} from "../lib";
import type {
  AgentConfig,
  AgentName,
  AgentOrchestrationTemplate,
  AgentTemplate,
  AgentsConfig,
  WorkflowEdge
} from "../types";
import {
  collaborationForAgent,
  syncMainOuterRoutes,
  workflowOuterNodes
} from "./workflow-canvas/core/workflow-nodes";

const NEW_TEMPLATE = "__new_template__";
const RESULT_FORMAT_PRESETS = ["论文", "代码", "Markdown 文件", "图片", "表格", "其他"] as const;

function routeEdgesFor(
  template: AgentOrchestrationTemplate,
  source: AgentName
): WorkflowEdge[] {
  const outerNodes = workflowOuterNodes(template);
  if (source === "main") {
    return outerNodes
      .map((definition) => definition.id)
      .filter((name) => name !== "main")
      .map((target) => ({ target, kind: "weak" as const }));
  }
  const fallback = () => {
    const candidates = outerNodes
      .map((definition) => definition.id)
      .filter((name) => name !== source)
      .map((target) => ({ target, kind: "weak" as const }));
    if (source === template.termination.agent) {
      candidates.push({ target: "finish", kind: "weak" });
    }
    return candidates;
  };
  const explicit = template.routes?.[source];
  if (Array.isArray(explicit)) {
    const visible = explicit.filter(
      (edge) =>
        edge.target === "finish" ||
        outerNodes.some((definition) => definition.id === edge.target)
    );
    return visible.map((edge) => ({ ...edge }));
  }
  return fallback();
}

function writeRouteEdges(
  template: AgentOrchestrationTemplate,
  source: AgentName,
  edges: WorkflowEdge[]
): void {
  template.routes ??= {};
  template.routes[source] = source === "main"
    ? workflowOuterNodes(template)
        .map((definition) => definition.id)
        .filter((name) => name !== "main")
        .map((target) => ({ target, kind: "weak" as const }))
    : edges.map((edge) => ({ ...edge }));
}

function syncMainRoutes(template: AgentOrchestrationTemplate): void {
  syncMainOuterRoutes(template);
}

export function OrchestrationTemplateEditor({
  value,
  agents,
  roleTemplates,
  onChange,
  onAgentsChange,
  compact = false,
  structureExpanded = true,
  structureId
}: {
  value: AgentOrchestrationTemplate;
  agents: AgentsConfig;
  roleTemplates?: Partial<Record<AgentTemplate, AgentConfig>>;
  onChange: (value: AgentOrchestrationTemplate) => void;
  onAgentsChange: (value: AgentsConfig) => void;
  compact?: boolean;
  structureExpanded?: boolean;
  structureId?: string;
}) {
  const [newAgentName, setNewAgentName] = useState("");
  const [selectedTemplate, setSelectedTemplate] = useState("");
  const [addError, setAddError] = useState("");
  const availableTemplates = useMemo<AgentTemplate[]>(
    () => [
      ...new Set([
        "general",
        "idea",
        "execution",
        "writing",
        "review",
        ...value.agents.map((definition) => definition.template ?? "general")
      ])
    ] as AgentTemplate[],
    [value.agents]
  );
  const templateChoice =
    selectedTemplate === NEW_TEMPLATE || availableTemplates.includes(selectedTemplate as AgentTemplate)
      ? selectedTemplate
      : availableTemplates.find((template) => template !== "main") || NEW_TEMPLATE;
  const terminationEdges = routeEdgesFor(value, value.termination.agent);
  const hasDirectFinishRoute =
    terminationEdges.length === 1 && terminationEdges[0]?.target === "finish";
  const resultFormat = {
    presets: Array.isArray(value.resultFormat?.presets) ? value.resultFormat.presets : [],
    custom: typeof value.resultFormat?.custom === "string" ? value.resultFormat.custom : "",
    ...(value.resultFormat?.none === true ? { none: true } : {})
  };

  const commit = (
    update: (draft: AgentOrchestrationTemplate) => void
  ) => {
    const draft = cloneAgentOrchestration(value);
    update(draft);
    onChange(draft);
  };

  const addAgent = () => {
    const name = newAgentName.trim();
    if (!isAgentIdentifier(name)) {
      setAddError("Name 只能包含字母、数字、下划线和连字符，最长 64 个字符。");
      return;
    }
    if (["input", "finish", "user"].includes(name) || name === "main") {
      setAddError(name === "main" ? "精确名称 main 已由系统固定提供，不能重复创建。" : "不能使用系统保留名称作为 Agent name。");
      return;
    }
    if (
      value.agents.some(
        (definition) =>
          definition.name === name
      ) || (value.collaborations ?? []).some((group) => group.id === name)
    ) {
      setAddError("Agent name 必须唯一。");
      return;
    }
    const template: AgentTemplate = templateChoice === NEW_TEMPLATE
      ? "general"
      : (templateChoice as AgentTemplate);
    const sourceConfig = roleTemplates?.[template];
    const nextAgents = cloneAgentsConfig(agents);
    nextAgents[name] = sourceConfig
      ? cloneAgentsConfig({ source: sourceConfig }).source
      : defaultAgentConfig(name, template);
    const nextTemplate = cloneAgentOrchestration(value);
    nextTemplate.agents.push({ name, template });
    if (nextTemplate.schemaVersion === 3 && nextTemplate.scopedWorkflow) nextTemplate.scopedWorkflow.rootAgentIds.push(name);
    const directTarget = nextTemplate.agents.find(
      (definition) => definition.name !== name && definition.name === "main"
    )?.name ?? nextTemplate.agents.find((definition) => definition.name !== name)?.name;
    if (directTarget) {
      writeRouteEdges(nextTemplate, name, [{ target: directTarget, kind: "strong" }]);
    }
    syncMainRoutes(nextTemplate);
    nextTemplate.decisionPlans[name] = defaultDecisionPlan(name);
    onAgentsChange(nextAgents);
    onChange(nextTemplate);
    setNewAgentName("");
    setAddError("");
  };

  const removeAgent = (name: AgentName) => {
    if (name === "main") return;
    if (collaborationForAgent(value, name)) return;
    if (!window.confirm(`确定删除 Agent “${name}”吗？\n\n相关配置、出边和其他 Agent 指向它的入边都会一并删除。`)) {
      return;
    }
    const nextTemplate = cloneAgentOrchestration(value);
    nextTemplate.agents = nextTemplate.agents.filter(
      (definition) => definition.name !== name
    );
    delete nextTemplate.routes?.[name];
    delete nextTemplate.decisionPlans[name];
    for (const definition of workflowOuterNodes(nextTemplate)) {
      const edges = routeEdgesFor(nextTemplate, definition.id).filter(
        (edge) => edge.target !== name
      );
      writeRouteEdges(nextTemplate, definition.id, edges);
    }
    if (nextTemplate.input.target === name) nextTemplate.input.target = nextTemplate.agents[0]?.name ?? "main";
    if (nextTemplate.termination.agent === name) {
      nextTemplate.termination.agent =
        nextTemplate.agents.find((definition) => definition.template === "review")
          ?.name ?? nextTemplate.agents[0]?.name ?? "main";
      if (nextTemplate.termination.agent !== "main") {
        const terminationEdges = routeEdgesFor(
          nextTemplate,
          nextTemplate.termination.agent
        ).filter((edge) => edge.target !== "finish");
        writeRouteEdges(nextTemplate, nextTemplate.termination.agent, [
          ...terminationEdges.map((edge) => ({ ...edge, kind: "weak" as const })),
          { target: "finish", kind: "weak" }
        ]);
      }
    }
    syncMainRoutes(nextTemplate);
    const nextAgents = cloneAgentsConfig(agents);
    delete nextAgents[name];
    onAgentsChange(nextAgents);
    onChange(nextTemplate);
  };

  const agentOption = (name: AgentName) => {
    const outer = workflowOuterNodes(value).find((entry) => entry.id === name);
    if (outer?.collaboration) return `${outer.displayName} · 协作组`;
    return `${name} · ${outer?.definition?.template ?? "general"}`;
  };

  return (
    <div className={`orchestration-editor${compact ? " compact" : ""}`}>
      <div className="orchestration-structure" id={structureId} hidden={!structureExpanded}>
      {structureExpanded && <>
      <section className="orchestration-part">
        <div className="orchestration-part-title">
          <Users size={16} />
          <span>
            <strong>Agent name 与模板</strong>
            <small>每个 Agent 数量固定为 1；模板只提供初始 Prompt 与 Skills 的初始配置。</small>
          </span>
        </div>
        <div className="orchestration-agent-list">
          {value.agents.map((definition) => {
            const role = definition.template ?? "general";
            const meta = agentMeta(definition.name, role);
            const collaboration = collaborationForAgent(value, definition.name);
            return (
              <div className="orchestration-agent-row" key={definition.name}>
                <span className={`agent-dot agent-${meta.color}`} />
                <label>
                  <small>Agent name</small>
                  <strong>{definition.name}</strong>
                </label>
                <label>
                  <small>模板</small>
                  <span>{definition.template ?? "general"}</span>
                </label>
                <label>
                  <small>数量</small>
                  <span>1</span>
                </label>
                {definition.name === "main" ? (
                  <span className="orchestration-main-lock">必需且不可删除</span>
                ) : collaboration ? (
                  <span className="orchestration-main-lock">{collaboration.displayName} 成员</span>
                ) : (
                  <button
                    type="button"
                    className="icon-button danger"
                    onClick={() => removeAgent(definition.name)}
                    aria-label={`删除 ${definition.name}`}
                    title="删除 Agent"
                  >
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <div className="orchestration-add-agent">
          <label>
            <span>新 Agent name</span>
            <input
              value={newAgentName}
              onChange={(event) => {
                setNewAgentName(event.target.value);
                setAddError("");
              }}
              placeholder="例如 verifier"
              maxLength={64}
              aria-label="新 Agent name"
            />
          </label>
          <label>
            <span>模板来源</span>
            <select
              value={templateChoice}
              onChange={(event) => setSelectedTemplate(event.target.value)}
              aria-label="新 Agent 模板"
            >
              {availableTemplates
                .filter((template) => template !== "main")
                .map((template) => (
                  <option value={template} key={template}>
                    使用模板：{template}
                  </option>
                ))}
              <option value={NEW_TEMPLATE}>新建通用模板（仅使用 Agent name）</option>
            </select>
          </label>
          <button type="button" className="secondary-button" onClick={addAgent}>
            <Plus size={15} />
            添加 Agent
          </button>
        </div>
        {templateChoice === NEW_TEMPLATE && newAgentName.trim() && (
          <small className="orchestration-new-role-hint">
            将创建通用 Worker <code>{newAgentName.trim()}</code>，默认使用统一 Worker Prompt。
          </small>
        )}
        {addError && <div className="inline-warning orchestration-error">{addError}</div>}
      </section>

      <section className="orchestration-part">
        <div className="orchestration-part-title">
          <LogIn size={16} />
          <span>
            <strong>输入</strong>
            <small>原始用户需求首先交给哪个 Agent name。</small>
          </span>
        </div>
        <div className="orchestration-route-row">
          <code>input</code>
          <span>→</span>
          <select
            value={value.input.target}
            onChange={(event) =>
              commit((draft) => {
                draft.input.target = event.target.value;
              })
            }
            aria-label="输入目标外层节点"
          >
            {workflowOuterNodes(value).map((definition) => (
              <option value={definition.id} key={definition.id}>
                {agentOption(definition.id)}
              </option>
            ))}
          </select>
        </div>
      </section>

      <section className="orchestration-part">
        <div className="orchestration-part-title">
          <GitBranch size={16} />
          <span>
            <strong>有向工作流出边</strong>
            <small>为每个 Agent 配置下一站。强边直接跳转，弱边保留候选，流程会结合上下文继续。</small>
          </span>
        </div>
        <div className="orchestration-route-legend" aria-label="出边类型说明">
          <span className="orchestration-route-legend-item strong">
            <i />
            <strong>强边</strong>
            <small>直接跳转</small>
          </span>
          <span className="orchestration-route-legend-item weak">
            <i />
            <strong>弱边</strong>
            <small>保留候选，按上下文继续</small>
          </span>
          <span className="orchestration-route-legend-note">
            <Sparkles size={13} />
            不会并行执行
          </span>
        </div>
        <div className="orchestration-route-board">
          {workflowOuterNodes(value).map((definition) => {
            const edges = routeEdgesFor(value, definition.id);
            const role = definition.definition?.template ?? "general";
            const meta = agentMeta(definition.id, role);
            const displayName = definition.collaboration
              ? definition.displayName
              : meta.name;
            const isMain = definition.id === "main";
            const hasChoice = edges.length > 1;
            return (
              <article
                className={`orchestration-route-card${hasChoice ? " has-choice" : ""}${isMain ? " fixed-main-routes" : ""}`}
                key={definition.id}
              >
                <header className="orchestration-route-card-head">
                  <div className="orchestration-route-source">
                    <span className={`orchestration-route-source-icon agent-${meta.color}`}>
                      <GitBranch size={15} />
                    </span>
                    <div>
                      <div className="orchestration-route-source-line">
                        <strong>{displayName}</strong>
                        <span className={`agent-badge subtle agent-${meta.color}`}>
                          {definition.kind === "collaboration" ? "collaboration" : definition.definition?.template ?? "general"}
                        </span>
                      </div>
                      <small>{definition.collaboration ? `${definition.collaboration.memberAgentIds.length} 名成员：${definition.collaboration.memberAgentIds.join("、")}` : meta.description}</small>
                    </div>
                  </div>
                  <span className={`orchestration-route-mode${hasChoice ? " choice" : " direct"}`}>
                    {hasChoice ? <Sparkles size={13} /> : <ArrowRight size={13} />}
                    {isMain ? "固定弱边" : hasChoice ? "候选路径" : "直接跳转"}
                  </span>
                </header>
                {isMain && edges.length === 0 && (
                  <div className="orchestration-empty-main-routes" role="status">
                    当前没有其他外层节点，Main 的固定路由为空。
                  </div>
                )}
                <div className="orchestration-edge-list">
                  {edges.map((edge, edgeIndex) => (
                    <div
                      className={`orchestration-edge-row ${edge.kind}`}
                      key={`${definition.id}-${edgeIndex}`}
                    >
                      <span className="orchestration-edge-index">
                        {String(edgeIndex + 1).padStart(2, "0")}
                      </span>
                      <span className="orchestration-edge-connector" aria-hidden="true">
                        <ArrowRight size={15} />
                      </span>
                      <label className="orchestration-edge-field target">
                        <span>下一站</span>
                        <select
                          value={edge.target}
                          disabled={isMain}
                          onChange={(event) =>
                            commit((draft) => {
                              const nextEdges = routeEdgesFor(draft, definition.id);
                              nextEdges[edgeIndex] = {
                                ...nextEdges[edgeIndex]!,
                                target: event.target.value
                              } as WorkflowEdge;
                              writeRouteEdges(draft, definition.id, nextEdges);
                            })
                          }
                          aria-label={`${displayName}第 ${edgeIndex + 1} 条出边目标`}
                        >
                          {workflowOuterNodes(value)
                            .filter((target) => target.id !== definition.id)
                            .map((target) => (
                              <option value={target.id} key={target.id}>
                                {agentOption(target.id)}
                              </option>
                            ))}
                          {definition.id === value.termination.agent && (
                            <option value="finish">finish（交由 Main 判断是否结束）</option>
                          )}
                        </select>
                      </label>
                      <label className="orchestration-edge-field kind">
                        <span>路由类型</span>
                        <select
                          value={edge.kind}
                          disabled={isMain}
                          onChange={(event) =>
                            commit((draft) => {
                              const nextEdges = routeEdgesFor(draft, definition.id);
                              const nextKind = event.target.value as WorkflowEdge["kind"];
                              if (nextKind === "strong") {
                                writeRouteEdges(draft, definition.id, [
                                  { ...nextEdges[edgeIndex]!, kind: "strong" }
                                ]);
                              } else {
                                nextEdges[edgeIndex] = {
                                  ...nextEdges[edgeIndex]!,
                                  kind: "weak"
                                };
                                writeRouteEdges(draft, definition.id, nextEdges);
                              }
                            })
                          }
                          aria-label={`${displayName}第 ${edgeIndex + 1} 条出边类型`}
                        >
                          <option value="strong">强边 · 直接跳转</option>
                          <option value="weak">弱边 · 保留候选</option>
                        </select>
                      </label>
                      <button
                        type="button"
                        className="icon-button danger orchestration-remove-edge"
                        disabled={
                          isMain ||
                          edges.length <= 1 ||
                          (edge.target === "finish" && definition.id === value.termination.agent)
                        }
                        onClick={() =>
                          commit((draft) => {
                            const nextEdges = routeEdgesFor(draft, definition.id);
                            nextEdges.splice(edgeIndex, 1);
                            writeRouteEdges(draft, definition.id, nextEdges);
                          })
                        }
                        aria-label={`删除 ${displayName} 第 ${edgeIndex + 1} 条出边`}
                        title="删除出边"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ))}
                </div>
                <div className="orchestration-route-actions">
                  <button
                    type="button"
                    className="secondary-button orchestration-add-edge"
                    disabled={isMain}
                    onClick={() =>
                      commit((draft) => {
                        let nextEdges = routeEdgesFor(draft, definition.id);
                        const fallback = workflowOuterNodes(draft).find(
                          (target) =>
                            target.id !== definition.id &&
                            !nextEdges.some((edge) => edge.target === target.id)
                        )?.id;
                        if (!fallback) return;
                        if (nextEdges.some((edge) => edge.kind === "strong")) {
                          nextEdges = nextEdges.map((edge) => ({
                            ...edge,
                            kind: "weak" as const
                          }));
                        }
                        nextEdges.push({ target: fallback, kind: "weak" });
                        writeRouteEdges(draft, definition.id, nextEdges);
                      })
                    }
                  >
                    <Plus size={13} /> {isMain ? "固定连接全部外层节点" : "添加弱边"}
                  </button>
                  <small>{isMain ? "系统同步，不允许用户编辑" : `${edges.length} 条出边`}</small>
                </div>
                {!isMain && <label className="orchestration-decision-plan">
                  <span>
                    <Sparkles size={13} />
                    路径判断提示
                    <em>可选</em>
                  </span>
                  <textarea
                    value={value.decisionPlans[definition.id] ?? ""}
                    onChange={(event) =>
                      commit((draft) => {
                        draft.decisionPlans[definition.id] = event.target.value;
                      })
                    }
                    rows={2}
                    maxLength={4000}
                    placeholder="描述多个候选之间的选择依据，或补充该节点的判断重点"
                    aria-label={`${displayName} 路径判断提示`}
                  />
                </label>}
              </article>
            );
          })}
        </div>
      </section>

      </>}
      </div>
      <section className="orchestration-part">
        <div className="orchestration-part-title">
          <Flag size={16} />
          <span>
            <strong>终止条件</strong>
                    <small>可使用自然语言描述；只有与其他弱边并存时，流程才会按此条件选择是否结束。</small>
          </span>
        </div>
        <div className="orchestration-termination-grid">
          <label>
            <span>终止条件 Agent</span>
            <select
              value={value.termination.agent}
              onChange={(event) =>
                commit((draft) => {
                  const nextTerminationAgent = event.target.value;
                  const previousTerminationAgent = draft.termination.agent;
                  // `finish` belongs to exactly one node. Move that edge when
                  // the user changes the termination Agent and keep the old
                  // node runnable instead of leaving an invalid dangling route.
                  for (const definition of workflowOuterNodes(draft)) {
                    const edges = routeEdgesFor(draft, definition.id).filter(
                      (edge) =>
                        edge.target !== "finish" ||
                        definition.id === nextTerminationAgent
                    );
                    if (
                      definition.id === previousTerminationAgent &&
                      definition.id !== nextTerminationAgent &&
                      edges.length === 0
                    ) {
                      const fallback = workflowOuterNodes(draft).find(
                        (candidate) => candidate.id !== definition.id
                      )?.id;
                      if (fallback) edges.push({ target: fallback, kind: "strong" });
                    }
                    writeRouteEdges(draft, definition.id, edges);
                  }
                  const terminationEdges = routeEdgesFor(
                    draft,
                    nextTerminationAgent
                  ).filter((edge) => edge.target !== "finish");
                  writeRouteEdges(draft, nextTerminationAgent, [
                    ...(nextTerminationAgent === "main"
                      ? []
                      : [
                          ...terminationEdges.map((edge) => ({
                            ...edge,
                            kind: "weak" as const
                          })),
                          { target: "finish", kind: "weak" as const }
                        ])
                  ]);
                  syncMainRoutes(draft);
                  draft.termination.agent = nextTerminationAgent;
                  if (nextTerminationAgent === "main") {
                    draft.termination.automatic = false;
                  }
                })
              }
              aria-label="终止外层节点"
            >
              {workflowOuterNodes(value).map((definition) => (
                <option value={definition.id} key={definition.id}>
                  {agentOption(definition.id)}
                </option>
              ))}
            </select>
          </label>
          <label className="orchestration-condition-field">
            <span>条件</span>
            <textarea
              value={value.termination.condition}
              onChange={(event) =>
                commit((draft) => {
                  draft.termination.condition = event.target.value;
                })
              }
              placeholder="例如：论文达到可投稿标准，且关键实验均已完成"
              maxLength={4_000}
              rows={3}
              aria-label="终止条件"
            />
          </label>
          <label>
            <span>结束判断</span>
            <select value={value.termination.automatic ? "agent" : "main"} disabled aria-label="结束判断方式">
              <option value="main">由 Main 判断</option>
              <option value="agent">终止 Agent 可直接完成</option>
            </select>
          </label>
          <div className="orchestration-automatic-field">
            <label className="agent-binary-toggle">
              <input
                type="checkbox"
                checked={value.termination.automatic === true}
                disabled={value.termination.agent === "main"}
                onChange={(event) => commit((draft) => {
                  draft.termination.automatic = event.target.checked;
                })}
                aria-label="允许终止 Agent 自动完成"
              />
              <i aria-hidden="true" />
              <strong>{value.termination.automatic ? "允许自动完成" : "由 Main 验收"}</strong>
            </label>
            <small>
              {value.termination.agent === "main"
                ? "Main 作为终止 Agent 时始终由 Main 完成，自动终止开关不适用。"
                : value.termination.automatic
                  ? "高风险：该 Agent 可根据自然语言条件直接选择结果并完成项目；它不会获得通用路由、请求用户或动态重配置权限。"
                  : hasDirectFinishRoute
                    ? "Agent 完成后仍回到 Main，由 Main 根据条件决定结束或继续。"
                    : "Main 会在 finish 与其他弱边之间按自然语言条件选择。"}
            </small>
          </div>
        </div>
        <div className="orchestration-result-format">
          <div className="orchestration-result-format-heading">
            <span>结果形式</span>
            <small>可多选常用形式，也可以只填写自然语言补充要求；不会强制扩展名、数量或生成工具。</small>
          </div>
          <div className="result-format-presets" role="group" aria-label="常用结果形式">
            {RESULT_FORMAT_PRESETS.map((preset) => {
              const checked = resultFormat.presets.includes(preset);
              return (
                <label className={`result-format-option${checked ? " selected" : ""}`} key={preset}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => commit((draft) => {
                      const current = draft.resultFormat ?? { presets: [], custom: "" };
                      const currentPresets = Array.isArray(current.presets)
                        ? current.presets
                        : [];
                      draft.resultFormat = {
                        ...current,
                        none: undefined,
                        presets: currentPresets.includes(preset)
                          ? currentPresets.filter((item) => item !== preset)
                          : [...currentPresets, preset]
                      };
                    })}
                    aria-label={`结果形式：${preset}`}
                  />
                  <span>{preset}</span>
                </label>
              );
            })}
          </div>
          <label className={`result-format-option${resultFormat.none ? " selected" : ""}`}>
            <input
              type="checkbox"
              checked={resultFormat.none === true}
              onChange={(event) => commit((draft) => {
                const current = draft.resultFormat ?? { presets: [], custom: "" };
                draft.resultFormat = event.target.checked
                  ? { presets: [], custom: "", none: true }
                  : { presets: [...(current.presets ?? [])], custom: current.custom ?? "" };
              })}
              aria-label="明确不要额外成果"
            />
            <span>无需额外成果</span>
          </label>
          <label className="result-format-custom">
            <span>补充交付要求 <em>可选</em></span>
            <textarea
              value={resultFormat.custom}
              onChange={(event) => commit((draft) => {
                const current = draft.resultFormat ?? { presets: [], custom: "" };
                draft.resultFormat = {
                  ...current,
                  presets: Array.isArray(current.presets) ? current.presets : [],
                  custom: event.target.value,
                  none: undefined
                };
              })}
              rows={3}
              maxLength={20_000}
              placeholder="例如：整理成便于审阅和继续编辑的结构，包含关键结论、数据说明和验收标准。"
              aria-label="结果形式补充说明"
            />
            <small>{resultFormat.custom.length.toLocaleString()} / 20,000 字符</small>
          </label>
        </div>
      </section>

      <section className="orchestration-part orchestration-intervention-part">
        <div className="orchestration-part-title">
          <CircleHelp size={16} />
          <span>
            <strong>用户介入</strong>
            <small>只有 Main 可以在需要人工决策、授权或补充信息时暂停流程并请求你处理。</small>
          </span>
        </div>
        <label className="orchestration-intervention-field">
          <span>是否允许 Main 请求用户介入</span>
          <select
            value={value.allowUserIntervention === false ? "disabled" : "enabled"}
            onChange={(event) =>
              commit((draft) => {
                draft.allowUserIntervention = event.target.value === "enabled";
              })
            }
            aria-label="是否允许 Main 请求用户介入"
          >
            <option value="enabled">允许</option>
            <option value="disabled">关闭</option>
          </select>
        </label>
      </section>

      <section className="orchestration-part orchestration-intervention-part">
        <div className="orchestration-part-title">
          <CircleHelp size={16} />
          <span>
            <strong>动态编排（高级权限）</strong>
            <small>Main 可以在运行中修改 Workflow、普通 Agent、项目 Skill/MCP 与可编辑运行配置。权限、Web Search、会话策略、Gateway 凭据和推理映射仍由用户与服务端锁定；Main 不能自行开启或关闭此权限。</small>
          </span>
        </div>
        <label className="orchestration-intervention-field">
          <span>允许 Main 动态重配置（高级权限）</span>
          <span className="agent-binary-toggle">
            <input
              type="checkbox"
              checked={value.allowMainReconfiguration === true}
              onChange={(event) => commit((draft) => {
                draft.allowMainReconfiguration = event.target.checked;
              })}
              aria-label="允许 Main 动态重配置（高级权限）"
            />
            <i aria-hidden="true" />
            <strong>{value.allowMainReconfiguration ? "已开启" : "关闭（默认）"}</strong>
          </span>
        </label>
        {value.allowMainReconfiguration && <div className="inline-warning" role="status">
          <strong>高级权限已开启。</strong> Main 提交的完整配置仍会经过版本校验、字段白名单和服务端原子校验。
        </div>}
      </section>
    </div>
  );
}
