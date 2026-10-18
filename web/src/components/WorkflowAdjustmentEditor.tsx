import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { ApiError, getWorkflowAdjustmentDetail, submitWorkflowAdjustment, withdrawWorkflowAdjustment } from "../api";
import type { FixedMcpDefinition, GatewayRecord, HarnessCatalogEntry, Project, SkillDefinition } from "../types";
import type { WorkflowAdjustmentContext, WorkflowAdjustmentRecord, WorkflowAdjustmentSummary } from "../workflowAdjustments";
import { loadWorkflowAdjustmentHistory, type WorkflowAdjustmentHistory, type WorkflowAdjustmentHistoryCache } from "../workflowAdjustmentHistory";
import { canvasDraftValue, clearWorkflowAdjustmentOperation, loadWorkflowAdjustmentDraft, loadWorkflowAdjustmentOperation,
  newWorkflowAdjustmentDraft, sameWorkflowVersion, saveWorkflowAdjustmentDraft, saveWorkflowAdjustmentOperation,
  workflowDraftRecommendationSnapshot, type WorkflowAdjustmentDraft, type WorkflowAdjustmentPendingOperation } from "../workflowAdjustmentDraft";
import { ExplainerRecommendationSettings, RecommendationProvider } from "./RecommendationContext";
import { WorkflowCanvasEditor } from "./WorkflowCanvasEditor";
import { CanvasTextDraftContext } from "./workflow-canvas/CanvasTextDraftContext";
import { WorkflowAdjustmentRecords, adjustmentStatusLabel, type AdjustmentRecordFilters } from "./WorkflowAdjustmentRecords";
import { useExplainerDraftBridge } from "./ProjectExplainerAssistant";
import "./workflow-adjustment-editor.css";

const actionable = (record: WorkflowAdjustmentRecord | WorkflowAdjustmentSummary) => record.status === "pending" || record.status === "needs_resubmission";
const sourceLabel = (record: WorkflowAdjustmentRecord | WorkflowAdjustmentSummary) => record.source.kind === "user" ? "用户" : record.source.kind === "main" ? "Main" : `组协调者 ${record.source.agentId}`;
const reasonText = (error: unknown) => error instanceof Error ? error.message : String(error);
const appliedVersion = (record: WorkflowAdjustmentRecord | WorkflowAdjustmentSummary) => "history" in record ? [...record.history].reverse().find(item => item.appliedVersion)?.appliedVersion : record.appliedVersion;
function resultNotice(record: WorkflowAdjustmentRecord | WorkflowAdjustmentSummary) {
  return record.status === "pending" ? "已提交，等待安全时机应用" : record.status === "applied" ? `已应用，实际接受版本 r${appliedVersion(record)?.revision ?? record.currentVersion.revision}`
    : `${adjustmentStatusLabel[record.status]}${record.waitingReason ? `：${record.waitingReason}` : ""}`;
}
function differences(before: unknown, after: unknown, path: string[] = []): Array<{ path: string[]; before: unknown; after: unknown }> {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
  if (record(before) && record(after)) return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().flatMap(key => differences(before[key], after[key], [...path, key]));
  return [{ path, before, after }];
}
type Preview = { kind: "record"; requestId: string; record: WorkflowAdjustmentRecord; journalVersion: string; view: "base" | "proposal" }
  | { kind: "current"; current: WorkflowAdjustmentContext["current"] };

export function WorkflowAdjustmentEditor({ project, eventRevision, gateways, harnesses, skills, mcpDirectory, onAddSkill, onClose }: {
  project: Project; gateways: GatewayRecord[]; harnesses: HarnessCatalogEntry[]; skills: SkillDefinition[]; mcpDirectory: FixedMcpDefinition[];
  eventRevision?: number;
  onAddSkill?: (title: string, content: string) => Promise<SkillDefinition>; onClose(): void;
}) {
  const [initial] = useState(() => {
    try { return { draft: loadWorkflowAdjustmentDraft(localStorage, project.id), operation: loadWorkflowAdjustmentOperation(localStorage, project.id), error: "" }; }
    catch (error) { return { draft: { kind: "empty" as const }, operation: { kind: "empty" as const }, error: reasonText(error) }; }
  });
  const [draft, setDraft] = useState<WorkflowAdjustmentDraft | undefined>(initial.draft.kind === "found" ? initial.draft.value : undefined);
  const draftRef = useRef<WorkflowAdjustmentDraft | undefined>(draft);
  const invalidDraft = useRef(initial.draft.kind === "invalid");
  const invalidOperation = initial.operation.kind === "invalid";
  const [pending, setPending] = useState(initial.operation.kind === "found" ? initial.operation.value : undefined);
  const pendingRef = useRef(pending);
  const [context, setContext] = useState<WorkflowAdjustmentHistory>();
  const contextRef = useRef(context);
  const readCache = useRef<WorkflowAdjustmentHistoryCache>({ firstPage: {} });
  const visibleCount = useRef(25);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState<string>();
  const detailLoadingRef = useRef<string>();
  const detailController = useRef<AbortController>();
  const detailRefreshController = useRef<AbortController>();
  const [historyError, setHistoryError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [error, setError] = useState(initial.draft.kind === "invalid" ? initial.draft.message : initial.operation.kind === "invalid" ? initial.operation.message : "");
  const [storageError, setStorageError] = useState(initial.error);
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [panel, setPanel] = useState<"config" | "records">("config");
  const [recordFilters, setRecordFilters] = useState<AdjustmentRecordFilters>({ query: "", source: "all", status: "all" });
  const [preview, setPreview] = useState<Preview>();
  const previewRef = useRef(preview); previewRef.current = preview;
  const [replaceId, setReplaceId] = useState<string>();
  const [withdrawId, setWithdrawId] = useState<string>();
  const [withdrawNote, setWithdrawNote] = useState("");
  const controller = useRef<AbortController>();
  const refreshInFlight = useRef<Promise<void>>();
  const refreshQueued = useRef(false);
  const mounted = useRef(true);
  const persist = useCallback((next: WorkflowAdjustmentDraft) => {
    draftRef.current = next; setDraft(next);
    try { saveWorkflowAdjustmentDraft(localStorage, next); setStorageError(""); }
    catch (reason) { setStorageError(`草稿保留在当前窗口，本地保存失败：${reasonText(reason)}`); }
  }, []);
  const edit = useCallback((change: (current: WorkflowAdjustmentDraft) => WorkflowAdjustmentDraft) => {
    if (draftRef.current) persist(change(draftRef.current));
  }, [persist]);
  const clearPending = useCallback((operation: WorkflowAdjustmentPendingOperation) => {
    try {
      clearWorkflowAdjustmentOperation(localStorage, project.id, operation);
      pendingRef.current = undefined; if (mounted.current) setPending(undefined);
    } catch (reason) { if (mounted.current) setStorageError(`操作结果已返回，本地确认记录清理失败：${reasonText(reason)}`); }
  }, [project.id]);
  const refreshPreview = useCallback(async (prior: Extract<Preview, { kind: "record" }>, journalVersion: string) => {
    if (detailLoadingRef.current || detailRefreshController.current && !detailRefreshController.current.signal.aborted) return;
    const request = new AbortController(); detailRefreshController.current = request;
    try {
      const detail = await getWorkflowAdjustmentDetail(project.id, prior.requestId, journalVersion, request.signal);
      if (!mounted.current || request.signal.aborted || contextRef.current?.journalVersion !== detail.journalVersion ||
        previewRef.current?.kind !== "record" || previewRef.current.requestId !== prior.requestId) return;
      setPreview(current => current?.kind === "record" && current.requestId === detail.record.requestId
        ? { ...current, record: detail.record, journalVersion: detail.journalVersion } : current);
      setDetailError("");
    } catch (reason) {
      if (mounted.current && !request.signal.aborted && previewRef.current?.kind === "record" && previewRef.current.requestId === prior.requestId)
        setDetailError(`完整记录查询失败，原草稿和预览保留：${reasonText(reason)}`);
    } finally { if (detailRefreshController.current === request) detailRefreshController.current = undefined; }
  }, [project.id]);
  const refresh = useCallback((): Promise<void> => {
    if (!mounted.current) return Promise.resolve();
    if (refreshInFlight.current) { refreshQueued.current = true; return refreshInFlight.current; }
    const request = new AbortController(); controller.current = request; setHistoryLoading(true);
    let timedOut = false;
    const timeout = window.setTimeout(() => { timedOut = true; request.abort(); }, 30_000);
    const read = (async () => { try {
      const operationAtStart = pendingRef.current;
      const watched = operationAtStart?.kind === "submit" ? operationAtStart.input.requestId : operationAtStart?.requestId;
      const next = await loadWorkflowAdjustmentHistory(project.id, visibleCount.current, readCache.current, request.signal, watched);
      const priorPreview = previewRef.current;
      if (!mounted.current || request.signal.aborted) return;
      contextRef.current = next; setContext(next);
      setHistoryError("");
      if (priorPreview?.kind === "record" && priorPreview.journalVersion !== next.journalVersion) void refreshPreview(priorPreview, next.journalVersion);
      if (!draftRef.current && !invalidDraft.current) persist(newWorkflowAdjustmentDraft(project.id, next.current));
      const operation = pendingRef.current;
      if (operation) {
        const id = operation.kind === "submit" ? operation.input.requestId : operation.requestId;
        const found = next.operationRecord?.requestId === id ? next.operationRecord : next.records.find(record => record.requestId === id);
        if (found && (operation.kind === "submit" || !actionable(found))) {
          clearPending(operation);
          setError("");
          setNotice(operation.kind === "withdraw" && found.status === "applied" ? `该请求已应用到 r${appliedVersion(found)?.revision ?? found.currentVersion.revision}，未撤回` : resultNotice(found));
        }
      }
    } catch (reason) {
      if (mounted.current && (!request.signal.aborted || timedOut)) setHistoryError(`修改记录查询失败，保留最近已确认内容：${timedOut ? "读取超时，请刷新重试" : reasonText(reason)}`);
    } finally {
      window.clearTimeout(timeout);
      if (controller.current === request) {
        refreshInFlight.current = undefined;
        if (mounted.current) {
          setLoading(false); setHistoryLoading(false);
          if (refreshQueued.current) { refreshQueued.current = false; void refresh(); }
        }
      }
    } })();
    refreshInFlight.current = read;
    return read;
  }, [project.id, persist, clearPending, refreshPreview]);
  useEffect(() => {
    mounted.current = true; void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState !== "hidden") void refresh(); }, 5_000);
    const wake = () => void refresh(); window.addEventListener("focus", wake); window.addEventListener("online", wake);
    const adjusted = (event: Event) => { if ((event as CustomEvent).detail?.projectId === project.id) void refresh(); };
    window.addEventListener("openfars:workflow-adjusted", adjusted);
    return () => { mounted.current = false; controller.current?.abort(); refreshInFlight.current = undefined; refreshQueued.current = false;
      detailController.current?.abort(); detailRefreshController.current?.abort(); window.clearInterval(timer); window.removeEventListener("focus", wake); window.removeEventListener("online", wake);
      window.removeEventListener("openfars:workflow-adjusted", adjusted); };
  }, [refresh]);
  useEffect(() => { const timer = window.setTimeout(() => void refresh(), 200); return () => window.clearTimeout(timer); }, [eventRevision, refresh]);
  const close = () => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); onClose(); };
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const dialogs = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].filter(dialog => !dialog.closest("[hidden]"));
      if (dialogs.length === 1) {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); onClose();
      }
    };
    window.addEventListener("keydown", escape); return () => window.removeEventListener("keydown", escape);
  }, [onClose]);
  const leavePreview = () => { detailRefreshController.current?.abort(); setPreview(undefined); setDetailError(""); };

  const send = async (operation: WorkflowAdjustmentPendingOperation) => {
    if (busyRef.current) return;
    try { saveWorkflowAdjustmentOperation(localStorage, project.id, operation); }
    catch (reason) { setError(reasonText(reason)); return; }
    pendingRef.current = operation; setPending(operation); busyRef.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const result = operation.kind === "submit" ? await submitWorkflowAdjustment(project.id, operation.input)
        : await withdrawWorkflowAdjustment(project.id, operation.requestId, operation.input);
      clearPending(operation);
      if (mounted.current) {
        setNotice(operation.kind === "withdraw" && "withdrawn" in result && !result.withdrawn
          ? `未撤回：${resultNotice(result.record)}` : resultNotice(result.record));
        setWithdrawId(undefined); setReplaceId(undefined); await refresh();
      }
    } catch (reason) {
      const rejected = reason instanceof ApiError && reason.status >= 400 && reason.status < 500 && reason.status !== 408;
      if (rejected) clearPending(operation);
      if (mounted.current) {
        setError(rejected ? reasonText(reason) : `操作结果待确认。草稿和原操作身份已保留，请查询记录或重试原操作：${reasonText(reason)}`);
        setReplaceId(undefined); void refresh();
      }
    } finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  };
  const submit = (confirmedReplaceId?: string) => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    const currentDraft = draftRef.current, latest = contextRef.current;
    if (!currentDraft || !latest || pendingRef.current || invalidOperation || busyRef.current) return;
    if (!sameWorkflowVersion(currentDraft.base, latest.current.version)) { setError("配置已发生修改，请基于最新版本核对后重新提交；原草稿已保留。"); return; }
    if (Object.values(currentDraft.textDrafts).some(field => canvasDraftValue(currentDraft.snapshot, field.path) !== field.value)) {
      setError("请先完成当前字段或共享 Agent 的修改确认，再提交完整草稿。"); return;
    }
    const prior = latest.userRequest ?? undefined;
    if (prior && confirmedReplaceId !== prior.requestId) { setReplaceId(prior.requestId); return; }
    if (confirmedReplaceId && prior?.requestId !== confirmedReplaceId) { setReplaceId(undefined); setError("待应用记录已变化，请重新核对后提交。"); return; }
    void send({ kind: "submit", input: { requestId: crypto.randomUUID(), base: structuredClone(currentDraft.base), proposal: structuredClone(currentDraft.snapshot),
      explanation: currentDraft.explanation, ...(prior ? { replacesRequestId: prior.requestId } : {}) } });
  };
  const freshDraft = () => {
    if (!context || !window.confirm("将使用当前正式配置新建草稿，替换本项目已有本地草稿；正式请求保持原状态。是否继续？")) return;
    invalidDraft.current = false; persist(newWorkflowAdjustmentDraft(project.id, context.current)); leavePreview(); setError("");
  };
  const editOwn = (record: WorkflowAdjustmentRecord) => {
    if (!window.confirm("将此请求的完整提案载入本地草稿，替换当前本地编辑；原请求仍可在安全边界应用。是否继续？")) return;
    persist({ schemaVersion: 1, projectId: project.id, base: structuredClone(record.base), baseSnapshot: structuredClone(record.baseSnapshot),
      snapshot: structuredClone(record.proposal), explanation: record.explanation, textDrafts: {} });
    setPreview(undefined); setPanel("config");
  };
  const openRecord = async (requestId: string, intent: "preview" | "edit" = "preview") => {
    const latest = contextRef.current; if (!latest) return;
    detailController.current?.abort(); detailRefreshController.current?.abort();
    const request = new AbortController(); detailController.current = request; detailLoadingRef.current = requestId; setDetailLoading(requestId);
    try {
      const detail = await getWorkflowAdjustmentDetail(project.id, requestId, latest.journalVersion, request.signal);
      if (!mounted.current || request.signal.aborted) return;
      if (contextRef.current?.journalVersion !== detail.journalVersion) throw new Error("记录在读取期间已有更新，请刷新后重新打开");
      setDetailError("");
      if (intent === "edit") editOwn(detail.record);
      else setPreview({ kind: "record", requestId, record: detail.record, journalVersion: detail.journalVersion, view: "proposal" });
    } catch (reason) { if (mounted.current && !request.signal.aborted) setDetailError(`完整记录查询失败，原草稿和预览保留：${reasonText(reason)}`); }
    finally { if (detailController.current === request) { detailLoadingRef.current = undefined; if (mounted.current) setDetailLoading(undefined); } }
  };
  const stale = !!draft && !!context && !sameWorkflowVersion(draft.base, context.current.version);
  const terminal = ["completed", "cancelled", "archived", "archiving", "cancelling"].includes(project.status);
  const selected = preview?.kind === "record" ? preview.record : undefined;
  const previewSnapshot = preview?.kind === "current" ? preview.current.snapshot : selected ? preview?.kind === "record" && preview.view === "base" ? selected.baseSnapshot : selected.proposal : undefined;
  const previewChanges = preview?.kind === "current" && draft ? differences(preview.current.snapshot, workflowDraftRecommendationSnapshot(draft)) : selected?.changes;
  const recommendation = useMemo(() => draft ? workflowDraftRecommendationSnapshot(draft) : undefined, [draft]);
  const textPersistence = useMemo(() => ({ drafts: draft?.textDrafts ?? {},
    update: (path: string[], value: string) => edit(current => ({ ...current, textDrafts: { ...current.textDrafts, [JSON.stringify(path)]: { path, value } } })),
    remove: (key: string) => edit(current => { const textDrafts = { ...current.textDrafts }; delete textDrafts[key]; return { ...current, textDrafts }; })
  }), [draft?.textDrafts, edit]);
  const harnessConstraint = (id: string) => context?.constraints?.agentHarnesses[id];
  useExplainerDraftBridge({ active: !!draft && !preview && !terminal && !loading, key: project.id, projectId: project.id, base: draft?.base,
    draft: { title: project.title, requirement: project.requirement, agents: recommendation?.agents ?? project.agents,
      orchestration: recommendation?.orchestration ?? project.orchestration, git: { enabled: project.git?.enabled === true },
      skillDefinitions: draft?.snapshot.skillDefinitions ?? {}, mcpDefinitions: draft?.snapshot.mcpDefinitions ?? {} },
    apply: (next, _taskId, base) => { if (!draftRef.current || !next.orchestration) return;
      const official = contextRef.current?.current;
      const reviewedBase = base && official && sameWorkflowVersion(base, official.version) ? { base, baseSnapshot: structuredClone(official.snapshot) } : {};
      persist({ ...draftRef.current, ...reviewedBase, snapshot: { agents: structuredClone(next.agents), orchestration: structuredClone(next.orchestration),
        skillDefinitions: structuredClone(next.skillDefinitions ?? {}), mcpDefinitions: structuredClone(next.mcpDefinitions ?? {}) }, textDrafts: {} });
    }
  });
  const tabs = <div className="adjustment-panel-tabs" role="tablist" aria-label="Workflow 右侧面板">
    <button type="button" role="tab" aria-selected={panel === "config"} onClick={() => setPanel("config")}>配置</button>
    <button type="button" role="tab" aria-selected={panel === "records"} onClick={() => setPanel("records")}>修改记录{context ? `（${context.total}）` : ""}</button>
  </div>;
  const visibleRecords = context?.userRequest && !context.records.some(record => record.requestId === context.userRequest!.requestId)
    ? [context.userRequest, ...context.records] : context?.records ?? [];
  const records = <WorkflowAdjustmentRecords records={visibleRecords} total={context?.total ?? 0} loadedCount={context?.records.length ?? 0}
    currentRevision={context?.current.version.revision} loading={loading} refreshing={historyLoading} hasMore={context?.nextBefore !== undefined}
    filters={recordFilters} onFiltersChange={setRecordFilters} selected={selected} changes={previewSnapshot ? previewChanges : undefined}
    comparingCurrent={preview?.kind === "current"} loadingRequestId={detailLoading} onRefresh={() => void refresh()}
    onLoadMore={() => { visibleCount.current = Math.max(visibleCount.current, context?.records.length ?? 0) + 25; void refresh(); }}
    renderActions={record => <>
      <button type="button" aria-label={`查看提案 ${record.requestId}`} aria-pressed={selected?.requestId === record.requestId}
        disabled={detailLoading === record.requestId} onClick={() => void openRecord(record.requestId)}>{detailLoading === record.requestId ? "正在读取…" : "查看修改"}</button>
      {actionable(record) && <>
        {record.source.kind === "user" && <button type="button" aria-label="继续修改自己的请求" disabled={busy || detailLoading === record.requestId} onClick={() => void openRecord(record.requestId, "edit")}>继续修改</button>}
        <button type="button" className="adjustment-record-withdraw" aria-label={`撤回提案 ${record.requestId}`} disabled={busy || !!pending || invalidOperation || terminal}
          onClick={() => { setWithdrawId(record.requestId); setWithdrawNote(""); }}>撤回</button>
      </>}
      {withdrawId === record.requestId && actionable(record) && <div className="adjustment-confirm">
        <label>撤回说明（选填）<textarea aria-label="撤回说明" maxLength={20_000} value={withdrawNote} onChange={event => setWithdrawNote(event.target.value)} /></label>
        <p>只撤回此请求；实际结果由正式状态决定。</p>
        <button type="button" disabled={busy || !!pending} onClick={() => void send({ kind: "withdraw", requestId: record.requestId,
          input: { operationId: crypto.randomUUID(), ...(withdrawNote ? { note: withdrawNote } : {}) } })}>确认撤回</button>
        <button type="button" onClick={() => setWithdrawId(undefined)}>取消撤回</button>
      </div>}
    </>} />;
  const sharedCanvas = { skills, onAddSkill, mcpDirectory, gateways, harnesses, gitEnabled: project.git?.enabled === true,
    workflowName: project.title, inspectorTabs: tabs, inspectorContent: panel === "records" ? records : undefined, agentHarnessConstraint: harnessConstraint };

  return <div className={`workflow-canvas-dialog workflow-adjustment-dialog${panel === "records" ? " showing-records" : ""}`} role="dialog" aria-modal="true" aria-label="查看与调整当前 Workflow">
    <div className="workflow-canvas-dialog-backdrop" aria-hidden="true" />
    <div className="workflow-canvas-dialog-panel">
      <div className="workflow-canvas-dialog-head"><div><strong>查看与调整当前 Workflow</strong><small>编辑草稿后提交，等待相关任务的安全边界应用。</small></div><button type="button" aria-label="关闭 Workflow 调整" onClick={close}><X size={17} /></button></div>
      <div className="adjustment-status">
        {draft && <span>草稿基础 r{draft.base.revision}</span>}{context && <span>当前正式 r{context!.current.version.revision}</span>}
        <button type="button" aria-busy={historyLoading} onClick={() => void refresh()}>刷新正式配置</button>
        <button type="button" disabled={!context} onClick={() => context && setPreview({ kind: "current", current: structuredClone(context.current) })}>查看当前正式版本</button>
        <button type="button" disabled={!context || busy} onClick={freshDraft}>使用正式配置新建草稿</button>
        {preview && <button type="button" onClick={leavePreview}>返回我的草稿</button>}
        {preview?.kind === "record" && selected && <><strong>只读提案 · {sourceLabel(selected)} · 基础 r{selected.base.revision} · {adjustmentStatusLabel[selected.status]}</strong>
          <button type="button" onClick={() => setPreview({ ...preview, view: preview.view === "base" ? "proposal" : "base" })}>{preview.view === "base" ? "查看修改后" : "查看原基础"}</button></>}
        {preview?.kind === "current" && <><strong>只读正式版本 r{preview.current.version.revision}</strong>
          <button type="button" disabled={!draft || !context || !sameWorkflowVersion(preview.current.version, context.current.version) || !!pending || busy}
            onClick={() => { if (!draftRef.current || !window.confirm("已核对正式版本及完整差异。保留当前完整草稿，以此正式版本为基础继续；不会自动合并内容。是否确认？")) return;
              persist({ ...draftRef.current, base: structuredClone(preview.current.version), baseSnapshot: structuredClone(preview.current.snapshot) }); leavePreview(); setError(""); }}>已核对，更新草稿基础</button></>}
        {preview?.kind === "current" && context && !sameWorkflowVersion(preview.current.version, context.current.version) && <p role="status">正式配置已更新，当前预览仍为 r{preview.current.version.revision}。请重新查看最新正式版本后核对。</p>}
        {preview?.kind === "record" && context && preview.journalVersion !== context.journalVersion && <p role="status">修改记录已有更新，当前预览保留最近一次完整读取的内容。</p>}
        {stale && <p role="status">正式配置已变化。原草稿及基础版本已保留，请查看当前正式版本与完整差异，核对后再提交。</p>}
        {terminal && <p>项目已进入结束状态，配置为只读；草稿与历史记录保留。</p>}
        {storageError && <p role="alert">{storageError}</p>}{error && <p role="alert">{error}</p>}
        {historyError && <p role="alert">{historyError}</p>}{detailError && <p role="alert">{detailError}</p>}{notice && <p role="status">{notice}</p>}
        {pending && (busy ? <p role="status">{pending.kind === "submit" ? "正在提交完整修改…" : "正在撤回提案…"}</p>
          : <p role="status">操作结果待确认，原身份与完整内容已保留。<button type="button" onClick={() => void refresh()}>查询确认</button><button type="button" onClick={() => void send(pending)}>重试原操作</button></p>)}
      </div>
      {draft && recommendation ? <RecommendationProvider input={{ projectId: project.id, title: project.title, requirement: project.requirement,
        agents: recommendation.agents, orchestration: recommendation.orchestration, git: { enabled: project.git?.enabled === true } }}
        gateways={gateways} harnesses={harnesses} disabled={!!preview || terminal}>
        <details className="adjustment-recommendation"><summary>工具推荐设置</summary><ExplainerRecommendationSettings /></details>
        <div className="workflow-canvas-dialog-scroll">
          <div className="adjustment-canvas" hidden={!!preview}>
            <CanvasTextDraftContext.Provider value={textPersistence}>
              <WorkflowCanvasEditor {...sharedCanvas} orchestration={draft.snapshot.orchestration} agents={draft.snapshot.agents} readOnly={terminal || !!preview}
                onOrchestrationChange={orchestration => edit(current => ({ ...current, snapshot: { ...current.snapshot, orchestration } }))}
                onAgentsChange={agents => edit(current => ({ ...current, snapshot: { ...current.snapshot, agents } }))} />
            </CanvasTextDraftContext.Provider>
          </div>
          {previewSnapshot && <div className="adjustment-canvas"><WorkflowCanvasEditor {...sharedCanvas} orchestration={previewSnapshot.orchestration}
            agents={previewSnapshot.agents} readOnly onOrchestrationChange={() => {}} onAgentsChange={() => {}} /></div>}
        </div>
        {!preview && <div className="adjustment-submit"><label>修改说明（公开，选填）<textarea aria-label="修改说明" maxLength={20_000} value={draft.explanation} disabled={terminal} onChange={event => edit(current => ({ ...current, explanation: event.target.value }))} /></label>
          <button type="button" className="adjustment-submit-primary" title={stale ? "正式配置已变化，请先核对当前正式版本" : undefined}
            disabled={busy || !!pending || invalidOperation || !context || terminal || stale} onClick={() => submit()}>提交完整修改</button>
          {replaceId && <div className="adjustment-confirm"><p>已有一条待应用修改，本次提交将覆盖它。旧请求内容及替换历史会保留。</p><code>{replaceId}</code>
            <button type="button" disabled={busy || !!pending} onClick={() => submit(replaceId)}>确认覆盖并提交</button><button type="button" onClick={() => setReplaceId(undefined)}>取消覆盖</button></div>}
        </div>}
      </RecommendationProvider> : <p className="adjustment-empty">{loading ? "正在读取当前正式配置…" : "草稿尚未建立。请核对上方说明，使用当前正式配置新建草稿。"}</p>}
    </div>
  </div>;
}
