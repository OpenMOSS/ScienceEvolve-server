import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowRight, Bot, Code2, Plus, ShieldCheck, Trash2, X } from "lucide-react";
import { Button } from "../Common";
import "./WorkflowGateEditor.css";
import { workflowGateSchema, type WorkflowGate } from "../../../../server/src/internal/shared/workflow-gate.js";
import type { AgentOrchestrationTemplate } from "../../types";
import { syncMainOuterRoutes, workflowOuterNodeIds } from "./core/workflow-nodes";

const gateFieldLabels: Record<string, string> = {
  id: "Gate ID", name: "Gate 名称", "verifier.code": "检查代码", "verifier.agentId": "检查 Agent",
  "verifier.instructions": "检查指引", decisionAgentId: "决策 Agent", rules: "硬规则"
};

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
  const panel = useRef<HTMLElement>(null);
  const creating = editing && !current;
  useEffect(() => {
    if (!creating) return;
    const opener = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel.current?.querySelector<HTMLInputElement>("input")?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setEditing(false); }
      if (event.key !== "Tab") return;
      const items = [...panel.current!.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary')]
        .filter(item => !item.closest("details:not([open])") || item.tagName === "SUMMARY");
      const first = items[0], last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", keydown, true);
    return () => { document.body.style.overflow = overflow; document.removeEventListener("keydown", keydown, true); if (opener?.isConnected) opener.focus(); };
  }, [creating]);
  const candidates = (group ? group.workflow.nodes.map(node => node.nodeId) : workflowOuterNodeIds(workflow)).filter(target => target !== id);
  const agents = workflow.agents.filter(agent => !group || agent.name !== "main" && agent.name !== group.leaderAgentId);
  function save() {
    try {
      const parsed = workflowGateSchema.safeParse({ id, name, ...(groupId ? { groupId } : {}),
        verifier: kind === "code" ? { kind, interpreter, code, output } : { kind, agentId: checker, instructions },
        ...(decision ? { decisionAgentId: decision } : {}), ...(rules.trim() ? { rules: JSON.parse(rules) } : {}) });
      if (!parsed.success) {
        setError(parsed.error.issues.map(issue => {
          const path = issue.path.join(".");
          const label = gateFieldLabels[path] ?? path;
          if (issue.code === "too_small") return `请填写${label}。`;
          if (path === "id") return "Gate ID 请使用字母、数字、下划线或连字符，并以字母或数字开头。";
          return `${label}：${issue.message}`;
        }).join("\n"));
        return;
      }
      const gate: WorkflowGate = parsed.data;
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
    } catch (error) {
      setError(error instanceof SyntaxError ? `硬规则 JSON 格式无效：${error.message}` : error instanceof Error ? error.message : "Gate 配置无效");
    }
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
  if (!editing) return <button type="button" className="gate-create-entry" disabled={readOnly} onClick={() => {
    setId(""); setName(""); setKind("code"); setInterpreter("python3"); setCode(""); setOutput("json");
    setChecker(""); setInstructions(""); setDecision(""); setRules(""); setTargets([]); setError(""); setEditing(true);
  }}>
    <ShieldCheck size={18} /><span><strong>新增 Gate</strong><small>检查结果 · 决定下一步</small></span><Plus size={15} />
  </button>;
  const editor = <section ref={panel} className={`workflow-gate-editor${creating ? " gate-dialog" : ""}`}
    role={creating ? "dialog" : undefined} aria-modal={creating || undefined} aria-label={current ? `Gate ${current.name}` : "新增 Gate 配置"}>
    <header className="gate-heading">
      <span className="gate-heading-icon"><ShieldCheck size={22} /></span>
      <div><small>WORKFLOW GATE</small><h3>{current ? current.name : "新增检查节点"}</h3><p>先检查，再把真实反馈交给下一步。</p></div>
      {creating && <button type="button" className="icon-button" aria-label="关闭 Gate 配置" onClick={() => setEditing(false)}><X size={18} /></button>}
    </header>
    <div className="gate-form-scroll"><fieldset disabled={readOnly} className="gate-form">
      <section className="gate-section">
        <h4><span>01</span>节点信息</h4>
        <div className="gate-fields-row">
          <label className="field"><span>Gate 名称</span><input aria-label="Gate 名称" placeholder="例如：实验结果检查" value={name} maxLength={160} onChange={event => setName(event.target.value)} /></label>
          <label className="field"><span>Gate ID</span><input aria-label="Gate ID" placeholder="例如：result-check" value={id} maxLength={64} disabled={Boolean(current)} onChange={event => setId(event.target.value.trim())} /></label>
        </div>
      </section>
      <section className="gate-section">
        <h4><span>02</span>如何检查</h4>
        <div className="gate-methods" role="group" aria-label="检查方式">
          <button type="button" aria-pressed={kind === "code"} onClick={() => setKind("code")}><Code2 size={19} /><strong>代码检查</strong><small>由前序 Agent 执行</small></button>
          <button type="button" aria-pressed={kind === "agent"} onClick={() => setKind("agent")}><Bot size={19} /><strong>Agent 检查</strong><small>指定智能体评估结果</small></button>
        </div>
        {kind === "code" ? <>
          <div className="gate-fields-row">
            <label className="field"><span>解释器</span><select aria-label="解释器" value={interpreter} onChange={event => setInterpreter(event.target.value as typeof interpreter)}><option value="python3">Python 3</option><option value="node">Node.js</option><option value="bash">Bash</option></select></label>
            <label className="field"><span>输出格式</span><select aria-label="输出格式" value={output} onChange={event => setOutput(event.target.value as typeof output)}><option value="json">JSON · 结构化结果</option><option value="text">文字 · 自然语言反馈</option></select></label>
          </div>
          <label className="field"><span>检查代码</span><textarea className="gate-code" aria-label="检查代码" rows={7} spellCheck={false} placeholder={interpreter === "python3" ? '# 读取实际结果并输出检查反馈\nimport json\n' : interpreter === "node" ? "// 填写要执行的检查代码" : "# 填写要执行的检查代码"} value={code} onChange={event => setCode(event.target.value)} /></label>
          <p className="gate-hint">在前序 Agent 的工作区内运行，沿用任务权限。原输入通过 <code>SCIENCEEVOLVE_GATE_INPUT_BASE64</code> 提供。</p>
        </> : <>
          <label className="field"><span>检查 Agent</span><select aria-label="检查 Agent" value={checker} onChange={event => setChecker(event.target.value)}><option value="">选择检查结果的智能体</option>{agents.map(agent => <option key={agent.name}>{agent.name}</option>)}</select></label>
          <label className="field"><span>检查指引</span><textarea aria-label="检查指引" rows={5} placeholder="说明需要检查的证据、判断标准与反馈要求…" value={instructions} onChange={event => setInstructions(event.target.value)} /></label>
        </>}
      </section>
      <section className="gate-section">
        <h4><span>03</span>反馈与去向</h4>
        <label className="field"><span>决策 Agent</span><select aria-label="决策 Agent" value={decision} onChange={event => setDecision(event.target.value)}><option value="">执行检查的 Agent</option>{agents.map(agent => <option key={agent.name}>{agent.name}</option>)}</select></label>
        <fieldset className="gate-targets"><legend>出边目标 <small>已选 {targets.length} 项</small></legend>
          <div role="group" aria-label="Gate 出边目标" className="gate-target-list">{[...candidates, "finish"].map(target => <label key={target} className={targets.includes(target) ? "is-selected" : ""}>
            <input type="checkbox" checked={targets.includes(target)} onChange={event => setTargets(event.target.checked ? [...targets, target] : targets.filter(item => item !== target))} />
            <span>{target === "finish" ? "结束 · finish" : target}</span><ArrowRight size={13} />
          </label>)}</div>
        </fieldset>
        <p className="gate-hint">每次只选择一个目标。唯一出边直接传递反馈；根图的 finish 仍须符合终止节点设置。</p>
        <details className="gate-advanced" open={rules.trim() ? true : undefined}>
          <summary>硬规则 <span>可选 · JSON</span></summary>
          <label className="field"><span>规则内容</span><textarea className="gate-code" aria-label="Gate 硬规则" rows={6} spellCheck={false} value={rules} onChange={event => setRules(event.target.value)} /></label>
          <p className="gate-hint">每条规则包含 target 和 all；条件包含 path、operator、value。支持 eq、ne、lt、lte、gt、gte、in、contains。规则须覆盖全部出边；留空时由决策 Agent 选路。</p>
        </details>
      </section>
    </fieldset></div>
    <footer className="gate-actions">
      {error && <p className="gate-error" role="alert">{error}</p>}
      <div className="gate-action-buttons">
        {current && <Button type="button" variant="danger" disabled={readOnly} onClick={remove}><Trash2 size={14} />删除 Gate</Button>}
        {creating && <Button type="button" variant="secondary" onClick={() => setEditing(false)}>取消</Button>}
        <Button type="button" disabled={readOnly} onClick={save}><ShieldCheck size={15} />保存 Gate</Button>
      </div>
    </footer>
  </section>;
  return creating ? createPortal(<div className="gate-dialog-backdrop" onMouseDown={event => {
    if (event.target === event.currentTarget) setEditing(false);
  }}>{editor}</div>, document.body) : editor;
}
