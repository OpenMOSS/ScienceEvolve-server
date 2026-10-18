/** A fallback only when a saved Gateway snapshot predates per-model windows. */
export const DEFAULT_MODEL_CONTEXT_WINDOW = 256 * 1024;
export const MAX_MODEL_CONTEXT_WINDOW = 2_000_000;

export function configuredModelContextWindow(value: unknown): number {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= MAX_MODEL_CONTEXT_WINDOW
    ? Number(value)
    : DEFAULT_MODEL_CONTEXT_WINDOW;
}

export function modelAutoCompactTokenLimit(contextWindow: number): number {
  return Math.max(1, Math.floor(contextWindow * 0.8));
}
