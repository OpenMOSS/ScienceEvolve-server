import { useState } from "react";
import { Cable, Check, ChevronDown, Plus } from "lucide-react";
import type { AgentMcpServer, FixedMcpDefinition } from "../types";
import { CreateMcpDialog } from "./CreateMcpDialog";

function serverKey(server: AgentMcpServer): string {
  return "project" in server
    ? `${server.name}\0project:${server.project}`
    : `${server.name}\0url:${server.url}`;
}

function serverLocation(server: AgentMcpServer): string {
  return "project" in server ? `project:${server.project}` : server.url;
}

export function McpServerControl({
  agentName,
  selected,
  options,
  systemOptions = [],
  disabled = false,
  className = "",
  onAdd,
  onToggle
}: {
  agentName: string;
  selected: AgentMcpServer[];
  options: AgentMcpServer[];
  /** Server-owned fixed directory entries. They are never editable. */
  systemOptions?: FixedMcpDefinition[];
  disabled?: boolean;
  className?: string;
  onAdd: (
    name: string,
    url: string
  ) => AgentMcpServer | Promise<AgentMcpServer>;
  onToggle: (server: AgentMcpServer, enabled: boolean) => void;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const selectedKeys = new Set(selected.map(serverKey));
  const isSystem = (server: AgentMcpServer) =>
    "url" in server && systemOptions.some(
      (entry) => entry.name === server.name && entry.url === server.url
    );
  const customOptions = options.filter((server) => !isSystem(server));

  const add = async (name: string, url: string) => {
    setNotice("");
    const server = await onAdd(name, url);
    setNotice(`${server.name} 已添加并启用。`);
    return server;
  };

  return (
    <div className={`mcp-server-control ${className}`.trim()}>
      <span className="mcp-server-label">
        <Cable size={14} />
        MCP 工具
      </span>
      <details className="skill-picker">
        <summary>
          <span>
            {selected.length ? `已启用 ${selected.length} 项` : "添加 MCP"}
          </span>
          <ChevronDown size={15} />
        </summary>
        <div className="skill-menu mcp-server-menu">
          <div className="user-skill-create-row">
            <button
              type="button"
              onClick={() => {
                setNotice("");
                setDialogOpen(true);
              }}
              disabled={disabled || selected.length >= 32}
            >
              <Plus size={14} />
              添加新 MCP
            </button>
            <small>只需填写名称与 URL</small>
            {notice && (
              <small className="user-skill-feedback success" role="status">
                {notice}
              </small>
            )}
          </div>
          {systemOptions.length > 0 && (
            <div className="mcp-directory-section">
              <div className="mcp-directory-heading">
                <strong>系统 MCP</strong>
                <small>固定服务 · 由服务端安全认证</small>
              </div>
              {systemOptions.map((server) => {
                const checked = selectedKeys.has(serverKey(server));
                return (
                  <div className="skill-option mcp-server-option mcp-system-option" key={serverKey(server)}>
                    <label className="skill-option-check">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={disabled || (!checked && selected.length >= 32)}
                        onChange={() => onToggle(server, !checked)}
                      />
                      <span className={`check-box ${checked ? "checked" : ""}`}>
                        {checked && <Check size={13} />}
                      </span>
                      <span>
                        <strong>{server.name} <em className="mcp-fixed-badge">系统</em></strong>
                        <small>{server.description}</small>
                        <small title={server.url}>{server.url}</small>
                      </span>
                    </label>
                  </div>
                );
              })}
            </div>
          )}
          {customOptions.length > 0 && (
            <div className="mcp-directory-section mcp-custom-section">
              <div className="mcp-directory-heading">
                <strong>项目与自定义 MCP</strong>
                <small>项目 stdio 服务或兼容的 HTTP 服务</small>
              </div>
              {customOptions.map((server) => {
                const checked = selectedKeys.has(serverKey(server));
                return (
                  <div className="skill-option mcp-server-option" key={serverKey(server)}>
                    <label className="skill-option-check">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={disabled || (!checked && selected.length >= 32)}
                        onChange={() => onToggle(server, !checked)}
                      />
                      <span className={`check-box ${checked ? "checked" : ""}`}>
                        {checked && <Check size={13} />}
                      </span>
                      <span>
                        <strong>{server.name}{"project" in server && <em className="mcp-fixed-badge">项目</em>}</strong>
                        <small title={serverLocation(server)}>{serverLocation(server)}</small>
                      </span>
                    </label>
                  </div>
                );
              })}
            </div>
          )}
          {!systemOptions.length && !customOptions.length ? (
            <div className="skill-empty">尚未添加 MCP</div>
          ) : null}
        </div>
      </details>
      {selected.length > 0 && (
        <div className="selected-skills compact mcp-server-chips">
          {selected.map((server) => (
            <div
              className="selected-skill-chip"
              key={serverKey(server)}
              title={serverLocation(server)}
            >
              <span>{server.name}</span>
              <em>{isSystem(server) ? "系统 MCP" : "project" in server ? "项目 MCP" : "MCP"}</em>
              <button
                type="button"
                onClick={() => onToggle(server, false)}
                disabled={disabled}
                aria-label={`移除 MCP ${server.name}`}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      {dialogOpen && (
        <CreateMcpDialog
          agentName={agentName}
          onClose={() => setDialogOpen(false)}
          onCreate={add}
        />
      )}
    </div>
  );
}
