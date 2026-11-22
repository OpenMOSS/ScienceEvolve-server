import { useState } from "react";
import type { HarnessCatalogEntry, Project } from "../../types";
import { protocolLabel } from "../../lib";
import type { CanvasNode } from "./core/canvas-model";
import { runtimeNodeLabel, type RuntimeNodeState } from "./core/workflow-runtime";
import { AgentPromptPanels } from "./AgentPromptPanels";
import { ScionTabs } from "../ScionTabs";

/** Shared read-only Agent facts for root and nested runtime canvases. */
export function RuntimeAgentNodeDetail({ node, project, title, state, executionCount, reason, invocationId, harnesses }: {
  node: CanvasNode;
  project: Project;
  title: string;
  state: RuntimeNodeState;
  executionCount: number;
  reason?: string;
  invocationId?: string;
  harnesses?: ReadonlyArray<Pick<HarnessCatalogEntry, "id" | "label">>;
}) {
  const [tab, setTab] = useState<"runtime" | "prompts">("runtime");
  const config = node.kind === "agent" ? project.agents?.[node.name] : undefined;
  const snapshot = config?.gatewaySnapshot;
  const harnessId = config?.harness;
  const harness = harnesses?.find((item) => item.id === harnessId)?.label
    ?? harnessId
    ?? "未记录";
  const nativeProtocol = snapshot?.nativeProtocol;
  const gatewayProtocol = snapshot?.protocol;
  const routeMode = snapshot?.routeMode ?? (
    gatewayProtocol && nativeProtocol
      ? nativeProtocol !== gatewayProtocol ? "proxy" : "direct"
      : undefined
  );
  const runtimeFacts = <div className="runtime-agent-rail-content">
    <div className="runtime-agent-execution">
      <small>累计执行 {executionCount} 次</small>
      {reason && <small title={reason}>{reason}</small>}
      {invocationId && <small title={invocationId}>Invocation {invocationId.slice(0, 18)}</small>}
    </div>
    {config && <dl className="runtime-agent-facts" data-runtime-config-snapshot="true">
      <div><dt>Harness</dt><dd>{harness}</dd></div>
      <div><dt>网关</dt><dd title={snapshot?.id ?? config.gatewayId}>{snapshot?.name ?? config.gatewayId ?? "服务环境默认"}</dd></div>
      <div><dt>模型</dt><dd>{config.model}</dd></div>
      <div><dt>协议 / 路由</dt><dd>{gatewayProtocol ? protocolLabel(gatewayProtocol) : "服务环境默认"}
        <small>{gatewayProtocol && routeMode === "proxy" ? nativeProtocol ? `自动路由：${protocolLabel(nativeProtocol)} → ${protocolLabel(gatewayProtocol)}` : "自动代理路由" : gatewayProtocol && nativeProtocol ? "直连" : gatewayProtocol ? "Harness 协议未记录" : "未绑定全局网关"}</small>
      </dd></div>
    </dl>}
    {config && <small className="runtime-agent-lock-state">{project.configurationLocked ? "项目创建后已锁定配置" : "项目配置尚未锁定"}</small>}
  </div>;
  return (
    <aside className="runtime-agent-rail" aria-label="运行节点详情">
      <header className="runtime-agent-rail-heading">
        <h3>{title}</h3>
        <span data-state={state}>{runtimeNodeLabel(state)}</span>
      </header>
      {config ? <ScionTabs label="节点详情视图" value={tab} onChange={setTab} tabs={[
        { value: "runtime", label: "运行", content: runtimeFacts },
        { value: "prompts", label: "提示词", content: <div className="runtime-agent-rail-content">
          <AgentPromptPanels key={node.name} agentId={node.name} agent={config} />
          <label className="runtime-user-prompt"><span>用户 Prompt</span>
            <textarea aria-label="用户 Prompt" readOnly value={config.instructions} rows={6} />
          </label>
        </div> }
      ]} /> : runtimeFacts}
    </aside>
  );
}
