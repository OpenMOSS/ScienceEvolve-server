import { useEffect, useState } from "react";
import { Check, Copy, RefreshCw } from "lucide-react";
import { getCatalog, getHarnessPrompt } from "../../api";
import type { AgentConfig, Catalog, HarnessPromptResult } from "../../types";
import { cacheResource, readCachedResource } from "../../resource-cache";
import { PERMISSION_PROMPTS } from "../../../../server/src/internal/shared/agent-permission-prompts.js";
import { Button } from "../Common";
import "./agent-prompt-panels.css";

function ReadOnlyPrompt({ title, text, note, open = false, error = false }: {
  title: string; text?: string; note: string; open?: boolean; error?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  useEffect(() => { setCopied(false); setCopyError(false); }, [text]);
  return <details className="canvas-prompt-panel" open={open}>
    <summary>{title}<small>只读</small></summary>
    <p className={error ? "runtime-help canvas-prompt-error" : "runtime-help"} role={error ? "alert" : undefined}>{note}</p>
    {text !== undefined && <>
      <div className="canvas-prompt-tools">
        <Button type="button" variant="ghost" icon={copied ? <Check size={13} /> : <Copy size={13} />}
          disabled={!text} onClick={async () => {
            try { await navigator.clipboard.writeText(text); setCopied(true); setCopyError(false); }
            catch { setCopied(false); setCopyError(true); }
          }}>{copied ? "已复制" : `复制 ${title}`}</Button>
      </div>
      {copyError && <p className="canvas-prompt-error" role="alert">复制失败，请在文本框中选择并复制。</p>}
      <textarea aria-label={title} readOnly value={text} rows={8} spellCheck={false} />
    </>}
  </details>;
}

/** Shared by text configuration, project settings, and every canvas inspector. */
export function AgentPromptPanels({ agentId, agent, mainSystemPrompt }: {
  agentId: string; agent: AgentConfig; mainSystemPrompt?: string;
}) {
  const [system, setSystem] = useState<{ text?: string; error?: string; loading?: boolean }>({});
  const [catalog, setCatalog] = useState(() => readCachedResource<Catalog>("catalog"));
  const [retry, setRetry] = useState(0);
  const selectedHarness = agent.harness || catalog?.defaultHarnessId || catalog?.harnesses?.find(item => item.default)?.id;
  const [harness, setHarness] = useState<{ key: string; result?: HarnessPromptResult; error?: string; loading: boolean }>();
  const key = JSON.stringify([selectedHarness, agent.model, agent.permission, agent.reasoningEffort,
    agent.webSearch, agent.skills, agent.autoSkills, agent.mcpServers.map(server => server.name)]);
  useEffect(() => {
    if ((agentId !== "main" || mainSystemPrompt?.trim()) && agent.harness) return;
    let active = true;
    setSystem(previous => ({ ...previous, loading: true, error: undefined }));
    getCatalog().then(value => {
      if (!active) return;
      setCatalog(value);
      setSystem(value.mainSystemPrompt?.trim() ? { text: value.mainSystemPrompt, loading: false }
        : { error: "当前服务未返回固定 System Prompt，请重试读取。", loading: false });
    }, error => {
      if (active) setSystem({ error: error instanceof Error ? error.message : String(error), loading: false });
    });
    return () => { active = false; };
  }, [agentId, mainSystemPrompt, agent.harness, retry]);
  useEffect(() => {
    const controller = new AbortController();
    const cached = readCachedResource<HarnessPromptResult>(`prompt:${key}`);
    setHarness({ key, result: cached, loading: true });
    if (!selectedHarness) { setHarness({ key, loading: false }); return; }
    if (!agent.model.trim()) { setHarness({ key, loading: false, error: "尚未选择模型，选择后可查询 Harness Prompt。" }); return; }
    getHarnessPrompt({ ...agent, harness: selectedHarness }, controller.signal, retry > 0).then(result => {
      if (!controller.signal.aborted) {
        cacheResource(`prompt:${key}`, result);
        setHarness({ key, result, loading: false });
      }
    }, error => {
      if (!controller.signal.aborted) setHarness({ key, result: cached, loading: false,
        error: error instanceof Error ? error.message : String(error) });
    });
    return () => controller.abort();
    // The key includes every configuration field sent to the read-only query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, retry]);
  const current = harness?.key === key ? harness : undefined;
  const systemText = agentId === "main"
    ? mainSystemPrompt?.trim() ? mainSystemPrompt : system.text ?? catalog?.mainSystemPrompt
    : PERMISSION_PROMPTS[agent.permission];
  const result = current?.result;
  const needsCatalog = (agentId === "main" && !mainSystemPrompt?.trim()) || !agent.harness;
  const loading = Boolean(current?.loading || (needsCatalog && system.loading));
  const queryError = !selectedHarness && system.error ? `无法读取默认 Harness：${system.error}` : current?.error;
  const source = result?.status === "available"
    ? `${result.harness} ${result.installedVersion} · 模型：${result.model} · 基础默认文本（非实际会话完整输入）\nPrompt 模板：${result.resolvedModel}\n${result.scopeNote ? `${result.scopeNote}\n` : ""}来源：${result.source}\n采集时间：${result.collectedAt}`
    : result ? `${result.harness}${result.installedVersion ? ` ${result.installedVersion}` : ""} · 模型：${result.model}\n无法显示 Harness Prompt：${result.reason ?? "服务未返回提示词缺失原因，请刷新重试。"}`
      : queryError ?? (!selectedHarness
        ? system.loading ? "正在读取默认 Harness…" : "未找到默认 Harness，请先选择 Harness。"
        : "正在查询当前 Harness、版本与模型…");
  const unavailable = Boolean(result ? result.status !== "available"
    : queryError || (!selectedHarness && !system.loading));
  return <section className="form-section canvas-prompt-panels" aria-label={`${agentId} 提示词来源`} aria-busy={loading}>
    <ReadOnlyPrompt title="System Prompt" text={systemText} open
      note={agentId === "main" ? (!mainSystemPrompt?.trim() ? system.error : undefined)
        ?? (systemText ? "ScienceEvolve 固定系统规则。" : "正在读取固定系统规则…")
        : "ScienceEvolve 根据当前文件权限注入的固定规则；角色职责由下方用户 Prompt 配置。"} />
    <ReadOnlyPrompt title="Harness Prompt" text={result?.status === "available" ? result.text : undefined} note={source}
      error={unavailable} open />
    {current?.error && result && <p className="canvas-prompt-error" role="alert">刷新失败：{current.error}</p>}
    <div className="canvas-prompt-actions">
      <Button type="button" icon={<RefreshCw size={14} />} loading={loading}
        onClick={() => setRetry(value => value + 1)}>{loading ? "正在读取提示词…" : "刷新提示词"}</Button>
      <span className="runtime-help" role="status">{loading ? "正在读取安装版本与提示词" : "只读查看，不修改 Agent 配置"}</span>
    </div>
  </section>;
}
