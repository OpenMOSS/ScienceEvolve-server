import { useEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import { getAgentToolRecommendationCatalog, getRecommendationExplainerConfig, recommendAgentTools,
  type AgentToolRecommendationResponse, type AgentToolSelection } from "../api";
import { useRecommendationContext } from "./RecommendationContext";

export function AgentToolRecommendation(props: { agentId: string; instructions: string; disabled?: boolean;
  onApply?: (selection: AgentToolSelection) => void; applyNotice?: string }) {
  return useRecommendationContext() ? <AgentToolRecommendationInner {...props} /> : null;
}

function AgentToolRecommendationInner({ agentId, instructions, disabled, onApply, applyNotice }: {
  agentId: string; instructions: string; disabled?: boolean; onApply?: (selection: AgentToolSelection) => void; applyNotice?: string;
}) {
  const context = useRecommendationContext()!;
  const target = context.input.agents[agentId];
  const input = { ...context.input, agents: { ...context.input.agents,
    ...(target ? { [agentId]: { ...target, instructions } } : {}) },
    ...(context.inputUploadId ? { inputUploadId: context.inputUploadId } : {}),
    ...(context.inputDescription?.trim() ? { inputDescription: context.inputDescription.trim() } : {}) };
  // Keep the complete local value for equality, rather than relying on a
  // lossy hash. The server echoes a separate request token, not an auth grant.
  const key = JSON.stringify({ input, agentId, files: context.files, catalog: context.catalogVersion,
    gateways: context.gateways, harnesses: context.harnesses, explainer: context.configuration?.fingerprint });
  const current = useRef(key); current.current = key;
  const locked = !!disabled || !!context.disabled || context.loading || context.saving;
  const currentLocked = useRef(locked); currentLocked.current = locked;
  const request = useRef<AbortController>();
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [preview, setPreview] = useState<{ result: AgentToolRecommendationResponse; key: string }>();
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    request.current?.abort(); request.current = undefined;
    setBusy(false); setApplying(false);
    if (preview) { setPreview(undefined); setNotice("指令、图、工具选择或共用配置已变化，请重新推荐。"); }
  }, [key, locked]);

  const generate = async () => {
    const configuration = context.configuration;
    if (locked || busy || !target || !configuration?.config.available || !instructions.trim()) return;
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setBusy(true); setPreview(undefined); setError(""); setNotice("");
    const token = crypto.randomUUID();
    try {
      const [catalog, config] = await Promise.all([getAgentToolRecommendationCatalog(input.projectId, controller.signal), getRecommendationExplainerConfig(input.projectId, controller.signal)]);
      if (controller.signal.aborted || current.current !== key || currentLocked.current) return;
      if (configuration.fingerprint !== config.fingerprint) {
        void context.refresh(); throw new Error("Project Explainer 配置已变化，请重新推荐。");
      }
      const result = await recommendAgentTools({ ...input, targetAgent: agentId, contextFingerprint: token,
        configurationFingerprint: config.fingerprint, catalogFingerprint: catalog.fingerprint }, controller.signal);
      if (controller.signal.aborted || current.current !== key || currentLocked.current) return;
      if (result.targetAgent !== agentId || result.contextFingerprint !== token || result.configurationFingerprint !== config.fingerprint || result.catalogFingerprint !== catalog.fingerprint) {
        throw new Error("推荐响应与当前 Agent 或配置不一致，原配置保持。");
      }
      setPreview({ result, key });
    } catch (reason) {
      if (!controller.signal.aborted && key === current.current) setError(reason instanceof Error ? reason.message : "工具推荐失败。");
    } finally { if (request.current === controller) { request.current = undefined; setBusy(false); } }
  };
  const apply = async () => {
    if (!preview || preview.key !== current.current || locked || applying) return;
    const original = preview;
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setApplying(true); setError("");
    try {
      const [catalog, config] = await Promise.all([getAgentToolRecommendationCatalog(input.projectId, controller.signal), getRecommendationExplainerConfig(input.projectId, controller.signal)]);
      if (controller.signal.aborted || currentLocked.current || current.current !== original.key) return;
      if (catalog.fingerprint !== original.result.catalogFingerprint || config.fingerprint !== original.result.configurationFingerprint) {
        setPreview(undefined); void context.refresh();
        throw new Error("工具目录或 Project Explainer 配置已变化，请重新推荐。");
      }
      const selected = original.result.selection;
      const patch = { skills: [...selected.skills], autoSkills: [...selected.autoSkills],
        mcpServers: structuredClone(selected.mcpServers), experimentMcp: selected.experimentMcp };
      if (onApply) onApply(patch); else context.onApplyTools?.(agentId, patch);
      setPreview(undefined); setNotice(applyNotice ?? "已应用到当前 Agent 的业务工具配置。");
    } catch (reason) {
      if (!controller.signal.aborted && current.current === original.key) setError(reason instanceof Error ? reason.message : "推荐无法应用。");
    } finally { if (request.current === controller) { request.current = undefined; setApplying(false); } }
  };
  return <section className="agent-tool-recommendation" aria-label={`${agentId} 工具推荐`}>
    <button type="button" disabled={locked || busy || !target || !instructions.trim() || !context.configuration?.config.available || (!onApply && !context.onApplyTools)} onClick={() => void generate()}>
      <Sparkles size={14} />{busy ? "正在推荐工具…" : "推荐 Skill / MCP"}
    </button>
    {busy && <button type="button" onClick={() => { request.current?.abort(); request.current = undefined; setBusy(false); setNotice("工具推荐已取消，原配置保持。"); }}>取消推荐</button>}
    <small>使用上方推荐模型，根据当前指令和完整 Workflow 推荐；确认后仅替换当前 Agent 的业务工具。</small>
    {context.configuration?.config.validationWarning && <p className="recommendation-validation-warning" role="status">{context.configuration.config.validationWarning}</p>}
    {preview && <div role="region" aria-label={`${agentId} 工具推荐预览`}>
      <dl>
        <dt>固定 Skills</dt><dd>{preview.result.selection.skills.join("、") || "无"}</dd>
        <dt>Auto Skills</dt><dd>{preview.result.selection.autoSkills.join("、") || "无"}</dd>
        <dt>MCP</dt><dd>{preview.result.selection.mcpServers.map(server => server.name).join("、") || "无"}</dd>
        <dt>SII 实验工具</dt><dd>{preview.result.selection.experimentMcp ? "选择" : "不选择"}</dd>
      </dl>
      <ul>{preview.result.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>
      {!!preview.result.warnings.length && <ul>{preview.result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
      <button type="button" disabled={locked || applying} onClick={() => void apply()}>{applying ? "核对配置中…" : "应用工具推荐"}</button>
      <button type="button" disabled={applying} onClick={() => { setPreview(undefined); setNotice("已取消预览，原配置保持。"); }}>放弃预览</button>
    </div>}
    {error && <p className="field-error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
