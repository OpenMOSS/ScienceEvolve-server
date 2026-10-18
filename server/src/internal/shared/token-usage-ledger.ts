export const TOKEN_USAGE_ACCOUNTING_VERSION = 4 as const;

export type GatewayProtocol =
  | "responses"
  | "chat-completions"
  | "anthropic-messages";

export interface TokenUsageTotals {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  invocations: number;
  /** Provider requests whose exact usage could not be established. */
  unknownRequests?: number;
  /** False when unknown requests or unaccounted historical data exist. */
  complete?: boolean;
}

export interface ThreadTokenUsageCursor {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/** Token counters reported by one completed upstream provider request. */
export interface GatewayTokenUsage {
  usageId: string;
  protocol: GatewayProtocol;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/** One sent provider request whose exact counters are unavailable. */
export interface GatewayUnknownTokenUsage {
  usageId: string;
  protocol: GatewayProtocol;
  model: string;
  status: "unknown";
  reason:
    | "provider-response-missing-usage"
    | "provider-error-response-missing-usage"
    | "stream-interrupted"
    | "transport-outcome-unknown"
    | "retry-abandoned";
  processingState: "processed" | "indeterminate";
}

export type GatewayUsageReport = GatewayTokenUsage | GatewayUnknownTokenUsage;

export interface GatewayUsageLedgerEntry {
  agent: string;
  status: "known" | "unknown";
  protocol: GatewayProtocol;
  model: string;
  updatedAt: string;
  reason?: GatewayUnknownTokenUsage["reason"];
  processingState?: GatewayUnknownTokenUsage["processingState"];
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface ProjectTokenUsage extends TokenUsageTotals {
  byAgent: Record<string, TokenUsageTotals>;
  accountingVersion?: typeof TOKEN_USAGE_ACCOUNTING_VERSION;
  threadUsageCursors?: Record<string, ThreadTokenUsageCursor>;
  /** Idempotent provider-request ledger; supports unknown-to-known repair. */
  requestLedger?: Record<string, GatewayUsageLedgerEntry>;
  /** Old event streams cannot prove every historical request was observed. */
  historicalIncomplete?: boolean;
  updatedAt?: string;
}

export function emptyTokenUsageTotals(): TokenUsageTotals {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    invocations: 0,
    unknownRequests: 0,
    complete: true
  };
}

export function createProjectTokenUsage(
  agentNames: readonly string[],
  historicalIncomplete = false
): ProjectTokenUsage {
  return {
    ...emptyTokenUsageTotals(),
    accountingVersion: TOKEN_USAGE_ACCOUNTING_VERSION,
    threadUsageCursors: {},
    requestLedger: {},
    historicalIncomplete,
    complete: !historicalIncomplete,
    byAgent: Object.fromEntries(
      agentNames.map((name) => [name, emptyTokenUsageTotals()])
    )
  };
}

function safeUsageCount(value: number | undefined): number | undefined {
  return value === undefined || !Number.isFinite(value)
    ? undefined
    : Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(value)));
}

function usageNumber(
  usage: Record<string, unknown> | undefined,
  keys: readonly string[]
): number | undefined {
  if (!usage) return undefined;
  for (const key of keys) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function usageRecordTotal(value: unknown): number {
  const record = objectValue(value);
  if (!record) return 0;
  return Object.values(record).reduce<number>(
    (sum, item) => sum + (
      typeof item === "number" && Number.isFinite(item)
        ? Math.max(0, Math.floor(item))
        : 0
    ),
    0
  );
}

/** Normalize protocol-specific counters into one request-level record. */
export function normalizeGatewayTokenUsage(
  usageId: string,
  protocol: GatewayProtocol,
  model: string,
  usage: Record<string, unknown> | undefined
): GatewayTokenUsage | undefined {
  if (!usage) return undefined;
  const rawInput = safeUsageCount(usageNumber(usage, [
    "input_tokens",
    "prompt_tokens",
    "inputTokens"
  ]));
  const outputTokens = safeUsageCount(usageNumber(usage, [
    "output_tokens",
    "completion_tokens",
    "outputTokens"
  ]));
  const cachedInputTokens = safeUsageCount(
    usageNumber(usage, [
      "cache_read_input_tokens",
      "cached_input_tokens",
      "cached_tokens",
      "cacheReadInputTokens"
    ]) ??
    usageNumber(objectValue(usage.input_tokens_details), ["cached_tokens"]) ??
    usageNumber(objectValue(usage.prompt_tokens_details), ["cached_tokens"])
  );
  const cacheCreationTokens = safeUsageCount(
    usageNumber(usage, ["cache_creation_input_tokens", "cacheCreationInputTokens"])
  ) ?? usageRecordTotal(usage.cache_creation);
  const reportedTotal = safeUsageCount(usageNumber(usage, [
    "total_tokens",
    "totalTokens"
  ]));
  if (
    rawInput === undefined &&
    outputTokens === undefined &&
    cachedInputTokens === undefined &&
    cacheCreationTokens === 0 &&
    reportedTotal === undefined
  ) return undefined;

  // Anthropic reports cache reads/writes beside input_tokens; Responses and
  // Chat include cached tokens inside their input total.
  const inputTokens = protocol === "anthropic-messages"
    ? safeUsageCount(
        (rawInput ?? 0) + (cachedInputTokens ?? 0) + cacheCreationTokens
      ) ?? 0
    : rawInput ?? 0;
  const output = outputTokens ?? 0;
  return {
    usageId,
    protocol,
    model,
    inputTokens,
    cachedInputTokens: cachedInputTokens ?? 0,
    outputTokens: output,
    totalTokens: Math.max(reportedTotal ?? 0, inputTokens + output)
  };
}

function tokenCount(
  data: Record<string, unknown>,
  keys: readonly string[]
): number | undefined {
  return safeUsageCount(usageNumber(data, keys));
}

/** Parse a durable trace payload back into its request-level report. */
export function gatewayUsageReportFromData(
  data: Record<string, unknown> | undefined
): GatewayUsageReport | undefined {
  if (!data || typeof data.usageId !== "string" || !data.usageId.trim()) {
    return undefined;
  }
  const protocol = data.protocol;
  const model = data.model;
  if (
    (protocol !== "responses" && protocol !== "chat-completions" && protocol !== "anthropic-messages") ||
    typeof model !== "string" || !model.trim()
  ) return undefined;
  if (data.usageStatus === "unknown") {
    const reasons: GatewayUnknownTokenUsage["reason"][] = [
      "provider-response-missing-usage",
      "provider-error-response-missing-usage",
      "stream-interrupted",
      "transport-outcome-unknown",
      "retry-abandoned"
    ];
    const reason = reasons.includes(data.reason as GatewayUnknownTokenUsage["reason"])
      ? data.reason as GatewayUnknownTokenUsage["reason"]
      : "provider-response-missing-usage";
    return {
      usageId: data.usageId,
      protocol,
      model,
      status: "unknown",
      reason,
      processingState: data.processingState === "indeterminate"
        ? "indeterminate"
        : "processed"
    };
  }
  const inputTokens = tokenCount(data, ["input_tokens", "inputTokens", "prompt_tokens", "promptTokens"]);
  const outputTokens = tokenCount(data, ["output_tokens", "outputTokens", "completion_tokens", "completionTokens"]);
  const cachedInputTokens = tokenCount(data, ["cached_input_tokens", "cachedInputTokens", "cached_tokens", "cachedTokens"]);
  const totalTokens = tokenCount(data, ["total_tokens", "totalTokens"]);
  if (
    inputTokens === undefined && outputTokens === undefined &&
    cachedInputTokens === undefined && totalTokens === undefined
  ) return undefined;
  const input = inputTokens ?? 0;
  const output = outputTokens ?? 0;
  return {
    usageId: data.usageId,
    protocol,
    model,
    inputTokens: input,
    cachedInputTokens: cachedInputTokens ?? 0,
    outputTokens: output,
    totalTokens: totalTokens ?? input + output
  };
}

function safeTokenSum(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

function addTokenUsage(target: TokenUsageTotals, usage: TokenUsageTotals): void {
  target.inputTokens = safeTokenSum(target.inputTokens, usage.inputTokens);
  target.cachedInputTokens = safeTokenSum(target.cachedInputTokens, usage.cachedInputTokens);
  target.outputTokens = safeTokenSum(target.outputTokens, usage.outputTokens);
  target.totalTokens = safeTokenSum(target.totalTokens, usage.totalTokens);
  target.invocations = safeTokenSum(target.invocations, usage.invocations);
}

export function refreshUsageCompleteness(projectUsage: ProjectTokenUsage): void {
  projectUsage.unknownRequests ??= 0;
  projectUsage.complete = projectUsage.unknownRequests === 0 &&
    projectUsage.historicalIncomplete !== true;
  for (const totals of Object.values(projectUsage.byAgent)) {
    totals.unknownRequests ??= 0;
    totals.complete = totals.unknownRequests === 0 &&
      projectUsage.historicalIncomplete !== true;
  }
}

/** Apply one provider request exactly once, allowing unknown -> known repair. */
export function applyGatewayUsageReport(
  projectUsage: ProjectTokenUsage,
  agent: string,
  report: GatewayUsageReport,
  updatedAt: string
): void {
  projectUsage.requestLedger ??= {};
  projectUsage.byAgent[agent] ??= emptyTokenUsageTotals();
  const previous = projectUsage.requestLedger[report.usageId];
  const known = !("status" in report) || report.status !== "unknown";
  if (previous?.status === "known") return;
  if (previous?.status === "unknown" && !known) return;

  if (previous?.status === "unknown" && known) {
    projectUsage.unknownRequests = Math.max(0, (projectUsage.unknownRequests ?? 0) - 1);
    projectUsage.byAgent[previous.agent] ??= emptyTokenUsageTotals();
    const previousAgentTotals = projectUsage.byAgent[previous.agent]!;
    previousAgentTotals.unknownRequests = Math.max(
      0,
      (previousAgentTotals.unknownRequests ?? 0) - 1
    );
  }

  if (known) {
    const usage = report as GatewayTokenUsage;
    const totals: TokenUsageTotals = {
      inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      invocations: 1,
      unknownRequests: 0,
      complete: true
    };
    addTokenUsage(projectUsage, totals);
    addTokenUsage(projectUsage.byAgent[agent]!, totals);
    projectUsage.updatedAt = updatedAt;
    projectUsage.requestLedger[report.usageId] = {
      agent,
      status: "known",
      protocol: report.protocol,
      model: report.model,
      inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      updatedAt
    };
  } else {
    const usage = report as GatewayUnknownTokenUsage;
    projectUsage.unknownRequests = safeTokenSum(projectUsage.unknownRequests ?? 0, 1);
    const agentTotals = projectUsage.byAgent[agent]!;
    agentTotals.unknownRequests = safeTokenSum(agentTotals.unknownRequests ?? 0, 1);
    projectUsage.updatedAt = updatedAt;
    projectUsage.requestLedger[report.usageId] = {
      agent,
      status: "unknown",
      protocol: report.protocol,
      model: report.model,
      reason: usage.reason,
      processingState: usage.processingState,
      updatedAt
    };
  }
  refreshUsageCompleteness(projectUsage);
}

function validNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function validTokenUsageTotals(value: unknown): value is TokenUsageTotals {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  return [
    "inputTokens",
    "cachedInputTokens",
    "outputTokens",
    "totalTokens",
    "invocations",
    "unknownRequests"
  ].every((key) => validNonNegativeInteger(data[key])) &&
    typeof data.complete === "boolean";
}

function validThreadTokenUsageCursor(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  return ["inputTokens", "cachedInputTokens", "outputTokens", "totalTokens"]
    .every((key) => validNonNegativeInteger(data[key]));
}

function validGatewayUsageLedgerEntry(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  return (data.status === "known" || data.status === "unknown") &&
    typeof data.agent === "string" &&
    typeof data.model === "string" &&
    (data.protocol === "responses" || data.protocol === "chat-completions" || data.protocol === "anthropic-messages") &&
    typeof data.updatedAt === "string";
}

export function isProjectTokenUsage(
  value: unknown,
  agentNames: readonly string[]
): value is ProjectTokenUsage {
  if (!validTokenUsageTotals(value)) return false;
  const data = value as unknown as ProjectTokenUsage;
  if (data.accountingVersion !== TOKEN_USAGE_ACCOUNTING_VERSION) return false;
  if (!data.byAgent || typeof data.byAgent !== "object" || Array.isArray(data.byAgent)) return false;
  if (!data.threadUsageCursors || typeof data.threadUsageCursors !== "object" || Array.isArray(data.threadUsageCursors)) return false;
  if (!data.requestLedger || typeof data.requestLedger !== "object" || Array.isArray(data.requestLedger)) return false;
  return agentNames.every((name) => validTokenUsageTotals(data.byAgent[name])) &&
    Object.values(data.threadUsageCursors).every(validThreadTokenUsageCursor) &&
    Object.values(data.requestLedger).every(validGatewayUsageLedgerEntry);
}
