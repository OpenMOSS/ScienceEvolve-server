import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Cable, X } from "lucide-react";
import type { AgentMcpServer } from "../types";

export function CreateMcpDialog({
  agentName,
  onClose,
  onCreate
}: {
  agentName: string;
  onClose: () => void;
  onCreate: (
    name: string,
    url: string
  ) => AgentMcpServer | Promise<AgentMcpServer>;
}) {
  const nameId = useId();
  const urlId = useId();
  const nameInput = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const canSave = Boolean(name.trim() && url.trim());

  useEffect(() => {
    nameInput.current?.focus();
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
      const endpoint = new URL(url.trim());
      if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
        throw new Error("MCP URL 仅支持 http:// 或 https://");
      }
      await onCreate(name.trim(), url.trim());
      onClose();
    } catch (reason) {
      setError(
        reason instanceof TypeError
          ? "请输入有效的 MCP URL"
          : reason instanceof Error
            ? reason.message
            : "MCP 保存失败"
      );
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
        className="skill-creator-dialog mcp-creator-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${nameId}-heading`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="skill-creator-head">
          <span className="skill-creator-icon">
            <Cable size={20} />
          </span>
          <div>
            <span>Custom MCP</span>
            <h2 id={`${nameId}-heading`}>为{agentName}添加 MCP</h2>
            <p>添加一个 Streamable HTTP MCP 服务，后续调用会自动连接。</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            aria-label="关闭添加 MCP 弹窗"
          >
            <X size={18} />
          </button>
        </header>

        <div className="skill-creator-fields">
          <label htmlFor={nameId}>
            <span>MCP 名称</span>
            <input
              id={nameId}
              ref={nameInput}
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                if (error) setError("");
              }}
              placeholder="例如：openai-docs"
              aria-label="MCP 名称"
              maxLength={120}
              disabled={saving}
            />
            <small>{name.length.toLocaleString()} / 120 字符</small>
          </label>
          <label htmlFor={urlId}>
            <span>MCP URL</span>
            <input
              id={urlId}
              value={url}
              onChange={(event) => {
                setUrl(event.target.value);
                if (error) setError("");
              }}
              placeholder="https://example.com/mcp"
              aria-label="MCP URL"
              inputMode="url"
              maxLength={4_096}
              disabled={saving}
            />
            <small>支持 http:// 与 https://</small>
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
            {saving ? "正在添加…" : "添加 MCP"}
          </button>
        </footer>
      </section>
    </div>,
    document.body
  );
}
