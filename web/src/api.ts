import {
  normalizeArtifactDirectoryPage,
  normalizeArtifactPage,
  normalizeArtifactSummary,
  normalizeAgentConfigPresets,
  normalizeSavedResearchTasks,
  normalizeEvent,
  normalizeProject,
  normalizeProjects,
  normalizeQueueSnapshot,
  normalizeSkills,
  normalizeGatewayModelReasoningConfigs,
  isVisibleHarness
} from "./lib";
import type {
  Artifact,
  ArtifactCatalogPage,
  ArtifactCatalogSummary,
  ArtifactDirectoryPage,
  ArtifactContent,
  AgentConfig,
  AgentConfigPreset,
  AgentEvent,
  Catalog,
  CollaborationDissolutionPlan,
  CreateProjectInput,
  DisplayItem,
  AgentName,
  Project,
  ProjectExplainerEvent,
  ProjectExplainerEventKind,
  ProjectExplainerHistory,
  ProjectExplainerRuntimeConfig,
  ProjectExplainerConfigInput,
  GatewayRecord,
  GatewayInput,
  AgentProtocol,
  AgentHarness,
  GatewayProbeStageResult,
  GatewayMatrixProgressEvent,
  GatewayTestProgressEvent,
  GitHubAccountCatalog,
  GitHubAccountRecord,
  GitHubRepositoryObservation,
  GitGraphPage,
  SavedResearchTask,
  QueueSnapshot,
  SkillDefinition
} from "./types";
import type { AgentOrchestrationTemplate } from "./types";
import { DEFAULT_MODEL_CONTEXT_WINDOW, MAX_MODEL_CONTEXT_WINDOW } from "./types";
import type { WorkflowAdjustmentPage, WorkflowAdjustmentPageInput, WorkflowAdjustmentDetail, WorkflowAdjustmentContext, WorkflowAdjustmentSubmission, WorkflowAdjustmentSubmissionResult,
  WorkflowAdjustmentWithdrawal, WorkflowAdjustmentWithdrawalResult } from "./workflowAdjustments";

// "." resolves against the current document directory. This matters when the
// UI is mounted at /.../proxy/<port>/ rather than at the origin root.
const API_BASE = (import.meta.env.VITE_API_BASE || ".").replace(/\/$/, "");

export class ApiError extends Error {
  status: number;
  details?: unknown;

  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
  }
}

export interface ExecutionSummary {
  invocationId: string;
  status: "queued" | "running" | "completed" | "failed";
  text?: string;
  error?: string;
}

export async function ensureExecutionSummary(projectId: string, invocationId: string, retry = false, signal?: AbortSignal): Promise<ExecutionSummary> {
  return await request(`/api/projects/${encodeURIComponent(projectId)}/execution-summaries/${encodeURIComponent(invocationId)}`, {
    method: "POST", body: JSON.stringify({ retry }), signal
  }) as ExecutionSummary;
}

export interface WorkflowAdjustmentReadCache {
  projectId?: string;
  etag?: string;
  context?: WorkflowAdjustmentContext;
}

export async function getWorkflowAdjustments(projectId: string, signal?: AbortSignal, cache?: WorkflowAdjustmentReadCache): Promise<WorkflowAdjustmentContext> {
  const path = `/api/projects/${encodeURIComponent(projectId)}/workflow/adjustments`;
  if (!cache) return await request(path, { signal, cache: "no-store" }) as WorkflowAdjustmentContext;
  const known = cache.projectId === projectId && cache.context && cache.etag ? { etag: cache.etag, context: cache.context } : undefined;
  const response = await fetch(`${API_BASE}${path}`, { signal, cache: "no-store",
    headers: { Accept: "application/json", ...(known ? { "If-None-Match": known.etag } : {}) } });
  if (response.status === 304) {
    const etag = response.headers.get("ETag");
    if (!known || (etag && etag !== known.etag)) throw new ApiError("修改记录未变化响应缺少对应的已确认内容", 304);
    return known.context;
  }
  const context = await readResponse(response) as WorkflowAdjustmentContext;
  if (!signal?.aborted) {
    cache.projectId = projectId; cache.context = context;
    const etag = response.headers.get("ETag");
    if (etag) cache.etag = etag; else delete cache.etag;
  }
  return context;
}

export interface WorkflowAdjustmentPageReadCache { key?: string; etag?: string; page?: WorkflowAdjustmentPage }

export async function getWorkflowAdjustmentPage(projectId: string, input: WorkflowAdjustmentPageInput = {}, signal?: AbortSignal,
  cache?: WorkflowAdjustmentPageReadCache): Promise<WorkflowAdjustmentPage> {
  const params = new URLSearchParams();
  for (const key of ["limit", "before", "expectedVersion", "watchRequestId"] as const) if (input[key] !== undefined) params.set(key, String(input[key]));
  const path = `/api/projects/${encodeURIComponent(projectId)}/workflow/adjustments/history${params.size ? `?${params}` : ""}`;
  if (!cache) return await request(path, { signal, cache: "no-store" }) as WorkflowAdjustmentPage;
  const known = cache.key === path && cache.etag && cache.page ? { etag: cache.etag, page: cache.page } : undefined;
  const response = await fetch(`${API_BASE}${path}`, { signal, cache: "no-store",
    headers: { Accept: "application/json", ...(known ? { "If-None-Match": known.etag } : {}) } });
  if (response.status === 304) {
    const etag = response.headers.get("ETag");
    if (!known || (etag && etag !== known.etag)) throw new ApiError("分页记录未变化响应缺少对应的已确认内容", 304);
    return known.page;
  }
  const page = await readResponse(response) as WorkflowAdjustmentPage;
  if (!signal?.aborted) {
    cache.key = path; cache.page = page;
    const etag = response.headers.get("ETag"); if (etag) cache.etag = etag; else delete cache.etag;
  }
  return page;
}

export async function getWorkflowAdjustmentDetail(projectId: string, requestId: string, expectedVersion?: string, signal?: AbortSignal): Promise<WorkflowAdjustmentDetail> {
  const params = new URLSearchParams(); if (expectedVersion !== undefined) params.set("expectedVersion", expectedVersion);
  const detail = await request(`/api/projects/${encodeURIComponent(projectId)}/workflow/adjustments/requests/${encodeURIComponent(requestId)}${params.size ? `?${params}` : ""}`,
    { signal, cache: "no-store" }) as WorkflowAdjustmentDetail;
  if (detail.record.projectId !== projectId || detail.record.requestId !== requestId || expectedVersion !== undefined && detail.journalVersion !== expectedVersion)
    throw new ApiError("完整记录的项目、请求身份或日志版本不匹配", 409);
  return detail;
}

/** Keep the caller's complete immutable request and identity intact for retries.
 * A 202 response may already be applied; the returned record is authoritative. */
export async function submitWorkflowAdjustment(projectId: string, input: WorkflowAdjustmentSubmission, signal?: AbortSignal): Promise<WorkflowAdjustmentSubmissionResult> {
  return await request(`/api/projects/${encodeURIComponent(projectId)}/workflow/adjustments`, {
    method: "POST", body: JSON.stringify(input), signal
  }) as WorkflowAdjustmentSubmissionResult;
}

export async function withdrawWorkflowAdjustment(projectId: string, requestId: string, input: WorkflowAdjustmentWithdrawal, signal?: AbortSignal): Promise<WorkflowAdjustmentWithdrawalResult> {
  return await request(`/api/projects/${encodeURIComponent(projectId)}/workflow/adjustments/${encodeURIComponent(requestId)}/withdraw`, {
    method: "POST", body: JSON.stringify(input), signal
  }) as WorkflowAdjustmentWithdrawalResult;
}

async function decodeResponse(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) return response.json();
  return response.text();
}

export interface ConfigRecommendationInput {
  advisor?: { gatewayId: string; model: string };
  projectId?: string;
  configurationFingerprint?: string;
  title: string;
  requirement: string;
  inputUploadId?: string;
  inputDescription?: string;
  git?: CreateProjectInput["git"];
  agents: CreateProjectInput["agents"];
  orchestration: AgentOrchestrationTemplate;
}

export interface ConfigRecommendationResponse {
  recommendation: Pick<ConfigRecommendationInput, "agents" | "orchestration">;
  warnings: string[];
  configurationFingerprint: string;
}
export interface ConfigRecommendationProgress {
  phase: "preparing" | "generation" | "recovery" | "validation";
  message: string;
}

export interface ExplainerRecommendationConfiguration {
  config: ProjectExplainerRuntimeConfig;
  fingerprint: string;
}

function normalizeRecommendationExplainerConfig(value: ExplainerRecommendationConfiguration): ExplainerRecommendationConfiguration {
  if (typeof value?.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.fingerprint)) {
    throw new Error("Project Explainer 推荐配置版本无效，请重新加载。");
  }
  return { config: normalizeProjectExplainerConfig(value.config), fingerprint: value.fingerprint };
}

async function withRecommendationDeadline<T>(run: (signal: AbortSignal) => Promise<T>, signal: AbortSignal | undefined,
  timeoutMs: number, timeoutMessage: string): Promise<T> {
  signal?.throwIfAborted();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => {
    cancel = () => {
      const reason = signal?.reason ?? new DOMException("推荐已取消", "AbortError");
      reject(reason); controller.abort(reason);
    };
    timer = setTimeout(() => {
      const reason = new Error(timeoutMessage);
      reject(reason); controller.abort(reason);
    }, timeoutMs);
  });
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    return await Promise.race([run(controller.signal), interrupted]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}

export async function getRecommendationExplainerConfig(projectId?: string, signal?: AbortSignal): Promise<ExplainerRecommendationConfiguration> {
  const value = await withRecommendationDeadline(activeSignal =>
    request(`/api/config-recommendations/explainer${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`, { signal: activeSignal }),
  signal, 30_000, "读取推荐模型配置超过 30 秒，请检查连接后重试。") as ExplainerRecommendationConfiguration;
  return normalizeRecommendationExplainerConfig(value);
}

export async function updateRecommendationExplainerConfig(input: ProjectExplainerConfigInput, signal?: AbortSignal): Promise<ExplainerRecommendationConfiguration> {
  const value = await request("/api/config-recommendations/explainer", { method: "PATCH", body: JSON.stringify(input), signal }) as ExplainerRecommendationConfiguration;
  return normalizeRecommendationExplainerConfig(value);
}

export async function recommendProjectConfig(input: ConfigRecommendationInput, signal?: AbortSignal,
  onProgress?: (progress: ConfigRecommendationProgress) => void): Promise<ConfigRecommendationResponse> {
  return await withRecommendationDeadline(activeSignal => requestProjectConfigRecommendation(input, activeSignal, onProgress),
    signal, 630_000, "推荐连接等待超过 10 分 30 秒，服务未返回完成结果，请重试。");
}

async function requestProjectConfigRecommendation(input: ConfigRecommendationInput, signal: AbortSignal,
  onProgress?: (progress: ConfigRecommendationProgress) => void): Promise<ConfigRecommendationResponse> {
  const body = JSON.stringify({ ...input, agents: agentsPayload(input.agents), orchestration: orchestrationPayload(input.orchestration) });
  if (!onProgress) return await request("/api/config-recommendations", { method: "POST", body, signal }) as ConfigRecommendationResponse;
  const response = await fetch(API_BASE + "/api/config-recommendations", {
    method: "POST", body, signal, headers: { "Content-Type": "application/json", Accept: "application/x-ndjson, application/json" }
  });
  if (!response.ok) {
    const value = await decodeResponse(response);
    const details = value && typeof value === "object" ? value as Record<string, unknown> : {};
    throw new ApiError(typeof details.error === "string" ? details.error : "推荐配置请求失败", response.status, details);
  }
  if (!(response.headers.get("content-type") ?? "").includes("application/x-ndjson")) return await response.json() as ConfigRecommendationResponse;
  const reader = response.body?.getReader();
  if (!reader) throw new Error("浏览器不支持读取推荐进度");
  const decoder = new TextDecoder();
  const cancelReader = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancelReader, { once: true });
  let buffer = "";
  let completed: ConfigRecommendationResponse | undefined;
  const consume = (line: string) => {
    signal?.throwIfAborted();
    if (!line.trim()) return;
    const event = JSON.parse(line) as Record<string, unknown>;
    if (event.type === "progress" && typeof event.message === "string" &&
      (event.phase === "preparing" || event.phase === "generation" || event.phase === "recovery" || event.phase === "validation")) {
      onProgress({ phase: event.phase, message: event.message });
    } else if (event.type === "complete") {
      const value = event.result as ConfigRecommendationResponse | undefined;
      if (!value?.recommendation?.agents || !value.recommendation.orchestration || typeof value.configurationFingerprint !== "string" || !Array.isArray(value.warnings)) {
        throw new Error("服务返回的推荐配置格式无效");
      }
      completed = value;
    } else if (event.type === "error") {
      throw new ApiError(typeof event.message === "string" ? event.message : "推荐配置生成失败", typeof event.status === "number" ? event.status : 502);
    }
  };
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        consume(line);
        // The complete event is the protocol's terminal result. A proxy can
        // leave the HTTP connection open after forwarding it.
        if (completed) return completed;
      }
    }
    consume(buffer + decoder.decode());
    signal?.throwIfAborted();
    if (!completed) throw new Error("推荐连接已中断，服务未返回完整结果，请重试。");
    return completed;
  } finally {
    signal.removeEventListener("abort", cancelReader);
    // Connection cleanup must not delay displaying an already complete result.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export type AgentToolSelection = Pick<AgentConfig, "skills" | "autoSkills" | "mcpServers"> & { experimentMcp: boolean };
export interface AgentToolRecommendationInput extends Omit<ConfigRecommendationInput, "advisor"> {
  targetAgent: string;
  contextFingerprint: string;
  configurationFingerprint: string;
  catalogFingerprint: string;
}
export interface AgentToolRecommendationResponse {
  targetAgent: string;
  selection: AgentToolSelection;
  reasons: string[];
  warnings: string[];
  contextFingerprint: string;
  configurationFingerprint: string;
  catalogFingerprint: string;
}
export async function getAgentToolRecommendationCatalog(projectId?: string, signal?: AbortSignal): Promise<{ fingerprint: string }> {
  const result = await request(`/api/agent-tool-recommendations/catalog${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`, { signal }) as { fingerprint: string };
  if (!/^[a-f0-9]{64}$/.test(result?.fingerprint ?? "")) throw new Error("工具目录版本无效，请重新加载。");
  return result;
}
export async function recommendAgentTools(input: AgentToolRecommendationInput, signal?: AbortSignal): Promise<AgentToolRecommendationResponse> {
  const result = await request("/api/agent-tool-recommendations", {
    method: "POST", body: JSON.stringify({ ...input, agents: agentsPayload(input.agents), orchestration: orchestrationPayload(input.orchestration) }), signal
  }) as AgentToolRecommendationResponse;
  const value = result?.selection;
  if (!value || !Array.isArray(value.skills) || !Array.isArray(value.autoSkills) || !Array.isArray(value.mcpServers) ||
    ![...value.skills, ...value.autoSkills].every(reference => typeof reference === "string") ||
    !value.mcpServers.every(server => server && typeof server.name === "string" &&
      (typeof server.url === "string" && server.project === undefined || typeof server.project === "string" && server.url === undefined)) ||
    typeof value.experimentMcp !== "boolean" || !Array.isArray(result.reasons) || !result.reasons.every(reason => typeof reason === "string") ||
    !Array.isArray(result.warnings) || !result.warnings.every(warning => typeof warning === "string")) {
    throw new Error("工具推荐返回格式无效；现有配置未更改。");
  }
  // Pick the four allowed fields even if a future server adds more metadata.
  return { ...result, selection: { skills: value.skills, autoSkills: value.autoSkills, mcpServers: value.mcpServers, experimentMcp: value.experimentMcp } };
}

function validationIssueSummary(value: unknown): string {
  if (!Array.isArray(value)) return "";
  const messages = value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const issue = entry as Record<string, unknown>;
    if (typeof issue.message !== "string" || !issue.message.trim()) return [];
    const path = Array.isArray(issue.path)
      ? issue.path
          .filter((part): part is string | number =>
            typeof part === "string" || typeof part === "number"
          )
          .join(".")
      : "";
    return [`${path ? `${path}：` : ""}${issue.message.trim()}`];
  });
  return [...new Set(messages)].slice(0, 8).join("；").slice(0, 4_000);
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers
    }
  });
  return await readResponse(response);
}

async function readResponse(response: Response): Promise<unknown> {
  const body = await decodeResponse(response);
  if (!response.ok) {
    const details = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const serverMessage =
      (typeof details.message === "string" && details.message) ||
      (typeof details.detail === "string" && details.detail) ||
      (typeof details.error === "string" && details.error) ||
      (typeof body === "string" && body) ||
      `请求失败（${response.status}）`;
    const issueSummary = validationIssueSummary(details.issues);
    const message = issueSummary && serverMessage === "Invalid request"
      ? `请求参数无效：${issueSummary}`
      : serverMessage;
    throw new ApiError(message, response.status, body);
  }
  return body;
}

type ServerOrchestrationPayload = AgentOrchestrationTemplate;

function orchestrationPayload(value: AgentOrchestrationTemplate): ServerOrchestrationPayload {
  return {
    schemaVersion: value.schemaVersion === 3 ? 3 : 2,
    agents: value.agents.map((definition) => ({
      name: definition.name,
      ...(definition.template ? { template: definition.template } : {}),
      ...(definition.description?.trim()
        ? { description: definition.description.trim().slice(0, 180) }
        : {})
    })),
    collaborations: (value.collaborations ?? []).map((group) => ({
      id: group.id,
      displayName: group.displayName,
      memberAgentIds: [...group.memberAgentIds],
      renamePolicy: group.renamePolicy,
      ...(group.formationSnapshot
        ? { formationSnapshot: structuredClone(group.formationSnapshot) }
        : {})
    })),
    ...(value.schemaVersion === 3 && value.scopedWorkflow
      ? { scopedWorkflow: structuredClone(value.scopedWorkflow) }
      : {}),
    agentTemplates: value.agentTemplates?.map((definition) => ({ ...definition })),
    input: { ...value.input },
    routes: Object.fromEntries(
      Object.entries(value.routes)
        .filter(([name]) => name !== "main")
        .map(([name, edges]) => [name, edges.map((edge) => ({ ...edge }))])
    ),
    loops: value.loops?.map((loop) => ({ ...loop })),
    decisionPlans: { ...value.decisionPlans },
    allowUserIntervention: value.allowUserIntervention !== false,
    allowMainReconfiguration: value.allowMainReconfiguration === true,
    termination: { ...value.termination },
    resultFormat: value.resultFormat
      ? {
          presets: [...value.resultFormat.presets],
          custom: value.resultFormat.custom
        }
      : { presets: [], custom: "" },
    canvas: value.canvas
      ? structuredClone(value.canvas)
      : undefined,
  };
}

function agentsPayload(agents: CreateProjectInput["agents"]): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(agents).map(([name, config]) => {
      // A runtime gateway snapshot is read-only display metadata.  Never send
      // it back through create/preset APIs (the server owns the credentialed
      // snapshot and its strict input schema intentionally rejects it).
      const {
        gatewaySnapshot: _gatewaySnapshot,
        reasoningEffort: _reasoningEffort,
        legacyReasoningEffort: _legacyReasoningEffort,
        reasoningMigrationWarning: _reasoningMigrationWarning,
        ...publicConfig
      } = config;
      return [name, publicConfig];
    })
  );
}

function unwrapProject(value: unknown): unknown {
  if (value && typeof value === "object" && "project" in value) {
    return (value as { project: unknown }).project;
  }
  return value;
}

export async function getProjects(includeArchived = false): Promise<Project[]> {
  const query = includeArchived ? "?view=summary&includeArchived=true" : "?view=summary";
  return normalizeProjects(await request(`/api/projects${query}`));
}

export async function getQueue(): Promise<QueueSnapshot> {
  return normalizeQueueSnapshot(await request("/api/queue"));
}

export async function getProject(projectId: string): Promise<Project> {
  const result = await request(
    `/api/projects/${encodeURIComponent(projectId)}?view=state`
  );
  return normalizeProject(unwrapProject(result));
}

export async function getProjectGitGraph(
  projectId: string,
  options: { limit?: number; cursor?: string; includeTechnical?: boolean } = {},
  signal?: AbortSignal
): Promise<GitGraphPage> {
  const query = new URLSearchParams();
  query.set("limit", String(options.limit ?? 200));
  if (options.cursor) query.set("cursor", options.cursor);
  if (options.includeTechnical) query.set("includeTechnical", "true");
  return await request(
    `/api/projects/${encodeURIComponent(projectId)}/git/graph?${query.toString()}`,
    { signal }
  ) as GitGraphPage;
}

export async function getProjectExplainerHistory(
  projectId: string,
  limit = 2_000
): Promise<ProjectExplainerHistory> {
  const result = await request(
    `/api/projects/${encodeURIComponent(projectId)}/explainer/history?limit=${encodeURIComponent(String(limit))}`
  );
  const record =
    result && typeof result === "object"
      ? (result as Record<string, unknown>)
      : {};
  return {
    events: Array.isArray(record.events)
      ? record.events.flatMap((event) => {
          const normalized = normalizeProjectExplainerEvent(event);
          return normalized ? [normalized] : [];
        })
      : [],
    active: record.active === true
  };
}

function normalizeProjectExplainerConfig(value: unknown): ProjectExplainerRuntimeConfig {
  const wrapper = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const record = wrapper.config && typeof wrapper.config === "object"
    ? wrapper.config as Record<string, unknown>
    : wrapper;
  if (
    record.schemaVersion !== 2 ||
    !isAgentHarness(record.harness) ||
    !isAgentProtocol(record.nativeProtocol) ||
    !isAgentProtocol(record.gatewayProtocol) ||
    typeof record.model !== "string" ||
    (record.reasoningEffort !== "low" && record.reasoningEffort !== "medium" && record.reasoningEffort !== "high" && record.reasoningEffort !== "xhigh") ||
    typeof record.revision !== "number" ||
    typeof record.updatedAt !== "string"
  ) throw new Error("服务未返回有效的 Project Explainer 配置");
  return {
    schemaVersion: 2,
    harness: record.harness,
    ...(typeof record.gatewayId === "string" ? { gatewayId: record.gatewayId } : {}),
    nativeProtocol: record.nativeProtocol,
    gatewayProtocol: record.gatewayProtocol,
    model: record.model,
    reasoningEffort: record.reasoningEffort,
    revision: record.revision,
    updatedAt: record.updatedAt,
    available: record.available === true,
    ...(typeof record.validationError === "string" ? { validationError: record.validationError } : {}),
    ...(typeof record.validationWarning === "string" ? { validationWarning: record.validationWarning } : {}),
    routeMode: record.routeMode === "proxy" ? "proxy" : "direct",
    ...(isRouteDirection(record.routeDirection) ? { routeDirection: record.routeDirection } : {})
  };
}

export async function getProjectExplainerConfig(
  projectId: string
): Promise<ProjectExplainerRuntimeConfig> {
  return normalizeProjectExplainerConfig(await request(
    `/api/projects/${encodeURIComponent(projectId)}/explainer/config`
  ));
}

export async function updateProjectExplainerConfig(
  projectId: string,
  input: ProjectExplainerConfigInput
): Promise<ProjectExplainerRuntimeConfig> {
  return normalizeProjectExplainerConfig(await request(
    `/api/projects/${encodeURIComponent(projectId)}/explainer/config`,
    { method: "PATCH", body: JSON.stringify(input) }
  ));
}

export async function resetProjectExplainer(projectId: string): Promise<void> {
  await request(
    `/api/projects/${encodeURIComponent(projectId)}/explainer/reset`,
    { method: "POST" }
  );
}

export async function cancelProjectExplainer(projectId: string): Promise<void> {
  await request(
    `/api/projects/${encodeURIComponent(projectId)}/explainer/turns/cancel`,
    { method: "POST" }
  );
}

export async function streamProjectExplainerQuestion(
  projectId: string,
  question: string,
  onEvent: (event: ProjectExplainerEvent) => Promise<void> | void,
  signal?: AbortSignal
): Promise<void> {
  return streamExplainerQuestionAt(`/api/projects/${encodeURIComponent(projectId)}/explainer/turns`, question, onEvent, signal);
}

async function streamExplainerQuestionAt(url: string, question: string,
  onEvent: (event: ProjectExplainerEvent) => Promise<void> | void, signal?: AbortSignal): Promise<void> {
  const response = await fetch(
    `${API_BASE}${url}`,
    {
      method: "POST",
      headers: {
        Accept: "application/x-ndjson, application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ question }),
      signal
    }
  );
  if (!response.ok) {
    const body = await decodeResponse(response);
    const details =
      body && typeof body === "object"
        ? (body as Record<string, unknown>)
        : {};
    const message =
      (typeof details.error === "string" && details.error) ||
      (typeof body === "string" && body) ||
      `请求失败（${response.status}）`;
    throw new ApiError(message, response.status, body);
  }
  if (!response.body) throw new Error("浏览器不支持流式解说响应");
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener("abort", abort, { once: true });
  const decoder = new TextDecoder();
  let pending = "";
  let completed = false;
  const consumeLine = async (line: string) => {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error("解说 Agent 返回了无效的流式事件");
    }
    const event = normalizeProjectExplainerEvent(parsed);
    if (event) { await onEvent(event); if (event.data?.turnComplete) completed = true; }
  };
  try { while (true) {
    const { value, done } = await reader.read();
    pending += decoder.decode(value, { stream: !done });
    let newline = pending.indexOf("\n");
    while (newline >= 0) {
      const line = pending.slice(0, newline).replace(/\r$/, "");
      pending = pending.slice(newline + 1);
      await consumeLine(line);
      if (completed) return;
      newline = pending.indexOf("\n");
    }
    if (done) break;
  }
  if (pending.trim()) await consumeLine(pending);
  } finally { signal?.removeEventListener("abort", abort); void reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

export interface ExplainerAssistantContext {
  id: string; revision: number; draft: CreateProjectInput; taskId?: string; projectId?: string; updatedAt: string; canUndo?: boolean;
  workflowBase?: { revision: number; hash: string };
}
export interface ExplainerAssistantAction {
  kind: "draft.updated" | "draft.saved" | "draft.undone" | "workflow.submitted";
  context: ExplainerAssistantContext; summary: string; href?: string; requestId?: string;
}
export function explainerAssistantDraftPayload(input: CreateProjectInput): CreateProjectInput {
  const git = { ...(input.git ?? { enabled: false }) };
  if (typeof git.repositoryName === "string") {
    const name = git.repositoryName.trim();
    if (name) git.repositoryName = name;
    else delete git.repositoryName;
  }
  return { title: input.title, requirement: input.requirement, agents: agentsPayload(input.agents) as CreateProjectInput["agents"],
    orchestration: input.orchestration ? orchestrationPayload(input.orchestration) : undefined,
    git, skillDefinitions: input.skillDefinitions ?? {}, mcpDefinitions: input.mcpDefinitions ?? {} };
}
export async function createExplainerConversation(target: { taskId?: string; projectId?: string } = {}): Promise<ExplainerAssistantContext> {
  return await request("/api/explainer/conversations", { method: "POST", body: JSON.stringify(target) }) as ExplainerAssistantContext;
}
export async function getExplainerConversation(id: string): Promise<ExplainerAssistantContext> {
  return await request(`/api/explainer/conversations/${encodeURIComponent(id)}/context`) as ExplainerAssistantContext;
}
export async function syncExplainerConversation(id: string, input: { expectedRevision: number; draft?: CreateProjectInput; taskId?: string; workflowBase?: { revision: number; hash: string } }): Promise<ExplainerAssistantContext> {
  return await request(`/api/explainer/conversations/${encodeURIComponent(id)}/context`, { method: "PATCH", body: JSON.stringify({ ...input,
    ...(input.draft ? { draft: explainerAssistantDraftPayload(input.draft) } : {}) }) }) as ExplainerAssistantContext;
}
export async function getExplainerConversationHistory(id: string): Promise<ProjectExplainerHistory> {
  const value = await request(`/api/explainer/conversations/${encodeURIComponent(id)}/history`) as ProjectExplainerHistory;
  return { active: value.active === true, events: Array.isArray(value.events) ? value.events.flatMap(event => normalizeProjectExplainerEvent(event) ?? []) : [] };
}
export async function getExplainerConversationConfig(id: string): Promise<ProjectExplainerRuntimeConfig> {
  return normalizeProjectExplainerConfig(await request(`/api/explainer/conversations/${encodeURIComponent(id)}/config`));
}
export async function updateExplainerConversationConfig(id: string, input: ProjectExplainerConfigInput): Promise<ProjectExplainerRuntimeConfig> {
  return normalizeProjectExplainerConfig(await request(`/api/explainer/conversations/${encodeURIComponent(id)}/config`, { method: "PATCH", body: JSON.stringify(input) }));
}
export async function cancelExplainerConversation(id: string): Promise<void> { await request(`/api/explainer/conversations/${encodeURIComponent(id)}/cancel`, { method: "POST" }); }
export async function streamExplainerConversation(id: string, question: string, onEvent: (event: ProjectExplainerEvent) => Promise<void> | void, signal?: AbortSignal) {
  return withRecommendationDeadline(activeSignal => streamExplainerQuestionAt(`/api/explainer/conversations/${encodeURIComponent(id)}/turns`, question, onEvent, activeSignal),
    signal, 630_000, "对话连接超过等待上限，请查看已保存的草稿和操作记录后重试。");
}
export async function undoExplainerDraft(id: string, expectedRevision: number): Promise<{ action: ExplainerAssistantAction }> {
  return await request(`/api/explainer/conversations/${encodeURIComponent(id)}/undo`, { method: "POST", body: JSON.stringify({ expectedRevision, operationId: crypto.randomUUID() }) }) as { action: ExplainerAssistantAction };
}

const PROJECT_EXPLAINER_EVENT_KINDS = new Set<ProjectExplainerEventKind>([
  "user",
  "assistant",
  "reasoning",
  "tool",
  "tool_output",
  "status",
  "error"
]);

function normalizeProjectExplainerEvent(
  value: unknown
): ProjectExplainerEvent | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  if (
    typeof record.id !== "string" ||
    typeof record.projectId !== "string" ||
    typeof record.turnId !== "string" ||
    typeof record.text !== "string" ||
    typeof record.ts !== "string" ||
    typeof kind !== "string" ||
    !PROJECT_EXPLAINER_EVENT_KINDS.has(kind as ProjectExplainerEventKind)
  ) {
    return undefined;
  }
  const phase = record.phase;
  return {
    id: record.id,
    projectId: record.projectId,
    turnId: record.turnId,
    kind: kind as ProjectExplainerEventKind,
    text: record.text,
    ts: record.ts,
    itemId: typeof record.itemId === "string" ? record.itemId : undefined,
    phase:
      phase === "started" || phase === "delta" || phase === "completed"
        ? phase
        : undefined,
    data:
      record.data && typeof record.data === "object"
        ? (record.data as Record<string, unknown>)
        : undefined
  };
}

export interface ProjectEventBootstrap {
  events: AgentEvent[];
  timelineEvents: AgentEvent[];
  totalEvents: number;
  lastSeq: number;
}

export interface ProjectEventHistoryPage {
  events: AgentEvent[];
  hasMore: boolean;
}

function normalizedEventList(value: unknown): AgentEvent[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(normalizeEvent)
    .filter((event): event is AgentEvent => Boolean(event));
}

export async function getProjectEventBootstrap(
  projectId: string,
  limit = 1_000
): Promise<ProjectEventBootstrap> {
  const params = new URLSearchParams({ limit: String(limit) });
  const result = await request(
    `/api/projects/${encodeURIComponent(projectId)}/events/bootstrap?${params}`
  );
  const record =
    result && typeof result === "object"
      ? (result as Record<string, unknown>)
      : {};
  const events = normalizedEventList(record.events);
  const timelineEvents = normalizedEventList(record.timelineEvents);
  const totalEvents = Number(record.totalEvents);
  const lastSeq = Number(record.lastSeq);
  return {
    events,
    timelineEvents,
    totalEvents: Number.isSafeInteger(totalEvents)
      ? Math.max(events.length, totalEvents)
      : events.length,
    lastSeq: Number.isSafeInteger(lastSeq)
      ? Math.max(events.at(-1)?.seq ?? 0, lastSeq)
      : events.at(-1)?.seq ?? 0
  };
}

export async function getProjectEventHistory(
  projectId: string,
  before: number,
  limit = 1_000
): Promise<ProjectEventHistoryPage> {
  const params = new URLSearchParams({
    before: String(before),
    limit: String(limit)
  });
  const result = await request(
    `/api/projects/${encodeURIComponent(projectId)}/events/history?${params}`
  );
  const record =
    result && typeof result === "object"
      ? (result as Record<string, unknown>)
      : {};
  return {
    events: normalizedEventList(record.events),
    hasMore: record.hasMore === true
  };
}

export async function createProject(input: CreateProjectInput): Promise<Project> {
  const result = await request("/api/projects", {
    method: "POST",
    body: JSON.stringify({
      ...input,
      agents: agentsPayload(input.agents),
      orchestration: input.orchestration ? orchestrationPayload(input.orchestration) : undefined
    })
  });
  return normalizeProject(unwrapProject(result));
}

export async function createProjectInputUpload(signal?: AbortSignal): Promise<string> {
  const result = await request("/api/project-input-uploads", { method: "POST", signal }) as { uploadId: string };
  return result.uploadId;
}

export async function uploadProjectInputFile(uploadId: string, relativePath: string, file: File, signal?: AbortSignal): Promise<void> {
  const params = new URLSearchParams({ path: relativePath });
  await request(`/api/project-input-uploads/${encodeURIComponent(uploadId)}/files?${params}`, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: file,
    signal
  });
}

export async function listProjectInputFiles(uploadId: string): Promise<Array<{ path: string; size: number; mtimeMs?: number }>> {
  const result = await request(`/api/project-input-uploads/${encodeURIComponent(uploadId)}/files`) as { files: Array<{ path: string; size: number; mtimeMs?: number }> };
  return result.files;
}

export async function removeProjectInputFile(uploadId: string, relativePath: string): Promise<void> {
  const params = new URLSearchParams({ path: relativePath });
  await request(`/api/project-input-uploads/${encodeURIComponent(uploadId)}/files?${params}`, { method: "DELETE" });
}

export async function openProjectInputDirectory(uploadId: string): Promise<void> {
  await request(`/api/project-input-uploads/${encodeURIComponent(uploadId)}/open-directory`, { method: "POST" });
}

export async function discardProjectInputUpload(uploadId: string): Promise<void> {
  await request(`/api/project-input-uploads/${encodeURIComponent(uploadId)}`, { method: "DELETE" });
}

export async function getSavedResearchTasks(): Promise<SavedResearchTask[]> {
  return normalizeSavedResearchTasks(await request("/api/saved-research-tasks"));
}

export async function getSavedResearchTask(
  taskId: string
): Promise<SavedResearchTask> {
  const result = await request(
    `/api/saved-research-tasks/${encodeURIComponent(taskId)}`
  );
  const record =
    result && typeof result === "object"
      ? (result as Record<string, unknown>)
      : {};
  const [task] = normalizeSavedResearchTasks({ tasks: [record.task] });
  if (!task) throw new Error("服务未返回已保存的科研任务");
  return task;
}

export async function createSavedResearchTask(
  input: CreateProjectInput
): Promise<SavedResearchTask> {
  const result = await request("/api/saved-research-tasks", {
    method: "POST",
    body: JSON.stringify({
      ...input,
      agents: agentsPayload(input.agents),
      orchestration: input.orchestration ? orchestrationPayload(input.orchestration) : undefined
    })
  });
  const record =
    result && typeof result === "object"
      ? (result as Record<string, unknown>)
      : {};
  const [task] = normalizeSavedResearchTasks({ tasks: [record.task] });
  if (!task) throw new Error("服务未返回已保存的科研任务");
  return task;
}

export async function updateSavedResearchTask(
  taskId: string,
  input: CreateProjectInput
): Promise<SavedResearchTask> {
  const result = await request(
    `/api/saved-research-tasks/${encodeURIComponent(taskId)}`,
    {
      method: "PUT",
      body: JSON.stringify({
        ...input,
        agents: agentsPayload(input.agents),
        orchestration: input.orchestration ? orchestrationPayload(input.orchestration) : undefined
      })
    }
  );
  const record =
    result && typeof result === "object"
      ? (result as Record<string, unknown>)
      : {};
  const [task] = normalizeSavedResearchTasks({ tasks: [record.task] });
  if (!task) throw new Error("服务未返回已保存的科研任务");
  return task;
}

export async function deleteSavedResearchTask(taskId: string): Promise<void> {
  await request(`/api/saved-research-tasks/${encodeURIComponent(taskId)}`, {
    method: "DELETE"
  });
}

export async function getAgentConfigPresets(includeVisualizations = false): Promise<AgentConfigPreset[]> {
  return normalizeAgentConfigPresets(await request(`/api/agent-config-presets${includeVisualizations ? "?includeVisualizations=true" : ""}`));
}

export async function importAgentConfigPreset(filename: string, text: string): Promise<AgentConfigPreset> {
  const result = await request("/api/agent-config-presets/import", {
    method: "POST", body: JSON.stringify({ filename, text })
  });
  const record = result && typeof result === "object" ? result as Record<string, unknown> : {};
  const [preset] = normalizeAgentConfigPresets({ presets: [record.preset] });
  if (!preset) throw new Error("服务未返回导入的 Workflow 配置");
  return preset;
}

export function downloadWorkflowSource(preset: AgentConfigPreset): void {
  if (!preset.importSource) return;
  const url = URL.createObjectURL(new Blob([preset.importSource.text], { type: "application/json;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = preset.importSource.filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export async function createAgentConfigPreset(input: {
  name: string;
  agents: CreateProjectInput["agents"];
  orchestration: AgentOrchestrationTemplate;
  skillDefinitions?: CreateProjectInput["skillDefinitions"];
  mcpDefinitions?: CreateProjectInput["mcpDefinitions"];
}): Promise<AgentConfigPreset> {
  const result = await request("/api/agent-config-presets", {
    method: "POST",
    body: JSON.stringify({
      name: input.name,
      agents: agentsPayload(input.agents),
      orchestration: orchestrationPayload(input.orchestration),
      skillDefinitions: input.skillDefinitions,
      mcpDefinitions: input.mcpDefinitions
    })
  });
  const record = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  const [preset] = normalizeAgentConfigPresets({ presets: [record.preset] });
  if (!preset) throw new Error("服务未返回新 Workflow 配置");
  return preset;
}

export async function updateAgentConfigPreset(
  presetId: string,
  input: {
    name: string;
    agents: CreateProjectInput["agents"];
    orchestration: AgentOrchestrationTemplate;
    skillDefinitions?: CreateProjectInput["skillDefinitions"];
    mcpDefinitions?: CreateProjectInput["mcpDefinitions"];
  }
): Promise<AgentConfigPreset> {
  const result = await request(`/api/agent-config-presets/${encodeURIComponent(presetId)}`, {
    method: "PUT",
    body: JSON.stringify({
      name: input.name,
      agents: agentsPayload(input.agents),
      orchestration: orchestrationPayload(input.orchestration),
      skillDefinitions: input.skillDefinitions,
      mcpDefinitions: input.mcpDefinitions
    })
  });
  const record = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
  const [preset] = normalizeAgentConfigPresets({ presets: [record.preset] });
  if (!preset) throw new Error("服务未返回更新后的 Workflow 配置");
  return preset;
}

export async function saveProjectAgentConfigPreset(
  projectId: string,
  name?: string
): Promise<AgentConfigPreset> {
  const result = await request(
    `/api/projects/${encodeURIComponent(projectId)}/agent-config-preset`,
    {
      method: "POST",
      body: JSON.stringify(name ? { name } : {})
    }
  );
  const record =
    result && typeof result === "object"
      ? (result as Record<string, unknown>)
      : {};
  const [preset] = normalizeAgentConfigPresets({ presets: [record.preset] });
  if (!preset) throw new Error("服务未返回已保存的 Agent 配置");
  return preset;
}

export async function deleteAgentConfigPreset(presetId: string): Promise<void> {
  await request(
    `/api/agent-config-presets/${encodeURIComponent(presetId)}`,
    { method: "DELETE" }
  );
}

export function downloadAgentConfigPreset(preset: AgentConfigPreset): void {
  const blob = new Blob([`${JSON.stringify(preset, null, 2)}\n`], {
    type: "application/json;charset=utf-8"
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const source = preset.sourceProjectId ?? preset.id;
  anchor.href = url;
  anchor.download = `scienceevolve-agent-config-${source}.json`;
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export async function getSkills(): Promise<SkillDefinition[]> {
  return normalizeSkills(await request("/api/skills"));
}

function isAgentProtocol(value: unknown): value is AgentProtocol {
  return value === "responses" || value === "chat-completions" || value === "anthropic-messages";
}

function isAgentHarness(value: unknown): value is AgentHarness {
  return typeof value === "string" && /^[a-z0-9](?:[a-z0-9._-]{0,63})$/.test(value);
}

function isRouteDirection(value: unknown): value is `${AgentProtocol}->${AgentProtocol}` {
  if (typeof value !== "string") return false;
  const [source, target] = value.split("->");
  return isAgentProtocol(source) && isAgentProtocol(target) && source !== target;
}

function normalizeGatewayProbeStageResult(value: unknown): GatewayProbeStageResult | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.stage !== "text_ordinary" &&
    candidate.stage !== "text_stream" &&
    candidate.stage !== "tool_ordinary" &&
    candidate.stage !== "tool_stream" &&
    candidate.stage !== "adapter_smoke"
  ) return undefined;
  if (
    candidate.status !== "queued" &&
    candidate.status !== "running" &&
    candidate.status !== "passed" &&
    candidate.status !== "failed" &&
    candidate.status !== "skipped"
  ) return undefined;
  return {
    stage: candidate.stage,
    label: typeof candidate.label === "string" ? candidate.label : candidate.stage,
    expectation: candidate.expectation === "tool"
      ? "tool"
      : candidate.expectation === "harness"
        ? "harness"
        : "text",
    stream: candidate.stream === true,
    status: candidate.status,
    durationMs: typeof candidate.durationMs === "number" && Number.isFinite(candidate.durationMs) && candidate.durationMs >= 0
      ? Math.round(candidate.durationMs)
      : undefined,
    httpStatus: typeof candidate.httpStatus === "number" && Number.isInteger(candidate.httpStatus)
      ? candidate.httpStatus
      : undefined,
    error: typeof candidate.error === "string" ? candidate.error : undefined
  };
}

function normalizeGateways(value: unknown): GatewayRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const gateway = item as Record<string, unknown>;
    if (
      typeof gateway.id !== "string" ||
      typeof gateway.name !== "string" ||
      typeof gateway.url !== "string" ||
      !Array.isArray(gateway.models) ||
      typeof gateway.defaultModel !== "string" ||
      !isAgentProtocol(gateway.protocol)
    ) return [];
    const normalizeTest = (value: unknown): GatewayRecord["test"] | undefined => {
      if (!value || typeof value !== "object") return undefined;
      const candidate = value as Record<string, unknown>;
      const candidateStatus = candidate.status;
      if (candidateStatus !== "untested" && candidateStatus !== "passed" && candidateStatus !== "failed") return undefined;
      const stageResults = Array.isArray(candidate.stageResults)
        ? candidate.stageResults.flatMap((item) => {
            const normalized = normalizeGatewayProbeStageResult(item);
            return normalized ? [normalized] : [];
          })
        : undefined;
      return {
        status: candidateStatus,
        testedAt: typeof candidate.testedAt === "string" ? candidate.testedAt : undefined,
        error: typeof candidate.error === "string" ? candidate.error : undefined,
        durationMs: typeof candidate.durationMs === "number" && Number.isFinite(candidate.durationMs) && candidate.durationMs >= 0
          ? Math.round(candidate.durationMs)
          : undefined,
        stageResults: stageResults?.length ? stageResults : undefined,
        protocol: isAgentProtocol(candidate.protocol) ? candidate.protocol : undefined,
        model: typeof candidate.model === "string" ? candidate.model : undefined,
        harness: isAgentHarness(candidate.harness) ? candidate.harness : undefined,
        nativeProtocol: isAgentProtocol(candidate.nativeProtocol) ? candidate.nativeProtocol : undefined,
        routeMode: candidate.routeMode === "direct" || candidate.routeMode === "proxy" ? candidate.routeMode : undefined,
        routeDirection: isRouteDirection(candidate.routeDirection)
          ? candidate.routeDirection
          : undefined,
        deliveryMode: candidate.deliveryMode === "buffered-json"
          ? "buffered-json"
          : candidate.deliveryMode === "native-stream"
            ? "native-stream"
            : undefined,
        probeKind: candidate.probeKind === "route" || candidate.probeKind === "adapter-smoke"
          ? candidate.probeKind
          : undefined,
        cacheKey: typeof candidate.cacheKey === "string" ? candidate.cacheKey : undefined,
        adapterVersion: typeof candidate.adapterVersion === "string" ? candidate.adapterVersion : undefined,
        executableFingerprint: typeof candidate.executableFingerprint === "string"
          ? candidate.executableFingerprint
          : undefined,
        gatewayRevision: typeof candidate.gatewayRevision === "number"
          ? candidate.gatewayRevision
          : undefined,
        routerCompatibilityVersion: typeof candidate.routerCompatibilityVersion === "string"
          ? candidate.routerCompatibilityVersion
          : undefined,
        reasoningOptionId: typeof candidate.reasoningOptionId === "string"
          ? candidate.reasoningOptionId
          : undefined,
        reasoningFingerprint: typeof candidate.reasoningFingerprint === "string" && /^[a-f0-9]{64}$/.test(candidate.reasoningFingerprint)
          ? candidate.reasoningFingerprint
          : undefined
      };
    };
    const test = normalizeTest(gateway.test) ?? { status: "untested" as const };
    const models = gateway.models.filter((model): model is string => typeof model === "string");
    const rawContextWindows = gateway.modelContextWindows && typeof gateway.modelContextWindows === "object" && !Array.isArray(gateway.modelContextWindows)
      ? gateway.modelContextWindows as Record<string, unknown>
      : {};
    const modelContextWindows = Object.fromEntries(models.map((model) => {
      const value = rawContextWindows[model];
      return [model, typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_MODEL_CONTEXT_WINDOW
        ? value
        : DEFAULT_MODEL_CONTEXT_WINDOW];
    }));
    return [{
      id: gateway.id,
      name: gateway.name,
      url: gateway.url,
      models,
      modelContextWindows,
      modelReasoning: normalizeGatewayModelReasoningConfigs(gateway.modelReasoning, models),
      defaultModel: gateway.defaultModel,
      protocol: gateway.protocol,
      revision: typeof gateway.revision === "number" && gateway.revision > 0
        ? Math.floor(gateway.revision)
        : 1,
      builtin: gateway.builtin === true,
      test,
      tests: Array.isArray(gateway.tests)
        ? gateway.tests.flatMap((item) => {
            const normalized = normalizeTest(item);
            return normalized ? [normalized] : [];
          })
        : [],
      apiKeyConfigured: gateway.apiKeyConfigured === true,
      createdAt: typeof gateway.createdAt === "string" ? gateway.createdAt : "",
      updatedAt: typeof gateway.updatedAt === "string" ? gateway.updatedAt : ""
    }];
  });
}

function unwrapGateway(value: unknown): GatewayRecord {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const [gateway] = normalizeGateways([record.gateway]);
  if (!gateway) throw new Error("服务未返回有效网关");
  return gateway;
}

function normalizeGatewayTestForGateway(gateway: GatewayRecord, candidate: unknown): GatewayRecord["test"] {
  if (!candidate || typeof candidate !== "object") return { status: "failed" };
  const [normalized] = normalizeGateways([{ ...gateway, test: candidate }]);
  return normalized?.test ?? { status: "failed" };
}

function normalizeGatewayMatrixProgressEvent(value: unknown): GatewayMatrixProgressEvent | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.type === "combination-start") {
    const stageResults = Array.isArray(record.stageResults)
      ? record.stageResults.flatMap((item) => {
          const normalized = normalizeGatewayProbeStageResult(item);
          return normalized ? [normalized] : [];
        })
      : [];
    return isAgentHarness(record.harness) && typeof record.model === "string"
      ? { type: "combination-start", harness: record.harness, model: record.model, stageResults }
      : undefined;
  }
  if (record.type === "stage") {
    const stage = normalizeGatewayProbeStageResult(record.stage);
    return isAgentHarness(record.harness) && typeof record.model === "string" && stage
      ? { type: "stage", harness: record.harness, model: record.model, stage }
      : undefined;
  }
  if (record.type === "result") {
    if (!isAgentHarness(record.harness) || typeof record.model !== "string") return undefined;
    const gateway = normalizeGateways([{
      id: "gwy_00000000000000000000000000000000",
      name: "",
      url: "https://gateway.invalid",
      models: [record.model],
      defaultModel: record.model,
      protocol: "responses",
      apiKeyConfigured: true,
      test: { status: "untested" },
      createdAt: "",
      updatedAt: ""
    }])[0];
    if (!gateway) return undefined;
    const result = normalizeGatewayTestForGateway(gateway, {
      ...(record.result && typeof record.result === "object" ? record.result as Record<string, unknown> : {}),
      harness: record.harness,
      model: record.model
    });
    return { type: "result", harness: record.harness, model: record.model, result };
  }
  if (record.type === "complete") {
    try {
      const gateway = unwrapGateway({ gateway: record.gateway });
      return {
        type: "complete",
        gateway,
        results: Array.isArray(record.results)
          ? record.results.map((item) => normalizeGatewayTestForGateway(gateway, item))
          : []
      };
    } catch {
      return undefined;
    }
  }
  if (record.type === "error" && typeof record.message === "string") {
    return { type: "error", message: record.message };
  }
  return undefined;
}

function normalizeGatewayTestProgressEvent(value: unknown): GatewayTestProgressEvent | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.type === "stage") {
    const stage = normalizeGatewayProbeStageResult(record.stage);
    return stage ? { type: "stage", stage } : undefined;
  }
  if (record.type === "result") {
    const resultRecord = record.result && typeof record.result === "object"
      ? record.result as Record<string, unknown>
      : {};
    const model = typeof resultRecord.model === "string" ? resultRecord.model : "";
    const protocol = isAgentProtocol(resultRecord.protocol) ? resultRecord.protocol : "responses";
    const gateway = normalizeGateways([{
      id: "gwy_00000000000000000000000000000000",
      name: "",
      url: "https://gateway.invalid",
      models: model ? [model] : ["model"],
      defaultModel: model || "model",
      protocol,
      apiKeyConfigured: true,
      test: { status: "untested" },
      createdAt: "",
      updatedAt: ""
    }])[0];
    if (!gateway) return undefined;
    return { type: "result", result: normalizeGatewayTestForGateway(gateway, resultRecord) };
  }
  if (record.type === "complete") {
    try {
      const gateway = unwrapGateway({ gateway: record.gateway });
      return { type: "complete", gateway, result: normalizeGatewayTestForGateway(gateway, record.result) };
    } catch {
      return undefined;
    }
  }
  if (record.type === "error" && typeof record.message === "string") {
    return { type: "error", message: record.message };
  }
  return undefined;
}

async function readGatewayTestStream(
  response: Response,
  onProgress: (event: GatewayTestProgressEvent) => void
): Promise<GatewayRecord> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("浏览器不支持读取网关测试流式响应");
  const decoder = new TextDecoder();
  let buffer = "";
  let completed: { gateway: GatewayRecord; result: GatewayRecord["test"] } | undefined;
  const consumeLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const event = normalizeGatewayTestProgressEvent(JSON.parse(trimmed));
    if (!event) return;
    onProgress(event);
    if (event.type === "error") throw new Error(event.message);
    if (event.type === "complete") completed = { gateway: event.gateway, result: event.result };
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) consumeLine(line);
  }
  buffer += decoder.decode();
  consumeLine(buffer);
  if (!completed) throw new Error("服务未返回网关测试完成事件");
  return completed.gateway;
}

async function readGatewayMatrixStream(
  response: Response,
  onProgress: (event: GatewayMatrixProgressEvent) => void
): Promise<{ gateway: GatewayRecord; results: GatewayRecord["test"][] }> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("浏览器不支持读取网关矩阵流式响应");
  const decoder = new TextDecoder();
  let buffer = "";
  let completed: { gateway: GatewayRecord; results: GatewayRecord["test"][] } | undefined;
  const consumeLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const event = normalizeGatewayMatrixProgressEvent(JSON.parse(trimmed));
    if (!event) return;
    onProgress(event);
    if (event.type === "error") throw new Error(event.message);
    if (event.type === "complete") completed = { gateway: event.gateway, results: event.results };
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) consumeLine(line);
  }
  buffer += decoder.decode();
  consumeLine(buffer);
  if (!completed) throw new Error("服务未返回网关矩阵完成事件");
  return completed;
}

export async function getGateways(): Promise<{ gateways: GatewayRecord[]; defaultGatewayId?: string }> {
  const value = await request("/api/gateways");
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    gateways: normalizeGateways(record.gateways),
    defaultGatewayId: typeof record.defaultGatewayId === "string" ? record.defaultGatewayId : undefined
  };
}

export async function createGateway(input: GatewayInput): Promise<GatewayRecord> {
  return unwrapGateway(await request("/api/gateways", { method: "POST", body: JSON.stringify(input) }));
}

export async function revealGatewayCredential(id: string): Promise<string> {
  const value = await request(`/api/gateways/${encodeURIComponent(id)}/credential/reveal`, {
    method: "POST"
  });
  const apiKey = value && typeof value === "object"
    ? (value as Record<string, unknown>).apiKey
    : undefined;
  if (typeof apiKey !== "string" || !apiKey) {
    throw new Error("服务未返回有效网关凭据");
  }
  return apiKey;
}

export async function updateGateway(id: string, input: GatewayInput): Promise<GatewayRecord> {
  return unwrapGateway(await request(`/api/gateways/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(input) }));
}

export async function deleteGateway(id: string): Promise<void> {
  await request(`/api/gateways/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function setDefaultGateway(id: string): Promise<GatewayRecord> {
  return unwrapGateway(await request(`/api/gateways/${encodeURIComponent(id)}/default`, { method: "POST" }));
}

export async function testGateway(
  id: string,
  model: string,
  harness?: AgentHarness,
  init?: Pick<RequestInit, "signal"> & {
    onProgress?: (event: GatewayTestProgressEvent) => void;
    gatewayReasoningOption?: string;
  }
): Promise<GatewayRecord> {
  const { onProgress, gatewayReasoningOption, ...requestInit } = init ?? {};
  if (onProgress) {
    const response = await fetch(API_BASE + "/api/gateways/" + encodeURIComponent(id) + "/test", {
      method: "POST",
      body: JSON.stringify({
        model,
        ...(harness ? { harness } : {}),
        ...(gatewayReasoningOption ? { gatewayReasoningOption } : {})
      }),
      ...requestInit,
      headers: {
        Accept: "application/x-ndjson",
        "Content-Type": "application/json"
      }
    });
    if (!response.ok) {
      const body = await decodeResponse(response);
      const details = body && typeof body === "object" ? body as Record<string, unknown> : {};
      const message =
        (typeof details.message === "string" && details.message) ||
        (typeof details.detail === "string" && details.detail) ||
        (typeof details.error === "string" && details.error) ||
        (typeof body === "string" && body) ||
        "请求失败（" + response.status + "）";
      throw new ApiError(message, response.status, body);
    }
    return readGatewayTestStream(response, onProgress);
  }
  return unwrapGateway(await request(`/api/gateways/${encodeURIComponent(id)}/test`, {
    method: "POST",
    body: JSON.stringify({
      model,
      ...(harness ? { harness } : {}),
      ...(gatewayReasoningOption ? { gatewayReasoningOption } : {})
    }),
    ...requestInit
  }));
}

export async function testGatewayMatrix(
  id: string,
  options: {
    harnesses?: AgentHarness[];
    models?: string[];
    reasoningOptions?: Record<string, string | null>;
  } = {},
  init?: Pick<RequestInit, "signal"> & { onProgress?: (event: GatewayMatrixProgressEvent) => void }
): Promise<{ gateway: GatewayRecord; results: GatewayRecord["test"][] }> {
  const { onProgress, ...requestInit } = init ?? {};
  if (onProgress) {
    const response = await fetch(API_BASE + "/api/gateways/" + encodeURIComponent(id) + "/test-matrix", {
      method: "POST",
      body: JSON.stringify(options),
      ...requestInit,
      headers: {
        Accept: "application/x-ndjson",
        "Content-Type": "application/json"
      }
    });
    if (!response.ok) {
      const body = await decodeResponse(response);
      const details = body && typeof body === "object" ? body as Record<string, unknown> : {};
      const message =
        (typeof details.message === "string" && details.message) ||
        (typeof details.detail === "string" && details.detail) ||
        (typeof details.error === "string" && details.error) ||
        (typeof body === "string" && body) ||
        "请求失败（" + response.status + "）";
      throw new ApiError(message, response.status, body);
    }
    return readGatewayMatrixStream(response, onProgress);
  }

  const value = await request(`/api/gateways/${encodeURIComponent(id)}/test-matrix`, {
    method: "POST",
    body: JSON.stringify(options),
    ...requestInit
  });
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const gateway = unwrapGateway({ gateway: record.gateway });
  return {
    gateway,
    results: Array.isArray(record.results) ? record.results.map((item) => normalizeGatewayTestForGateway(gateway, item)) : []
  };
}

export async function refreshGatewayModels(id: string): Promise<GatewayRecord> {
  return unwrapGateway(await request(`/api/gateways/${encodeURIComponent(id)}/models/refresh`, { method: "POST" }));
}

export async function discoverGatewayModels(
  input: Pick<GatewayInput, "url" | "apiKey" | "protocol">
): Promise<string[]> {
  const value = await request("/api/gateway-models/discover", {
    method: "POST",
    body: JSON.stringify(input)
  });
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return Array.isArray(record.models)
    ? record.models.filter((model): model is string => typeof model === "string")
    : [];
}

function normalizeGitHubAccount(value: unknown): GitHubAccountRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const account = value as Record<string, unknown>;
  if (
    typeof account.id !== "string" ||
    typeof account.login !== "string" ||
    typeof account.providerUserId !== "number" ||
    !Number.isSafeInteger(account.providerUserId) ||
    (account.status !== "ready" && account.status !== "expired" && account.status !== "revoked") ||
    !Array.isArray(account.scopes) ||
    typeof account.createdAt !== "string" ||
    typeof account.updatedAt !== "string"
  ) return undefined;
  return {
    id: account.id,
    login: account.login,
    providerUserId: account.providerUserId,
    ...(typeof account.avatarUrl === "string" ? { avatarUrl: account.avatarUrl } : {}),
    status: account.status,
    scopes: account.scopes.filter((scope): scope is string => typeof scope === "string"),
    isDefault: account.isDefault === true,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    ...(typeof account.lastVerifiedAt === "string"
      ? { lastVerifiedAt: account.lastVerifiedAt }
      : {})
  };
}

export async function getGitHubAccounts(): Promise<GitHubAccountCatalog> {
  const value = await request("/api/github/accounts");
  const record = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
  const accounts = Array.isArray(record.accounts)
    ? record.accounts.flatMap((account) => {
        const normalized = normalizeGitHubAccount(account);
        return normalized ? [normalized] : [];
      })
    : [];
  return {
    accounts,
    ...(typeof record.defaultAccountId === "string"
      ? { defaultAccountId: record.defaultAccountId }
      : {}),
    oauthConfigured: record.oauthConfigured === true
  };
}

export async function startGitHubAuthorization(): Promise<{ authorizationUrl: string; expiresAt: string }> {
  const value = await request("/api/github/auth/start", {
    method: "POST",
    body: JSON.stringify({})
  });
  const record = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
  if (typeof record.authorizationUrl !== "string" || typeof record.expiresAt !== "string") {
    throw new Error("服务未返回有效的 GitHub 登录地址");
  }
  return { authorizationUrl: record.authorizationUrl, expiresAt: record.expiresAt };
}

function unwrapGitHubAccount(value: unknown): GitHubAccountRecord {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const account = normalizeGitHubAccount(record.account);
  if (!account) throw new Error("服务未返回有效的 GitHub 账号");
  return account;
}

export async function verifyGitHubAccount(accountId: string): Promise<GitHubAccountRecord> {
  return unwrapGitHubAccount(await request(
    `/api/github/accounts/${encodeURIComponent(accountId)}/verify`,
    { method: "POST", body: JSON.stringify({}) }
  ));
}

export async function setDefaultGitHubAccount(accountId: string): Promise<GitHubAccountRecord> {
  return unwrapGitHubAccount(await request(
    `/api/github/accounts/${encodeURIComponent(accountId)}/default`,
    { method: "POST", body: JSON.stringify({}) }
  ));
}

export async function deleteGitHubAccount(accountId: string): Promise<void> {
  await request(`/api/github/accounts/${encodeURIComponent(accountId)}`, { method: "DELETE" });
}

export async function getGitHubRepositoryStatus(projectId: string): Promise<GitHubRepositoryObservation> {
  const value = await request(
    `/api/github/projects/${encodeURIComponent(projectId)}/repository-status`
  );
  const record = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
  const repository = record.repository && typeof record.repository === "object" && !Array.isArray(record.repository)
    ? record.repository as Record<string, unknown>
    : undefined;
  if (!repository || typeof repository.exists !== "boolean" || typeof repository.observedAt !== "string") {
    throw new Error("服务未返回有效的 GitHub 仓库状态");
  }
  return {
    exists: repository.exists,
    observedAt: repository.observedAt,
    ...(typeof repository.htmlUrl === "string" ? { htmlUrl: repository.htmlUrl } : {}),
    ...(typeof repository.private === "boolean" ? { private: repository.private } : {}),
    ...(typeof repository.defaultBranch === "string" ? { defaultBranch: repository.defaultBranch } : {})
  };
}

export async function getCatalog(): Promise<Catalog> {
  const result = await request("/api/skills");
  const record =
    result && typeof result === "object"
      ? (result as Record<string, unknown>)
      : {};
  const models = Array.isArray(record.models)
    ? record.models
        .map((item) =>
          typeof item === "string"
            ? item
            : item && typeof item === "object"
              ? String(
                  (item as Record<string, unknown>).id ??
                    (item as Record<string, unknown>).name ??
                    ""
                )
              : ""
        )
        .filter(Boolean)
    : [];
  const promptRecord =
    record.agentPrompts && typeof record.agentPrompts === "object"
      ? (record.agentPrompts as Record<string, unknown>)
      : {};
  const agentPrompts = Object.fromEntries(
    Object.entries(promptRecord).flatMap(([agent, prompt]) =>
      typeof prompt === "string" ? [[agent, prompt]] : []
    )
  ) as Record<string, string>;
  const routerCompatibilityVersion = typeof record.routerCompatibilityVersion === "string"
    ? record.routerCompatibilityVersion
    : undefined;
  const defaultHarnessRecord = Array.isArray(record.harnesses)
    ? record.harnesses.find((item) =>
        item && typeof item === "object" &&
        (item as Record<string, unknown>).id === record.defaultHarnessId
      ) as Record<string, unknown> | undefined
    : undefined;
  return {
    skills: normalizeSkills(result),
    models,
    ...(Array.isArray(record.gateways)
      ? { gateways: normalizeGateways(record.gateways) }
      : {}),
    ...(typeof record.defaultGatewayId === "string"
      ? { defaultGatewayId: record.defaultGatewayId }
      : {}),
    ...(isAgentHarness(record.defaultHarnessId) && isVisibleHarness(defaultHarnessRecord)
      ? { defaultHarnessId: record.defaultHarnessId }
      : {}),
    ...(Array.isArray(record.protocols)
      ? {
          protocols: record.protocols.filter((value): value is AgentProtocol =>
            value === "responses" || value === "chat-completions" || value === "anthropic-messages"
          )
        }
      : {}),
    ...(routerCompatibilityVersion ? { routerCompatibilityVersion } : {}),
    ...(Array.isArray(record.harnesses)
      ? {
          harnesses: record.harnesses.flatMap((item) => {
          if (!item || typeof item !== "object") return [];
          const harness = item as Record<string, unknown>;
          const id = harness.id;
          const protocol = harness.nativeProtocol;
          if (!isAgentHarness(id) || !isAgentProtocol(protocol)) return [];
          const capabilityRecord = harness.capabilities && typeof harness.capabilities === "object"
            ? harness.capabilities as Record<string, unknown>
            : {};
          const purposes = Array.isArray(harness.purposes)
            ? harness.purposes.filter((purpose): purpose is "workflow" | "explainer" | "probe" =>
                purpose === "workflow" || purpose === "explainer" || purpose === "probe"
              )
            : [];
          return [{
            ...(harness.schemaVersion === 1 ? { schemaVersion: 1 as const } : {}),
            id,
            label: typeof harness.label === "string" ? harness.label : id,
            adapterVersion: typeof harness.adapterVersion === "string" ? harness.adapterVersion : "unknown",
            nativeProtocol: protocol,
            purposes,
            ...(harness.selectable === false || harness.userSelectable === false ? { selectable: false } : {}),
            ...(harness.default === true ? { default: true } : {}),
            ...(harness.userSelectable === false ? { userSelectable: false } : {}),
            ...(harness.mode === "readonly-explainer" || harness.mode === "workflow"
              ? { mode: harness.mode }
              : {}),
            notes: typeof harness.notes === "string" ? harness.notes : "",
            capabilities: {
              structuredEvents: capabilityRecord.structuredEvents === true,
              toolResults: capabilityRecord.toolResults === true,
              durableSession: capabilityRecord.durableSession === true,
              permissionPrompts: Array.isArray(capabilityRecord.permissionPrompts)
                ? capabilityRecord.permissionPrompts.filter(
                    (permission): permission is "workspace" | "compute" | "yolo" =>
                      permission === "workspace" || permission === "compute" || permission === "yolo"
                  )
                : [],
              workspaceInputs: capabilityRecord.workspaceInputs === true,
              autoSkills: capabilityRecord.autoSkills === true,
              officialEvents: capabilityRecord.officialEvents === true,
              toolEvents: capabilityRecord.toolEvents === true,
              usageEvents: capabilityRecord.usageEvents === true,
              readOnlyExplainer: capabilityRecord.readOnlyExplainer === true,
              webSearch: capabilityRecord.webSearch === true,
              skills: capabilityRecord.skills === true,
              mcp: capabilityRecord.mcp === true,
              assistantStreaming:
                capabilityRecord.assistantStreaming === "proxy-visible-output" ||
                capabilityRecord.assistantStreaming === "terminal"
                  ? capabilityRecord.assistantStreaming
                  : "native"
            },
            available: harness.available === true,
            ...(typeof harness.availabilityReason === "string" && harness.availabilityReason.trim()
              ? { availabilityReason: harness.availabilityReason.trim() }
              : {}),
            ...(typeof harness.executableFingerprint === "string" && harness.executableFingerprint.trim()
              ? { executableFingerprint: harness.executableFingerprint.trim() }
              : {}),
            ...(routerCompatibilityVersion ? { routerCompatibilityVersion } : {})
          }];
        })
        }
      : {}),
    agentPrompts,
    ...(typeof record.mainSystemPrompt === "string"
      ? { mainSystemPrompt: record.mainSystemPrompt }
      : {}),
    ...(Array.isArray(record.mcpDirectory)
      ? {
          mcpDirectory: record.mcpDirectory.flatMap((item) => {
            if (!item || typeof item !== "object") return [];
            const value = item as Record<string, unknown>;
            return typeof value.name === "string" &&
              typeof value.description === "string" &&
              typeof value.url === "string"
              ? [{
                  name: value.name,
                  description: value.description,
                  url: value.url
                }]
              : [];
          })
        }
      : {})
  };
}

export async function createUserSkill(
  title: string,
  content: string
): Promise<SkillDefinition> {
  const result = await request("/api/skills", {
    method: "POST",
    body: JSON.stringify({ title, content })
  });
  const record =
    result && typeof result === "object"
      ? (result as Record<string, unknown>)
      : {};
  const [skill] = normalizeSkills({ skills: [record.skill] });
  if (!skill) throw new Error("服务未返回已创建的 Skill");
  return skill;
}

export async function projectAction(
  projectId: string,
  action: "pause" | "resume" | "cancel" | "archive" | "unarchive"
): Promise<void> {
  await request(`/api/projects/${encodeURIComponent(projectId)}/${action}`, {
    method: "POST"
  });
}

export interface ProjectBatchItemResult {
  projectId: string;
  ok: boolean;
  project?: Project;
  error?: string;
}

export interface ProjectBatchResult {
  successCount: number;
  failureCount: number;
  results: ProjectBatchItemResult[];
}

function normalizeProjectBatchResult(value: unknown): ProjectBatchResult {
  const record = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
  const items = Array.isArray(record.results) ? record.results : [];
  const results = items.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const data = item as Record<string, unknown>;
    const projectId = typeof data.projectId === "string" ? data.projectId : "";
    if (!projectId) return [];
    return [{
      projectId,
      ok: data.ok === true,
      ...(data.project && typeof data.project === "object"
        ? { project: normalizeProject(data.project) }
        : {}),
      ...(typeof data.error === "string" ? { error: data.error } : {})
    }];
  });
  return {
    successCount: results.filter((item) => item.ok).length,
    failureCount: results.filter((item) => !item.ok).length,
    results
  };
}

export async function archiveProjects(
  projectIds: string[]
): Promise<ProjectBatchResult> {
  return normalizeProjectBatchResult(await request("/api/projects/archive/batch", {
    method: "POST",
    body: JSON.stringify({ projectIds })
  }));
}

export async function deleteArchivedProject(
  projectId: string,
  confirmation: string
): Promise<void> {
  await request(`/api/projects/${encodeURIComponent(projectId)}`, {
    method: "DELETE",
    body: JSON.stringify({ confirmation })
  });
}

export async function deleteArchivedProjects(
  projectIds: string[],
  confirmation: "永久删除"
): Promise<ProjectBatchResult> {
  return normalizeProjectBatchResult(await request("/api/projects/delete/batch", {
    method: "POST",
    body: JSON.stringify({ projectIds, confirmation })
  }));
}

export async function respondToUserIntervention(
  projectId: string,
  message: string
): Promise<Project> {
  const result = await request(
    `/api/projects/${encodeURIComponent(projectId)}/intervention/respond`,
    {
      method: "POST",
      body: JSON.stringify({ message })
    }
  );
  return normalizeProject(unwrapProject(result));
}

export async function addProjectUserInput(
  projectId: string,
  message: string,
  options?: { mode?: "wait" | "interrupt"; requestId?: string }
): Promise<Project> {
  const body: Record<string, string> = { message };
  if (options?.mode) body.mode = options.mode;
  if (options?.requestId) body.requestId = options.requestId;
  const result = await request(
    `/api/projects/${encodeURIComponent(projectId)}/user-inputs`,
    {
      method: "POST",
      body: JSON.stringify(body)
    }
  );
  return normalizeProject(unwrapProject(result));
}

export async function updateProjectAgentModels(
  projectId: string,
  models: Partial<Record<AgentName, string>>
): Promise<Project> {
  const result = await request(
    `/api/projects/${encodeURIComponent(projectId)}/agents/models`,
    {
      method: "PATCH",
      body: JSON.stringify({ models })
    }
  );
  return normalizeProject(unwrapProject(result));
}

export async function updateProjectAgentConfigs(
  projectId: string,
  agents: Partial<
    Record<
      AgentName,
      Partial<
        Pick<
          AgentConfig,
          | "model"
          | "instructions"
          | "skills"
          | "autoSkills"
          | "mcpServers"
          | "experimentMcp"
          | "permission"
          | "webSearch"
          | "sessionPersistence"
          | "decisionBy"
        >
      > & { gatewayReasoningOption?: string | null }
    >
  >
): Promise<Project> {
  const result = await request(
    `/api/projects/${encodeURIComponent(projectId)}/agents/config`,
    {
      method: "PATCH",
      body: JSON.stringify({ agents })
    }
  );
  return normalizeProject(unwrapProject(result));
}

export type CollaborationGroupUpdate =
  | {
      action: "rename";
      groupId: string;
      displayName: string;
      requestId?: string;
    }
  | {
      action: "dissolve";
      groupId: string;
      expectedWorkflowRevision: number;
      restoration?: CollaborationDissolutionPlan;
      requestId: string;
    };

export async function updateProjectCollaborationGroup(
  projectId: string,
  input: CollaborationGroupUpdate
): Promise<Project> {
  const result = await request(
    `/api/projects/${encodeURIComponent(projectId)}/workflow/collaboration-groups`,
    {
      method: "PATCH",
      body: JSON.stringify(input)
    }
  );
  return normalizeProject(unwrapProject(result));
}

export async function getArtifacts(projectId: string): Promise<Artifact[]> {
  const page = await getArtifactPage(projectId, { limit: 200 });
  return page.artifacts;
}

/** Load only lightweight counts for files currently present in Agent workspaces. */
export async function getArtifactSummary(
  projectId: string,
  options: { scope?: "project" } = {}
): Promise<ArtifactCatalogSummary> {
  const result = await request(
    `/api/projects/${encodeURIComponent(projectId)}/artifacts?view=summary${options.scope ? `&scope=${options.scope}` : ""}`
  );
  if (!result || typeof result !== "object" || !Object.prototype.hasOwnProperty.call(result, "groups")) {
    throw new Error("Artifact summary response is invalid");
  }
  return normalizeArtifactSummary(result);
}

/** Load one bounded, agent-scoped artifact page on demand. */
export async function getArtifactPage(
  projectId: string,
  options: {
    agent?: AgentName;
    offset?: number;
    limit?: number;
    query?: string;
    scope?: "project";
  } = {}
): Promise<ArtifactCatalogPage> {
  const params = new URLSearchParams();
  if (options.agent) params.set("agent", options.agent);
  if (options.scope) params.set("scope", options.scope);
  if (options.offset !== undefined) params.set("offset", String(options.offset));
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  if (options.query?.trim()) params.set("q", options.query.trim());
  const query = params.size ? `?${params}` : "";
  const result = await request(
    `/api/projects/${encodeURIComponent(projectId)}/artifacts${query}`
  );
  if (!result || typeof result !== "object" || !Object.prototype.hasOwnProperty.call(result, "offset") || !Object.prototype.hasOwnProperty.call(result, "hasMore")) {
    throw new Error("Artifact page response is invalid");
  }
  return normalizeArtifactPage(result);
}

/** Load only the direct children of one Agent shared-workspace directory. */
export async function getArtifactDirectory(
  projectId: string,
  options: {
    agent?: AgentName;
    scope?: "project";
    directory?: string;
    offset?: number;
    limit?: number;
  }
): Promise<ArtifactDirectoryPage> {
  const params = new URLSearchParams({
    view: "directory"
  });
  if (options.agent) params.set("agent", options.agent);
  if (options.scope) params.set("scope", options.scope);
  if (options.directory) params.set("directory", options.directory);
  if (options.offset !== undefined) params.set("offset", String(options.offset));
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  const result = await request(
    `/api/projects/${encodeURIComponent(projectId)}/artifacts?${params}`
  );
  if (
    !result ||
    typeof result !== "object" ||
    !Array.isArray((result as { entries?: unknown }).entries)
  ) {
    throw new Error("Artifact directory endpoint is unavailable");
  }
  return normalizeArtifactDirectoryPage(result);
}

export async function getArtifact(
  projectId: string,
  artifact: Artifact
): Promise<ArtifactContent> {
  const params = new URLSearchParams({ path: artifact.path });
  params.set("origin", "workspace");
  if (artifact.agent) params.set("agent", artifact.agent);
  if (artifact.workspaceId) params.set("workspaceId", artifact.workspaceId);
  else {
    if (artifact.id) params.set("artifactId", artifact.id);
    if (artifact.commitSha) params.set("commitSha", artifact.commitSha);
  }
  const response = await fetch(
    `${API_BASE}/api/projects/${encodeURIComponent(projectId)}/artifacts/content?${params}`,
    { headers: { Accept: "text/plain, application/json" } }
  );
  // Preserve the original bytes-as-text for JSON/CSV/code previews. Parsing a
  // JSON response here would lose object-shaped files such as metrics.json.
  const body = await response.text();
  if (!response.ok) {
    let details: unknown = body;
    try {
      details = JSON.parse(body) as unknown;
    } catch {
      // Keep the server's plain-text error.
    }
    throw new ApiError(
      body || `产物读取失败（${response.status}）`,
      response.status,
      details
    );
  }
  return { ...artifact, content: body };
}

/** Read a Main-selected file directly from its Agent shared workspace. */
export async function getDisplayedFile(
  projectId: string,
  item: DisplayItem
): Promise<ArtifactContent> {
  return getArtifact(projectId, {
    id: item.artifactId,
    path: item.path,
    name: item.title || item.path.split("/").at(-1) || item.path,
    kind: "text",
    agent: item.agent,
    origin: "workspace",
    commitSha: item.commitSha
  });
}

export function getArtifactDownloadUrl(
  projectId: string,
  artifact: Artifact
): string {
  return getArtifactResourceUrl(projectId, artifact, true);
}

export function getArtifactViewUrl(
  projectId: string,
  artifact: Artifact
): string {
  return getArtifactResourceUrl(projectId, artifact, false);
}

function getArtifactResourceUrl(
  projectId: string,
  artifact: Artifact,
  download: boolean
): string {
  const params = new URLSearchParams({
    path: artifact.path,
    ...(download ? { download: "1" } : {}),
    origin: "workspace"
  });
  if (artifact.agent) params.set("agent", artifact.agent);
  if (artifact.workspaceId) params.set("workspaceId", artifact.workspaceId);
  else {
    if (artifact.id) params.set("artifactId", artifact.id);
    if (artifact.commitSha) params.set("commitSha", artifact.commitSha);
  }
  return `${API_BASE}/api/projects/${encodeURIComponent(projectId)}/artifacts/content?${params}`;
}

export function eventStreamUrl(projectId: string, after: number): string {
  const params = new URLSearchParams({ after: String(after) });
  return `${API_BASE}/api/projects/${encodeURIComponent(projectId)}/events?${params}`;
}
