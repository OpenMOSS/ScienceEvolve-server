import { useState } from "react";
import { workflowGateSchema, type WorkflowGate } from "../../../../server/src/internal/shared/workflow-gate.js";
import type { AgentOrchestrationTemplate } from "../../types";
import { syncMainOuterRoutes, workflowOuterNodeIds } from "./core/workflow-nodes";

export function WorkflowGateEditor({ workflow, gateId, groupId, readOnly, onChange, onSelect }: {
  workflow: AgentOrchestrationTemplate; gateId?: string; groupId?: string; readOnly?: boolean;
  onChange(value: AgentOrchestrationTemplate): void; onSelect?(id: string): void;
}) {
  const current = workflow.gates?.find(gate => gate.id === gateId);
  const group = workflow.scopedWorkflow?.groups.find(group => group.id === groupId);
  const routes = group ? group.workflow.routes : workflow.routes;
  const [editing, setEditing] = useState(Boolean(current));
  const [id, setId] = useState(current?.id ?? "");
  const [name, setName] = useState(current?.name ?? "");
  const [kind, setKind] = useState<"code" | "agent">(current?.verifier.kind ?? "code");
  const [interpreter, setInterpreter] = useState<"node" | "python3" | "bash">(current?.verifier.kind === "code" ? current.verifier.interpreter : "python3");
  const [code, setCode] = useState(current?.verifier.kind === "code" ? current.verifier.code : "");
  const [output, setOutput] = useState<"json" | "text">(current?.verifier.kind === "code" ? current.verifier.output : "json");
  const [checker, setChecker] = useState(current?.verifier.kind === "agent" ? current.verifier.agentId : "");
  const [instructions, setInstructions] = useState(current?.verifier.kind === "agent" ? current.verifier.instructions : "");
  const [decision, setDecision] = useState(current?.decisionAgentId ?? "");
  const [rules, setRules] = useState(current?.rules ? JSON.stringify(current.rules, null, 2) : "");
  const [targets, setTargets] = useState((current ? routes[current.id] : [])?.map(edge => edge.target) ?? []);
  const [error, setError] = useState("");
  const candidates = (group ? group.workflow.nodes.map(node => node.nodeId) : workflowOuterNodeIds(workflow)).filter(target => target !== id);
  const agents = workflow.agents.filter(agent => !group || agent.name !== "main" && agent.name !== group.leaderAgentId);
  function save() {
    try {
      const gate: WorkflowGate = workflowGateSchema.parse({ id, name, ...(groupId ? { groupId } : {}),
        verifier: kind === "code" ? { kind, interpreter, code, output } : { kind, agentId: checker, instructions },
        ...(decision ? { decisionAgentId: decision } : {}), ...(rules.trim() ? { rules: JSON.parse(rules) } : {}) });
      if (!targets.length || new Set(targets).size !== targets.length) throw new Error("请选择至少一条不同的出边。");
      if (gate.rules && (gate.rules.some(rule => !targets.includes(rule.target)) || targets.some(target => !gate.rules!.some(rule => rule.target === target))))
        throw new Error("硬规则必须覆盖每条出边，且只能引用已选目标。");
      if (!current && (workflow.agents.some(agent => agent.name === id) || workflow.collaborations?.some(group => group.id === id) || workflow.gates?.some(gate => gate.id === id)))
        throw new Error("Gate ID 已被使用。");
      const next = structuredClone(workflow);
      next.gates = [...(next.gates ?? []).filter(item => item.id !== current?.id), gate];
      const scope = groupId ? next.scopedWorkflow!.groups.find(group => group.id === groupId)!.workflow : undefined;
      if (scope && !current) scope.nodes.push({ kind: "gate", nodeId: id, gateId: id });
      (scope?.routes ?? next.routes)[id] = targets.map(target => ({ target, kind: targets.length === 1 ? "strong" : "weak" }));
      if (!groupId) syncMainOuterRoutes(next);
      onChange(next); onSelect?.(id); setError(""); if (!current) setEditing(false);
    } catch (error) { setError(error instanceof Error ? error.message : "Gate 配置无效"); }
  }
  function remove() {
    if (!current) return;
    const inbound = Object.entries(routes).filter(([source, edges]) => (groupId || source !== "main") && edges.some(edge => edge.target === current.id));
    if (inbound.length || (group ? group.workflow.input.edges.some(edge => edge.target === current.id) : workflow.input.target === current.id) ||
      (!group && workflow.termination.agent === current.id)) {
      setError("请先调整指向此 Gate 的入边、入口或终止设置，再删除节点。"); return;
    }
    const next = structuredClone(workflow);
    next.gates = next.gates!.filter(gate => gate.id !== current.id);
    const scope = groupId ? next.scopedWorkflow!.groups.find(group => group.id === groupId)!.workflow : undefined;
    if (scope) scope.nodes = scope.nodes.filter(node => node.nodeId !== current.id);
    delete (scope?.routes ?? next.routes)[current.id];
    if (!groupId) syncMainOuterRoutes(next);
    onChange(next); setEditing(false);
  }
  if (!editing) return <button type="button" disabled={readOnly} onClick={() => setEditing(true)}>新增 Gate</button>;
  return <section className="workflow-gate-editor" aria-label={current ? `Gate ${current.name}` : "新增 Gate 配置"}>
    <h3>{current ? current.name : "新增 Gate"}</h3>
    <fieldset disabled={readOnly}>
      <label>Gate ID<input aria-label="Gate ID" value={id} disabled={Boolean(current)} onChange={event => setId(event.target.value)} /></label>
      <label>Gate 名称<input aria-label="Gate 名称" value={name} onChange={event => setName(event.target.value)} /></label>
      <label>检查方式<select aria-label="检查方式" value={kind} onChange={event => setKind(event.target.value as typeof kind)}><option value="code">前序 Agent 执行代码</option><option value="agent">配置 Agent 检查</option></select></label>
      {kind === "code" ? <>
        <label>解释器<select aria-label="解释器" value={interpreter} onChange={event => setInterpreter(event.target.value as typeof interpreter)}><option value="python3">Python 3</option><option value="node">Node.js</option><option value="bash">Bash</option></select></label>
        <label>检查代码<textarea aria-label="检查代码" rows={8} value={code} onChange={event => setCode(event.target.value)} /></label>
        <label>输出格式<select aria-label="输出格式" value={output} onChange={event => setOutput(event.target.value as typeof output)}><option value="json">JSON</option><option value="text">文字</option></select></label>
        <p>原输入由 SCIENCEEVOLVE_GATE_INPUT_BASE64 提供。代码在前序 Agent 的工作区内运行，使用该任务已有权限。</p>
      </> : <>
        <label>检查 Agent<select aria-label="检查 Agent" value={checker} onChange={event => setChecker(event.target.value)}><option value="">请选择</option>{agents.map(agent => <option key={agent.name}>{agent.name}</option>)}</select></label>
        <label>检查指引<textarea aria-label="检查指引" value={instructions} onChange={event => setInstructions(event.target.value)} /></label>
      </>}
      <label>决策 Agent<select aria-label="决策 Agent" value={decision} onChange={event => setDecision(event.target.value)}><option value="">执行检查的 Agent</option>{agents.map(agent => <option key={agent.name}>{agent.name}</option>)}</select></label>
      <label>出边目标<select aria-label="Gate 出边目标" multiple value={targets} onChange={event => setTargets([...event.target.selectedOptions].map(option => option.value))}>{[...candidates, "finish"].map(target => <option key={target}>{target}</option>)}</select></label>
      <p>每次进入只选择一条出边。根图的 finish 仍须符合终止节点设置。</p>
      <label>硬规则（可选 JSON）<textarea aria-label="Gate 硬规则" rows={6} value={rules} onChange={event => setRules(event.target.value)} /></label>
      <p>每条规则包含 target 和 all；条件包含 path、operator、value。支持 eq、ne、lt、lte、gt、gte、in、contains。留空时由决策 Agent 选路；唯一出边直接传递反馈。</p>
      <button type="button" onClick={save}>保存 Gate</button>
      {current && <button type="button" onClick={remove}>删除 Gate</button>}
      {!current && <button type="button" onClick={() => setEditing(false)}>取消</button>}
    </fieldset>
    {error && <p role="alert">{error}</p>}
  </section>;
}
