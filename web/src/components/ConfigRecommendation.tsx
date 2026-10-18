import { useEffect, useRef, useState } from "react";
import { RotateCcw, Sparkles } from "lucide-react";
import { getRecommendationExplainerConfig, recommendProjectConfig, type ConfigRecommendationInput, type ConfigRecommendationResponse, type ConfigRecommendationProgress } from "../api";
import { agentOrchestrationError } from "../lib";
import { Button } from "./Common";
import type { GatewayRecord, HarnessCatalogEntry } from "../types";
import { ExplainerRecommendationSettings, RecommendationProvider, useRecommendationContext } from "./RecommendationContext";
import { ConfigRecommendationDialog, type RecommendationOperation } from "./ConfigRecommendationDialog";
import { summarizeConfigurationChanges } from "./config-recommendation-summary";
import { buildCanvasLayoutPlan } from "./workflow-canvas/core/canvas-layout-plan";
import { normalizeCanvasLayout } from "./workflow-canvas/core/canvas-layout";
import "./ConfigRecommendation.css";

type Configuration = ConfigRecommendationResponse["recommendation"];

interface ConfigRecommendationProps {
  input: Omit<ConfigRecommendationInput, "advisor">;
  files?: Array<{ path: string; size: number; mtimeMs?: number }>;
  inputUploadId?: string;
  inputDescription?: string;
  gateways: GatewayRecord[];
  harnesses?: HarnessCatalogEntry[];
  defaultGatewayId?: string;
  disabled?: boolean;
  recommendedApplied?: boolean;
  onApply: (configuration: Configuration) => void;
  onRestoreDefault?: () => void;
}
export function ConfigRecommendation(props: ConfigRecommendationProps) {
  const shared = useRecommendationContext();
  if (shared) return <ConfigRecommendationInner {...props} />;
  return <RecommendationProvider input={props.input} files={props.files} inputUploadId={props.inputUploadId}
    inputDescription={props.inputDescription} gateways={props.gateways} harnesses={props.harnesses} disabled={props.disabled}>
    <ConfigRecommendationInner {...props} />
  </RecommendationProvider>;
}
function ConfigRecommendationInner({ input, files = [], inputUploadId, inputDescription = "", disabled, recommendedApplied, onApply, onRestoreDefault }: ConfigRecommendationProps) {
  const shared = useRecommendationContext()!;
  const configuration = shared.configuration;
  const advisorValid = !!configuration?.config.available && !shared.loading && !shared.saving;
  const taskValid = !!input.title.trim() && input.title.trim().length <= 120 && input.requirement.trim().length >= 10 && input.requirement.length <= 8000;
  const requestInput = { ...input, configurationFingerprint: configuration?.fingerprint };
  const fingerprint = JSON.stringify({ ...requestInput, inputUploadId, inputDescription, files,
    catalogVersion: shared.catalogVersion, gateways: shared.gateways, harnesses: shared.harnesses });
  const current = useRef(fingerprint);
  current.current = fingerprint;
  const controller = useRef<AbortController>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [operation, setOperation] = useState<RecommendationOperation>();
  const [dialogOpen, setDialogOpen] = useState(false);
  useEffect(() => () => controller.current?.abort(), []);
  // Focus-triggered reads keep the accepted configuration. Only actual input
  // or configuration changes and editing locks invalidate a recommendation.
  useEffect(() => {
    if (controller.current) {
      controller.current.abort();
      controller.current = undefined;
      setLoading(false);
      setNotice("任务或配置已变更，请重新生成推荐。");
      setOperation(previous => previous ? { ...previous, status: "cancelled", message: "任务或配置已变更，请重新生成推荐。", finishedAt: Date.now() } : previous);
    }
  }, [fingerprint, disabled, shared.disabled, shared.saving]);

  const cancel = () => {
    controller.current?.abort();
    controller.current = undefined;
    setLoading(false);
    setNotice("推荐已取消，现有配置未更改。");
    setOperation(previous => previous ? { ...previous, status: "cancelled", message: "推荐已取消，现有配置未更改。", finishedAt: Date.now() } : previous);
  };
  const closeDialog = () => {
    if (controller.current) cancel();
    setDialogOpen(false);
  };
  const generate = async () => {
    if (!advisorValid || !taskValid || disabled || shared.disabled || loading || !configuration) return;
    const request = new AbortController();
    controller.current?.abort();
    controller.current = request;
    setLoading(true);
    setError("");
    setNotice("");
    setWarnings([]);
    const before = structuredClone({ agents: input.agents, orchestration: input.orchestration });
    setOperation({ status: "running", phase: "preparing", stage: 0, message: "正在核对课题与推荐模型配置", startedAt: Date.now(), lastProgressAt: Date.now(),
      advisor: { gateway: shared.gateways.find(gateway => gateway.id === configuration.config.gatewayId)?.name ?? "所选网关", model: configuration.config.model } });
    setDialogOpen(true);
    const progress = (event: ConfigRecommendationProgress) => {
      if (request.signal.aborted || controller.current !== request || fingerprint !== current.current) return;
      const stage = event.phase === "preparing" ? 0 : event.phase === "validation" ? 2 : 1;
      setOperation(previous => previous ? { ...previous, phase: event.phase, stage: Math.max(previous.stage ?? 0, stage), message: event.message, lastProgressAt: Date.now() } : previous);
    };
    try {
      const source = await getRecommendationExplainerConfig(input.projectId, request.signal);
      if (source.fingerprint !== configuration.fingerprint) {
        void shared.refresh();
        throw new Error("Project Explainer 配置已变化，请重新生成。");
      }
      if (request.signal.aborted || fingerprint !== current.current) return;
      const result = await recommendProjectConfig({ ...requestInput, ...(inputUploadId ? { inputUploadId } : {}), ...(inputDescription.trim() ? { inputDescription: inputDescription.trim() } : {}) }, request.signal, progress);
      if (request.signal.aborted || fingerprint !== current.current) return;
      progress({ phase: "validation", message: "正在核对当前配置与推荐结果" });
      const latest = await getRecommendationExplainerConfig(input.projectId, request.signal);
      if (request.signal.aborted || fingerprint !== current.current) return;
      if (latest.fingerprint !== source.fingerprint || result.configurationFingerprint !== source.fingerprint) {
        void shared.refresh();
        throw new Error("Project Explainer 配置在生成期间已变化，原配置保持。");
      }
      const recommendation = result.recommendation;
      const issue = agentOrchestrationError(recommendation.orchestration);
      if (issue) throw new Error(issue);
      if (!recommendation.orchestration.agents.every((agent) => recommendation.agents[agent.name]?.model?.trim())) {
        throw new Error("推荐配置缺少 Agent 设置，请重新生成。");
      }
      const applied = {
        agents: structuredClone(Object.fromEntries(recommendation.orchestration.agents.map((agent) => [agent.name, recommendation.agents[agent.name]]))),
        orchestration: structuredClone(recommendation.orchestration)
      };
      setOperation(previous => previous ? { ...previous, phase: "applying", stage: 3, message: "正在自动整理 Workflow 布局并应用推荐", lastProgressAt: Date.now() } : previous);
      // Run the same layered + tidy planner as the canvas toolbar. Start from
      // the new graph so old positions and port pins cannot crowd new Agents.
      const initialLayout = normalizeCanvasLayout(undefined, applied.orchestration);
      const layout = await buildCanvasLayoutPlan({ kind: "layered", orchestration: applied.orchestration,
        layout: initialLayout, viewportSize: { width: 1000, height: 640 } });
      if (request.signal.aborted || controller.current !== request || fingerprint !== current.current) return;
      // Let each compact/full canvas fit the result to its actual dimensions.
      applied.orchestration.canvas = { ...layout.layout, viewport: initialLayout.viewport };
      const summary = summarizeConfigurationChanges(before, applied, { gateways: shared.gateways, harnesses: shared.harnesses });
      const resultWarnings = [...(result.warnings ?? []), ...(layout.usedFallback ? ["自动布局已使用备用整理方案，可在画布中继续调整。"] : [])];
      if (controller.current === request) {
        controller.current = undefined;
        setLoading(false);
      }
      onApply(applied);
      setWarnings(resultWarnings);
      setNotice("推荐配置已自动填入下方 Agent 与 Workflow，并已整理画布布局，可继续修改并保存。");
      setOperation(previous => previous ? { ...previous, status: "completed", stage: 4, message: "推荐已完成，配置已应用", summary,
        warnings: resultWarnings, finishedAt: Date.now() } : previous);
    } catch (reason) {
      if (!request.signal.aborted && fingerprint === current.current) {
        const message = reason instanceof Error ? reason.message : "推荐配置生成失败";
        setError(message);
        setOperation(previous => previous ? { ...previous, status: "failed", message: `推荐失败：${message}`, finishedAt: Date.now() } : previous);
      }
    } finally {
      if (controller.current === request) {
        controller.current = undefined;
        setLoading(false);
      }
    }
  };

  return <div className="config-recommendation">
    <ExplainerRecommendationSettings />
    <div className="recommendation-actions">
      <Button type="button" variant="secondary" loading={loading} disabled={disabled || shared.disabled || loading || !advisorValid || !taskValid} onClick={() => void generate()}>
        <Sparkles size={16} />{loading ? "正在生成推荐…" : "推荐配置"}
      </Button>
      {recommendedApplied && onRestoreDefault && <Button type="button" variant="ghost" disabled={disabled || loading} onClick={() => {
        onRestoreDefault();
        setWarnings([]);
        setOperation(undefined);
        setNotice("已恢复系统默认 Agent 与 Workflow 配置。");
      }}><RotateCcw size={16} />恢复默认</Button>}
      {operation?.status === "completed" && <Button type="button" variant="ghost" onClick={() => setDialogOpen(true)}>查看本次修改</Button>}
      <small>课题要求、所选文件与图片、文件用途说明会一起交给 Project Explainer。推荐支持 UTF-8 文本、DOCX、XLSX、PPTX、PDF 及常见图片；超限或无法读取的附件会提示错误。生成成功后可继续修改。</small>
    </div>
    {error && !dialogOpen && <p className="field-error" role="alert">推荐失败：{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {!!warnings.length && !dialogOpen && <ul className="recommendation-warnings">{warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
    {dialogOpen && operation && <ConfigRecommendationDialog operation={operation} onClose={closeDialog} onCancel={cancel}
      canRetry={advisorValid && taskValid && !disabled && !shared.disabled && !loading}
      onRetry={() => void generate()} />}
  </div>;
}
