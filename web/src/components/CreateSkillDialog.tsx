import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FilePlus2, X } from "lucide-react";
import type { SkillDefinition } from "../types";

export function CreateSkillDialog({
  agentName,
  onClose,
  onCreate
}: {
  agentName: string;
  onClose: () => void;
  onCreate: (title: string, content: string) => Promise<SkillDefinition>;
}) {
  const titleId = useId();
  const contentId = useId();
  const titleInput = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const canSave = Boolean(title.trim() && content.trim());

  useEffect(() => {
    titleInput.current?.focus();
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
      await onCreate(title.trim(), content.trim());
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Skill 保存失败");
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
        className="skill-creator-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${titleId}-heading`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="skill-creator-head">
          <span className="skill-creator-icon">
            <FilePlus2 size={20} />
          </span>
          <div>
            <span>Custom Skill</span>
            <h2 id={`${titleId}-heading`}>为{agentName}创建新 Skill</h2>
            <p>保存后生成持久化的 SKILL.md，并加入复选框候选项。</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            aria-label="关闭创建 Skill 弹窗"
          >
            <X size={18} />
          </button>
        </header>

        <div className="skill-creator-fields">
          <label htmlFor={titleId}>
            <span>Skill 标题</span>
            <input
              id={titleId}
              ref={titleInput}
              value={title}
              onChange={(event) => {
                setTitle(event.target.value);
                if (error) setError("");
              }}
              placeholder="例如：实验结果一致性检查"
              aria-label="Skill 标题"
              maxLength={160}
              disabled={saving}
            />
            <small>{title.length.toLocaleString()} / 160 字符</small>
          </label>
          <label htmlFor={contentId}>
            <span>Skill 内容</span>
            <textarea
              id={contentId}
              value={content}
              onChange={(event) => {
                setContent(event.target.value);
                if (error) setError("");
              }}
              placeholder="使用 Markdown 写明适用场景、执行步骤、约束和预期输出……"
              aria-label="Skill 内容"
              rows={12}
              maxLength={100_000}
              disabled={saving}
            />
            <small>{content.length.toLocaleString()} / 100,000 字符</small>
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
            {saving ? "正在保存…" : "保存 Skill"}
          </button>
        </footer>
      </section>
    </div>,
    document.body
  );
}
