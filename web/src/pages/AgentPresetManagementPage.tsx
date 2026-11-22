import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { ArrowLeft, Copy, Database, Download, Eye, Pencil, Plus, Trash2, Upload, X } from "lucide-react";
import { createAgentConfigPreset, deleteAgentConfigPreset, downloadAgentConfigPreset, downloadWorkflowSource, getAgentConfigPresets, getCatalog, importAgentConfigPreset, updateAgentConfigPreset } from "../api";
import { Button, ErrorPanel, PageLoader } from "../components/Common";
import { WorkflowPresetPreview } from "../components/WorkflowPresetPreview";
import { WorkflowCanvasEditor } from "../components/WorkflowCanvasEditor";
import {
  applyCatalogDefaultGateway, applyCatalogDefaultGatewayToNewAgents, applyCatalogDefaultHarness,
  applyCatalogDefaultHarnessToNewAgents, catalogDefaultHarnessId, cloneAgentOrchestration, cloneAgentsConfig,
  createBlankWorkflow, formatRelativeTime, projectResourcesPayload
} from "../lib";
import type { AgentConfigPreset, AgentsConfig, Catalog, GatewayRecord, HarnessCatalogEntry } from "../types";

function ConfigPresetLibrary({
  presets,
  harnesses,
  gateways,
  onImport,
  onDownload,
  onDelete,
  onEdit
}: {
  presets: AgentConfigPreset[];
  harnesses: HarnessCatalogEntry[];
  gateways: GatewayRecord[];
  onImport: (filename: string, text: string) => Promise<AgentConfigPreset>;
  onDownload: (preset: AgentConfigPreset) => void;
  onDelete: (preset: AgentConfigPreset) => Promise<void>;
  onEdit: (preset: AgentConfigPreset) => void;
}) {
  const [deletingId, setDeletingId] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const importInput = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState("");
  const [preview, setPreview] = useState<AgentConfigPreset>();

  const importWorkflow = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || importing) return;
    setImportError("");
    if (!/\.json$/i.test(file.name) || file.size > 1_000_000) {
      setImportError("请选择不超过 1 MB 的 workflow.json 文件");
      return;
    }
    setImporting(true);
    try {
      const text = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("读取 workflow.json 失败"));
        reader.onload = () => resolve(String(reader.result ?? ""));
        reader.readAsText(file, "utf-8");
      });
      setPreview(await onImport(file.name, text));
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "导入 Workflow 失败");
    } finally {
      setImporting(false);
    }
  };

  const deletePreset = async (preset: AgentConfigPreset) => {
    if (preset.builtin) return;
    const confirmed = window.confirm(
      preset.importSource
        ? `确定删除 SDK Workflow“${preset.name}”吗？只删除已导入的可视化记录，不影响原始文件或任何课题。`
        : `确定删除配置“${preset.name}”吗？\n\n这是 Workflow 配置。配置删除后，已经使用它的项目副本不受影响，但将无法再更新或覆盖该配置；如需继续保存为可复用配置，请使用“另存为新配置”。`
    );
    if (!confirmed) return;
    setDeletingId(preset.id);
    setDeleteError("");
    try {
      await onDelete(preset);
      if (preview?.id === preset.id) setPreview(undefined);
    } catch (error) {
      setDeleteError(
        error instanceof Error ? error.message : "删除配置失败，请稍后重试。"
      );
    } finally {
      setDeletingId("");
    }
  };

  return (
    <section className="config-preset-library" aria-label="已有 Agent 配置">
      <header>
        <div className="config-preset-heading">
          <Database size={19} aria-hidden="true" />
          <h2>预设列表</h2>
          <small>{presets.length} 项</small>
        </div>
        <Button type="button" icon={<Upload size={15} />} loading={importing} onClick={() => importInput.current?.click()}>
          {importing ? "正在导入…" : "导入 SDK workflow.json"}
        </Button>
      </header>
      <input ref={importInput} className="workflow-json-file-input" type="file" accept=".json,application/json" aria-label="导入 SDK Workflow 文件" onChange={(event) => void importWorkflow(event)} />
      {importError && <span className="config-preset-delete-error" role="alert">{importError}</span>}
      <div className="config-preset-library-list">
        {presets.length ? (
          presets.map((preset) => {
            const agentCount = preset.orchestration.agents.length;
            const pathCount = 1 + Object.values(preset.orchestration.routes ?? {}).reduce((total, routes) => total + routes.length, 0);
            const mcpAssignmentCount = Object.values(preset.agents).reduce((total, config) => total + config.mcpServers.length, 0);
            return (
              <article key={preset.id}>
                <div className="config-preset-details">
                  <div className="config-preset-title">
                    <strong>{preset.name}</strong>
                    {preset.builtin && <em className="config-preset-builtin">系统内置</em>}
                    {preset.importSource && <em className="config-preset-builtin">SDK 导入</em>}
                  </div>
                  <ul className="config-preset-meta">
                    <li>{agentCount} 个 Agent</li>
                    <li>{pathCount} 条路径</li>
                    <li>{mcpAssignmentCount} 个 MCP 绑定</li>
                    {preset.updatedAt && <li>更新于 {formatRelativeTime(preset.updatedAt)}</li>}
                  </ul>
                  {!preset.builtin && <small>来源：{preset.importSource?.filename ?? preset.sourceProjectTitle ?? preset.sourceProjectId ?? "未知项目"}</small>}
                </div>
                <div className="config-preset-actions">
                  <button type="button" onClick={() => setPreview(preset)} aria-label={`查看 Workflow ${preset.name}`} title="查看 Workflow"><Eye size={15} /></button>
                  <button
                    type="button"
                    onClick={() => preset.importSource ? downloadWorkflowSource(preset) : onDownload(preset)}
                    aria-label={`下载配置 ${preset.name}`}
                    title="下载 JSON"
                  >
                    <Download size={15} />
                  </button>
                  <button type="button" disabled={Boolean(deletingId)} onClick={() => onEdit(preset)}
                    aria-label={`${preset.builtin || preset.importSource ? "复制并编辑" : "编辑配置"} ${preset.name}`}
                    title={preset.builtin || preset.importSource ? "复制并编辑" : "编辑配置"}>
                    {preset.builtin || preset.importSource ? <Copy size={15} /> : <Pencil size={15} />}
                  </button>
                  {!preset.builtin && (
                    <button
                      type="button"
                      className="config-preset-delete"
                      onClick={() => void deletePreset(preset)}
                      disabled={Boolean(deletingId)}
                      aria-label={`删除配置 ${preset.name}`}
                      title="删除配置"
                    >
                      <Trash2 size={15} />
                    </button>
                  )}
                </div>
              </article>
            );
          })
        ) : (
          <p>暂无已保存配置</p>
        )}
      </div>
      {deleteError && (
        <span className="config-preset-delete-error" role="alert">
          {deleteError}
        </span>
      )}
      {preview && <WorkflowPresetPreview preset={preview} harnesses={harnesses} gateways={gateways} onClose={() => setPreview(undefined)} />}
    </section>
  );
}

function PresetEditor({ source, catalog, onSaved, onClose }: {
  source?: AgentConfigPreset;
  catalog?: Catalog;
  onSaved: (preset: AgentConfigPreset) => void;
  onClose: () => void;
}) {
  const editableId = source && !source.builtin && !source.importSource ? source.id : undefined;
  const [name, setName] = useState(() => source ? editableId ? source.name : `${source.name.slice(0, 44)} 副本` : "");
  const [workflow, setWorkflow] = useState(() => {
    if (source) return { agents: cloneAgentsConfig(source.agents), orchestration: cloneAgentOrchestration(source.orchestration) };
    const blank = createBlankWorkflow();
    const harnesses = catalog?.harnesses ?? [];
    return {
      ...blank,
      agents: applyCatalogDefaultGateway(
        applyCatalogDefaultHarness(blank.agents, harnesses, catalogDefaultHarnessId(harnesses)),
        catalog?.defaultGatewayId,
        catalog?.gateways ?? []
      )
    };
  });
  const [gitEnabled, setGitEnabled] = useState(Boolean(workflow.orchestration.collaborations?.length));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const harnesses = catalog?.harnesses ?? [];
  const gateways = catalog?.gateways ?? [];
  const defaultHarnessId = catalogDefaultHarnessId(harnesses);
  const close = () => { if (!savingRef.current) onClose(); };

  const changeAgents = (agents: AgentsConfig) => {
    setWorkflow(current => ({
      ...current,
      agents: applyCatalogDefaultHarnessToNewAgents(current.agents,
        applyCatalogDefaultGatewayToNewAgents(current.agents, agents, catalog?.defaultGatewayId, gateways),
        harnesses, defaultHarnessId)
    }));
  };

  const save = async () => {
    if (savingRef.current) return;
    const title = name.trim();
    if (!title) { setError("请输入预设名称"); return; }
    savingRef.current = true;
    setSaving(true);
    setError("");
    try {
      const input = {
        name: title,
        agents: workflow.agents,
        orchestration: workflow.orchestration,
        ...projectResourcesPayload(source?.skillDefinitions, source?.mcpDefinitions)
      };
      onSaved(editableId ? await updateAgentConfigPreset(editableId, input) : await createAgentConfigPreset(input));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "保存配置失败");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <div className="workflow-canvas-dialog agent-preset-editor" role="dialog" aria-modal="true" aria-label={editableId ? "编辑 Agent 配置" : "新建 Agent 配置"}>
      <div className="workflow-canvas-dialog-backdrop" aria-hidden="true" />
      <div className="workflow-canvas-dialog-panel">
        <div className="workflow-canvas-dialog-head">
          <strong>{editableId ? "编辑 Agent 配置" : "新建 Agent 配置"}</strong>
          <button type="button" aria-label="关闭配置编辑器" onClick={close} disabled={saving}><X size={18} /></button>
        </div>
        {error && <ErrorPanel title="保存配置失败" message={error} />}
        <div className="workflow-canvas-dialog-scroll">
          <WorkflowCanvasEditor
            workflowName={name}
            onWorkflowNameChange={setName}
            orchestration={workflow.orchestration}
            agents={workflow.agents}
            onOrchestrationChange={orchestration => setWorkflow(current => ({ ...current, orchestration }))}
            onAgentsChange={changeAgents}
            onSave={() => void save()}
            onClose={close}
            saving={saving}
            harnesses={harnesses}
            gateways={gateways}
            skills={catalog?.skills}
            mcpDirectory={catalog?.mcpDirectory}
            gitEnabled={gitEnabled}
            onGitEnabledChange={setGitEnabled}
          />
        </div>
      </div>
    </div>
  );
}

export function AgentPresetManagementPage({ onBack }: { onBack: () => void }) {
  const [presets, setPresets] = useState<AgentConfigPreset[]>();
  const [catalog, setCatalog] = useState<Catalog>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [editor, setEditor] = useState<{ source?: AgentConfigPreset }>();
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let active = true;
    void getAgentConfigPresets(true).then(value => {
      if (active) setPresets(value);
    }).catch(reason => {
      if (active) setError(reason instanceof Error ? reason.message : "Agent 配置预设加载失败");
    });
    void getCatalog().then(value => {
      if (active) setCatalog(value);
    }).catch(() => { /* Presets can still be managed without the preview catalog. */ });
    return () => { active = false; };
  }, [attempt]);

  return (
    <main className="gateway-management-page agent-preset-management-page">
      <header className="gateway-management-hero">
        <Button variant="ghost" icon={<ArrowLeft size={18} />} onClick={onBack}>返回项目</Button>
        <div><h1>Agent 配置预设</h1></div>
        <Button variant="primary" icon={<Plus size={16} />} disabled={!presets} onClick={() => setEditor({})}>新建预设</Button>
      </header>
      {notice && <p className="gateway-management-notice" role="status">{notice}</p>}
      {error ? <>
        <ErrorPanel title="Agent 配置预设加载失败" message={error} />
        <Button onClick={() => { setError(""); setAttempt(value => value + 1); }}>重试</Button>
      </> : !presets ? <PageLoader label="正在加载配置预设…" /> : (
        <ConfigPresetLibrary
          presets={presets}
          harnesses={catalog?.harnesses ?? []}
          gateways={catalog?.gateways ?? []}
          onImport={async (filename, text) => {
            const imported = await importAgentConfigPreset(filename, text);
            setPresets(current => [imported, ...(current ?? []).filter(item => item.id !== imported.id)]);
            return imported;
          }}
          onDownload={downloadAgentConfigPreset}
          onEdit={source => setEditor({ source })}
          onDelete={async preset => {
            await deleteAgentConfigPreset(preset.id);
            setPresets(current => current?.filter(item => item.id !== preset.id));
          }}
        />
      )}
      {editor && <PresetEditor source={editor.source} catalog={catalog} onClose={() => setEditor(undefined)} onSaved={saved => {
        setPresets(current => current?.some(item => item.id === saved.id)
          ? current.map(item => item.id === saved.id ? saved : item)
          : [saved, ...(current ?? [])]);
        setNotice(`${saved.name} 已保存`);
        setEditor(undefined);
      }} />}
    </main>
  );
}
