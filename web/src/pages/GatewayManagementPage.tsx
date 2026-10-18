import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ChevronDown,
  CheckCircle2,
  Copy,
  Eye,
  EyeOff,
  LoaderCircle,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  X
} from "lucide-react";
import {
  createGateway,
  deleteGateway,
  discoverGatewayModels,
  getCatalog,
  refreshGatewayModels,
  revealGatewayCredential,
  setDefaultGateway,
  testGateway,
  testGatewayMatrix,
  updateGateway
} from "../api";
import { Button, ErrorPanel } from "../components/Common";
import {
  gatewayCombinationTestState,
  harnessSupportsPurpose,
  protocolLabel
} from "../lib";
import type {
  AgentHarness,
  GatewayInput,
  GatewayReasoningOption,
  GatewayReasoningParameterPath,
  GatewayMatrixProgressEvent,
  GatewayProbeStageResult,
  GatewayRecord,
  GatewayTestProgressEvent,
  HarnessCatalogEntry
} from "../types";
import {
  DEFAULT_MODEL_CONTEXT_WINDOW,
  GATEWAY_REASONING_PARAMETER_PATHS,
  MAX_MODEL_CONTEXT_WINDOW
} from "../types";

const EMPTY_GATEWAY: GatewayInput = {
  name: "",
  url: "https://",
  apiKey: "",
  models: [],
  modelContextWindows: {},
  modelReasoning: {},
  defaultModel: "",
  protocol: "responses"
};

const GATEWAY_PROTOCOLS: GatewayInput["protocol"][] = [
  "responses",
  "chat-completions",
  "anthropic-messages"
];

type TestMode = "connection" | "matrix";

type TestStageResult = Omit<GatewayProbeStageResult, "status"> & {
  status: GatewayProbeStageResult["status"] | "cancelled" | "interrupted";
};

interface TestStep {
  key: string;
  harness?: AgentHarness;
  harnessLabel: string;
  model: string;
  reasoningOptionId?: string;
  status: "queued" | "running" | "passed" | "failed" | "cancelled";
  error?: string;
  durationMs?: number;
  stageResults?: TestStageResult[];
}

const REASONING_PARAMETER_LABELS: Record<GatewayReasoningParameterPath, string> = {
  reasoning_effort: "reasoning_effort",
  "reasoning.effort": "reasoning.effort",
  "chat_template_kwargs.reasoning_effort": "chat_template_kwargs.reasoning_effort",
  "thinking.effort": "thinking.effort"
};

function testedAtLabel(value?: string): string {
  if (!value) return "尚未测试";
  const time = Date.parse(value);
  return Number.isFinite(time)
    ? new Date(time).toLocaleString("zh-CN", { hour12: false })
    : value;
}

function durationLabel(value?: number): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  if (value < 1_000) return `${Math.round(value)}ms`;
  return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}s`;
}

const GATEWAY_STAGE_DEFINITIONS: Array<Pick<GatewayProbeStageResult, "stage" | "label" | "expectation" | "stream">> = [
  { stage: "text_ordinary", label: "文本普通", expectation: "text", stream: false },
  { stage: "text_stream", label: "文本流式", expectation: "text", stream: true },
  { stage: "tool_ordinary", label: "工具调用普通", expectation: "tool", stream: false },
  { stage: "tool_stream", label: "工具调用流式", expectation: "tool", stream: true },
  { stage: "adapter_smoke", label: "Harness 真实探测", expectation: "harness", stream: false }
];

const GATEWAY_STAGE_ORDER = GATEWAY_STAGE_DEFINITIONS.map((stage) => stage.stage);

function stageStatusLabel(status: TestStageResult["status"]): string {
  if (status === "cancelled") return "已取消";
  if (status === "interrupted") return "已中断";
  return status === "passed"
    ? "通过"
    : status === "failed"
      ? "失败"
      : status === "running"
        ? "测试中"
        : status === "queued"
          ? "等待中"
          : "未执行";
}

function mergeStageResults(
  current: TestStageResult[] | undefined,
  next: GatewayProbeStageResult
): TestStageResult[] {
  const byStage = new Map((current ?? []).map((stage) => [stage.stage, stage]));
  byStage.set(next.stage, next);
  return [...byStage.values()].sort((left, right) =>
    GATEWAY_STAGE_ORDER.indexOf(left.stage) - GATEWAY_STAGE_ORDER.indexOf(right.stage)
  );
}

function queuedStageResults(): GatewayProbeStageResult[] {
  return GATEWAY_STAGE_DEFINITIONS.map((stage) => ({ ...stage, status: "queued" }));
}

function runningStageResults(): GatewayProbeStageResult[] {
  return GATEWAY_STAGE_DEFINITIONS.map((stage, index) => ({ ...stage, status: index === 0 ? "running" : "queued" }));
}

function isTerminalTestStep(step: TestStep): boolean {
  return step.status === "passed" || step.status === "failed" || step.status === "cancelled";
}

function settleInterruptedTests(steps: TestStep[], cancelled: boolean, error: string): TestStep[] {
  return steps.map((step) => ({
    ...step,
    ...(!isTerminalTestStep(step) ? { status: cancelled ? "cancelled" as const : "failed" as const, error } : {}),
    stageResults: step.stageResults?.map((stage) => {
      if (stage.status === "running") {
        return { ...stage, status: cancelled ? "cancelled" as const : "interrupted" as const, error };
      }
      if (stage.status === "queued") return { ...stage, status: "skipped" as const, error };
      return stage;
    })
  }));
}

function isAbortReason(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && "name" in value && value.name === "AbortError");
}

/** Test errors are public diagnostics. Strip token-shaped text defensively. */
export function redactGatewayFailure(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value || "探测失败");
  return text
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/((?:api[-_ ]?key|token|secret)\s*[:=]\s*)[^\s,;&]+/gi, "$1[REDACTED]")
    .replace(/\b(?:sk|key)-[A-Za-z0-9._-]{8,}\b/g, "[REDACTED]")
    .replace(/([?&](?:key|api_key|token|secret)=)[^&#\s]+/gi, "$1[REDACTED]")
    .slice(0, 600);
}

function draftErrors(draft: GatewayInput, editing: boolean): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!draft.name.trim()) errors.name = "请输入网关显示名称";
  try {
    const url = new URL(draft.url);
    if (url.protocol !== "https:") errors.url = "网关必须使用 HTTPS";
    if (url.username || url.password) errors.url = "URL 不得携带用户名或密码";
    if (url.search || url.hash) errors.url = "URL 不得携带查询参数或片段";
    if (url.port && url.port !== "443") errors.url = "网关仅支持 HTTPS 443 端口";
  } catch {
    errors.url = "请输入完整、有效的 HTTPS 地址";
  }
  if (!editing && !draft.apiKey.trim()) errors.apiKey = "新增网关必须提供 API key";
  if (!draft.models.length) errors.models = "至少填写一个 model";
  if (draft.models.some((model) => {
    const value = draft.modelContextWindows?.[model];
    return !Number.isInteger(value) || value! < 1 || value! > MAX_MODEL_CONTEXT_WINDOW;
  })) errors.modelContextWindows = `上下文长度必须是 1 到 ${MAX_MODEL_CONTEXT_WINDOW.toLocaleString("en-US")} 的整数`;
  const optionIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
  for (const [model, config] of Object.entries(draft.modelReasoning ?? {})) {
    if (!draft.models.includes(model)) {
      errors.modelReasoning = `思考参数配置引用了未声明的 model：${model}`;
      break;
    }
    if (!GATEWAY_REASONING_PARAMETER_PATHS.includes(config.parameter) || config.options.length > 32) {
      errors.modelReasoning = `${model} 的思考参数配置无效`;
      break;
    }
    const ids = new Set<string>();
    const labels = new Set<string>();
    for (const option of config.options) {
      const id = option.id.trim();
      const label = option.label.trim();
      const value = option.value.trim();
      const normalizedLabel = label.toLocaleLowerCase();
      if (!optionIdPattern.test(id) || !label || label.length > 120 || !value || value.length > 120) {
        errors.modelReasoning = `${model} 的思考选项需填写有效 id、显示名和发送值`;
        break;
      }
      if (ids.has(id) || labels.has(normalizedLabel)) {
        errors.modelReasoning = `${model} 的思考选项 id 和显示名不能重复`;
        break;
      }
      ids.add(id);
      labels.add(normalizedLabel);
    }
    if (errors.modelReasoning) break;
  }
  if (!draft.defaultModel.trim()) errors.defaultModel = "请选择默认 model";
  else if (!draft.models.includes(draft.defaultModel.trim())) {
    errors.defaultModel = "默认 model 必须包含在模型列表中";
  }
  return errors;
}

export function GatewayManagementPage({ onBack }: { onBack: () => void }) {
  const [gateways, setGateways] = useState<GatewayRecord[]>([]);
  const [harnesses, setHarnesses] = useState<HarnessCatalogEntry[]>([]);
  const [defaultGatewayId, setDefaultGatewayId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState("");
  const [notice, setNotice] = useState("");
  const [busyGatewayId, setBusyGatewayId] = useState("");

  const [editorOpen, setEditorOpen] = useState(false);
  const [editingGatewayId, setEditingGatewayId] = useState<string>();
  const [draft, setDraft] = useState<GatewayInput>(EMPTY_GATEWAY);
  const [submitted, setSubmitted] = useState(false);
  const [modelRefreshBusy, setModelRefreshBusy] = useState(false);
  const [modelRefreshState, setModelRefreshState] = useState<{ status: "success" | "error"; message: string }>();
  const [modelAddOpen, setModelAddOpen] = useState(false);
  const [newModelName, setNewModelName] = useState("");
  const [modelAddError, setModelAddError] = useState("");
  const [credential, setCredential] = useState("");
  const [credentialBusy, setCredentialBusy] = useState(false);
  const credentialTimer = useRef<number>();

  const [testDialog, setTestDialog] = useState<{ gatewayId: string; mode: TestMode }>();
  const [testSteps, setTestSteps] = useState<TestStep[]>([]);
  const [testRunning, setTestRunning] = useState(false);
  const [expandedTestSteps, setExpandedTestSteps] = useState<Set<string>>(() => new Set());
  const testAbortRef = useRef<AbortController>();
  const probeHarnesses = harnesses.filter((item) =>
    item.available && harnessSupportsPurpose(item, "probe")
  );

  const updateGatewayRecord = (gateway: GatewayRecord) => {
    setGateways((current) => current.map((item) => item.id === gateway.id ? gateway : item));
  };

  const load = async () => {
    setLoading(true);
    setPageError("");
    try {
      const catalog = await getCatalog();
      setGateways(catalog.gateways ?? []);
      setHarnesses(catalog.harnesses ?? []);
      setDefaultGatewayId(catalog.defaultGatewayId);
    } catch (reason) {
      setPageError(redactGatewayFailure(reason));
    } finally {
      setLoading(false);
    }
  };

  const syncCatalogAfterTest = async () => {
    try {
      const catalog = await getCatalog();
      setGateways(catalog.gateways ?? []);
      setHarnesses(catalog.harnesses ?? []);
      setDefaultGatewayId(catalog.defaultGatewayId);
    } catch {
      // The streamed gateway result remains authoritative for this run. A
      // later page reload can retry catalog synchronization.
    }
  };

  useEffect(() => {
    void load();
    return () => {
      if (credentialTimer.current !== undefined) window.clearTimeout(credentialTimer.current);
    };
  }, []);

  const hideCredential = () => {
    if (credentialTimer.current !== undefined) window.clearTimeout(credentialTimer.current);
    credentialTimer.current = undefined;
    setCredential("");
  };

  const openNew = () => {
    hideCredential();
    setEditingGatewayId(undefined);
    setDraft({ ...EMPTY_GATEWAY, models: [], modelContextWindows: {}, modelReasoning: {}, apiKey: "" });
    setSubmitted(false);
    setModelRefreshState(undefined);
    setModelAddOpen(false);
    setNewModelName("");
    setModelAddError("");
    setPageError("");
    setEditorOpen(true);
  };

  const openEdit = (gateway: GatewayRecord) => {
    hideCredential();
    setEditingGatewayId(gateway.id);
    setDraft({
      name: gateway.name,
      url: gateway.url,
      apiKey: "",
      models: [...gateway.models],
      modelContextWindows: Object.fromEntries(gateway.models.map((model) => [
        model,
        gateway.modelContextWindows?.[model] ?? DEFAULT_MODEL_CONTEXT_WINDOW
      ])),
      modelReasoning: Object.fromEntries(Object.entries(gateway.modelReasoning ?? {}).map(([model, config]) => [
        model,
        { ...config, options: config.options.map((option) => ({ ...option })) }
      ])),
      defaultModel: gateway.defaultModel,
      protocol: gateway.protocol
    });
    setSubmitted(false);
    setModelRefreshState(undefined);
    setModelAddOpen(false);
    setNewModelName("");
    setModelAddError("");
    setPageError("");
    setEditorOpen(true);
  };

  const errors = draftErrors(draft, Boolean(editingGatewayId));

  const save = async () => {
    setSubmitted(true);
    if (Object.keys(errors).length) return;
    const busyId = editingGatewayId ?? "new";
    setBusyGatewayId(busyId);
    setPageError("");
    try {
      const saved = editingGatewayId
        ? await updateGateway(editingGatewayId, { ...draft, defaultModel: draft.defaultModel.trim() })
        : await createGateway({ ...draft, defaultModel: draft.defaultModel.trim() });
      setGateways((current) => current.some((item) => item.id === saved.id)
        ? current.map((item) => item.id === saved.id ? saved : item)
        : [...current, saved]);
      if (!defaultGatewayId) setDefaultGatewayId(saved.id);
      setNotice(`网关“${saved.name}”已保存。`);
      setEditorOpen(false);
      hideCredential();
    } catch (reason) {
      setPageError(redactGatewayFailure(reason));
    } finally {
      setBusyGatewayId("");
    }
  };

  const reveal = async () => {
    if (!editingGatewayId) return;
    if (credential) {
      hideCredential();
      return;
    }
    setCredentialBusy(true);
    setPageError("");
    try {
      const value = await revealGatewayCredential(editingGatewayId);
      setCredential(value);
      credentialTimer.current = window.setTimeout(hideCredential, 30_000);
    } catch (reason) {
      setPageError(redactGatewayFailure(reason));
    } finally {
      setCredentialBusy(false);
    }
  };

  const copyCredential = async () => {
    if (!editingGatewayId) return;
    setCredentialBusy(true);
    try {
      const value = credential || await revealGatewayCredential(editingGatewayId);
      if (!navigator.clipboard?.writeText) throw new Error("当前浏览器不支持安全复制");
      await navigator.clipboard.writeText(value);
      setNotice("凭据已复制；请妥善保管剪贴板内容。");
    } catch (reason) {
      setPageError(redactGatewayFailure(reason));
    } finally {
      setCredentialBusy(false);
    }
  };

  const refreshEditingModels = async () => {
    setModelRefreshBusy(true);
    setModelRefreshState(undefined);
    try {
      const refreshed = editingGatewayId && !draft.apiKey.trim()
        ? await refreshGatewayModels(editingGatewayId)
        : undefined;
      const models = refreshed?.models ?? await discoverGatewayModels({
        url: draft.url,
        apiKey: draft.apiKey,
        protocol: draft.protocol
      });
      if (refreshed) updateGatewayRecord(refreshed);
      setDraft((current) => ({
        ...current,
        models: [...models],
        modelContextWindows: Object.fromEntries(models.map((model) => [
          model,
          current.modelContextWindows?.[model]
            ?? refreshed?.modelContextWindows?.[model]
            ?? DEFAULT_MODEL_CONTEXT_WINDOW
        ])),
        modelReasoning: Object.fromEntries(models.flatMap((model) => {
          const config = current.modelReasoning?.[model] ?? refreshed?.modelReasoning?.[model];
          return config ? [[model, {
            ...config,
            options: config.options.map((option) => ({ ...option }))
          }]] : [];
        })),
        defaultModel: models.includes(current.defaultModel)
          ? current.defaultModel
          : refreshed?.defaultModel && models.includes(refreshed.defaultModel)
            ? refreshed.defaultModel
            : models[0] ?? ""
      }));
      setModelRefreshState({ status: "success", message: `已刷新 ${models.length} 个 model。` });
    } catch (reason) {
      setModelRefreshState({ status: "error", message: redactGatewayFailure(reason) });
    } finally {
      setModelRefreshBusy(false);
    }
  };

  const updateModelContextWindow = (model: string, value: number) => {
    setDraft((current) => ({
      ...current,
      modelContextWindows: {
        ...current.modelContextWindows,
        [model]: value
      }
    }));
  };

  const removeDraftModel = (model: string) => {
    setDraft((current) => {
      const models = current.models.filter((candidate) => candidate !== model);
      const modelContextWindows = Object.fromEntries(Object.entries(current.modelContextWindows ?? {})
        .filter(([candidate]) => candidate !== model));
      const modelReasoning = Object.fromEntries(Object.entries(current.modelReasoning ?? {})
        .filter(([candidate]) => candidate !== model));
      return {
        ...current,
        models,
        modelContextWindows,
        modelReasoning,
        defaultModel: current.defaultModel === model ? models[0] ?? "" : current.defaultModel
      };
    });
    setModelRefreshState(undefined);
  };

  const enableModelReasoning = (model: string, enabled: boolean) => {
    setDraft((current) => {
      const modelReasoning = { ...current.modelReasoning };
      if (enabled) {
        modelReasoning[model] = modelReasoning[model] ?? {
          parameter: "reasoning_effort",
          options: []
        };
      } else {
        delete modelReasoning[model];
      }
      return { ...current, modelReasoning };
    });
  };

  const updateModelReasoningParameter = (model: string, parameter: GatewayReasoningParameterPath) => {
    setDraft((current) => {
      const config = current.modelReasoning?.[model];
      if (!config) return current;
      return {
        ...current,
        modelReasoning: {
          ...current.modelReasoning,
          [model]: { ...config, parameter }
        }
      };
    });
  };

  const updateModelReasoningOption = (
    model: string,
    index: number,
    field: keyof GatewayReasoningOption,
    value: string
  ) => {
    setDraft((current) => {
      const config = current.modelReasoning?.[model];
      if (!config) return current;
      return {
        ...current,
        modelReasoning: {
          ...current.modelReasoning,
          [model]: {
            ...config,
            options: config.options.map((option, optionIndex) =>
              optionIndex === index ? { ...option, [field]: value } : option
            )
          }
        }
      };
    });
  };

  const addModelReasoningOption = (model: string) => {
    setDraft((current) => {
      const config = current.modelReasoning?.[model];
      if (!config || config.options.length >= 32) return current;
      let number = config.options.length + 1;
      while (config.options.some((option) => option.id === `option-${number}`)) number += 1;
      return {
        ...current,
        modelReasoning: {
          ...current.modelReasoning,
          [model]: {
            ...config,
            options: [...config.options, {
              id: `option-${number}`,
              label: `选项 ${number}`,
              value: "high"
            }]
          }
        }
      };
    });
  };

  const removeModelReasoningOption = (model: string, index: number) => {
    setDraft((current) => {
      const config = current.modelReasoning?.[model];
      if (!config) return current;
      return {
        ...current,
        modelReasoning: {
          ...current.modelReasoning,
          [model]: {
            ...config,
            options: config.options.filter((_, optionIndex) => optionIndex !== index)
          }
        }
      };
    });
  };

  const addDraftModel = () => {
    const model = newModelName.trim();
    if (!model) {
      setModelAddError("请输入 model 名称");
      return;
    }
    if (draft.models.includes(model)) {
      setModelAddError("该 model 已存在");
      return;
    }
    if (draft.models.length >= 200) {
      setModelAddError("每个网关最多配置 200 个 model");
      return;
    }
    setDraft((current) => ({
      ...current,
      models: [...current.models, model],
      modelContextWindows: {
        ...current.modelContextWindows,
        [model]: DEFAULT_MODEL_CONTEXT_WINDOW
      },
      defaultModel: current.defaultModel || model
    }));
    setNewModelName("");
    setModelAddError("");
    setModelAddOpen(false);
    setModelRefreshState(undefined);
  };

  const testStepForHarness = (
    harness: HarnessCatalogEntry,
    model: string,
    reasoningOptionId?: string
  ): TestStep => ({
    key: `${harness.id}:${model}:${reasoningOptionId ?? "default"}`,
    harness: harness.id,
    harnessLabel: harness.label,
    model,
    ...(reasoningOptionId ? { reasoningOptionId } : {}),
    status: "queued",
    stageResults: queuedStageResults()
  });

  const openTest = (gateway: GatewayRecord, mode: TestMode) => {
    const selectedModel = gateway.defaultModel;
    const selectedHarness = probeHarnesses.find((item) => item.default) ?? probeHarnesses[0];
    const steps: TestStep[] = mode === "connection"
      ? selectedHarness ? [testStepForHarness(selectedHarness, selectedModel)] : []
      : probeHarnesses.map((harness) => testStepForHarness(harness, selectedModel));
    setTestDialog({ gatewayId: gateway.id, mode });
    setTestSteps(steps);
    setExpandedTestSteps(new Set());
    setPageError("");
  };

  const chooseConnectionModel = (model: string) => {
    const harness = probeHarnesses.find((item) => item.id === testSteps[0]?.harness)
      ?? probeHarnesses.find((item) => item.default)
      ?? probeHarnesses[0];
    setTestSteps(harness ? [testStepForHarness(harness, model)] : []);
    setExpandedTestSteps(new Set());
    setPageError("");
  };

  const chooseConnectionHarness = (harnessId: AgentHarness) => {
    const harness = probeHarnesses.find((item) => item.id === harnessId);
    const model = testSteps[0]?.model ?? gateways.find((gateway) => gateway.id === testDialog?.gatewayId)?.defaultModel ?? "";
    setTestSteps(harness && model
      ? [testStepForHarness(harness, model, testSteps[0]?.reasoningOptionId)]
      : []);
    setExpandedTestSteps(new Set());
    setPageError("");
  };

  const chooseMatrixModel = (model: string) => {
    setTestSteps(probeHarnesses.map((harness) => testStepForHarness(harness, model)));
    setExpandedTestSteps(new Set());
    setPageError("");
  };

  const chooseTestReasoningOption = (reasoningOptionId: string | undefined) => {
    const gateway = gateways.find((item) => item.id === testDialog?.gatewayId);
    if (testDialog?.mode === "connection") {
      const harness = probeHarnesses.find((item) => item.id === testSteps[0]?.harness);
      const model = testSteps[0]?.model ?? gateway?.defaultModel ?? "";
      setTestSteps(harness && model ? [testStepForHarness(harness, model, reasoningOptionId)] : []);
    } else {
      const model = testSteps[0]?.model ?? gateway?.defaultModel ?? "";
      setTestSteps(model
        ? probeHarnesses.map((harness) => testStepForHarness(harness, model, reasoningOptionId))
        : []);
    }
    setExpandedTestSteps(new Set());
    setPageError("");
  };

  const toggleTestStep = (key: string) => {
    setExpandedTestSteps((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const closeTestDialog = () => {
    if (testRunning) {
      testAbortRef.current?.abort();
      return;
    }
    setTestDialog(undefined);
  };

  const stepFromResult = (step: TestStep, result: GatewayRecord["test"] | undefined): TestStep => {
    if (!result) {
      return { ...step, status: "failed", error: "服务未返回该组合的探测结果" };
    }
    return {
      ...step,
      status: result.status === "passed" ? "passed" : "failed",
      error: result.status === "passed"
        ? undefined
        : result.status === "untested"
          ? "服务返回的最终探测状态不完整"
          : redactGatewayFailure(result.error),
      durationMs: result.durationMs,
      stageResults: result.stageResults
    };
  };

  const runTests = async () => {
    if (!testDialog || !testSteps.length) return;
    const controller = new AbortController();
    testAbortRef.current = controller;
    setTestRunning(true);
    setPageError("");
    let working: TestStep[] = testSteps.map((step) => ({
      ...step,
      status: testDialog.mode === "connection" ? "running" : "queued",
      error: undefined,
      durationMs: undefined,
      stageResults: testDialog.mode === "connection" ? runningStageResults() : queuedStageResults()
    }));
    const updateWorking = (updater: (current: TestStep[]) => TestStep[]) => {
      working = updater(working);
      setTestSteps(working);
    };
    setTestSteps(working);
    try {
      if (testDialog.mode === "matrix") {
        const harnesses = [...new Set(working.flatMap((step) => step.harness ? [step.harness] : []))];
        const models = [...new Set(working.map((step) => step.model))];
        const matchesProgressStep = (step: TestStep, event: Extract<GatewayMatrixProgressEvent, { harness: AgentHarness; model: string }>) =>
          step.harness === event.harness && step.model === event.model;
        const applyProgress = (event: GatewayMatrixProgressEvent) => {
          if (event.type === "combination-start") {
            updateWorking((current) => current.map((step) => matchesProgressStep(step, event)
              ? { ...step, status: "running" as const, error: undefined, durationMs: undefined, stageResults: event.stageResults }
              : step));
          } else if (event.type === "stage") {
            updateWorking((current) => current.map((step) => matchesProgressStep(step, event)
              ? { ...step, status: step.status === "queued" ? "running" as const : step.status, stageResults: mergeStageResults(step.stageResults, event.stage) }
              : step));
          } else if (event.type === "result") {
            updateWorking((current) => current.map((step) => matchesProgressStep(step, event)
              ? stepFromResult(step, event.result)
              : step));
          } else if (event.type === "complete") {
            updateGatewayRecord(event.gateway);
          }
        };
        const reasoningOptions = Object.fromEntries(models.map((model) => [
          model,
          working.find((step) => step.model === model)?.reasoningOptionId ?? null
        ]));
        const selectedReasoningOptions = Object.values(reasoningOptions).some(Boolean)
          ? { reasoningOptions }
          : {};
        const matrix = await testGatewayMatrix(testDialog.gatewayId, {
          harnesses,
          models,
          ...selectedReasoningOptions
        }, {
          signal: controller.signal,
          onProgress: applyProgress
        });
        updateGatewayRecord(matrix.gateway);
        updateWorking((current) => current.map((step) => stepFromResult(
          step,
          matrix.results.find((result) =>
            result.harness === step.harness &&
            result.model === step.model &&
            result.reasoningOptionId === step.reasoningOptionId
          )
        )));
        await syncCatalogAfterTest();
      } else {
        if (controller.signal.aborted) throw new DOMException("aborted", "AbortError");
        const step = working[0]!;
        let finalResult: GatewayRecord["test"] | undefined;
        const applyProgress = (event: GatewayTestProgressEvent) => {
          if (event.type === "stage") {
            updateWorking((current) => current.map((item) => item.key === step.key
              ? { ...item, status: "running" as const, stageResults: mergeStageResults(item.stageResults, event.stage) }
              : item));
          } else if (event.type === "result") {
            finalResult = event.result;
            updateWorking((current) => current.map((item) => item.key === step.key
              ? stepFromResult(item, event.result)
              : item));
          } else if (event.type === "complete") {
            finalResult = event.result;
            updateGatewayRecord(event.gateway);
            updateWorking((current) => current.map((item) => item.key === step.key
              ? stepFromResult(item, event.result)
              : item));
          }
        };
        const probeInit = {
          signal: controller.signal,
          onProgress: applyProgress,
          ...(step.reasoningOptionId
            ? { gatewayReasoningOption: step.reasoningOptionId }
            : {})
        };
        const checked = await testGateway(
          testDialog.gatewayId,
          step.model,
          step.harness,
          probeInit
        );
        updateGatewayRecord(checked);
        // The streamed/returned test is the server's final Adapter-smoke
        // verdict. Re-deriving it from a catalog captured before server HMR
        // can incorrectly turn a pass into "untested" when fingerprints move.
        const result = finalResult ?? checked.test;
        updateWorking((current) => current.map((item) => item.key === step.key
          ? stepFromResult(item, result)
          : item));
        await syncCatalogAfterTest();
      }
      const passed = working.filter((step) => step.status === "passed").length;
      setNotice(`真实探测完成：${passed}/${working.length} 个组合通过。`);
    } catch (reason) {
      const cancelled = controller.signal.aborted || isAbortReason(reason);
      const error = cancelled ? "测试已取消" : "测试中断：" + redactGatewayFailure(reason);
      updateWorking((current) => settleInterruptedTests(current, cancelled, error));
      if (cancelled) {
        const passed = working.filter((step) => step.status === "passed").length;
        setNotice(`真实探测已取消：已完成 ${passed}/${working.length} 个通过。`);
      } else {
        setPageError(error);
      }
    } finally {
      if (testAbortRef.current === controller) testAbortRef.current = undefined;
      setTestRunning(false);
    }
  };

  const chooseDefault = async (gateway: GatewayRecord) => {
    setBusyGatewayId(gateway.id);
    setPageError("");
    try {
      await setDefaultGateway(gateway.id);
      setDefaultGatewayId(gateway.id);
      setNotice(`“${gateway.name}”已设为默认网关。`);
    } catch (reason) {
      setPageError(redactGatewayFailure(reason));
    } finally {
      setBusyGatewayId("");
    }
  };

  const remove = async (gateway: GatewayRecord) => {
    if (!window.confirm(`确定删除全局网关“${gateway.name}”吗？已启动项目的快照不会改变。`)) return;
    setBusyGatewayId(gateway.id);
    setPageError("");
    try {
      await deleteGateway(gateway.id);
      const remaining = gateways.filter((item) => item.id !== gateway.id);
      setGateways(remaining);
      if (defaultGatewayId === gateway.id) setDefaultGatewayId(remaining[0]?.id);
      setNotice(`网关“${gateway.name}”已删除。`);
    } catch (reason) {
      setPageError(redactGatewayFailure(reason));
    } finally {
      setBusyGatewayId("");
    }
  };

  const tested = testSteps.filter(isTerminalTestStep).length;
  const progressTotal = testSteps.length;
  const progressValue = tested;
  const progressSubject = testDialog?.mode === "matrix" ? "Harness" : "真实探测";
  const progressLabel = testRunning
    ? `正在验证 ${progressValue}/${progressTotal} 个 ${progressSubject}`
    : progressValue === progressTotal && progressTotal > 0
      ? `已完成 ${progressValue}/${progressTotal} 个 ${progressSubject}`
      : `准备运行 ${progressTotal} 个 ${progressSubject}`;
  const activeTestGateway = gateways.find((gateway) => gateway.id === testDialog?.gatewayId);
  const activeTestModel = testSteps[0]?.model ?? activeTestGateway?.defaultModel ?? "";
  const activeTestReasoningOptions = activeTestGateway?.modelReasoning?.[activeTestModel]?.options ?? [];
  const activeTestReasoningOption = activeTestReasoningOptions.find(
    (option) => option.id === testSteps[0]?.reasoningOptionId
  );

  return (
    <main className="gateway-management-page">
      <header className="gateway-management-hero">
        <Button variant="ghost" icon={<ArrowLeft size={18} />} onClick={onBack}>返回项目</Button>
        <div>
          <span className="eyebrow"><ShieldCheck size={15} /> Runtime resources</span>
          <h1>全局网关库</h1>
          <p>统一维护服务地址、凭据、model 和 Harness 路由验证。项目只引用已保存记录。</p>
        </div>
        <Button variant="primary" icon={<Plus size={16} />} onClick={openNew}>新增网关</Button>
      </header>

      {pageError && <ErrorPanel title="网关操作失败" message={pageError} />}
      {notice && <div className="gateway-management-notice" role="status"><CheckCircle2 size={15} />{notice}</div>}

      {loading ? (
        <div className="gateway-management-loading"><LoaderCircle className="spin" size={22} />正在读取全局网关…</div>
      ) : (
        <section className="gateway-management-grid" aria-label="全局网关列表">
          {gateways.map((gateway) => {
            const visibleHarnesses = probeHarnesses;
            const busy = busyGatewayId === gateway.id;
            return (
              <article className="gateway-management-card" key={gateway.id}>
                <div className="gateway-management-card-head">
                  <span>
                    <strong>{gateway.name}</strong>
                    <small>{gateway.url}</small>
                  </span>
                  <span className={`gateway-test-state gateway-test-${gateway.test.status}`}>
                    {gateway.test.status === "passed" ? "连接已验证" : gateway.test.status === "failed" ? "连接失败" : "尚未验证"}
                  </span>
                </div>
                <div className="gateway-management-tags">
                  {gateway.builtin && <em>系统预置</em>}
                  {defaultGatewayId === gateway.id && <em>默认</em>}
                  <em>{protocolLabel(gateway.protocol)}</em>
                  <em>{gateway.models.length} models</em>
                  {Object.keys(gateway.modelReasoning ?? {}).length > 0 && <em>{Object.keys(gateway.modelReasoning ?? {}).length} 个 model 配置思考参数</em>}
                </div>
                <dl className="gateway-management-facts">
                  <div><dt>默认 model</dt><dd>{gateway.defaultModel}</dd></div>
                  <div><dt>最近测试</dt><dd>{testedAtLabel(gateway.test.testedAt)}</dd></div>
                  <div><dt>凭据</dt><dd>{gateway.apiKeyConfigured ? "服务端已配置" : "未配置"}</dd></div>
                </dl>
                <div className="gateway-management-routes" aria-label={`${gateway.name} Harness 路由状态`}>
                  {visibleHarnesses.map((harness) => {
                    const latest = gateway.models
                      .map((model) => gatewayCombinationTestState(gateway, harness.id, model, harnesses))
                      .filter((test) => test.status !== "untested")
                      .sort((left, right) => String(left.testedAt ?? "").localeCompare(String(right.testedAt ?? "")))
                      .at(-1);
                    const status = latest?.status === "passed"
                      ? "passed"
                      : latest?.status === "failed"
                        ? "failed"
                        : "untested";
                    const statusLabel = status === "passed" ? "通过" : status === "failed" ? "未通过" : "未验证";
                    return <span key={harness.id} className={status}>{harness.label} · {statusLabel}</span>;
                  })}
                </div>
                {gateway.test.error && <small className="gateway-management-error">{redactGatewayFailure(gateway.test.error)}</small>}
                <div className="gateway-management-actions">
                  <button type="button" onClick={() => openEdit(gateway)}>编辑</button>
                  <button type="button" disabled={busy} onClick={() => openTest(gateway, "connection")}>测试连接</button>
                  <button type="button" disabled={busy || !visibleHarnesses.length} onClick={() => openTest(gateway, "matrix")}>验证全部 Harness</button>
                  {defaultGatewayId !== gateway.id && <button type="button" disabled={busy} onClick={() => void chooseDefault(gateway)}>设为默认</button>}
                  <button type="button" className="danger" disabled={busy} onClick={() => void remove(gateway)}>删除</button>
                </div>
              </article>
            );
          })}
          {!gateways.length && <div className="gateway-management-empty">尚无网关。新增并完成真实探测后，即可供所有项目复用。</div>}
        </section>
      )}

      {editorOpen && (
        <div className="gateway-modal-backdrop" role="presentation">
          <section className="gateway-modal" role="dialog" aria-modal="true" aria-label={editingGatewayId ? "编辑全局网关" : "新增全局网关"}>
            <header><span><strong>{editingGatewayId ? "编辑全局网关" : "新增全局网关"}</strong><small>凭据仅提交到 Server，不进入项目快照或公开 API。</small></span><button type="button" onClick={() => { setEditorOpen(false); hideCredential(); }} aria-label="关闭网关编辑器"><X size={17} /></button></header>
            <div className="gateway-modal-grid">
              <label><span>显示名称</span><input aria-label="网关显示名称" value={draft.name} aria-invalid={submitted && Boolean(errors.name)} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} />{submitted && errors.name && <small role="alert">{errors.name}</small>}</label>
              <label><span>网关 HTTPS 地址</span><input aria-label="网关 URL" value={draft.url} aria-invalid={submitted && Boolean(errors.url)} onChange={(event) => setDraft((current) => ({ ...current, url: event.target.value }))} />{submitted && errors.url && <small role="alert">{errors.url}</small>}</label>
              <label><span>API key</span><input aria-label="网关 API key" type="password" autoComplete="new-password" value={draft.apiKey} placeholder={editingGatewayId ? "留空以保留现有凭据" : "输入服务端凭据"} aria-invalid={submitted && Boolean(errors.apiKey)} onChange={(event) => setDraft((current) => ({ ...current, apiKey: event.target.value }))} />{submitted && errors.apiKey && <small role="alert">{errors.apiKey}</small>}</label>
              {editingGatewayId && <div className="gateway-modal-credential"><div><button type="button" disabled={credentialBusy} onClick={() => void reveal()}>{credential ? <EyeOff size={14} /> : <Eye size={14} />}{credential ? "隐藏现有凭据" : "查看现有凭据"}</button><button type="button" disabled={credentialBusy} onClick={() => void copyCredential()}><Copy size={14} />复制现有凭据</button></div>{credential && <output aria-label="当前网关凭据"><code>{credential}</code><small>30 秒后自动隐藏</small></output>}</div>}
              <label><span>当前协议</span><select aria-label="网关当前协议" value={draft.protocol} onChange={(event) => setDraft((current) => ({ ...current, protocol: event.target.value as GatewayInput["protocol"] }))}>{GATEWAY_PROTOCOLS.map((protocol) => <option value={protocol} key={protocol}>{protocolLabel(protocol)}</option>)}</select></label>
              <label><span>默认 model</span><select aria-label="网关默认 model" value={draft.defaultModel} aria-invalid={submitted && Boolean(errors.defaultModel)} disabled={!draft.models.length} onChange={(event) => setDraft((current) => ({ ...current, defaultModel: event.target.value }))}><option value="" disabled>请选择默认 model</option>{draft.models.map((model) => <option value={model} key={model}>{model}</option>)}</select>{submitted && errors.defaultModel && <small role="alert">{errors.defaultModel}</small>}</label>
              <section className="gateway-model-editor wide" aria-label="网关模型列表">
                <span className="gateway-model-list-heading"><span>可用 models</span><span className="gateway-model-list-actions"><button type="button" onClick={() => { setModelAddOpen(true); setModelAddError(""); }} aria-label="添加 model"><Plus size={13} />添加 model</button><button type="button" disabled={modelRefreshBusy} onClick={() => void refreshEditingModels()} aria-label="刷新网关 model 列表"><RefreshCw className={modelRefreshBusy ? "spin" : undefined} size={13} />刷新 models</button></span></span>
                {modelAddOpen && <div className="gateway-model-add-row"><input autoFocus type="text" value={newModelName} placeholder="输入 model 名称" aria-label="新 model 名称" aria-invalid={Boolean(modelAddError)} onChange={(event) => { setNewModelName(event.target.value); setModelAddError(""); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addDraftModel(); } else if (event.key === "Escape") { setModelAddOpen(false); setNewModelName(""); setModelAddError(""); } }} /><button type="button" onClick={addDraftModel}>确认</button><button type="button" onClick={() => { setModelAddOpen(false); setNewModelName(""); setModelAddError(""); }}>取消</button>{modelAddError && <small role="alert">{modelAddError}</small>}</div>}
                <div className="gateway-model-rows">
                  {draft.models.map((model) => {
                    const contextWindow = draft.modelContextWindows?.[model] ?? DEFAULT_MODEL_CONTEXT_WINDOW;
                    const invalidContext = !Number.isInteger(contextWindow) || contextWindow < 1 || contextWindow > MAX_MODEL_CONTEXT_WINDOW;
                    const reasoningConfig = draft.modelReasoning?.[model];
                    return <div className="gateway-model-item" key={model}>
                      <div className="gateway-model-row">
                        <code title={model}>{model}</code>
                        <label className="gateway-model-context"><span>上下文</span><input type="number" min={1} max={MAX_MODEL_CONTEXT_WINDOW} step={1} value={contextWindow || ""} aria-label={`${model} 上下文长度`} aria-invalid={submitted && invalidContext} onChange={(event) => updateModelContextWindow(model, event.target.value === "" ? 0 : event.target.valueAsNumber)} /><em>tokens</em></label>
                        <label className="gateway-model-reasoning-toggle"><input type="checkbox" checked={Boolean(reasoningConfig)} onChange={(event) => enableModelReasoning(model, event.target.checked)} aria-label={`${model} 自定义网关思考强度`} /><span>思考参数</span></label>
                        <button type="button" className="gateway-model-delete" aria-label={`删除 model ${model}`} onClick={() => removeDraftModel(model)}><Trash2 size={13} />删除</button>
                      </div>
                      {reasoningConfig && <div className="gateway-model-reasoning-editor">
                        <label><span>发送字段</span><select aria-label={`${model} 思考参数字段`} value={reasoningConfig.parameter} onChange={(event) => updateModelReasoningParameter(model, event.target.value as GatewayReasoningParameterPath)}>{GATEWAY_REASONING_PARAMETER_PATHS.map((parameter) => <option key={parameter} value={parameter}>{REASONING_PARAMETER_LABELS[parameter]}</option>)}</select></label>
                        <div className="gateway-reasoning-options">
                          <div className="gateway-reasoning-options-head"><span>可选强度（未选择时不发送该字段）</span><button type="button" disabled={reasoningConfig.options.length >= 32} onClick={() => addModelReasoningOption(model)}><Plus size={12} />添加选项</button></div>
                          {reasoningConfig.options.map((option, index) => <div className="gateway-reasoning-option-row" key={index}>
                            <label><span>ID</span><input value={option.id} maxLength={64} aria-label={`${model} 思考选项 ${index + 1} ID`} onChange={(event) => updateModelReasoningOption(model, index, "id", event.target.value)} /></label>
                            <label><span>显示名</span><input value={option.label} maxLength={120} aria-label={`${model} 思考选项 ${index + 1} 显示名`} onChange={(event) => updateModelReasoningOption(model, index, "label", event.target.value)} /></label>
                            <label><span>发送值</span><input value={option.value} maxLength={120} aria-label={`${model} 思考选项 ${index + 1} 发送值`} onChange={(event) => updateModelReasoningOption(model, index, "value", event.target.value)} /></label>
                            <button type="button" aria-label={`删除 ${model} 思考选项 ${index + 1}`} onClick={() => removeModelReasoningOption(model, index)}><Trash2 size={13} /></button>
                          </div>)}
                          {!reasoningConfig.options.length && <small>尚未添加可选强度；Agent 将只能使用模型默认值。</small>}
                        </div>
                      </div>}
                    </div>;
                  })}
                  {!draft.models.length && <div className="gateway-model-empty">点击“添加 model”或“刷新 models”建立模型列表。</div>}
                </div>
                {submitted && errors.models && <small role="alert">{errors.models}</small>}
                {submitted && errors.modelContextWindows && <small role="alert">{errors.modelContextWindows}</small>}
                {submitted && errors.modelReasoning && <small role="alert">{errors.modelReasoning}</small>}
                {modelRefreshState && <small className={`gateway-model-refresh-${modelRefreshState.status}`} role={modelRefreshState.status === "error" ? "alert" : "status"}>{modelRefreshState.message}</small>}
              </section>
            </div>
            <footer><Button variant="ghost" onClick={() => { setEditorOpen(false); hideCredential(); }}>取消</Button><Button variant="primary" loading={busyGatewayId === (editingGatewayId ?? "new")} onClick={() => void save()}>保存网关</Button></footer>
          </section>
        </div>
      )}

      {testDialog && activeTestGateway && (
        <div className="gateway-modal-backdrop" role="presentation">
          <section className="gateway-modal gateway-test-modal" role="dialog" aria-modal="true" aria-label="网关真实测试">
            <header><span><strong>{testDialog.mode === "matrix" ? "全部 Harness 真实验证" : "网关真实连接测试"}</strong><small>{activeTestGateway.name} · {protocolLabel(activeTestGateway.protocol)}</small></span><button type="button" onClick={closeTestDialog} aria-label={testRunning ? "取消网关测试" : "关闭网关测试"}><X size={17} /></button></header>
            {testDialog.mode === "connection" ? (
              <div className="gateway-test-picker-row">
                <label className="gateway-test-model-picker">
                  <span>测试 Harness</span>
                  <select aria-label="测试连接 Harness" value={testSteps[0]?.harness ?? ""} disabled={testRunning || !probeHarnesses.length} onChange={(event) => chooseConnectionHarness(event.target.value as AgentHarness)}>
                    {probeHarnesses.map((harness) => <option key={harness.id} value={harness.id}>{harness.label}</option>)}
                  </select>
                </label>
                <label className="gateway-test-model-picker">
                  <span>测试 model</span>
                  <select aria-label="测试连接 model" value={testSteps[0]?.model ?? activeTestGateway.defaultModel} disabled={testRunning} onChange={(event) => chooseConnectionModel(event.target.value)}>
                    {activeTestGateway.models.map((model) => <option key={model} value={model}>{model}</option>)}
                  </select>
                </label>
              </div>
            ) : (
              <label className="gateway-test-model-picker">
                <span>验证 model</span>
                <select aria-label="验证全部 Harness model" value={testSteps[0]?.model ?? activeTestGateway.defaultModel} disabled={testRunning} onChange={(event) => chooseMatrixModel(event.target.value)}>
                  {activeTestGateway.models.map((model) => <option key={model} value={model}>{model}</option>)}
                </select>
              </label>
            )}
            {activeTestReasoningOptions.length > 0 && <label className="gateway-test-model-picker gateway-test-reasoning-picker">
              <span>网关思考强度</span>
              <select aria-label="测试网关思考强度" value={testSteps[0]?.reasoningOptionId ?? ""} disabled={testRunning} onChange={(event) => chooseTestReasoningOption(event.target.value || undefined)}>
                <option value="">模型 / 网关默认（不发送字段）</option>
                {activeTestReasoningOptions.map((option) => <option key={option.id} value={option.id}>{option.label} · {option.value}</option>)}
              </select>
            </label>}
            {testDialog.mode === "matrix" && <div className="gateway-test-progress" aria-live="polite">
              <div><strong>{progressLabel}</strong><span>{progressTotal ? Math.round((progressValue / progressTotal) * 100) : 0}%</span></div>
              <progress max={Math.max(1, progressTotal)} value={progressValue} />
            </div>}
            <div className="gateway-test-steps">
              {testSteps.map((step) => {
                const expanded = expandedTestSteps.has(step.key);
                const hasStages = Boolean(step.stageResults?.length);
                return <div key={step.key} className={`gateway-test-step-wrap ${step.status}`}>
                  <button type="button" className={`gateway-test-step ${step.status}`} onClick={() => toggleTestStep(step.key)} aria-expanded={expanded} disabled={!hasStages}>
                    <span>{step.status === "running" ? <LoaderCircle className="spin" size={14} /> : step.status === "passed" ? <CheckCircle2 size={14} /> : step.status === "failed" ? <AlertTriangle size={14} /> : <span className="gateway-test-step-dot" />}</span>
                    <strong>{step.harnessLabel}</strong>
                    <code>{step.model}</code>
                    <small className="gateway-test-reasoning-label">{step.reasoningOptionId ? activeTestReasoningOption?.label ?? step.reasoningOptionId : "默认思考强度"}</small>
                    <em>{durationLabel(step.durationMs)}</em>
                    {hasStages && <ChevronDown className={expanded ? "expanded" : undefined} size={14} />}
                    {step.error && <small>{step.error}</small>}
                  </button>
                  {expanded && hasStages && <div className="gateway-test-stage-list">
                    {step.stageResults!.map((stage) => <div key={stage.stage} className={`gateway-test-stage ${stage.status}`}>
                      <span>{stage.label}</span>
                      <strong>{stageStatusLabel(stage.status)}</strong>
                      <em>{durationLabel(stage.durationMs)}</em>
                      {stage.httpStatus && <code>HTTP {stage.httpStatus}</code>}
                      {stage.error && <small>{stage.error}</small>}
                    </div>)}
                  </div>}
                </div>;
              })}
            </div>
            <footer><Button variant="ghost" onClick={closeTestDialog}>{testRunning ? "取消测试" : "关闭"}</Button><Button variant="primary" loading={testRunning} disabled={testRunning || !testSteps.length} onClick={() => void runTests()}>{tested === testSteps.length && tested > 0 ? "重新测试" : "开始真实测试"}</Button></footer>
          </section>
        </div>
      )}
    </main>
  );
}
