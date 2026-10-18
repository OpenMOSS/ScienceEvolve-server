import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AGENT_PROTOCOLS,
  GatewayStore,
  type AdapterSmokeProbeRunner,
  type AgentHarness,
  type AgentProtocol,
  type GatewayProbeStageResult,
  type GatewayTestResult
} from "./agent-runtime.js";
import type { GatewayHostnameResolver } from "./gateway-security.js";
import { validateGatewayNetworkTarget } from "./gateway-security.js";
import { nowIso, redactTrace } from "./utils.js";

export const REAL_ACCEPTANCE_AUTHORIZATION =
  "I_UNDERSTAND_EXTERNAL_CALLS_AND_COSTS";

export type RealGatewayAcceptancePhase = "matrix" | "faults" | "all";

interface GatewaySourceDefinition {
  id: "aigw" | "sii" | "deepseek";
  name: string;
  apiKeyVariable: string;
  alternateApiKeyVariable?: string;
  urlVariable: string;
  fallbackUrl?: string;
  modelsVariable: string;
  fallbackModelsVariable?: string;
  fallbackModels?: string[];
  protocolsVariable: string;
  fallbackProtocols?: AgentProtocol[];
}

const GATEWAY_SOURCES: readonly GatewaySourceDefinition[] = [
  {
    id: "aigw",
    name: "AIGW",
    apiKeyVariable: "AIGW_API_KEY",
    urlVariable: "AIGW_BASE_URL",
    fallbackUrl: "https://aigw.sotatts.online/v1",
    modelsVariable: "OPENFARS_AIGW_ACCEPTANCE_MODELS",
    // The current real-acceptance configuration is Kimi-only. An explicit
    // OPENFARS_AIGW_ACCEPTANCE_MODELS value is still preferred, but the
    // fallback must never silently reintroduce the superseded Nex model.
    fallbackModels: ["kimi-k3"],
    protocolsVariable: "OPENFARS_AIGW_ACCEPTANCE_PROTOCOLS",
    fallbackProtocols: ["responses"]
  },
  {
    id: "sii",
    name: "SII Qwen3.8-27B",
    apiKeyVariable: "SII_API_KEY",
    alternateApiKeyVariable: "INF_API_KEY",
    urlVariable: "SII_BASE_URL",
    modelsVariable: "OPENFARS_SII_ACCEPTANCE_MODELS",
    fallbackModelsVariable: "SII_MODEL",
    protocolsVariable: "OPENFARS_SII_ACCEPTANCE_PROTOCOLS",
    fallbackProtocols: ["chat-completions"]
  },
  {
    id: "deepseek",
    name: "SII DeepSeek-V4-Flash",
    apiKeyVariable: "DEEPSEEK_API_KEY",
    urlVariable: "DEEPSEEK_BASE_URL",
    fallbackUrl: "https://d8cj8amkhbkccckmh5g9cpdh5ogm8cpk.openapi-sj.sii.edu.cn/v1",
    modelsVariable: "OPENFARS_DEEPSEEK_ACCEPTANCE_MODELS",
    fallbackModelsVariable: "DEEPSEEK_MODEL",
    fallbackModels: ["dsv4-flash-0731"],
    protocolsVariable: "OPENFARS_DEEPSEEK_ACCEPTANCE_PROTOCOLS",
    fallbackProtocols: ["responses"]
  }
] as const;

export interface RealGatewayAcceptancePlan {
  id: string;
  name: string;
  url: string;
  apiKey: string;
  apiKeyVariable: string;
  models: string[];
  protocols: AgentProtocol[];
  harnesses: AgentHarness[];
}

export interface PublicRealGatewayAcceptancePlan {
  id: string;
  name: string;
  url: string;
  apiKeyVariable: string;
  credentialConfigured: boolean;
  models: string[];
  protocols: AgentProtocol[];
  harnesses: AgentHarness[];
  matrixCombinations: number;
  minimumMatrixRequests: number;
  maximumMatrixRequests: number;
}

export interface SanitizedGatewayTestResult {
  status: "passed" | "failed";
  protocol: AgentProtocol;
  model: string;
  testedAt: string;
  error?: string;
  durationMs?: number;
  stageResults?: GatewayProbeStageResult[];
  httpStatus?: number;
  harness?: AgentHarness;
  nativeProtocol?: AgentProtocol;
  routeMode?: "direct" | "proxy";
  routeDirection?: `${AgentProtocol}->${AgentProtocol}`;
  probeKind?: "route" | "adapter-smoke";
  cacheKey?: string;
  adapterVersion?: string;
  executableFingerprint?: string;
  gatewayRevision?: number;
  routerCompatibilityVersion?: string;
}

export interface GatewayMatrixEvidence {
  gateway: string;
  protocol: AgentProtocol;
  model: string;
  results: SanitizedGatewayTestResult[];
  routeResults: SanitizedGatewayTestResult[];
  adapterSmokeResults: SanitizedGatewayTestResult[];
  passed: boolean;
}

export interface GatewayFaultEvidence {
  gateway: string;
  harness: AgentHarness;
  protocol: AgentProtocol;
  model: string;
  invalidCredential: {
    passed: boolean;
    kind: "gateway-route-invalid-credential";
    expectedHttpStatuses: readonly [401, 403];
    result: SanitizedGatewayTestResult;
  };
  invalidModel: {
    passed: boolean;
    kind: "gateway-route-invalid-model";
    expectedHttpStatuses: readonly [400, 404, 422, 503];
    result: SanitizedGatewayTestResult;
  };
  retry: {
    passed: boolean;
    injectedStatus: 503;
    fetchCalls: number;
    delegatedCalls: number;
    result: SanitizedGatewayTestResult;
  };
  timeout: {
    passed: boolean;
    kind: "post-dispatch-response-withholding";
    dispatchedCalls: number;
    abortObserved: boolean;
    result: SanitizedGatewayTestResult;
  };
  cancellation: {
    passed: boolean;
    kind: "real-stream-client-abort";
    responseStatus?: number;
    chunkObserved: boolean;
    signalAborted: boolean;
    readerRejectedAfterAbort: boolean;
    readerDoneAfterAbort: boolean;
    error?: string;
  };
  passed: boolean;
}

export interface RealGatewayAcceptanceEvidence {
  schemaVersion: 1;
  kind: "openfars-real-gateway-acceptance";
  startedAt: string;
  finishedAt: string;
  phase: RealGatewayAcceptancePhase;
  authorization: "explicit-environment-opt-in";
  credentialHandling: {
    loadedAfterAuthorization: true;
    commandLineSecrets: false;
    isolatedTemporaryGatewayStore: true;
    temporaryGatewayStoreRemoved: boolean;
    evidenceContainsCredentials: false;
  };
  plan: PublicRealGatewayAcceptancePlan[];
  coverage: {
    bothRequiredGateways: boolean;
    allProtocolsPerGateway: boolean;
    allHarnessesPerGateway: boolean;
    allSixDirectedRoutes: boolean;
  };
  matrix: GatewayMatrixEvidence[];
  faults: GatewayFaultEvidence[];
  summary: {
    matrixCases: number;
    matrixPassed: number;
    matrixFailed: number;
    faultSuites: number;
    faultSuitesPassed: number;
    faultSuitesFailed: number;
    allRequestedChecksPassed: boolean;
    fullDocumentMatrixPassed: boolean;
  };
}

export function assertRealAcceptanceAuthorized(
  environment: NodeJS.ProcessEnv
): void {
  if (
    environment.OPENFARS_ALLOW_REAL_ACCEPTANCE !==
    REAL_ACCEPTANCE_AUTHORIZATION
  ) {
    throw new Error(
      "真实验收默认关闭；必须通过 OPENFARS_ALLOW_REAL_ACCEPTANCE 显式确认外部调用与可能费用"
    );
  }
}

/** Apply the same gateway network policy to real Adapter smoke runs. */
export function createRealAcceptanceGatewayTargetValidator(
  resolver?: GatewayHostnameResolver
): (url: string) => Promise<string> {
  return (url) => validateGatewayNetworkTarget(url, resolver);
}

export function parseRealGatewayAcceptancePhase(
  value: string | undefined
): RealGatewayAcceptancePhase {
  const normalized = value?.trim() || "all";
  if (normalized === "matrix" || normalized === "faults" || normalized === "all") {
    return normalized;
  }
  throw new Error("真实网关验收 phase 只能是 matrix、faults 或 all");
}

export function buildRealGatewayAcceptancePlans(
  environment: NodeJS.ProcessEnv,
  harnessCatalog: Pick<AdapterSmokeProbeRunner, "harnessIds" | "nativeProtocol">
): RealGatewayAcceptancePlan[] {
  const harnesses = parseHarnesses(
    environment.OPENFARS_ACCEPTANCE_HARNESSES,
    harnessCatalog
  );
  const selectedIds = parseGatewayIds(environment.OPENFARS_ACCEPTANCE_GATEWAYS);
  const sources = GATEWAY_SOURCES.filter((source) => selectedIds === undefined || selectedIds.includes(source.id));
  if (!sources.length) throw new Error("未选择任何已知真实网关");
  return sources.map((source) => {
    const configuredApiKeyVariable = environment[source.apiKeyVariable]?.trim()
      ? source.apiKeyVariable
      : source.alternateApiKeyVariable && environment[source.alternateApiKeyVariable]?.trim()
        ? source.alternateApiKeyVariable
        : source.apiKeyVariable;
    const apiKey = environment[configuredApiKeyVariable]?.trim() ?? "";
    if (!apiKey) {
      throw new Error(`缺少 ${source.apiKeyVariable}；未发起任何真实网关请求`);
    }
    const url =
      environment[source.urlVariable]?.trim() || source.fallbackUrl || "";
    if (!url) {
      throw new Error(`缺少 ${source.urlVariable}；未发起任何真实网关请求`);
    }
    const models = parseList(environment[source.modelsVariable]);
    if (!models.length && source.fallbackModelsVariable) {
      models.push(...parseList(environment[source.fallbackModelsVariable]));
    }
    if (!models.length) models.push(...(source.fallbackModels ?? []));
    if (!models.length) {
      throw new Error(`缺少 ${source.modelsVariable}；未发起任何真实网关请求`);
    }
    return {
      id: source.id,
      name: source.name,
      url,
      apiKey,
      apiKeyVariable: configuredApiKeyVariable,
      models,
      protocols: parseProtocols(
        environment[source.protocolsVariable] ?? source.fallbackProtocols?.join(",")
      ),
      harnesses
    };
  });
}

function parseGatewayIds(value: string | undefined): Array<GatewaySourceDefinition["id"]> | undefined {
  if (value === undefined || !value.trim()) return undefined;
  const entries = parseList(value);
  if (!entries.length || entries.some((entry) => !["aigw", "sii", "deepseek"].includes(entry))) {
    throw new Error("验收网关只能是 aigw、sii 或 deepseek");
  }
  return entries as Array<GatewaySourceDefinition["id"]>;
}

function parseRequiredGatewayIds(
  environment: NodeJS.ProcessEnv
): Set<GatewaySourceDefinition["id"]> {
  const entries = environment.OPENFARS_ACCEPTANCE_REQUIRED_GATEWAYS?.trim()
    ? parseGatewayIds(environment.OPENFARS_ACCEPTANCE_REQUIRED_GATEWAYS)
    : (["aigw", "sii"] as Array<GatewaySourceDefinition["id"]>);
  return new Set(entries ?? []);
}

export function publicRealGatewayAcceptancePlan(
  plan: RealGatewayAcceptancePlan
): PublicRealGatewayAcceptancePlan {
  const matrixCombinations =
    plan.models.length * plan.protocols.length * plan.harnesses.length;
  return {
    id: plan.id,
    name: plan.name,
    url: publicGatewayUrl(plan.url),
    apiKeyVariable: plan.apiKeyVariable,
    credentialConfigured: Boolean(plan.apiKey),
    models: [...plan.models],
    protocols: [...plan.protocols],
    harnesses: [...plan.harnesses],
    matrixCombinations,
    // Each production combination performs text/tool x ordinary/streaming.
    minimumMatrixRequests: matrixCombinations * 5,
    // Every production probe retries a retryable first response once.
    maximumMatrixRequests: matrixCombinations * 9
  };
}

export function sanitizeAcceptanceText(
  value: string,
  secrets: readonly string[]
): string {
  let sanitized = value;
  for (const secret of secrets) {
    if (secret) sanitized = sanitized.split(secret).join("[REDACTED]");
  }
  return redactTrace(sanitized).slice(0, 1_000);
}

export function sanitizeGatewayTestResult(
  result: GatewayTestResult,
  secrets: readonly string[]
): SanitizedGatewayTestResult {
  return {
    status: result.status,
    protocol: result.protocol,
    model: result.model,
    testedAt: result.testedAt,
    ...(result.error
      ? { error: sanitizeAcceptanceText(result.error, secrets) }
      : {}),
    ...(result.durationMs === undefined
      ? {}
      : { durationMs: result.durationMs }),
    ...(result.stageResults?.length
      ? {
          stageResults: result.stageResults.map((stage) => ({
            ...stage,
            ...(stage.error ? { error: sanitizeAcceptanceText(stage.error, secrets) } : {})
          }))
        }
      : {}),
    ...(result.httpStatus === undefined
      ? {}
      : { httpStatus: result.httpStatus }),
    ...(result.harness ? { harness: result.harness } : {}),
    ...(result.nativeProtocol
      ? { nativeProtocol: result.nativeProtocol }
      : {}),
    ...(result.routeMode ? { routeMode: result.routeMode } : {}),
    ...(result.routeDirection
      ? { routeDirection: result.routeDirection }
      : {}),
    ...(result.probeKind ? { probeKind: result.probeKind } : {}),
    ...(result.cacheKey ? { cacheKey: result.cacheKey } : {}),
    ...(result.adapterVersion ? { adapterVersion: result.adapterVersion } : {}),
    ...(result.executableFingerprint
      ? { executableFingerprint: result.executableFingerprint }
      : {}),
    ...(result.gatewayRevision === undefined
      ? {}
      : { gatewayRevision: result.gatewayRevision }),
    ...(result.routerCompatibilityVersion
      ? { routerCompatibilityVersion: result.routerCompatibilityVersion }
      : {})
  };
}

export async function runRealGatewayAcceptance(options: {
  plans: RealGatewayAcceptancePlan[];
  phase: RealGatewayAcceptancePhase;
  evidenceDirectory: string;
  authorization: string | undefined;
  fetch?: typeof globalThis.fetch;
  resolveHostname?: GatewayHostnameResolver;
  now?: () => Date;
  adapterSmokeProbe: AdapterSmokeProbeRunner;
}): Promise<{ evidence: RealGatewayAcceptanceEvidence; evidencePath: string }> {
  // Keep the safety gate in the core operation as well as the CLI so importing
  // this module cannot silently bypass the explicit external-call opt-in.
  assertRealAcceptanceAuthorized({
    OPENFARS_ALLOW_REAL_ACCEPTANCE: options.authorization
  });
  const startedAt = (options.now?.() ?? new Date()).toISOString();
  const secrets = options.plans.map((plan) => plan.apiKey).filter(Boolean);
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const acceptanceTimeoutMs = Number.parseInt(
    process.env.OPENFARS_ACCEPTANCE_TIMEOUT_MS ?? "120000",
    10
  );
  const temporaryRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "openfars-real-gateway-acceptance-")
  );
  let temporaryGatewayStoreRemoved = false;
  const matrix: GatewayMatrixEvidence[] = [];
  const faults: GatewayFaultEvidence[] = [];
  try {
    if (options.phase === "matrix" || options.phase === "all") {
      for (const plan of options.plans) {
        for (const protocol of plan.protocols) {
          for (const model of plan.models) {
            const storeRoot = path.join(
              temporaryRoot,
              safeSegment(`${plan.id}-${protocol}-${model}`)
            );
            const store = new GatewayStore(storeRoot, {
              fetch: fetchImpl,
              resolveHostname: options.resolveHostname,
              adapterSmokeProbe: options.adapterSmokeProbe,
              ...(Number.isFinite(acceptanceTimeoutMs)
                ? { testTimeoutMs: acceptanceTimeoutMs }
                : {})
            });
            const gateway = await store.create({
              name: `${plan.name} ${protocol} ${model}`,
              url: plan.url,
              apiKey: plan.apiKey,
              models: [model],
              defaultModel: model,
              protocol
            });
            const result = await store.testMatrix(gateway.id, {
              harnesses: plan.harnesses,
              models: [model]
            });
            const persistedResults = result.gateway.tests ?? result.results;
            const sanitized = persistedResults.map((entry) =>
              sanitizeGatewayTestResult({
                ...entry,
                protocol: entry.protocol ?? protocol,
                model: entry.model ?? model,
                testedAt: entry.testedAt ?? (options.now?.() ?? new Date()).toISOString(),
                status: entry.status === "passed" ? "passed" : "failed"
              }, secrets)
            );
            const routeResults = sanitized.filter((entry) => entry.probeKind !== "adapter-smoke");
            const adapterSmokeResults = sanitized.filter((entry) => entry.probeKind === "adapter-smoke");
            matrix.push({
              gateway: plan.id,
              protocol,
              model,
              results: sanitized,
              routeResults,
              adapterSmokeResults,
              passed:
                routeResults.length === plan.harnesses.length &&
                adapterSmokeResults.length === plan.harnesses.length &&
                sanitized.every((entry) => entry.status === "passed")
            });
          }
        }
      }
    }

    if (options.phase === "faults" || options.phase === "all") {
      for (const plan of options.plans) {
        for (const protocol of plan.protocols) {
          faults.push(
            await runFaultSuite({
              plan,
              protocol,
              model: plan.models[0]!,
              root: temporaryRoot,
              fetchImpl,
              resolveHostname: options.resolveHostname,
              secrets,
              adapterSmokeProbe: options.adapterSmokeProbe
            })
          );
        }
      }
    }
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
    temporaryGatewayStoreRemoved = true;
  }

  const matrixPassed = matrix.filter((entry) => entry.passed).length;
  const faultSuitesPassed = faults.filter((entry) => entry.passed).length;
  const requestedMatrix = options.phase === "matrix" || options.phase === "all";
  const requestedFaults = options.phase === "faults" || options.phase === "all";
  const requiredGatewayIds = parseRequiredGatewayIds(process.env);
  const bothRequiredGateways = [...requiredGatewayIds].every((id) =>
    options.plans.some((plan) => plan.id === id)
  );
  const allProtocolsPerGateway =
    options.plans.length > 0 &&
    options.plans.every((plan) =>
      AGENT_PROTOCOLS.every((protocol) => plan.protocols.includes(protocol))
    );
  const allHarnessesPerGateway =
    options.plans.length > 0 &&
    options.plans.every((plan) =>
      options.adapterSmokeProbe.harnessIds().every((harness) =>
        plan.harnesses.includes(harness)
      )
    );
  const allSixDirectedRoutes =
    allProtocolsPerGateway && allHarnessesPerGateway;
  const allRequestedChecksPassed =
    (!requestedMatrix || (matrix.length > 0 && matrixPassed === matrix.length)) &&
    (!requestedFaults ||
      (faults.length > 0 && faultSuitesPassed === faults.length));
  const evidence: RealGatewayAcceptanceEvidence = {
    schemaVersion: 1,
    kind: "openfars-real-gateway-acceptance",
    startedAt,
    finishedAt: (options.now?.() ?? new Date()).toISOString(),
    phase: options.phase,
    authorization: "explicit-environment-opt-in",
    credentialHandling: {
      loadedAfterAuthorization: true,
      commandLineSecrets: false,
      isolatedTemporaryGatewayStore: true,
      temporaryGatewayStoreRemoved,
      evidenceContainsCredentials: false
    },
    plan: options.plans.map(publicRealGatewayAcceptancePlan),
    coverage: {
      bothRequiredGateways,
      allProtocolsPerGateway,
      allHarnessesPerGateway,
      allSixDirectedRoutes
    },
    matrix,
    faults,
    summary: {
      matrixCases: matrix.length,
      matrixPassed,
      matrixFailed: matrix.length - matrixPassed,
      faultSuites: faults.length,
      faultSuitesPassed,
      faultSuitesFailed: faults.length - faultSuitesPassed,
      allRequestedChecksPassed,
      fullDocumentMatrixPassed:
        options.phase === "all" &&
        bothRequiredGateways &&
        allSixDirectedRoutes &&
        allRequestedChecksPassed
    }
  };

  await assertEvidenceDoesNotContainSecrets(evidence, secrets);
  await fs.mkdir(options.evidenceDirectory, { recursive: true });
  const timestamp = evidence.finishedAt.replace(/[:.]/g, "-");
  const evidencePath = path.join(
    options.evidenceDirectory,
    `real-gateway-acceptance-${timestamp}.json`
  );
  await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx"
  });
  return { evidence, evidencePath };
}

async function runFaultSuite(options: {
  plan: RealGatewayAcceptancePlan;
  protocol: AgentProtocol;
  model: string;
  root: string;
  fetchImpl: typeof globalThis.fetch;
  resolveHostname?: GatewayHostnameResolver;
  secrets: readonly string[];
  adapterSmokeProbe: AdapterSmokeProbeRunner;
}): Promise<GatewayFaultEvidence> {
  const harness = harnessForNativeProtocol(
    options.protocol,
    options.plan.harnesses,
    options.adapterSmokeProbe
  );
  let counter = 0;
  const nextRoot = (label: string) =>
    path.join(
      options.root,
      safeSegment(`${options.plan.id}-${options.protocol}-${label}-${counter++}`)
    );

  const invalidCredentialRaw = await runSingleHarnessProbe({
    root: nextRoot("invalid-credential"),
    plan: options.plan,
    protocol: options.protocol,
    model: options.model,
    harness,
    apiKey: "openfars-deliberately-invalid-credential",
    fetchImpl: options.fetchImpl,
    resolveHostname: options.resolveHostname,
    adapterSmokeProbe: options.adapterSmokeProbe
  });
  const invalidCredentialResult = sanitizeGatewayTestResult(
    invalidCredentialRaw,
    options.secrets
  );
  const invalidCredential = {
    passed:
      invalidCredentialResult.status === "failed" &&
      (invalidCredentialResult.httpStatus === 401 ||
        invalidCredentialResult.httpStatus === 403),
    kind: "gateway-route-invalid-credential" as const,
    expectedHttpStatuses: [401, 403] as const,
    result: invalidCredentialResult
  };

  const invalidModelName = "openfars-deliberately-invalid-model";
  const invalidModelRaw = await runSingleHarnessProbe({
    root: nextRoot("invalid-model"),
    plan: options.plan,
    protocol: options.protocol,
    model: invalidModelName,
    harness,
    apiKey: options.plan.apiKey,
    fetchImpl: options.fetchImpl,
    resolveHostname: options.resolveHostname,
    adapterSmokeProbe: options.adapterSmokeProbe
  });
  const invalidModelResult = sanitizeGatewayTestResult(
    invalidModelRaw,
    options.secrets
  );
  const providerReportsMissingChannel =
    invalidModelResult.httpStatus === 503 &&
    /no available channel/i.test(invalidModelResult.error ?? "");
  const invalidModel = {
    passed:
      invalidModelResult.status === "failed" &&
      (invalidModelResult.httpStatus === 400 ||
        invalidModelResult.httpStatus === 404 ||
        invalidModelResult.httpStatus === 422 ||
        providerReportsMissingChannel),
    kind: "gateway-route-invalid-model" as const,
    // AIGW maps an unknown provider/model route to a specific 503
    // "no available channel" rejection.  Do not accept arbitrary 5xx
    // outages: the message classification above remains mandatory.
    expectedHttpStatuses: [400, 404, 422, 503] as const,
    result: invalidModelResult
  };

  let retryFetchCalls = 0;
  let retryDelegatedCalls = 0;
  const retryFetch: typeof globalThis.fetch = async (input, init) => {
    retryFetchCalls += 1;
    if (retryFetchCalls === 1) {
      return new Response(JSON.stringify({ error: "injected retryable response" }), {
        status: 503,
        headers: { "content-type": "application/json" }
      });
    }
    retryDelegatedCalls += 1;
    return options.fetchImpl(input, init);
  };
  const retryRaw = await runSingleHarnessProbe({
    root: nextRoot("retry"),
    plan: options.plan,
    protocol: options.protocol,
    model: options.model,
    harness,
    apiKey: options.plan.apiKey,
    fetchImpl: retryFetch,
    resolveHostname: options.resolveHostname,
    adapterSmokeProbe: options.adapterSmokeProbe
  });
  const retryResult = sanitizeGatewayTestResult(retryRaw, options.secrets);
  const retry = {
    passed:
      retryResult.status === "passed" &&
      retryFetchCalls >= 5 &&
      retryDelegatedCalls >= 4,
    injectedStatus: 503 as const,
    fetchCalls: retryFetchCalls,
    delegatedCalls: retryDelegatedCalls,
    result: retryResult
  };

  let dispatchedCalls = 0;
  let abortObserved = false;
  const timeoutFetch: typeof globalThis.fetch = async (input, init) => {
    dispatchedCalls += 1;
    const signal = init?.signal;
    void options.fetchImpl(input, init).then(
      async (response) => {
        await response.body?.cancel().catch(() => undefined);
      },
      () => undefined
    );
    return new Promise<Response>((_resolve, reject) => {
      const rejectAsAbort = () => {
        abortObserved = true;
        const error = new Error("acceptance timeout injection aborted");
        error.name = "AbortError";
        reject(error);
      };
      if (signal?.aborted) {
        rejectAsAbort();
        return;
      }
      signal?.addEventListener("abort", rejectAsAbort, { once: true });
    });
  };
  const timeoutRaw = await runSingleHarnessProbe({
    root: nextRoot("timeout"),
    plan: options.plan,
    protocol: options.protocol,
    model: options.model,
    harness,
    apiKey: options.plan.apiKey,
    fetchImpl: timeoutFetch,
    resolveHostname: options.resolveHostname,
    timeoutMs: 500,
    adapterSmokeProbe: options.adapterSmokeProbe
  });
  const timeoutResult = sanitizeGatewayTestResult(timeoutRaw, options.secrets);
  const timeout = {
    passed:
      timeoutResult.status === "failed" &&
      abortObserved &&
      /超时/.test(timeoutResult.error ?? ""),
    kind: "post-dispatch-response-withholding" as const,
    dispatchedCalls,
    abortObserved,
    result: timeoutResult
  };

  const cancellation = await runCancellationProbe(
    options.plan,
    options.protocol,
    options.model,
    options.fetchImpl,
    options.secrets
  );

  return {
    gateway: options.plan.id,
    harness,
    protocol: options.protocol,
    model: options.model,
    invalidCredential,
    invalidModel,
    retry,
    timeout,
    cancellation,
    passed:
      invalidCredential.passed &&
      invalidModel.passed &&
      retry.passed &&
      timeout.passed &&
      cancellation.passed
  };
}

async function runSingleHarnessProbe(options: {
  root: string;
  plan: RealGatewayAcceptancePlan;
  protocol: AgentProtocol;
  model: string;
  harness: AgentHarness;
  apiKey: string;
  fetchImpl: typeof globalThis.fetch;
  resolveHostname?: GatewayHostnameResolver;
  timeoutMs?: number;
  adapterSmokeProbe: AdapterSmokeProbeRunner;
}): Promise<GatewayTestResult> {
  const store = new GatewayStore(options.root, {
    fetch: options.fetchImpl,
    resolveHostname: options.resolveHostname,
    adapterSmokeProbe: options.adapterSmokeProbe,
    ...(Number.isFinite(Number.parseInt(process.env.OPENFARS_ACCEPTANCE_TIMEOUT_MS ?? "120000", 10))
      ? { testTimeoutMs: Number.parseInt(process.env.OPENFARS_ACCEPTANCE_TIMEOUT_MS ?? "120000", 10) }
      : {}),
    ...(options.timeoutMs === undefined
      ? {}
      : { testTimeoutMs: options.timeoutMs })
  });
  const gateway = await store.create({
    name: `${options.plan.name} ${options.protocol} ${options.model}`,
    url: options.plan.url,
    apiKey: options.apiKey,
    models: [options.model],
    defaultModel: options.model,
    protocol: options.protocol
  });
  return store.testHarness(gateway.id, options.harness, options.model);
}

async function runCancellationProbe(
  plan: RealGatewayAcceptancePlan,
  protocol: AgentProtocol,
  model: string,
  fetchImpl: typeof globalThis.fetch,
  secrets: readonly string[]
): Promise<GatewayFaultEvidence["cancellation"]> {
  const controller = new AbortController();
  let responseStatus: number | undefined;
  let chunkObserved = false;
  let readerRejectedAfterAbort = false;
  let readerDoneAfterAbort = false;
  let errorMessage: string | undefined;
  try {
    const response = await fetchImpl(
      `${plan.url.replace(/\/+$/, "")}/${endpointSuffix(protocol)}`,
      {
        method: "POST",
        headers: gatewayHeaders(protocol, plan.apiKey),
        body: JSON.stringify(cancellationBody(protocol, model)),
        redirect: "error",
        signal: controller.signal
      }
    );
    responseStatus = response.status;
    if (!response.ok) {
      errorMessage = `取消探测返回 HTTP ${response.status}`;
    } else if (!response.body) {
      errorMessage = "取消探测没有返回可取消的响应流";
    } else {
      const reader = response.body.getReader();
      const first = await readWithTimeout(reader, controller, 15_000);
      chunkObserved = !first.done && Boolean(first.value?.byteLength);
      controller.abort();
      try {
        const afterAbort = await reader.read();
        readerDoneAfterAbort = afterAbort.done;
        if (!afterAbort.done) {
          errorMessage = "取消探测在 abort 后仍收到响应流数据";
        }
      } catch {
        readerRejectedAfterAbort = true;
      }
      await reader.cancel().catch(() => undefined);
    }
  } catch (error) {
    if (controller.signal.aborted) {
      readerRejectedAfterAbort = true;
    } else {
      errorMessage = error instanceof Error ? error.message : "取消探测失败";
    }
  } finally {
    controller.abort();
  }
  const signalAborted = controller.signal.aborted;
  return {
    passed:
      responseStatus !== undefined &&
      responseStatus >= 200 &&
      responseStatus < 300 &&
      chunkObserved &&
      signalAborted &&
      (readerRejectedAfterAbort || readerDoneAfterAbort),
    kind: "real-stream-client-abort",
    ...(responseStatus === undefined ? {} : { responseStatus }),
    chunkObserved,
    signalAborted,
    readerRejectedAfterAbort,
    readerDoneAfterAbort,
    ...(errorMessage
      ? { error: sanitizeAcceptanceText(errorMessage, secrets) }
      : {})
  };
}

async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  controller: AbortController,
  timeoutMs: number
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`取消探测等待首个流事件超时（${timeoutMs}ms）`));
        }, timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function endpointSuffix(protocol: AgentProtocol): string {
  if (protocol === "responses") return "responses";
  if (protocol === "chat-completions") return "chat/completions";
  return "messages";
}

function gatewayHeaders(
  protocol: AgentProtocol,
  apiKey: string
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "text/event-stream, application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`
  };
  if (protocol === "anthropic-messages") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
  }
  return headers;
}

function cancellationBody(
  protocol: AgentProtocol,
  model: string
): Record<string, unknown> {
  const instruction =
    "Count from 1 upward, one number per line, until stopped by the client.";
  if (protocol === "responses") {
    return {
      model,
      input: instruction,
      stream: true,
      max_output_tokens: 256
    };
  }
  if (protocol === "chat-completions") {
    return {
      model,
      messages: [{ role: "user", content: instruction }],
      stream: true,
      max_tokens: 256
    };
  }
  return {
    model,
    messages: [{ role: "user", content: instruction }],
    stream: true,
    max_tokens: 256
  };
}

function harnessForNativeProtocol(
  protocol: AgentProtocol,
  selectedHarnesses: readonly AgentHarness[],
  harnessCatalog: Pick<AdapterSmokeProbeRunner, "harnessIds" | "nativeProtocol">
): AgentHarness {
  const registered = new Set(harnessCatalog.harnessIds());
  const harness = selectedHarnesses.find((candidate) =>
    registered.has(candidate) && harnessCatalog.nativeProtocol(candidate) === protocol
  );
  if (!harness) throw new Error(`当前 Registry 没有原生支持 ${protocol} 的 probe Adapter`);
  return harness;
}

function parseProtocols(value: string | undefined): AgentProtocol[] {
  const entries = parseList(value ?? "responses");
  if (
    entries.some(
      (entry) => !AGENT_PROTOCOLS.includes(entry as AgentProtocol)
    )
  ) {
    throw new Error(
      "验收协议只能是 responses、chat-completions、anthropic-messages"
    );
  }
  return entries as AgentProtocol[];
}

function parseHarnesses(
  value: string | undefined,
  harnessCatalog: Pick<AdapterSmokeProbeRunner, "harnessIds" | "nativeProtocol">
): AgentHarness[] {
  const registeredHarnesses = harnessCatalog.harnessIds();
  const registered = new Set(registeredHarnesses);
  const entries = parseList(value ?? registeredHarnesses.join(","));
  if (
    !entries.length ||
    entries.some((entry) => !registered.has(entry))
  ) {
    throw new Error(`验收 Harness 必须来自当前 Registry：${registeredHarnesses.join("、")}`);
  }
  return entries as AgentHarness[];
}

function parseList(value: string | undefined): string[] {
  return [
    ...new Set(
      (value ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    )
  ];
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 180);
}

function publicGatewayUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "[invalid URL]";
  }
}

async function assertEvidenceDoesNotContainSecrets(
  evidence: RealGatewayAcceptanceEvidence,
  secrets: readonly string[]
): Promise<void> {
  const serialized = JSON.stringify(evidence);
  if (secrets.some((secret) => secret && serialized.includes(secret))) {
    throw new Error("拒绝写入验收证据：脱敏检查发现凭据内容");
  }
}

export function expectedRealGatewayAcceptanceInputs(): Array<{
  gateway: string;
  requiredCredentialVariable: string;
  urlVariable: string;
  modelsVariable: string;
  protocolsVariable: string;
}> {
  return GATEWAY_SOURCES.map((source) => ({
    gateway: source.id,
    requiredCredentialVariable: source.apiKeyVariable,
    urlVariable: source.urlVariable,
    modelsVariable: source.modelsVariable,
    protocolsVariable: source.protocolsVariable
  }));
}

export function acceptanceTimestamp(): string {
  return nowIso();
}
