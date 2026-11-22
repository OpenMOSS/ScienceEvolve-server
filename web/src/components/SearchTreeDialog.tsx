import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, GitBranch } from "lucide-react";
import type { SearchTreeConfig } from "../types";
import { SearchTreeEditor, SearchTreePanel } from "./SearchTree";

type SearchTreeDialogProps = { onClose: () => void } & (
  | { projectId: string }
  | { value?: SearchTreeConfig; files: { path: string }[]; onChange: (value: SearchTreeConfig | undefined) => void }
);

export function SearchTreeDialog(props: SearchTreeDialogProps) {
  const { onClose } = props;
  const runtime = "projectId" in props;
  const panel = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close.current(); }
      if (event.key !== "Tab") return;
      const items = [...panel.current!.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')];
      const first = items[0], last = items.at(-1);
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel.current)) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", keydown, true);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener("keydown", keydown, true);
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  return createPortal(<section ref={panel} tabIndex={-1} className="search-tree-dialog" role="dialog" aria-modal="true" aria-label={runtime ? "项目搜索树" : "编辑搜索树"}
    onKeyDown={event => event.stopPropagation()}>
    <header className="search-tree-dialog-heading">
      <button type="button" className="button button-secondary" onClick={onClose}><ArrowLeft size={16} />返回 Workflow</button>
      <div><GitBranch size={20} /><span><strong>搜索树</strong><small>{runtime ? "项目实时探索记录 · 沿用初始规划" : "与课题共用初始规划 · 不改变 Workflow 路由"}</small></span></div>
      <span className="search-tree-draft-status">{runtime ? "与 Agent 共用项目搜索树 · 节点修改后请保存" : "修改已同步到课题草稿，请保存课题"}</span>
    </header>
    <div className="search-tree-dialog-body">{runtime
      ? <SearchTreePanel projectId={props.projectId} defaultOpen />
      : <SearchTreeEditor value={props.value} files={props.files} onChange={props.onChange} defaultOpen />}</div>
  </section>, document.body);
}
