import { forwardRef, type CSSProperties, type HTMLAttributes, type ReactNode, type Ref } from "react";
import "./workflow-canvas.css";

export interface CanvasWorldViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface CanvasWorldProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  viewport: CanvasWorldViewport;
  worldWidth: number;
  worldHeight: number;
  children: ReactNode;
  panning?: boolean;
  connecting?: boolean;
  layoutBusy?: boolean;
  compact?: boolean;
  verticalGuide?: number;
  horizontalGuide?: number;
  hint?: ReactNode;
  empty?: ReactNode;
  /** Ref for the transformed world layer, used by high-frequency viewport gestures. */
  worldRef?: Ref<HTMLDivElement>;
}

/**
 * The single viewport used by both the full editor and compact preview.
 * Coordinates remain in workflow-world pixels; compact mode only changes the
 * viewport fit supplied by the host and never changes node or edge markup.
 */
export const CanvasWorld = forwardRef<HTMLDivElement, CanvasWorldProps>(function CanvasWorld(
  {
    viewport,
    worldWidth,
    worldHeight,
    children,
    panning = false,
    connecting = false,
    layoutBusy = false,
    compact = false,
    verticalGuide,
    horizontalGuide,
    hint,
    empty,
    worldRef,
    className = "",
    style,
    ...rest
  },
  ref
) {
  const viewportStyle = {
    ...style,
    "--canvas-grid-x": `${viewport.x - 4 * viewport.zoom}px`,
    "--canvas-grid-y": `${viewport.y - 4 * viewport.zoom}px`,
    "--canvas-grid-size": `${18 * viewport.zoom}px`
  } as CSSProperties;
  const worldStyle: CSSProperties = {
    width: worldWidth,
    height: worldHeight,
    transform: `translate3d(${viewport.x}px, ${viewport.y}px, 0) scale(${viewport.zoom})`
  };

  return (
    <div
      ref={ref}
      className={[
        "workflow-canvas-presentation workflow-canvas",
        panning && "is-panning",
        connecting && "is-connecting",
        layoutBusy && "is-layout-busy",
        viewport.zoom < .7 && "is-semantic-overview",
        compact && "is-compact",
        className
      ].filter(Boolean).join(" ")}
      style={viewportStyle}
      tabIndex={compact ? -1 : 0}
      aria-label={compact ? "Workflow 画布预览" : "Agent 工作流画布"}
      aria-busy={layoutBusy}
      {...rest}
    >
      <div ref={worldRef} className="workflow-canvas-world" style={worldStyle}>
        {children}
      </div>
      {(verticalGuide !== undefined || horizontalGuide !== undefined) && (
        <div className="alignment-guides" aria-hidden="true">
          {verticalGuide !== undefined && <i className="alignment-guide vertical" style={{ left: verticalGuide }} />}
          {horizontalGuide !== undefined && <i className="alignment-guide horizontal" style={{ top: horizontalGuide }} />}
        </div>
      )}
      {empty && <div className="canvas-empty">{empty}</div>}
      {!compact && hint && <div className="workflow-canvas-hint">{hint}</div>}
      <div className="canvas-corner-label">WORKFLOW CANVAS</div>
    </div>
  );
});
