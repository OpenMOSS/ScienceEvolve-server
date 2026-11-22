import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ChevronDown, Eye, FilePlus2, GitBranch, History, Send, Settings2, X } from "lucide-react";
import { Button } from "./Common";
import { ApiError, getWorkflowAdjustmentDetail, submitWorkflowAdjustment, withdrawWorkflowAdjustment } from "../api";
import type { FixedMcpDefinition, GatewayRecord, HarnessCatalogEntry, Project, SkillDefinition } from "../types";
import type { WorkflowAdjustmentContext, WorkflowAdjustmentRecord, WorkflowAdjustmentSnapshot, WorkflowAdjustmentSummary } from "../workflowAdjustments";
import { loadWorkflowAdjustmentHistory, type WorkflowAdjustmentHistory, type WorkflowAdjustmentHistoryCache } from "../workflowAdjustmentHistory";
import { canvasDraftValue, clearWorkflowAdjustmentOperation, loadWorkflowAdjustmentDraft, loadWorkflowAdjustmentOperation,
  newWorkflowAdjustmentDraft, sameWorkflowVersion, saveWorkflowAdjustmentDraft, saveWorkflowAdjustmentOperation,
  workflowDraftRecommendationSnapshot, type WorkflowAdjustmentDraft, type WorkflowAdjustmentPendingOperation } from "../workflowAdjustmentDraft";
import { ExplainerRecommendationSettings, RecommendationProvider } from "./RecommendationContext";
import { WorkflowCanvasEditor } from "./WorkflowCanvasEditor";
import { SearchTreeDialog } from "./SearchTreeDialog";
import { CanvasTextDraftContext } from "./workflow-canvas/CanvasTextDraftContext";
import { normalizeCanvasLayout } from "./workflow-canvas/core/canvas-layout";
import { defaultScopedCanvas } from "./workflow-canvas/core/scoped-workflow";
import type { WorkflowCanvasLayout } from "../types";
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

function withoutDraftViewportChanges(draft: WorkflowAdjustmentDraft): WorkflowAdjustmentDraft {
  const base = draft.baseSnapshot.orchestration;
  const next = structuredClone(draft.snapshot.orchestration);
  const restoreViewport = (canvas: WorkflowCanvasLayout, original: WorkflowCanvasLayout | undefined, baseline: WorkflowCanvasLayout) => {
    const restored = { ...canvas, viewport: original?.viewport ?? baseline.viewport };
    return !differences(restored, baseline).length ? original : restored;
  };
  if (next.canvas) next.canvas = restoreViewport(next.canvas, base.canvas, normalizeCanvasLayout(base.canvas, base));
  for (const group of next.scopedWorkflow?.groups ?? []) {
    const original = base.scopedWorkflow?.groups.find(item => item.id === group.id)?.workflow;
    if (!original || !group.workflow.canvas) continue;
    const baseline = original.canvas ?? defaultScopedCanvas(original.nodes.map(node => node.nodeId), original.input.edges.map(edge => edge.target));
    group.workflow.canvas = restoreViewport(group.workflow.canvas, original.canvas, baseline);
  }
  return { ...draft, snapshot: { ...draft.snapshot, orchestration: next } };
}

function mergeLatest(
  draft: WorkflowAdjustmentDraft,
  current: WorkflowAdjustmentContext["current"],
  resolution?: "local" | "official"
): WorkflowAdjustmentDraft | undefined {
  const conflicts = new Set<string>();
  const conflictParents = new Set<string>();
  const equal = (left: unknown, right: unknown) => !differences(left, right).length;
  const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
  const merge = (base: unknown, local: unknown, latest: unknown, path: string[], applying = false): unknown => {
    const key = JSON.stringify(path);
    if (applying && conflicts.has(key)) return resolution === "official" ? latest : local;
    if (!applying || !conflictParents.has(key)) {
      if (equal(local, base)) return latest;
      if (equal(latest, base) || equal(local, latest)) return local;
    }
    if (record(base) && record(local) && record(latest)) {
      return Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(latest)])]
        .flatMap(key => {
          const value = merge(base[key], local[key], latest[key], [...path, key], applying);
          return value === undefined ? [] : [[key, value]];
        }));
    }
    if (!applying) {
      conflicts.add(key);
      path.forEach((_, index) => conflictParents.add(JSON.stringify(path.slice(0, index))));
    }
    return latest;
  };
  merge(draft.baseSnapshot, workflowDraftRecommendationSnapshot(draft), current.snapshot, []);
  if (conflicts.size && !resolution) return undefined;
  const snapshot = merge(draft.baseSnapshot, draft.snapshot, current.snapshot, [], true) as WorkflowAdjustmentSnapshot;
  const textDrafts = resolution === "official" ? Object.fromEntries(Object.entries(draft.textDrafts).filter(([, field]) =>
    !field.path.some((_, index) => conflicts.has(JSON.stringify(field.path.slice(0, index + 1)))))) : draft.textDrafts;
  return { ...draft, base: structuredClone(current.version), baseSnapshot: structuredClone(current.snapshot),
    snapshot: structuredClone(snapshot), textDrafts };
}
type Preview = { kind: "record"; requestId: string; record: WorkflowAdjustmentRecord; journalVersion: string; view: "base" | "proposal" }
  | { kind: "current"; current: WorkflowAdjustmentContext["current"] };

export function WorkflowAdjustmentEditor({ project, eventRevision, gateways, harnesses, skills, mcpDirectory, onAddSkill, onWorkflowApplied, onClose }: {
  project: Project; gateways: GatewayRecord[]; harnesses: HarnessCatalogEntry[]; skills: SkillDefinition[]; mcpDirectory: FixedMcpDefinition[];
  eventRevision?: number;
  onAddSkill?: (title: string, content: string) => Promise<SkillDefinition>; onWorkflowApplied?: () => void; onClose(): void;
}) {
  const [initial] = useState(() => {
    try {
      const stored = loadWorkflowAdjustmentDraft(localStorage, project.id);
      const draft = stored.kind === "found" ? { ...stored, value: withoutDraftViewportChanges(stored.value) } : stored;
      return { draft, operation: loadWorkflowAdjustmentOperation(localStorage, project.id), error: "" };
    }
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
  const [searchTreeOpen, setSearchTreeOpen] = useState(false);
  const [recordFilters, setRecordFilters] = useState<AdjustmentRecordFilters>({ query: "", source: "all", status: "all" });
  const [preview, setPreview] = useState<Preview>();
  const recommendationDetails = useRef<HTMLDetailsElement>(null);
  const versionMenu = useRef<HTMLDetailsElement>(null);
  const previewRef = useRef(preview); previewRef.current = preview;
  const [submitDialog, setSubmitDialog] = useState<{ replaceId?: string }>();
  const submitTrigger = useRef<HTMLButtonElement>(null);
  const [withdrawId, setWithdrawId] = useState<string>();
  const [withdrawNote, setWithdrawNote] = useState("");
  const controller = useRef<AbortController>();
  const refreshInFlight = useRef<Promise<void>>();
  const refreshQueued = useRef(false);
  const mounted = useRef(true);
  const observedEventRevision = useRef(eventRevision);
  const persist = useCallback((next: WorkflowAdjustmentDraft) => {
    draftRef.current = next; setDraft(next);
    try { saveWorkflowAdjustmentDraft(localStorage, next); setStorageError(""); }
    catch (reason) { setStorageError(`草稿保留在当前窗口，本地保存失败：${reasonText(reason)}`); }
  }, []);
  const edit = useCallback((change: (current: WorkflowAdjustmentDraft) => WorkflowAdjustmentDraft) => {
    if (draftRef.current) persist({ ...change(draftRef.current), updatedAt: new Date().toISOString() });
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
      const local = draftRef.current;
      if (!local && !invalidDraft.current) {
        persist(newWorkflowAdjustmentDraft(project.id, next.current));
      } else if (local && !pendingRef.current && !sameWorkflowVersion(local.base, next.current.version) &&
        differences(local.baseSnapshot, next.current.snapshot).length) {
        const updated = mergeLatest(local, next.current);
        if (updated) persist(updated);
      }
      const operation = pendingRef.current;
      if (operation) {
        const id = operation.kind === "submit" ? operation.input.requestId : operation.requestId;
        const found = next.operationRecord?.requestId === id ? next.operationRecord : next.records.find(record => record.requestId === id);
        if (found && (operation.kind === "submit" || !actionable(found))) {
          clearPending(operation);
          if (found.status === "applied") onWorkflowApplied?.();
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
  }, [project.id, persist, clearPending, refreshPreview, onWorkflowApplied]);
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
  useEffect(() => {
    if (observedEventRevision.current === eventRevision) return;
    observedEventRevision.current = eventRevision;
    const timer = window.setTimeout(() => void refresh(), 200);
    return () => window.clearTimeout(timer);
  }, [eventRevision, refresh]);
  const close = () => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); onClose(); };
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (recommendationDetails.current?.open) {
        recommendationDetails.current.open = false;
        recommendationDetails.current.querySelector("summary")?.focus();
        event.preventDefault(); return;
      }
      const dialogs = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].filter(dialog => !dialog.closest("[hidden]"));
      if (dialogs.length === 1) {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); onClose();
      }
    };
    const dismissRecommendation = (event: PointerEvent) => {
      const details = recommendationDetails.current;
      if (details?.open && !details.contains(event.target as Node)) details.open = false;
      const versions = versionMenu.current;
      if (versions?.open && !versions.contains(event.target as Node)) versions.open = false;
    };
    window.addEventListener("keydown", escape);
    document.addEventListener("pointerdown", dismissRecommendation);
    return () => { window.removeEventListener("keydown", escape); document.removeEventListener("pointerdown", dismissRecommendation); };
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
        if (result.record.status === "applied") onWorkflowApplied?.();
        setNotice(operation.kind === "withdraw" && "withdrawn" in result && !result.withdrawn
          ? `未撤回：${resultNotice(result.record)}` : resultNotice(result.record));
        setWithdrawId(undefined); await refresh();
      }
    } catch (reason) {
      const rejected = reason instanceof ApiError && reason.status >= 400 && reason.status < 500 && reason.status !== 408;
      if (rejected) clearPending(operation);
      if (mounted.current) {
        setError(rejected ? reasonText(reason) : `操作结果待确认。草稿和原操作身份已保留，请查询记录或重试原操作：${reasonText(reason)}`);
        void refresh();
      }
    } finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  };
  const submit = (confirmedReplaceId?: string) => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    const currentDraft = draftRef.current, latest = contextRef.current;
    if (!currentDraft || !latest || pendingRef.current || invalidOperation || busyRef.current) return;
    if (!sameWorkflowVersion(currentDraft.base, latest.current.version)) { dismissSubmit(); setError("配置已发生修改，请基于最新版本核对后重新提交；原草稿已保留。"); return; }
    if (Object.values(currentDraft.textDrafts).some(field => canvasDraftValue(currentDraft.snapshot, field.path) !== field.value)) {
      dismissSubmit(); setError("请先完成当前字段或共享 Agent 的修改确认，再提交完整草稿。"); return;
    }
    const prior = latest.userRequest ?? undefined;
    if (prior?.requestId !== confirmedReplaceId) { dismissSubmit(); setError("待应用记录已变化，请重新核对后提交。"); return; }
    setSubmitDialog(undefined);
    void send({ kind: "submit", input: { requestId: crypto.randomUUID(), base: structuredClone(currentDraft.base), proposal: structuredClone(currentDraft.snapshot),
      explanation: currentDraft.explanation, ...(prior ? { replacesRequestId: prior.requestId } : {}) } });
  };
  const freshDraft = () => {
    const latest = contextRef.current;
    if (!latest || pendingRef.current || busyRef.current ||
      !window.confirm("恢复到当前正式版本会丢弃本地草稿中的修改。已提交的记录会保留。是否恢复？")) return;
    invalidDraft.current = false; persist(newWorkflowAdjustmentDraft(project.id, latest.current)); leavePreview(); setPanel("config"); setError("");
  };
  const editOwn = (record: WorkflowAdjustmentRecord) => {
    if (!window.confirm("将此请求的完整提案载入本地草稿，替换当前本地编辑；原请求仍可在安全边界应用。是否继续？")) return;
    persist(withoutDraftViewportChanges({ schemaVersion: 1, projectId: project.id, base: structuredClone(record.base), baseSnapshot: structuredClone(record.baseSnapshot),
      snapshot: structuredClone(record.proposal), explanation: record.explanation, textDrafts: {} }));
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
  const recommendation = useMemo(() => draft ? workflowDraftRecommendationSnapshot(draft) : undefined, [draft]);
  const draftChanged = useMemo(() => !!draft && !!differences(draft.baseSnapshot, recommendation).length, [draft, recommendation]);
  const submitDisabled = busy || !!pending || invalidOperation || !context || terminal || !draftChanged;
  const dismissSubmit = () => {
    setSubmitDialog(undefined);
    window.requestAnimationFrame(() => {
      const trigger = submitTrigger.current;
      if (!trigger?.disabled) trigger?.focus();
      else trigger.closest(".workflow-canvas-dialog-head")?.querySelector<HTMLButtonElement>(".adjustment-close")?.focus();
    });
  };
  const selected = preview?.kind === "record" ? preview.record : undefined;
  const previewSnapshot = preview?.kind === "current" ? preview.current.snapshot : selected ? preview?.kind === "record" && preview.view === "base" ? selected.baseSnapshot : selected.proposal : undefined;
  const previewChanges = preview?.kind === "current" && draft ? differences(preview.current.snapshot, workflowDraftRecommendationSnapshot(draft)) : selected?.changes;
  const formalPreview = preview?.kind === "current" ? preview.current : undefined;
  const draftModifiedAt = draft?.updatedAt ? new Date(draft.updatedAt) : undefined;
  const closeVersionMenu = () => { if (versionMenu.current) versionMenu.current.open = false; };
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
    <button type="button" role="tab" aria-selected={panel === "config"} onClick={() => setPanel("config")}><Settings2 size={14} aria-hidden="true" />配置</button>
    <button type="button" role="tab" aria-selected={panel === "records"} onClick={() => setPanel("records")}><History size={14} aria-hidden="true" />修改记录{context && <span className="adjustment-tab-count">{context.total}</span>}</button>
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
    persistCanvasViewport: false,
    onOpenInspectorConfig: () => setPanel("config"),
    workflowName: project.title, inspectorTabs: tabs, inspectorContent: panel === "records" ? records : undefined, agentHarnessConstraint: harnessConstraint };

  return <div className={`workflow-canvas-dialog workflow-adjustment-dialog${panel === "records" ? " showing-records" : ""}`} role="dialog" aria-modal="true" aria-label="查看与调整当前 Workflow">
    <div className="workflow-canvas-dialog-backdrop" aria-hidden="true" />
    <div className="workflow-canvas-dialog-panel" {...(submitDialog || formalPreview ? { inert: "", "aria-hidden": true } : {})}>
      <div className="workflow-canvas-dialog-head">
        <div className="adjustment-heading">
          <strong title={project.title}>{project.title || "Workflow"}</strong>
          <small className="adjustment-draft-status">
            {draftChanged && draftModifiedAt && Number.isFinite(draftModifiedAt.getTime()) &&
              <time dateTime={draftModifiedAt.toISOString()}>最近修改 {new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(draftModifiedAt)}</time>}
          </small>
        </div>
        <div className="adjustment-header-controls">
          <div className="adjustment-header-actions">
            <button type="button" aria-label="查看项目搜索树" disabled={!project.searchTree}
              title={project.searchTree ? "查看项目当前搜索树与探索记录" : "本项目创建时未启用搜索树，无法查看或在创建后补开"} onClick={() => setSearchTreeOpen(true)}><GitBranch size={14} />{project.searchTree ? "搜索树" : "搜索树 · 未启用"}</button>
            <button type="button" aria-label="版本历史" title="版本历史" aria-pressed={panel === "records"} onClick={() => setPanel(panel === "records" ? "config" : "records")}><History size={15} aria-hidden="true" />历史</button>
            <details className="adjustment-version-menu" ref={versionMenu} onKeyDown={event => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              event.stopPropagation();
              closeVersionMenu();
              versionMenu.current?.querySelector("summary")?.focus();
            }}>
              <summary aria-label="版本操作"><span>{context ? `当前正式 r${context.current.version.revision}` : "正式版本"}</span><ChevronDown size={14} aria-hidden="true" /></summary>
              <div className="adjustment-version-options">
                <button type="button" aria-label="查看当前正式版本" disabled={!context} onClick={() => {
                  if (!context) return;
                  closeVersionMenu(); setPreview({ kind: "current", current: structuredClone(context.current) });
                }}><Eye size={14} aria-hidden="true" />查看正式版本</button>
                <button type="button" disabled={!context || busy || !!pending} onClick={() => { closeVersionMenu(); freshDraft(); }}><FilePlus2 size={14} aria-hidden="true" />恢复到正式版本</button>
              </div>
            </details>
            {draft && !preview && <button ref={submitTrigger} type="button" className="adjustment-submit-trigger"
              aria-haspopup="dialog" disabled={submitDisabled}
              onClick={() => {
                const latest = contextRef.current;
                if (!latest) return;
                if (draftRef.current && !sameWorkflowVersion(draftRef.current.base, latest.current.version)) {
                  setPreview({ kind: "current", current: structuredClone(latest.current) });
                  return;
                }
                setSubmitDialog({ replaceId: latest.userRequest?.requestId });
              }}>
              <Send size={14} aria-hidden="true" />提交修改
            </button>}
          </div>
        </div>
        <button type="button" className="adjustment-close" aria-label="关闭 Workflow 调整" onClick={close}><X size={17} /></button>
      </div>
      <div className="adjustment-status">
        {preview?.kind === "record" && context && preview.journalVersion !== context.journalVersion && <p role="status">修改记录已有更新，当前预览保留最近一次完整读取的内容。</p>}
        {stale && <p role="status">部分内容与最新正式版本有冲突。提交前请选择要保留的内容。</p>}
        {terminal && <p>项目已进入结束状态，配置为只读；草稿与历史记录保留。</p>}
        {storageError && <p role="alert">{storageError}</p>}{error && <p role="alert">{error}</p>}
        {historyError && <p role="alert">{historyError}</p>}{detailError && <p role="alert">{detailError}</p>}{notice && <p role="status">{notice}</p>}
        {pending && (busy ? <p role="status">{pending.kind === "submit" ? "正在提交完整修改…" : "正在撤回提案…"}</p>
          : <p role="status">操作结果待确认，原身份与完整内容已保留。<button type="button" onClick={() => void refresh()}>查询确认</button><button type="button" onClick={() => void send(pending)}>重试原操作</button></p>)}
      </div>
      {draft && recommendation ? <RecommendationProvider input={{ projectId: project.id, title: project.title, requirement: project.requirement,
        agents: recommendation.agents, orchestration: recommendation.orchestration, git: { enabled: project.git?.enabled === true } }}
        gateways={gateways} harnesses={harnesses} disabled={!!preview || terminal}>
        <div className={`adjustment-context-bar${preview ? " is-preview" : ""}`}>
          <div className="adjustment-context-main">
            {preview?.kind === "record" ? <>
              <button type="button" className="adjustment-back-to-draft" onClick={leavePreview}><ArrowLeft size={14} />返回我的草稿</button>
              <span className="adjustment-preview-label"><Eye size={14} />
                <strong>{`只读提案 · ${sourceLabel(preview.record)} · 基础 r${preview.record.base.revision} · ${adjustmentStatusLabel[preview.record.status]}`}</strong>
              </span>
              <div className="adjustment-preview-actions">
                {preview.kind === "record" && <button type="button" onClick={() => setPreview({ ...preview, view: preview.view === "base" ? "proposal" : "base" })}><Eye size={13} />{preview.view === "base" ? "查看修改后" : "查看原基础"}</button>}
              </div>
            </> : null}
          </div>
          <details ref={recommendationDetails} className="adjustment-recommendation">
            <summary><Settings2 size={14} /><span>工具推荐设置</span><ChevronDown size={13} /></summary>
            <div className="adjustment-recommendation-panel">
              <div className="adjustment-recommendation-heading"><strong>工具推荐设置</strong>
                <button type="button" aria-label="关闭工具推荐设置" onClick={() => { if (recommendationDetails.current) recommendationDetails.current.open = false; recommendationDetails.current?.querySelector("summary")?.focus(); }}><X size={15} /></button>
              </div>
              <ExplainerRecommendationSettings />
            </div>
          </details>
        </div>
        <div className="workflow-canvas-dialog-scroll">
          <div className="adjustment-canvas" hidden={!!preview}>
            <CanvasTextDraftContext.Provider value={textPersistence}>
              <WorkflowCanvasEditor {...sharedCanvas} orchestration={draft.snapshot.orchestration} agents={draft.snapshot.agents} readOnly={terminal || !!preview}
                onOrchestrationChange={orchestration => edit(current => ({ ...current, snapshot: { ...current.snapshot, orchestration } }))}
                onAgentsChange={agents => edit(current => ({ ...current, snapshot: { ...current.snapshot, agents } }))} />
            </CanvasTextDraftContext.Provider>
          </div>
          {previewSnapshot && !formalPreview && <div className="adjustment-canvas is-preview"><WorkflowCanvasEditor {...sharedCanvas} orchestration={previewSnapshot.orchestration}
            agents={previewSnapshot.agents} readOnly onOrchestrationChange={() => {}} onAgentsChange={() => {}} /></div>}
        </div>
      </RecommendationProvider> : <p className="adjustment-empty">{loading ? "正在读取当前正式配置…" : "草稿尚未建立。请核对上方说明，使用当前正式配置新建草稿。"}</p>}
    </div>
    {searchTreeOpen && project.searchTree && <SearchTreeDialog key={project.id} projectId={project.id} onClose={() => setSearchTreeOpen(false)} />}
    {formalPreview && <div className="modal-backdrop adjustment-submit-backdrop">
      <section className="adjustment-formal-dialog" role="dialog" aria-modal="true" aria-label="查看正式版本"
        onKeyDown={event => {
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); leavePreview(); }
          if (event.key !== "Tab") return;
          const controls = [...event.currentTarget.querySelectorAll<HTMLElement>("button, summary, select, input, textarea, [tabindex]")]
            .filter(control => !control.matches(":disabled") && control.tabIndex >= 0 && control.getClientRects().length);
          if (document.activeElement === (event.shiftKey ? controls[0] : controls.at(-1))) {
            event.preventDefault();
            (event.shiftKey ? controls.at(-1) : controls[0])?.focus();
          }
        }}>
        <header>
          <h2>只读正式版本 r{formalPreview.version.revision}</h2>
          {stale && context && sameWorkflowVersion(formalPreview.version, context.current.version) && draftChanged &&
            (["local", "official"] as const).map(resolution => <Button key={resolution} type="button" variant="secondary"
              disabled={!!pending || busy} onClick={() => {
                const latest = contextRef.current?.current;
                if (!draftRef.current || !latest || !sameWorkflowVersion(formalPreview.version, latest.version)) return;
                const merged = mergeLatest(draftRef.current, latest, resolution);
                if (merged) persist(merged);
                leavePreview(); setError("");
              }}>{resolution === "local" ? "冲突处保留我的修改" : "冲突处采用正式版本"}</Button>)}
          <button type="button" className="adjustment-close" aria-label="返回我的草稿" autoFocus onClick={leavePreview}><X size={17} aria-hidden="true" /></button>
        </header>
        {context && !sameWorkflowVersion(formalPreview.version, context.current.version) &&
          <div className="adjustment-formal-notice" role="status">正式配置已更新，当前预览仍为 r{formalPreview.version.revision}。
            <Button type="button" variant="secondary" onClick={() => setPreview({ kind: "current", current: structuredClone(context.current) })}>查看最新正式版本</Button>
          </div>}
        <div className="workflow-canvas-dialog-scroll">
          <div className="adjustment-canvas is-preview">
            <WorkflowCanvasEditor {...sharedCanvas} inspectorTabs={undefined} inspectorContent={stale && draftChanged ? records : undefined}
              orchestration={formalPreview.snapshot.orchestration} agents={formalPreview.snapshot.agents} readOnly
              onOrchestrationChange={() => {}} onAgentsChange={() => {}} />
          </div>
        </div>
      </section>
    </div>}
    {submitDialog && draft && !preview && <div className="modal-backdrop adjustment-submit-backdrop"
      onMouseDown={event => { if (event.target === event.currentTarget) dismissSubmit(); }}>
      <form className="confirm-dialog adjustment-submit-dialog" role="dialog" aria-modal="true" aria-label="提交 Workflow 修改"
        onSubmit={event => { event.preventDefault(); if (!submitDisabled) submit(submitDialog.replaceId); }}
        onKeyDown={event => {
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dismissSubmit(); }
          if (event.key !== "Tab") return;
          const fields = [...event.currentTarget.querySelectorAll<HTMLElement>("textarea:not(:disabled), button:not(:disabled)")];
          const from = event.shiftKey ? fields[0] : fields.at(-1);
          if (document.activeElement === from) {
            event.preventDefault();
            (event.shiftKey ? fields.at(-1) : fields[0])?.focus();
          }
        }}>
        <h2>提交 Workflow 修改</h2>
        <label className="adjustment-explanation"><span>修改说明 <small>公开 · 选填</small></span>
          <textarea autoFocus aria-label="修改说明" rows={4} maxLength={20_000} value={draft.explanation}
            onChange={event => edit(current => ({ ...current, explanation: event.target.value }))} />
        </label>
        {submitDialog.replaceId && <p className="adjustment-replace-note" role="status">本次提交将替换待应用的修改，原记录保留在修改历史中。</p>}
        {stale && <p role="alert">正式配置已变化，请返回草稿核对后再提交。</p>}
        <div className="dialog-actions">
          <Button type="button" variant="secondary" onClick={dismissSubmit}>返回草稿</Button>
          <Button type="submit" disabled={submitDisabled}>{submitDialog.replaceId ? "确认覆盖并提交" : "提交完整修改"}</Button>
        </div>
      </form>
    </div>}
  </div>;
}
