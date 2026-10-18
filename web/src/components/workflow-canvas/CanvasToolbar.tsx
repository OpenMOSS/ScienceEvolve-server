import { CornerUpLeft, CornerUpRight, GitBranch, Maximize, MoreHorizontal, Network, Plus, Trash2 } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface CanvasToolbarProps {
  edgeKind: "strong" | "weak";
  zoom: number;
  connecting?: boolean;
  connectStatus?: string;
  layoutStatus?: string;
  layoutPhase?: "idle" | "planning" | "applying";
  readOnly?: boolean;
  allowFitWhenReadOnly?: boolean;
  layoutBusy?: boolean;
  canUndo?: boolean;
  canRedo?: boolean;
  addAgentLabel?: string;
  onAddAgent?: () => void;
  onToggleConnect?: () => void;
  onEdgeKindChange?: (kind: "strong" | "weak") => void;
  onZoomOut?: () => void;
  onResetZoom?: () => void;
  onZoomIn?: () => void;
  onClear?: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  onTidy?: () => void;
  onLayered?: () => void;
  onFit?: () => void;
}

export function CanvasToolbar({
  edgeKind, zoom, connecting = false, connectStatus, layoutStatus, layoutPhase = "idle", readOnly = false, allowFitWhenReadOnly = false, layoutBusy = false, canUndo = false, canRedo = false, addAgentLabel = "Agent 模板",
  onAddAgent, onToggleConnect, onEdgeKindChange, onZoomOut, onResetZoom, onZoomIn, onClear, onUndo, onRedo, onTidy, onLayered, onFit
}: CanvasToolbarProps) {
  const editDisabled = readOnly || layoutBusy;
  const fitDisabled = layoutBusy || (readOnly && !allowFitWhenReadOnly);
  const layoutDisabled = (!onTidy || editDisabled) && (!onLayered || editDisabled) && (!onFit || fitDisabled);
  const [layoutMenuOpen, setLayoutMenuOpen] = useState(false);
  const [layoutCollapsed, setLayoutCollapsed] = useState(false);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const toolbarLeadRef = useRef<HTMLDivElement>(null);
  const toolbarRightRef = useRef<HTMLDivElement>(null);
  const layoutMenuRef = useRef<HTMLDivElement>(null);
  const measurementKeyRef = useRef("");
  useEffect(() => {
    if (!layoutMenuOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!layoutMenuRef.current?.contains(event.target as Node)) setLayoutMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setLayoutMenuOpen(false);
    };
    window.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [layoutMenuOpen]);
  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    const lead = toolbarLeadRef.current;
    const right = toolbarRightRef.current;
    const layout = layoutMenuRef.current;
    if (!toolbar || !lead || !right || !layout) return;

    const intrinsicGroupWidth = (group: HTMLElement) => {
      const groupStyle = window.getComputedStyle(group);
      const gap = parseFloat(groupStyle.columnGap || groupStyle.gap) || 0;
      const visibleChildren = Array.from(group.children).filter((child) => {
        const element = child as HTMLElement;
        const style = window.getComputedStyle(element);
        return style.display !== "none" && style.position !== "absolute";
      }) as HTMLElement[];
      const previousGroup = { flex: group.style.flex, width: group.style.width, overflow: group.style.overflow };
      const previousChildren = visibleChildren.map((child) => ({ child, flexShrink: child.style.flexShrink }));
      // The flex layout can clip the text before the decision is made. Force
      // the group and each visible control to its natural width briefly, then
      // restore the live layout immediately after measuring.
      group.style.flex = "0 0 auto";
      group.style.width = "max-content";
      group.style.overflow = "visible";
      visibleChildren.forEach((child) => { child.style.flexShrink = "0"; });
      const width = group.getBoundingClientRect().width;
      group.style.flex = previousGroup.flex;
      group.style.width = previousGroup.width;
      group.style.overflow = previousGroup.overflow;
      previousChildren.forEach(({ child, flexShrink }) => { child.style.flexShrink = flexShrink; });
      return width || visibleChildren.reduce((total, child) => {
        const style = window.getComputedStyle(child);
        const margins = (parseFloat(style.marginLeft) || 0) + (parseFloat(style.marginRight) || 0);
        return total + Math.max(child.scrollWidth, child.getBoundingClientRect().width) + margins;
      }, Math.max(0, visibleChildren.length - 1) * gap);
    };
    const measure = () => {
      if (toolbar.clientWidth <= 0) return;
      const measurementKey = [
        toolbar.clientWidth,
        connectStatus ?? "",
        layoutStatus ?? "",
        layoutMenuOpen ? "open" : "closed",
        document.fonts?.status ?? ""
      ].join(":");
      if (measurementKeyRef.current === measurementKey) return;
      // Measure the expanded controls even when the previous render was
      // collapsed. The reference editor makes this same intrinsic-width
      // decision so the 920px view keeps labels while narrow desktop centers
      // move only the layout actions into the menu.
      const wasCollapsed = layout.classList.contains("is-collapsed");
      layout.classList.remove("is-collapsed");
      const toolbarStyle = window.getComputedStyle(toolbar);
      const padding = (parseFloat(toolbarStyle.paddingLeft) || 0) + (parseFloat(toolbarStyle.paddingRight) || 0);
      const gap = parseFloat(toolbarStyle.columnGap || toolbarStyle.gap) || 0;
      const required = intrinsicGroupWidth(lead) + intrinsicGroupWidth(right) + padding + gap;
      const collapsed = required > toolbar.clientWidth - 2;
      layout.classList.toggle("is-collapsed", wasCollapsed);
      measurementKeyRef.current = measurementKey;
      setLayoutCollapsed((current) => current === collapsed ? current : collapsed);
    };
    let disposed = false;
    let frame: number | undefined;
    const scheduleMeasure = () => {
      if (disposed || frame !== undefined) return;
      frame = window.requestAnimationFrame(() => {
        frame = undefined;
        measure();
      });
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(scheduleMeasure);
    // Observe the available container, not the toolbar whose temporary
    // intrinsic-width styles are changed by measure(); observing the latter
    // creates a self-sustaining ResizeObserver/layout loop.
    if (toolbar.parentElement) observer?.observe(toolbar.parentElement);
    // Font loading is the only intrinsic-size change that does not guarantee
    // a toolbar resize notification. Measure it once when fonts settle rather
    // than mutating every toolbar child on a permanent polling interval.
    void document.fonts?.ready.then(scheduleMeasure);
    window.addEventListener("resize", scheduleMeasure);
    return () => {
      disposed = true;
      observer?.disconnect();
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", scheduleMeasure);
    };
  }, [connectStatus, layoutMenuOpen, layoutStatus]);
  const runLayout = (action?: () => void) => {
    setLayoutMenuOpen(false);
    action?.();
  };
  return (
    <div ref={toolbarRef} className="canvas-toolbar" aria-label="画布工具栏">
      <div ref={toolbarLeadRef} className="toolbar-group">
        {onAddAgent && <button type="button" className="toolbar-button" onClick={onAddAgent} disabled={editDisabled}><Plus size={16} /><span>{addAgentLabel}</span></button>}
        {onToggleConnect && <button type="button" className={`toolbar-button ${connecting ? "is-connecting" : ""}`} onClick={onToggleConnect} disabled={editDisabled} aria-pressed={connecting}><span aria-hidden="true">→</span><span>拖拽连线</span></button>}
        <span className="toolbar-separator" aria-hidden="true" />
        <div className="edge-type-toggle" aria-label="新连接类型">
          <button type="button" className={`edge-type-button ${edgeKind === "strong" ? "active" : ""}`} data-edge-type="strong" aria-pressed={edgeKind === "strong"} disabled={editDisabled} onClick={() => onEdgeKindChange?.("strong")}>强边</button>
          <button type="button" className={`edge-type-button ${edgeKind === "weak" ? "active" : ""}`} data-edge-type="weak" aria-pressed={edgeKind === "weak"} disabled={editDisabled} onClick={() => onEdgeKindChange?.("weak")}>弱边</button>
        </div>
        <span className="edge-mode-note">强边必经 · 弱边可选</span>
      </div>
      <div ref={toolbarRightRef} className="toolbar-group toolbar-right">
        {layoutStatus ? (
          <span className={`layout-status is-${layoutPhase}`} aria-live="polite" role="status">
            {layoutBusy && <i className="layout-status-spinner" aria-hidden="true" />}
            <span>{layoutStatus}</span>
          </span>
        ) : <span className="connect-status" aria-live="polite">{connectStatus}</span>}
        <button type="button" className="icon-button toolbar-icon" title="缩小画布" aria-label="缩小画布" onClick={onZoomOut} disabled={layoutBusy}>−</button>
        <button type="button" className="zoom-reset-button" title="重置缩放" aria-label="重置缩放" onClick={onResetZoom} disabled={layoutBusy}>{Math.round(zoom * 100)}%</button>
        <button type="button" className="icon-button toolbar-icon" title="放大画布" aria-label="放大画布" onClick={onZoomIn} disabled={layoutBusy}>+</button>
        {onClear && <button type="button" className="icon-button toolbar-icon" title="清空画布" aria-label="清空画布" onClick={onClear} disabled={editDisabled}><Trash2 size={15} /></button>}
        {onUndo && <><span className="toolbar-separator" aria-hidden="true" /><button type="button" className="toolbar-button compact-command" title="撤销最近一次操作" aria-label="撤销" onClick={onUndo} disabled={editDisabled || !canUndo}><CornerUpLeft size={15} /><span>撤销</span></button></>}
        {onRedo && <button type="button" className="icon-button toolbar-icon" title="重做最近撤销的操作" aria-label="重做" onClick={onRedo} disabled={editDisabled || !canRedo}><CornerUpRight size={15} /></button>}
        {(onTidy || onLayered || onFit) && <div className={`layout-control ${layoutCollapsed ? "is-collapsed" : ""}`} aria-label="布局操作" ref={layoutMenuRef}>
          <div className="layout-direct-actions">
            {onTidy && <button type="button" className="toolbar-button compact-command layout-action-button layout-primary" onClick={onTidy} disabled={editDisabled} title="整理重叠、过短连线和轻微错位" aria-label="智能整理布局"><Network size={15} /><span>智能整理</span></button>}
            {onLayered && <button type="button" className="toolbar-button compact-command layout-action-button" onClick={onLayered} disabled={editDisabled} title="依次执行分层重排、智能整理和适应画布" aria-label="依次执行分层重排、智能整理和适应画布"><GitBranch size={15} /><span>分层重排</span></button>}
            {onFit && <button type="button" className="toolbar-button compact-command layout-action-button" onClick={onFit} disabled={fitDisabled} title="缩放并居中显示全部流程" aria-label="适应画布"><Maximize size={15} /><span>适应画布</span></button>}
          </div>
          <button
            type="button"
            className="layout-menu-button"
            title="更多布局操作"
            aria-label="更多布局操作"
            aria-haspopup="menu"
            aria-expanded={layoutMenuOpen}
            disabled={layoutDisabled}
            onClick={() => setLayoutMenuOpen((open) => !open)}
          ><MoreHorizontal size={15} /></button>
          {layoutMenuOpen && <div className="layout-menu" role="menu">
            {onTidy && <button type="button" role="menuitem" onClick={() => runLayout(onTidy)} disabled={editDisabled}><Network size={15} /><span><strong>智能整理</strong></span></button>}
            {onLayered && <button type="button" role="menuitem" onClick={() => runLayout(onLayered)} disabled={editDisabled}><GitBranch size={15} /><span><strong>分层重排</strong></span></button>}
            {onFit && <button type="button" role="menuitem" onClick={() => runLayout(onFit)} disabled={fitDisabled}><Maximize size={15} /><span><strong>适应画布</strong></span></button>}
          </div>}
        </div>}
      </div>
    </div>
  );
}
