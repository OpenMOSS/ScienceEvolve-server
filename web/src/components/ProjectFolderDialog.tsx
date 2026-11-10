import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Folder, X } from "lucide-react";
import { Button } from "./Common";

export function ProjectFolderDialog({ mode, name, busy, error, onClose, onConfirm }: {
  mode: "create" | "rename" | "delete";
  name?: string;
  busy: boolean;
  error: string;
  onClose: () => void;
  onConfirm: (name: string) => void;
}) {
  const headingId = useId();
  const panel = useRef<HTMLElement>(null);
  const [value, setValue] = useState(name ?? "");
  const latest = useRef({ busy, onClose });
  latest.current = { busy, onClose };
  const heading = mode === "create" ? "新建项目文件夹" : mode === "rename" ? "重命名文件夹" : "删除文件夹";

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const input = panel.current?.querySelector("input");
    if (input) { input.focus(); input.select(); }
    else panel.current?.querySelector<HTMLButtonElement>('[data-folder-cancel]')?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !latest.current.busy) { event.preventDefault(); latest.current.onClose(); }
      if (event.key !== "Tab") return;
      const items = [...panel.current!.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled)')];
      if (!items.length) { event.preventDefault(); panel.current?.focus(); return; }
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener("keydown", onKeyDown);
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  return createPortal(<div className="modal-backdrop" onMouseDown={event => {
    if (event.target === event.currentTarget && !busy) onClose();
  }}>
    <section ref={panel} tabIndex={-1} className="workflow-modal project-folder-dialog" role="dialog" aria-modal="true" aria-labelledby={headingId}>
      <form onSubmit={event => { event.preventDefault(); if (!busy && (mode === "delete" || value.trim())) onConfirm(value.trim()); }}>
        <div className="workflow-modal-heading">
          <span className="workflow-modal-icon"><Folder size={19} /></span>
          <strong id={headingId}>{heading}</strong>
          <button type="button" className="icon-button" aria-label="关闭文件夹对话框" onClick={onClose} disabled={busy}><X size={18} /></button>
        </div>
        {mode === "delete" ? <p>删除“{name}”后，其中的项目会移回“未分类”，项目及其研究记录均保留。</p>
          : <label className="workflow-modal-field"><span>文件夹名称</span>
            <input value={value} maxLength={80} onChange={event => setValue(event.target.value)} disabled={busy} />
          </label>}
        {error && <p className="field-error" role="alert">{error}</p>}
        <div className="workflow-modal-actions">
          <Button type="button" variant="secondary" data-folder-cancel onClick={onClose} disabled={busy}>取消</Button>
          <Button type="submit" variant={mode === "delete" ? "danger" : "primary"} loading={busy} disabled={mode !== "delete" && !value.trim()}>
            {mode === "delete" ? "删除文件夹" : "保存文件夹"}
          </Button>
        </div>
      </form>
    </section>
  </div>, document.body);
}
