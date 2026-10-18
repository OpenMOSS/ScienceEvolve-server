import { normalizeScopedRuntime } from "./scoped-runtime";
import { acceptedGitHandoff } from "./project-results";
import {
  AGENT_TEMPLATES,
  GATEWAY_REASONING_PARAMETER_PATHS,
  type AgentConfig,
  type AgentProtocol,
  type AgentTemplate,
  type AgentEvent,
  type AgentName,
  type AgentMcpServer,
  type AgentProgress,
  type AgentProgressState,
  type AgentConfigPreset,
  type AgentOrchestrationTemplate,
  type CollaborationFormationSnapshot,
  type ResultFormat,
  type WorkflowEdge,
  type WorkflowEdgeMap,
  type SavedResearchTask,
  type AgentsConfig,
  type Artifact,
  type ArtifactCatalogPage,
  type ArtifactCatalogSummary,
  type ArtifactDirectoryEntry,
  type ArtifactDirectoryPage,
  type FailureAttempt,
  type FailureAttemptOperationSummary,
  type FailureAttemptSummary,
  type OverallProgress,
  type Project,
  type ProjectGitState,
  type ProjectGitInput,
  type NodeRun,
  type GroupRun,
  type WorkTask,
  type MemberExecution,
  type PullRequestRecord,
  type OperationRecord,
  type ProjectComputeUsage,
  type ProjectTokenUsage,
  type InvocationPerformance,
  type MainCapabilitySnapshot,
  type PerformanceAggregate,
  type ProjectPerformance,
  type ProjectRuntimeActivity,
  type ProjectRuntimeProjection,
  type ProjectMcpDefinitions,
  type ProjectSkillDefinitions,
  type ProjectUserInput,
  type InterruptionSnapshot,
  type ProjectStatus,
  type QueueSnapshot,
  type QueueTask,
  type QueuePool,
  type ReasoningEffort,
  type CurrentAssignment,
  type HandoffRecord,
  type GatewayRecord,
  type GatewayModelReasoningConfigs,
  type GatewayReasoningParameterPath,
  type ResolvedGatewayReasoning,
  type GatewayTestState,
  type HarnessCatalogEntry,
  type SkillDefinition,
  type TokenUsageTotals,
  type UserIntervention
} from "./types";
import { normalizeCanvasLayout } from "./components/workflow-canvas/core/canvas-layout";
import { validateWorkflowLoops } from "../../server/src/internal/shared/workflow-loop-validation.js";
import { scopedWorkflowError } from "./components/workflow-canvas/core/scoped-workflow";
import { workflowOuterNodeIds } from "./components/workflow-canvas/core/workflow-nodes";

export const DEFAULT_MODELS = [
  "nex-agi/Nex-N2-Pro",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.5",
  "gpt-5.4"
];

export const SYSTEM_CONTROLLER_AGENT = "main";

const HARNESS_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,63})$/;
const GATEWAY_REASONING_OPTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Keep public Gateway reasoning metadata usable even when older records contain stray fields. */
export function normalizeGatewayModelReasoningConfigs(
  value: unknown,
  models: readonly string[]
): GatewayModelReasoningConfigs {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const knownModels = new Set(models);
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).flatMap(([model, rawConfig]) => {
    if (!knownModels.has(model) || !rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig)) return [];
    const config = rawConfig as Record<string, unknown>;
    if (!GATEWAY_REASONING_PARAMETER_PATHS.includes(config.parameter as GatewayReasoningParameterPath)) return [];
    if (!Array.isArray(config.options) || config.options.length > 32) return [];
    const ids = new Set<string>();
    const labels = new Set<string>();
    const options = config.options.flatMap((rawOption) => {
      if (!rawOption || typeof rawOption !== "object" || Array.isArray(rawOption)) return [];
      const option = rawOption as Record<string, unknown>;
      const id = typeof option.id === "string" ? option.id.trim() : "";
      const label = typeof option.label === "string" ? option.label.trim() : "";
      const outboundValue = typeof option.value === "string" ? option.value.trim() : "";
      const normalizedLabel = label.toLocaleLowerCase();
      if (
        !GATEWAY_REASONING_OPTION_ID_PATTERN.test(id) ||
        !label || label.length > 120 ||
        !outboundValue || outboundValue.length > 120 ||
        ids.has(id) || labels.has(normalizedLabel)
      ) return [];
      ids.add(id);
      labels.add(normalizedLabel);
      return [{ id, label, value: outboundValue }];
    });
    return [[model, {
      parameter: config.parameter as GatewayReasoningParameterPath,
      options
    }]];
  }));
}

function normalizeResolvedGatewayReasoning(value: unknown): ResolvedGatewayReasoning | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.mode !== "option" ||
    typeof candidate.optionId !== "string" ||
    !GATEWAY_REASONING_OPTION_ID_PATTERN.test(candidate.optionId) ||
    typeof candidate.label !== "string" || !candidate.label.trim() || candidate.label.length > 120 ||
    typeof candidate.value !== "string" || !candidate.value.trim() || candidate.value.length > 120 ||
    !GATEWAY_REASONING_PARAMETER_PATHS.includes(candidate.parameter as GatewayReasoningParameterPath) ||
    typeof candidate.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(candidate.fingerprint)
  ) return undefined;
  return {
    mode: "option",
    optionId: candidate.optionId,
    label: candidate.label.trim(),
    value: candidate.value.trim(),
    parameter: candidate.parameter as GatewayReasoningParameterPath,
    fingerprint: candidate.fingerprint
  };
}

export function protocolLabel(protocol: AgentProtocol): string {
  return protocol === "responses"
    ? "OpenAI Responses"
    : protocol === "chat-completions"
      ? "OpenAI Chat Completions"
      : "Anthropic Messages";
}

export type HarnessPurpose = HarnessCatalogEntry["purposes"][number];

/** Selection visibility is Registry metadata, never a frontend Harness-ID branch. */
export function isVisibleHarness(harness: { userSelectable?: unknown } | undefined): boolean {
  return harness?.userSelectable !== false;
}

export function harnessSupportsPurpose(
  harness: HarnessCatalogEntry,
  purpose: HarnessPurpose
): boolean {
  if (!isVisibleHarness(harness)) return false;
  if (!harness.purposes.includes(purpose)) return false;
  // Project Explainer is a stronger contract than merely accepting an
  // `explainer` discriminator: the Catalog must also advertise the mechanical
  // read-only guarantee used by that surface.
  return purpose !== "explainer" || harness.capabilities.readOnlyExplainer === true;
}

export function catalogDefaultHarnessId(
  harnesses: HarnessCatalogEntry[],
  explicit?: string
): string | undefined {
  const workflowHarnesses = harnesses.filter((entry) =>
    isVisibleHarness(entry) && entry.available && harnessSupportsPurpose(entry, "workflow")
  );
  if (explicit && workflowHarnesses.some((entry) => entry.id === explicit)) return explicit;
  return workflowHarnesses.find((entry) => entry.default)?.id ?? workflowHarnesses[0]?.id;
}

export function applyCatalogDefaultHarness(
  agents: AgentsConfig,
  harnesses: HarnessCatalogEntry[],
  explicit?: string
): AgentsConfig {
  const defaultHarnessId = catalogDefaultHarnessId(harnesses, explicit);
  if (!defaultHarnessId) return agents;
  const defaultHarness = harnesses.find((entry) => entry.id === defaultHarnessId);
  return Object.fromEntries(Object.entries(agents).map(([name, config]) => [
    name,
    config.harness && isVisibleHarness(harnesses.find((entry) => entry.id === config.harness))
      ? config
      : constrainAgentConfigToHarness({ ...config, harness: defaultHarnessId }, defaultHarness)
  ])) as AgentsConfig;
}

export function applyCatalogDefaultHarnessToNewAgents(
  previous: AgentsConfig,
  next: AgentsConfig,
  harnesses: HarnessCatalogEntry[],
  explicit?: string
): AgentsConfig {
  const additions = Object.fromEntries(
    Object.entries(next).filter(([name]) => !previous[name])
  ) as AgentsConfig;
  if (!Object.keys(additions).length) return next;
  return {
    ...next,
    ...applyCatalogDefaultHarness(additions, harnesses, explicit)
  };
}

export function harnessOptionsWithHistorical(
  harnesses: HarnessCatalogEntry[],
  selectedId?: string
): HarnessCatalogEntry[] {
  const visibleHarnesses = harnesses.filter((entry) => isVisibleHarness(entry));
  const selected = selectedId
    ? harnesses.find((entry) => entry.id === selectedId)
    : undefined;
  if (selected && !isVisibleHarness(selected)) return visibleHarnesses;
  if (!selectedId || visibleHarnesses.some((entry) => entry.id === selectedId)) {
    return visibleHarnesses;
  }
  return [
    ...visibleHarnesses,
    {
      id: selectedId,
      label: selectedId,
      adapterVersion: "unknown",
      purposes: [],
      notes: "历史项目引用的 Harness 已不在当前服务端目录中",
      capabilities: {
        structuredEvents: false,
        toolResults: false,
        durableSession: false,
        permissionPrompts: [],
        workspaceInputs: false,
        autoSkills: false,
        officialEvents: false,
        toolEvents: false,
        usageEvents: false,
        readOnlyExplainer: false,
        webSearch: false,
        skills: false,
        mcp: false
      },
      available: false,
      availabilityReason: "该历史 Harness 当前未注册；原 ID 已保留，未替换为默认 Harness"
    }
  ];
}

/**
 * Build a purpose-scoped selector without hiding an already-persisted value.
 * A selected Harness that is registered but does not support the requested
 * purpose remains visible as a disabled diagnostic option. Catalog entries
 * marked non-selectable are excluded from both normal and historical options.
 */
export function harnessOptionsForPurpose(
  harnesses: HarnessCatalogEntry[],
  purpose: HarnessPurpose,
  selectedId?: string
): HarnessCatalogEntry[] {
  const supported = harnesses.filter((entry) =>
    isVisibleHarness(entry) && harnessSupportsPurpose(entry, purpose)
  );
  const selected = selectedId
    ? harnesses.find((entry) => entry.id === selectedId)
    : undefined;
  if (selected && !isVisibleHarness(selected)) return supported;
  if (selected && isVisibleHarness(selected) && !harnessSupportsPurpose(selected, purpose)) {
    const purposeLabel = purpose === "workflow"
      ? "Workflow"
      : purpose === "explainer"
        ? "Project Explainer"
        : "运行探测";
    return [
      ...supported,
      {
        ...selected,
        available: false,
        availabilityReason:
          purpose === "explainer" && selected.purposes.includes("explainer")
            ? `${selected.label} 未声明只读 Project Explainer capability`
            : `${selected.label} 未声明 ${purposeLabel} purpose`
      }
    ];
  }
  return harnessOptionsWithHistorical(supported, selectedId);
}

/** Remove options a newly selected Harness cannot compile into its CLI. */
export function constrainAgentConfigToHarness(
  config: AgentConfig,
  harness: HarnessCatalogEntry | undefined
): AgentConfig {
  if (!harness) return config;
  const capabilities = harness.capabilities;
  const permissions = capabilities.permissionPrompts;
  const permission = permissions?.includes(config.permission)
    ? config.permission
    : permissions?.[0] ?? config.permission;
  return {
    ...config,
    skills: capabilities.skills === false ? [] : config.skills,
    autoSkills: capabilities.skills === false || capabilities.autoSkills === false
      ? []
      : config.autoSkills,
    mcpServers: capabilities.mcp === false ? [] : config.mcpServers,
    ...(capabilities.mcp === false && config.experimentMcp ? { experimentMcp: false } : {}),
    permission,
    webSearch: capabilities.webSearch === false ? false : config.webSearch
  };
}

/**
 * Apply the server-selected default gateway only to configurations that do
 * not already name one.  This is used when a genuinely new/default workflow
 * is materialized; callers loading a saved task should deliberately skip it
 * so changing the system default cannot rewrite an existing draft.
 */
export function applyCatalogDefaultGateway(
  agents: AgentsConfig,
  defaultGatewayId: string | undefined,
  gateways: GatewayRecord[]
): AgentsConfig {
  if (!defaultGatewayId) return agents;
  const gateway = gateways.find((item) => item.id === defaultGatewayId);
  if (!gateway) return agents;
  return Object.fromEntries(Object.entries(agents).map(([name, config]) => {
    if (config.gatewayId) return [name, config];
    return [name, {
      ...config,
      gatewayId: defaultGatewayId,
      model: gateway.models.includes(config.model) ? config.model : gateway.defaultModel,
      ...(gatewayReasoningOptionIsValid(
        gateway,
        gateway.models.includes(config.model) ? config.model : gateway.defaultModel,
        config.gatewayReasoningOption
      ) ? {} : { gatewayReasoningOption: undefined })
    }];
  })) as AgentsConfig;
}

/**
 * Fill the system default only for Agent identities that were just created.
 * Existing unassigned entries are intentional (for example a saved preset
 * that predates the gateway library) and must not be rewritten while another
 * editor emits a full AgentsConfig snapshot.
 */
export function applyCatalogDefaultGatewayToNewAgents(
  previous: AgentsConfig,
  next: AgentsConfig,
  defaultGatewayId: string | undefined,
  gateways: GatewayRecord[]
): AgentsConfig {
  if (!defaultGatewayId) return next;
  const additions = Object.fromEntries(
    Object.entries(next).filter(([name]) => !previous[name])
  ) as AgentsConfig;
  if (!Object.keys(additions).length) return next;
  const configured = applyCatalogDefaultGateway(additions, defaultGatewayId, gateways);
  return { ...next, ...configured };
}

/**
 * Resolve the persisted probe result for one exact Harness/Gateway/model
 * combination. Direct probes may be shared by Harnesses that natively speak
 * the gateway protocol; translated routes must have their own matrix result.
 */
export function gatewayCombinationTestState(
  gateway: Pick<GatewayRecord, "protocol" | "revision" | "test" | "tests">,
  harness: NonNullable<AgentConfig["harness"]>,
  model: string,
  harnesses: HarnessCatalogEntry[] = [],
  reasoningOptionId?: string
): GatewayTestState {
  const tests = gateway.tests?.length ? gateway.tests : [gateway.test];
  const catalogHarness = harnesses.find((entry) => entry.id === harness);
  const nativeProtocol = catalogHarness?.nativeProtocol
    ?? tests.find((test) => test.harness === harness)?.nativeProtocol;
  if (!nativeProtocol) {
    return { status: "untested", protocol: gateway.protocol, model, harness };
  }
  const routeMode = nativeProtocol === gateway.protocol ? "direct" : "proxy";
  const routeDirection = routeMode === "proxy"
    ? `${nativeProtocol}->${gateway.protocol}` as const
    : undefined;
  const matchesExpectedRoute = (test: GatewayTestState) =>
    test.status === "passed" &&
    (routeMode === "direct"
      ? (test.routeMode ?? "direct") === "direct"
      : test.harness === harness &&
        test.nativeProtocol === nativeProtocol &&
        test.routeMode === "proxy" &&
        test.routeDirection === routeDirection);
  const routeTests = tests.filter((test) =>
    test.probeKind !== "adapter-smoke" &&
    test.protocol === gateway.protocol &&
    test.model === model &&
    test.reasoningOptionId === reasoningOptionId
  );
  const exactRoutes = routeTests.filter((test) => test.harness === harness);
  // An exact Harness result supersedes a legacy untagged direct probe,
  // including when the exact result failed. Only combinations without an
  // exact result may inherit the old shared direct-route record.
  const route = exactRoutes.length
    ? exactRoutes.at(-1)
    : routeMode === "direct"
      ? routeTests.filter((test) =>
          test.harness === undefined && (test.routeMode ?? "direct") === "direct"
        ).at(-1)
      : undefined;
  if (route?.status === "failed") return route;
  const smokeMatches = (test: GatewayTestState) =>
    test.probeKind === "adapter-smoke" &&
    test.protocol === gateway.protocol &&
    test.model === model &&
    test.harness === harness &&
    test.reasoningOptionId === reasoningOptionId &&
    test.nativeProtocol === nativeProtocol &&
    test.gatewayRevision === gateway.revision &&
    (!catalogHarness || test.adapterVersion === catalogHarness.adapterVersion) &&
    (!catalogHarness?.executableFingerprint ||
      test.executableFingerprint === catalogHarness.executableFingerprint) &&
    (!catalogHarness?.routerCompatibilityVersion ||
      test.routerCompatibilityVersion === catalogHarness.routerCompatibilityVersion);
  const smoke = tests.filter(smokeMatches).at(-1);
  const validSmoke = smoke?.status === "failed" || (
    smoke?.status === "passed" &&
    Boolean(
      smoke.cacheKey &&
      smoke.adapterVersion &&
      smoke.executableFingerprint &&
      smoke.routerCompatibilityVersion
    )
  );
  if (route && matchesExpectedRoute(route) && smoke && validSmoke) return smoke;
  return {
    status: "untested",
    protocol: gateway.protocol,
    model,
    harness,
    ...(reasoningOptionId ? { reasoningOptionId } : {}),
    nativeProtocol,
    routeMode,
    ...(routeDirection ? { routeDirection } : {})
  };
}

export interface GatewayModelTestOption {
  model: string;
  test: GatewayTestState;
}

/** Matrix-backed model choices for one Harness on one saved gateway. */
export function gatewayModelTestOptions(
  gateway: Pick<GatewayRecord, "protocol" | "revision" | "models" | "test" | "tests">,
  harness: NonNullable<AgentConfig["harness"]>,
  harnesses: HarnessCatalogEntry[] = [],
  reasoningOptionId?: string
): GatewayModelTestOption[] {
  return gateway.models.map((model) => ({
    model,
    test: gatewayCombinationTestState(gateway, harness, model, harnesses, reasoningOptionId)
  }));
}

export function gatewayReasoningOptions(
  gateway: Pick<GatewayRecord, "modelReasoning"> | undefined,
  model: string
) {
  return gateway?.modelReasoning?.[model]?.options ?? [];
}

export function gatewayReasoningOptionIsValid(
  gateway: Pick<GatewayRecord, "modelReasoning"> | undefined,
  model: string,
  optionId: string | undefined
): boolean {
  return !optionId || gatewayReasoningOptions(gateway, model).some((option) => option.id === optionId);
}

/** Resolve a legacy Harness effort only when its exact provider value is unique. */
export function migrateLegacyAgentReasoning(
  agents: AgentsConfig,
  gateways: readonly GatewayRecord[]
): AgentsConfig {
  let changed = false;
  const migrated = Object.fromEntries(Object.entries(agents).map(([name, config]) => {
    const legacy = config.legacyReasoningEffort ?? config.reasoningEffort;
    if (!legacy) return [name, config];
    const gateway = gateways.find((candidate) => candidate.id === config.gatewayId);
    const matches = gatewayReasoningOptions(gateway, config.model).filter(
      (option) => option.value === legacy
    );
    const { reasoningEffort: _reasoningEffort, legacyReasoningEffort: _legacy, ...clean } = config;
    changed = true;
    if (config.gatewayReasoningOption) {
      const { reasoningMigrationWarning: _warning, ...selected } = clean;
      return [name, selected];
    }
    if (matches.length === 1) {
      const { reasoningMigrationWarning: _warning, ...selected } = clean;
      return [name, { ...selected, gatewayReasoningOption: matches[0]!.id }];
    }
    const warning = matches.length > 1
      ? `旧 Harness 思考深度“${legacy}”匹配到多个 Gateway/model 选项，已改用 Provider 默认值`
      : `旧 Harness 思考深度“${legacy}”无法精确匹配当前 Gateway/model 选项，已改用 Provider 默认值`;
    return [name, { ...clean, reasoningMigrationWarning: warning }];
  }));
  return changed ? migrated as AgentsConfig : agents;
}

/**
 * Summarize persisted probe results for display. A failed result is a warning
 * when selecting a gateway; it does not make that gateway unavailable.
 */
export function gatewayHarnessTestState(
  gateway: Pick<GatewayRecord, "protocol" | "revision" | "models" | "test" | "tests">,
  harness: NonNullable<AgentConfig["harness"]>,
  harnesses: HarnessCatalogEntry[] = []
): Pick<GatewayTestState, "status" | "error"> {
  const options = gatewayModelTestOptions(gateway, harness, harnesses);
  if (options.some((option) => option.test.status === "passed")) {
    return { status: "passed" };
  }
  if (options.length > 0 && options.every((option) => option.test.status === "failed")) {
    return {
      status: "failed",
      error: options.find((option) => option.test.error)?.test.error
    };
  }
  return { status: "untested" };
}

/**
 * Mirror the server's project-creation checks so every editing surface
 * explains an invalid Harness/Gateway/model configuration before submit.
 * Callers separately gate launch on Catalog load state. This helper validates
 * a successfully loaded (including explicitly empty) runtime directory.
 */
export function agentRuntimeConfigurationErrors(
  orchestration: Pick<AgentOrchestrationTemplate, "agents">,
  agents: AgentsConfig,
  gateways: GatewayRecord[],
  harnesses: HarnessCatalogEntry[],
  requireGlobalGateway = false
): string[] {
  return orchestration.agents.flatMap((definition) => {
    const config = agents[definition.name];
    if (!config) return [`${definition.name}：缺少 Agent 配置`];
    const harness = config.harness ?? catalogDefaultHarnessId(harnesses);
    const errors: string[] = [];
    if (!harness) {
      // Loading/saving a draft remains possible while discovery is degraded.
      // A launch surface also blocks on its Catalog state; when a global
      // gateway is required, absence is a hard configuration error here.
      if (requireGlobalGateway || harnesses.length > 0) {
        return [`${definition.name}：服务端没有可用的 Workflow Harness`];
      }
      if (!config.model.trim()) errors.push(`${definition.name}：model 不能为空`);
      return errors;
    }
    const catalogEntry = harnesses.find((item) => item.id === harness);
    if (harnesses.length) {
      if (!catalogEntry) {
        errors.push(`${definition.name}：${harness} 不在服务端 Harness 目录中`);
      } else if (!catalogEntry.available) {
        errors.push(
          `${definition.name}：${catalogEntry.label} 当前不可用（${catalogEntry.availabilityReason ?? "服务端未找到可执行入口"}）`
        );
      }
    }
    if (catalogEntry) {
      if (!harnessSupportsPurpose(catalogEntry, "workflow")) {
        errors.push(`${definition.name}：${catalogEntry.label} 不支持 Workflow purpose`);
      }
      if (catalogEntry.capabilities.structuredEvents === false) {
        errors.push(`${definition.name}：${catalogEntry.label} 不支持统一结构化事件`);
      }
      if (catalogEntry.capabilities.toolResults === false) {
        errors.push(`${definition.name}：${catalogEntry.label} 不支持统一工具结果`);
      }
      if (catalogEntry.capabilities.workspaceInputs === false) {
        errors.push(`${definition.name}：${catalogEntry.label} 不支持受控工作区输入`);
      }
      if (config.sessionPersistence && catalogEntry.capabilities.durableSession === false) {
        errors.push(`${definition.name}：${catalogEntry.label} 不支持持续 session`);
      }
      if (config.webSearch && !catalogEntry.capabilities.webSearch) {
        errors.push(`${definition.name}：${catalogEntry.label} 不支持 Web Search`);
      }
      if (config.skills.length > 0 && catalogEntry.capabilities.skills === false) {
        errors.push(`${definition.name}：${catalogEntry.label} 不支持 Skills`);
      }
      if (config.autoSkills.length > 0 &&
          (catalogEntry.capabilities.skills === false || catalogEntry.capabilities.autoSkills === false)) {
        errors.push(`${definition.name}：${catalogEntry.label} 不支持 Auto Skills`);
      }
      if ((config.mcpServers.length > 0 || config.experimentMcp) && catalogEntry.capabilities.mcp === false) {
        errors.push(`${definition.name}：${catalogEntry.label} 不支持 MCP`);
      }
      const permissionPrompts = catalogEntry.capabilities.permissionPrompts;
      if (permissionPrompts && !permissionPrompts.includes(config.permission)) {
        errors.push(`${definition.name}：${catalogEntry.label} 不支持 ${config.permission} 权限约束`);
      }
    }
    if (!config.model.trim()) errors.push(`${definition.name}：model 不能为空`);
    if (!config.gatewayId) {
      if (requireGlobalGateway) errors.push(`${definition.name}：必须选择全局网关`);
      else if (gateways.length > 0) errors.push(`${definition.name}：使用 ${harness} 时必须选择全局网关`);
      return errors;
    }
    const gateway = gateways.find((item) => item.id === config.gatewayId);
    if (!gateway) return [...errors, `${definition.name}：所选全局网关不存在`];
    if (!gateway.models.includes(config.model)) {
      return [...errors, `${definition.name}：model 不在网关模型列表中`];
    }
    if (!gatewayReasoningOptionIsValid(gateway, config.model, config.gatewayReasoningOption)) {
      errors.push(`${definition.name}：所选网关思考强度不属于当前 model`);
    }
    return errors;
  });
}

/** Connection probes inform the user but do not prevent an attempted run. */
export function agentRuntimeConfigurationWarnings(
  orchestration: Pick<AgentOrchestrationTemplate, "agents">,
  agents: AgentsConfig,
  gateways: GatewayRecord[],
  harnesses: HarnessCatalogEntry[]
): string[] {
  return orchestration.agents.flatMap((definition) => {
    const config = agents[definition.name];
    const migrationWarnings = config?.reasoningMigrationWarning
      ? [`${definition.name}：${config.reasoningMigrationWarning}`]
      : [];
    const harness = config?.harness ?? catalogDefaultHarnessId(harnesses);
    const gateway = gateways.find((item) => item.id === config?.gatewayId);
    if (!config || !harness || !gateway || !gateway.models.includes(config.model)) {
      return migrationWarnings;
    }
    const combination = gatewayCombinationTestState(
      gateway,
      harness,
      config.model,
      harnesses,
      config.gatewayReasoningOption
    );
    if (combination.status === "passed") return migrationWarnings;
    const nativeProtocol = harnesses.find((entry) => entry.id === harness)?.nativeProtocol;
    const routeHint = nativeProtocol && nativeProtocol !== gateway.protocol
      ? `；尚未通过 ${protocolLabel(nativeProtocol)} → ${protocolLabel(gateway.protocol)} 协议路由探测`
      : "";
    return [...migrationWarnings,
      `${definition.name}：网关尚未通过当前协议和 model 的连接测试${routeHint}${combination.error ? `（${combination.error}）` : ""}；仍可启动，但运行可能失败`
    ];
  });
}

export function isLarkSkill(skill: SkillDefinition): boolean {
  const idName = skill.id.split(":").at(-1) ?? skill.id;
  return [skill.name, idName].some((value) =>
    value.trim().toLowerCase().startsWith("lark")
  );
}

export function agentSkillMode(
  config: Pick<AgentConfig, "skills" | "autoSkills">,
  skillId: string
): "fixed" | "auto" | undefined {
  if (config.skills.includes(skillId)) return "fixed";
  if (config.autoSkills.includes(skillId)) return "auto";
  return undefined;
}

export function agentMcpServerKey(server: AgentMcpServer): string {
  return "project" in server
    ? `${server.name}\0project:${server.project}`
    : `${server.name}\0url:${server.url}`;
}

export const REASONING_EFFORT_OPTIONS: ReadonlyArray<{
  value: ReasoningEffort;
  label: string;
}> = [
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高（推荐）" },
  { value: "xhigh", label: "极高" }
];

export const DEFAULT_AGENTS: AgentsConfig = {
  main: {
    model: "nex-agi/Nex-N2-Pro",
    skills: ["builtin:awesome-ai-research-writing-director"],
    autoSkills: [],
    mcpServers: [],
    instructions: "",
    permission: "yolo",
    webSearch: false,
    sessionPersistence: true,
    decisionBy: "main"
  },
  idea: {
    model: "nex-agi/Nex-N2-Pro",
    skills: [
      "builtin:ccf-idea-optimizer",
      "builtin:ccf-idea-reviewer",
      "builtin:ccf-literature-monitor",
      "builtin:ccf-literature-searcher",
      "builtin:ccf-experiment-designer"
    ],
    autoSkills: [],
    mcpServers: [],
    instructions: "",
    permission: "workspace",
    webSearch: true,
    sessionPersistence: false,
    decisionBy: "main"
  },
  execution: {
    model: "nex-agi/Nex-N2-Pro",
    skills: ["builtin:nature-figure"],
    autoSkills: [],
    mcpServers: [],
    instructions: "",
    permission: "compute",
    webSearch: true,
    sessionPersistence: false,
    decisionBy: "main"
  },
  writing: {
    model: "nex-agi/Nex-N2-Pro",
    skills: [
      "builtin:ccf-paper-writer",
      "builtin:ccf-visual-composer",
      "builtin:ccf-paper-to-exemplar",
      "builtin:nature-writing",
      "builtin:nature-polishing"
    ],
    autoSkills: [],
    mcpServers: [],
    instructions: "",
    permission: "workspace",
    webSearch: true,
    sessionPersistence: false,
    decisionBy: "main"
  },
  review: {
    model: "nex-agi/Nex-N2-Pro",
    skills: ["builtin:ccf-paper-reviewer"],
    autoSkills: [],
    mcpServers: [],
    instructions: "",
    permission: "workspace",
    webSearch: true,
    sessionPersistence: false,
    decisionBy: "main"
  }
};

export const DEFAULT_AGENT_ORCHESTRATION: AgentOrchestrationTemplate = {
  schemaVersion: 2,
  agents: [
    { name: "main", template: "main" },
    { name: "idea", template: "idea" },
    { name: "execution", template: "execution" },
    { name: "writing", template: "writing" },
    { name: "review", template: "review" }
  ],
  collaborations: [],
  input: { source: "input", target: "idea" },
  routes: {
    main: [
      { target: "idea", kind: "weak" },
      { target: "execution", kind: "weak" },
      { target: "writing", kind: "weak" },
      { target: "review", kind: "weak" }
    ],
    idea: [{ target: "main", kind: "strong" }],
    execution: [{ target: "main", kind: "strong" }],
    writing: [{ target: "main", kind: "strong" }],
    review: [
      { target: "main", kind: "weak" },
      { target: "finish", kind: "weak" }
    ]
  },
  decisionPlans: {
    main: defaultDecisionPlan("main"),
    idea: defaultDecisionPlan("idea"),
    execution: defaultDecisionPlan("execution"),
    writing: defaultDecisionPlan("writing"),
    review: defaultDecisionPlan("review")
  },
  allowUserIntervention: true,
  allowMainReconfiguration: false,
  termination: {
    agent: "review",
    condition: "评审结果表明论文达到可接受的投稿标准，且没有未解决的关键问题",
    decisionBy: "main",
    automatic: false
  },
  resultFormat: { presets: ["论文"], custom: "" }
};

export function defaultDecisionPlan(agent: AgentName): string {
  return `结合 ${agent} Agent 刚完成的结果、用户需求、当前项目证据、未解决问题和终止条件，选择下一位最合适的 Agent；只有满足终止条件时才结束。`;
}

export function cloneAgentOrchestration(
  orchestration: AgentOrchestrationTemplate = DEFAULT_AGENT_ORCHESTRATION
): AgentOrchestrationTemplate {
  return structuredClone(orchestration);
}

export function normalizeAgentOrchestration(
  value: unknown
): AgentOrchestrationTemplate {
  const source = asObject(value);
  const rawAgents = Array.isArray(source.agents) ? source.agents : DEFAULT_AGENT_ORCHESTRATION.agents;
  const agents: AgentOrchestrationTemplate["agents"] = [];
  const names = new Set<string>();
  for (const rawEntry of rawAgents) {
    const entry = asObject(rawEntry);
    const name = asString(entry.name).trim();
    const template = ["main", "general", "idea", "execution", "writing", "review"].includes(entry.template as string)
      ? entry.template as AgentTemplate
      : "general";
    if (!isAgentIdentifier(name)) continue;
    // Only the exact lower-case `main` name is system-owned. Other casing
    // variants (for example `Main`) are valid user-defined Agent names.
    if (names.has(name)) continue;
    names.add(name);
    const description = asString(entry.description).trim().slice(0, 180);
    agents.push({
      name,
      template: name === "main" ? "main" : template,
      ...(description ? { description } : {})
    });
  }
  if (!agents.length) {
    agents.push({ name: "main", template: "main" });
  }
  const mainIndex = agents.findIndex((entry) => entry.name === "main");
  if (mainIndex < 0) {
    agents.unshift({ name: "main", template: "main" });
  } else if (mainIndex > 0) {
    const [main] = agents.splice(mainIndex, 1);
    agents.unshift({ ...main!, template: "main" });
  } else {
    agents[0] = { ...agents[0]!, template: "main" };
  }
  const collaborations = (Array.isArray(source.collaborations)
    ? source.collaborations
    : []).flatMap((rawGroup) => {
    const group = asObject(rawGroup);
    const id = asString(group.id).trim();
    if (!id) return [];
    const memberAgentIds = Array.isArray(group.memberAgentIds)
      ? group.memberAgentIds
          .filter((member): member is string => typeof member === "string")
          .map((member) => member.trim())
          .filter(Boolean)
      : [];
    return [{
      id,
      displayName: asString(group.displayName).trim().slice(0, 160) || id,
      memberAgentIds,
      renamePolicy: group.renamePolicy === "locked" ? "locked" as const : "editable" as const,
      ...(group.formationSnapshot && typeof group.formationSnapshot === "object"
        ? { formationSnapshot: structuredClone(group.formationSnapshot) as CollaborationFormationSnapshot }
        : {})
    }];
  });
  const schemaVersion = source.schemaVersion === 3 ? 3 as const : 2 as const;
  // A malformed v3 document must remain v3 so validation can report it;
  // silently projecting it to v2 would discard the user's scoped graph.
  const scopedWorkflow = schemaVersion === 3 && source.scopedWorkflow && typeof source.scopedWorkflow === "object"
    ? structuredClone(source.scopedWorkflow) as AgentOrchestrationTemplate["scopedWorkflow"]
    : undefined;
  const outerIds = workflowOuterNodeIds({ agents, collaborations, schemaVersion, scopedWorkflow });
  const configuredOuter = (name: string) => outerIds.includes(name);
  const firstOuterNode = outerIds[0] ?? "main";
  const agentTemplates: AgentOrchestrationTemplate["agents"] = [];
  const templateNames = new Set<string>();
  const builtinTemplateNames = new Set(["main", "general", "idea", "execution", "writing", "review"]);
  const rawTemplates = Array.isArray(source.agentTemplates)
    ? source.agentTemplates
    : agents.filter((entry) => !builtinTemplateNames.has(entry.name) && !/_copy[1-9]\d*$/.test(entry.name));
  for (const rawTemplate of rawTemplates) {
    const entry = asObject(rawTemplate);
    const name = asString(entry.name).trim();
    const template = ["general", "idea", "execution", "writing", "review"].includes(entry.template as string)
      ? entry.template as AgentTemplate
      : "general";
    if (!isAgentIdentifier(name) || builtinTemplateNames.has(name) || templateNames.has(name)) continue;
    templateNames.add(name);
    agentTemplates.push({ name, template, description: asString(entry.description).trim().slice(0, 180) });
  }
  const rawInput = asObject(source.input);
  const requestedInputTarget = rawInput.target;
  const inputTarget =
    typeof requestedInputTarget === "string" && requestedInputTarget.trim()
      ? requestedInputTarget.trim()
      : configuredOuter(DEFAULT_AGENT_ORCHESTRATION.input.target)
        ? DEFAULT_AGENT_ORCHESTRATION.input.target
        : firstOuterNode;
  const rawTermination = asObject(source.termination);
  const rawResultFormat = asObject(source.resultFormat);
  const resultFormat: ResultFormat = {
    presets: [...new Set(
      (Array.isArray(rawResultFormat.presets) ? rawResultFormat.presets : [])
        .filter((preset): preset is string => typeof preset === "string")
        .map((preset) => preset.trim())
        .filter(Boolean)
    )].slice(0, 12),
    custom: asString(rawResultFormat.custom).trim().slice(0, 20_000),
    ...(rawResultFormat.none === true ? { none: true } : {})
  };
  const requestedTerminationAgent = rawTermination.agent;
  const automaticTermination = rawTermination.automatic === true;
  const terminationAgent =
    typeof requestedTerminationAgent === "string" && requestedTerminationAgent.trim()
      ? requestedTerminationAgent.trim()
      : configuredOuter("review")
        ? "review"
        : firstOuterNode;
  const rawRoutes = asObject(source.routes);
  const routes: WorkflowEdgeMap = {};
  // Keep invalid/member route keys visible for the validator rather than
  // silently dropping an illegal imported draft.
  for (const [sourceId, requested] of Object.entries(rawRoutes)) {
    if (!isAgentIdentifier(sourceId) || !Array.isArray(requested)) continue;
    routes[sourceId] = requested.flatMap((rawEdge) => {
      const edge = asObject(rawEdge);
      const target = asString(edge.target).trim();
      const kind = asString(edge.kind).trim();
      return target && (kind === "strong" || kind === "weak")
        ? [{ target, kind } as WorkflowEdge]
        : [];
    });
  }
  for (const nodeId of outerIds) {
      const requested = rawRoutes[nodeId];
      const hasRequestedRoute = Object.prototype.hasOwnProperty.call(
        rawRoutes,
        nodeId
      );
      const parsed: WorkflowEdge[] = Array.isArray(requested)
        ? requested.flatMap((rawEdge) => {
            const edge = asObject(rawEdge);
            const target = asString(edge.target).trim();
            const kind = asString(edge.kind).trim();
            return target && (kind === "strong" || kind === "weak")
              ? [{ target, kind } as WorkflowEdge]
              : [];
          })
        : [];
      // Saved-task drafts may intentionally contain an empty or otherwise
      // incomplete route. Only synthesize defaults when the route key itself
      // is absent; otherwise loading a draft would silently rewrite it.
      if (hasRequestedRoute && Array.isArray(requested)) {
        routes[nodeId] = parsed;
        continue;
      }
      const candidates = outerIds
        .filter((name) => name !== nodeId)
        .map((target) => ({ target, kind: "weak" as const }));
      if (nodeId === terminationAgent) {
        candidates.push({ target: "finish", kind: "weak" });
      }
      routes[nodeId] = candidates.length > 0
        ? candidates
        : [{ target: "finish", kind: "weak" as const }];
  }
  // Main's fan-out is system-owned and always mirrors the outer-node list.
  routes.main = outerIds
    .filter((name) => name !== "main")
    .map((target) => ({ target, kind: "weak" as const }));
  const rawDecisionPlans = asObject(source.decisionPlans);
  const decisionPlans = Object.fromEntries(
    Object.entries(rawDecisionPlans)
      .filter(([name, plan]) => isAgentIdentifier(name) && typeof plan === "string")
      .map(([name, plan]) => [name, String(plan).trim()])
  ) as Record<AgentName, string>;
  for (const nodeId of outerIds) {
    decisionPlans[nodeId] = decisionPlans[nodeId] || defaultDecisionPlan(nodeId);
  }
  const loops = Array.isArray(source.loops)
    ? source.loops.map((rawLoop) => {
        const loop = asObject(rawLoop);
        return {
          id: asString(loop.id).trim(),
          from: asString(loop.from).trim(),
          to: asString(loop.to).trim(),
          maxIterations: asNumber(loop.maxIterations),
          exitTo: asString(loop.exitTo).trim()
        };
      })
    : undefined;
  const canvas = normalizeCanvasLayout(source.canvas, {
    schemaVersion,
    scopedWorkflow,
    agents,
    collaborations,
    routes,
    input: { source: "input" as const, target: inputTarget },
    termination: {
      agent: terminationAgent,
      condition: "",
      decisionBy: "main" as const,
      automatic: automaticTermination
    }
  });
  return {
    schemaVersion,
    agents,
    collaborations,
    ...(scopedWorkflow ? { scopedWorkflow } : {}),
    ...(Array.isArray(source.agentTemplates) || agentTemplates.length ? { agentTemplates } : {}),
    input: { source: "input", target: inputTarget },
    routes,
    ...(loops ? { loops } : {}),
    decisionPlans,
    allowUserIntervention: source.allowUserIntervention !== false,
    allowMainReconfiguration: source.allowMainReconfiguration === true,
    termination: {
      agent: terminationAgent,
      condition:
        asString(rawTermination.condition).trim() ||
        DEFAULT_AGENT_ORCHESTRATION.termination.condition,
      decisionBy: "main",
      automatic: automaticTermination
    },
    resultFormat,
    canvas
  };
}

/** Leaving Git mode may remove an empty scoped envelope, never business nodes
 * or routes. A non-flat scope must first be edited into an ordinary workflow. */
export function orchestrationWithoutGit(value: AgentOrchestrationTemplate): AgentOrchestrationTemplate {
  if ((value.collaborations?.length ?? 0) > 0 || (value.scopedWorkflow?.groups.length ?? 0) > 0) {
    throw new Error("请先移除所有协作组再关闭 Git 机制");
  }
  if (value.schemaVersion !== 3) return value;
  const roots = new Set(value.scopedWorkflow?.rootAgentIds);
  if (roots.size !== value.agents.length || value.agents.some(agent => !roots.has(agent.name))) {
    throw new Error("关闭 Git 前，请将所有已配置的 Agent 放回普通 Workflow。");
  }
  const { scopedWorkflow: _scopedWorkflow, ...ordinary } = value;
  return { ...ordinary, schemaVersion: 2 };
}

export function agentOrchestrationError(
  value: AgentOrchestrationTemplate,
  gitEnabled?: boolean
): string | undefined {
  if (value.canvas?.connections?.input === false) {
    return "用户输入尚未连接到 Agent";
  }
  if (value.canvas?.connections?.termination === false) {
    return "结束节点尚未连接到 Agent";
  }
  const loopIssue = validateWorkflowLoops(value)[0];
  if (loopIssue) return `Loop ${loopIssue.loopId || loopIssue.index + 1}：${loopIssue.message}`;
  const seen = new Set<string>();
  for (const definition of value.agents) {
    if (!isAgentIdentifier(definition.name)) return "Agent name 格式无效";
    if (seen.has(definition.name)) return `Agent name 不能重复：${definition.name}`;
    seen.add(definition.name);
  }
  const agentIds = new Set(value.agents.map((entry) => entry.name));
  if (value.schemaVersion === 3) {
    if (!value.scopedWorkflow) return "v3 配置缺少组内 Workflow";
    const scopedError = scopedWorkflowError(value.scopedWorkflow, agentIds);
    if (scopedError) return scopedError;
    const registered = new Set((value.collaborations ?? []).map((group) => group.id));
    const scoped = new Set(value.scopedWorkflow.groups.map((group) => group.id));
    if (registered.size !== scoped.size || [...registered].some((id) => !scoped.has(id))) {
      return "协作组登记与组内 Workflow 不一致";
    }
  }
  const groupIds = new Set<string>();
  const memberOwners = new Map<string, string>();
  const members = new Set<string>();
  for (const group of value.collaborations ?? []) {
    if (!isAgentIdentifier(group.id)) return `协作组 id 格式无效：${group.id || "（空）"}`;
    if (seen.has(group.id) || groupIds.has(group.id)) return `Agent name 与协作组 id 必须唯一：${group.id}`;
    groupIds.add(group.id);
    if (!group.displayName.trim()) return `${group.id} 的显示名不能为空`;
    const local = new Set<string>();
    for (const member of value.schemaVersion === 3 ? [] : group.memberAgentIds) {
      if (local.has(member)) return `${group.id} 不能重复包含成员 ${member}`;
      local.add(member);
      if (member === "main") return "Main 不能成为协作组成员";
      if ((value.collaborations ?? []).some((entry) => entry.id === member)) return "协作组不能包含另一个协作组";
      if (!agentIds.has(member)) return `${group.id} 包含未知 Agent：${member}`;
      const owner = memberOwners.get(member);
      if (owner && owner !== group.id) return `Agent ${member} 不能同时属于多个协作组`;
      memberOwners.set(member, group.id);
      members.add(member);
    }
    if (value.schemaVersion !== 3 && local.size < 2) return `${group.id} 必须包含至少两个不同的普通 Agent`;
  }
  if ((value.collaborations?.length ?? 0) > 0 && gitEnabled === false) {
    return "协作组要求启用 Git 机制";
  }
  const outerIds = new Set(workflowOuterNodeIds(value));
  const configured = (name: string) => outerIds.has(name);
  if (members.has(value.input.target)) return "输入目标不能指向协作组成员；请选择协作组外层节点";
  if (!configured(value.input.target)) return "输入目标外层节点不存在";
  if (members.has(value.termination.agent)) return "终止节点不能指向协作组成员；请选择协作组外层节点";
  if (!configured(value.termination.agent)) return "终止条件外层节点不存在";
  for (const source of Object.keys(value.routes ?? {})) {
    if (members.has(source)) return `协作组成员 ${source} 不能作为外层路由源`;
    if (!outerIds.has(source)) return `Routes 包含未配置的外层节点：${source}`;
  }
  for (const nodeId of outerIds) {
    const edges = value.routes?.[nodeId] ?? [];
    if (edges.length === 0 && nodeId !== "main") return `${nodeId} 必须至少配置一条出边`;
    const strongCount = edges.filter((edge) => edge.kind === "strong").length;
    if (strongCount > 1 || (strongCount === 1 && edges.length > 1)) {
      return `${nodeId} 的强边必须是唯一出边`;
    }
    const seenTargets = new Set<string>();
    for (const edge of edges) {
      if (edge.target === nodeId) {
        return `${nodeId} 的出边不能指向自身`;
      }
      if (members.has(edge.target)) return `${nodeId} 的外层出边不能指向协作组成员 ${edge.target}`;
      if (edge.target !== "finish" && !configured(edge.target)) {
        return `${nodeId} 的出边目标不存在`;
      }
      if (edge.target === "finish" && nodeId !== value.termination.agent) {
        return "只有指定的终止外层节点可以拥有 finish 出边";
      }
      if (seenTargets.has(edge.target)) {
        return `${nodeId} 不能重复配置同一出边`;
      }
      seenTargets.add(edge.target);
    }
    if (
      nodeId === value.termination.agent && nodeId !== "main" &&
      !edges.some((edge) => edge.target === "finish")
    ) {
      return "终止外层节点必须包含 finish 出边";
    }
    if ((value.decisionPlans[nodeId]?.length ?? 0) > 4_000) {
      return `${nodeId} 的判定方案不能超过 4000 个字符`;
    }
  }
  for (const source of Object.keys(value.decisionPlans ?? {})) {
    if (members.has(source)) return `协作组成员 ${source} 不能拥有外层节点判定方案`;
    if (!outerIds.has(source)) return `判定方案包含未配置的外层节点：${source}`;
  }
  if (!value.termination.condition.trim()) return "终止条件不能为空";
  if (value.termination.condition.length > 4_000) {
    return "终止条件不能超过 4000 个字符";
  }
  return undefined;
}

export function cloneAgentsConfig(
  agents: AgentsConfig = DEFAULT_AGENTS
): AgentsConfig {
  return Object.fromEntries(
    Object.entries(agents).map(([name, config]) => [
      name,
      {
        ...config,
        skills: [...config.skills],
        autoSkills: [...config.autoSkills],
        mcpServers: config.mcpServers.map((server) => ({ ...server }))
      }
    ])
  ) as AgentsConfig;
}

/**
 * Start a new canvas with the three system-owned nodes only. The default
 * five-Agent workflow remains provided by DEFAULT_AGENTS and
 * DEFAULT_AGENT_ORCHESTRATION; this factory is used only for explicit
 * "new workflow" actions.
 */
export function createBlankWorkflow(): {
  agents: AgentsConfig;
  orchestration: AgentOrchestrationTemplate;
} {
  const defaults = cloneAgentsConfig(DEFAULT_AGENTS);
  const main = defaults.main ?? defaultAgentConfig("main", "main");
  return {
    agents: { main },
    orchestration: {
      schemaVersion: 2,
      agents: [{ name: "main", template: "main" }],
      collaborations: [],
      input: { source: "input", target: "main" },
      routes: { main: [] },
      decisionPlans: { main: defaultDecisionPlan("main") },
      allowUserIntervention: true,
      allowMainReconfiguration: false,
      termination: {
        agent: "main",
        condition: DEFAULT_AGENT_ORCHESTRATION.termination.condition,
        decisionBy: "main",
        automatic: false
      },
      resultFormat: { presets: ["论文"], custom: "" }
    }
  };
}

export function agentTemplateFor(
  orchestration: AgentOrchestrationTemplate,
  agent: AgentName
): AgentTemplate {
  if (agent === SYSTEM_CONTROLLER_AGENT) return "main";
  return orchestration.agents.find((entry) => entry.name === agent)?.template ?? "general";
}

export function agentMeta(
  agent: AgentName,
  template: AgentTemplate | string = agent
): { name: string; shortName: string; description: string; color: string } {
  if (agent === SYSTEM_CONTROLLER_AGENT) {
    return {
      name: "Main Agent",
      shortName: "Main",
      description: "处理异常、用户需求与路由决策",
      color: "green"
    };
  }
  const copy = /^(.*)_copy([1-9]\d*)$/.exec(agent);
  if (isAgentTemplate(template)) {
    const builtin = AGENT_META[template];
    if (copy) {
      const sourceName = copy[1] === template ? builtin.name : copy[1]!;
      return { ...builtin, name: `${sourceName}（副本${copy[2]}）`, shortName: copy[1] === template ? builtin.shortName : copy[1]! };
    }
    return agent === template
      ? builtin
      : { ...builtin, name: agent, shortName: agent };
  }
  if (copy) return { name: `${copy[1]}（副本${copy[2]}）`, shortName: copy[1]!, description: `自定义 ${template} 模板 Agent`, color: "slate" };
  return {
    name: agent,
    shortName: agent,
    description: `自定义 ${template} 模板 Agent`,
    color: "slate"
  };
}

export const AGENT_META: Record<
  AgentTemplate,
  { name: string; shortName: string; description: string; color: string }
> = {
  general: {
    name: "通用智能体",
    shortName: "通用",
    description: "按自定义提示执行工作",
    color: "slate"
  },
  main: {
    name: "Main Agent",
    shortName: "Main",
    description: "负责全局调度、用户输入与最终判断",
    color: "green"
  },
  idea: {
    name: "构思智能体",
    shortName: "构思",
    description: "形成课题假设与研究方案",
    color: "amber"
  },
  execution: {
    name: "执行智能体",
    shortName: "执行",
    description: "完成实验、分析与结果验证",
    color: "cyan"
  },
  writing: {
    name: "写作智能体",
    shortName: "写作",
    description: "以 LaTeX 组织完整论文",
    color: "violet"
  },
  review: {
    name: "评审智能体",
    shortName: "评审",
    description: "按证据进行自然语言评审与反馈",
    color: "rose"
  }
};

export const STATUS_META: Record<
  ProjectStatus,
  { label: string; tone: string; description: string }
> = {
  draft: { label: "草稿", tone: "neutral", description: "尚未启动" },
  queued: { label: "排队中", tone: "info", description: "等待智能体资源" },
  running: { label: "研究中", tone: "active", description: "智能体正在协作" },
  retrying: { label: "重试中", tone: "warning", description: "等待重试当前智能体" },
  interrupting: { label: "中断中", tone: "danger", description: "正在保存当前智能体的中断状态" },
  interrupted: {
    label: "运行中断",
    tone: "danger",
    description: "可从持久化断点恢复科研流程"
  },
  pausing: { label: "暂停中", tone: "warning", description: "等待安全暂停点" },
  paused: { label: "已暂停", tone: "warning", description: "可随时继续" },
  cancelling: { label: "取消中", tone: "danger", description: "正在终止当前智能体" },
  cancelled: { label: "已取消", tone: "neutral", description: "项目已取消" },
  stopping: { label: "停止中", tone: "danger", description: "正在终止进程" },
  stopped: { label: "已停止", tone: "neutral", description: "项目已人工停止" },
  completed: { label: "已完成", tone: "success", description: "流程已确认项目完成" },
  failed: { label: "异常", tone: "danger", description: "项目需要处理" }
};

export function projectWaitingLabel(status: ProjectStatus, runtime?: ProjectRuntimeProjection): string | undefined {
  if (runtime?.status !== status || !["queued", "retrying", "paused"].includes(status)) return undefined;
  if (status === "retrying") return "自动恢复中";
  return runtime.waiting?.kind === "recovery" ? "等待恢复"
    : runtime.waiting?.kind === "management" ? "等待协调"
      : runtime.waiting?.kind === "workflow-adjustment" ? "等待 Workflow 调整" : undefined;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

const PROJECT_RESOURCE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PROJECT_RESOURCE_FILE_PATTERN = /^[^\\:\u0000-\u001f]{1,240}$/;

function isProjectResourceFilePath(value: string): boolean {
  return PROJECT_RESOURCE_FILE_PATTERN.test(value) &&
    value.split("/").every((part) => Boolean(part) && part !== "." && part !== "..");
}

function normalizeProjectFiles(value: unknown): Record<string, string> {
  const source = asObject(value);
  return Object.fromEntries(Object.entries(source).flatMap(([file, contents]) =>
    isProjectResourceFilePath(file) && typeof contents === "string"
      ? [[file, contents]]
      : []
  ));
}

export function normalizeProjectSkillDefinitions(
  value: unknown
): ProjectSkillDefinitions {
  const source = asObject(value);
  return Object.fromEntries(Object.entries(source).flatMap(([name, rawDefinition]) => {
    if (!PROJECT_RESOURCE_NAME_PATTERN.test(name)) return [];
    const definition = asObject(rawDefinition);
    const files = normalizeProjectFiles(definition.files);
    return Object.hasOwn(files, "SKILL.md") ? [[name, { files }]] : [];
  }));
}

export function normalizeProjectMcpDefinitions(
  value: unknown
): ProjectMcpDefinitions {
  const source = asObject(value);
  return Object.fromEntries(Object.entries(source).flatMap(([name, rawDefinition]) => {
    if (!PROJECT_RESOURCE_NAME_PATTERN.test(name)) return [];
    const definition = asObject(rawDefinition);
    const files = normalizeProjectFiles(definition.files);
    const entrypoint = asString(definition.entrypoint).trim();
    if (!entrypoint || !Object.hasOwn(files, entrypoint)) return [];
    const command = asString(definition.command).trim();
    const args = Array.isArray(definition.args)
      ? definition.args.filter((arg): arg is string => typeof arg === "string")
      : [];
    const envFrom = Object.fromEntries(Object.entries(asObject(definition.envFrom)).flatMap(
      ([childName, hostName]) => typeof hostName === "string" ? [[childName, hostName]] : []
    ));
    return [[name, {
      files,
      ...(command ? { command } : {}),
      entrypoint,
      ...(args.length ? { args } : {}),
      ...(Object.keys(envFrom).length ? { envFrom } : {})
    }]];
  }));
}

export function projectResourcesPayload(
  skillDefinitions: ProjectSkillDefinitions = {},
  mcpDefinitions: ProjectMcpDefinitions = {}
): {
  skillDefinitions?: ProjectSkillDefinitions;
  mcpDefinitions?: ProjectMcpDefinitions;
} {
  return {
    ...(Object.keys(skillDefinitions).length
      ? { skillDefinitions: structuredClone(skillDefinitions) }
      : {}),
    ...(Object.keys(mcpDefinitions).length
      ? { mcpDefinitions: structuredClone(mcpDefinitions) }
      : {})
  };
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  return fallback;
}

function asOptionalNumber(value: unknown): number | undefined {
  const number = asNumber(value, Number.NaN);
  return Number.isFinite(number) ? number : undefined;
}

function asNonNegativeInteger(value: unknown, fallback = 0): number {
  const number = asOptionalNumber(value);
  return number === undefined ? fallback : Math.max(0, Math.floor(number));
}

function asPositiveInteger(value: unknown): number | undefined {
  const number = asOptionalNumber(value);
  return number === undefined ? undefined : Math.max(1, Math.floor(number));
}

function asOptionalNonNegativeInteger(value: unknown): number | undefined {
  const number = asOptionalNumber(value);
  return number === undefined ? undefined : Math.max(0, Math.floor(number));
}

export function normalizeStatus(value: unknown): ProjectStatus {
  const status = asString(value, "draft").toLowerCase();
  const allowed: ProjectStatus[] = [
    "draft",
    "queued",
    "running",
    "retrying",
    "interrupting",
    "interrupted",
    "pausing",
    "paused",
    "cancelling",
    "cancelled",
    "stopping",
    "stopped",
    "completed",
    "failed"
  ];
  return allowed.includes(status as ProjectStatus) ? (status as ProjectStatus) : "draft";
}

export function isAgentTemplate(value: unknown): value is AgentTemplate {
  return typeof value === "string" && AGENT_TEMPLATES.includes(value as AgentTemplate);
}

export function isAgentIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,63}$/u.test(value) &&
    !["input", "finish", "user"].includes(value.toLowerCase())
  );
}

export function normalizeAgentProgressState(
  value: unknown,
  fallback: AgentProgressState = "waiting"
): AgentProgressState {
  const state = asString(value).toLowerCase();
  const allowed: AgentProgressState[] = [
    "waiting",
    "queued",
    "running",
    "retrying",
    "interrupted",
    "completed",
    "paused",
    "cancelled",
    "failed"
  ];
  return allowed.includes(state as AgentProgressState)
    ? (state as AgentProgressState)
    : fallback;
}

export function normalizeAgentProgress(
  value: unknown,
  fallback: Partial<AgentProgress> = {}
): AgentProgress {
  const data = asObject(value);
  const queuePosition = asPositiveInteger(data.queuePosition ?? fallback.queuePosition);
  return {
    state: normalizeAgentProgressState(data.state, fallback.state),
    runs: asNonNegativeInteger(data.runs, fallback.runs),
    executions: asNonNegativeInteger(
      data.executions,
      fallback.executions ?? fallback.runs
    ),
    ...(queuePosition === undefined ? {} : { queuePosition })
  };
}

export function normalizeOverallProgress(
  value: unknown,
  fallbackLabel = ""
): OverallProgress {
  const data = asObject(value);
  return {
    percent: Math.max(0, Math.min(100, asNumber(data.percent, 0))),
    label: asString(data.label, fallbackLabel),
    estimated: true,
    successfulCalls: asNonNegativeInteger(data.successfulCalls)
  };
}

export function normalizeQueueSnapshot(value: unknown): QueueSnapshot {
  const root = asObject(value);
  const source = asObject(root.queue ?? value);
  const taskList = (value: unknown): QueueTask[] => {
    if (!Array.isArray(value)) return [];
    const tasks = new Map<string, QueueTask>();
    for (const item of value) {
      const data = asObject(item), id = asString(data.id), projectId = asString(data.projectId);
      if (!id || !projectId || !["running", "starting", "recovering"].includes(asString(data.state))) continue;
      tasks.set(id, { id, projectId, state: data.state as QueueTask["state"],
        ...(optionalString(data.agentId) ? { agentId: optionalString(data.agentId) } : {}),
        ...(optionalString(data.invocationId) ? { invocationId: optionalString(data.invocationId) } : {}),
        ...(optionalString(data.executionId) ? { executionId: optionalString(data.executionId) } : {}),
        ...(optionalString(data.groupRunId) ? { groupRunId: optionalString(data.groupRunId) } : {}),
        ...(optionalString(data.startedAt) ? { startedAt: optionalString(data.startedAt) } : {}) });
    }
    return [...tasks.values()];
  };
  return Object.fromEntries(
    [...new Set(["main", "worker", ...Object.keys(source)])].map((kind) => {
      const snapshot = asObject(source[kind]);
      const rawActiveProjectIds = Array.isArray(snapshot.activeProjectIds)
        ? snapshot.activeProjectIds as unknown[]
        : [];
      const activeProjectIds = [
        ...new Set(
          [
            ...rawActiveProjectIds.map((item) => asString(item))
          ].filter((item): item is string => Boolean(item))
        )
      ];
      const capacity =
        asPositiveInteger(snapshot.capacity) ??
        Math.max(10, activeProjectIds.length);
      const rawQueued = Array.isArray(snapshot.queued) ? snapshot.queued : [];
      const queued = rawQueued
        .map((item, index) => {
          const data = asObject(item);
          return {
            projectId: asString(data.projectId),
            position:
              asPositiveInteger(data.position ?? data.queuePosition) ??
              index + 1,
            enteredAt: asString(data.enteredAt),
            ...Object.fromEntries(["id", "agentId", "executionId", "groupRunId", "poolId", "reason"].flatMap(key =>
              optionalString(data[key]) ? [[key, optionalString(data[key])]] : []))
          };
        })
        .filter((item) => item.projectId);
      return [
        kind,
        {
          capacity,
          activeProjectIds,
          queued,
          ...(Array.isArray(snapshot.activeTasks) ? { activeTasks: taskList(snapshot.activeTasks) } : {}),
          ...(Array.isArray(snapshot.recoveringTasks) ? { recoveringTasks: taskList(snapshot.recoveringTasks) } : {}),
          ...(Array.isArray(snapshot.pools) ? { pools: snapshot.pools.flatMap((value): QueuePool[] => {
            const pool = asObject(value), id = asString(pool.id), capacity = asPositiveInteger(pool.capacity);
            if (!id || !capacity || pool.scope !== "shared" && pool.scope !== "project") return [];
            return [{ id, capacity, scope: pool.scope, occupied: asNonNegativeInteger(pool.occupied),
              ...(optionalString(pool.projectId) ? { projectId: optionalString(pool.projectId) } : {}) }];
          }) } : {})
        }
      ];
    })
  ) as QueueSnapshot;
}

export function normalizeAgents(
  value: unknown,
  orchestration: AgentOrchestrationTemplate = DEFAULT_AGENT_ORCHESTRATION
): AgentsConfig {
  const source = asObject(value);
  const result: AgentsConfig = {};
  for (const definition of orchestration.agents) {
    const { name } = definition;
    const template = definition.template ?? "general";
    const item = asObject(source[name]);
    const defaults = defaultAgentConfig(name, template);
    const model = asString(item.model, defaults.model);
    const rawSkills = item.skills;
    const rawAutoSkills = item.autoSkills;
    const rawMcpServers = item.mcpServers;
    const rawReasoningEffort = asString(item.reasoningEffort);
    const reasoningEffort = REASONING_EFFORT_OPTIONS.some(
      (option) => option.value === rawReasoningEffort
    )
      ? (rawReasoningEffort as ReasoningEffort)
      : undefined;
    const legacyReasoningEffort = reasoningEffort;
    const rawGatewaySnapshot = asObject(item.gatewaySnapshot);
    const snapshotProtocol = rawGatewaySnapshot.protocol;
    const snapshotId = asString(rawGatewaySnapshot.id);
    const snapshotName = asString(rawGatewaySnapshot.name);
    const snapshotUrl = asString(rawGatewaySnapshot.url);
    const snapshotModels = Array.isArray(rawGatewaySnapshot.models)
      ? rawGatewaySnapshot.models.filter((model): model is string => typeof model === "string")
      : [];
    const rawSnapshotContextWindows = asObject(rawGatewaySnapshot.modelContextWindows);
    const snapshotModelContextWindows = Object.fromEntries(snapshotModels.flatMap((model) => {
      const contextWindow = rawSnapshotContextWindows[model];
      return typeof contextWindow === "number" && Number.isInteger(contextWindow) && contextWindow > 0
        ? [[model, contextWindow]]
        : [];
    }));
    const snapshotModelReasoning = normalizeGatewayModelReasoningConfigs(
      rawGatewaySnapshot.modelReasoning,
      snapshotModels
    );
    const snapshotReasoning = normalizeResolvedGatewayReasoning(rawGatewaySnapshot.reasoning);
    const snapshotNativeProtocol = rawGatewaySnapshot.nativeProtocol === "responses" || rawGatewaySnapshot.nativeProtocol === "chat-completions" || rawGatewaySnapshot.nativeProtocol === "anthropic-messages"
      ? rawGatewaySnapshot.nativeProtocol as AgentProtocol
      : undefined;
    const snapshotRouteMode: "direct" | "proxy" = rawGatewaySnapshot.routeMode === "direct" || rawGatewaySnapshot.routeMode === "proxy"
      ? rawGatewaySnapshot.routeMode
      : snapshotProtocol && snapshotNativeProtocol && snapshotProtocol !== snapshotNativeProtocol ? "proxy" : "direct";
    const gatewaySnapshot =
      /^gwy_[a-f0-9]{32}$/.test(snapshotId) &&
      Boolean(snapshotName) &&
      Boolean(snapshotUrl) &&
      (snapshotProtocol === "responses" ||
        snapshotProtocol === "chat-completions" ||
        snapshotProtocol === "anthropic-messages") &&
      snapshotModels.length > 0
        ? {
            id: snapshotId,
            name: snapshotName,
            url: snapshotUrl,
            models: snapshotModels,
            ...(Object.keys(snapshotModelContextWindows).length
              ? { modelContextWindows: snapshotModelContextWindows }
              : {}),
            ...(Object.keys(snapshotModelReasoning).length
              ? { modelReasoning: snapshotModelReasoning }
              : {}),
            ...(snapshotReasoning ? { reasoning: snapshotReasoning } : {}),
            ...(asString(rawGatewaySnapshot.reasoningMigrationWarning)
              ? { reasoningMigrationWarning: asString(rawGatewaySnapshot.reasoningMigrationWarning) }
              : {}),
            defaultModel: asString(rawGatewaySnapshot.defaultModel),
            protocol: snapshotProtocol as AgentProtocol,
            ...(snapshotNativeProtocol ? { nativeProtocol: snapshotNativeProtocol } : {}),
            routeMode: snapshotRouteMode,
            ...(snapshotRouteMode === "proxy" && snapshotProtocol && snapshotNativeProtocol
              ? { routeDirection: `${snapshotNativeProtocol}->${snapshotProtocol}` as `${AgentProtocol}->${AgentProtocol}` }
              : {}),
            deliveryMode: rawGatewaySnapshot.deliveryMode === "buffered-json"
              ? "buffered-json" as const
              : "native-stream" as const,
            ...(asString(rawGatewaySnapshot.testedAt)
              ? { testedAt: asString(rawGatewaySnapshot.testedAt) }
              : {})
          }
        : undefined;
    const permission = item.permission === "workspace" || item.permission === "compute" || item.permission === "yolo"
      ? item.permission
      : defaults.permission;
    const normalizedHarness = typeof item.harness === "string" && HARNESS_ID_PATTERN.test(item.harness)
      ? item.harness
      : defaults.harness;
    const explicitReasoningOption = typeof item.gatewayReasoningOption === "string" &&
      GATEWAY_REASONING_OPTION_ID_PATTERN.test(item.gatewayReasoningOption)
      ? item.gatewayReasoningOption
      : undefined;
    const legacyMatches = !explicitReasoningOption && legacyReasoningEffort
      ? (snapshotModelReasoning[model]?.options ?? []).filter(
          (option) => option.value === legacyReasoningEffort
        )
      : [];
    const migratedReasoningOption = legacyMatches.length === 1
      ? legacyMatches[0]!.id
      : undefined;
    const reasoningMigrationWarning = asString(
      item.reasoningMigrationWarning ?? rawGatewaySnapshot.reasoningMigrationWarning
    ) || (!explicitReasoningOption && legacyReasoningEffort && !migratedReasoningOption
      ? legacyMatches.length > 1
        ? `旧 Harness 思考深度“${legacyReasoningEffort}”匹配到多个 Gateway/model 选项，已改用 Provider 默认值`
        : `旧 Harness 思考深度“${legacyReasoningEffort}”无法精确匹配当前 Gateway/model 选项，已改用 Provider 默认值`
      : "");
    result[name] = {
      model: asString(item.model, defaults.model),
      ...(normalizedHarness ? { harness: normalizedHarness } : {}),
      ...(typeof item.gatewayId === "string" && /^gwy_[a-f0-9]{32}$/.test(item.gatewayId)
        ? { gatewayId: item.gatewayId }
        : {}),
      ...(explicitReasoningOption || migratedReasoningOption
        ? { gatewayReasoningOption: explicitReasoningOption ?? migratedReasoningOption }
        : {}),
      ...(gatewaySnapshot ? { gatewaySnapshot } : {}),
      ...(!explicitReasoningOption && !migratedReasoningOption && legacyReasoningEffort
        ? { legacyReasoningEffort }
        : {}),
      ...(reasoningMigrationWarning ? { reasoningMigrationWarning } : {}),
      skills: Array.isArray(rawSkills)
        ? rawSkills
            .map((skill) =>
              typeof skill === "string"
                ? skill
                : asString(asObject(skill).id)
            )
            .filter(Boolean)
        : [...defaults.skills],
      autoSkills: Array.isArray(rawAutoSkills)
        ? rawAutoSkills
            .map((skill) =>
              typeof skill === "string"
                ? skill
                : asString(asObject(skill).id)
            )
            .filter(Boolean)
        : [...defaults.autoSkills],
      mcpServers: Array.isArray(rawMcpServers)
        ? rawMcpServers.flatMap<AgentMcpServer>((rawServer) => {
            const server = asObject(rawServer);
            const name = asString(server.name).trim();
            const url = asString(server.url).trim();
            const project = asString(server.project).trim();
            if (name && project && !url) return [{ name, project }];
            return name && url && !project ? [{ name, url }] : [];
          })
        : defaults.mcpServers.map((server) => ({ ...server })),
      ...(typeof item.experimentMcp === "boolean" ? { experimentMcp: item.experimentMcp } : {}),
      instructions: asString(
        item.instructions,
        defaults.instructions
      ),
      permission,
      webSearch: asBoolean(
        item.webSearch,
        defaults.webSearch
      ),
      sessionPersistence: name === "main" ? true : asBoolean(item.sessionPersistence, defaults.sessionPersistence),
      decisionBy: name === "main" ? "main" : item.decisionBy === "agent" ? "agent" : defaults.decisionBy
    };
  }
  return result;
}

export function defaultAgentConfig(
  _name: AgentName,
  template: AgentTemplate | string
): AgentConfig {
  const source = isAgentTemplate(template) ? DEFAULT_AGENTS[template as keyof typeof DEFAULT_AGENTS] : undefined;
  if (source) {
    return {
      ...source,
      skills: [...source.skills],
      autoSkills: [...source.autoSkills],
      mcpServers: source.mcpServers.map((server) => ({ ...server }))
    };
  }
  return {
    model: "nex-agi/Nex-N2-Pro",
    skills: [],
    autoSkills: [],
    mcpServers: [],
    instructions: "Carry out the bounded task assigned by main. Inspect project evidence, distinguish measured facts from proposals, and return an ordinary Worker handoff.",
    permission: "workspace",
    webSearch: false,
    sessionPersistence: false,
    decisionBy: "main"
  };
}

export function normalizeAgentConfigPresets(
  value: unknown
): AgentConfigPreset[] {
  const source = asObject(value);
  const rawPresets = Array.isArray(source.presets) ? source.presets : [];
  return rawPresets.flatMap((entry) => {
    const preset = asObject(entry);
    const id = asString(preset.id);
    const name = asString(preset.name);
    if (
      preset.schemaVersion !== 2 ||
      !id ||
      !name ||
      preset.kind !== "scienceevolve-agent-config-preset"
    ) {
      return [];
    }
    // Imported SDK documents are read-only visualizations. Their validated
    // routes and Agent settings must not acquire Web scheduler invariants.
    const visualization = typeof asObject(preset.importSource).text === "string";
    const orchestration = visualization
      ? structuredClone(preset.orchestration) as AgentOrchestrationTemplate
      : normalizeAgentOrchestration(preset.orchestration);
    return [
      {
        schemaVersion: 2 as const,
        kind: "scienceevolve-agent-config-preset" as const,
        id,
        name,
        builtin: asBoolean(preset.builtin),
        ...(typeof asObject(preset.importSource).text === "string" ? {
          importSource: {
            filename: asString(asObject(preset.importSource).filename),
            text: asString(asObject(preset.importSource).text),
            notices: (Array.isArray(asObject(preset.importSource).notices) ? asObject(preset.importSource).notices as unknown[] : []).map((entry) => ({
              path: asString(asObject(entry).path), message: asString(asObject(entry).message)
            }))
          }
        } : {}),
        sourceProjectId: asString(preset.sourceProjectId) || undefined,
        sourceProjectTitle: asString(preset.sourceProjectTitle) || undefined,
        createdAt: asString(preset.createdAt) || undefined,
        updatedAt: asString(preset.updatedAt) || undefined,
        agents: visualization ? Object.fromEntries(Object.entries(structuredClone(asObject(preset.agents))).map(([name, config]) => {
          const { proxy: _legacyProxy, ...current } = asObject(config);
          return [name, current];
        })) as unknown as AgentsConfig : normalizeAgents(preset.agents, orchestration),
        orchestration,
        ...(Object.keys(normalizeProjectSkillDefinitions(preset.skillDefinitions)).length
          ? { skillDefinitions: normalizeProjectSkillDefinitions(preset.skillDefinitions) }
          : {}),
        ...(Object.keys(normalizeProjectMcpDefinitions(preset.mcpDefinitions)).length
          ? { mcpDefinitions: normalizeProjectMcpDefinitions(preset.mcpDefinitions) }
          : {})
      }
    ];
  });
}

export function normalizeSavedResearchTasks(
  value: unknown
): SavedResearchTask[] {
  const source = asObject(value);
  const rawTasks = Array.isArray(source.tasks) ? source.tasks : [];
  return rawTasks.flatMap((entry) => {
    const task = asObject(entry);
    const id = asString(task.id);
    const title = asString(task.title).trim();
    const requirement = asString(task.requirement).trim();
    const createdAt = asString(task.createdAt);
    const updatedAt = asString(task.updatedAt);
    if (
      task.schemaVersion !== 2 ||
      !id ||
      !title ||
      !requirement ||
      !createdAt ||
      !updatedAt ||
      task.kind !== "scienceevolve-saved-research-task"
    ) {
      return [];
    }
    const orchestration = normalizeAgentOrchestration(task.orchestration);
    const rawGit = asObject(task.git);
    const git: ProjectGitInput = {
      enabled: rawGit.enabled === true,
      ...(rawGit.provider === "github" ? { provider: "github" as const } : {}),
      ...(optionalString(rawGit.accountId) ? { accountId: asString(rawGit.accountId) } : {}),
      ...(optionalString(rawGit.repositoryName) ? { repositoryName: asString(rawGit.repositoryName) } : {}),
      ...(rawGit.repositoryVisibility === "private" || rawGit.repositoryVisibility === "public"
        ? { repositoryVisibility: rawGit.repositoryVisibility }
        : {})
    };
    return [
      {
        schemaVersion: 2 as const,
        kind: "scienceevolve-saved-research-task" as const,
        id,
        title,
        requirement,
        createdAt,
        updatedAt,
        agents: normalizeAgents(task.agents, orchestration),
        orchestration,
        git,
        ...(Object.keys(normalizeProjectSkillDefinitions(task.skillDefinitions)).length
          ? { skillDefinitions: normalizeProjectSkillDefinitions(task.skillDefinitions) }
          : {}),
        ...(Object.keys(normalizeProjectMcpDefinitions(task.mcpDefinitions)).length
          ? { mcpDefinitions: normalizeProjectMcpDefinitions(task.mcpDefinitions) }
          : {})
      }
    ];
  });
}

export function normalizeCurrentAssignment(
  value: unknown,
  configuredNames: Set<string> = new Set(),
  requireDisplayBinding = false
): CurrentAssignment | undefined {
  if (!value || typeof value !== "object") return undefined;
  const data = asObject(value);
  const target = asString(data.target);
  const invocationId = asString(data.invocationId);
  const message = asString(data.message);
  if (!target || !invocationId || !message) return undefined;
  const successCriteria = Array.isArray(data.successCriteria)
    ? data.successCriteria.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  return {
    target,
    message,
    rationale: asString(data.rationale),
    successCriteria,
    ...(data.display ? {
      display: normalizeDisplaySelection(
        data.display,
        configuredNames,
        requireDisplayBinding
      )
    } : {}),
    invocationId,
    updatedAt: asString(data.updatedAt),
    ...(data.overridden === true ? { overridden: true } : {}),
    ...(asString(data.overrideReason) ? { overrideReason: asString(data.overrideReason) } : {})
  };
}

export function normalizeHandoffRecord(value: unknown): HandoffRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const data = asObject(value);
  const agent = asString(data.agent);
  const invocationId = asString(data.invocationId);
  const markdown = asString(data.markdown);
  if (!agent || !invocationId || !markdown) return undefined;
  return {
    agent,
    invocationId,
    markdown,
    excerpt: asString(data.excerpt),
    updatedAt: asString(data.updatedAt)
  };
}

export function normalizeUserIntervention(
  value: unknown
): UserIntervention | undefined {
  if (!value || typeof value !== "object") return undefined;
  const data = asObject(value);
  const id = asString(data.id);
  const message = asString(data.message);
  const rawStatus = asString(data.status);
  if (!id || !message || !["pending", "answered"].includes(rawStatus)) {
    return undefined;
  }
  const successCriteria = Array.isArray(data.successCriteria)
    ? (data.successCriteria as unknown[]).filter(
        (item): item is string => typeof item === "string"
      )
    : [];
  return {
    id,
    status: rawStatus as UserIntervention["status"],
    requestedAt:
      asString(data.requestedAt) || "",
    answeredAt: asString(data.answeredAt) || undefined,
    message,
    rationale: asString(data.rationale),
    successCriteria,
    requestedBy: asString(data.requestedBy) || undefined,
    requestedInvocationId: asString(data.requestedInvocationId) || undefined,
    requestKind: "main",
    response: asString(data.response) || undefined
  };
}

export function normalizeProjectUserInputs(value: unknown): ProjectUserInput[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const data = asObject(item);
    const id = asString(data.id);
    const message = asString(data.message);
    const status = asString(data.status);
    const targetMainInvocation = asNonNegativeInteger(
      data.targetMainInvocation
    );
    if (
      !id ||
      !message ||
      !["pending", "delivered"].includes(status) ||
      targetMainInvocation < 1
    ) {
      return [];
    }
    const mode = data.mode === "interrupt" ? "interrupt" : "wait";
    return [{
      id,
      status: status as ProjectUserInput["status"],
      createdAt: asString(data.createdAt),
      message,
      mode,
      ...(asString(data.requestId) ? { requestId: asString(data.requestId) } : {}),
      targetMainInvocation,
      deliveredAt: asString(data.deliveredAt) || undefined,
      deliveredInvocationId: asString(data.deliveredInvocationId) || undefined
    }];
  });
}

function normalizeInterruptionSnapshot(value: unknown): InterruptionSnapshot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const data = asObject(value);
  const status = data.status;
  const agent = asString(data.agent);
  const inputId = asString(data.inputId);
  const invocationId = asString(data.invocationId);
  const requestedAt = asString(data.requestedAt);
  if (
    !agent || !inputId || !invocationId || !requestedAt ||
    !["requested", "interrupting", "interrupted", "force-terminated"].includes(String(status))
  ) return undefined;
  const activeTools = Array.isArray(data.activeTools)
    ? data.activeTools.filter((item): item is string => typeof item === "string").slice(-40)
    : [];
  const traceTail = Array.isArray(data.traceTail)
    ? data.traceTail.filter((item): item is string => typeof item === "string").slice(-80)
    : [];
  const artifacts = Array.isArray(data.artifacts)
    ? data.artifacts.flatMap((raw) => {
        const item = asObject(raw);
        const itemAgent = asString(item.agent);
        const path = asString(item.path);
        return itemAgent && path ? [{ agent: itemAgent, path, ...(asString(item.title) ? { title: asString(item.title) } : {}) }] : [];
      })
    : [];
  return {
    status: status as InterruptionSnapshot["status"],
    inputId,
    ...(asString(data.requestId) ? { requestId: asString(data.requestId) } : {}),
    agent,
    kind: data.kind === "worker" ? "worker" : "main",
    invocationId,
    ...(asString(data.harness) ? { harness: data.harness as InterruptionSnapshot["harness"] } : {}),
    ...(asString(data.gatewayId) ? { gatewayId: asString(data.gatewayId) } : {}),
    ...(asString(data.gatewayName) ? { gatewayName: asString(data.gatewayName) } : {}),
    ...(asString(data.gatewayProtocol) ? { gatewayProtocol: data.gatewayProtocol as InterruptionSnapshot["gatewayProtocol"] } : {}),
    ...(asString(data.model) ? { model: asString(data.model) } : {}),
    ...(asString(data.sessionId) ? { sessionId: asString(data.sessionId) } : {}),
    ...(asString(data.startedAt) ? { startedAt: asString(data.startedAt) } : {}),
    requestedAt,
    ...(asString(data.interruptedAt) ? { interruptedAt: asString(data.interruptedAt) } : {}),
    eventSeq: asNonNegativeInteger(data.eventSeq),
    ...(asString(data.lastActivityAt) ? { lastActivityAt: asString(data.lastActivityAt) } : {}),
    activeTools,
    ...(asString(data.partialOutput) ? { partialOutput: asString(data.partialOutput) } : {}),
    ...(asString(data.partialHandoff) ? { partialHandoff: asString(data.partialHandoff) } : {}),
    traceTail,
    artifacts,
    ...(asString(data.workspaceSummary) ? { workspaceSummary: asString(data.workspaceSummary) } : {}),
    ...(data.forceTerminated === true ? { forceTerminated: true } : {}),
    recoverable: data.recoverable !== false
  };
}

function emptyTokenUsageTotals(): TokenUsageTotals {
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

function normalizeTokenUsageTotals(value: unknown): TokenUsageTotals {
  const data = asObject(value);
  const inputTokens = asNonNegativeInteger(
    data.inputTokens
  );
  const outputTokens = asNonNegativeInteger(
    data.outputTokens
  );
  const invocations = asNonNegativeInteger(data.invocations);
  const unknownRequests = asNonNegativeInteger(data.unknownRequests);
  return {
    inputTokens,
    cachedInputTokens: asNonNegativeInteger(
      data.cachedInputTokens
    ),
    outputTokens,
    totalTokens: asNonNegativeInteger(
      data.totalTokens ?? inputTokens + outputTokens
    ),
    invocations,
    unknownRequests,
    complete: typeof data.complete === "boolean"
      ? data.complete
      : invocations === 0
  };
}

export function normalizeProjectTokenUsage(
  value: unknown,
  orchestration: AgentOrchestrationTemplate = DEFAULT_AGENT_ORCHESTRATION,
  archivedAgentNames: readonly AgentName[] = []
): ProjectTokenUsage {
  const data = asObject(value);
  const totals = normalizeTokenUsageTotals(data);
  const rawByAgent = asObject(data.byAgent);
  return {
    ...totals,
    byAgent: Object.fromEntries(
      [...new Set([...orchestration.agents.map(agent => agent.name), ...archivedAgentNames])].map(name => [
        name,
        rawByAgent[name]
          ? normalizeTokenUsageTotals(rawByAgent[name])
          : emptyTokenUsageTotals()
      ])
    ) as ProjectTokenUsage["byAgent"],
    updatedAt: asString(data.updatedAt) || undefined
  };
}

export function normalizeInvocationPerformance(
  value: unknown
): InvocationPerformance | undefined {
  const data = asObject(value);
  const invocationId = asString(data.invocationId);
  const agent = asString(data.agent);
  const status = data.status;
  const startedAt = asString(data.startedAt);
  if (
    !invocationId ||
    !agent ||
    !startedAt ||
    (status !== "active" && status !== "completed" && status !== "incomplete")
  ) return undefined;
  const optionalMetric = (metric: unknown): number | undefined =>
    typeof metric === "number" && Number.isFinite(metric) && metric >= 0
      ? Math.round(metric * 10) / 10
      : undefined;
  const firstTokenLatencyMs = optionalMetric(data.firstTokenLatencyMs);
  const currentTokensPerSecond = optionalMetric(data.currentTokensPerSecond);
  const averageTokensPerSecond = optionalMetric(data.averageTokensPerSecond);
  const outputDurationMs = optionalMetric(data.outputDurationMs);
  return {
    invocationId,
    agent,
    attempt: asNonNegativeInteger(data.attempt),
    status,
    startedAt,
    ...(asString(data.firstTokenAt) ? { firstTokenAt: asString(data.firstTokenAt) } : {}),
    ...(asString(data.completedAt) ? { completedAt: asString(data.completedAt) } : {}),
    ...(firstTokenLatencyMs === undefined ? {} : { firstTokenLatencyMs }),
    ...(currentTokensPerSecond === undefined ? {} : { currentTokensPerSecond }),
    ...(typeof data.requestActive === "boolean" ? { requestActive: data.requestActive } : {}),
    ...(averageTokensPerSecond === undefined ? {} : { averageTokensPerSecond }),
    ...(outputDurationMs === undefined ? {} : { outputDurationMs }),
    outputTokens: asNonNegativeInteger(data.outputTokens),
    tokenSource: data.tokenSource === "official" ? "official" : "estimated",
    streaming: data.streaming === true
  };
}

function normalizePerformanceAggregate(
  value: unknown
): PerformanceAggregate | undefined {
  const data = asObject(value);
  const updatedAt = asString(data.updatedAt);
  if (!updatedAt) return undefined;
  const optionalMetric = (metric: unknown): number | undefined =>
    typeof metric === "number" && Number.isFinite(metric) && metric >= 0
      ? Math.round(metric * 10) / 10
      : undefined;
  const averageFirstTokenLatencyMs = optionalMetric(data.averageFirstTokenLatencyMs);
  const averageTokensPerSecond = optionalMetric(data.averageTokensPerSecond);
  return {
    invocations: asNonNegativeInteger(data.invocations),
    outputTokens: asNonNegativeInteger(data.outputTokens),
    outputDurationMs: optionalMetric(data.outputDurationMs) ?? 0,
    firstTokenSamples: asNonNegativeInteger(data.firstTokenSamples),
    totalFirstTokenLatencyMs: optionalMetric(data.totalFirstTokenLatencyMs) ?? 0,
    ...(averageFirstTokenLatencyMs === undefined ? {} : { averageFirstTokenLatencyMs }),
    ...(averageTokensPerSecond === undefined ? {} : { averageTokensPerSecond }),
    tokenSource:
      data.tokenSource === "official" || data.tokenSource === "mixed"
        ? data.tokenSource
        : "estimated",
    updatedAt
  };
}

export function normalizeProjectPerformance(
  value: unknown,
  orchestration: AgentOrchestrationTemplate = DEFAULT_AGENT_ORCHESTRATION,
  archivedAgentNames: readonly AgentName[] = []
): ProjectPerformance {
  const data = asObject(value);
  const names = [...new Set([...orchestration.agents.map(agent => agent.name), ...archivedAgentNames])];
  const byAgentSource = asObject(data.byAgent);
  const byAgent = Object.fromEntries(
    names.flatMap(name => {
      const performance = normalizeInvocationPerformance(
        byAgentSource[name]
      );
      return performance ? [[name, performance] as const] : [];
    })
  );
  const aggregateByAgentSource = asObject(data.aggregateByAgent);
  const aggregateByAgent = Object.fromEntries(
    names.flatMap(name => {
      const aggregate = normalizePerformanceAggregate(
        aggregateByAgentSource[name]
      );
      return aggregate ? [[name, aggregate] as const] : [];
    })
  );
  const aggregate = normalizePerformanceAggregate(data.aggregate);
  // The server bounds recent history and retains older last-measured TTFT
  // samples. Keep those samples when restoring the page after a refresh.
  const history = Array.isArray(data.history)
    ? data.history
        .flatMap((item) => {
          const performance = normalizeInvocationPerformance(item);
          return performance ? [performance] : [];
        })
    : [];
  const latest = normalizeInvocationPerformance(data.latest);
  return {
    byAgent,
    ...(Object.keys(aggregateByAgent).length ? { aggregateByAgent } : {}),
    ...(aggregate ? { aggregate } : {}),
    ...(history.length ? { history } : {}),
    ...(latest ? { latest } : {})
  };
}

export function normalizeProjectComputeUsage(
  value: unknown
): ProjectComputeUsage {
  const data = asObject(value);
  const rawAccelerators = Array.isArray(data.byAccelerator)
    ? (data.byAccelerator as unknown[])
    : [];
  const byAccelerator = rawAccelerators.flatMap((item) => {
    const accelerator = asObject(item);
    const type = asString(accelerator.type).trim();
    if (!type) return [];
    return [
      {
        type,
        cardHours: Math.max(
          0,
          asNumber(accelerator.cardHours)
        )
      }
    ];
  });
  return {
    source: "inspire",
    totalCardHours: Math.max(
      0,
      asNumber(data.totalCardHours)
    ),
    byAccelerator,
    workloadCount: asNonNegativeInteger(
      data.workloadCount
    ),
    activeWorkloadCount: asNonNegativeInteger(
      data.activeWorkloadCount
    ),
    updatedAt: asString(data.updatedAt) || undefined
  };
}

function fallbackAgentProgressState(
  role: AgentName,
  status: ProjectStatus,
  currentAgent: AgentName | undefined,
  queuedAgent: AgentName | undefined,
  runs: number
): AgentProgressState {
  if (currentAgent === role) {
    if (status === "cancelled" || status === "stopped") return "cancelled";
    if (status === "failed") return "failed";
    if (status === "interrupted") return "interrupted";
    if (status === "interrupting") return "interrupting";
    if (status === "paused") return "paused";
    if (status === "retrying") return "retrying";
    return "running";
  }
  if (queuedAgent === role) {
    if (status === "interrupted") return "interrupted";
    if (status === "interrupting") return "interrupting";
    if (status === "retrying") return "retrying";
    if (status === "paused") return "paused";
    if (status === "cancelled" || status === "stopped") return "cancelled";
    if (status === "failed") return "failed";
    return "queued";
  }
  return runs > 0 ? "completed" : "waiting";
}

function normalizeDisplaySelection(
  value: unknown,
  configuredNames: Set<string>,
  requireBinding = false
): Project["display"] {
  const data = asObject(value);
  const normalizeItem = (raw: unknown) => {
    const item = asObject(raw);
    const agent = asString(item.agent);
    const path = asString(item.path).replaceAll("\\", "/").trim();
    const artifactId = asString(item.artifactId).trim();
    const commitSha = asString(item.commitSha).trim();
    const hasBinding = Object.prototype.hasOwnProperty.call(item, "artifactId") ||
      Object.prototype.hasOwnProperty.call(item, "commitSha");
    if (
      !agent ||
      !configuredNames.has(agent) ||
      !path ||
      path.startsWith("/") ||
      /^[A-Za-z]:\//.test(path) ||
      path.split("/").some((part) => part === ".." || part.startsWith(".")) ||
      requireBinding && !hasBinding ||
      hasBinding && (!artifactId || artifactId.length > 512 || !/^[a-f0-9]{40,64}$/.test(commitSha))
    ) return undefined;
    return {
      agent,
      path,
      title: asString(item.title) || path.split("/").at(-1) || path,
      ...(hasBinding ? { artifactId, commitSha } : {})
    };
  };
  const primary = normalizeItem(data.primary);
  const items = Array.isArray(data.items)
    ? data.items.flatMap((item) => {
        const normalized = normalizeItem(item);
        return normalized ? [normalized] : [];
      })
    : [];
  return primary ? { primary, items } : undefined;
}

function normalizeLoopCounter(
  value: unknown,
  orchestration: AgentOrchestrationTemplate
): Record<string, number> {
  const source = asObject(value);
  return Object.fromEntries((orchestration.loops ?? []).map((loop) => [
    loop.id,
    asNonNegativeInteger(source[loop.id])
  ]));
}

const NODE_RUN_STATUSES = new Set<NodeRun["status"]>([
  "preparing", "queued", "coordinating", "running", "integrating", "paused",
  "blocked", "cancelled", "failed", "completed"
]);
const GROUP_RUN_STATUSES = new Set<GroupRun["status"]>([
  "preparing", "coordinating", "running", "integrating", "paused", "blocked",
  "cancelled", "failed", "completed"
]);
const TASK_STATUSES = new Set<WorkTask["status"]>([
  "pending", "assigned", "working", "waiting", "continuation_pending",
  "succeeded", "failed", "cancelled"
]);
const EXECUTION_STATUSES = new Set<MemberExecution["status"]>([
  "queued", "working", "waiting_authorization", "waiting_review", "pr_open",
  "resolving", "merged", "stop_requested", "stopped", "superseded",
  "succeeded", "failed", "cancelled"
]);

function optionalString(value: unknown): string | undefined {
  const result = asString(value);
  return result || undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function normalizeProjectGitState(value: unknown): ProjectGitState {
  const raw = asObject(value);
  if (raw.enabled !== true) return { enabled: false, status: "disabled" };
  const allowedStatuses = new Set<ProjectGitState["status"]>([
    "authorizing", "creating_repository", "initializing_local", "pushing_main",
    "ready", "waiting_for_github", "failed"
  ]);
  const status = allowedStatuses.has(raw.status as ProjectGitState["status"])
    ? raw.status as ProjectGitState["status"]
    : "authorizing";
  const repository = asObject(raw.repository);
  const account = asObject(raw.account);
  const initialization = asObject(raw.initialization);
  const capacity = asObject(raw.capacity);
  return {
    enabled: true,
    status,
    ...(raw.provider === "github" ? { provider: "github" as const } : {}),
    ...(optionalString(account.id) && optionalString(account.login) &&
      typeof account.providerUserId === "number" && Number.isSafeInteger(account.providerUserId)
      ? {
          account: {
            id: asString(account.id),
            login: asString(account.login),
            providerUserId: account.providerUserId,
            ...(optionalString(account.avatarUrl)
              ? { avatarUrl: asString(account.avatarUrl) }
              : {})
          }
        }
      : {}),
    ...(optionalString(raw.requestedRepositoryName)
      ? { requestedRepositoryName: asString(raw.requestedRepositoryName) }
      : {}),
    requestedRepositoryVisibility: raw.requestedRepositoryVisibility === "public" ? "public" : "private",
    ...(optionalString(repository.owner) && optionalString(repository.name) &&
      optionalString(repository.htmlUrl) && optionalString(repository.localPath)
      ? {
          repository: {
            owner: asString(repository.owner),
            name: asString(repository.name),
            htmlUrl: asString(repository.htmlUrl),
            private: repository.private !== false,
            defaultBranch: "main" as const,
            localPath: asString(repository.localPath)
          }
        }
      : {}),
    ...(optionalString(initialization.operationId)
      ? {
          initialization: {
            operationId: asString(initialization.operationId),
            attempt: Math.max(1, asNonNegativeInteger(initialization.attempt, 1)),
            completedSteps: stringArray(initialization.completedSteps),
            ...(optionalString(initialization.error)
              ? { error: asString(initialization.error) }
              : {})
          }
        }
      : {}),
    branches: Array.isArray(raw.branches)
      ? raw.branches.flatMap((item) => {
          const branch = asObject(item);
          const name = optionalString(branch.name);
          if (!name) return [];
          return [{
            name,
            status: asString(branch.status, "unknown"),
            ...(optionalString(branch.head) ? { head: asString(branch.head) } : {}),
            ...(optionalString(branch.base) ? { base: asString(branch.base) } : {}),
            ...(optionalString(branch.ownerExecutionId)
              ? { ownerExecutionId: asString(branch.ownerExecutionId) }
              : {}),
            ...(optionalString(branch.worktreePath)
              ? { worktreePath: asString(branch.worktreePath) }
              : {}),
            ...(branch.retained === true ? { retained: true as const } : {}),
            ...(optionalString(branch.observedAt)
              ? { observedAt: asString(branch.observedAt) }
              : {})
          }];
        })
      : [],
    commits: Array.isArray(raw.commits)
      ? raw.commits.flatMap((item) => {
          const commit = asObject(item);
          const sha = optionalString(commit.sha);
          if (!sha) return [];
          return [{
            sha,
            ...(optionalString(commit.htmlUrl) ? { htmlUrl: asString(commit.htmlUrl) } : {}),
            ...(optionalString(commit.message) ? { message: asString(commit.message) } : {}),
            ...(optionalString(commit.observedAt)
              ? { observedAt: asString(commit.observedAt) }
              : {})
          }];
        })
      : [],
    blockers: stringArray(raw.blockers),
    ...(optionalString(raw.observedAt) ? { observedAt: asString(raw.observedAt) } : {}),
    ...(Number.isFinite(capacity.retainedWorktreeCount)
      ? {
          capacity: {
            retainedWorktreeCount: asNonNegativeInteger(capacity.retainedWorktreeCount),
            ...(Number.isFinite(capacity.warningThreshold)
              ? { warningThreshold: asNonNegativeInteger(capacity.warningThreshold) }
              : {}),
            ...(optionalString(capacity.warning) ? { warning: asString(capacity.warning) } : {})
          }
        }
      : {})
  };
}

function normalizeNodeRuns(value: unknown): NodeRun[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const raw = asObject(item);
    const node = asObject(raw.node);
    const id = optionalString(raw.id);
    const nodeId = optionalString(node.nodeId);
    const status = raw.status as NodeRun["status"];
    if (!id || !nodeId || !NODE_RUN_STATUSES.has(status)) return [];
    const nodeRef = node.kind === "collaboration"
      ? { kind: "collaboration" as const, nodeId, groupId: asString(node.groupId, nodeId) }
      : { kind: "agent" as const, nodeId, agentId: asString(node.agentId, nodeId) };
    return [{
      id,
      node: nodeRef,
      workflowRevision: asNonNegativeInteger(raw.workflowRevision),
      activationRequestId: asString(raw.activationRequestId),
      inputSnapshotRef: asString(raw.inputSnapshotRef),
      activatedByAgentId: asString(raw.activatedByAgentId, "main"),
      status,
      ...copyOptionalStrings(raw, [
        "optionalTask", "sourceNodeRunId", "sourceAgentId", "routeEmissionId",
        "activatedAt", "updatedAt", "completedAt", "output", "failureReason"
      ])
    }];
  });
}

function copyOptionalStrings(
  raw: Record<string, unknown>,
  keys: string[]
): Record<string, string> {
  return Object.fromEntries(keys.flatMap((key) => {
    const value = optionalString(raw[key]);
    return value ? [[key, value]] : [];
  }));
}

function normalizeGroupRuns(value: unknown): GroupRun[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const raw = asObject(item);
    const status = raw.status as GroupRun["status"];
    const id = optionalString(raw.id);
    if (!id || !GROUP_RUN_STATUSES.has(status)) return [];
    return [{
      id,
      nodeRunId: asString(raw.nodeRunId),
      memberSnapshot: stringArray(raw.memberSnapshot),
      leaderAgentId: asString(raw.leaderAgentId),
      coordinatorEpoch: asNonNegativeInteger(raw.coordinatorEpoch),
      baseCommit: asString(raw.baseCommit),
      groupBranch: asString(raw.groupBranch),
      integrationTarget: "main" as const,
      taskIds: stringArray(raw.taskIds),
      status,
      ...copyOptionalStrings(raw, [
        "actingCoordinatorId", "integrationOwnerExecutionId", "finalPullRequestId",
        "startedAt", "updatedAt", "completedAt", "leaderDecision", "output",
        "failureReason"
      ])
    }];
  });
}

function normalizeWorkTasks(value: unknown): WorkTask[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const raw = asObject(item);
    const status = raw.status as WorkTask["status"];
    const id = optionalString(raw.id);
    if (!id || !TASK_STATUSES.has(status)) return [];
    return [{
      id,
      nodeRunId: asString(raw.nodeRunId),
      assignment: asString(raw.assignment),
      dependencyTaskIds: stringArray(raw.dependencyTaskIds),
      // Collaboration FIFO positions are a one-based public contract. Keep
      // malformed/legacy zero values from leaking into the UI as task #0.
      queueOrdinal: asPositiveInteger(raw.queueOrdinal) ?? 1,
      status,
      ...copyOptionalStrings(raw, [
        "groupRunId", "assigneeAgentId", "currentExecutionId", "predecessorTaskId",
        "successorTaskId", "createdAt", "updatedAt", "completedAt", "waitReason",
        "failureReason", "cancelReason"
      ])
    }];
  });
}

function normalizeExecutions(value: unknown): MemberExecution[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const raw = asObject(item);
    const status = raw.status as MemberExecution["status"];
    const id = optionalString(raw.id);
    if (!id || !EXECUTION_STATUSES.has(status)) return [];
    return [{
      id,
      nodeRunId: asString(raw.nodeRunId),
      taskId: asString(raw.taskId),
      agentId: asString(raw.agentId),
      purpose: raw.purpose === "final-integration" ? "final-integration" as const : "delivery" as const,
      ownershipEpoch: asNonNegativeInteger(raw.ownershipEpoch),
      status,
      executionBranch: asString(raw.executionBranch),
      worktreePath: asString(raw.worktreePath),
      ...copyOptionalStrings(raw, [
        "groupRunId", "pullRequestId", "invocationId", "sessionId",
        "predecessorExecutionId", "successorExecutionId", "failureReason", "queuedAt",
        "startedAt", "updatedAt", "completedAt", "waitReason", "output"
      ])
    }];
  });
}

function normalizePullRequests(value: unknown): PullRequestRecord[] {
  if (!Array.isArray(value)) return [];
  const statuses = new Set<PullRequestRecord["status"]>([
    "open", "conflicted", "closed", "merged", "unknown"
  ]);
  return value.flatMap((item) => {
    const raw = asObject(item);
    const status = raw.status as PullRequestRecord["status"];
    const id = optionalString(raw.id);
    if (!id || !statuses.has(status)) return [];
    const reconciliation = asObject(raw.reconciliation);
    const reconciliationStatus = reconciliation.status;
    const validReconciliation = reconciliationStatus === "pending" ||
      reconciliationStatus === "observed" || reconciliationStatus === "uncertain" ||
      reconciliationStatus === "failed";
    return [{
      id,
      providerNumber: asNonNegativeInteger(raw.providerNumber),
      htmlUrl: asString(raw.htmlUrl),
      head: asString(raw.head),
      base: asString(raw.base),
      ownerExecutionId: asString(raw.ownerExecutionId),
      status,
      observedAt: asString(raw.observedAt),
      ...(typeof raw.mergeable === "boolean" ? { mergeable: raw.mergeable } : {}),
      ...(Array.isArray(raw.conflictPaths) ? { conflictPaths: stringArray(raw.conflictPaths) } : {}),
      ...(Array.isArray(raw.blockers) ? { blockers: stringArray(raw.blockers) } : {}),
      ...copyOptionalStrings(raw, [
        "headSha", "baseSha", "mergeCommitSha", "diffUrl", "headCommitUrl"
      ]),
      checks: Array.isArray(raw.checks)
        ? raw.checks.flatMap((item) => {
            const check = asObject(item);
            if (!Number.isFinite(check.id) || !optionalString(check.name)) return [];
            return [{
              id: asNonNegativeInteger(check.id),
              name: asString(check.name),
              status: asString(check.status),
              observedAt: asString(check.observedAt),
              ...(optionalString(check.conclusion)
                ? { conclusion: asString(check.conclusion) }
                : {}),
              ...(optionalString(check.htmlUrl) ? { htmlUrl: asString(check.htmlUrl) } : {})
            }];
          })
        : [],
      ...(validReconciliation
        ? {
            reconciliation: {
              status: reconciliationStatus,
              ...copyOptionalStrings(reconciliation, ["operationId", "message", "observedAt"])
            }
          }
        : {})
    }];
  });
}

function normalizeOperations(value: unknown): OperationRecord[] {
  if (!Array.isArray(value)) return [];
  const kinds = new Set<OperationRecord["kind"]>([
    "repository.create", "git.push", "pull.create", "pull.merge", "pull.close",
    "memory.commit"
  ]);
  const statuses = new Set<OperationRecord["status"]>([
    "prepared", "observed", "finalized", "uncertain", "failed", "superseded"
  ]);
  return value.flatMap((item) => {
    const raw = asObject(item);
    const kind = raw.kind as OperationRecord["kind"];
    const status = raw.status as OperationRecord["status"];
    const id = optionalString(raw.id);
    if (!id || !kinds.has(kind) || !statuses.has(status) || status === "superseded" && kind !== "git.push") return [];
    return [{
      id,
      kind,
      payloadHash: asString(raw.payloadHash),
      status,
      ...(Number.isFinite(raw.ownershipEpoch)
        ? { ownershipEpoch: asNonNegativeInteger(raw.ownershipEpoch) }
        : {}),
      ...(raw.remoteFact && typeof raw.remoteFact === "object" && !Array.isArray(raw.remoteFact)
        ? { remoteFact: raw.remoteFact as Record<string, unknown> }
        : {}),
      ...copyOptionalStrings(raw, ["ownerExecutionId", "expectedHead", "expectedBase"])
    }];
  });
}

const FAILURE_ATTEMPT_SCOPES = new Set<FailureAttempt["scope"]>([
  "git", "resident", "tool", "control", "usage", "scheduler"
]);

function normalizeFailureAttempts(value: unknown): FailureAttempt[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const raw = asObject(item);
    const scope = raw.scope as FailureAttempt["scope"];
    const status = raw.status as FailureAttempt["status"];
    const attemptId = optionalString(raw.attemptId);
    const projectId = optionalString(raw.projectId);
    const operation = optionalString(raw.operation);
    const startedAt = optionalString(raw.startedAt);
    const finishedAt = optionalString(raw.finishedAt);
    if (
      !attemptId || !projectId || !operation || !startedAt || !finishedAt ||
      !FAILURE_ATTEMPT_SCOPES.has(scope) ||
      (status !== "failed" && status !== "succeeded")
    ) return [];
    const errorCode = raw.errorCode === null
      ? null
      : optionalString(raw.errorCode) ?? null;
    return [{
      attemptId,
      projectId,
      scope,
      operation,
      status,
      errorCode,
      retryable: raw.retryable === true,
      redactedMessage: asString(raw.redactedMessage),
      causeClass: asString(raw.causeClass, "Unknown"),
      ...copyOptionalStrings(raw, ["agentId", "invocationId"]),
      ...(Number.isFinite(raw.ownershipEpoch)
        ? { ownershipEpoch: asNonNegativeInteger(raw.ownershipEpoch) }
        : {}),
      startedAt,
      finishedAt,
      metadata: raw.metadata && typeof raw.metadata === "object" && !Array.isArray(raw.metadata)
        ? structuredClone(raw.metadata as Record<string, unknown>)
        : {}
    }];
  });
}

function deriveFailureAttemptSummary(
  attempts: readonly FailureAttempt[],
  value: unknown
): FailureAttemptSummary {
  const raw = asObject(value);
  const rawOperations = Array.isArray(raw.operations) ? raw.operations : [];
  const normalizedOperations = rawOperations.flatMap((item): FailureAttemptOperationSummary[] => {
    const operation = asObject(item);
    const scope = operation.scope as FailureAttempt["scope"];
    const status = operation.status as FailureAttempt["status"];
    const attemptId = optionalString(operation.attemptId);
    const operationName = optionalString(operation.operation);
    const startedAt = optionalString(operation.startedAt);
    const finishedAt = optionalString(operation.finishedAt);
    if (!attemptId || !operationName || !startedAt || !finishedAt ||
      !FAILURE_ATTEMPT_SCOPES.has(scope) ||
      (status !== "failed" && status !== "succeeded")) return [];
    return [{
      scope,
      operation: operationName,
      status,
      attemptId,
      attemptCount: asNonNegativeInteger(operation.attemptCount),
      failureCount: asNonNegativeInteger(operation.failureCount),
      startedAt,
      finishedAt,
      ...copyOptionalStrings(operation, ["lastFailureAt", "lastSuccessAt"])
    }];
  });
  const chronologicalAttempts = attempts
    .map((attempt, index) => ({ attempt, index }))
    .sort((left, right) => {
      const time = Date.parse(left.attempt.finishedAt) - Date.parse(right.attempt.finishedAt);
      return Number.isFinite(time) && time !== 0 ? time : left.index - right.index;
    })
    .map(({ attempt }) => attempt);
  const byOperation = new Map<string, FailureAttemptOperationSummary>();
  for (const attempt of chronologicalAttempts) {
    const key = `${attempt.scope}\0${attempt.operation}`;
    const prior = byOperation.get(key);
    byOperation.set(key, {
      scope: attempt.scope,
      operation: attempt.operation,
      status: attempt.status,
      attemptId: attempt.attemptId,
      attemptCount: (prior?.attemptCount ?? 0) + 1,
      failureCount: (prior?.failureCount ?? 0) + (attempt.status === "failed" ? 1 : 0),
      startedAt: attempt.startedAt,
      finishedAt: attempt.finishedAt,
      ...(attempt.status === "failed"
        ? { lastFailureAt: attempt.finishedAt }
        : prior?.lastFailureAt ? { lastFailureAt: prior.lastFailureAt } : {}),
      ...(attempt.status === "succeeded"
        ? { lastSuccessAt: attempt.finishedAt }
        : prior?.lastSuccessAt ? { lastSuccessAt: prior.lastSuccessAt } : {})
    });
  }
  const operations = attempts.length > 0
    ? [...byOperation.values()].sort((left, right) =>
      left.finishedAt.localeCompare(right.finishedAt) ||
      left.scope.localeCompare(right.scope) ||
      left.operation.localeCompare(right.operation))
    : normalizedOperations;
  const hasAttempts = attempts.length > 0;
  const latestAttempt = chronologicalAttempts.at(-1);
  const latestFailure = [...chronologicalAttempts]
    .reverse()
    .find((attempt) => attempt.status === "failed");
  const derivedFailedAttempts = attempts.filter((attempt) => attempt.status === "failed").length;
  const failedAttempts = hasAttempts
    ? derivedFailedAttempts
    : asNonNegativeInteger(raw.failedAttempts);
  const succeededAttempts = hasAttempts
    ? attempts.length - derivedFailedAttempts
    : asNonNegativeInteger(raw.succeededAttempts);
  const derivedUnresolvedFailures = operations
    .filter((operation) => operation.status === "failed").length;
  const unresolvedFailures = hasAttempts
    ? derivedUnresolvedFailures
    : Number.isFinite(raw.unresolvedFailures)
      ? asNonNegativeInteger(raw.unresolvedFailures)
      : derivedUnresolvedFailures;
  return {
    currentStatus: unresolvedFailures > 0 || (!hasAttempts && raw.currentStatus === "failed")
      ? "failed"
      : "healthy",
    totalAttempts: hasAttempts ? attempts.length : asNonNegativeInteger(raw.totalAttempts),
    failedAttempts,
    succeededAttempts,
    unresolvedFailures,
    ...(latestAttempt ? { latestAttempt } : {}),
    ...(latestFailure ? { latestFailure } : {}),
    operations
  };
}


function normalizeCollaborationState(value: unknown): Project["collaboration"] {
  const data = asObject(value);
  if (!Number.isSafeInteger(data.stateRevision) || (data.stateRevision as number) < 1) return undefined;
  const businessState = Array.isArray(data.businessState) ? data.businessState.flatMap(value => {
    const record = asObject(value), object = asObject(record.object);
    if (typeof object.kind !== "string" || !object.kind || typeof object.id !== "string" || !object.id ||
      !record.extensions || typeof record.extensions !== "object" || Array.isArray(record.extensions) ||
      !Number.isSafeInteger(record.sequence) || (record.sequence as number) < 1 ||
      typeof record.updatedAt !== "string" || !Number.isFinite(Date.parse(record.updatedAt))) return [];
    return [{ object: { kind: object.kind, id: object.id }, extensions: structuredClone(record.extensions) as Record<string, unknown>,
      sequence: record.sequence as number, updatedAt: record.updatedAt }];
  }) : [];
  const formal = asObject(data.formalState), domain = asObject(formal.domain), checkpoint = asObject(formal.checkpoint);
  const experiments = asObject(formal.experiments), ledger = asObject(experiments.ledger), commit = asObject(formal.invocationCommit);
  const formalState = ["git", "serial"].includes(String(domain.scheduler)) && domain.protocol === "project-state-v1" &&
    typeof checkpoint.version === "string" && Number.isSafeInteger(checkpoint.revision) &&
    checkpoint.lifecycle && typeof checkpoint.lifecycle === "object" && !Array.isArray(checkpoint.lifecycle) &&
    ["idle", "in_progress", "committed"].includes(String(commit.status)) && Array.isArray(ledger.experiments) && ledger.experiments.every(value => {
      const e = asObject(value);
      return ["id", "agent", "taskId", "runId", "status"].every(key => typeof e[key] === "string") && typeof e.required === "boolean" &&
        (e.resultReceived === undefined || typeof e.resultReceived === "boolean");
    })
    ? structuredClone(formal) as unknown as NonNullable<Project["collaboration"]>["formalState"] : undefined;
  return { stateRevision: data.stateRevision as number, businessState, ...(formalState ? { formalState } : {}) };
}

export function normalizeProject(value: unknown): Project {
  const data = asObject(value);
  const collaboration = normalizeCollaborationState(data.collaboration);
  const publishedArtifacts = normalizeArtifacts(data.artifacts);
  const failureAttempts = normalizeFailureAttempts(data.failureAttempts);
  const orchestration = normalizeAgentOrchestration(data.orchestration);
  const configuredNames = new Set(
    orchestration.agents.map((definition) => definition.name)
  );
  const archivedAgentSessions = Array.isArray(data.archivedAgentSessions) ? data.archivedAgentSessions.flatMap(value => {
    const entry = asObject(value), sessions = asObject(entry.sessions);
    const agentId = asString(entry.agentId), workflowRevision = asNonNegativeInteger(entry.workflowRevision), sessionCount = Object.keys(sessions).length;
    if (!agentId || workflowRevision < 1 || !sessionCount && asObject(entry.definition).name !== agentId) return [];
    return [{ agentId, workflowRevision, sessionCount,
      harnesses: [...new Set([asString(entry.harnessId), ...Object.values(sessions).map(binding => asString(asObject(asObject(binding).session).harnessId))].filter(Boolean))] }];
  }) : [];
  const id = asString(data.id);
  const status = normalizeStatus(data.status);
  const rawCurrentAgent = data.currentAgent;
  const rawQueuedAgent = data.queuedAgent;
  const currentAgent =
    typeof rawCurrentAgent === "string" && configuredNames.has(rawCurrentAgent)
      ? rawCurrentAgent
      : undefined;
  const queuedAgent =
    typeof rawQueuedAgent === "string" && configuredNames.has(rawQueuedAgent)
      ? rawQueuedAgent
      : undefined;
  const phase = asString(data.phase, status);
  const queuePosition = asPositiveInteger(
    data.queuePosition
  );
  const queueDepth = asOptionalNonNegativeInteger(
    data.queueDepth
  );
  const runCounts = asObject(data.runCounts);
  const executionCounts = asObject(data.executionCounts);
  const rawAgentProgress = asObject(data.agentProgress);
  const agentProgress = Object.fromEntries(
    orchestration.agents.map((definition) => {
      const agent = definition.name;
      const runs = asNonNegativeInteger(runCounts[agent]);
      const executions = asNonNegativeInteger(executionCounts[agent], runs);
      return [
        agent,
        normalizeAgentProgress(rawAgentProgress[agent], {
          state: fallbackAgentProgressState(
            agent,
            status,
            currentAgent,
            queuedAgent,
            runs
          ),
          runs,
          executions,
          queuePosition: queuedAgent === agent ? queuePosition : undefined
        })
      ];
    })
  ) as Record<AgentName, AgentProgress>;
  const completionGeneration = asNonNegativeInteger(
    data.completionGeneration
  );
  const rawMainCapabilities = asObject(data.mainCapabilities);
  const controlMode: MainCapabilitySnapshot["controlMode"] | undefined = rawMainCapabilities.controlMode === "autonomous" ||
    rawMainCapabilities.controlMode === "weak-branch"
    ? rawMainCapabilities.controlMode
    : undefined;
  const mainCapabilities = controlMode
    ? {
        schemaVersion: 1 as const,
        controlMode,
        routeCandidates: Array.isArray(rawMainCapabilities.routeCandidates)
          ? rawMainCapabilities.routeCandidates.filter(
              (candidate): candidate is string => typeof candidate === "string" &&
                (candidate === "finish" || configuredNames.has(candidate))
            )
          : [],
        canReconfigure: rawMainCapabilities.canReconfigure === true,
        canComplete: rawMainCapabilities.canComplete === true,
        canRequestUser: rawMainCapabilities.canRequestUser === true
      }
    : undefined;
  return {
    id,
    ...(collaboration ? { collaboration } : {}),
    title: asString(data.title, "未命名科研项目"),
    requirement: asString(data.requirement),
    status,
    phase,
    currentAgent,
    queuedAgent,
    activeInvocationId: optionalString(data.activeInvocationId),
    turn: asNonNegativeInteger(data.turn),
    cycle: Math.max(1, asNumber(data.cycle, 1)),
    queuePosition,
    queueDepth,
    queueEnteredAt:
      asString(data.queueEnteredAt) || undefined,
    agentProgress,
    overallProgress: normalizeOverallProgress(
      data.overallProgress,
      phase
    ),
    createdAt: asString(data.createdAt) || undefined,
    updatedAt: asString(data.updatedAt) || undefined,
    archivedAt: asString(data.archivedAt) || undefined,
    cancelledAt: asString(data.cancelledAt) || undefined,
    cancelledBy: asString(data.cancelledBy) || undefined,
    cancelReason: asString(data.cancelReason) || undefined,
    cancellationRequestedAt: asString(data.cancellationRequestedAt) || undefined,
    cancellationSettledAt: asString(data.cancellationSettledAt) || undefined,
    workspaceCheckpoints: Array.isArray(data.workspaceCheckpoints)
      ? data.workspaceCheckpoints.map((value) => {
          const entry = asObject(value);
          return {
            id: asString(entry.id), agent: asString(entry.agent),
            createdAt: asString(entry.createdAt), fileCount: asNonNegativeInteger(entry.fileCount),
            incomplete: asBoolean(entry.incomplete),
            status: entry.status === "no_output" ? "no_output" as const : "unverified_partial_output" as const
          };
        }).filter((entry) => /^chk_[a-f0-9]{32}$/.test(entry.id))
      : [],
    interruptedAt: asString(data.interruptedAt) || undefined,
    archivedAgentSessions,
    agents: normalizeAgents(data.agents, orchestration),
    orchestration,
    ...(Object.keys(normalizeProjectSkillDefinitions(data.skillDefinitions)).length
      ? { skillDefinitions: normalizeProjectSkillDefinitions(data.skillDefinitions) }
      : {}),
    ...(Object.keys(normalizeProjectMcpDefinitions(data.mcpDefinitions)).length
      ? { mcpDefinitions: normalizeProjectMcpDefinitions(data.mcpDefinitions) }
      : {}),
    loopIterations: normalizeLoopCounter(data.loopIterations, orchestration),
    loopBatches: normalizeLoopCounter(data.loopBatches, orchestration),
    loopTotalIterations: normalizeLoopCounter(data.loopTotalIterations, orchestration),
    latestHandoff: normalizeHandoffRecord(data.latestHandoff) ?? acceptedGitHandoff(data),
    latestAssignment: normalizeCurrentAssignment(
      data.latestAssignment,
      configuredNames,
      asObject(data.git).enabled === true
    ),
    completionGeneration,
    userIntervention: normalizeUserIntervention(
      data.userIntervention
    ),
    userInputs: normalizeProjectUserInputs(
      data.userInputs
    ),
    interruptionSnapshot: normalizeInterruptionSnapshot(data.interruptionSnapshot),
    ...(data.interruptRequest && typeof data.interruptRequest === "object"
      ? {
          interruptRequest: {
            inputId: asString(asObject(data.interruptRequest).inputId),
            invocationId: asString(asObject(data.interruptRequest).invocationId),
            agent: asString(asObject(data.interruptRequest).agent),
            requestedAt: asString(asObject(data.interruptRequest).requestedAt),
            deadlineAt: asString(asObject(data.interruptRequest).deadlineAt),
            ...(asObject(data.interruptRequest).forceTerminated === true ? { forceTerminated: true } : {})
          }
        }
      : {}),
    tokenUsage: normalizeProjectTokenUsage(
      data.tokenUsage,
      orchestration,
      archivedAgentSessions.map(entry => entry.agentId)
    ),
    performance: normalizeProjectPerformance(data.performance, orchestration, archivedAgentSessions.map(entry => entry.agentId)),
    computeUsage: normalizeProjectComputeUsage(
      data.computeUsage
    ),
    git: normalizeProjectGitState(data.git),
    workflowRevision: asNonNegativeInteger(data.workflowRevision),
    activeNodeRunId: optionalString(data.activeNodeRunId),
    ...normalizeScopedRuntime(data),
    scopedPullRequests: normalizePullRequests(data.scopedPullRequests),
    nodeRuns: normalizeNodeRuns(data.nodeRuns),
    groupRuns: normalizeGroupRuns(data.groupRuns),
    tasks: normalizeWorkTasks(data.tasks),
    executions: normalizeExecutions(data.executions),
    pullRequests: normalizePullRequests(data.pullRequests),
    operations: normalizeOperations(data.operations),
    runtime: normalizeProjectRuntimeProjection(data.runtime),
    failureAttempts,
    failureSummary: deriveFailureAttemptSummary(failureAttempts, data.failureSummary),
    mainContextSeq: asNonNegativeInteger(data.mainContextSeq),
    ...(mainCapabilities ? { mainCapabilities } : {}),
    configurationLocked: asBoolean(data.configurationLocked),
    lockedAt: asString(data.lockedAt) || undefined,
    display: normalizeDisplaySelection(
      data.display,
      new Set([...configuredNames, ...publishedArtifacts.flatMap(artifact => artifact.agent ? [artifact.agent] : [])]),
      asObject(data.git).enabled === true
    ),
    displayError: asString(data.displayError) || undefined,
    artifacts: publishedArtifacts,
    error:
      asString(data.error ?? data.lastError) ||
      undefined
  };
}

function normalizeProjectRuntimeActivity(value: unknown): ProjectRuntimeActivity | undefined {
  const raw = asObject(value);
  const kind = raw.kind === "resident" || raw.kind === "turn" ? raw.kind : undefined;
  const phase = ["resident:starting", "resident:running", "model:running"]
    .includes(String(raw.phase))
    ? raw.phase as ProjectRuntimeActivity["phase"]
    : undefined;
  const leaseState = raw.leaseState === "current" || raw.leaseState === "recovering"
    ? raw.leaseState
    : undefined;
  const activityId = optionalString(raw.activityId);
  const projectId = optionalString(raw.projectId);
  const invocationId = optionalString(raw.invocationId);
  const agentId = optionalString(raw.agentId);
  const nodeRunId = optionalString(raw.nodeRunId);
  const startedAt = optionalString(raw.startedAt);
  const writerLeaseEpoch = asPositiveInteger(raw.writerLeaseEpoch);
  if (!kind || !phase || !leaseState || !activityId || !projectId ||
    !invocationId || !agentId || !nodeRunId || !startedAt || !writerLeaseEpoch) {
    return undefined;
  }
  return {
    activityId,
    projectId,
    kind,
    phase,
    invocationId,
    agentId,
    nodeRunId,
    ...(typeof raw.scopeKind === "string" && ["scoped-agent", "scoped-leader", "scoped-main", "terminal-push-observation", "terminal-push-coordinator"].includes(raw.scopeKind)
      ? { scopeKind: raw.scopeKind as ProjectRuntimeActivity["scopeKind"] } : {}),
    ...copyOptionalStrings(raw, ["groupRunId", "taskId", "executionId", "inputId"]),
    ...(asPositiveInteger(raw.ownershipEpoch)
      ? { ownershipEpoch: asPositiveInteger(raw.ownershipEpoch) }
      : {}),
    ...(asPositiveInteger(raw.coordinatorEpoch)
      ? { coordinatorEpoch: asPositiveInteger(raw.coordinatorEpoch) }
      : {}),
    startedAt,
    writerLeaseEpoch,
    leaseState
  };
}

export function normalizeProjectRuntimeProjection(
  value: unknown
): ProjectRuntimeProjection | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = asObject(value);
  const activities = Array.isArray(raw.activities)
    ? raw.activities.flatMap((activity) => {
        const normalized = normalizeProjectRuntimeActivity(activity);
        return normalized ? [normalized] : [];
      })
    : [];
  const primary = normalizeProjectRuntimeActivity(raw.primaryActivity);
  const waiting = asObject(raw.waiting);
  const waitingKind = waiting.kind === "recovery" || waiting.kind === "management" || waiting.kind === "workflow-adjustment"
    ? waiting.kind : undefined;
  const waitingReason = optionalString(waiting.reason);
  const currentAgent = optionalString(raw.currentAgent);
  const activeInvocationId = optionalString(raw.activeInvocationId);
  const activityStartedAt = optionalString(raw.activityStartedAt);
  const leaseState = raw.leaseState === "current" || raw.leaseState === "recovering"
    ? raw.leaseState
    : undefined;
  return {
    stateRevision: asNonNegativeInteger(raw.stateRevision),
    status: normalizeStatus(raw.status),
    phase: asString(raw.phase, "collaboration:ready"),
    ...(waitingKind && waitingReason ? { waiting: { kind: waitingKind, reason: waitingReason,
      ...copyOptionalStrings(waiting, ["agentId", "groupRunId", "executionId", "operationId"]) } } : {}),
    ...(currentAgent ? { currentAgent } : {}),
    ...(activeInvocationId ? { activeInvocationId } : {}),
    ...(activityStartedAt ? { activityStartedAt } : {}),
    ...copyOptionalStrings(raw, ["nodeRunId", "groupRunId", "taskId", "executionId"]),
    ...(asPositiveInteger(raw.ownershipEpoch)
      ? { ownershipEpoch: asPositiveInteger(raw.ownershipEpoch) }
      : {}),
    ...(asPositiveInteger(raw.coordinatorEpoch)
      ? { coordinatorEpoch: asPositiveInteger(raw.coordinatorEpoch) }
      : {}),
    ...(leaseState ? { leaseState } : {}),
    executionCount: asNonNegativeInteger(raw.executionCount),
    ...(primary ? { primaryActivity: primary } : {}),
    activities
  };
}

export function normalizeProjects(value: unknown): Project[] {
  const source = Array.isArray(asObject(value).projects)
    ? (asObject(value).projects as unknown[])
    : [];
  return source.map(normalizeProject).filter((project) => project.id);
}

export function normalizeSkills(value: unknown): SkillDefinition[] {
  const source = Array.isArray(asObject(value).skills)
    ? (asObject(value).skills as unknown[])
    : [];
  return source
    .map((item) => {
      if (typeof item === "string") return { id: item, name: item };
      const skill = asObject(item);
      const id = asString(skill.id);
      return {
        id,
        name: asString(skill.name, id),
        description: asString(skill.description) || undefined,
        category: asString(skill.category) || undefined
      };
    })
    .filter((skill) => skill.id);
}

export function normalizeEvent(value: unknown): AgentEvent | undefined {
  const data = asObject(value);
  let payload = asObject(data.data);
  // Older resident invocations persisted the same public Harness envelope
  // under `event`. Both history and SSE must survive ephemeral cache cleanup.
  const resident = asObject(payload.resident === true ? payload.canonicalEvent ?? payload.event : undefined);
  const residentEvent = resident.schemaVersion === 1 && typeof resident.eventId === "string" &&
    typeof resident.invocationId === "string" && typeof resident.harnessId === "string" &&
    typeof resident.kind === "string" ? resident : undefined;
  if (residentEvent && payload.canonicalEvent === undefined) payload = { ...payload, canonicalEvent: residentEvent };
  const seq = asNumber(data.seq, -1);
  if (seq < 0) return undefined;
  const field = (name: string): unknown => data[name] ?? payload[name];
  const agent = field("agent") ?? field("agentId");
  return {
    ...copyOptionalStrings(
      Object.fromEntries([
        "eventId", "requestId", "projectId", "nodeId", "nodeRunId", "groupRunId",
        "agentId", "taskId", "executionId", "invocationId"
      ].map((name) => [name, field(name)])),
      [
        "eventId", "requestId", "projectId", "nodeId", "nodeRunId", "groupRunId",
        "agentId", "taskId", "executionId", "invocationId"
      ]
    ),
    seq,
    ...(Number.isFinite(field("workflowRevision"))
      ? { workflowRevision: asNonNegativeInteger(field("workflowRevision")) }
      : {}),
    ...(Number.isFinite(field("ownershipEpoch"))
      ? { ownershipEpoch: asNonNegativeInteger(field("ownershipEpoch")) }
      : {}),
    ...(Number.isFinite(field("coordinatorEpoch"))
      ? { coordinatorEpoch: asNonNegativeInteger(field("coordinatorEpoch")) }
      : {}),
    type: asString(data.type, "trace"),
    agent: typeof agent === "string" ? agent : undefined,
    message: residentEvent
      ? asString(residentEvent.message, asString(asObject(residentEvent.diagnostic).message,
          asString(asObject(residentEvent.tool).name, asString(data.message))))
      : asString(data.message),
    data: payload,
    ts: asString(data.ts, new Date().toISOString())
  };
}

export function mergeEvents(
  current: AgentEvent[],
  incoming: AgentEvent | AgentEvent[]
): AgentEvent[] {
  const next = Array.isArray(incoming) ? incoming : [incoming];
  if (!next.length) return current;
  const lastCurrentSeq = current.at(-1)?.seq ?? Number.NEGATIVE_INFINITY;
  const currentEventIds = new Set(current.flatMap((event) => event.eventId ? [event.eventId] : []));
  const nextEventIds = new Set<string>();
  let previousSeq = lastCurrentSeq;
  let appendOnly = true;
  for (const event of next) {
    if (event.seq <= previousSeq || (event.eventId && (currentEventIds.has(event.eventId) || nextEventIds.has(event.eventId)))) {
      appendOnly = false;
      break;
    }
    if (event.eventId) nextEventIds.add(event.eventId);
    previousSeq = event.seq;
  }
  if (appendOnly) return [...current, ...next];

  const bySeq = new Map(current.map((event) => [event.seq, event]));
  const seqByEventId = new Map(
    current.flatMap((event) => event.eventId ? [[event.eventId, event.seq] as const] : [])
  );
  for (const event of next) {
    if (event.eventId) {
      const previousEventSeq = seqByEventId.get(event.eventId);
      if (previousEventSeq !== undefined && previousEventSeq !== event.seq) {
        bySeq.delete(previousEventSeq);
      }
      seqByEventId.set(event.eventId, event.seq);
    }
    bySeq.set(event.seq, event);
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

function normalizeArtifactItem(item: unknown, includeVariants = true): Artifact | undefined {
  const raw = asObject(item);
  const path = asString(raw.path);
  if (!path) return undefined;
  const extension = path.split(".").pop()?.toLowerCase();
  const agent = raw.producer ?? raw.agent;
  const rawCycle = raw.cycle;
  return {
    id: asString(raw.id) || undefined,
    path,
    name: asString(raw.name, path.split("/").pop() || path),
    kind:
      raw.kind === "markdown" || raw.kind === "latex" || raw.kind === "text"
        ? raw.kind
        : extension === "md" || extension === "markdown"
          ? "markdown"
          : extension === "tex"
            ? "latex"
            : "text",
    agent: typeof agent === "string" ? agent : undefined,
    origin: "workspace",
    cycle:
      typeof rawCycle === "number" && Number.isFinite(rawCycle)
        ? rawCycle
        : undefined,
    mediaType: asString(raw.mediaType) || undefined,
    size: asNumber(raw.size, undefined),
    updatedAt: asString(raw.updatedAt) || undefined,
    title: asString(raw.title) || undefined,
    description: asString(raw.description) || undefined,
    workspaceId: asString(raw.workspaceId) || undefined,
    workspaceLabel: asString(raw.workspaceLabel) || undefined,
    ...(includeVariants && Array.isArray(raw.variants) ? { variants: raw.variants.flatMap(item => {
      const variant = normalizeArtifactItem(item, false); return variant ? [variant] : [];
    }) } : {}),
    sha256: /^[a-f0-9]{64}$/.test(asString(raw.sha256))
      ? asString(raw.sha256)
      : undefined,
    commitSha: /^[a-f0-9]{40,64}$/.test(asString(raw.commitSha ?? asObject(raw.gitSource).commitSha))
      ? asString(raw.commitSha ?? asObject(raw.gitSource).commitSha)
      : undefined
  } satisfies Artifact;
}

export function normalizeArtifacts(value: unknown): Artifact[] {
  const source = Array.isArray(value) ? value : [];
  const normalized = source.flatMap((item) => {
    const artifact = normalizeArtifactItem(item);
    return artifact ? [artifact] : [];
  });
  const latestByPath = new Map<string, Artifact>();
  for (const artifact of normalized) {
    // Preserve the newest version of a producer/path pair in the catalog.
    const key = `${artifact.agent ?? "system"}:${artifact.path}`;
    latestByPath.set(key, artifact);
  }
  return [...latestByPath.values()];
}

export function normalizeArtifactSummary(value: unknown): ArtifactCatalogSummary {
  const data = asObject(value);
  const rawGroups = asObject(data.groups);
  const groups = Object.fromEntries(
    Object.keys(rawGroups).map((agent) => [
      agent,
      asNonNegativeInteger(rawGroups[agent])
    ])
  ) as Record<AgentName, number>;
  return {
    groups,
    total: asNonNegativeInteger(data.total)
  };
}

export function normalizeArtifactPage(value: unknown): ArtifactCatalogPage {
  const data = asObject(value);
  const summary = normalizeArtifactSummary(data);
  return {
    ...summary,
    artifacts: normalizeArtifacts(data.artifacts),
    offset: asNonNegativeInteger(data.offset),
    limit: Math.max(1, asNonNegativeInteger(data.limit) || 100),
    hasMore: data.hasMore === true
  };
}

export function normalizeArtifactDirectoryPage(
  value: unknown
): ArtifactDirectoryPage {
  const data = asObject(value);
  const rawAgent = data.agent;
  const agent = typeof rawAgent === "string" ? rawAgent : "main";
  const entries = (Array.isArray(data.entries) ? data.entries : []).flatMap(
    (item): ArtifactDirectoryEntry[] => {
      const raw = asObject(item);
      const type =
        raw.type === "directory"
          ? "directory"
          : raw.type === "file"
            ? "file"
            : undefined;
      const artifact = normalizeArtifactItem({
        ...raw,
        producer: raw.producer ?? agent,
        origin: raw.origin ?? "workspace"
      });
      return type && artifact ? [{ ...artifact, type }] : [];
    }
  );
  const rawParent = data.parent;
  return {
    agent,
    directory: asString(data.directory),
    parent: typeof rawParent === "string" ? rawParent : undefined,
    entries,
    offset: asNonNegativeInteger(data.offset),
    limit: Math.max(1, asNonNegativeInteger(data.limit) || 50),
    total: asNonNegativeInteger(data.total),
    hasMore: data.hasMore === true
  };
}

export function formatRelativeTime(value?: string): string {
  if (!value) return "刚刚";
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return "刚刚";
  const seconds = Math.round((time - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

export function formatClock(value?: string): string {
  if (!value) return "--:--";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "--:--";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date);
}

export function formatTokenCount(value?: number): string {
  const count = Math.max(0, Math.floor(value ?? 0));
  return new Intl.NumberFormat("zh-CN").format(count);
}

export function humanFileSize(value?: number): string {
  if (value === undefined || value < 0) return "";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
