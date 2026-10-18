import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Save, X } from "lucide-react";

export function SaveAgentConfigDialog({
  projectId,
  projectTitle,
  onClose,
  onSave
}: {
  projectId: string;
  projectTitle: string;
  onClose: () => void;
  onSave: (title: string) => Promise<void>;
}) {
  const titleId = useId();
  const titleInput = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState(`${projectTitle} · Agent 配置`);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const canSave = Boolean(title.trim());

  useEffect(() => {
    titleInput.current?.focus();
    titleInput.current?.select();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, saving]);

  const save = async () => {
    if (!canSave || saving) return;
    setSaving(true);
    setError("");
    try {
      await onSave(title.trim());
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Agent 配置保存失败");
      setSaving(false);
    }
  };

  return createPortal(
    <div
      className="modal-backdrop skill-creator-backdrop"
      onMouseDown={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <section
        className="skill-creator-dialog config-preset-save-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${titleId}-heading`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="skill-creator-head">
          <span className="skill-creator-icon">
            <Save size={20} />
          </span>
          <div>
            <span>Agent configuration</span>
            <h2 id={`${titleId}-heading`}>保存项目 Agent 配置</h2>
            <p>填写配置库中显示的标题；来源项目标题和 ID 会另外保留。</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            aria-label="关闭保存 Agent 配置弹窗"
          >
            <X size={18} />
          </button>
        </header>

        <div className="config-preset-source">
          <span>来源项目</span>
          <strong>{projectTitle}</strong>
          <code>{projectId}</code>
        </div>

        <div className="skill-creator-fields">
          <label htmlFor={titleId}>
            <span>配置标题</span>
            <input
              id={titleId}
              ref={titleInput}
              value={title}
              onChange={(event) => {
                setTitle(event.target.value);
                if (error) setError("");
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void save();
                }
              }}
              placeholder="例如：H200 高思考深度论文实验配置"
              aria-label="Agent 配置标题"
              maxLength={160}
              disabled={saving}
            />
            <small>{title.length.toLocaleString()} / 160 字符</small>
          </label>
        </div>

        {error && (
          <p className="skill-creator-error" role="alert">
            {error}
          </p>
        )}

        <footer className="skill-creator-actions">
          <button type="button" onClick={onClose} disabled={saving}>
            取消
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => void save()}
            disabled={!canSave || saving}
          >
            {saving ? "正在保存…" : "保存到配置库"}
          </button>
        </footer>
      </section>
    </div>,
    document.body
  );
}
