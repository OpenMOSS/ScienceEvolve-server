import { useRef, useState } from "react";
import { LoaderCircle, Trash2 } from "lucide-react";
import { deleteGitHubRepositories, previewGitHubRepositoryDeletion, type GitHubRepositoryDeletionPreview } from "../api";
import type { GitHubAccountRecord, Project } from "../types";

const fullName = (repository: { owner: string; name: string }) => `${repository.owner}/${repository.name}`;
export function GitHubRepositoryBatchDelete({ accounts, projects, deletedProjectIds, connecting, onAuthorize, onDeleted }: {
  accounts: GitHubAccountRecord[]; projects: Project[]; deletedProjectIds: Set<string>; connecting: boolean;
  onAuthorize?(accountId: string): void;
  onDeleted(repositories: { owner: string; name: string }[]): void;
}) {
  const [open, setOpen] = useState(false), [accountId, setAccountId] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [preview, setPreview] = useState<GitHubRepositoryDeletionPreview>();
  const [confirmation, setConfirmation] = useState("");
  const [preparing, setPreparing] = useState(false), [deleting, setDeleting] = useState(false), [finished, setFinished] = useState(false);
  const [error, setError] = useState("");
  const epoch = useRef(0);
  const account = accounts.find(account => account.id === accountId);
  const authorized = account?.status === "ready" && account.scopes.includes("delete_repo");
  const all = projects.filter(project => project.git?.repository);
  const seen = new Set<string>();
  const choices = all.filter(project => {
    const key = fullName(project.git!.repository!).toLowerCase();
    if (project.git?.account?.id !== accountId || seen.has(key)) return false;
    seen.add(key); return true;
  }).map(project => {
    const repository = project.git!.repository!;
    const related = all.filter(item => fullName(item.git!.repository!).toLowerCase() === fullName(repository).toLowerCase());
    const blocked = related.some(item => !["completed", "failed", "cancelled"].includes(item.status));
    const deleted = related.some(item => deletedProjectIds.has(item.id));
    return { project, repository, key: fullName(repository).toLowerCase(), blocked, deleted };
  });
  const eligible = choices.filter(item => !item.blocked && !item.deleted);
  const reset = () => { ++epoch.current; setSelected([]); setPreview(undefined); setConfirmation(""); setError(""); setPreparing(false); setFinished(false); };
  const close = () => { if (deleting) return; reset(); setOpen(false); };
  const prepare = async () => {
    const generation = ++epoch.current;
    setPreparing(true); setError("");
    try {
      const result = await previewGitHubRepositoryDeletion(accountId, eligible.filter(item => selected.includes(item.key))
        .map(item => ({ projectId: item.project.id, owner: item.repository.owner, name: item.repository.name })));
      if (generation === epoch.current) { setPreview(result); setConfirmation(""); }
    } catch (error) { if (generation === epoch.current) setError(error instanceof Error ? error.message : "仓库删除预览失败"); }
    finally { if (generation === epoch.current) setPreparing(false); }
  };
  const remove = async () => {
    if (!preview || deleting || confirmation !== preview.confirmationText) return;
    setDeleting(true); setError("");
    try {
      const result = await deleteGitHubRepositories(preview.accountId, preview.previewId, confirmation);
      setPreview(result); setFinished(true);
      onDeleted(result.repositories.filter(item => item.status === "deleted"));
    } catch (error) { setError(error instanceof Error ? error.message : "仓库批量删除失败，请核对结果后重试"); }
    finally { setDeleting(false); }
  };
  const ready = preview?.repositories.filter(item => item.status === "ready").length ?? 0;
  return <>
    <button type="button" className="github-repository-batch-trigger" disabled={!accounts.length || !all.length}
      onClick={() => { reset(); setAccountId(accounts.find(account => account.isDefault)?.id ?? accounts[0]?.id ?? ""); setOpen(true); }}>
      <Trash2 size={14} />批量删除仓库
    </button>
    {open && <div className="workflow-modal-backdrop"><section className="workflow-modal github-repository-batch-dialog" role="dialog" aria-modal="true" aria-labelledby="github-repository-batch-heading">
      <h2 id="github-repository-batch-heading">批量删除 GitHub 仓库</h2>
      <p>仅处理本系统项目绑定的仓库。删除会移除 GitHub 上的代码、Issue 和 Pull Request；本地项目记录与文件保留。</p>
      {error && <p role="alert">{error}</p>}
      {!preview ? <>
        <label>GitHub 账号<select aria-label="批量删除使用的 GitHub 账号" value={accountId} disabled={preparing}
          onChange={event => { reset(); setAccountId(event.target.value); }}>
          {accounts.map(account => <option key={account.id} value={account.id}>{account.login}</option>)}
        </select></label>
        {!authorized && <div className="github-repository-deletion-auth" role="status">
          <p>此账号尚未授权仓库删除，需要增加 GitHub 的 delete_repo 权限。</p>
          <button type="button" disabled={connecting || !account || !onAuthorize} onClick={() => onAuthorize?.(accountId)}>{connecting ? "等待 GitHub 授权…" : "授权仓库删除"}</button>
        </div>}
        <div className="github-repository-delete-selection">
          <small>每批最多选择 100 个仓库。</small>
          <label><input type="checkbox" aria-label="选择当前账号所有可删除仓库" disabled={!authorized || preparing || !eligible.length}
            checked={eligible.length > 0 && eligible.slice(0, 100).every(item => selected.includes(item.key))}
            onChange={event => setSelected(event.target.checked ? eligible.slice(0, 100).map(item => item.key) : [])} />全选可删除仓库</label>
          {choices.map(item => <label key={item.key}><input type="checkbox" aria-label={`选择仓库 ${fullName(item.repository)}`}
            disabled={!authorized || preparing || item.blocked || item.deleted || selected.length >= 100 && !selected.includes(item.key)} checked={selected.includes(item.key)}
            onChange={event => setSelected(current => event.target.checked ? [...current, item.key] : current.filter(key => key !== item.key))} />
            <span><strong>{fullName(item.repository)}</strong><small>{item.project.title}{item.blocked ? " · 仍有关联项目未结束" : item.deleted ? " · GitHub 已删除" : ""}</small></span>
          </label>)}
          {!choices.length && <p>此账号没有本系统项目关联的仓库。</p>}
        </div>
      </> : <>
        <p>{finished ? "批量删除结果" : `已核验账号 ${preview.accountLogin}，待删除 ${ready} 个仓库。请核对完整仓库名称。`}</p>
        <ul className="github-repository-delete-results">{preview.repositories.map(item => <li key={fullName(item)}>
          <strong>{fullName(item)}</strong><span>{item.status === "deleted" ? "已删除" : item.status === "unconfirmed" ? "结果待核对" : item.status === "failed" ? "未删除" : "待确认删除"}</span>
          {item.error && <p>{item.error}</p>}
        </li>)}</ul>
        {!finished && ready > 0 && <label>输入“{preview.confirmationText}”以确认<input aria-label="仓库永久删除确认词" value={confirmation}
          disabled={deleting} onChange={event => setConfirmation(event.target.value)} autoComplete="off" /></label>}
      </>}
      <div className="workflow-modal-actions">
        <button type="button" disabled={deleting} onClick={close}>{finished ? "关闭" : "取消"}</button>
        {!preview && <button type="button" disabled={!authorized || !selected.length || preparing} onClick={() => void prepare()}>
          {preparing ? <LoaderCircle size={14} className="spin" /> : null}{preparing ? "正在核验仓库…" : `预览删除 ${selected.length} 个仓库`}
        </button>}
        {preview && !finished && <button type="button" className="danger" disabled={!ready || confirmation !== preview.confirmationText || deleting} onClick={() => void remove()}>
          {deleting ? "正在删除…" : `永久删除 ${ready} 个仓库`}
        </button>}
      </div>
    </section></div>}
  </>;
}
