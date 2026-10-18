import type { AgentConfigPreset, GatewayRecord, HarnessCatalogEntry } from "../types";
import { downloadWorkflowSource } from "../api";
import { WorkflowCanvasEditor } from "./WorkflowCanvasEditor";

export function WorkflowPresetPreview({ preset, harnesses, gateways, onClose }: {
  preset: AgentConfigPreset;
  harnesses: HarnessCatalogEntry[];
  gateways: GatewayRecord[];
  onClose: () => void;
}) {
  return (
    <div className="workflow-canvas-dialog workflow-preset-preview" role="dialog" aria-modal="true" aria-label={`查看 Workflow：${preset.name}`}>
      <div className="workflow-canvas-dialog-backdrop" aria-hidden="true" />
      <div className="workflow-canvas-dialog-panel">
        <div className="workflow-canvas-dialog-head">
          <div><strong>{preset.name}</strong><small>{preset.importSource ? "SDK Workflow · 原始配置只读预览" : "Agent 配置预设 · 只读预览"}</small></div>
          <button type="button" onClick={onClose} aria-label="关闭 Workflow 预览">×</button>
        </div>
        <div className="workflow-canvas-dialog-scroll">
          <WorkflowCanvasEditor
            readOnly orchestration={preset.orchestration} agents={preset.agents} workflowName={preset.name}
            harnesses={harnesses} gateways={gateways}
            onOrchestrationChange={() => {}} onAgentsChange={() => {}}
          />
          {preset.importSource && (
            <details className="workflow-json-import-report">
              <summary>查看原始 workflow.json</summary>
              <p>完整保留上传时的内容，包括 Agent 配置、Skills、MCP 和网关引用。预览不会加载这些资源。</p>
              <button type="button" className="button" onClick={() => downloadWorkflowSource(preset)}>下载原始 workflow.json</button>
              <pre>{preset.importSource.text}</pre>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}
