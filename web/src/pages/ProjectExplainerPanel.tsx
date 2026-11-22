import {
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState
} from "react";
import ReactMarkdown from "react-markdown";
import { ProjectExplainerReplyStatus, ProjectExplainerTrace } from "../components/ProjectExplainerTrace";
import { isExplainerConversationMessage, mergeExplainerMessages, reconcileExplainerHistory,
  pendingExplainerMessage, explainerActionFromEvent, notifyExplainerAction, restoreExplainerMessages } from "../components/project-explainer-events";
import { ExplainerActionCard } from "../components/ExplainerActionCard";
import rehypeKatex from "rehype-katex";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import {
  Activity,
  AlertTriangle,
  Bot,
  CheckCircle2,
  CircleStop,
  LoaderCircle,
  RefreshCw,
  Send
} from "lucide-react";
import {
  cancelProjectExplainer,
  getCatalog,
  getProjectExplainerConfig,
  getProjectExplainerHistory,
  refreshGatewayModels,
  resetProjectExplainer,
  streamProjectExplainerQuestion,
  updateProjectExplainerConfig
} from "../api";
import { Button } from "../components/Common";
import { cacheResource, readCachedResource } from "../resource-cache";
import {
  gatewayCombinationTestState,
  gatewayHarnessTestState,
  gatewayModelTestOptions,
  harnessOptionsForPurpose,
  protocolLabel
} from "../lib";
import type {
  ProjectExplainerEvent,
  ProjectExplainerRuntimeConfig,
  ProjectExplainerConfigInput,
  AgentHarness,
  GatewayRecord,
  Catalog
} from "../types";

export function ProjectExplainerPanel({ projectId }: { projectId: string }) {
  const [events, setEvents] = useState<ProjectExplainerEvent[]>(() => restoreExplainerMessages(readCachedResource<ProjectExplainerEvent[]>(`project-explainer:${projectId}:events`) ?? []));
  const [runtimeConfig, setRuntimeConfig] = useState<ProjectExplainerRuntimeConfig | undefined>(() => readCachedResource(`project-explainer:${projectId}:config`));
  const [configDraft, setConfigDraft] = useState<ProjectExplainerConfigInput>();
  const [runtimeCatalog, setRuntimeCatalog] = useState<Pick<Catalog, "gateways" | "harnesses" | "protocols" | "defaultHarnessId">>();
  const [configLoading, setConfigLoading] = useState(true);
  const [configSaving, setConfigSaving] = useState(false);
  const [refreshingGatewayId, setRefreshingGatewayId] = useState("");
  const [gatewayRefreshError, setGatewayRefreshError] = useState("");
  const [configError, setConfigError] = useState("");
  const [configNotice, setConfigNotice] = useState("");
  // Keep the running page compact; tests open the editor so field-level
  // validation remains directly exercisable without an extra click.
  const [configEditorOpen, setConfigEditorOpen] = useState(
    () => import.meta.env.MODE === "test"
  );
  const [question, setQuestion] = useState("");
  const [historyLoading, setHistoryLoading] = useState(true);
  const [streaming, setStreaming] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [remoteActive, setRemoteActive] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetNotice, setResetNotice] = useState("");
  const [error, setError] = useState("");
  const abortRef = useRef<AbortController>();
  const stopRequestedRef = useRef(false);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const historyRequestRef = useRef(0);
  const gatewayRefreshRequestRef = useRef(0);
  const currentProjectRef = useRef(projectId); currentProjectRef.current = projectId;

  const loadRuntimeConfig = useCallback(async () => {
    try {
      const [config, catalog] = await Promise.all([
        getProjectExplainerConfig(projectId),
        getCatalog()
      ]);
      if (currentProjectRef.current !== projectId) return;
      cacheResource(`project-explainer:${projectId}:config`, config);
      setRuntimeConfig(config);
      setConfigDraft({
        harness: config.harness,
        ...(config.gatewayId ? { gatewayId: config.gatewayId } : {}),
        model: config.model,
        reasoningEffort: config.reasoningEffort
      });
      setRuntimeCatalog({
        gateways: catalog.gateways ?? [],
        harnesses: catalog.harnesses ?? [],
        protocols: catalog.protocols ?? [],
        defaultHarnessId: catalog.defaultHarnessId
      });
      setConfigError("");
    } catch (reason) {
      setConfigError(reason instanceof Error ? reason.message : "Project Explainer 配置加载失败");
    } finally {
      setConfigLoading(false);
    }
  }, [projectId]);

  const loadHistory = useCallback(async () => {
    const requestId = ++historyRequestRef.current;
    try {
      const history = await getProjectExplainerHistory(projectId);
      if (requestId !== historyRequestRef.current) return;
      setEvents(current => cacheResource(`project-explainer:${projectId}:events`, reconcileExplainerHistory(current, history.events)));
      setRemoteActive(history.active);
      setError("");
    } catch (reason) {
      if (requestId !== historyRequestRef.current) return;
      setError(reason instanceof Error ? reason.message : "解说历史加载失败");
    } finally {
      if (requestId === historyRequestRef.current) setHistoryLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    const cachedEvents = readCachedResource<ProjectExplainerEvent[]>(`project-explainer:${projectId}:events`);
    setEvents(restoreExplainerMessages(cachedEvents ?? []));
    setQuestion("");
    setHistoryLoading(!cachedEvents);
    setStopping(false);
    setRemoteActive(false);
    setResetting(false);
    setResetNotice("");
    setError("");
    setRuntimeConfig(readCachedResource(`project-explainer:${projectId}:config`));
    setConfigDraft(undefined);
    setRuntimeCatalog(undefined);
    setConfigLoading(true);
    setConfigSaving(false);
    gatewayRefreshRequestRef.current += 1;
    setRefreshingGatewayId("");
    setGatewayRefreshError("");
    setConfigError("");
    setConfigNotice("");
    stopRequestedRef.current = false;
    void loadHistory();
    void loadRuntimeConfig();
    return () => {
      historyRequestRef.current += 1;
      gatewayRefreshRequestRef.current += 1;
      stopRequestedRef.current = true;
      abortRef.current?.abort();
    };
  }, [loadHistory, loadRuntimeConfig]);

  useEffect(() => {
    if (!remoteActive || streaming) return;
    let inFlight = false;
    const refresh = () => {
      if (inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      void loadHistory().finally(() => { inFlight = false; });
    };
    const timer = window.setInterval(refresh, 2_000);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", refresh); };
  }, [loadHistory, remoteActive, streaming]);

  useEffect(() => {
    const receive = (event: Event) => {
      const detail = (event as CustomEvent).detail as { projectId?: string; source?: string; event?: ProjectExplainerEvent };
      if (detail.source !== "floating" || detail.projectId !== projectId || !detail.event) return;
      historyRequestRef.current += 1;
      setHistoryLoading(false); setRemoteActive(!detail.event.data?.turnComplete);
      setEvents(current => cacheResource(`project-explainer:${projectId}:events`, mergeExplainerMessages(current, detail.event!), false));
    };
    const refresh = (event: Event) => {
      const detail = (event as CustomEvent).detail as { projectId?: string; source?: string; active?: boolean };
      if (detail.source === "panel" || detail.projectId !== projectId) return;
      if (detail.active === true) { setRemoteActive(true); return; }
      if (!streaming) { void loadHistory(); void loadRuntimeConfig(); }
    };
    window.addEventListener("openfars:explainer-event", receive); window.addEventListener("openfars:explainer-refresh", refresh);
    return () => { window.removeEventListener("openfars:explainer-event", receive); window.removeEventListener("openfars:explainer-refresh", refresh); };
  }, [projectId, loadHistory, loadRuntimeConfig, streaming]);

  useEffect(() => {
    const transcript = transcriptRef.current;
    if (!transcript) return;
    transcript.scrollTop = transcript.scrollHeight;
  }, [events]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const message = question.trim();
    if (!message || streaming || abortRef.current || stopping || remoteActive || resetting || !runtimeConfig?.available) return;
    const controller = new AbortController();
    abortRef.current = controller;
    const pending = pendingExplainerMessage(projectId, message, events);
    setEvents(current => cacheResource(`project-explainer:${projectId}:events`,
      [...current.filter(event => !(event.data?.clientPending === "unconfirmed" && event.text === message)), pending]));
    stopRequestedRef.current = false;
    setStreaming(true);
    setError("");
    setResetNotice("");
    setQuestion("");
    window.dispatchEvent(new CustomEvent("openfars:explainer-refresh", { detail: { projectId, active: true, source: "panel" } }));
    try {
      await streamProjectExplainerQuestion(
        projectId,
        message,
        (incoming) => {
          if (stopRequestedRef.current) return;
          if (currentProjectRef.current !== projectId) return;
          setEvents((current) => cacheResource(`project-explainer:${projectId}:events`, mergeExplainerMessages(current, incoming), false));
          const action = explainerActionFromEvent(incoming);
          if (action) notifyExplainerAction(action);
          window.dispatchEvent(new CustomEvent("openfars:explainer-event", { detail: { projectId, event: incoming, source: "panel" } }));
        },
        controller.signal
      );
    } catch (reason) {
      if (!controller.signal.aborted) {
        setError(reason instanceof Error ? reason.message : "项目解说失败");
        setQuestion(current => current || message);
        setEvents(current => current.map(event => event.id === pending.id ? { ...event, data: { ...event.data, clientPending: "unconfirmed" } } : event));
      }
    } finally {
      if (currentProjectRef.current === projectId) setEvents(current => cacheResource(`project-explainer:${projectId}:events`, current.map(event =>
        event.id === pending.id && event.data?.clientPending === "sending" ? { ...event, data: { ...event.data, clientPending: "unconfirmed" } } : event)));
      if (abortRef.current === controller) abortRef.current = undefined;
      setStreaming(false);
      if (!stopRequestedRef.current) setStopping(false);
      void loadHistory();
      window.dispatchEvent(new CustomEvent("openfars:explainer-refresh", { detail: { projectId, active: false, source: "panel" } }));
    }
  };

  const stopConversation = async () => {
    if (!streaming || stopping || stopRequestedRef.current) return;
    const controller = abortRef.current;
    stopRequestedRef.current = true;
    setStopping(true);
    setError("");
    try {
      // The backend only resolves this request after the selected Harness process has exited.
      await cancelProjectExplainer(projectId);
      if (abortRef.current === controller) controller?.abort();
    } catch (reason) {
      // A failed request is not a confirmed cancellation, so continue rendering
      // the still-active stream and allow the user to retry.
      stopRequestedRef.current = false;
      setError(
        reason instanceof Error
          ? `无法确认解说已停止：${reason.message}`
          : "无法确认解说已停止"
      );
    } finally {
      setStopping(false);
    }
  };

  const resetConversation = async () => {
    if (streaming || stopping || remoteActive || resetting) return;
    historyRequestRef.current += 1;
    setResetting(true);
    setError("");
    setResetNotice("");
    try {
      await resetProjectExplainer(projectId);
      setEvents([]);
      cacheResource(`project-explainer:${projectId}:events`, []);
      setQuestion("");
      setRemoteActive(false);
      setHistoryLoading(false);
      setResetNotice("解说上下文已刷新，可以重新询问。");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "解说上下文刷新失败");
    } finally {
      setResetting(false);
    }
  };

  const selectRuntimeGateway = (gatewayId: string) => {
    const requestId = ++gatewayRefreshRequestRef.current;
    const gateway = runtimeCatalog?.gateways?.find((item) => item.id === gatewayId);
    setGatewayRefreshError("");
    setConfigError("");
    setConfigNotice("");
    setConfigDraft((current) => current ? {
      ...current,
      ...(gateway ? { gatewayId: gateway.id } : { gatewayId: undefined }),
      model: gateway && gateway.models.includes(current.model) ? current.model : ""
    } : current);

    if (!gateway) {
      setRefreshingGatewayId("");
      return;
    }

    setRefreshingGatewayId(gateway.id);
    void refreshGatewayModels(gateway.id)
      .then((refreshed) => {
        if (requestId !== gatewayRefreshRequestRef.current) return;
        setRuntimeCatalog((current) => current ? {
          ...current,
          gateways: (current.gateways ?? []).map((item) =>
            item.id === refreshed.id ? refreshed : item
          )
        } : current);
        setConfigDraft((current) => current?.gatewayId === refreshed.id ? {
          ...current,
          model: refreshed.models.includes(current.model) ? current.model : ""
        } : current);
      })
      .catch((reason) => {
        if (requestId !== gatewayRefreshRequestRef.current) return;
        setGatewayRefreshError(
          reason instanceof Error
            ? `model 列表刷新失败：${reason.message}`
            : "model 列表刷新失败，请检查网关后重试"
        );
      })
      .finally(() => {
        if (requestId === gatewayRefreshRequestRef.current) setRefreshingGatewayId("");
      });
  };

  const saveRuntimeConfig = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!configDraft || configSaving) return;
    if (refreshingGatewayId) {
      setConfigError("正在刷新所选网关的 model 列表，请稍候");
      return;
    }
    if (gatewayRefreshError) {
      setConfigError("所选网关的 model 列表刷新失败，请重新选择网关后再保存");
      return;
    }
    const draftGateway = runtimeCatalog?.gateways?.find((gateway) => gateway.id === configDraft.gatewayId);
    if (!draftGateway || !configDraft.model.trim() || !draftGateway.models.includes(configDraft.model)) {
      setConfigError(!draftGateway
        ? "请选择已保存网关"
        : !configDraft.model.trim()
          ? "切换网关后需要重新选择 model"
          : "当前 model 不在所选网关的模型列表中，请重新选择");
      return;
    }
    if (!selectedHarnessCompatible) {
      setConfigError(
        selectedHarness?.availabilityReason ??
        "当前 Harness 不支持只读 Project Explainer。"
      );
      return;
    }
    setConfigSaving(true);
    setConfigError("");
    setConfigNotice("");
    const update = async (confirmHarnessSwitch = false) =>
      updateProjectExplainerConfig(projectId, {
        ...configDraft,
        ...(confirmHarnessSwitch ? { confirmHarnessSwitch: true } : {})
      });
    try {
      let updated: ProjectExplainerRuntimeConfig;
      try {
        updated = await update(false);
      } catch (reason) {
        const record = reason as { status?: number; details?: unknown };
        const details = record.details && typeof record.details === "object"
          ? record.details as Record<string, unknown>
          : {};
        if (
          record.status !== 409 ||
          details.code !== "explainer_harness_switch_confirmation_required" ||
          !window.confirm("当前回答会终止，已有历史将带入新会话。是否继续切换 harness？")
        ) throw reason;
        updated = await update(true);
      }
      setRuntimeConfig(updated);
      setGatewayRefreshError("");
      setConfigDraft({
        harness: updated.harness,
        ...(updated.gatewayId ? { gatewayId: updated.gatewayId } : {}),
        model: updated.model,
        reasoningEffort: updated.reasoningEffort
      });
      setConfigNotice(
        updated.harness !== runtimeConfig?.harness
          ? "已切换 harness 并重建底层会话，完整历史会带入下一次问答。"
          : "Project Explainer 配置已保存，将用于下一次问答。"
      );
      void loadHistory();
    } catch (reason) {
      setConfigError(reason instanceof Error ? reason.message : "Project Explainer 配置保存失败");
      if (runtimeConfig) {
        setConfigDraft({
          harness: runtimeConfig.harness,
          ...(runtimeConfig.gatewayId ? { gatewayId: runtimeConfig.gatewayId } : {}),
          model: runtimeConfig.model,
          reasoningEffort: runtimeConfig.reasoningEffort
        });
      }
    } finally {
      setConfigSaving(false);
    }
  };

  const selectedGateway: GatewayRecord | undefined = runtimeCatalog?.gateways?.find(
    (gateway) => gateway.id === configDraft?.gatewayId
  );
  const catalogHarnesses = runtimeCatalog?.harnesses ?? [];
  const explainerPurposeOptions = harnessOptionsForPurpose(
    catalogHarnesses,
    "explainer"
  );
  const compatibleExplainerHarnesses = explainerPurposeOptions.filter(
    (item) => item.available
  );
  const selectedHarnessId = configDraft?.harness
    ?? runtimeCatalog?.defaultHarnessId
    ?? compatibleExplainerHarnesses.find((item) => item.default)?.id
    ?? compatibleExplainerHarnesses[0]?.id
    ?? "";
  const harnessOptions = harnessOptionsForPurpose(
    catalogHarnesses,
    "explainer",
    selectedHarnessId
  );
  const selectedHarness = harnessOptions.find((item) => item.id === selectedHarnessId);
  const selectedHarnessCompatible = compatibleExplainerHarnesses.some(
    (item) => item.id === selectedHarnessId && item.available
  );
  const modelTestOptions = selectedGateway
    ? gatewayModelTestOptions(selectedGateway, selectedHarnessId, harnessOptions)
    : [];
  const failedModelOptions = modelTestOptions.filter((option) => option.test.status === "failed");
  const activeHarnessLabel = harnessOptions.find((item) => item.id === runtimeConfig?.harness)?.label
    ?? runtimeConfig?.harness
    ?? "Project Explainer";
  const routeNeeded = Boolean(
    selectedHarness?.nativeProtocol && selectedGateway && selectedHarness.nativeProtocol !== selectedGateway.protocol
  );
  const modelSelectionError = selectedGateway && configDraft
    ? !configDraft.model.trim()
      ? "切换网关后需要重新选择 model"
      : !selectedGateway.models.includes(configDraft.model)
        ? "当前 model 不在所选网关的模型列表中，请重新选择"
        : ""
    : "";
  const combinationTest = selectedGateway && selectedHarness && configDraft &&
    configDraft.model.trim() && selectedGateway.models.includes(configDraft.model)
    ? gatewayCombinationTestState(selectedGateway, selectedHarness.id, configDraft.model, harnessOptions)
    : undefined;
  const combinationTestWarning = combinationTest && combinationTest.status !== "passed"
    ? combinationTest.status === "failed"
      ? `当前 Harness / 网关 / model 组合验证失败${combinationTest.error ? `：${combinationTest.error}` : ""}；仍可使用，但运行可能失败。`
      : "当前 Harness / 网关 / model 组合尚未验证；仍可使用，但运行可能失败。"
    : "";
  const configDirty = Boolean(runtimeConfig && configDraft && (
    runtimeConfig.harness !== configDraft.harness ||
    runtimeConfig.gatewayId !== configDraft.gatewayId ||
    runtimeConfig.model !== configDraft.model ||
    runtimeConfig.reasoningEffort !== configDraft.reasoningEffort
  ));
  const configStateLabel = configSaving
    ? "保存中"
    : configError
      ? "保存失败"
      : configDirty
        ? "未保存修改"
        : configNotice
          ? "已保存"
          : runtimeConfig?.available
            ? runtimeConfig.validationWarning ? "未验证" : "可用"
            : "待配置";

  const handleQuestionKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const synthetic = event as KeyboardEvent<HTMLTextAreaElement> & { isComposing?: boolean };
    const native = event.nativeEvent as globalThis.KeyboardEvent & { which?: number };
    if (
      synthetic.isComposing ||
      native.isComposing ||
      native.keyCode === 229 ||
      native.which === 229 ||
      event.keyCode === 229 ||
      event.which === 229
    ) {
      // Prevent the form's native Enter submit while an IME owns the key.
      // Returning alone still lets jsdom/browsers perform implicit submit.
      event.preventDefault();
      return;
    }
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  };

  return (
    <section className="project-explainer-panel" aria-label="项目解说 Agent">
      <div className="project-explainer-heading">
        <div>
          <span className="project-explainer-icon"><Bot size={18} /></span>
          <span>
            <small>PROJECT EXPLAINER · {activeHarnessLabel}</small>
            <strong>询问这个科研项目</strong>
          </span>
        </div>
        <div className="project-explainer-heading-actions">
          <button
            type="button"
            className="project-explainer-reset"
            onClick={() => void resetConversation()}
            disabled={streaming || stopping || remoteActive || resetting || historyLoading}
            aria-label="刷新解说上下文"
            title="清空当前解说上下文并开始新会话"
          >
            <RefreshCw className={resetting ? "spin" : undefined} size={13} />
            刷新
          </button>
          <span className="project-explainer-policy">只读 · 无 Skills · 无 MCP</span>
        </div>
      </div>
      <div className="project-explainer-config-summary" aria-label="Project Explainer 当前运行配置">
        <div className="project-explainer-config-summary-copy">
          <span className="project-explainer-config-kicker">只读运行配置</span>
          <strong>{activeHarnessLabel} · {runtimeConfig?.model || configDraft?.model || "未选择 model"}</strong>
          <small>
            {selectedGateway?.name || "未选择全局网关"} · {selectedGateway ? protocolLabel(selectedGateway.protocol) : "等待路由"}
            {routeNeeded && selectedHarness?.nativeProtocol && selectedGateway ? ` · ${protocolLabel(selectedHarness.nativeProtocol)} → ${protocolLabel(selectedGateway.protocol)}` : ""}
          </small>
        </div>
        <span className={`project-explainer-config-state ${runtimeConfig?.available ? "available" : "pending"}`}>
          {configStateLabel}
        </span>
        <button
          type="button"
          className="project-explainer-config-open"
          onClick={() => setConfigEditorOpen(true)}
          aria-expanded={configEditorOpen}
          aria-controls="project-explainer-runtime-config"
        >
          切换配置
        </button>
      </div>
      {runtimeConfig?.validationWarning && <p className="project-explainer-config-warning" role="status">{runtimeConfig.validationWarning}</p>}
      <form
        id="project-explainer-runtime-config"
        className="project-explainer-runtime-config"
        data-open={configEditorOpen ? "true" : "false"}
        role="dialog"
        aria-modal="true"
        onSubmit={saveRuntimeConfig}
        aria-label="Project Explainer 运行配置"
      >
        <div className="project-explainer-runtime-heading">
          <span>
            <strong>只读运行配置</strong>
            <small>仅影响后续项目问答，不影响 Main/Worker 工作流</small>
          </span>
          <span className="project-explainer-runtime-heading-actions">
            <em className={runtimeConfig?.available ? "available" : "unavailable"}>
              {configStateLabel}
            </em>
            <button
              type="button"
              className="project-explainer-config-close"
              onClick={() => setConfigEditorOpen(false)}
              aria-label="关闭 Project Explainer 配置"
            >
              关闭
            </button>
          </span>
        </div>
        {configLoading || !configDraft ? (
          <div className="project-explainer-config-loading"><LoaderCircle className="spin" size={14} />正在加载配置…</div>
        ) : (
          <>
            <div className="project-explainer-runtime-grid">
              <label>
                <span>Harness</span>
                <select
                  aria-label="Project Explainer Harness"
                  value={configDraft.harness}
                  onChange={(event) => setConfigDraft((current) => current ? {
                    ...current,
                    harness: event.target.value as AgentHarness
                  } : current)}
                >
                  {harnessOptions.length ? harnessOptions.map((item) => (
                    <option key={item.id} value={item.id} disabled={!item.available}>
                      {item.label}{item.available ? "" : `（${item.availabilityReason ?? "不可用"}）`}
                    </option>
                  )) : <option value={configDraft.harness}>{configDraft.harness}</option>}
                </select>
              </label>
              <label>
                <span>全局网关</span>
                <select
                  aria-label="Project Explainer 全局网关"
                  value={configDraft.gatewayId ?? ""}
                  onChange={(event) => selectRuntimeGateway(event.target.value)}
                >
                  <option value="">请选择已保存网关</option>
                  {(runtimeCatalog?.gateways ?? []).map((gateway) => {
                    const state = gatewayHarnessTestState(gateway, selectedHarnessId, harnessOptions);
                    return (
                      <option key={gateway.id} value={gateway.id}>
                        {gateway.name} · {state.status === "passed" ? "有已验证 model" : state.status === "failed" ? "连接验证失败" : "当前 Harness 未验证"}
                      </option>
                    );
                  })}
                </select>
              </label>
              <div className="project-explainer-derived-route" aria-live="polite"><span>网关协议与路由</span><strong>{selectedGateway ? protocolLabel(selectedGateway.protocol) : "选择网关后显示"}</strong><small>{routeNeeded && selectedHarness?.nativeProtocol && selectedGateway ? `自动路由：${protocolLabel(selectedHarness.nativeProtocol)} → ${protocolLabel(selectedGateway.protocol)}` : selectedGateway && selectedHarness?.nativeProtocol ? "直连" : selectedGateway ? "Harness 目录待确认" : "尚未推导"}</small>{combinationTestWarning && <small className="project-explainer-config-warning" role="status">{combinationTestWarning}</small>}</div>
              <label>
                <span>Model</span>
                {selectedGateway ? (
                  <select
                    aria-label="Project Explainer Model"
                    value={configDraft.model}
                    disabled={Boolean(refreshingGatewayId)}
                    onChange={(event) => setConfigDraft((current) => current ? {
                      ...current,
                      model: event.target.value
                    } : current)}
                    aria-invalid={Boolean(modelSelectionError)}
                  >
                    <option value="" disabled>请选择网关 model</option>
                    {modelTestOptions.map(({ model, test }) => (
                      <option key={model} value={model} title={test.error}>
                        {model} · {test.status === "passed" ? "已验证" : test.status === "failed" ? "验证失败" : "未验证"}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    aria-label="Project Explainer Model"
                    value={configDraft.model}
                    disabled
                    aria-invalid={Boolean(modelSelectionError)}
                  />
                )}
                {refreshingGatewayId && (
                  <small className="project-explainer-config-loading" role="status">
                    <LoaderCircle className="spin" size={12} />正在刷新 model 列表…
                  </small>
                )}
                {gatewayRefreshError && <small className="field-error" role="alert">{gatewayRefreshError}</small>}
                {modelSelectionError && <small className="field-error" role="alert">{modelSelectionError}</small>}
                {failedModelOptions.length > 0 && <small className="project-explainer-config-warning">以下 model 验证失败，仍可选择并使用：{failedModelOptions.map(({ model, test }) => `${model}${test.error ? `（${test.error}）` : ""}`).join("；")}</small>}
              </label>
            </div>
            {routeNeeded && selectedHarness?.nativeProtocol && (
              <span className="project-explainer-route-notice">
                已根据所选 harness 和网关协议自动启用本地路由；可直接保存并尝试运行。
              </span>
            )}
            {runtimeConfig?.validationError && !runtimeConfig.available && (
              <span className="project-explainer-config-error" role="alert">{runtimeConfig.validationError}</span>
            )}
            {!compatibleExplainerHarnesses.length && (
              <span className="project-explainer-config-error" role="alert">
                当前服务端没有注册可用的只读 Project Explainer Harness。
              </span>
            )}
            {compatibleExplainerHarnesses.length > 0 && !selectedHarnessCompatible && (
              <span className="project-explainer-config-error" role="alert">
                {selectedHarness?.availabilityReason ?? "当前 Harness 不支持只读 Project Explainer。"}
              </span>
            )}
            <div className="project-explainer-runtime-actions">
              <small>运行期间可修改；URL 与 API key 只在全局网关库维护。</small>
              <Button type="submit" variant="secondary" loading={configSaving} disabled={configSaving || Boolean(refreshingGatewayId) || Boolean(gatewayRefreshError) || !selectedGateway || !selectedHarnessCompatible || Boolean(modelSelectionError)}>
                保存问答配置
              </Button>
            </div>
          </>
        )}
        {configError && <span className="project-explainer-config-error" role="alert">{configError}</span>}
        {configNotice && <span className="project-explainer-config-notice" role="status"><CheckCircle2 size={13} />{configNotice}</span>}
      </form>
      <div
        className="project-explainer-transcript"
        ref={transcriptRef}
        aria-live="polite"
        aria-label="项目解说对话"
      >
        {historyLoading && !events.length ? (
          <div className="project-explainer-empty">
            <LoaderCircle className="spin" size={20} />
            正在读取解说会话…
          </div>
        ) : events.length ? (
          events.filter(isExplainerConversationMessage).map((entry) => {
            const action = explainerActionFromEvent(entry);
            if (action) return <ExplainerActionCard key={entry.id} action={action} />;
            if (entry.kind === "user") {
              return (
                <div className="project-explainer-message user" key={entry.id}>
                  <small>你</small>
                  <p>{entry.text}</p>
                  {!!entry.data?.clientPending && <small>{entry.data.clientPending === "sending" ? "发送中…" : "发送未确认，请检查后重试"}</small>}
                </div>
              );
            }
            if (entry.kind === "assistant") {
              return (
                <div className="project-explainer-message assistant" key={entry.id}>
                  <small><Bot size={12} /> {activeHarnessLabel}</small>
                  <div className="markdown-body">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm, remarkMath]}
                      rehypePlugins={[rehypeSanitize, rehypeKatex]}
                    >
                      {entry.text || (streaming ? "…" : "")}
                    </ReactMarkdown>
                  </div>
                </div>
              );
            }
            if (["reasoning", "tool", "tool_output"].includes(entry.kind)) {
              const sameCall = (event: ProjectExplainerEvent) => event.turnId === entry.turnId && event.itemId === entry.itemId;
              if (entry.kind === "tool_output" && events.some(event => event.kind === "tool" && sameCall(event))) return null;
              return <ProjectExplainerTrace key={`${entry.turnId}:${entry.kind}:${entry.itemId ?? entry.id}`} event={entry}
                output={events.filter(event => event.kind === "tool_output" && sameCall(event)).at(-1)}
                active={(streaming || remoteActive) && entry.turnId === events.at(-1)?.turnId} />;
            }
            return (
              <div
                className={`project-explainer-status ${entry.kind}`}
                key={entry.id}
                role={entry.kind === "error" ? "alert" : undefined}
              >
                {entry.kind === "error" ? <AlertTriangle size={13} /> : <Activity size={12} />}
                {entry.text}
              </div>
            );
          })
        ) : (
          <div className="project-explainer-empty">
            <Bot size={24} />
            <strong>可直接询问项目现状、实验、论文或评审依据</strong>
            <small>所选解说 Agent 只能读取本项目 workspaces，不会修改科研文件或流程。</small>
          </div>
        )}
        <ProjectExplainerReplyStatus events={events} active={streaming || remoteActive} />
      </div>
      <form className="project-explainer-compose" onSubmit={submit}>
        <textarea
          value={question}
          onChange={(event) => {
            setQuestion(event.target.value);
            if (error) setError("");
            if (resetNotice) setResetNotice("");
          }}
          onKeyDown={handleQuestionKeyDown}
          rows={2}
          maxLength={50_000}
          disabled={streaming || stopping || remoteActive || resetting || !runtimeConfig?.available}
          placeholder={
            remoteActive
              ? "另一个页面中的解说正在回答…"
              : runtimeConfig && !runtimeConfig.available
                ? "请先修复并保存上方 Project Explainer 配置…"
              : "例如：当前实验做到哪一步？论文结论由哪些结果支持？"
          }
          aria-label="向项目解说 Agent 提问"
        />
        <div>
          <small>Enter 发送 · Shift+Enter 换行</small>
          {streaming || stopping ? (
            <Button
              type="button"
              variant="secondary"
              icon={<CircleStop size={15} />}
              loading={stopping}
              onClick={() => void stopConversation()}
              disabled={stopping}
            >
              {stopping ? "停止中" : "停止"}
            </Button>
          ) : (
            <Button
              type="submit"
              variant="primary"
              icon={<Send size={15} />}
              disabled={!question.trim() || stopping || remoteActive || resetting || !runtimeConfig?.available}
            >
              询问解说
            </Button>
          )}
        </div>
        {error && <span className="project-explainer-error" role="alert">{error}</span>}
        {resetNotice && (
          <span className="project-explainer-reset-notice" role="status">
            <CheckCircle2 size={13} />
            {resetNotice}
          </span>
        )}
      </form>
    </section>
  );
}
