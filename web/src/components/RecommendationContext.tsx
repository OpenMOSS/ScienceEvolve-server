import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, Settings2, Sparkles } from "lucide-react";
import { getRecommendationExplainerConfig, updateRecommendationExplainerConfig, updateProjectExplainerConfig,
  type AgentToolSelection, type ConfigRecommendationInput, type ExplainerRecommendationConfiguration } from "../api";
import type { GatewayRecord, HarnessCatalogEntry, ProjectExplainerConfigInput } from "../types";
import { Button } from "./Common";
import "./ConfigRecommendation.css";

export interface RecommendationContextInput {
  input: Omit<ConfigRecommendationInput, "advisor">;
  files?: Array<{ path: string; size: number; mtimeMs?: number }>;
  inputUploadId?: string;
  inputDescription?: string;
  gateways: GatewayRecord[];
  harnesses?: HarnessCatalogEntry[];
  /** Catalog changes invalidate previews even before the next server read. */
  catalogVersion?: string;
  disabled?: boolean;
  onApplyTools?: (agentId: string, selection: AgentToolSelection) => void;
}
interface RecommendationContextValue extends RecommendationContextInput {
  configuration?: ExplainerRecommendationConfiguration;
  loading: boolean;
  saving: boolean;
  error: string;
  loadFailed: boolean;
  refresh(): Promise<ExplainerRecommendationConfiguration | undefined>;
  save(input: ProjectExplainerConfigInput): Promise<boolean>;
}
const Context = createContext<RecommendationContextValue | undefined>(undefined);
export function useRecommendationContext() { return useContext(Context); }

/** Both recommendations read the real Explainer configuration. No second
 * advisor selector or session exists in the browser. */
export function RecommendationProvider({ children, ...props }: RecommendationContextInput & { children: ReactNode }) {
  const [configuration, setConfiguration] = useState<ExplainerRecommendationConfiguration>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [loadFailed, setLoadFailed] = useState(false);
  const request = useRef<AbortController>();
  const generation = useRef(0);
  const currentConfiguration = useRef<ExplainerRecommendationConfiguration>();
  const savingRequest = useRef(false);
  const projectId = props.input.projectId;
  const refresh = useCallback(async () => {
    if (savingRequest.current) return;
    const epoch = ++generation.current;
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    // Background reads must not cancel a recommendation or clear its preview
    // when the accepted configuration has not actually changed.
    setLoading(!currentConfiguration.current); setSaving(false);
    try {
      const result = await getRecommendationExplainerConfig(projectId, controller.signal);
      if (controller.signal.aborted || epoch !== generation.current) return;
      currentConfiguration.current = result;
      setConfiguration(result); setError(""); setLoadFailed(false); return result;
    } catch (reason) {
      if (!controller.signal.aborted && epoch === generation.current) {
        setLoadFailed(true); setError(reason instanceof Error ? reason.message : "推荐模型设置读取失败。");
      }
    } finally { if (epoch === generation.current) setLoading(false); }
  }, [projectId]);
  const routeVersion = JSON.stringify([props.gateways.map(gateway => [gateway.id, gateway.revision, gateway.models]), props.harnesses]);
  useEffect(() => {
    setConfiguration(undefined); setError(""); setLoadFailed(false);
    const onFocus = () => void refresh(); window.addEventListener("focus", onFocus);
    return () => {
      ++generation.current; request.current?.abort();
      currentConfiguration.current = undefined; savingRequest.current = false;
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);
  useEffect(() => { void refresh(); }, [refresh, routeVersion]);
  const save = async (input: ProjectExplainerConfigInput) => {
    savingRequest.current = true;
    const epoch = ++generation.current;
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setSaving(true); setError(""); setLoadFailed(false);
    try {
      if (projectId) {
        try {
          await updateProjectExplainerConfig(projectId, input);
        } catch (reason) {
          const record = reason as { status?: number; details?: { code?: string } };
          if (controller.signal.aborted || epoch !== generation.current || record.status !== 409 ||
            record.details?.code !== "explainer_harness_switch_confirmation_required" ||
            !window.confirm("当前回答会终止，已有历史将带入新会话。是否继续切换 harness？")) throw reason;
          await updateProjectExplainerConfig(projectId, { ...input, confirmHarnessSwitch: true });
        }
      }
      const result = projectId ? await getRecommendationExplainerConfig(projectId, controller.signal) : await updateRecommendationExplainerConfig(input, controller.signal);
      if (!controller.signal.aborted && epoch === generation.current) {
        currentConfiguration.current = result;
        setConfiguration(result); return true;
      }
    } catch (reason) {
      if (!controller.signal.aborted && epoch === generation.current) setError(reason instanceof Error ? reason.message : "推荐模型设置保存失败。");
    } finally { if (epoch === generation.current) { savingRequest.current = false; setSaving(false); setLoading(false); } }
    return false;
  };
  return <Context.Provider value={{ ...props, configuration, loading, saving, error, loadFailed, refresh, save }}>{children}</Context.Provider>;
}

export function ExplainerRecommendationSettings() {
  const context = useRecommendationContext();
  const [draft, setDraft] = useState<ProjectExplainerConfigInput>();
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState(false);
  const touched = useRef(false);
  const draftFingerprint = useRef<string>();
  const draftProjectId = useRef(context?.input.projectId);
  const panelId = useId();
  const accepted = context?.configuration;
  const draftFromConfig = (configuration: ExplainerRecommendationConfiguration): ProjectExplainerConfigInput => {
    const config = configuration.config;
    return { harness: config.harness, gatewayId: config.gatewayId, model: config.model, reasoningEffort: config.reasoningEffort };
  };
  useEffect(() => {
    if (draftProjectId.current !== context?.input.projectId) {
      draftProjectId.current = context?.input.projectId;
      touched.current = false; setEditing(false); setSaved(false);
    }
    if (!touched.current) {
      setDraft(accepted ? draftFromConfig(accepted) : undefined);
      draftFingerprint.current = accepted?.fingerprint;
    }
  }, [accepted?.fingerprint, context?.input.projectId]);
  if (!context) return null;
  const { configuration, gateways, harnesses = [], disabled, loading, saving, error } = context;
  const gateway = gateways.find(item => item.id === draft?.gatewayId);
  const options = harnesses.filter(item => item.purposes.includes("explainer") && item.capabilities.readOnlyExplainer && item.selectable !== false && item.userSelectable !== false);
  const busy = disabled || loading || saving;
  const dirty = !!draft && !!configuration && JSON.stringify(draft) !== JSON.stringify(draftFromConfig(configuration));
  const updateDraft = (next: ProjectExplainerConfigInput) => { touched.current = true; setDraft(next); setSaved(false); };
  const cancel = () => {
    touched.current = false;
    setDraft(configuration ? draftFromConfig(configuration) : undefined);
    draftFingerprint.current = configuration?.fingerprint;
    setEditing(false);
  };
  const harnessLabel = harnesses.find(item => item.id === configuration?.config.harness)?.label
    ?? configuration?.config.harness;
  const gatewayLabel = gateways.find(item => item.id === configuration?.config.gatewayId)?.name;
  const effortLabels = { low: "低", medium: "中", high: "高", xhigh: "最高" };
  return <section className="recommendation-explainer-settings" aria-label="推荐模型设置">
    <div className="recommendation-model-header">
      <span className="recommendation-model-icon" aria-hidden="true"><Sparkles size={17} /></span>
      <div className="recommendation-model-copy">
        <span className="recommendation-model-label">推荐模型</span>
        <div className="recommendation-model-summary" role="status">
          <strong>{configuration?.config.model || (loading ? "正在读取…" : "暂时不可用")}</strong>
          {configuration && <span>{[harnessLabel, gatewayLabel, `思考强度 ${effortLabels[configuration.config.reasoningEffort]}`].filter(Boolean).join(" · ")}</span>}
        </div>
      </div>
      <button type="button" className="recommendation-settings-toggle" aria-label="调整推荐模型" aria-expanded={editing} aria-controls={panelId}
        disabled={busy || !draft} onClick={() => editing ? cancel() : setEditing(true)}>
        <Settings2 size={14} />设置<ChevronDown size={14} className={editing ? "is-open" : ""} />
      </button>
    </div>
    <small className="recommendation-model-scope">{context.input.projectId
      ? "配置推荐、Agent 工具推荐与本项目的 Project Explainer 问答使用此模型。"
      : "用于新课题的配置推荐和 Agent 工具推荐。无需调整即可开始推荐。"}</small>
    <div id={panelId} className="recommendation-settings-panel" hidden={!editing}>
      {draft && <>
      <div className="recommendation-advisor" role="group" aria-label="Project Explainer 推荐配置">
        <label><span>运行方式</span><select aria-label="推荐 Explainer Harness" value={draft.harness} disabled={busy} onChange={event => updateDraft({ ...draft, harness: event.target.value })}>
          {!options.some(item => item.id === draft.harness) && <option value={draft.harness}>{draft.harness}</option>}
          {options.map(item => <option key={item.id} value={item.id} disabled={!item.available}>{item.label}{item.available ? "" : " · 不可用"}</option>)}
        </select></label>
        <label><span>网关</span><select aria-label="推荐 Explainer 网关" value={draft.gatewayId ?? ""} disabled={busy} onChange={event => {
          const selected = gateways.find(item => item.id === event.target.value); updateDraft({ ...draft, gatewayId: selected?.id, model: selected?.defaultModel ?? selected?.models[0] ?? "" });
        }}>
          {!gateway && <option value={draft.gatewayId ?? ""}>{draft.gatewayId ? "当前网关不可用" : "请选择网关"}</option>}
          {gateways.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>
        <label><span>模型</span><select aria-label="推荐 Explainer 模型" value={draft.model} disabled={busy || !gateway} onChange={event => updateDraft({ ...draft, model: event.target.value })}>
          {!gateway?.models.includes(draft.model) && <option value={draft.model}>{draft.model || "请选择模型"}</option>}
          {gateway?.models.map(model => <option value={model} key={model}>{model}</option>)}
        </select></label>
        <label><span>思考强度</span><select aria-label="推荐 Explainer 思考强度" value={draft.reasoningEffort ?? "medium"} disabled={busy} onChange={event => updateDraft({ ...draft, reasoningEffort: event.target.value as ProjectExplainerConfigInput["reasoningEffort"] })}>
          {Object.entries(effortLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
        </select></label>
      </div>
      <div className="recommendation-settings-footer">
        <small>{dirty ? "有未保存的更改，推荐仍使用上方已保存的模型。" : "修改后保存，将用于后续推荐。"}</small>
        <div className="recommendation-settings-actions">
          <Button type="button" variant="ghost" disabled={busy} onClick={cancel}>取消</Button>
          <Button type="button" variant="primary" loading={saving} disabled={busy || !dirty || !gateway?.models.includes(draft.model)} onClick={async () => {
            if (await context.save(draft)) { touched.current = false; setEditing(false); setSaved(true); }
          }}>保存设置</Button>
        </div>
      </div>
      {dirty && draftFingerprint.current !== configuration?.fingerprint && <p className="recommendation-settings-conflict" role="status">
        设置已在其他页面更新。取消编辑可查看最新设置，保存则应用当前选择。
      </p>}
      </>}
    </div>
    {saved && <small className="recommendation-settings-saved" role="status"><Check size={14} />设置已保存，将用于后续推荐。</small>}
    {error && <div className="recommendation-settings-error"><p className="field-error" role="alert">{error}</p>
      {context.loadFailed && <Button type="button" variant="ghost" disabled={busy} onClick={() => void context.refresh()}>重新读取设置</Button>}
    </div>}
    {configuration && !configuration.config.available && <p className="field-error" role="alert">{configuration.config.validationError ?? "推荐模型不可用，请调整设置。"}</p>}
    {configuration?.config.validationWarning && <p className="recommendation-validation-warning" role="status">{configuration.config.validationWarning}</p>}
  </section>;
}
