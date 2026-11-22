import { useEffect, useState } from "react";
import { searchTreeRequest } from "../api";
import type { SearchTreeConfig } from "../types";

export function SearchTreeEditor({ value, onChange, files = [] }: {
  value?: SearchTreeConfig; onChange: (value: SearchTreeConfig | undefined) => void; files?: { path: string }[];
}) {
  return <section className="form-section" aria-label="搜索树规划">
    <label><input type="checkbox" checked={Boolean(value)} onChange={event => onChange(event.target.checked
      ? { root: { name: "研究起点" }, directions: [] } : undefined)} />启用搜索树</label>
    <p>规划探索方向，并让 Agent 按需记录方案与证据。搜索树不改变任务路由。</p>
    {value && <>
      <label className="field"><span>根节点名称</span><input value={value.root.name}
        onChange={event => onChange({ ...value, root: { ...value.root, name: event.target.value } })} /></label>
      <label className="field"><span>起点说明</span><textarea value={value.root.description ?? ""}
        onChange={event => onChange({ ...value, root: { ...value.root, description: event.target.value } })} /></label>
      {files.length > 0 && <fieldset><legend>关联初始文件快照</legend>{files.map(file => <label key={file.path}>
        <input type="checkbox" checked={value.root.inputFiles?.includes(file.path) ?? false} onChange={event => onChange({
          ...value, root: { ...value.root, inputFiles: event.target.checked
            ? [...(value.root.inputFiles ?? []), file.path] : value.root.inputFiles?.filter(name => name !== file.path) }
        })} />{file.path}</label>)}</fieldset>}
      {value.directions.map(node => <fieldset key={node.id}><legend>方向</legend>
        <label className="field"><span>方向名称</span><input aria-label={`方向名称 ${node.id}`} value={node.name}
          onChange={event => onChange({ ...value, directions: value.directions.map(item => item.id === node.id ? { ...item, name: event.target.value } : item) })} /></label>
        <label className="field"><span>父方向</span><select aria-label={`父方向 ${node.id}`} value={node.parentId}
          onChange={event => onChange({ ...value, directions: value.directions.map(item => item.id === node.id ? { ...item, parentId: event.target.value } : item) })}>
          <option value="root">{value.root.name}（根）</option>
          {value.directions.filter(item => item.id !== node.id).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>
        <label className="field"><span>方向说明</span><textarea value={node.description ?? ""}
          onChange={event => onChange({ ...value, directions: value.directions.map(item => item.id === node.id ? { ...item, description: event.target.value } : item) })} /></label>
        <button type="button" disabled={value.directions.some(item => item.parentId === node.id)}
          onClick={() => onChange({ ...value, directions: value.directions.filter(item => item.id !== node.id) })}>删除方向</button>
      </fieldset>)}
      <button type="button" onClick={() => onChange({ ...value, directions: [...value.directions,
        { id: `direction-${crypto.randomUUID()}`, kind: "direction", parentId: "root", name: "新方向" }] })}>添加方向</button>
    </>}
  </section>;
}

interface TreeNode { id: string; kind: "root" | "direction" | "candidate"; parentId?: string; name: string; description?: string; [key: string]: unknown }
interface Overview { revision: string; root: TreeNode; nodes: TreeNode[] }
export function SearchTreePanel({ projectId }: { projectId: string }) {
  const [overview, setOverview] = useState<Overview>();
  const [selected, setSelected] = useState<TreeNode>();
  const [history, setHistory] = useState<unknown>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function load() { setOverview(await searchTreeRequest(projectId, { operation: "overview" }) as Overview); }
  async function action(fn: () => Promise<void>) {
    setError(""); setBusy(true);
    try { await fn(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  useEffect(() => {
    let current = true;
    setOverview(undefined); setSelected(undefined); setHistory(undefined); setError("");
    void searchTreeRequest(projectId, { operation: "overview" }).then(value => {
      if (current) setOverview(value as Overview);
    }, reason => { if (current) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { current = false; };
  }, [projectId]);
  function branch(parentId: string): React.ReactNode {
    return <ul>{overview?.nodes.filter(node => node.parentId === parentId).map(node => <li key={node.id}>
      <button type="button" disabled={busy} onClick={() => void action(async () => {
        const result = await searchTreeRequest(projectId, { operation: "node", nodeId: node.id }) as { node: TreeNode };
        setSelected(result.node); setHistory(undefined);
      })}>{node.kind === "direction" ? "方向" : "候选"}：{node.name}</button>{branch(node.id)}
    </li>)}</ul>;
  }
  async function write(operation: Record<string, unknown>) {
    if (!overview) throw new Error("请先读取搜索树版本");
    await searchTreeRequest(projectId, { ...operation, requestId: crypto.randomUUID(), expectedRevision: overview.revision });
    setSelected(undefined); await load();
  }
  return <details className="form-section"><summary>搜索树与探索记录</summary>
    {error && <p role="alert">{error}</p>}
    <button type="button" disabled={busy} onClick={() => void action(load)}>刷新</button>
    <button type="button" disabled={busy || !overview} onClick={() => void action(async () => {
      setHistory(await searchTreeRequest(projectId, { operation: "history" }));
    })}>查看变更历史</button>
    {overview && <>
      <h3>根：{overview.root.name}</h3><p>{overview.root.description}</p>
      {Array.isArray(overview.root.inputs) && overview.root.inputs.map((input: { path: string; sha256: string; bytes: number }) =>
        <p key={input.path}><button type="button" disabled={busy} onClick={() => void action(async () => {
          const snapshot = await searchTreeRequest(projectId, { operation: "input", path: input.path }) as { content: string };
          const url = URL.createObjectURL(new Blob([Uint8Array.from(atob(snapshot.content), char => char.charCodeAt(0))]));
          try { const link = document.createElement("a"); link.href = url; link.download = input.path.split("/").pop()!; link.click(); }
          finally { URL.revokeObjectURL(url); }
        })}>初始快照：{input.path}</button>（{input.bytes} bytes）<code>{input.sha256}</code></p>)}
      {branch("root")}
      <button type="button" disabled={busy} onClick={() => setSelected({ id: `direction-${crypto.randomUUID()}`,
        kind: "direction", parentId: "root", name: "新方向" })}>新增方向</button>
      {selected && <div>
        <h4>{selected.kind === "direction" ? "方向规划" : "候选记录"}</h4>
        <label className="field"><span>名称</span><input value={selected.name} onChange={event => setSelected({ ...selected, name: event.target.value })} /></label>
        <label className="field"><span>父节点</span><select value={selected.parentId} onChange={event => setSelected({ ...selected, parentId: event.target.value })}>
          {selected.kind === "direction" && <option value="root">{overview.root.name}（根）</option>}
          {overview.nodes.filter(node => node.id !== selected.id && (selected.kind === "candidate" || node.kind === "direction"))
            .map(node => <option key={node.id} value={node.id}>{node.name}</option>)}
        </select></label>
        <label className="field"><span>说明</span><textarea value={selected.description ?? ""}
          onChange={event => setSelected({ ...selected, description: event.target.value })} /></label>
        {selected.kind === "candidate" && <pre>{JSON.stringify(selected, null, 2)}</pre>}
        <button type="button" disabled={busy} onClick={() => void action(() => write({ operation: "put", node: selected }))}>保存节点</button>
        <button type="button" disabled={busy || overview.nodes.some(node => node.parentId === selected.id)}
          onClick={() => void action(() => write({ operation: "delete", nodeId: selected.id }))}>删除节点</button>
      </div>}
      <small>版本：{overview.revision}</small>
    </>}
    {history !== undefined && <pre>{JSON.stringify(history, null, 2)}</pre>}
  </details>;
}
