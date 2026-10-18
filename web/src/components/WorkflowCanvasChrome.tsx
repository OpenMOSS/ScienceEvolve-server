import {
  ArrowRight,
  ChevronsDown,
  Download,
  GitBranch,
  LayoutDashboard,
  Minus,
  Plus,
  RotateCcw,
  Save,
  Sparkles,
  Trash2,
  X
} from "lucide-react";
import type { ReactNode } from "react";

export function WorkflowEditorHeader({
  workflowName,
  onWorkflowNameChange,
  onDownload,
  onSave,
  onClose,
  saving,
  readOnly
}: {
  workflowName?: string;
  onWorkflowNameChange?: (value: string) => void;
  onDownload?: () => void;
  onSave?: () => void;
  onClose?: () => void;
  saving: boolean;
  readOnly: boolean;
}) {
  return <header className="app-header workflow-editor-header">
    <div className="brand">
      <div className="brand-mark" aria-hidden="true"><GitBranch size={20} /></div>
      <div className="brand-copy"><strong>ScienceEvolve</strong><small>科研智能体工作台</small></div>
      <span className="header-divider" aria-hidden="true" />
      <label className="workflow-name-field"><span className="sr-only">工作流名称</span><input value={workflowName ?? "未命名流程"} onChange={(event) => onWorkflowNameChange?.(event.target.value)} readOnly={!onWorkflowNameChange} maxLength={48} /></label>
    </div>
    <div className="header-actions">
      <span className="save-state" aria-live="polite"><i />编辑中</span>
      {onDownload && <button type="button" className="download-button" onClick={onDownload} title="下载 Workflow 配置"><Download size={15} /><span>下载配置</span></button>}
      {onSave && <button type="button" className="primary-button" onClick={onSave} disabled={saving || readOnly}><Save size={15} />{saving ? "保存中" : "保存流程"}</button>}
      {onClose && <button type="button" className="canvas-close-button" onClick={onClose} title="关闭 Workflow 编辑器" aria-label="关闭 Workflow 编辑器"><X size={16} /></button>}
    </div>
  </header>;
}

export function WorkflowCanvasToolbar({
  connectFrom,
  newEdgeKind,
  notice,
  onAddAgent,
  onConnect,
  onEdgeKindChange,
  onZoomOut,
  onZoomReset,
  onZoomIn,
  onClear,
  onUndo,
  onTidy,
  onLayered,
  onFit,
  canUndo,
  zoom,
  readOnly
}: {
  connectFrom: boolean;
  newEdgeKind: "strong" | "weak";
  notice: string;
  onAddAgent: () => void;
  onConnect: () => void;
  onEdgeKindChange: (kind: "strong" | "weak") => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  onZoomIn: () => void;
  onClear: () => void;
  onUndo: () => void;
  onTidy: () => void;
  onLayered: () => void;
  onFit: () => void;
  canUndo: boolean;
  zoom: number;
  readOnly: boolean;
}) {
  return <div className="canvas-toolbar">
    <div className="toolbar-group">
      <button type="button" className="toolbar-button" onClick={onAddAgent} disabled={readOnly} title="添加 Agent"><Plus size={15} /><span>Agent</span></button>
      <button type="button" className={`toolbar-button ${connectFrom ? "is-connecting" : ""}`} onClick={onConnect} title="从任意连接点拖到另一个 Agent"><ArrowRight size={15} /><span>拖拽连线</span></button>
      <span className="toolbar-separator" aria-hidden="true" />
      <div className="edge-type-toggle" aria-label="新连接类型">
        <button type="button" className={`edge-type-button ${newEdgeKind === "strong" ? "active" : ""}`} aria-pressed={newEdgeKind === "strong"} onClick={() => onEdgeKindChange("strong")}>强边</button>
        <button type="button" className={`edge-type-button ${newEdgeKind === "weak" ? "active" : ""}`} aria-pressed={newEdgeKind === "weak"} onClick={() => onEdgeKindChange("weak")}>弱边</button>
      </div>
      <span className="edge-mode-note">强边必经 · 弱边可选</span>
    </div>
    <div className="toolbar-group toolbar-right">
      {notice && <span className="connect-status" role="status">{notice}</span>}
      <button type="button" className="icon-button toolbar-icon" onClick={onZoomOut} disabled={readOnly} title="缩小画布" aria-label="缩小画布"><Minus size={15} /></button>
      <button type="button" className="zoom-reset-button" onClick={onZoomReset} title="重置缩放">{Math.round(zoom * 100)}%</button>
      <button type="button" className="icon-button toolbar-icon" onClick={onZoomIn} disabled={readOnly} title="放大画布" aria-label="放大画布"><Plus size={15} /></button>
      <button type="button" className="icon-button toolbar-icon" onClick={onClear} disabled={readOnly} title="清空画布" aria-label="清空画布"><Trash2 size={15} /></button>
      <span className="toolbar-separator" aria-hidden="true" />
      <button type="button" className="toolbar-button compact-command" onClick={onUndo} disabled={!canUndo || readOnly} title="撤销最近一次操作"><RotateCcw size={15} /><span>撤销</span></button>
      <div className="layout-control">
        <div className="layout-direct-actions" aria-label="布局操作">
          <button type="button" className="toolbar-button compact-command layout-action-button layout-primary" onClick={onTidy} disabled={readOnly} title="智能整理"><Sparkles size={15} /><span>智能整理</span></button>
          <button type="button" className="toolbar-button compact-command layout-action-button" onClick={onLayered} disabled={readOnly} title="分层重排"><LayoutDashboard size={15} /><span>分层重排</span></button>
          <button type="button" className="toolbar-button compact-command layout-action-button" onClick={onFit} disabled={readOnly} title="适应画布"><ChevronsDown size={15} /><span>适应画布</span></button>
        </div>
      </div>
    </div>
  </div>;
}

export function WorkflowCanvasFooter({ summary }: { summary: ReactNode }) {
  return <footer className="canvas-footer">
    <div className="flow-summary">{summary}</div>
    <div className="canvas-legend"><span><i className="legend-line strong" />直接执行</span><span><i className="legend-line weak" />弱边 · 可选</span><span><i className="legend-line termination" />结束</span></div>
  </footer>;
}
