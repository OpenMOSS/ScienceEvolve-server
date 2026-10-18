import { workflowAdjustmentPageSchema, workflowAdjustmentDetailQuerySchema } from "./workflow-adjustments.js";
import express, {
  type ErrorRequestHandler,
  type NextFunction,
  type Request,
  type Response
} from "express";
import { z, ZodError } from "zod";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createReadStream, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { AppConfig } from "./config.js";
import type { EventHub } from "./event-hub.js";
import type { Orchestrator } from "./orchestrator.js";
import { projectListSummary } from "./project-list-summary.js";
import { CollaborationStateError } from "./collaboration-state/errors.js";
import { workflowAdjustmentSubmissionBodySchema, workflowAdjustmentWithdrawalBodySchema } from "./workflow-adjustments.js";
import type { ProjectStorage } from "./storage.js";
import type { SkillCatalog } from "./skill-catalog.js";
import {
  ProjectExplainerBusyError,
  ProjectExplainerConfigurationError,
  ProjectExplainerHarnessSwitchConfirmationError,
  type ProjectExplainerEvent,
  type ProjectExplainerPort,
  type ProjectExplainerRecommendationPort
} from "./project-explainer.js";
import { AgentConfigPresetStore } from "./agent-config-presets.js";
import { parseWorkflowImport } from "./workflow-import.js";
import { ConfigRecommendationError, configRecommendationInputSchema, type ConfigRecommendationPort } from "./config-recommendations.js";
import { agentToolRecommendationInputSchema, type AgentToolRecommendationService } from "./agent-tool-recommendations.js";
import { SavedResearchTaskStore } from "./saved-research-tasks.js";
import { registerExplainerAssistantRoutes } from "./explainer-assistant-api.js";
import type { ProjectExplainerAssistantPort } from "./project-explainer.js";
import type { AgentName, TimelineEvent } from "./types.js";
import {
  createUserSkillSchema,
  cancelProjectSchema,
  resumeProjectSchema,
  batchDeleteArchivedProjectsSchema,
  batchProjectIdsSchema,
  deleteArchivedProjectSchema,
  agentConfigPresetInputSchema,
  projectExplainerQuestionSchema,
  projectExplainerConfigSchema,
  projectUserInputSchema,
  savedResearchTaskInputSchema,
  saveAgentConfigPresetSchema,
  gitGraphQuerySchema,
  skillInputSchema,
  updateAgentConfigsSchema,
  updateAgentModelsSchema,
  updateCollaborationGroupSchema,
  userInterventionResponseSchema
} from "./validation.js";
import { BUILTIN_AGENT_PROMPTS, MAIN_SYSTEM_PROMPT } from "./prompt.js";
import { publicFixedMcpDirectory } from "./mcp-directory.js";
import {
  GatewayStore,
  DEFAULT_HARNESS_ID,
  GatewayProbeCancelledError,
  normalizeGatewayInput,
  publicGateway,
  type AgentProtocol,
  type GatewayInput,
  type GatewayMatrixProgressEvent,
  type GatewayTestProgressEvent
} from "./agent-runtime.js";
import {
  harnessCatalogRegistry,
  toPublicHarnessDescriptor
} from "./harness-runtime/registry.js";
import type { PublicHarnessDescriptor } from "./harness-runtime/contracts.js";
import { AGENT_PROTOCOLS } from "./agent-runtime.js";
import { PROTOCOL_ROUTER_COMPATIBILITY_VERSION } from "./protocol-router.js";
import { redactTrace } from "./utils.js";
import type { ExecutionSummaryService } from "./execution-summary.js";
import { GitHubAccountStore } from "./github-accounts.js";
import { GitHubAuthorizationError } from "./collaboration-git/errors.js";
import { ProjectInputUploads, ProjectInputUploadError } from "./project-input-uploads.js";

const MAX_PENDING_SSE_EVENTS = 1_000;
const DEFAULT_EVENT_PAGE_LIMIT = 1_000;
const MAX_EVENT_PAGE_LIMIT = 5_000;
const MAX_ARTIFACT_PREVIEW_BYTES = 5 * 1024 * 1024;

function responseAbortSignal(response: Response): AbortSignal {
  const controller = new AbortController();
  response.on("close", () => {
    if (!response.writableEnded) controller.abort();
  });
  return controller.signal;
}

function wantsGatewayMatrixStream(request: Request): boolean {
  const accept = String(request.headers.accept ?? "").toLowerCase();
  return accept.includes("application/x-ndjson") || accept.includes("application/jsonl");
}

function writeGatewayMatrixStreamEvent(
  response: Response,
  event: GatewayMatrixProgressEvent | { type: "complete"; gateway: unknown; results: unknown } | { type: "error"; message: string }
): void {
  if (response.destroyed || response.writableEnded) return;
  response.write(JSON.stringify(event) + "\n");
}

function writeGatewayTestStreamEvent(
  response: Response,
  event: GatewayTestProgressEvent | { type: "complete"; gateway: unknown; result: unknown } | { type: "error"; message: string }
): void {
  if (response.destroyed || response.writableEnded) return;
  response.write(JSON.stringify(event) + "\n");
}

function eventPageLimit(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_EVENT_PAGE_LIMIT;
  return Math.min(parsed, MAX_EVENT_PAGE_LIMIT);
}

export interface AppDependencies {
  orchestrator: Orchestrator;
  storage: ProjectStorage;
  eventHub: EventHub;
  skills: SkillCatalog;
  configPresets?: AgentConfigPresetStore;
  savedResearchTasks?: SavedResearchTaskStore;
  projectExplainer?: ProjectExplainerPort & Partial<ProjectExplainerRecommendationPort> & Partial<ProjectExplainerAssistantPort>;
  configRecommendations?: ConfigRecommendationPort;
  agentToolRecommendations?: Pick<AgentToolRecommendationService, "catalog" | "recommend">;
  executionSummaries?: Pick<ExecutionSummaryService, "ensure">;
  gatewayStore?: GatewayStore;
  githubAccounts?: GitHubAccountStore;
  harnessCatalog?: () => Promise<PublicHarnessDescriptor[]>;
  config: Pick<AppConfig, "modelSuggestions" | "maxEventHistory">;
  harnessVersion?: string;
}

export function createApp(dependencies: AppDependencies) {
  const { orchestrator, storage, eventHub, skills, config } =
    dependencies;
  const gatewayStore = dependencies.gatewayStore ?? new GatewayStore(storage.root);
  const githubAccounts = dependencies.githubAccounts ?? new GitHubAccountStore(storage.root);
  const configPresets =
    dependencies.configPresets ?? new AgentConfigPresetStore(storage.root);
  const savedResearchTasks =
    dependencies.savedResearchTasks ?? new SavedResearchTaskStore(storage.root);
  const inputUploads = new ProjectInputUploads(storage.root);
  const projectExplainer = dependencies.projectExplainer;
  const harnessCatalog = dependencies.harnessCatalog ?? (async () =>
    harnessCatalogRegistry.list().map((descriptor) =>
      toPublicHarnessDescriptor(descriptor, {
        available: false,
        availabilityReason: "Harness Runtime Catalog 未注入；服务拒绝推测 Adapter 可用性"
      })
    )
  );
  const app = express();
  app.disable("x-powered-by");
  app.use((_, response, next) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self' blob:; object-src 'none'; base-uri 'self'"
    );
    response.setHeader(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=()"
    );
    next();
  });
  // The proposal may itself use the full 2 MiB validation allowance. Its
  // request/version fields and 20,000-character explanation also travel in
  // this envelope, so they need room before the unchanged proposal check.
  app.post("/api/projects/:projectId/workflow/adjustments", express.json({ limit: "3mb" }));
  app.use("/api/explainer/conversations", express.json({ limit: "3mb" }));
  app.use(express.json({ limit: "2mb" }));
  registerExplainerAssistantRoutes(app, projectExplainer);

  app.get("/api/config-recommendations/explainer", async (request, response, next) => {
    try {
      const { projectId } = z.object({ projectId: z.string().regex(/^prj_[a-f0-9]{32}$/).optional() }).strict().parse(request.query);
      if (!projectExplainer?.getRecommendationConfig) {
        response.status(503).json({ error: "Project Explainer 推荐配置不可用。" });
        return;
      }
      if (projectId && !await orchestrator.getProject(projectId)) {
        response.status(404).json({ error: "Project not found" });
        return;
      }
      response.json(await projectExplainer.getRecommendationConfig(projectId));
    } catch (error) { next(error); }
  });

  app.patch("/api/config-recommendations/explainer", async (request, response, next) => {
    try {
      if (!projectExplainer?.updateDraftConfig || !projectExplainer.getRecommendationConfig) {
        response.status(503).json({ error: "Project Explainer 推荐配置不可用。" });
        return;
      }
      const input = projectExplainerConfigSchema.parse(request.body);
      await projectExplainer.updateDraftConfig(input);
      response.json(await projectExplainer.getRecommendationConfig());
    } catch (error) {
      if (error instanceof ProjectExplainerConfigurationError) {
        response.status(400).json({ error: redactTrace(error.message), code: "explainer_configuration_invalid" });
      } else next(error);
    }
  });

  app.post("/api/config-recommendations", async (request, response, next) => {
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const send = (event: object) => {
      if (!response.destroyed && !response.writableEnded) response.write(`${JSON.stringify(event)}\n`);
    };
    try {
      const input = configRecommendationInputSchema.parse(request.body);
      if (!dependencies.configRecommendations) {
        response.status(503).json({ error: "配置推荐服务尚未配置。" });
        return;
      }
      const signal = responseAbortSignal(response);
      const streaming = String(request.headers.accept ?? "").toLowerCase().includes("application/x-ndjson");
      if (streaming) {
        response.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
        response.setHeader("Cache-Control", "no-cache, no-transform");
        response.setHeader("X-Accel-Buffering", "no");
        response.flushHeaders?.();
        send({ type: "progress", phase: "preparing", message: "正在准备课题与上传材料" });
        heartbeat = setInterval(() => {
          if (!response.destroyed && !response.writableEnded) response.write("\n");
        }, 15_000);
        heartbeat.unref();
      }
      const attachments = input.inputUploadId ? await inputUploads.recommendationAttachments(input.inputUploadId) : [];
      const result = streaming
        ? await dependencies.configRecommendations.recommend(input, signal, attachments, (progress) => send({ type: "progress", ...progress }))
        : await dependencies.configRecommendations.recommend(input, signal, attachments);
      if (!response.destroyed) {
        if (streaming) {
          send({ type: "complete", result });
          response.end();
        } else response.json(result);
      }
    } catch (error) {
      if (response.headersSent) {
        send({ type: "error", message: redactTrace(error instanceof Error ? error.message : "推荐配置生成失败"),
          status: error instanceof ConfigRecommendationError ? error.status : error instanceof z.ZodError ? 400 : 500 });
        if (!response.destroyed && !response.writableEnded) response.end();
      } else if (error instanceof ConfigRecommendationError) {
        if (!response.destroyed) response.status(error.status).json({ error: redactTrace(error.message) });
      } else next(error);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  });

  const recommendationResources = (projectId?: string) => async () => {
    if (!projectId) return {};
    const project = await orchestrator.getProject(projectId);
    if (!project) throw new ConfigRecommendationError("Project not found", 404);
    return { skillDefinitions: project.skillDefinitions, mcpDefinitions: project.mcpDefinitions };
  };
  app.get("/api/agent-tool-recommendations/catalog", async (request, response, next) => {
    try {
      const { projectId } = z.object({ projectId: z.string().regex(/^prj_[a-f0-9]{32}$/).optional() }).strict().parse(request.query);
      if (!dependencies.agentToolRecommendations) { response.status(503).json({ error: "工具推荐服务尚未配置。" }); return; }
      response.json(await dependencies.agentToolRecommendations.catalog(recommendationResources(projectId)));
    } catch (error) {
      if (error instanceof ConfigRecommendationError) response.status(error.status).json({ error: redactTrace(error.message) });
      else next(error);
    }
  });
  app.post("/api/agent-tool-recommendations", async (request, response, next) => {
    try {
      const input = agentToolRecommendationInputSchema.parse(request.body);
      if (!dependencies.agentToolRecommendations) { response.status(503).json({ error: "工具推荐服务尚未配置。" }); return; }
      const attachments = input.inputUploadId ? await inputUploads.recommendationAttachments(input.inputUploadId) : [];
      const result = await dependencies.agentToolRecommendations.recommend(input, responseAbortSignal(response), attachments, recommendationResources(input.projectId));
      if (!response.destroyed) response.json(result);
    } catch (error) {
      if (error instanceof ConfigRecommendationError) {
        if (!response.destroyed) response.status(error.status).json({ error: redactTrace(error.message) });
      } else next(error);
    }
  });

  app.get("/api/health", async (_request, response) => {
    response.json({
      status: "ok",
      harnessVersion: dependencies.harnessVersion ?? "unknown",
      now: new Date().toISOString()
    });
  });

  // The directory contains names, descriptions and fixed URLs only.  The
  // shared bearer credential is intentionally resolved by the Harness runtime on the
  // server and is never exposed through this endpoint.
  app.get("/api/mcp-directory", (_request, response) => {
    response.json({ mcpDirectory: publicFixedMcpDirectory() });
  });

  // Global gateway library. Credentials never appear in list/get responses;
  // server-side probes/runners consume them directly, while the sole explicit
  // reveal action is isolated in the POST-only route below.
  app.get("/api/gateways", async (_request, response, next) => {
    try {
      response.json({
        gateways: await gatewayStore.list(),
        defaultGatewayId: await gatewayStore.defaultGatewayId()
      });
    } catch (error) {
      next(error);
    }
  });

  // Global GitHub account library. Tokens remain encrypted and server-only;
  // these routes expose identity/status facts and OAuth navigation only.
  app.get("/api/github/accounts", async (_request, response, next) => {
    try {
      const accounts = await githubAccounts.list();
      response.setHeader("Cache-Control", "no-store, private");
      response.json({
        accounts,
        defaultAccountId: accounts.find((account) => account.isDefault)?.id,
        oauthConfigured: githubAccounts.oauthConfigured()
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/github/auth/start", async (request, response) => {
    try {
      const headerOrigin = typeof request.headers.origin === "string"
        ? request.headers.origin
        : undefined;
      response.setHeader("Cache-Control", "no-store, private");
      response.json(githubAccounts.startAuthorization(headerOrigin));
    } catch (error) {
      const message = redactTrace(error instanceof Error ? error.message : "GitHub 登录启动失败");
      response.status(/尚未配置/.test(message) ? 503 : 400).json({ error: message });
    }
  });

  app.get("/api/github/auth/callback", async (request, response) => {
    let openerOrigin = "";
    try {
      const state = typeof request.query.state === "string" ? request.query.state : undefined;
      openerOrigin = githubAccounts.authorizationOpenerOrigin(state) ?? "";
      if (typeof request.query.error === "string") {
        githubAccounts.cancelAuthorization(state);
        throw new Error("GitHub 登录已取消或被拒绝");
      }
      const result = await githubAccounts.completeAuthorization({
        code: typeof request.query.code === "string" ? request.query.code : undefined,
        state
      });
      openerOrigin = result.openerOrigin;
      sendGitHubOAuthCallback(response, {
        openerOrigin,
        status: "success",
        message: `GitHub 账号 ${result.account.login} 已连接`
      });
    } catch (error) {
      // A failed callback may not have a trustworthy return origin. The page
      // remains self-contained and never reflects raw provider diagnostics.
      sendGitHubOAuthCallback(response, {
        openerOrigin,
        status: "error",
        message: redactTrace(error instanceof Error ? error.message : "GitHub 登录失败")
      });
    }
  });

  app.post("/api/github/accounts/:accountId/verify", async (request, response, next) => {
    try {
      response.json({ account: await githubAccounts.verify(request.params.accountId) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/github/accounts/:accountId/default", async (request, response, next) => {
    try {
      response.json({ account: await githubAccounts.setDefault(request.params.accountId) });
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/github/accounts/:accountId", async (request, response, next) => {
    try {
      const project = (await storage.listStates()).find(
        (state) => state.git?.account?.id === request.params.accountId
      );
      if (project) {
        response.status(409).json({
          error: `GitHub 账号仍被项目“${project.title}”绑定，不能移除`
        });
        return;
      }
      if (!(await githubAccounts.remove(request.params.accountId))) {
        response.status(404).json({ error: "GitHub account not found" });
        return;
      }
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/github/projects/:projectId/repository-status", async (request, response, next) => {
    try {
      const project = await storage.tryLoadState(request.params.projectId);
      const accountId = project?.git?.account?.id;
      const repository = project?.git?.repository;
      if (!project) {
        response.status(404).json({ error: "Project not found" });
        return;
      }
      if (!accountId || !repository) {
        response.status(409).json({ error: "项目尚未绑定 GitHub 仓库" });
        return;
      }
      response.setHeader("Cache-Control", "no-store, private");
      response.json({
        repository: await githubAccounts.observeRepository(
          accountId,
          repository.owner,
          repository.name
        )
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/gateways", async (request, response, next) => {
    try {
      const input = gatewayInputFromRequest(request.body);
      response.status(201).json({ gateway: await gatewayStore.create(input) });
    } catch (error) {
      next(error);
    }
  });

  // This is the only public route that can return a stored credential. It is
  // deliberately POST-only and non-cacheable so browser prefetchers, catalog
  // polling, and ordinary project snapshots can never reveal a key. The UI
  // calls it only after an explicit reveal/copy action and clears the value.
  app.post("/api/gateways/:gatewayId/credential/reveal", async (request, response, next) => {
    try {
      const gateway = await gatewayStore.get(request.params.gatewayId);
      if (!gateway) {
        response.status(404).json({ error: "Gateway not found" });
        return;
      }
      response.setHeader("Cache-Control", "no-store, private");
      response.setHeader("Pragma", "no-cache");
      response.json({ apiKey: gateway.apiKey });
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/gateways/:gatewayId", async (request, response, next) => {
    try {
      const current = await gatewayStore.get(request.params.gatewayId);
      if (!current) {
        response.status(404).json({ error: "Gateway not found" });
        return;
      }
      const input = gatewayInputFromRequest(request.body, current.apiKey);
      const gateway = await gatewayStore.update(request.params.gatewayId, input);
      if (!gateway) {
        response.status(404).json({ error: "Gateway not found" });
        return;
      }
      response.json({ gateway });
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/gateways/:gatewayId", async (request, response, next) => {
    try {
      if (!(await gatewayStore.delete(request.params.gatewayId))) {
        response.status(404).json({ error: "Gateway not found" });
        return;
      }
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/gateways/:gatewayId/default", async (request, response, next) => {
    try {
      response.json({ gateway: await gatewayStore.setDefault(request.params.gatewayId) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/gateways/:gatewayId/test", async (request, response, next) => {
    try {
      const signal = responseAbortSignal(response);
      const body = request.body && typeof request.body === "object" ? request.body as Record<string, unknown> : {};
      const model = typeof body.model === "string" ? body.model : undefined;
      const reasoningOptionId = typeof body.gatewayReasoningOption === "string"
        ? body.gatewayReasoningOption
        : undefined;
      let requestedHarness: string | undefined;
      if (body.harness !== undefined) {
        const knownHarnessIds = new Set((await harnessCatalog()).map((item) => item.id));
        if (typeof body.harness !== "string" || !knownHarnessIds.has(body.harness)) {
          throw new Error("不支持所选 harness");
        }
        requestedHarness = body.harness;
      }
      if (!wantsGatewayMatrixStream(request)) {
        const result = requestedHarness
          ? await gatewayStore.testHarness(request.params.gatewayId, requestedHarness, model, signal, undefined, reasoningOptionId)
          : await gatewayStore.test(request.params.gatewayId, undefined, model, signal, undefined, reasoningOptionId);
        response.json({ result, gateway: await gatewayStore.get(request.params.gatewayId).then((value) => value ? publicGateway(value) : undefined) });
        return;
      }

      response.status(200);
      response.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      response.setHeader("Cache-Control", "no-cache, no-transform");
      response.setHeader("X-Accel-Buffering", "no");
      response.flushHeaders?.();
      const result = requestedHarness
          ? await gatewayStore.testHarness(request.params.gatewayId, requestedHarness, model, signal, (stage) => {
            writeGatewayTestStreamEvent(response, { type: "stage", stage });
          }, reasoningOptionId)
        : await gatewayStore.test(request.params.gatewayId, undefined, model, signal, (stage) => {
            writeGatewayTestStreamEvent(response, { type: "stage", stage });
          }, reasoningOptionId);
      const gateway = await gatewayStore.get(request.params.gatewayId).then((value) => value ? publicGateway(value) : undefined);
      writeGatewayTestStreamEvent(response, { type: "result", result });
      writeGatewayTestStreamEvent(response, { type: "complete", gateway, result });
      response.end();
    } catch (error) {
      if (error instanceof GatewayProbeCancelledError) {
        if (!response.headersSent && !response.destroyed) response.status(499).json({ message: error.message });
        else if (!response.destroyed && !response.writableEnded) response.end();
        return;
      }
      if (response.headersSent) {
        writeGatewayTestStreamEvent(response, {
          type: "error",
          message: redactTrace(error instanceof Error ? error.message : "网关探测失败").slice(0, 500)
        });
        response.end();
        return;
      }
      next(error);
    }
  });

  app.post("/api/gateway-models/discover", async (request, response, next) => {
    try {
      const input = gatewayModelDiscoveryInputFromRequest(request.body);
      response.json({ models: await gatewayStore.discoverModels(input) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/gateways/:gatewayId/test-matrix", async (request, response, next) => {
    try {
      const signal = responseAbortSignal(response);
      const body = request.body && typeof request.body === "object" ? request.body as Record<string, unknown> : {};
      const requestedHarnesses = body.harnesses === undefined
        ? undefined
        : Array.isArray(body.harnesses) && body.harnesses.every((value) => typeof value === "string")
          ? body.harnesses as string[]
          : (() => { throw new Error("harnesses 必须是字符串数组"); })();
      const knownHarnessIds = new Set((await harnessCatalog()).map((item) => item.id));
      if (requestedHarnesses?.some((harness) => !knownHarnessIds.has(harness))) {
        throw new Error("不支持所选 harness");
      }
      const models = body.models === undefined
        ? undefined
        : Array.isArray(body.models) && body.models.every((value) => typeof value === "string")
          ? body.models as string[]
          : (() => { throw new Error("models 必须是字符串数组"); })();
      const reasoningOptions = body.reasoningOptions === undefined
        ? undefined
        : body.reasoningOptions && typeof body.reasoningOptions === "object" && !Array.isArray(body.reasoningOptions) &&
            Object.values(body.reasoningOptions).every((value) => value === null || typeof value === "string")
          ? body.reasoningOptions as Record<string, string | null>
          : (() => { throw new Error("reasoningOptions 必须是 model 到选项 id/null 的对象"); })();
      if (!wantsGatewayMatrixStream(request)) {
        const matrix = await gatewayStore.testMatrix(request.params.gatewayId, {
          harnesses: requestedHarnesses,
          models,
          reasoningOptions
        }, signal);
        response.json(matrix);
        return;
      }

      response.status(200);
      response.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      response.setHeader("Cache-Control", "no-cache, no-transform");
      response.setHeader("X-Accel-Buffering", "no");
      response.flushHeaders?.();
      const matrix = await gatewayStore.testMatrix(request.params.gatewayId, {
        harnesses: requestedHarnesses,
        models,
        reasoningOptions
      }, signal, (event) => {
        writeGatewayMatrixStreamEvent(response, event);
      });
      writeGatewayMatrixStreamEvent(response, { type: "complete", gateway: matrix.gateway, results: matrix.results });
      response.end();
    } catch (error) {
      if (error instanceof GatewayProbeCancelledError) {
        if (!response.headersSent && !response.destroyed) response.status(499).json({ message: error.message });
        else if (!response.destroyed && !response.writableEnded) response.end();
        return;
      }
      if (response.headersSent) {
        writeGatewayMatrixStreamEvent(response, {
          type: "error",
          message: redactTrace(error instanceof Error ? error.message : "网关矩阵探测失败").slice(0, 500)
        });
        response.end();
        return;
      }
      next(error);
    }
  });

  app.post("/api/gateways/:gatewayId/models/refresh", async (request, response, next) => {
    try {
      response.json({ gateway: await gatewayStore.refreshModels(request.params.gatewayId) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/runtime/catalog", async (_request, response, next) => {
    try {
      const harnesses = await harnessCatalog();
      response.json({
        harnesses,
        defaultHarnessId: harnesses.find((item) => item.default)?.id ?? DEFAULT_HARNESS_ID,
        protocols: AGENT_PROTOCOLS,
        routerCompatibilityVersion: PROTOCOL_ROUTER_COMPATIBILITY_VERSION,
        gateways: await gatewayStore.list(),
        defaultGatewayId: await gatewayStore.defaultGatewayId()
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/agent-config-presets", async (request, response, next) => {
    try {
      const presets = await configPresets.list();
      response.json({ presets: request.query.includeVisualizations === "true" ? presets : presets.filter((preset) => !preset.importSource) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/saved-research-tasks", async (_request, response, next) => {
    try {
      response.json({ tasks: await savedResearchTasks.list() });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/agent-config-presets/import", async (request, response, next) => {
    try {
      const input = parseWorkflowImport(request.body);
      response.status(201).json({ preset: await configPresets.create(input) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/agent-config-presets", async (request, response, next) => {
    try {
      const input = agentConfigPresetInputSchema.parse(request.body);
      response.status(201).json({ preset: await configPresets.create(input) });
    } catch (error) {
      next(error);
    }
  });

  app.get(
    "/api/saved-research-tasks/:taskId",
    async (request, response, next) => {
      try {
        const { taskId } = request.params;
        if (!/^task_[a-f0-9]{32}$/.test(taskId)) {
          response.status(400).json({ error: "Invalid saved research task id" });
          return;
        }
        const task = await savedResearchTasks.get(taskId);
        if (!task) {
          response.status(404).json({ error: "Saved research task not found" });
          return;
        }
        response.json({ task });
      } catch (error) {
        next(error);
      }
    }
  );

  app.post("/api/saved-research-tasks", async (request, response, next) => {
    try {
      const input = savedResearchTaskInputSchema.parse(request.body);
      response.status(201).json({ task: await savedResearchTasks.create(input) });
    } catch (error) {
      next(error);
    }
  });

  app.put(
    "/api/saved-research-tasks/:taskId",
    async (request, response, next) => {
      try {
        const { taskId } = request.params;
        if (!/^task_[a-f0-9]{32}$/.test(taskId)) {
          response.status(400).json({ error: "Invalid saved research task id" });
          return;
        }
        const input = savedResearchTaskInputSchema.parse(request.body);
        const task = await savedResearchTasks.update(taskId, input);
        if (!task) {
          response.status(404).json({ error: "Saved research task not found" });
          return;
        }
        response.json({ task });
      } catch (error) {
        next(error);
      }
    }
  );

  app.delete(
    "/api/saved-research-tasks/:taskId",
    async (request, response, next) => {
      try {
        const { taskId } = request.params;
        if (!/^task_[a-f0-9]{32}$/.test(taskId)) {
          response.status(400).json({ error: "Invalid saved research task id" });
          return;
        }
        if (!(await savedResearchTasks.delete(taskId))) {
          response.status(404).json({ error: "Saved research task not found" });
          return;
        }
        response.status(204).end();
      } catch (error) {
        next(error);
      }
    }
  );

  app.put("/api/agent-config-presets/:presetId", async (request, response, next) => {
    try {
      const { presetId } = request.params;
      if (presetId === "default") {
        response.status(409).json({ error: "系统默认配置不能覆盖更新" });
        return;
      }
      if (!/^cfg_[a-f0-9]{32}$/.test(presetId)) {
        response.status(400).json({ error: "Invalid Workflow config preset id" });
        return;
      }
      const input = agentConfigPresetInputSchema.parse(request.body);
      const preset = await configPresets.update(presetId, input);
      if (!preset) {
        response.status(404).json({ error: "Workflow config preset not found" });
        return;
      }
      response.json({ preset });
    } catch (error) {
      next(error);
    }
  });

  app.delete(
    "/api/agent-config-presets/:presetId",
    async (request, response, next) => {
      try {
        const { presetId } = request.params;
        if (presetId === "default") {
          response.status(409).json({ error: "系统默认配置不能删除" });
          return;
        }
        if (!/^cfg_[a-f0-9]{32}$/.test(presetId)) {
          response.status(400).json({ error: "Invalid Agent config preset id" });
          return;
        }
        if (!(await configPresets.delete(presetId))) {
          response.status(404).json({ error: "Agent config preset not found" });
          return;
        }
        response.status(204).end();
      } catch (error) {
        next(error);
      }
    }
  );

  app.post(
    "/api/projects/:projectId/agent-config-preset",
    async (request, response, next) => {
      try {
        const input = saveAgentConfigPresetSchema.parse(request.body ?? {});
        const project = await orchestrator.getProject(request.params.projectId);
        if (!project) throw new Error("Project not found");
        const preset = await configPresets.saveFromProject(project, input.name);
        response.status(201).json({ preset });
      } catch (error) {
        next(error);
      }
    }
  );

  app.get("/api/skills", async (_request, response, next) => {
    try {
      const publicSkills = (await skills.list()).map(
        ({ path: _path, ...skill }) => skill
      );
      const harnesses = await harnessCatalog();
      response.json({
        skills: publicSkills,
        models: config.modelSuggestions,
        gateways: await gatewayStore.list(),
        defaultGatewayId: await gatewayStore.defaultGatewayId(),
        harnesses,
        defaultHarnessId: harnesses.find((item) => item.default)?.id ?? DEFAULT_HARNESS_ID,
        protocols: AGENT_PROTOCOLS,
        routerCompatibilityVersion: PROTOCOL_ROUTER_COMPATIBILITY_VERSION,
        agentPrompts: BUILTIN_AGENT_PROMPTS,
        mainSystemPrompt: MAIN_SYSTEM_PROMPT,
        mcpDirectory: publicFixedMcpDirectory()
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/skills/resolve", async (request, response) => {
    try {
      const input = skillInputSchema.parse(request.body);
      const { path: _path, ...skill } = await skills.resolveInput(input.skill);
      response.json({ skill });
    } catch (error) {
      response.status(400).json({
        error: error instanceof Error ? error.message : "Skill 解析失败"
      });
    }
  });

  app.post("/api/skills", async (request, response) => {
    try {
      const input = createUserSkillSchema.parse(request.body);
      const { path: _path, ...skill } = await skills.createUserSkill(input);
      response.status(201).json({ skill });
    } catch (error) {
      response.status(400).json({
        error: error instanceof Error ? error.message : "Skill 创建失败"
      });
    }
  });

  app.get("/api/projects", async (request, response, next) => {
    try {
      const includeArchived = request.query.includeArchived === "true";
      const projects = await orchestrator.listProjects(includeArchived);
      response.json({
        projects: request.query.view === "summary" ? projects.map(projectListSummary) : projects
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/queue", (_request, response) => {
    response.json(orchestrator.getQueueSnapshot());
  });

  app.post("/api/project-input-uploads", async (_request, response, next) => {
    try {
      response.status(201).json({ uploadId: await inputUploads.create() });
    } catch (error) { next(error); }
  });

  app.put("/api/project-input-uploads/:uploadId/files", async (request, response, next) => {
    try {
      await inputUploads.put(String(request.params.uploadId), request.query.path, request);
      response.status(204).end();
    } catch (error) { next(error); }
  });

  app.get("/api/project-input-uploads/:uploadId/files", async (request, response, next) => {
    try { response.json({ files: await inputUploads.list(String(request.params.uploadId)) }); }
    catch (error) { next(error); }
  });

  app.delete("/api/project-input-uploads/:uploadId/files", async (request, response, next) => {
    try {
      await inputUploads.removeFile(String(request.params.uploadId), request.query.path);
      response.status(204).end();
    } catch (error) { next(error); }
  });

  app.post(["/api/project-input-uploads/:uploadId/open-directory", "/api/project-input-uploads/:uploadId/open-explorer"], async (request, response, next) => {
    try {
      if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "")) {
        response.status(403).json({ error: "只能从本机打开系统文件管理器" });
        return;
      }
      await inputUploads.openDirectory(String(request.params.uploadId));
      response.status(204).end();
    } catch (error) { next(error); }
  });

  app.delete("/api/project-input-uploads/:uploadId", async (request, response, next) => {
    try {
      await inputUploads.discard(String(request.params.uploadId));
      response.status(204).end();
    } catch (error) { next(error); }
  });

  app.post("/api/projects", async (request, response, next) => {
    const uploadId = request.body?.inputUploadId;
    let sealed = false;
    try {
      const files = uploadId ? await inputUploads.seal(uploadId) : undefined;
      sealed = !!uploadId;
      const project = await orchestrator.createProject(request.body, uploadId ? {
        files: files ?? [],
        install: (projectId) => inputUploads.install(uploadId, storage.projectDir(projectId))
      } : undefined);
      const conversationId = typeof request.body.explainerConversationId === "string" ? request.body.explainerConversationId
        : typeof request.body.sourceSavedTaskId === "string" ? await projectExplainer?.assistant?.resolve(request.body.sourceSavedTaskId) : undefined;
      if (conversationId && /^(?:exp|prj)_[a-f0-9]{32}$/.test(conversationId)) {
        await projectExplainer?.bindAssistantProject?.(conversationId, project.id).catch(error => {
          console.warn("Project created; Explainer association needs retry:", redactTrace(error instanceof Error ? error.message : String(error)));
        });
      }
      if (uploadId) void inputUploads.discard(uploadId).catch(() => undefined);
      response.status(202).json({ project });
    } catch (error) {
      if (sealed) inputUploads.unseal(uploadId);
      next(error);
    }
  });

  app.post("/api/projects/:projectId/git/retry", async (request, response, next) => {
    try {
      const project = await orchestrator.retryGitInitialization(request.params.projectId);
      response.status(202).json({ project });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/projects/archive/batch", async (request, response, next) => {
    try {
      const { projectIds } = batchProjectIdsSchema.parse(request.body);
      const results = [];
      for (const projectId of projectIds) {
        try {
          const project = await orchestrator.archive(projectId);
          results.push({ projectId, ok: true as const, project });
        } catch (error) {
          results.push({
            projectId,
            ok: false as const,
            error: redactTrace(error instanceof Error ? error.message : "Unknown error")
          });
        }
      }
      response.json({
        successCount: results.filter((item) => item.ok).length,
        failureCount: results.filter((item) => !item.ok).length,
        results
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/projects/delete/batch", async (request, response, next) => {
    try {
      const { projectIds } = batchDeleteArchivedProjectsSchema.parse(request.body);
      const results = [];
      for (const projectId of projectIds) {
        try {
          if (projectExplainer?.isActive(projectId)) {
            throw new Error("Project explainer has an active turn and cannot be deleted");
          }
          await orchestrator.deleteArchivedConfirmed(projectId);
          results.push({ projectId, ok: true as const });
        } catch (error) {
          results.push({
            projectId,
            ok: false as const,
            error: redactTrace(error instanceof Error ? error.message : "Unknown error")
          });
        }
      }
      response.json({
        successCount: results.filter((item) => item.ok).length,
        failureCount: results.filter((item) => !item.ok).length,
        results
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/projects/:projectId", async (request, response, next) => {
    try {
      const projectId = request.params.projectId;
      const getProjectAllowingRecovery = async () => {
        try {
          return await orchestrator.getProject(projectId);
        } catch (error) {
          // A restore failure can resolve its storage barrier one microtask
          // before the orchestrator publishes storage-recovery-required.
          await new Promise<void>((resolve) => setImmediate(resolve));
          try {
            const recovery = await orchestrator.getProject(projectId);
            if (recovery?.phase === "storage-recovery-required") {
              return recovery;
            }
          } catch {
            // Preserve the original storage error if recovery was not exposed.
          }
          throw error;
        }
      };
      const preliminary = await getProjectAllowingRecovery();
      if (!preliminary) {
        response.status(404).json({ error: "Project not found" });
        return;
      }
      if (request.query.view === "state") {
        response.json({ project: preliminary });
        return;
      }
      if (preliminary.phase === "storage-recovery-required") {
        response.json({
          project: preliminary,
          events: [],
          artifacts: [],
          storageRecoveryRequired: true
        });
        return;
      }
      try {
        const snapshot = await storage.withStableProjectSnapshot(
          projectId,
          async () => {
            const project = await orchestrator.getProject(projectId);
            if (!project) return undefined;
            const [events, artifactPage] = await Promise.all([
              storage.readEvents(project.id, 0, config.maxEventHistory),
              storage.listArtifactPage(project.id, { offset: 0, limit: 200 })
            ]);
            return { project, events, artifacts: artifactPage.artifacts };
          }
        );
        if (!snapshot) {
          response.status(404).json({ error: "Project not found" });
          return;
        }
        response.json(snapshot);
      } catch (error) {
        const recovery = await getProjectAllowingRecovery();
        if (recovery?.phase !== "storage-recovery-required") throw error;
        response.json({
          project: recovery,
          events: [],
          artifacts: [],
          storageRecoveryRequired: true
        });
      }
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/projects/:projectId/git/graph", async (request, response, next) => {
    try {
      const query = gitGraphQuerySchema.parse(request.query);
      const graph = await orchestrator.getProjectGitGraph(
        request.params.projectId,
        query
      );
      response.setHeader("Cache-Control", "no-store, private");
      response.json(graph);
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/projects/:projectId", async (request, response, next) => {
    try {
      const { confirmation } = deleteArchivedProjectSchema.parse(request.body);
      if (projectExplainer?.isActive(request.params.projectId)) {
        throw new Error("Project explainer has an active turn and cannot be deleted");
      }
      await orchestrator.deleteArchived(request.params.projectId, confirmation);
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.get(
    "/api/projects/:projectId/events/bootstrap",
    async (request, response, next) => {
      try {
        const project = await orchestrator.getProject(request.params.projectId);
        if (!project) {
          response.status(404).json({ error: "Project not found" });
          return;
        }
        response.json(
          await storage.readEventBootstrap(
            project.id,
            eventPageLimit(request.query.limit)
          )
        );
      } catch (error) {
        next(error);
      }
    }
  );

  app.get(
    "/api/projects/:projectId/events/history",
    async (request, response, next) => {
      try {
        const project = await orchestrator.getProject(request.params.projectId);
        if (!project) {
          response.status(404).json({ error: "Project not found" });
          return;
        }
        const beforeSeq = Number.parseInt(String(request.query.before ?? ""), 10);
        if (!Number.isSafeInteger(beforeSeq) || beforeSeq < 1) {
          response.status(400).json({ error: "before must be a positive event sequence" });
          return;
        }
        response.json(
          await storage.readEventHistory(
            project.id,
            beforeSeq,
            eventPageLimit(request.query.limit)
          )
        );
      } catch (error) {
        next(error);
      }
    }
  );

  app.get(
    "/api/projects/:projectId/events",
    async (request, response, next) => {
      try {
        const project = await orchestrator.getProject(request.params.projectId);
        if (!project) {
          response.status(404).json({ error: "Project not found" });
          return;
        }
        const queryAfter = Number.parseInt(String(request.query.after ?? "0"), 10);
        const headerAfter = Number.parseInt(
          request.header("last-event-id") ?? "0",
          10
        );
        let lastSent = Math.max(
          Number.isFinite(queryAfter) ? queryAfter : 0,
          Number.isFinite(headerAfter) ? headerAfter : 0
        );
        response.status(200);
        response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        response.setHeader("Cache-Control", "no-cache, no-transform");
        response.setHeader("Connection", "keep-alive");
        response.setHeader("X-Accel-Buffering", "no");
        response.flushHeaders();
        response.write(": connected\n\n");

        let closed = false;
        let replaying = true;
        const replayController = new AbortController();
        const pending: TimelineEvent[] = [];
        const waitForDrainOrClose = () =>
          new Promise<void>((resolve) => {
            const finish = () => {
              response.off("drain", finish);
              request.off("close", finish);
              resolve();
            };
            response.once("drain", finish);
            request.once("close", finish);
          });
        const send = async (event: TimelineEvent): Promise<boolean> => {
          if (
            event.seq <= lastSent ||
            closed ||
            response.writableEnded ||
            response.destroyed
          ) {
            return false;
          }
          lastSent = event.seq;
          const frame =
            `id: ${event.seq}\n` +
            `event: ${event.type}\n` +
            `data: ${JSON.stringify(event)}\n\n`;
          if (!response.write(frame)) {
            await waitForDrainOrClose();
          }
          return !closed;
        };

        let queuedLiveEvents = 0;
        let liveQueue = Promise.resolve();
        const enqueueLive = (event: TimelineEvent) => {
          if (closed) return;
          if (queuedLiveEvents >= MAX_PENDING_SSE_EVENTS) {
            closed = true;
            replayController.abort();
            response.end();
            return;
          }
          queuedLiveEvents += 1;
          liveQueue = liveQueue
            .then(async () => {
              await send(event);
            })
            .catch(() => {
              closed = true;
              replayController.abort();
              if (!response.writableEnded) response.end();
            })
            .finally(() => {
              queuedLiveEvents -= 1;
            });
        };
        const unsubscribe = eventHub.subscribe(project.id, (event) => {
          if (replaying) {
            if (pending.length >= MAX_PENDING_SSE_EVENTS) {
              closed = true;
              replayController.abort();
              response.end();
              return;
            }
            pending.push(event);
          } else {
            enqueueLive(event);
          }
        });
        let pendingLiveSnapshot: ReturnType<EventHub["liveSnapshot"]> | undefined;
        let sendingLiveSnapshot = false;
        const flushLiveSnapshots = async () => {
          if (sendingLiveSnapshot) return;
          sendingLiveSnapshot = true;
          try {
            while (
              pendingLiveSnapshot &&
              !closed &&
              !response.writableEnded &&
              !response.destroyed
            ) {
              const snapshot = pendingLiveSnapshot;
              pendingLiveSnapshot = undefined;
              const frame =
                `event: live.snapshot\n` +
                `data: ${JSON.stringify(snapshot)}\n\n`;
              if (!response.write(frame)) await waitForDrainOrClose();
            }
          } finally {
            sendingLiveSnapshot = false;
            if (pendingLiveSnapshot && !closed) {
              void flushLiveSnapshots();
            }
          }
        };
        const sendLiveSnapshot = (snapshot: ReturnType<EventHub["liveSnapshot"]>) => {
          // A slow browser needs only the newest ephemeral snapshot. Durable
          // timeline events keep their independent ordered queue above.
          pendingLiveSnapshot = snapshot;
          void flushLiveSnapshots().catch(() => {
            closed = true;
            replayController.abort();
            if (!response.writableEnded) response.end();
          });
        };
        const unsubscribeLive = eventHub.subscribeLive(
          project.id,
          sendLiveSnapshot
        );
        sendLiveSnapshot(eventHub.liveSnapshot(project.id));

        const heartbeat = setInterval(() => {
          if (
            !closed &&
            !response.writableEnded &&
            !response.writableNeedDrain
          ) {
            response.write(`: heartbeat ${Date.now()}\n\n`);
          }
        }, 15_000);
        heartbeat.unref();
        request.on("close", () => {
          closed = true;
          replayController.abort();
          clearInterval(heartbeat);
          unsubscribe();
          unsubscribeLive();
          if (!response.writableEnded) response.end();
        });

        await storage.replayEvents(
          project.id,
          lastSent,
          send,
          replayController.signal
        );
        while (pending.length > 0 && !closed) {
          const batch = pending.splice(0).sort((a, b) => a.seq - b.seq);
          for (const event of batch) {
            await send(event);
          }
        }
        replaying = false;
      } catch (error) {
        if (!response.headersSent) next(error);
        else response.end();
      }
    }
  );

  app.get(
    "/api/projects/:projectId/artifacts",
    async (request, response, next) => {
      try {
        const project = await orchestrator.getProject(request.params.projectId);
        if (!project) {
          response.status(404).json({ error: "Project not found" });
          return;
        }
        const rawAgent = request.query.agent;
        const agent =
          rawAgent === undefined ? undefined : String(rawAgent);
        const scope = request.query.scope === "project" ? "project" as const : undefined;
        if (request.query.scope !== undefined && !scope) {
          response.status(400).json({ error: "Invalid artifact scope" }); return;
        }
        if (agent !== undefined && !project.agents[agent] &&
          !(agent === "shared" && !project.git?.enabled) &&
          !project.artifacts?.some((artifact) => artifact.agent === agent)) {
          response.status(400).json({ error: "Invalid artifact agent" });
          return;
        }
        if (request.query.view === "summary") {
          response.json(await storage.listArtifactSummary(project.id, { scope }));
          return;
        }
        const parseNonNegative = (value: unknown, fallback: number) => {
          const parsed = Number.parseInt(String(value ?? ""), 10);
          return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
        };
        if (request.query.view === "directory") {
          if (!agent && scope !== "project") {
            response.status(400).json({ error: "Artifact directory requires an agent" });
            return;
          }
          const directory = String(request.query.directory ?? "");
          if (directory.length > 4_096) {
            response.status(400).json({ error: "Artifact directory path is too long" });
            return;
          }
          try {
            response.json(
              await storage.listArtifactDirectory(
                project.id,
                agent ?? "shared",
                directory,
                {
                  offset: parseNonNegative(request.query.offset, 0),
                  limit: parseNonNegative(request.query.limit, 50) || 50,
                  scope
                }
              )
            );
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "ENOENT" || code === "ENOTDIR") {
              response.status(404).json({ error: "Artifact directory not found" });
              return;
            }
            const message = error instanceof Error ? error.message : "";
            if (/Invalid relative path|Path traversal/.test(message)) {
              response.status(400).json({ error: "Invalid artifact directory" });
              return;
            }
            throw error;
          }
          return;
        }
        const page = await storage.listArtifactPage(project.id, {
          agent: agent as AgentName | undefined,
          offset: parseNonNegative(request.query.offset, 0),
          limit: parseNonNegative(request.query.limit, 100) || 100,
          query: String(request.query.q ?? "").trim().slice(0, 200),
          scope
        });
        response.json(page);
      } catch (error) {
        next(error);
      }
    }
  );

  app.get(
    "/api/projects/:projectId/artifacts/content",
    async (request, response, next) => {
      try {
        const project = await orchestrator.getProject(request.params.projectId);
        if (!project) {
          response.status(404).json({ error: "Project not found" });
          return;
        }
        const artifactPath = String(request.query.path ?? "");
        const origin = String(request.query.origin ?? "workspace");
        if (origin !== "workspace") {
          response.status(400).json({ error: "Invalid artifact origin" });
          return;
        }
        let mediaType = "text/plain";
        let content: Buffer;
        const rawAgent = request.query.agent;
        const agent = String(rawAgent ?? "");
        const workspaceId = request.query.workspaceId === undefined ? undefined : String(request.query.workspaceId);
        if (workspaceId !== undefined && !/^(?:shared|repository|worktree_[a-f0-9]{24})$/.test(workspaceId)) {
          response.status(400).json({ error: "Invalid workspace source" }); return;
        }
        if (!workspaceId && !project.agents[agent] && !(agent === "shared" && !project.git?.enabled) &&
          !project.artifacts?.some((artifact) => artifact.agent === agent)) {
          response.status(400).json({ error: "Workspace artifact agent is required" });
          return;
        }
        const artifactId = request.query.artifactId === undefined
          ? undefined
          : String(request.query.artifactId);
        const commitSha = request.query.commitSha === undefined
          ? undefined
          : String(request.query.commitSha);
        if (artifactId !== undefined && (!artifactId || artifactId.length > 512)) {
          response.status(400).json({ error: "Invalid artifact identity" });
          return;
        }
        if (commitSha !== undefined && !/^[a-f0-9]{40,64}$/.test(commitSha)) {
          response.status(400).json({ error: "Invalid artifact commit" });
          return;
        }
        const exactBinding = artifactId || commitSha
          ? { artifactId, commitSha }
          : undefined;
        if (workspaceId && exactBinding) {
          response.status(400).json({ error: "A live workspace read cannot replace an immutable publication binding" }); return;
        }
        const workspaceArtifact = workspaceId ? await storage.resolveBrowserWorkspaceFile(project.id, workspaceId, artifactPath) : await storage.resolveWorkspaceArtifact(
          request.params.projectId,
          agent,
          artifactPath,
          exactBinding
        );
        const isDisplayed = !workspaceId && project.display && [
          project.display.primary,
          ...project.display.items
        ].some((item) =>
          item.agent === agent && item.path === workspaceArtifact.relativePath
        );
        const published = !workspaceId ? project.artifacts?.filter((artifact) =>
          artifact.agent === agent &&
          artifact.path === workspaceArtifact.relativePath &&
          (!project.git?.enabled || ((!artifactId || artifact.id === artifactId) &&
          (!commitSha || artifact.gitSource?.commitSha === commitSha)))
        ).reverse().sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).at(0) : undefined;
        if (isDisplayed && !published) {
          response.status(409).json({
            error: "Displayed artifact is no longer present in the published catalog"
          });
          return;
        }
        if (published) {
          try {
            await storage.resolvePublishedArtifactRecord(
              request.params.projectId,
              published
            );
          } catch {
            response.status(409).json({
              error: "Published artifact changed after publication and must be republished"
            });
            return;
          }
        }
        mediaType = workspaceArtifact.mediaType;
        const download = request.query.download === "1";
        if (download || isBrowserInlineMediaType(mediaType)) {
          response.setHeader("Content-Type", mediaType);
          response.setHeader("Content-Length", String(workspaceArtifact.size));
          response.setHeader(
            "Content-Disposition",
            `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(path.basename(artifactPath))}`
          );
          const stream = createReadStream(workspaceArtifact.sourcePath);
          stream.on("error", (streamError) => {
            if (response.headersSent) response.destroy(streamError);
            else next(streamError);
          });
          stream.pipe(response);
          return;
        }
        if (
          workspaceArtifact.size > MAX_ARTIFACT_PREVIEW_BYTES ||
          !isTextArtifactMediaType(mediaType)
        ) {
          response.status(415).json({
            error: "This workspace file is available for download but not text preview"
          });
          return;
        }
        content = workspaceId ? await readFile(workspaceArtifact.sourcePath) : (
          await storage.readWorkspaceArtifact(
            request.params.projectId,
            agent,
            artifactPath,
            exactBinding
          )
        ).content;
        response.type(mediaType);
        response.setHeader(
          "Content-Disposition",
          `${request.query.download === "1" ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(path.basename(artifactPath))}`
        );
        response.send(content);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          response.status(404).json({ error: "Artifact not found" });
          return;
        }
        if (error instanceof Error && /Invalid relative path|Path traversal/.test(error.message)) {
          response.status(400).json({ error: "Invalid artifact path" }); return;
        }
        next(error);
      }
    }
  );

  app.post(
    "/api/projects/:projectId/user-inputs",
    async (request, response, next) => {
      try {
        const input = projectUserInputSchema.parse(request.body);
        const project = await orchestrator.addProjectUserInput(
          request.params.projectId,
          input.message,
          input.mode,
          input.requestId
        );
        response.status(202).json({ project });
      } catch (error) {
        next(error);
      }
    }
  );

  app.post("/api/projects/:projectId/execution-summaries/:invocationId", async (request, response, next) => {
    try {
      if (!/^inv_[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(request.params.invocationId)) {
        response.status(400).json({ error: "Invalid invocation id" });
        return;
      }
      if (!await storage.tryLoadState(request.params.projectId)) {
        response.status(404).json({ error: "Project not found" });
        return;
      }
      if (!dependencies.executionSummaries) {
        response.status(503).json({ error: "执行摘要服务不可用" });
        return;
      }
      response.json(await dependencies.executionSummaries.ensure(
        request.params.projectId, request.params.invocationId, request.body?.retry === true));
    } catch (error) { next(error); }
  });

  app.get(
    "/api/projects/:projectId/explainer/config",
    async (request, response, next) => {
      try {
        const project = await orchestrator.getProject(request.params.projectId);
        if (!project) {
          response.status(404).json({ error: "Project not found" });
          return;
        }
        if (!projectExplainer?.getConfig) {
          response.status(503).json({ error: "Project explainer configuration is not available" });
          return;
        }
        response.json({ config: await projectExplainer.getConfig(project.id) });
      } catch (error) {
        next(error);
      }
    }
  );

  app.patch(
    "/api/projects/:projectId/explainer/config",
    async (request, response, next) => {
      try {
        const project = await orchestrator.getProject(request.params.projectId);
        if (!project) {
          response.status(404).json({ error: "Project not found" });
          return;
        }
        if (!projectExplainer?.updateConfig) {
          response.status(503).json({ error: "Project explainer configuration is not available" });
          return;
        }
        const input = projectExplainerConfigSchema.parse(request.body);
        try {
          response.json({ config: await projectExplainer.updateConfig(project.id, input) });
        } catch (error) {
          if (error instanceof ProjectExplainerHarnessSwitchConfirmationError) {
            response.status(409).json({
              error: error.message,
              code: "explainer_harness_switch_confirmation_required"
            });
            return;
          }
          if (error instanceof ProjectExplainerConfigurationError) {
            response.status(400).json({
              error: error.message,
              code: "explainer_configuration_invalid"
            });
            return;
          }
          throw error;
        }
      } catch (error) {
        next(error);
      }
    }
  );

  app.get(
    "/api/projects/:projectId/explainer/history",
    async (request, response, next) => {
      try {
        const project = await orchestrator.getProject(request.params.projectId);
        if (!project) {
          response.status(404).json({ error: "Project not found" });
          return;
        }
        if (!projectExplainer) {
          response.status(503).json({ error: "Project explainer is not configured" });
          return;
        }
        const parsedLimit = Number.parseInt(String(request.query.limit ?? ""), 10);
        const limit = Number.isSafeInteger(parsedLimit)
          ? Math.min(5_000, Math.max(1, parsedLimit))
          : 2_000;
        response.json(await projectExplainer.history(project.id, limit));
      } catch (error) {
        next(error);
      }
    }
  );

  app.post(
    "/api/projects/:projectId/explainer/reset",
    async (request, response, next) => {
      try {
        const project = await orchestrator.getProject(request.params.projectId);
        if (!project) {
          response.status(404).json({ error: "Project not found" });
          return;
        }
        if (!projectExplainer) {
          response.status(503).json({ error: "Project explainer is not configured" });
          return;
        }
        try {
          await projectExplainer.reset(project.id);
        } catch (error) {
          if (error instanceof ProjectExplainerBusyError) {
            response.status(409).json({
              error: "Project explainer already has an active turn"
            });
            return;
          }
          throw error;
        }
        response.status(204).end();
      } catch (error) {
        next(error);
      }
    }
  );

  app.post(
    "/api/projects/:projectId/explainer/turns/cancel",
    async (request, response, next) => {
      try {
        const project = await orchestrator.getProject(request.params.projectId);
        if (!project) {
          response.status(404).json({ error: "Project not found" });
          return;
        }
        if (!projectExplainer) {
          response.status(503).json({ error: "Project explainer is not configured" });
          return;
        }
        await projectExplainer.cancel(project.id);
        response.status(204).end();
      } catch (error) {
        next(error);
      }
    }
  );

  app.post(
    "/api/projects/:projectId/explainer/turns",
    async (request, response, next) => {
      try {
        const input = projectExplainerQuestionSchema.parse(request.body);
        const project = await orchestrator.getProject(request.params.projectId);
        if (!project) {
          response.status(404).json({ error: "Project not found" });
          return;
        }
        if (!projectExplainer) {
          response.status(503).json({ error: "Project explainer is not configured" });
          return;
        }
        if (projectExplainer.isActive(project.id)) {
          response.status(409).json({ error: "Project explainer already has an active turn" });
          return;
        }

        response.status(200);
        response.setHeader(
          "Content-Type",
          "application/x-ndjson; charset=utf-8"
        );
        response.setHeader("Cache-Control", "no-cache, no-transform");
        response.setHeader("Connection", "keep-alive");
        response.setHeader("X-Accel-Buffering", "no");
        response.flushHeaders();
        const controller = new AbortController();
        let disconnected = false;
        const disconnect = () => {
          disconnected = true;
          controller.abort();
        };
        request.once("aborted", disconnect);
        response.once("close", () => {
          if (!response.writableEnded) disconnect();
        });
        const send = async (event: ProjectExplainerEvent) => {
          if (
            disconnected ||
            response.writableEnded ||
            response.destroyed
          ) {
            return;
          }
          if (!response.write(`${JSON.stringify(event)}\n`)) {
            await waitForResponseDrain(response, controller.signal);
          }
        };
        try {
          await projectExplainer.ask(
            project.id,
            input.question,
            send,
            controller.signal
          );
        } catch (error) {
          if (error instanceof ProjectExplainerBusyError) {
            await send({
              id: `explainer_event_${Date.now()}`,
              projectId: project.id,
              turnId: `explainer_turn_${Date.now()}`,
              kind: "error",
              text: error.message,
              ts: new Date().toISOString(),
              phase: "completed"
            });
          } else if (!controller.signal.aborted) {
            throw error;
          }
        } finally {
          request.off("aborted", disconnect);
          if (!response.writableEnded && !response.destroyed) response.end();
        }
      } catch (error) {
        if (response.headersSent) {
          if (!response.writableEnded) response.end();
          return;
        }
        next(error);
      }
    }
  );

  app.get("/api/projects/:projectId/workflow/adjustments", async (request, response, next) => {
    response.setHeader("Cache-Control", "no-store, private");
    try {
      const result = await orchestrator.queryWorkflowAdjustments(request.params.projectId, request.get("If-None-Match"));
      if (result.etag) response.setHeader("ETag", result.etag);
      if (!result.context) response.status(304).end();
      else response.json(result.context);
    }
    catch (error) { next(error); }
  });

  app.get("/api/projects/:projectId/workflow/adjustments/history", async (request, response, next) => {
    response.setHeader("Cache-Control", "no-store, private");
    try {
      const input = workflowAdjustmentPageSchema.parse(request.query);
      const result = await orchestrator.getWorkflowAdjustmentPage(request.params.projectId, input, request.get("If-None-Match"));
      response.setHeader("ETag", result.etag);
      if (!result.page) response.status(304).end(); else response.json(result.page);
    } catch (error) { next(error); }
  });

  app.get("/api/projects/:projectId/workflow/adjustments/requests/:requestId", async (request, response, next) => {
    response.setHeader("Cache-Control", "no-store, private");
    try {
      const query = workflowAdjustmentDetailQuerySchema.parse(request.query);
      response.json(await orchestrator.getWorkflowAdjustmentDetail(request.params.projectId, request.params.requestId, query.expectedVersion));
    } catch (error) { next(error); }
  });

  app.post("/api/projects/:projectId/workflow/adjustments", async (request, response, next) => {
    response.setHeader("Cache-Control", "no-store, private");
    try {
      const body = workflowAdjustmentSubmissionBodySchema.parse(request.body);
      const result = await orchestrator.submitWorkflowAdjustment(request.params.projectId, { ...body, projectId: request.params.projectId });
      response.status(result.replay ? 200 : 202).json(result);
    } catch (error) { next(error); }
  });

  app.post("/api/projects/:projectId/workflow/adjustments/:requestId/withdraw", async (request, response, next) => {
    response.setHeader("Cache-Control", "no-store, private");
    try {
      const body = workflowAdjustmentWithdrawalBodySchema.parse(request.body);
      response.json(await orchestrator.withdrawWorkflowAdjustment(request.params.projectId,
        { ...body, projectId: request.params.projectId, requestId: request.params.requestId }));
    } catch (error) { next(error); }
  });

  app.patch(
    "/api/projects/:projectId/agents/models",
    async (request, response, next) => {
      try {
        const input = updateAgentModelsSchema.parse(request.body);
        const project = await orchestrator.updateAgentModels(
          request.params.projectId,
          input.models
        );
        response.json({ project });
      } catch (error) {
        next(error);
      }
    }
  );

  app.patch(
    "/api/projects/:projectId/agents/config",
    async (request, response, next) => {
      try {
        const input = updateAgentConfigsSchema.parse(request.body);
        const project = await orchestrator.updateAgentConfigs(
          request.params.projectId,
          input.agents
        );
        response.json({ project });
      } catch (error) {
        next(error);
      }
    }
  );

  app.patch(
    "/api/projects/:projectId/workflow/collaboration-groups",
    async (request, response, next) => {
      try {
        const input = updateCollaborationGroupSchema.parse(request.body);
        const project = await orchestrator.updateCollaborationGroup(
          request.params.projectId,
          input
        );
        response.json({ project });
      } catch (error) {
        next(error);
      }
    }
  );

  app.post(
    "/api/projects/:projectId/intervention/respond",
    async (request, response, next) => {
      try {
        const input = userInterventionResponseSchema.parse(request.body);
        const project = await orchestrator.respondToUserIntervention(
          request.params.projectId,
          input.message
        );
        response.json({ project });
      } catch (error) {
        next(error);
      }
    }
  );

  app.get("/api/projects/:projectId/checkpoints/:checkpointId", async (request, response, next) => {
    try {
      response.json(await storage.readWorkspaceCheckpoint(request.params.projectId, request.params.checkpointId));
    } catch (error) { next(error); }
  });

  for (const action of [
    "pause",
    "resume",
    "cancel",
    "archive",
    "unarchive"
  ] as const) {
    app.post(
      `/api/projects/:projectId/${action}`,
      async (request, response, next) => {
        try {
          const project = action === "cancel"
            ? await orchestrator.cancel(request.params.projectId, cancelProjectSchema.parse(request.body ?? {}))
            : action === "resume" && resumeProjectSchema.parse(request.body ?? {}).preserveRecoveryBudget
              ? await orchestrator.resume(request.params.projectId, { preserveRecoveryBudget: true })
            : await orchestrator[action](request.params.projectId);
          response.json({ project });
        } catch (error) {
          next(error);
        }
      }
    );
  }

  const staticDir = findWebDist();
  if (staticDir) {
    app.use(express.static(staticDir, { index: false }));
    app.get(/^(?!\/api\/).*/, (_request, response) => {
      response.sendFile(path.join(staticDir, "index.html"));
    });
  } else {
    app.get("/", (_request, response) => {
      response
        .status(200)
        .type("text/plain")
        .send("ScienceEvolve API is running. Start the Vite web client in development.");
    });
  }

  const notFound = (request: Request, response: Response) => {
    response.status(404).json({ error: `Route not found: ${request.path}` });
  };
  app.use(notFound);

  const errorHandler: ErrorRequestHandler = (
    error: unknown,
    _request: Request,
    response: Response,
    _next: NextFunction
  ) => {
    if (response.headersSent) return;
    if (error && typeof error === "object" && "type" in error && error.type === "entity.too.large") {
      response.status(413).json({ error: "请求内容超过此接口允许的大小", code: "request_body_too_large" });
      return;
    }
    if (error instanceof CollaborationStateError && error.code === "INVALID_STATE_TRANSITION" &&
      /^\/api\/projects\/[^/]+\/(?:pause|resume|cancel)$/.test(_request.path)) {
      response.status(409).json({ error: redactTrace(error.message), code: error.code });
      return;
    }
    if (error instanceof CollaborationStateError && /^\/api\/projects\/[^/]+\/workflow\/adjustments(?:\/|$)/.test(_request.path)) {
      const status = ["PROJECT_NOT_FOUND", "RECORD_NOT_FOUND"].includes(error.code) ? 404
        : ["UNSAFE_CONFIGURATION", "CREDENTIAL_DATA_REJECTED"].includes(error.code) ? 400
        : ["WRITER_LEASE_HELD", "WRITER_LEASE_STALE"].includes(error.code) ? 503
        : error.code === "DATABASE_INTEGRITY_FAILED" ? 500 : 409;
      response.status(status).json({ error: redactTrace(error.message), code: error.code,
        ...(["STALE_WORKFLOW_CONFIGURATION", "WORKFLOW_ADJUSTMENT_CONFLICT"].includes(error.code) ? { details: error.details } : {}) });
      return;
    }
    if (error instanceof ZodError) {
      const issueSummary = [...new Set(error.issues.map((issue) => {
        const pathLabel = issue.path.length ? issue.path.join(".") : "request";
        return `${pathLabel}：${issue.message}`;
      }))]
        .slice(0, 8)
        .join("；")
        .slice(0, 4_000);
      response.status(400).json({
        error: redactTrace(
          issueSummary ? `请求参数无效：${issueSummary}` : "请求参数无效"
        ),
        issues: error.issues
      });
      return;
    }
    if (error instanceof ProjectInputUploadError) {
      response.status(error.status).json({ error: error.message });
      return;
    }
    // Provider/CLI failures are user-visible diagnostics, but they must not
    // become a second credential channel.  Keep ordinary validation text
    // intact while redacting bearer/API-key-shaped fragments.
    const message = redactTrace(error instanceof Error ? error.message : "Unknown error");
    const status = error instanceof GitHubAuthorizationError
      ? (error.publicData.status === 403 ? 403 : 401)
      : message === "Project not found" || message === "GitHub account not found"
        ? 404
        : /Project configuration is locked|Collaboration group .* is policy locked|locked through final pull-request resolution|No pending user intervention|No active model API recovery/.test(message)
          ? 409
          : /Cannot add user input|100 pending user inputs|Only (?:completed or )?cancelled projects can be archived|Only archived projects can be deleted|Project deletion is already in progress|Archived project is still settling|Project explainer has an active turn/.test(message)
            ? 409
            : /SDK Workflow visualization is read-only|Unknown or ambiguous skill|Cannot resume|Invalid project id|Invalid GitHub account id|Project name confirmation does not match/.test(message)
              ? 400
              : 500;
    response.status(status).json({ error: message });
  };
  app.use(errorHandler);

  return app;
}

function gatewayInputFromRequest(value: unknown, existingApiKey?: string): GatewayInput {
  if (!value || typeof value !== "object") throw new Error("Gateway payload must be an object");
  const body = value as Record<string, unknown>;
  const protocol = typeof body.protocol === "string" && AGENT_PROTOCOLS.includes(body.protocol as AgentProtocol)
    ? body.protocol as AgentProtocol
    : undefined;
  const input: GatewayInput = {
    name: typeof body.name === "string" ? body.name : "",
    url: typeof body.url === "string" ? body.url : "",
    apiKey: typeof body.apiKey === "string" && body.apiKey.trim() ? body.apiKey : existingApiKey ?? "",
    models: Array.isArray(body.models) ? body.models.filter((item): item is string => typeof item === "string") : [],
    modelContextWindows: body.modelContextWindows && typeof body.modelContextWindows === "object" && !Array.isArray(body.modelContextWindows)
      ? body.modelContextWindows as Record<string, number>
      : undefined,
    modelReasoning: body.modelReasoning as GatewayInput["modelReasoning"],
    defaultModel: typeof body.defaultModel === "string" ? body.defaultModel : "",
    protocol: protocol as AgentProtocol
  };
  return normalizeGatewayInput(input);
}

function gatewayModelDiscoveryInputFromRequest(
  value: unknown
): Pick<GatewayInput, "url" | "apiKey" | "protocol"> {
  if (!value || typeof value !== "object") throw new Error("Gateway payload must be an object");
  const body = value as Record<string, unknown>;
  const protocol = typeof body.protocol === "string" && AGENT_PROTOCOLS.includes(body.protocol as AgentProtocol)
    ? body.protocol as AgentProtocol
    : undefined;
  return {
    url: typeof body.url === "string" ? body.url : "",
    apiKey: typeof body.apiKey === "string" ? body.apiKey : "",
    protocol: protocol as AgentProtocol
  };
}

function sendGitHubOAuthCallback(
  response: Response,
  result: {
    openerOrigin: string;
    status: "success" | "error";
    message: string;
  }
): void {
  const nonce = randomBytes(18).toString("base64");
  const payload = JSON.stringify({
    type: "openfars:github-auth",
    status: result.status,
    message: result.message.slice(0, 500)
  }).replaceAll("<", "\\u003c");
  const targetOrigin = JSON.stringify(result.openerOrigin).replaceAll("<", "\\u003c");
  response.setHeader("Cache-Control", "no-store, private");
  response.setHeader(
    "Content-Security-Policy",
    `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
  );
  response.status(result.status === "success" ? 200 : 400).type("html").send(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>GitHub 登录</title><style nonce="${nonce}">body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f6f2;color:#17231c;font:15px system-ui,sans-serif}.card{max-width:440px;margin:24px;padding:28px;border:1px solid #dce4dc;border-radius:14px;background:#fff;box-shadow:0 18px 50px rgba(25,45,32,.12)}h1{font-size:20px;margin:0 0 10px}p{line-height:1.6;margin:0;color:#536158}</style></head>
<body><main class="card"><h1>${result.status === "success" ? "GitHub 登录完成" : "GitHub 登录未完成"}</h1><p>可以关闭此窗口并返回 ScienceEvolve。</p></main>
<script nonce="${nonce}">const payload=${payload};const target=${targetOrigin};if(target&&window.opener){window.opener.postMessage(payload,target);setTimeout(()=>window.close(),250)}</script></body></html>`);
}

function findWebDist(): string | undefined {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDir, "..", "..", "..", "web", "dist"),
    path.resolve(moduleDir, "..", "..", "web", "dist"),
    path.resolve(process.cwd(), "web", "dist"),
    path.resolve(process.cwd(), "..", "web", "dist")
  ];
  for (const candidate of candidates) {
    try {
      const stat = requireStat(candidate);
      if (stat) return candidate;
    } catch {
      // Continue through source/build/npm-workspace layouts.
    }
  }
  return undefined;
}

function isTextArtifactMediaType(mediaType: string): boolean {
  const normalized = mediaType.toLowerCase();
  return (
    normalized.startsWith("text/") ||
    normalized.includes("json") ||
    normalized.includes("javascript") ||
    normalized.includes("typescript") ||
    normalized.includes("x-tex") ||
    normalized.includes("xml")
  );
}

function isBrowserInlineMediaType(mediaType: string): boolean {
  const normalized = mediaType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return (
    normalized === "application/pdf" ||
    normalized.startsWith("image/") ||
    normalized.startsWith("audio/") ||
    normalized.startsWith("video/")
  );
}

function waitForResponseDrain(
  response: Response,
  signal: AbortSignal
): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      response.off("drain", finish);
      response.off("close", finish);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    response.once("drain", finish);
    response.once("close", finish);
    signal.addEventListener("abort", finish, { once: true });
  });
}

function requireStat(candidate: string): boolean {
  // This synchronous check only runs once while constructing the HTTP app.
  try {
    const stat = statSync(candidate);
    return stat.isDirectory();
  } catch {
    return false;
  }
}
