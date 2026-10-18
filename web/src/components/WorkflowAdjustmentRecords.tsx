import { useEffect, useId, useRef, type ReactNode } from "react";
import { ArrowRight, CheckCircle2, Clock3, FileDiff, History, RefreshCw, Search } from "lucide-react";
import type { WorkflowAdjustmentRecord, WorkflowAdjustmentSummary, WorkflowAdjustmentStatus } from "../workflowAdjustments";

export const adjustmentStatusLabel: Record<WorkflowAdjustmentStatus, string> = {
  pending: "待应用", needs_resubmission: "需要重新提交", applied: "已应用", withdrawn: "已撤回", replaced: "已替换", failed: "失败"
};
export interface AdjustmentRecordFilters {
  query: string;
  source: "all" | WorkflowAdjustmentSummary["source"]["kind"];
  status: "all" | "actionable" | WorkflowAdjustmentStatus;
}
type Change = { path: string[]; before?: unknown; after?: unknown; kind?: "added" | "removed" | "changed" };
const sourceLabel = (record: WorkflowAdjustmentRecord | WorkflowAdjustmentSummary) => record.source.kind === "user" ? "用户"
  : record.source.kind === "main" ? "Main" : `组协调者 ${record.source.agentId}`;
const isActionable = (record: WorkflowAdjustmentSummary) => record.status === "pending" || record.status === "needs_resubmission";
const timestamp = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
  }).format(date);
};
const displayValue = (value: unknown) => value === undefined ? "未设置" : typeof value === "string" ? value || "（空文本）"
  : typeof value === "boolean" ? value ? "开启" : "关闭" : JSON.stringify(value, null, 2);
const fields: Record<string, string> = {
  instructions: "Agent 指令", model: "模型", harness: "Harness", gatewayId: "网关", skills: "Skills", autoSkills: "自动 Skills",
  mcpServers: "MCP 工具", experimentMcp: "SII 实验工具", permission: "权限", webSearch: "网页搜索", sessionPersistence: "会话持久化",
  decisionBy: "决策者", reasoningEffort: "推理强度", description: "职责说明", template: "角色模板", agents: "Agent 团队",
  input: "输入节点", routes: "路由连线", decisionPlans: "执行决策", collaborations: "协作组", scopedWorkflow: "组内 Workflow",
  allowUserIntervention: "用户干预", allowMainReconfiguration: "Main 运行中修改", termination: "结束条件", resultFormat: "交付要求",
  schemaVersion: "配置格式版本", canvas: "画布布局", condition: "验收条件", automatic: "自动结束", agent: "负责 Agent",
  source: "来源", target: "目标", presets: "交付格式", custom: "自定义要求", none: "无需额外交付"
};
function changeGroup(path: string[]) {
  return path[0] === "agents" ? "Agent 配置" : path[0] === "orchestration" ? "Workflow 编排"
    : path[0] === "skillDefinitions" ? "项目 Skills" : path[0] === "mcpDefinitions" ? "项目 MCP" : "其他设置";
}
function changeLabel(path: string[]) {
  if (!path.length) return "完整配置";
  const rest = path.slice(1);
  if (path[0] === "agents") return [rest[0], ...rest.slice(1).map(part => fields[part] ?? part)].filter(Boolean).join(" · ") || "Agent 配置";
  if (path[0] === "orchestration" && ["routes", "decisionPlans"].includes(rest[0] ?? ""))
    return [fields[rest[0]!], rest[1], ...rest.slice(2).map(part => fields[part] ?? part)].filter(Boolean).join(" · ");
  return rest.map(part => fields[part] ?? part).join(" · ") || changeGroup(path);
}

export function WorkflowAdjustmentRecords({ records, total, loadedCount, currentRevision, loading, refreshing, hasMore,
  filters, onFiltersChange, selected, changes, comparingCurrent, loadingRequestId, onRefresh, onLoadMore, renderActions }: {
  records: WorkflowAdjustmentSummary[]; total: number; loadedCount: number; currentRevision?: number;
  loading: boolean; refreshing: boolean; hasMore: boolean;
  filters: AdjustmentRecordFilters; onFiltersChange(filters: AdjustmentRecordFilters): void;
  selected?: WorkflowAdjustmentRecord; changes?: Change[]; comparingCurrent: boolean; loadingRequestId?: string;
  onRefresh(): void; onLoadMore(): void; renderActions(record: WorkflowAdjustmentSummary): ReactNode;
}) {
  const detailId = useId();
  const recordsHeading = useRef<HTMLHeadingElement>(null);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const listHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    // A newly opened panel starts at its heading instead of inheriting the
    // canvas inspector's scroll position. Polling never moves focus.
    const heading = selected || comparingCurrent ? detailHeading.current : recordsHeading.current;
    if (!heading?.getClientRects().length) return;
    heading.focus({ preventScroll: true });
    heading.scrollIntoView({ block: "nearest" });
  }, [selected?.requestId, comparingCurrent]);
  const query = filters.query.trim().toLocaleLowerCase();
  const filtered = records.filter(record => (filters.source === "all" || record.source.kind === filters.source) &&
    (filters.status === "all" || (filters.status === "actionable" ? isActionable(record) : record.status === filters.status)) &&
    (!query || [record.requestId, `#${record.submissionSequence}`, sourceLabel(record), record.waitingReason ?? "", `r${record.base.revision}`]
      .some(value => value.toLocaleLowerCase().includes(query))));
  const filtering = !!query || filters.source !== "all" || filters.status !== "all";
  const groups = new Map<string, Change[]>();
  for (const change of changes ?? []) {
    const group = changeGroup(change.path);
    const entries = groups.get(group);
    if (entries) entries.push(change); else groups.set(group, [change]);
  }
  const pendingCount = records.filter(isActionable).length;
  const appliedCount = records.filter(record => record.status === "applied").length;
  const acceptedVersion = selected && [...selected.history].reverse().find(item => item.appliedVersion)?.appliedVersion;
  const replacedBy = selected && [...selected.history].reverse().find(item => item.replacedByRequestId)?.replacedByRequestId;

  return <section className="adjustment-records" aria-label="共用修改记录">
    <div className="adjustment-record-heading"><div><h3 ref={recordsHeading} tabIndex={-1}><History size={16} />修改记录</h3><p>以下统计基于已载入的 {records.length} 条记录</p></div>
      <button type="button" aria-busy={refreshing} onClick={onRefresh}><RefreshCw size={13} className={refreshing ? "spin" : undefined} />刷新记录</button></div>
    <div className="adjustment-record-overview" aria-label="已载入记录概况">
      <span><Clock3 size={14} /><strong>{pendingCount}</strong>待处理</span>
      <span><CheckCircle2 size={14} /><strong>{appliedCount}</strong>已应用</span>
      <span>正式版本 <strong>{currentRevision === undefined ? "—" : `r${currentRevision}`}</strong></span>
    </div>

    {(selected || comparingCurrent) && <section className="adjustment-record-detail" id={detailId} aria-label={selected ? "完整请求记录" : "正式版本与草稿比较"}>
      {selected && <section>
        <div className="adjustment-detail-heading"><FileDiff size={17} /><h3 ref={detailHeading} tabIndex={-1}>本次修改详情</h3>
          <span className={`adjustment-status-badge status-${selected.status}`}>{adjustmentStatusLabel[selected.status]}</span></div>
        <button type="button" className="adjustment-browse-records" onClick={() => { listHeading.current?.focus({ preventScroll: true }); listHeading.current?.scrollIntoView({ block: "nearest" }); }}>浏览记录列表</button>
        <p className="adjustment-detail-source"><strong>{sourceLabel(selected)} · {adjustmentStatusLabel[selected.status]}</strong>
          <time dateTime={selected.submittedAt} title={new Date(selected.submittedAt).toString()}>{timestamp(selected.submittedAt)}</time></p>
        <p className="adjustment-detail-versions">基础 r{selected.base.revision}<ArrowRight size={12} />
          {acceptedVersion ? `应用到 r${acceptedVersion.revision}` : selected.status === "applied" ? "已应用" : "尚未应用"}</p>
        <div className="adjustment-detail-explanation"><h4>修改说明</h4>{selected.explanation ? <pre>{selected.explanation}</pre> : <p>提出者未填写修改说明，可查看下方具体差异。</p>}</div>
        {selected.waitingReason && <p className={`adjustment-record-reason status-${selected.status}`}>{selected.waitingReason}</p>}
        <details className="adjustment-request-meta"><summary>请求标识与关联记录</summary><p>请求编号 <code>{selected.requestId}</code></p>
          {selected.replacesRequestId && <p>替换请求 <code>{selected.replacesRequestId}</code></p>}
          {replacedBy && <p>后续请求 <code>{replacedBy}</code></p>}
        </details>
      </section>}
      <section className="adjustment-differences" aria-label="完整修改差异">
        <h3 {...(comparingCurrent ? { ref: detailHeading, tabIndex: -1 } : {})}>{comparingCurrent ? "当前正式版本与完整草稿差异" : "修改内容"}<span>{changes?.length ?? 0} 项</span></h3>
        {[...groups].map(([group, items]) => <section key={group} className="adjustment-change-group"><h4>{group}<span>{items.length}</span></h4>
          {items.map((change, index) => <details className="adjustment-field-change" key={JSON.stringify(change.path)} open={items.length === 1 || index === 0}>
            <summary><span className={`adjustment-change-kind kind-${change.kind ?? (change.before === undefined ? "added" : change.after === undefined ? "removed" : "changed")}`}>
              {change.kind === "added" || change.before === undefined ? "新增" : change.kind === "removed" || change.after === undefined ? "移除" : "调整"}</span><strong>{changeLabel(change.path)}</strong></summary>
            <code className="adjustment-change-path">{change.path.join(" / ") || "完整快照"}</code>
            <div className="adjustment-change-values"><div className="before"><h5>修改前</h5><pre>{displayValue(change.before)}</pre></div><div className="after"><h5>修改后</h5><pre>{displayValue(change.after)}</pre></div></div>
          </details>)}
        </section>)}
        {!changes?.length && <p className="adjustment-record-empty">没有内容差异。</p>}
      </section>
      {selected && <section className="adjustment-transition-section" aria-label="请求状态时间线"><h3>状态时间线</h3>
        <ol className="adjustment-transition-list">{selected.history.map((transition, index) => <li key={index} className={`status-${transition.status}`}>
          <div><strong>{adjustmentStatusLabel[transition.status]}</strong><time dateTime={transition.at} title={new Date(transition.at).toString()}>{timestamp(transition.at)}</time></div>
          {transition.appliedVersion && <p>已应用到 r{transition.appliedVersion.revision}</p>}
          {transition.reason && <p>{transition.reason}</p>}{transition.note && <pre>{transition.note}</pre>}
          {transition.replacedByRequestId && <p>后续请求：<code>{transition.replacedByRequestId}</code></p>}
          {transition.appliedVersion && <details className="adjustment-request-meta"><summary>配置版本标识</summary><code>{transition.appliedVersion.hash}</code></details>}
        </li>)}</ol>
      </section>}
    </section>}

    <div className="adjustment-record-browser">
      <div className="adjustment-record-list-heading"><h3 ref={listHeading} tabIndex={-1}>{selected || comparingCurrent ? "提交记录列表" : "提交记录"}</h3><span>筛选已载入的记录</span></div>
      <div className="adjustment-record-filters">
        <label className="adjustment-record-search"><Search size={14} /><input type="search" aria-label="搜索修改记录" placeholder="搜索提出者、编号或原因"
          value={filters.query} onChange={event => onFiltersChange({ ...filters, query: event.target.value })} /></label>
        <div><select aria-label="按修改来源筛选" value={filters.source} onChange={event => onFiltersChange({ ...filters, source: event.target.value as AdjustmentRecordFilters["source"] })}>
          <option value="all">全部来源</option><option value="user">用户</option><option value="main">Main</option><option value="scoped_leader">组协调者</option>
        </select><select aria-label="按修改状态筛选" value={filters.status} onChange={event => onFiltersChange({ ...filters, status: event.target.value as AdjustmentRecordFilters["status"] })}>
          <option value="all">全部状态</option><option value="actionable">待处理</option>{Object.entries(adjustmentStatusLabel).map(([status, label]) => <option key={status} value={status}>{label}</option>)}
        </select></div>
        {filtering && <p className="adjustment-record-filter-note">匹配 {filtered.length} 条已载入记录<button type="button" onClick={() => onFiltersChange({ query: "", source: "all", status: "all" })}>清除筛选</button></p>}
      </div>
      {!records.length && <div className="adjustment-record-empty"><History size={22} /><strong>{loading ? "正在读取修改记录…" : "暂无提交记录"}</strong><p>提交的修改会在这里展示，未提交内容保留在本地草稿中。</p></div>}
      {!!records.length && !filtered.length && <p className="adjustment-record-empty">已载入记录中没有符合条件的修改。可以清除筛选{hasMore ? "或加载更早记录" : ""}。</p>}
      <div className="adjustment-record-list">{filtered.map(record => <article key={record.requestId}
        className={`adjustment-record status-${record.status}${selected?.requestId === record.requestId ? " is-selected" : ""}`} aria-label={`${sourceLabel(record)}的修改 ${record.requestId}`}>
        <div className="adjustment-record-title"><strong>{sourceLabel(record)} · {adjustmentStatusLabel[record.status]}</strong>{selected?.requestId === record.requestId && <span className="adjustment-record-selected">当前查看</span>}</div>
        <div className="adjustment-record-facts"><time dateTime={record.submittedAt} title={new Date(record.submittedAt).toString()}>{timestamp(record.submittedAt)}</time><span>#{record.submissionSequence} · {record.changeCount} 项变更</span></div>
        <p className="adjustment-record-version">基础 r{record.base.revision}{record.appliedVersion ? ` → 应用 r${record.appliedVersion.revision}` : record.status === "applied" ? " · 已应用" : " · 尚未应用"}</p>
        {record.waitingReason && <p className="adjustment-record-reason">{record.waitingReason}</p>}
        <div className="adjustment-record-actions">{renderActions(record)}</div>
      </article>)}</div>
      {loadingRequestId && <p role="status">正在读取完整记录…</p>}
      <div className="adjustment-record-pagination"><span>已载入 {loadedCount} / {total} 条记录</span>
        {hasMore && <button type="button" disabled={refreshing} onClick={onLoadMore}>{refreshing ? "正在读取历史…" : "加载更早记录"}</button>}</div>
    </div>
  </section>;
}
