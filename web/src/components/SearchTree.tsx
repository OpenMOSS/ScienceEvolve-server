import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Download, GitBranch, History, Plus, RefreshCw, Sprout, Trash2 } from "lucide-react";
import { searchTreeRequest } from "../api";
import type { SearchTreeConfig } from "../types";
import { searchTreeNodeSchema, type SearchTreeNode } from "../../../server/src/internal/shared/search-tree";
import { Button } from "./Common";
import { SearchTreeCanvas, searchTreeDescendants, type SearchTreeSummaryNode } from "./SearchTreeCanvas";
import "./SearchTree.css";

export function SearchTreeEditor({ value, onChange, files = [], defaultOpen = false }: {
  value?: SearchTreeConfig; onChange: (value: SearchTreeConfig | undefined) => void; files?: { path: string }[]; defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [selectedId, setSelectedId] = useState("root");
  const selected = value?.directions.find(node => node.id === selectedId);
  const excluded = value && selected ? searchTreeDescendants(value.directions, selected.id) : new Set<string>();
  const hasChildren = value?.directions.some(node => node.parentId === selectedId);
  function add() {
    if (!value) return;
    const node = { id: `direction-${crypto.randomUUID()}`, kind: "direction" as const, parentId: selected?.id ?? "root", name: "新方向" };
    onChange({ ...value, directions: [...value.directions, node] }); setSelectedId(node.id);
  }
  function patchNode(patch: Partial<SearchTreeConfig["directions"][number]>) {
    if (value && selected) onChange({ ...value, directions: value.directions.map(node => node.id === selected.id ? { ...node, ...patch } : node) });
  }
  return <section className="search-tree-section" aria-label="搜索树规划">
    <div className="search-tree-entry">
      <span className="search-tree-entry-icon"><GitBranch size={22} /></span>
      <button type="button" className="search-tree-entry-copy" aria-expanded={open && Boolean(value)} onClick={() => {
        if (!value) { onChange({ root: { name: "研究起点" }, directions: [] }); setSelectedId("root"); setOpen(true); }
        else setOpen(current => !current);
      }}><strong>搜索树规划 {value ? <span>{value.directions.length} 个初始方向</span> : <span>可选</span>}</strong>
        <small>先规划探索方向，启动后由 Agent 在同一棵树上持续积累方案与证据。</small>
      </button>
      <label className="search-tree-toggle"><input type="checkbox" aria-label="启用搜索树" checked={Boolean(value)} onChange={event => {
        onChange(event.target.checked ? { root: { name: "研究起点" }, directions: [] } : undefined);
        setOpen(event.target.checked); setSelectedId("root");
      }} /><span aria-hidden="true" /></label>
      {value && <button type="button" className="icon-button" aria-label={open ? "收起搜索树规划" : "展开搜索树规划"} aria-expanded={open} onClick={() => setOpen(current => !current)}>{open ? <ChevronDown size={17} /> : <ChevronRight size={17} />}</button>}
    </div>
    {value && open && <>
      <div className="search-tree-toolbar"><p><Sprout size={15} />初始规划 · 随课题保存，启动后沿用</p><Button type="button" variant="secondary" onClick={add}><Plus size={14} />{selected ? "添加子方向" : "添加方向"}</Button></div>
      <div className="search-tree-workbench">
        <SearchTreeCanvas root={{ id: "root", kind: "root", name: value.root.name }} nodes={value.directions} selectedId={selected?.id ?? "root"} onSelect={setSelectedId} />
        <aside className="search-tree-inspector" aria-label="初始节点详情">
          <header><span className="search-tree-kicker">{selected ? "DIRECTION" : "RESEARCH ROOT"}</span><h3>{selected ? "探索方向" : "研究起点"}</h3><p>{selected ? "描述这个分支要解决的问题。" : "点击左侧节点编辑，或添加第一个探索方向。"}</p></header>
          {selected ? <>
            <label className="field"><span>方向名称</span><input aria-label="方向名称" value={selected.name} onChange={event => patchNode({ name: event.target.value })} /></label>
            <label className="field"><span>父方向</span><select aria-label="父方向" value={selected.parentId} onChange={event => patchNode({ parentId: event.target.value })}>
              <option value="root">{value.root.name}（根）</option>{value.directions.filter(node => !excluded.has(node.id)).map(node => <option key={node.id} value={node.id}>{node.name}</option>)}
            </select></label>
            <label className="field"><span>方向说明</span><textarea rows={5} value={selected.description ?? ""} placeholder="研究问题、探索范围或待验证的假设…" onChange={event => patchNode({ description: event.target.value })} /></label>
            <Button type="button" variant="danger" disabled={hasChildren} onClick={() => {
              onChange({ ...value, directions: value.directions.filter(node => node.id !== selected.id) }); setSelectedId(selected.parentId);
            }}><Trash2 size={14} />删除方向</Button>
            {hasChildren && <p className="search-tree-note">请先移动或删除子节点，再删除此方向。</p>}
          </> : <>
            <label className="field"><span>根节点名称</span><input value={value.root.name} onChange={event => onChange({ ...value, root: { ...value.root, name: event.target.value } })} /></label>
            <label className="field"><span>起点说明</span><textarea rows={5} value={value.root.description ?? ""} placeholder="这次研究的出发点、已有信息与约束…" onChange={event => onChange({ ...value, root: { ...value.root, description: event.target.value } })} /></label>
            {files.length > 0 && <fieldset className="search-tree-inputs"><legend>关联初始文件快照</legend>{files.map(file => <label key={file.path}>
              <input type="checkbox" checked={value.root.inputFiles?.includes(file.path) ?? false} onChange={event => onChange({ ...value, root: { ...value.root, inputFiles: event.target.checked
                ? [...(value.root.inputFiles ?? []), file.path] : value.root.inputFiles?.filter(name => name !== file.path) } })} /><span>{file.path}</span>
            </label>)}</fieldset>}
          </>}
        </aside>
      </div>
      <footer className="search-tree-footer">用户规划方向 · Agent 添加候选与证据 · 搜索树不改变 Workflow 路由</footer>
    </>}
  </section>;
}

interface Overview {
  revision: string;
  root: { id: "root"; kind: "root"; name: string; description?: string; inputs: { path: string; sha256: string; bytes: number }[] };
  nodes: SearchTreeSummaryNode[];
}
interface SearchTreeSnapshot { revision: string; tree: { root: Overview["root"]; nodes: SearchTreeNode[] } }
interface NodeDraft { node: SearchTreeNode; revision: string; isNew: boolean; dirty: boolean }
interface TreeHistory { entries: { revision: string; requestId: string; actor: { kind: "user" } | { kind: "agent"; agentId: string }; at: string }[]; nextBefore?: string }
const executionLabels = { not_started: "未执行", running: "运行中", succeeded: "已成功", failed: "已失败", unknown: "结果待确认" };
const errorMessage = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);

export function SearchTreePanel({ projectId, defaultOpen = false }: { projectId: string; defaultOpen?: boolean }) {
  return <ProjectSearchTree key={projectId} projectId={projectId} defaultOpen={defaultOpen} />;
}
function ProjectSearchTree({ projectId, defaultOpen }: { projectId: string; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [overview, setOverview] = useState<Overview>();
  const [draft, setDraft] = useState<NodeDraft>();
  const [history, setHistory] = useState<TreeHistory>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const alive = useRef(true);
  const loadingOverview = useRef(false);
  const generation = useRef(0);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const load = useCallback(async () => {
    if (loadingOverview.current) return;
    loadingOverview.current = true; setLoading(true);
    const version = generation.current;
    try {
      const result = await searchTreeRequest(projectId, { operation: "overview" }) as Overview;
      if (alive.current && version === generation.current) setOverview(result);
    } catch (reason) { if (alive.current) setError(errorMessage(reason)); }
    finally { loadingOverview.current = false; if (alive.current) setLoading(false); }
  }, [projectId]);
  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, load]);
  useEffect(() => {
    if (!open || error) return;
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 5000);
    return () => window.clearInterval(timer);
  }, [open, error, load]);
  async function action(fn: () => Promise<void>) {
    setError(""); setNotice(""); setBusy(true);
    try { await fn(); } catch (reason) { if (alive.current) setError(errorMessage(reason)); }
    finally { if (alive.current) setBusy(false); }
  }
  function canSelect() {
    if (busy) return false;
    if (draft?.dirty) { setNotice("当前节点有未保存的修改，请先保存或取消编辑。"); return false; }
    setNotice(""); return true;
  }
  function select(id: string) {
    if (!canSelect()) return;
    if (id === "root") { setDraft(undefined); return; }
    void action(async () => {
      const result = await searchTreeRequest(projectId, { operation: "node", nodeId: id }) as { revision: string; node: SearchTreeNode };
      if (alive.current) setDraft({ node: result.node, revision: result.revision, isNew: false, dirty: false });
    });
  }
  function add() {
    if (!overview || !canSelect()) return;
    setDraft({ revision: overview.revision, isNew: true, dirty: true, node: {
      id: `direction-${crypto.randomUUID()}`, kind: "direction", parentId: draft?.node.kind === "direction" ? draft.node.id : "root", name: "新方向"
    } });
  }
  function patch(patch: { name?: string; description?: string; parentId?: string }) {
    setDraft(current => current ? { ...current, dirty: true, node: { ...current.node, ...patch } } : current);
  }
  async function write(operation: Record<string, unknown>) {
    if (!draft) throw new Error("请先读取待编辑节点及其版本");
    const result = await searchTreeRequest(projectId, { ...operation, requestId: crypto.randomUUID(), expectedRevision: draft.revision }) as SearchTreeSnapshot;
    if (!alive.current) return;
    generation.current++;
    setOverview({ revision: result.revision, root: result.tree.root, nodes: result.tree.nodes });
    setDraft(undefined); setHistory(undefined); setNotice("搜索树已保存，Agent 将读取更新后的同一棵树。");
  }
  const selected = draft?.node;
  const excluded = overview && selected ? searchTreeDescendants(overview.nodes, selected.id) : new Set<string>();
  const hasChildren = overview?.nodes.some(node => node.parentId === selected?.id);
  const stale = draft && overview && draft.revision !== overview.revision;
  return <section className="search-tree-section search-tree-runtime" aria-label="搜索树与探索记录">
    <div className="search-tree-entry">
      <span className="search-tree-entry-icon"><GitBranch size={22} /></span>
      <button type="button" className="search-tree-entry-copy" aria-expanded={open} onClick={() => setOpen(current => !current)}>
        <strong>搜索树与探索记录 {overview && <span>{overview.nodes.filter(node => node.kind === "direction").length} 个方向 · {overview.nodes.filter(node => node.kind === "candidate").length} 个候选</span>}</strong>
        <small>沿用初始规划，查看 Agent 的探索分支、真实结果和变更历史。</small>
      </button>
      <button type="button" className="icon-button" aria-label={open ? "收起搜索树" : "展开搜索树"} aria-expanded={open} onClick={() => setOpen(current => !current)}>{open ? <ChevronDown size={18} /> : <ChevronRight size={18} />}</button>
    </div>
    <div className="search-tree-runtime-body" hidden={!open}>
      <div className="search-tree-toolbar"><p><span className={`search-tree-live-dot${error ? " is-paused" : ""}`} />{error ? "同步已暂停，请检查错误后刷新" : "展开时每 5 秒同步 · 不覆盖未保存编辑"}</p>
        <div><Button type="button" variant="ghost" disabled={busy || loading} onClick={() => { setError(""); void load(); }}><RefreshCw size={14} className={loading ? "spin" : ""} />刷新</Button>
          <Button type="button" variant="secondary" disabled={busy || !overview} onClick={add}><Plus size={14} />{selected?.kind === "direction" ? "添加子方向" : "新增方向"}</Button></div>
      </div>
      {error && <p className="search-tree-error" role="alert">{error}</p>}
      {notice && <p className="search-tree-notice" role="status">{notice}</p>}
      {!overview && <p className="search-tree-empty">{loading ? "正在读取搜索树…" : "尚未读取搜索树，请点击刷新。"}</p>}
      {overview && <>
        <div className="search-tree-workbench">
          <SearchTreeCanvas root={overview.root} nodes={draft?.isNew ? [...overview.nodes, draft.node] : overview.nodes} selectedId={selected?.id ?? "root"} onSelect={select} />
          <aside className="search-tree-inspector" aria-label="搜索节点详情" aria-busy={busy}>
            {selected ? <>
              <header><span className="search-tree-kicker">{draft?.isNew ? "NEW DIRECTION" : selected.kind === "direction" ? "DIRECTION" : "CANDIDATE"}</span><h3>{selected.kind === "direction" ? "方向规划" : "候选记录"}</h3><p>{draft?.isNew ? "保存后写入当前搜索树。" : "编辑与 Agent 共用的节点，保留完整变更记录。"}</p></header>
              {stale && <p className="search-tree-stale" role="status">节点与画布版本不同。保存时会校验所读版本，不会覆盖其他人的更新。请刷新画布，或取消编辑后重新选择节点以读取最新内容。</p>}
              <fieldset className="search-tree-edit-fields" disabled={busy}>
                <label className="field"><span>名称</span><input value={selected.name} onChange={event => patch({ name: event.target.value })} /></label>
                <label className="field"><span>父节点</span><select value={selected.parentId} onChange={event => patch({ parentId: event.target.value })}>
                  {selected.kind === "direction" && <option value="root">{overview.root.name}（根）</option>}
                  {overview.nodes.filter(node => !excluded.has(node.id) && (selected.kind === "candidate" || node.kind === "direction")).map(node => <option key={node.id} value={node.id}>{node.name}</option>)}
                </select></label>
                <label className="field"><span>说明</span><textarea rows={4} value={selected.description ?? ""} onChange={event => patch({ description: event.target.value })} /></label>
              </fieldset>
              {selected.kind === "candidate" && <div className="search-tree-evidence">
                <span className={`search-tree-status ${selected.execution.status}`}>{executionLabels[selected.execution.status]}</span>
                <dl><div><dt>探索目标</dt><dd>{selected.goal}</dd></div><div><dt>来源</dt><dd>{selected.source}</dd></div>
                  {selected.change && <div><dt>方案改动</dt><dd>{selected.change}</dd></div>}
                  <div><dt>代码版本</dt><dd>{selected.version.status === "committed" ? <code>{selected.version.commit}</code> : "未提交"}</dd></div>
                  {selected.execution.details && <div><dt>执行说明</dt><dd>{selected.execution.details}</dd></div>}</dl>
                {selected.evidence?.length ? <section><h4>执行证据</h4><ul>{selected.evidence.map((item, index) => <li key={index}>{item}</li>)}</ul></section> : <p className="search-tree-note">尚未登记执行证据。</p>}
                {(["parameters", "result", "evaluation"] as const).map(key => selected[key] !== undefined && <details key={key}><summary>{{ parameters: "参数", result: "实际结果", evaluation: "评估" }[key]}</summary><pre>{JSON.stringify(selected[key], null, 2)}</pre></details>)}
              </div>}
              <div className="search-tree-edit-actions"><Button type="button" disabled={busy || !draft?.dirty} onClick={() => void action(() => write({ operation: "put", node: searchTreeNodeSchema.parse(selected) }))}>保存节点</Button>
                <Button type="button" variant="secondary" disabled={busy} onClick={() => { setDraft(undefined); setNotice(""); }}>取消编辑</Button>
                {!draft?.isNew && <Button type="button" variant="danger" disabled={busy || hasChildren} onClick={() => void action(() => write({ operation: "delete", nodeId: selected.id }))}><Trash2 size={13} />删除节点</Button>}
              </div>
              {hasChildren && <p className="search-tree-note">请先移动或删除子节点，再删除此节点。</p>}
            </> : <>
              <header><span className="search-tree-kicker">RESEARCH ROOT</span><h3>{overview.root.name}</h3><p>创建时的研究起点 · 只读快照</p></header>
              <p className="search-tree-description">{overview.root.description || "未填写起点说明。"}</p>
              <p className="search-tree-note">用户可增删探索方向；Agent 在方向下维护候选方案、执行结果和证据。点击任意节点查看详情。</p>
              {overview.root.inputs?.length > 0 && <section className="search-tree-snapshots"><h4>初始文件快照</h4>{overview.root.inputs.map(input => <div key={input.path}>
                <button type="button" disabled={busy} onClick={() => void action(async () => {
                  const snapshot = await searchTreeRequest(projectId, { operation: "input", path: input.path }) as { content: string };
                  if (!alive.current) return;
                  const url = URL.createObjectURL(new Blob([Uint8Array.from(atob(snapshot.content), char => char.charCodeAt(0))]));
                  try { const link = document.createElement("a"); link.href = url; link.download = input.path.split("/").pop()!; link.click(); }
                  finally { URL.revokeObjectURL(url); }
                })}><Download size={14} />{input.path}</button><small>{input.bytes.toLocaleString()} bytes · SHA-256 <code title={input.sha256}>{input.sha256.slice(0, 12)}</code></small>
              </div>)}</section>}
            </>}
          </aside>
        </div>
        <footer className="search-tree-footer"><span>树版本 <code title={overview.revision}>{overview.revision.slice(0, 10)}</code> · 初始规划与运行记录持续保留</span>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => {
            if (history) { setHistory(undefined); return; }
            void action(async () => { const result = await searchTreeRequest(projectId, { operation: "history" }) as TreeHistory; if (alive.current) setHistory(result); });
          }}><History size={14} />{history ? "收起变更历史" : "查看变更历史"}</Button>
        </footer>
      </>}
      {history && <section className="search-tree-history" aria-label="搜索树变更历史"><h3>变更历史</h3>
        <ol>{history.entries.map(entry => <li key={entry.revision}><span className="search-tree-history-dot" /><div><strong>{entry.actor.kind === "user" ? "用户" : `Agent · ${entry.actor.agentId}`}</strong><small>{entry.requestId === "initialize" ? "创建初始搜索树" : entry.requestId}</small></div><time dateTime={entry.at}>{new Date(entry.at).toLocaleString()}</time><code>{entry.revision.slice(0, 10)}</code></li>)}</ol>
        {history.nextBefore && <Button type="button" variant="secondary" disabled={busy} onClick={() => void action(async () => {
          const more = await searchTreeRequest(projectId, { operation: "history", before: history.nextBefore }) as TreeHistory;
          if (alive.current) setHistory({ ...more, entries: [...history.entries, ...more.entries] });
        })}>加载更早记录</Button>}
      </section>}
    </div>
  </section>;
}
