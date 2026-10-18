import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import { Bot, ChevronDown, LoaderCircle, MessageSquare, Minus, Plus, Send, Settings2, Square, Undo2 } from "lucide-react";
import { ApiError, cancelExplainerConversation, createExplainerConversation, explainerAssistantDraftPayload, getCatalog, getExplainerConversation,
  getExplainerConversationConfig, getExplainerConversationHistory, streamExplainerConversation, syncExplainerConversation,
  undoExplainerDraft, updateExplainerConversationConfig, type ExplainerAssistantAction, type ExplainerAssistantContext } from "../api";
import type { Catalog, CreateProjectInput, ProjectExplainerConfigInput, ProjectExplainerEvent, ProjectExplainerRuntimeConfig } from "../types";
import "./project-explainer-assistant.css";
import { foldExplainerMessages, isExplainerConversationMessage, mergeExplainerMessages } from "./project-explainer-events";
import { ProjectExplainerReplyStatus, ProjectExplainerTrace } from "./ProjectExplainerTrace";
export { mergeExplainerMessages } from "./project-explainer-events";

interface EditorBridge {
  key: string; taskId?: string; projectId?: string;
  base?: { revision: number; hash: string };
  read(): CreateProjectInput;
  apply(draft: CreateProjectInput, taskId?: string, workflowBase?: ExplainerAssistantContext["workflowBase"]): void;
}
interface AssistantValue {
  show(message?: string): void;
  conversationId?: string;
  registerEditor(editor: EditorBridge): () => void;
  bindDraft(taskId: string, draft: CreateProjectInput): Promise<void>;
}
const AssistantContext = createContext<AssistantValue | undefined>(undefined);
export function useProjectExplainerAssistant() { return useContext(AssistantContext); }
export function useExplainerDraftBridge(input: { active: boolean; key: string; taskId?: string; projectId?: string; base?: { revision: number; hash: string }; draft: CreateProjectInput;
  apply(draft: CreateProjectInput, taskId?: string, workflowBase?: ExplainerAssistantContext["workflowBase"]): void }) {
  const assistant = useProjectExplainerAssistant();
  const latest = useRef(input); latest.current = input;
  useEffect(() => {
    if (!assistant || !input.active) return;
    return assistant.registerEditor({ key: input.key, get taskId() { return latest.current.taskId; }, get projectId() { return latest.current.projectId; }, get base() { return latest.current.base; },
      read: () => latest.current.draft, apply: (draft, taskId, base) => {
        latest.current.apply(draft, taskId, base);
        // Several committed tool receipts can arrive in one streamed chunk,
        // before React renders the first application.
        latest.current = { ...latest.current, draft, ...(taskId ? { taskId } : {}) };
      } });
  }, [assistant?.registerEditor, input.active, input.key]);
  return assistant;
}
export function explainerDraftFingerprint(draft: CreateProjectInput): string {
  const value = structuredClone(explainerAssistantDraftPayload(draft));
  delete value.explainerConversationId; delete value.sourceSavedTaskId;
  delete value.inputUploadId; delete value.inputDescription;
  if (value.orchestration) delete value.orchestration.canvas;
  const stable = (item: unknown): unknown => Array.isArray(item) ? item.map(stable) : item && typeof item === "object"
    ? Object.fromEntries(Object.entries(item).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, stable(value)])) : item;
  return JSON.stringify(stable(value));
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const configInput = (config: ProjectExplainerRuntimeConfig): ProjectExplainerConfigInput => ({ harness: config.harness,
  gatewayId: config.gatewayId, model: config.model, reasoningEffort: config.reasoningEffort });
const draftPayload = (input: CreateProjectInput) => {
  const { explainerConversationId: _conversation, sourceSavedTaskId: _source, inputUploadId: _upload, inputDescription: _description, ...draft } = input;
  return draft;
};
const actionFromEvent = (event: ProjectExplainerEvent) => {
  const action = event.data?.assistantAction as ExplainerAssistantAction | undefined;
  return action?.context?.id && ["draft.updated", "draft.saved", "draft.undone", "workflow.submitted"].includes(action.kind) ? action : undefined;
};

export function ProjectExplainerAssistantProvider({ children, target }: { children: ReactNode; target: { newProject?: boolean; taskId?: string; projectId?: string } }) {
  const [open, setOpen] = useState(false);
  const [context, setContext] = useState<ExplainerAssistantContext>();
  const contextRef = useRef(context); contextRef.current = context;
  const [events, setEvents] = useState<ProjectExplainerEvent[]>([]);
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [runningId, setRunningId] = useState<string>();
  const [remoteActive, setRemoteActive] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pendingAction, setPendingAction] = useState<ExplainerAssistantAction>();
  const [config, setConfig] = useState<ProjectExplainerRuntimeConfig>();
  const [catalog, setCatalog] = useState<Catalog>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);
  const [configDraft, setConfigDraft] = useState<ProjectExplainerConfigInput>();
  const editor = useRef<EditorBridge>();
  const request = useRef<AbortController>();
  const epoch = useRef(0);
  const loadedKey = useRef<string>();
  const transcript = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number }>();
  const [mobile, setMobile] = useState(() => window.innerWidth <= 620);
  const key = target.projectId ? `project:${target.projectId}` : target.taskId ? `task:${target.taskId}` : target.newProject ? "new" : "home";
  const currentKey = useRef(key); currentKey.current = key;
  const registerEditor = useCallback((value: EditorBridge) => { editor.current = value; return () => { if (editor.current === value) editor.current = undefined; }; }, []);
  const show = useCallback((text?: string) => { if (text) setQuestion(text); setOpen(true); }, []);
  const load = useCallback(async (forceNew = false) => {
    const generation = ++epoch.current; setLoading(true); setError("");
    try {
      let conversation: ExplainerAssistantContext | undefined;
      const storageKey = `openfars.explainer.conversation.${key}`;
      if (!forceNew && !target.taskId && !target.projectId) {
        try { const savedId = localStorage.getItem(storageKey); if (savedId) conversation = await getExplainerConversation(savedId); }
        catch (error) { if (!(error instanceof ApiError && error.status === 404)) throw error; }
        // A fresh project must not inherit a previously saved or running target.
        if (target.newProject && (conversation?.taskId || conversation?.projectId)) conversation = undefined;
      }
      if (!conversation) conversation = await createExplainerConversation({ ...(target.taskId ? { taskId: target.taskId } : {}), ...(target.projectId ? { projectId: target.projectId } : {}) });
      const [history, runtimeConfig, runtimeCatalog] = await Promise.all([getExplainerConversationHistory(conversation.id), getExplainerConversationConfig(conversation.id), getCatalog()]);
      if (generation !== epoch.current) return;
      const sameConversation = contextRef.current?.id === conversation.id;
      contextRef.current = conversation; setContext(conversation);
      setEvents(current => foldExplainerMessages(sameConversation && history.active ? [...history.events, ...current] : history.events));
      loadedKey.current = key;
      setRemoteActive(history.active); setConfig(runtimeConfig); setConfigDraft(configInput(runtimeConfig)); setCatalog(runtimeCatalog);
      setPendingAction(undefined); setNotice("");
      if (target.newProject && !target.taskId && !conversation.taskId && !conversation.projectId &&
        (conversation.draft.title || conversation.draft.requirement) && editor.current &&
        explainerDraftFingerprint(conversation.draft) !== explainerDraftFingerprint(editor.current.read())) {
        setPendingAction({ kind: "draft.updated", context: conversation, summary: "已恢复上次助手会话中的草稿。" });
        setNotice("上次的助手草稿已保留。可以应用到当前表单，或继续使用你的手动编辑。");
      }
      try { localStorage.setItem(storageKey, conversation.id); } catch { /* Conversation remains stored on the server. */ }
    } catch (error) { if (generation === epoch.current) setError(message(error)); }
    finally { if (generation === epoch.current) setLoading(false); }
  }, [key, target.taskId, target.projectId]);
  useEffect(() => { if (open && loadedKey.current !== key) void load(); return () => { ++epoch.current; }; }, [open, load, key]);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    const resize = () => {
      setMobile(window.innerWidth <= 620);
      const box = panel.current?.getBoundingClientRect();
      if (box) setPosition(current => current ? { left: Math.max(0, Math.min(current.left, window.innerWidth - box.width)),
        top: Math.max(0, Math.min(current.top, window.innerHeight - box.height)) } : current);
    };
    window.addEventListener("resize", resize); return () => window.removeEventListener("resize", resize);
  }, []);
  useEffect(() => { const node = transcript.current; if (node) node.scrollTop = node.scrollHeight; }, [events, open]);
  useEffect(() => {
    if (!open || !context || !remoteActive || runningId === context.id) return;
    let disposed = false;
    let inFlight = false;
    const refresh = () => {
      if (disposed || inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      void getExplainerConversationHistory(context.id).then(history => {
        if (disposed || contextRef.current?.id !== context.id) return;
        setEvents(current => foldExplainerMessages(history.active ? [...history.events, ...current] : history.events)); setRemoteActive(history.active);
      }).catch(error => { if (!disposed) setError(message(error)); }).finally(() => { inFlight = false; });
    };
    const timer = window.setInterval(refresh, 2000);
    document.addEventListener("visibilitychange", refresh);
    return () => { disposed = true; window.clearInterval(timer); document.removeEventListener("visibilitychange", refresh); };
  }, [open, context?.id, remoteActive, runningId]);
  const applyAction = (action: ExplainerAssistantAction, expected?: string, force = false) => {
    if (contextRef.current?.id !== action.context.id) return;
    const previous = contextRef.current;
    if (action.context.revision < previous.revision) return;
    if (previous.projectId && action.context.projectId !== previous.projectId) return;
    contextRef.current = action.context; setContext(action.context);
    const bridge = editor.current;
    const matches = bridge && (bridge.projectId ? bridge.projectId === action.context.projectId : bridge.taskId ? bridge.taskId === action.context.taskId : currentKey.current === "new");
    if (matches && action.kind !== "workflow.submitted") {
      const current = explainerDraftFingerprint(bridge.read());
      if (force || current === expected || current === explainerDraftFingerprint(previous.draft)) {
        bridge.apply(action.context.draft, action.context.taskId, action.context.workflowBase); setPendingAction(undefined);
      } else {
        setPendingAction(action); setNotice("你在生成期间修改了草稿，已保留手动编辑。可以查看助手结果后选择应用，或继续说明新的要求。");
      }
    }
    if (action.kind === "workflow.submitted") window.dispatchEvent(new CustomEvent("openfars:workflow-adjusted", { detail: { projectId: action.context.projectId } }));
    if (action.context.taskId && !action.context.projectId) window.dispatchEvent(new Event("openfars:saved-tasks-changed"));
  };
  const bindDraft = async (taskId: string, draft: CreateProjectInput) => {
    const prior = contextRef.current; if (!prior || loadedKey.current !== currentKey.current) return;
    const next = await syncExplainerConversation(prior.id, { expectedRevision: prior.revision, draft, taskId });
    contextRef.current = next; setContext(next);
  };
  const send = async () => {
    const text = question.trim(), prior = contextRef.current;
    if (!text || !prior || runningId || remoteActive || loading || !config?.available) return;
    const activeKey = currentKey.current;
    const controller = new AbortController(); request.current = controller;
    let expected = editor.current ? explainerDraftFingerprint(editor.current.read()) : undefined;
    setError(""); setNotice(""); setRunningId(prior.id);
    try {
      if (editor.current) {
        const next = await syncExplainerConversation(prior.id, { expectedRevision: prior.revision, draft: draftPayload(editor.current.read()), ...(editor.current.taskId ? { taskId: editor.current.taskId } : {}),
          ...(editor.current.base ? { workflowBase: editor.current.base } : {}) });
        contextRef.current = next; setContext(next);
      }
      setQuestion(""); setRemoteActive(true);
      window.dispatchEvent(new CustomEvent("openfars:explainer-refresh", { detail: { projectId: prior.projectId, active: true } }));
      await streamExplainerConversation(prior.id, text, event => {
        window.dispatchEvent(new CustomEvent("openfars:explainer-event", { detail: { projectId: prior.projectId, event, source: "floating" } }));
        if (contextRef.current?.id !== prior.id) return;
        setEvents(events => mergeExplainerMessages(events, event));
        const action = actionFromEvent(event);
        if (action) { applyAction(action, activeKey === currentKey.current ? expected : undefined); expected = explainerDraftFingerprint(action.context.draft); }
      }, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) {
        setError(message(error));
        try { const latest = await getExplainerConversation(prior.id); if (contextRef.current?.id === prior.id) { contextRef.current = latest; setContext(latest); } } catch { /* Keep confirmed state. */ }
      }
    } finally {
      if (request.current === controller) { request.current = undefined; setRunningId(undefined); }
      if (contextRef.current?.id === prior.id) {
        setRemoteActive(false);
        const history = await getExplainerConversationHistory(prior.id).catch(() => undefined);
        if (history && !history.active) setEvents(foldExplainerMessages(history.events));
      }
      window.dispatchEvent(new CustomEvent("openfars:explainer-refresh", { detail: { projectId: contextRef.current?.projectId, active: false } }));
    }
  };
  const stop = async () => {
    const id = runningId ?? context?.id; if (!id) return;
    try { await cancelExplainerConversation(id); request.current?.abort(); setRemoteActive(false); }
    catch (error) { setError(message(error)); }
  };
  const saveConfig = async () => {
    if (!context || !configDraft) return;
    setSavingConfig(true); setError("");
    try {
      let updated: ProjectExplainerRuntimeConfig;
      try { updated = await updateExplainerConversationConfig(context.id, configDraft); }
      catch (error) {
        if (!(error instanceof ApiError) || error.status !== 409 || (error.details as { code?: string })?.code !== "explainer_harness_switch_confirmation_required" ||
          !window.confirm("切换 Harness 会停止当前回答，并将已有历史带入新会话。是否继续？")) throw error;
        updated = await updateExplainerConversationConfig(context.id, { ...configDraft, confirmHarnessSwitch: true });
      }
      setConfig(updated); setConfigDraft(configInput(updated)); setNotice("Project Explainer 配置已更新，已有对话历史保留。");
      const history = await getExplainerConversationHistory(context.id); setEvents(foldExplainerMessages(history.events));
      window.dispatchEvent(new CustomEvent("openfars:explainer-refresh", { detail: { projectId: context.projectId } }));
    } catch (error) { setError(message(error)); }
    finally { setSavingConfig(false); }
  };
  const undo = async () => {
    const prior = contextRef.current; if (!prior || runningId) return;
    try {
      if (editor.current && explainerDraftFingerprint(editor.current.read()) !== explainerDraftFingerprint(prior.draft)) {
        setNotice("草稿已有新的手动修改，已保留。请告诉助手需要撤销的具体内容。"); return;
      }
      const result = await undoExplainerDraft(prior.id, prior.revision); applyAction(result.action, explainerDraftFingerprint(prior.draft)); setNotice(result.action.summary);
    } catch (error) { setError(message(error)); }
  };
  const drag = (event: React.PointerEvent) => {
    if (window.innerWidth <= 620 || (event.target as HTMLElement).closest("button")) return;
    const node = panel.current; if (!node) return;
    event.preventDefault(); const box = node.getBoundingClientRect(), x = event.clientX, y = event.clientY;
    const move = (next: PointerEvent) => setPosition({ left: Math.max(0, Math.min(window.innerWidth - box.width, box.left + next.clientX - x)),
      top: Math.max(0, Math.min(window.innerHeight - box.height, box.top + next.clientY - y)) });
    const end = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", end, { once: true });
  };
  const gateway = catalog?.gateways?.find(item => item.id === configDraft?.gatewayId);
  const traceKey = (event: ProjectExplainerEvent) => `${event.turnId}:${event.itemId}`;
  const tools = new Set(events.filter(event => event.kind === "tool").map(traceKey));
  const outputs = new Map(events.filter(event => event.kind === "tool_output").map(event => [traceKey(event), event]));
  const activeTurnId = events.at(-1)?.turnId;
  const turns = events.filter(event => event.kind === "user" || event.kind === "error" && isExplainerConversationMessage(event) || event.kind === "assistant" && event.text.trim() ||
    event.kind === "reasoning" || event.kind === "tool" || event.kind === "tool_output" && !tools.has(traceKey(event)) ||
    event.kind === "status" && isExplainerConversationMessage(event));
  const active = !!runningId || remoteActive;

  useEffect(() => {
    const receive = (incoming: Event) => {
      const detail = (incoming as CustomEvent).detail as { source?: string; projectId?: string; event?: ProjectExplainerEvent };
      if (detail.source === "floating" || !detail.event || !detail.projectId || contextRef.current?.projectId !== detail.projectId) return;
      setEvents(current => mergeExplainerMessages(current, detail.event!));
      setRemoteActive(!detail.event.data?.turnComplete);
      const action = actionFromEvent(detail.event); if (action) applyAction(action);
    };
    const refresh = (incoming: Event) => {
      const detail = (incoming as CustomEvent).detail as { projectId?: string; active?: boolean; source?: string };
      if (detail.source !== "panel" || !detail.projectId || contextRef.current?.projectId !== detail.projectId) return;
      setRemoteActive(detail.active === true);
      if (detail.active === false) void load();
    };
    window.addEventListener("openfars:explainer-event", receive); window.addEventListener("openfars:explainer-refresh", refresh);
    return () => { window.removeEventListener("openfars:explainer-event", receive); window.removeEventListener("openfars:explainer-refresh", refresh); };
  }, [load]);

  return <AssistantContext.Provider value={{ show, registerEditor, bindDraft, conversationId: loadedKey.current === key ? context?.id : undefined }}>
    {children}
    {createPortal(<>
      {!open && <button type="button" className={`explainer-floating-launcher${active ? " is-active" : ""}`} aria-label="打开 Project Explainer 助手" onClick={() => show()}><Bot size={20} /><span>Project Explainer</span>{active && <LoaderCircle size={14} className="spin" />}</button>}
      {open && <section ref={panel} className="explainer-floating-panel" role="dialog" aria-modal="false" aria-label="Project Explainer 助手"
        style={position && !mobile ? { ...position, right: "auto", bottom: "auto" } : undefined}
        onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false); } }}>
        <header className="explainer-floating-head" onPointerDown={drag}><Bot size={20} /><div><strong>Project Explainer</strong><small>{target.projectId ? "当前项目" : context?.draft.title || "一起设计项目与 Workflow"}</small></div>
          {key === "home" && <button type="button" aria-label="开始新的助手会话" title="开始新的项目草稿对话" disabled={active || loading} onClick={() => void load(true)}><Plus size={17} /></button>}
          <button type="button" aria-label="助手 Harness 与模型设置" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(value => !value)}><Settings2 size={17} /></button>
          <button type="button" aria-label="最小化助手" onClick={() => setOpen(false)}><Minus size={18} /></button></header>
        <div className="explainer-floating-route"><span>{config ? `${config.harness} · ${config.model}` : "正在读取 Agent 配置…"}</span><button type="button" aria-label="展开助手配置" onClick={() => setSettingsOpen(value => !value)}><ChevronDown size={13} /></button></div>
        {settingsOpen && <div className="explainer-floating-settings" role="group" aria-label="悬浮助手配置">
          <label>Harness<select aria-label="助手 Harness" value={configDraft?.harness ?? ""} disabled={loading || savingConfig} onChange={event => configDraft && setConfigDraft({ ...configDraft, harness: event.target.value })}>
            {!catalog?.harnesses?.some(item => item.id === configDraft?.harness) && <option value={configDraft?.harness ?? ""}>{configDraft?.harness ?? "加载中"}</option>}
            {catalog?.harnesses?.filter(item => item.purposes.includes("explainer") && item.capabilities.readOnlyExplainer && item.selectable !== false && item.userSelectable !== false).map(item => <option key={item.id} value={item.id} disabled={!item.available}>{item.label}</option>)}</select></label>
          <label>网关<select aria-label="助手网关" value={configDraft?.gatewayId ?? ""} disabled={loading || savingConfig} onChange={event => { const item = catalog?.gateways?.find(item => item.id === event.target.value); if (item && configDraft) setConfigDraft({ ...configDraft, gatewayId: item.id, model: item.defaultModel }); }}>
            {!gateway && <option value="">请选择网关</option>}{catalog?.gateways?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label>模型<select aria-label="助手模型" value={configDraft?.model ?? ""} disabled={loading || savingConfig || !gateway} onChange={event => configDraft && setConfigDraft({ ...configDraft, model: event.target.value })}>
            {!gateway?.models.includes(configDraft?.model ?? "") && <option value={configDraft?.model ?? ""}>{configDraft?.model || "请选择模型"}</option>}{gateway?.models.map(model => <option key={model} value={model}>{model}</option>)}</select></label>
          <label>思考强度<select aria-label="助手思考强度" value={configDraft?.reasoningEffort ?? "high"} disabled={loading || savingConfig} onChange={event => configDraft && setConfigDraft({ ...configDraft, reasoningEffort: event.target.value as ProjectExplainerConfigInput["reasoningEffort"] })}>
            {["low", "medium", "high", "xhigh"].map(item => <option key={item} value={item}>{item}</option>)}</select></label>
          <button type="button" disabled={loading || savingConfig || !configDraft} onClick={() => void saveConfig()}>{savingConfig ? "正在保存…" : "保存助手配置"}</button>
        </div>}
        <div className="explainer-floating-transcript" ref={transcript} role="log" aria-label="助手对话记录" aria-live="polite">
          {loading && <p className="explainer-floating-empty"><LoaderCircle className="spin" size={18} />正在读取同一段会话…</p>}
          {!loading && !turns.length && <div className="explainer-floating-empty"><MessageSquare size={25} /><strong>描述你想做的研究或 Workflow</strong><p>可以创建项目草稿、增加并行协作组，或继续调整当前配置。草稿由你查看后启动。</p>
            <button type="button" onClick={() => setQuestion("请根据我的课题设计 Workflow，至少包含一个协作组，组内至少三个 Agent 并行协作，最后独立复核。")}>试试：三个 Agent 并行协作</button></div>}
          {turns.map(event => {
            const action = actionFromEvent(event);
            if (["reasoning", "tool", "tool_output"].includes(event.kind)) return <ProjectExplainerTrace key={`${event.turnId}:${event.kind}:${event.itemId ?? event.id}`}
              event={event} output={outputs.get(traceKey(event))} active={active && event.turnId === activeTurnId} />;
            return action ? <article key={event.id} className="explainer-action-card"><strong>{action.kind === "draft.saved" || action.kind === "draft.updated" && action.context.taskId && !action.context.projectId ? "项目草稿已保存" : action.kind === "workflow.submitted" ? "Workflow 修改已提交" : "草稿已更新"}</strong><p>{action.summary}</p>
              {action.href && /^\/(?:saved-tasks\/task_[a-f0-9]{32}\/edit|projects\/prj_[a-f0-9]{32})$/.test(action.href) && <a href={`#${action.href}`}>打开{action.href.startsWith("/saved-tasks/") ? "项目草稿" : "项目"}</a>}</article>
              : <article key={`${event.turnId}:${event.itemId ?? event.id}`} className={`explainer-chat-message ${event.kind}`} role={event.kind === "error" ? "alert" : undefined}><small>{event.kind === "user" ? "你" : "Project Explainer"}</small><ReactMarkdown>{event.text}</ReactMarkdown></article>;
          })}
          <ProjectExplainerReplyStatus events={events} active={active} />
        </div>
        {config?.validationWarning && <p className="explainer-floating-warning">{config.validationWarning}</p>}
        {config && !config.available && <p className="explainer-floating-error" role="alert">{config.validationError}</p>}
        {error && <p className="explainer-floating-error" role="alert">{error}<button type="button" onClick={() => void load()}>重新读取</button></p>}
        {notice && <p className="explainer-floating-notice" role="status">{notice}</p>}
        {pendingAction && <button type="button" className="explainer-pending-apply" onClick={() => applyAction(pendingAction, undefined, true)}>应用助手修改</button>}
        <form className="explainer-floating-compose" onSubmit={event => { event.preventDefault(); void send(); }}>
          <textarea aria-label="给 Project Explainer 的消息" aria-describedby="explainer-compose-hint" placeholder="例如：保留现有 Agent，增加一个三人并行协作组…" rows={3} maxLength={50_000} value={question} onChange={event => setQuestion(event.target.value)} autoFocus
            onKeyDown={event => {
              if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
              event.preventDefault();
              if (!event.repeat) event.currentTarget.form?.requestSubmit();
            }} />
          <small id="explainer-compose-hint" className="explainer-compose-hint">回车发送 · Shift + 回车换行</small>
          <div><button type="button" className="explainer-undo" disabled={!context || context.canUndo === false || active || loading} onClick={() => void undo()}><Undo2 size={13} />撤销助手修改</button>
            {active ? <button type="button" onClick={() => void stop()}><Square size={13} />停止</button> : <button type="submit" className="explainer-send" disabled={loading || !question.trim() || !config?.available}><Send size={14} />发送</button>}</div>
        </form>
      </section>}
    </>, document.body)}
  </AssistantContext.Provider>;
}
