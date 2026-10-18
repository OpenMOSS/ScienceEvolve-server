import type {
  AgentOrchestrationTemplate,
  CollaborationDissolutionPlan,
  CollaborationNode,
  WorkflowEdge
} from "../../types";
import { dissolutionPlanError } from "./core/collaboration-dissolution";

function routeLabel(routes: readonly WorkflowEdge[]): string {
  return routes.length ? routes.map((edge) => `${edge.target}（${edge.kind === "strong" ? "强边" : "弱边"}）`).join("、") : "未选择";
}

export function CollaborationDissolutionPlanner({
  orchestration,
  group,
  plan,
  disabled = false,
  onChange
}: {
  orchestration: AgentOrchestrationTemplate;
  group: CollaborationNode;
  plan: CollaborationDissolutionPlan;
  disabled?: boolean;
  onChange: (plan: CollaborationDissolutionPlan) => void;
}) {
  const inboundSources = Object.entries(orchestration.routes)
    .filter(([source, routes]) => source !== group.id && routes.some((edge) => edge.target === group.id))
    .map(([source]) => source);
  const groupOutgoing = orchestration.routes[group.id] ?? [];
  const updateIncoming = (source: string, target: string) => onChange({
    ...plan,
    incomingTargetBySource: { ...plan.incomingTargetBySource, [source]: target }
  });
  const updateMemberTarget = (member: string, target: string) => {
    const inherited = groupOutgoing.find((edge) => edge.target === target);
    const edge: WorkflowEdge = {
      target,
      kind: group.memberAgentIds.includes(target) ? "strong" : inherited?.kind ?? "weak"
    };
    onChange({ ...plan, memberRoutes: { ...plan.memberRoutes, [member]: [edge] } });
  };
  const error = dissolutionPlanError(orchestration, group, plan);
  return <div className="collaboration-dissolution-mapping" aria-label={`${group.displayName} 解散拓扑映射`}>
    <section>
      <strong>入边映射</strong>
      {inboundSources.map((source) => <label key={source}><span>{source} →</span><select aria-label={`${source} 解散后目标`} value={plan.incomingTargetBySource[source] ?? ""} disabled={disabled} onChange={(event) => updateIncoming(source, event.target.value)}>{group.memberAgentIds.map((member) => <option value={member} key={member}>{member}</option>)}</select></label>)}
      {orchestration.input.target === group.id && <label><span>用户输入 →</span><select aria-label="解散后输入目标" value={plan.inputTarget ?? ""} disabled={disabled} onChange={(event) => onChange({ ...plan, inputTarget: event.target.value })}>{group.memberAgentIds.map((member) => <option value={member} key={member}>{member}</option>)}</select></label>}
    </section>
    <section>
      <strong>成员出边</strong>
      {group.memberAgentIds.map((member) => {
        const routes = plan.memberRoutes[member] ?? [];
        const current = routes.length === 1 ? routes[0]!.target : "__multiple";
        const targets = [...new Set([
          ...group.memberAgentIds.filter((candidate) => candidate !== member),
          ...groupOutgoing.map((edge) => edge.target)
        ])];
        return <label key={member}><span>{member} →</span><select aria-label={`${member} 解散后出边`} value={current} disabled={disabled} onChange={(event) => updateMemberTarget(member, event.target.value)}>{routes.length > 1 && <option value="__multiple">保留原组全部出边</option>}{targets.map((target) => <option value={target} key={target}>{target}</option>)}</select><small>{routeLabel(routes)}</small></label>;
      })}
      {orchestration.termination.agent === group.id && <label><span>终止 Agent</span><select aria-label="解散后终止 Agent" value={plan.terminationAgent ?? ""} disabled={disabled} onChange={(event) => onChange({ ...plan, terminationAgent: event.target.value })}>{group.memberAgentIds.map((member) => <option value={member} key={member}>{member}</option>)}</select></label>}
    </section>
    <div className={`collaboration-dissolution-validation${error ? " is-error" : " is-valid"}`} role="status">
      {error ? `拓扑不可保存：${error}` : "拓扑预览有效：所有恢复后的 Agent 均可到达，并存在通往 finish 的路径。"}
    </div>
  </div>;
}
