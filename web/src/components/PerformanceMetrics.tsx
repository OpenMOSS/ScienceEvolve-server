import type { InvocationPerformance, PerformanceAggregate } from "../types";

function formatLatency(milliseconds: number | undefined): string {
  if (milliseconds === undefined) return "—";
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`;
  return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 2 : 1)} s`;
}

export function formatTokenSpeed(
  value: number | undefined,
  source: InvocationPerformance["tokenSource"] | PerformanceAggregate["tokenSource"],
  alwaysEstimated = false
): string {
  if (value === undefined) return "—";
  const approximate = alwaysEstimated || source !== "official";
  return `${approximate ? "≈" : ""}${value.toFixed(1)} tok/s`;
}

export function PerformanceMetrics({
  performance,
  averageFallback,
  latestToken,
  hideInactiveSpeed = false,
  showApproximation = true,
  compact = false
}: {
  performance?: InvocationPerformance;
  averageFallback?: InvocationPerformance | PerformanceAggregate;
  latestToken?: InvocationPerformance;
  hideInactiveSpeed?: boolean;
  showApproximation?: boolean;
  compact?: boolean;
}) {
  const average = averageFallback?.averageTokensPerSecond ?? performance?.averageTokensPerSecond;
  const averageSource = averageFallback?.averageTokensPerSecond !== undefined
    ? averageFallback.tokenSource
    : performance?.tokenSource ?? "estimated";
  const fallbackLatency = averageFallback && "invocationId" in averageFallback
    ? averageFallback.firstTokenLatencyMs
    : undefined;
  const latency = latestToken?.firstTokenLatencyMs ?? performance?.firstTokenLatencyMs ?? fallbackLatency;
  const active = performance?.status === "active" && performance.requestActive !== false;
  return (
    <div className={`performance-metrics ${compact ? "compact" : ""}`}>
      <span title="最近一次实际测得的首 Token 延迟"><small>首 Token 延迟</small><strong>{formatLatency(latency)}</strong></span>
      {(active || !hideInactiveSpeed) && <span>
        <small>当前速度</small>
        <strong>
          {active && performance.streaming
            ? formatTokenSpeed(performance.currentTokensPerSecond, "official", showApproximation)
            : active
              ? "非流式"
              : "—"}
        </strong>
      </span>}
      <span><small>平均速度</small><strong>{formatTokenSpeed(average, showApproximation ? averageSource : "official")}</strong></span>
    </div>
  );
}
