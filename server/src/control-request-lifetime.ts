/** One accepted synchronous Git action includes provider calls and local Git.
 * Abort the operation first, then leave time for its real cancellation/result
 * to cross the inner MCP and the stable proxy. Transport timeouts never imply
 * that the accepted operation stopped or that its remote mutation failed. */
export const CONTROL_OPERATION_TIMEOUT_MS = 5 * 60_000;
export const CONTROL_REQUEST_TIMEOUT_MS = CONTROL_OPERATION_TIMEOUT_MS + 15_000;
export const CONTROL_PROXY_TIMEOUT_MS = CONTROL_REQUEST_TIMEOUT_MS + 5_000;
export const CONTROL_DRAIN_TIMEOUT_MS = CONTROL_PROXY_TIMEOUT_MS + 5_000;
export const CONTROL_DISCOVERY_TIMEOUT_MS = 10_000;

export function controlRequestTimeoutMs(method: unknown, proxy = false): number {
  return method === "tools/call"
    ? proxy ? CONTROL_PROXY_TIMEOUT_MS : CONTROL_REQUEST_TIMEOUT_MS
    : CONTROL_DISCOVERY_TIMEOUT_MS;
}
