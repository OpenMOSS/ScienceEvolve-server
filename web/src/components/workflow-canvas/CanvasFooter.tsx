import type { ReactNode } from "react";

export interface CanvasFooterProps {
  agentCount: number;
  strongEdgeCount: number;
  weakEdgeCount: number;
  inputTarget?: string;
  terminationTarget?: string;
  currentTarget?: string;
  inputConnected?: boolean;
  terminationConnected?: boolean;
  compact?: boolean;
  leading?: ReactNode;
}

/** Footer reports the visible graph, not OpenFARS' validation defaults. */
export function CanvasFooter({
  agentCount, strongEdgeCount, weakEdgeCount, inputTarget, terminationTarget, inputConnected = Boolean(inputTarget),
  terminationConnected = Boolean(terminationTarget), currentTarget, compact = false, leading
}: CanvasFooterProps) {
  return (
    <footer className={`canvas-footer ${compact ? "is-compact" : ""}`}>
      <div className="flow-summary">
        {leading}
        <strong>{agentCount}</strong> 个 Agent <span>·</span> <strong>{strongEdgeCount}</strong> 条强边 <span>·</span> <strong>{weakEdgeCount}</strong> 条弱边 <span>·</span> 输入：{inputConnected ? inputTarget : "未连接"} <span>·</span> 结束：{terminationConnected ? terminationTarget : "未连接"}{currentTarget && <><span>·</span> 当前：{currentTarget}</>}
      </div>
      {!compact && <div className="canvas-legend" aria-label="连线图例"><span><i className="legend-line strong" />直接执行</span><span><i className="legend-line weak" />弱边 · 可选</span><span><i className="legend-line termination" />结束</span></div>}
    </footer>
  );
}
