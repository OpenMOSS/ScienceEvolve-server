import { z } from "zod";
import { randomUUID } from "node:crypto";
import { redactTrace } from "./utils.js";
import type { GatewayStore } from "./agent-runtime.js";
import type { HarnessRuntimeFacade } from "./harness-runtime/runtime.js";
import type { PublicHarnessDescriptor } from "./harness-runtime/contracts.js";
import type { SkillCatalog } from "./skill-catalog.js";
import type { AgentConfigMap, AgentOrchestrationTemplate } from "./types.js";
import { publicFixedMcpDirectory, isFixedMcpServer, sameMcpServerSelection } from "./mcp-directory.js";
import type { RecommendationAttachment } from "./project-input-uploads.js";
import { ProjectExplainerConfigurationError, type ProjectExplainerRecommendationPort } from "./project-explainer.js";
import { agentConfigSchema, agentNameSchema, agentOrchestrationTemplateSchema, defaultInstructionsForAgent, mergeAgentConfigs, savedResearchTaskInputSchema } from "./validation.js";
import {
  ConfigRecommendationError,
  generateConfigurationRecommendation,
  parseConfigurationRecommendationAnswer
} from "./internal/shared/configuration-recommendation.js";

export { ConfigRecommendationError } from "./internal/shared/configuration-recommendation.js";

export const configRecommendationInputSchema = savedResearchTaskInputSchema.innerType().extend({
  inputUploadId: z.string().regex(/^[a-f0-9]{48}$/).optional(),
  inputDescription: z.string().trim().max(2000).optional(),
  projectId: z.string().regex(/^prj_[a-f0-9]{32}$/).optional(),
  configurationFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  // Older clients may echo their selector, but cannot choose a second AI source.
  advisor: z.object({ gatewayId: z.string().trim().regex(/^gwy_[a-f0-9]{32}$/), model: z.string().trim().min(1).max(200) }).strict().optional()
}).superRefine((task, context) => {
  if (task.orchestration.collaborations.length > 0 && !task.git.enabled) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["git", "enabled"],
      message: "协作组要求启用 Git 机制"
    });
  }
});
export type ConfigRecommendationInput = z.infer<typeof configRecommendationInputSchema>;
export interface ConfigRecommendationResult {
  recommendation: { agents: AgentConfigMap; orchestration: AgentOrchestrationTemplate };
  warnings: string[];
  configurationFingerprint: string;
}
export interface ConfigRecommendationProgress {
  phase: "preparing" | "generation" | "recovery" | "validation";
  message: string;
}
export interface ConfigRecommendationPort {
  recommend(input: ConfigRecommendationInput, signal: AbortSignal, attachments?: RecommendationAttachment[], onProgress?: (progress: ConfigRecommendationProgress) => void): Promise<ConfigRecommendationResult>;
}
type PlannerRuntime = Pick<HarnessRuntimeFacade, "harnessCatalog">;
type Route = { harness: string; gatewayId: string; model: string; verified: boolean };
export interface ConfigRecommendationDiagnostic {
  requestId: string;
  timestamp: string;
  status: "started" | "phase" | "activity" | "completed" | "failed";
  phase: string;
  elapsedMs: number;
  model?: string;
  harness?: string;
  gatewayId?: string;
  outputCharacters: number;
  lastModelActivityAt?: string;
  httpStatus?: number;
  error?: string;
}
const RECOMMENDATION_IDLE_TIMEOUT_MS = 300_000;
const RECOMMENDATION_MAX_DURATION_MS = 600_000;
const outputSchema = z.object({
  agents: z.record(agentNameSchema, agentConfigSchema),
  orchestration: agentOrchestrationTemplateSchema
}).strict();

class RecommendationRouteError extends Error {
  constructor(readonly agent: string) { super("Unavailable route"); }
}

/** A disposable configuration advisor: no project, persisted session, or project actions. */
export class ConfigRecommendationService implements ConfigRecommendationPort {
  private readonly active = new Set<AbortController>();
  constructor(private readonly runtime: PlannerRuntime, private readonly gateways: GatewayStore,
    private readonly skills: Pick<SkillCatalog, "list">, private readonly explainer: ProjectExplainerRecommendationPort,
    private readonly observe?: (event: ConfigRecommendationDiagnostic) => void) {}

  async shutdown(): Promise<void> { for (const controller of this.active) controller.abort(); }

  async recommend(input: ConfigRecommendationInput, signal: AbortSignal, attachments: RecommendationAttachment[] = [], onProgress?: (progress: ConfigRecommendationProgress) => void): Promise<ConfigRecommendationResult> {
    if (this.active.size >= 2) throw new ConfigRecommendationError("配置推荐正在处理中，请稍后重试。", 429);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) controller.abort();
    this.active.add(controller);
    let timedOut: "idle" | "total" | undefined;
    let phase = "加载配置";
    const requestId = randomUUID(), startedAt = Date.now();
    let modelInfo: { model?: string; harness?: string; gatewayId?: string } = {};
    let outputCharacters = 0, lastModelActivityAt: number | undefined;
    const report = (status: ConfigRecommendationDiagnostic["status"], failure?: ConfigRecommendationError) => {
      try {
        this.observe?.({ requestId, timestamp: new Date().toISOString(), status, phase,
          elapsedMs: Date.now() - startedAt, ...modelInfo, outputCharacters,
          ...(lastModelActivityAt === undefined ? {} : { lastModelActivityAt: new Date(lastModelActivityAt).toISOString() }),
          ...(failure ? { httpStatus: failure.status, error: redactTrace(failure.message).slice(0, 1_000) } : {}) });
      } catch { /* Diagnostics never affect generation or expose its contents. */ }
    };
    const expire = (kind: "idle" | "total") => {
      if (controller.signal.aborted) return;
      timedOut = kind; controller.abort();
    };
    const idleTimeout = setTimeout(() => expire("idle"), RECOMMENDATION_IDLE_TIMEOUT_MS);
    const totalTimeout = setTimeout(() => expire("total"), RECOMMENDATION_MAX_DURATION_MS);
    report("started");
    try {
      controller.signal.throwIfAborted();
      onProgress?.({ phase: "preparing", message: "正在读取课题材料与模型配置" });
      const [catalog, gateways, skills, explainer] = await Promise.all([
        this.runtime.harnessCatalog(), this.gateways.list(), this.skills.list(), this.explainer.getRecommendationConfig(input.projectId)
      ]);
      const routes: Route[] = [];
      modelInfo = { model: explainer.config.model, harness: explainer.config.harness, gatewayId: explainer.config.gatewayId };
      if (!explainer.config.available) throw new ConfigRecommendationError(explainer.config.validationError ?? "Project Explainer 配置不可用。", 503);
      if ((input.configurationFingerprint && input.configurationFingerprint !== explainer.fingerprint) ||
        (input.advisor && (input.advisor.gatewayId !== explainer.config.gatewayId || input.advisor.model !== explainer.config.model))) {
        throw new ConfigRecommendationError("推荐使用 Project Explainer 配置；配置已变化，请重新读取后生成。", 409);
      }
      phase = "检查研究 Agent 运行组合";
      onProgress?.({ phase: "preparing", message: "正在检查可用模型、Agent 与工具" });
      for (const gateway of gateways) {
        for (const descriptor of catalog.filter((entry) => entry.available && entry.purposes.includes("workflow") &&
          entry.selectable !== false && entry.userSelectable !== false)) {
          for (const model of [gateway.defaultModel, ...gateway.models.filter((item) => item !== gateway.defaultModel)]) {
            controller.signal.throwIfAborted();
            const verified = await this.gateways.harnessCombinationPassed(gateway.id, descriptor.id, model);
            routes.push({ harness: descriptor.id, gatewayId: gateway.id, model, verified });
          }
        }
      }
      if (!routes.length) throw new ConfigRecommendationError("研究 Agent 尚无可用运行组合。请先配置可用的 Harness、网关和模型。", 503);
      routes.sort((left, right) => Number(right.verified) - Number(left.verified));
      const { advisor: _advisor, projectId: _projectId, configurationFingerprint: _fingerprint, inputUploadId: _uploadId, inputDescription: _inputDescription, ...task } = input;
      const draftAgents = task.agents ? Object.fromEntries(Object.entries(task.agents).map(([name, config]) => {
        if (name === "main" || !config.instructions) return [name, config];
        const template = task.orchestration.agents.find((entry) => entry.name === name)?.template;
        return [name, config.instructions === defaultInstructionsForAgent(name, template)
          ? { ...config, instructions: "" }
          : config];
      })) : undefined;
      const schemaVersion = task.orchestration.schemaVersion === 3 ? 3 : 2;
      const agentConfigExample = {
        harness: routes[0]!.harness, gatewayId: routes[0]!.gatewayId, model: routes[0]!.model,
        instructions: "Role-specific instructions", skills: [], autoSkills: [],
        mcpServers: [], experimentMcp: false, permission: "workspace", webSearch: false, sessionPersistence: false, decisionBy: "main"
      };
      const evidence = {
        task: { ...task, ...(draftAgents ? { agents: draftAgents } : {}) },
        ...(attachments.length || input.inputDescription ? { userInputs: {
          description: input.inputDescription ?? "",
          files: attachments.map((attachment) => attachment.kind === "text"
            ? { path: attachment.path, kind: attachment.kind, content: attachment.text }
            : { path: attachment.path, kind: attachment.kind, mediaType: attachment.mediaType })
        } } : {}),
        availableRoutes: routes,
        harnesses: catalog.filter((item) => item.available).map(({ id, capabilities }) => ({ id, capabilities })),
        skills: skills.map(({ id, name, description }) => ({ id, name, description: description.slice(0, 240) })),
        mcpDirectory: publicFixedMcpDirectory(),
        outputShape: {
          agentConfigExample,
          workflowFields: ["schemaVersion", "agents", "collaborations", ...(schemaVersion === 3 ? ["scopedWorkflow"] : []),
            "input", "routes", "decisionPlans", "allowUserIntervention", "allowMainReconfiguration", "termination", "resultFormat"],
          // Show the complete envelope as well as field types. Otherwise an
          // advisor can confuse the Agent settings map with the workflow's
          // Agent list, especially when repairing an otherwise valid answer.
          example: {
            agents: {
              main: { ...agentConfigExample, sessionPersistence: true },
              worker: { ...agentConfigExample }
            },
            orchestration: {
              schemaVersion,
              agents: [{ name: "main", template: "main" }, { name: "worker", template: "general" }],
              collaborations: [],
              ...(schemaVersion === 3 ? { scopedWorkflow: { schemaVersion: 1, rootAgentIds: ["main", "worker"], groups: [] } } : {}),
              input: { source: "input", target: "worker" },
              routes: { main: [{ target: "worker", kind: "weak" }], worker: [{ target: "finish", kind: "weak" }] },
              decisionPlans: { main: "Schedule work and verify acceptance criteria", worker: "Finish only after the requested outputs are verified" },
              allowUserIntervention: task.orchestration.allowUserIntervention,
              allowMainReconfiguration: task.orchestration.allowMainReconfiguration ?? false,
              termination: { agent: "worker", condition: "Requested outputs and validation evidence are complete", decisionBy: "main", automatic: false },
              resultFormat: { presets: [], custom: "Task-specific deliverable and reproducibility evidence" }
            }
          }
        }
      };
      const verifyCurrent = async () => {
        if ((await this.explainer.getRecommendationConfig(input.projectId)).fingerprint !== explainer.fingerprint) {
          throw new ConfigRecommendationError("Project Explainer 配置在生成期间已变化，请重新生成。", 409);
        }
      };
      // The Explainer owns the actual Harness, gateway and read-only invocation.
      // This service only builds evidence and validates the Agent's proposal.
      const inputWarnings = new Set<string>();
      let generationPhase: "generation" | "recovery" = "generation";
      if (explainer.config.validationWarning) inputWarnings.add(explainer.config.validationWarning);
      const result = await generateConfigurationRecommendation({
        evidence,
        signal: controller.signal,
        recoveryAnswer: answer => this.recoveryAnswer(answer),
        generateAnswer: async (instructions, quotedEvidence, invocationSignal) => {
          await verifyCurrent();
          let receivedCharacters = 0;
          let lastProgressAt: number | undefined;
          const invocationStartedAt = Date.now();
          const currentPhase = generationPhase;
          try {
            const generated = await this.explainer.generateRecommendation({
              ...(input.projectId ? { projectId: input.projectId } : {}),
              configurationFingerprint: explainer.fingerprint,
              instructions,
              evidence: JSON.parse(quotedEvidence) as Record<string, unknown>,
              attachments,
              onModelProgress: ({ kind, characters }) => {
                if (invocationSignal.aborted || characters <= 0) return;
                // A real reasoning/output delta proves the invocation is
                // alive. HTTP heartbeats and local timers never extend it.
                idleTimeout.refresh();
                const firstActivity = lastModelActivityAt === undefined;
                lastModelActivityAt = Date.now();
                if (kind === "output") outputCharacters += characters;
                if (firstActivity) report("activity");
                if (kind === "output") receivedCharacters += characters;
                const now = Date.now();
                if (lastProgressAt !== undefined && now - lastProgressAt < 1_000) return;
                lastProgressAt = now;
                onProgress?.({ phase: currentPhase, message: receivedCharacters
                  ? `${currentPhase === "recovery" ? "正在修复推荐配置" : "正在生成推荐配置"}，已接收 ${receivedCharacters} 字符`
                  : `模型正在分析课题与 Workflow，已等待 ${Math.floor((now - invocationStartedAt) / 1000)} 秒` });
              }
            }, invocationSignal);
            if (generated.configurationFingerprint !== explainer.fingerprint) {
              throw new ConfigRecommendationError("Project Explainer 配置在生成期间已变化，请重新生成。", 409);
            }
            for (const warning of generated.inputWarnings ?? []) inputWarnings.add(warning);
            return generated.answer;
          } catch (error) {
            if (error instanceof ConfigRecommendationError || invocationSignal.aborted) throw error;
            if (error instanceof ProjectExplainerConfigurationError) throw new ConfigRecommendationError(error.message, 409);
            throw new ConfigRecommendationError("Project Explainer 推荐生成失败，请检查其配置后重试。现有配置未更改。", 502);
          }
        },
        onPhase: (nextPhase) => {
          if (nextPhase === "generation" || nextPhase === "recovery") generationPhase = nextPhase;
          phase = nextPhase === "generation"
            ? "等待配置顾问模型输出"
            : nextPhase === "recovery"
              ? "恢复配置顾问输出"
              : "校验推荐配置";
          report("phase");
          onProgress?.({ phase: nextPhase, message: nextPhase === "generation"
            ? "正在生成 Agent 与 Workflow 推荐"
            : nextPhase === "recovery"
              ? "正在修复推荐格式并重新生成"
              : "正在校验 Agent 与 Workflow 配置" });
        },
        verifyCurrent,
        validate: (answer) => this.validate(
          answer,
          input,
          routes,
          catalog,
          new Set(skills.map((skill) => skill.id))
        ),
        validationError: (error) => this.validationError(error)
      });
      // A gateway may have been edited while the model was generating the recommendation.
      onProgress?.({ phase: "validation", message: "正在核对最新模型配置与推荐结果" });
      const [currentGateways, currentCatalog] = await Promise.all([
        this.gateways.list(), this.runtime.harnessCatalog()
      ]);
      for (const [name, config] of Object.entries(result.recommendation.agents)) {
        const original = gateways.find((gateway) => gateway.id === config.gatewayId);
        const current = currentGateways.find((gateway) => gateway.id === config.gatewayId);
        const harness = currentCatalog.find((descriptor) => descriptor.id === config.harness);
        if (!original || !current || current.revision !== original.revision ||
          !current.models.includes(config.model) || !harness?.available || !harness.purposes.includes("workflow") ||
          harness.selectable === false || harness.userSelectable === false) {
          throw new ConfigRecommendationError("网关或模型配置已变化，请重新生成推荐。", 409);
        }
        if (!await this.gateways.harnessCombinationPassed(current.id, config.harness!, config.model, config.gatewayReasoningOption)) {
          result.warnings.push(`${name} 的 ${config.harness} / ${current.name} / ${config.model} 组合尚未通过验证；仍可使用，但运行可能失败。`);
        }
      }
      result.warnings.push(...inputWarnings);
      report("completed");
      return { ...result, configurationFingerprint: explainer.fingerprint };
    } catch (error) {
      const fail = (failure: ConfigRecommendationError): never => { report("failed", failure); throw failure; };
      if (error instanceof ConfigRecommendationError) return fail(error);
      if (error instanceof ProjectExplainerConfigurationError) return fail(new ConfigRecommendationError(error.message, 409));
      if (controller.signal.aborted) {
        return fail(new ConfigRecommendationError(timedOut === "idle"
          ? `配置推荐在${phase}阶段连续 300 秒没有收到模型进度，已停止等待，请重试或检查网关连接。`
          : timedOut === "total"
            ? "配置推荐总用时超过 600 秒，已停止等待，请重试或调整推荐任务。"
            : "配置推荐已取消，请重新生成。", timedOut ? 504 : 499));
      }
      return fail(new ConfigRecommendationError("配置推荐生成失败或返回了无效配置，请重试。现有配置未更改。"));
    } finally {
      clearTimeout(idleTimeout);
      clearTimeout(totalTimeout);
      signal.removeEventListener("abort", abort);
      this.active.delete(controller);
    }
  }

  private validationError(error: unknown): ConfigRecommendationError {
    if (error instanceof RecommendationRouteError) {
      const agent = error.agent.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
      return new ConfigRecommendationError(`配置顾问返回的配置未通过校验（agents.${agent}：必须完整复制 availableRoutes 中同一条 Harness、网关和模型组合；使用完整模型 ID，保留前缀、大小写和后缀），请重新生成。`, 502);
    }
    if (error instanceof SyntaxError) {
      return new ConfigRecommendationError("配置顾问返回的内容不是有效 JSON，请换用更擅长结构化输出的模型重试。", 502);
    }
    if (error instanceof z.ZodError) {
      const issue = error.issues[0];
      const path = issue?.path.map((part) => String(part).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40)).join(".") || "root";
      const detail = issue?.code === "custom" && /^v[23] 配置必须包含 collaborations 数组$/.test(issue.message)
        ? "collaborations 必须是数组，没有协作组时填 []"
        : issue?.code === "custom" && issue.message === "强边必须是唯一出边"
          ? "strong 边必须是唯一出边；保留单条 strong 直连，或将多条候选出边全部设为 weak"
        : issue?.code === "invalid_type" && path === "agents"
          ? "顶层 agents 必须是以 Agent 名称为键的配置对象；Agent 列表放在 orchestration.agents"
          : issue?.code === "unrecognized_keys" && path === "root"
            ? "顶层只允许 agents 和 orchestration，Workflow 字段必须放在 orchestration 内"
            : issue?.code === "invalid_type"
              ? `需要 ${issue.expected}，实际为 ${issue.received}`
              : issue?.code ?? "unknown";
      return new ConfigRecommendationError(`配置顾问返回的配置格式错误（${path}：${detail}），请重新生成。`, 502);
    }
    const knownValidationReasons = new Set([
      "Missing decision plan", "Missing deliverable format", "Conflicting deliverable format", "Agent map mismatch", "Unknown workflow agent",
      "Unavailable route", "Unknown skill", "Unknown MCP", "Unsupported capability", "Unsupported permission"
    ]);
    if (error instanceof Error && knownValidationReasons.has(error.message)) {
      return new ConfigRecommendationError(`配置顾问返回的配置未通过校验（${error.message}），请重新生成。`, 502);
    }
    if (error instanceof Error && /^Missing (harness|gatewayId|model|instructions|skills|autoSkills|mcpServers|permission|webSearch|sessionPersistence|decisionBy)$/.test(error.message)) {
      return new ConfigRecommendationError(`配置顾问返回的配置缺少必填字段（${error.message.slice(8)}），请重新生成。`, 502);
    }
    return new ConfigRecommendationError("配置顾问返回的 Agent 或 Workflow 配置未通过校验，请换用更擅长结构化输出的模型重试。", 502);
  }

  private recoveryAnswer(answer: string): string | undefined {
    try {
      const raw = parseConfigurationRecommendationAnswer(answer);
      const candidate = structuredClone(raw);
      const orchestration = candidate.orchestration;
      if (orchestration && typeof orchestration === "object" && !Array.isArray(orchestration)) {
        const workflow = orchestration as Record<string, unknown>;
        // This is only a check for quoting the known draft back to the model.
        // Actual acceptance still validates its complete regenerated answer.
        if ((workflow.schemaVersion === 2 || workflow.schemaVersion === 3) && workflow.collaborations === undefined) {
          workflow.collaborations = [];
        }
      }
      // Only a schema-known draft is quoted; unrecognized fields are omitted.
      if (outputSchema.safeParse(candidate).success) return JSON.stringify(raw);
    } catch {
      // A malformed or ambiguous answer is regenerated from trusted shape
      // examples and the bounded validation reason instead.
    }
    return undefined;
  }

  private validate(answer: string, input: ConfigRecommendationInput, routes: Route[], catalog: PublicHarnessDescriptor[], skillIds: Set<string>): Omit<ConfigRecommendationResult, "configurationFingerprint"> {
    const raw = parseConfigurationRecommendationAnswer(answer);
    const warnings: string[] = [];
    if (raw.orchestration && typeof raw.orchestration === "object" && !Array.isArray(raw.orchestration)) {
      const workflow = raw.orchestration as Record<string, unknown>;
      if (workflow.schemaVersion === 2 && workflow.collaborations === undefined) {
        // Empty membership is unambiguous only when the complete graph still
        // passes the normal topology validator below. Unknown group targets
        // and missing v3 scope definitions continue to fail validation.
        workflow.collaborations = [];
        warnings.push("Workflow 未设置协作组，已按普通 Agent 编排补齐配置。");
      }
    }
    if (raw && typeof raw === "object" && raw.agents && typeof raw.agents === "object" && !Array.isArray(raw.agents)) {
      for (const [name, source] of Object.entries(raw.agents)) {
        if (!source || typeof source !== "object" || Array.isArray(source)) continue;
        const config = source as Record<string, unknown>;
        if (typeof config.harness !== "string" || typeof config.model !== "string") continue;
        if (!("gatewayId" in config)) {
          const matches = routes.filter((route) => route.harness === config.harness && route.model === config.model);
          if (matches.length === 1) {
            config.gatewayId = matches[0]!.gatewayId;
            warnings.push(`${name} 的网关已根据唯一已配置的 Harness / 模型组合补全。`);
          }
        }
        if (typeof config.gatewayId === "string" && !config.model.includes("/") &&
          !routes.some(route => route.harness === config.harness && route.gatewayId === config.gatewayId && route.model === config.model)) {
          // A bare model label may omit its provider namespace. Resolve only
          // one exact basename on the already-selected gateway and Harness;
          // never switch gateways, guess casing or pick among duplicate names.
          const matches = routes.filter(route => route.harness === config.harness && route.gatewayId === config.gatewayId &&
            route.model.includes("/") && route.model.split("/").at(-1) === config.model);
          if (matches.length === 1) {
            config.model = matches[0]!.model;
            warnings.push(`${name} 的模型名称已按所选网关补全为 ${matches[0]!.model}。`);
          }
        }
      }
    }
    const parsed = outputSchema.parse(raw);
    const names = new Set(parsed.orchestration.agents.map((agent) => agent.name));
    for (const name of names) {
      if (!parsed.orchestration.decisionPlans[name]?.trim()) throw new Error("Missing decision plan");
    }
    const resultFormat = parsed.orchestration.resultFormat;
    if (!resultFormat?.none && !resultFormat?.presets.length && !resultFormat?.custom.trim()) throw new Error("Missing deliverable format");
    if (resultFormat?.none && (resultFormat.presets.length || resultFormat.custom.trim())) throw new Error("Conflicting deliverable format");
    if (names.size !== Object.keys(parsed.agents).length || Object.keys(parsed.agents).some((name) => !names.has(name))) throw new Error("Agent map mismatch");
    for (const key of [...Object.keys(parsed.orchestration.routes), ...Object.keys(parsed.orchestration.decisionPlans)]) {
      if (!names.has(key)) throw new Error("Unknown workflow agent");
    }
    const agents = mergeAgentConfigs(parsed.agents, parsed.orchestration);
    for (const [name, config] of Object.entries(agents)) {
      const source = (raw.agents as Record<string, Record<string, unknown>>)[name]!;
      for (const field of ["harness", "gatewayId", "model", "instructions", "skills", "autoSkills", "mcpServers", "permission", "webSearch", "sessionPersistence", "decisionBy"]) {
        if (!(field in source)) throw new Error(`Missing ${field}`);
      }
      if (!routes.some((route) => route.harness === config.harness && route.gatewayId === config.gatewayId && route.model === config.model)) throw new RecommendationRouteError(name);
      const capabilities = catalog.find((entry) => entry.id === config.harness)!.capabilities;
      if (config.skills.some((id) => !skillIds.has(id)) || config.autoSkills.some((id) => !skillIds.has(id))) throw new Error("Unknown skill");
      const existingMcpServers = input.agents?.[name]?.mcpServers ?? [];
      if (config.mcpServers.some((server) =>
        !isFixedMcpServer(server) &&
        !existingMcpServers.some((existing) => sameMcpServerSelection(existing, server))
      )) throw new Error("Unknown MCP");
      if ((!capabilities.skills && config.skills.length) || (!capabilities.autoSkills && config.autoSkills.length) ||
        (!capabilities.mcp && (config.mcpServers.length || config.experimentMcp)) || (!capabilities.webSearch && config.webSearch) ||
        (!capabilities.durableSession && config.sessionPersistence)) throw new Error("Unsupported capability");
      const permission = input.agents?.[name]?.permission ?? "workspace";
      if (config.permission !== permission) warnings.push(`${name} 的运行权限已保留为 ${permission}；如需调整，请手动设置。`);
      config.permission = permission;
      if (!capabilities.permissionPrompts.includes(permission)) throw new Error("Unsupported permission");
      if (name === "main") config.instructions = input.agents?.main?.instructions ?? defaultInstructionsForAgent("main");
    }
    parsed.orchestration.allowMainReconfiguration = input.orchestration.allowMainReconfiguration ?? false;
    const allowUserIntervention = input.orchestration.allowUserIntervention !== false;
    if (parsed.orchestration.allowUserIntervention !== allowUserIntervention) {
      warnings.push(`已保留用户介入设置为${allowUserIntervention ? "允许" : "关闭"}；如需修改，请手动设置。`);
    }
    parsed.orchestration.allowUserIntervention = allowUserIntervention;
    return { recommendation: { agents, orchestration: parsed.orchestration }, warnings };
  }
}
