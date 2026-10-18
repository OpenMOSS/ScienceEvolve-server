import type { HarnessCatalogEntry, Project } from "../../types";
import { protocolLabel } from "../../lib";
import type { CanvasNode } from "./core/canvas-model";
import { runtimeNodeLabel, type RuntimeNodeState } from "./core/workflow-runtime";

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
  return (
    <aside className="workflow-runtime-detail" aria-label="运行节点详情">
      <strong>{title}</strong>
      <span>{runtimeNodeLabel(state)}</span>
      <small>累计执行 {executionCount} 次</small>
      {reason && (
        <small className="workflow-runtime-detail-reason" title={reason}>
          {reason}
        </small>
      )}
      {invocationId && (
        <small title={invocationId}>Invocation {invocationId.slice(0, 18)}</small>
      )}
      {config && (
        <div className="workflow-runtime-detail-config" data-runtime-config-snapshot="true">
          <div><span>Harness</span><strong>{harness}</strong></div>
          <div><span>网关</span><strong title={snapshot?.id ?? config.gatewayId}>{snapshot?.name ?? (config.gatewayId ? config.gatewayId : "服务环境默认")}</strong></div>
          <div><span>Model</span><strong title={config.model}>{config.model}</strong></div>
          <div><span>协议 / 路由</span><strong>{gatewayProtocol ? protocolLabel(gatewayProtocol) : "服务环境默认"}</strong><small>{gatewayProtocol && routeMode === "proxy" ? nativeProtocol ? `自动路由：${protocolLabel(nativeProtocol)} → ${protocolLabel(gatewayProtocol)}` : "自动代理路由" : gatewayProtocol && nativeProtocol ? "直连" : gatewayProtocol ? "Harness 协议未记录" : "未绑定全局网关"}</small></div>
          <small className="workflow-runtime-lock-note">{project.configurationLocked ? "项目创建后已锁定配置；此处为运行快照，只读。" : "项目配置尚未锁定。"}</small>
        </div>
      )}
    </aside>
  );
}
