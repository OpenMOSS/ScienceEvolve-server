// Match the duration range of Codex's built-in clock.sleep tool.
export const SLEEP_MAX_DURATION_MS = 43_200_000;
// Allow the longest sleep to finish before Codex's MCP client times out.
export const SLEEP_TOOL_TIMEOUT_SEC = SLEEP_MAX_DURATION_MS / 1000 + 60;
