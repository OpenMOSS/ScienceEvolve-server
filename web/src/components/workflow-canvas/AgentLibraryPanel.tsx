import { GitBranch, Plus, Search, Trash2, UsersRound, X } from "lucide-react";
import { Fragment, useState, type CSSProperties } from "react";
import type { AgentDefinition, AgentOrchestrationTemplate, AgentTemplate } from "../../types";
import { agentMeta } from "../../lib";
import { collaborationMemberRefs } from "./core/workflow-nodes";

const BUILTIN_TEMPLATES: AgentDefinition[] = [
  { name: "main", template: "main" },
  ...(["general", "idea", "execution", "writing", "review"] as AgentTemplate[])
    .map((template) => ({ name: template, template }))
];
const COLORS: Record<string, [string, string]> = {
  green: ["#25714e", "#e7f1e9"], indigo: ["#5c5bd6", "#eeedff"], amber: ["#b56f17", "#fff2d9"],
  cyan: ["#177588", "#e1f4f5"], violet: ["#76599d", "#f1ebf8"], rose: ["#a65365", "#f9eaed"], slate: ["#526674", "#eaf0f3"]
};

export function AgentLibraryPanel({ orchestration, selectedId, readOnly = false, gitEnabled = false, searchable = false, onSelectMain, onSelectCollaboration, onAddCopy, onRemoveTemplate, onShowCreate, onShowCreateCollaboration }: {
  orchestration: AgentOrchestrationTemplate;
  selectedId?: string;
  readOnly?: boolean;
  gitEnabled?: boolean;
  searchable?: boolean;
  onSelectMain: () => void;
  onSelectCollaboration: (id: string) => void;
  onAddCopy: (definition: AgentDefinition) => void;
  onRemoveTemplate: (name: string) => void;
  onShowCreate: () => void;
  onShowCreateCollaboration?: () => void;
}) {
  const [query, setQuery] = useState("");
  const term = searchable ? query.trim().toLocaleLowerCase() : "";
  const legacyTemplates = orchestration.agents.filter((entry) => !BUILTIN_TEMPLATES.some((builtin) => builtin.name === entry.name)
    && !/_copy[1-9]\d*$/.test(entry.name));
  const templateGroups = [
    { label: "内置模板", entries: BUILTIN_TEMPLATES, custom: false },
    { label: "自定义模板", entries: (orchestration.agentTemplates ?? legacyTemplates)
      .filter((entry) => !BUILTIN_TEMPLATES.some((builtin) => builtin.name === entry.name)), custom: true }
  ].map(group => ({ ...group, entries: group.entries.filter(entry => {
    if (!term) return true;
    const meta = agentMeta(entry.name, entry.template ?? "general");
    return [entry.name, meta.name, entry.description || meta.description].some(value => value.toLocaleLowerCase().includes(term));
  }) }));
  const collaborations = orchestration.collaborations ?? [];
  return <section className="panel-section agent-library-section">
    <div className="panel-heading">
      <h2>Agent 模板</h2>
      <button type="button" className={searchable ? "library-create" : "icon-button"} onClick={onShowCreate} disabled={readOnly} title="添加 Agent 模板" aria-label="添加 Agent 模板">
        <Plus size={15} aria-hidden="true" />{searchable && <span>新建</span>}
      </button>
    </div>
    {onShowCreateCollaboration && <section className="collaboration-library-section" aria-label="协作组库">
      <div className="collaboration-library-heading">
        <span><UsersRound size={14} /><strong>协作组</strong><em>{collaborations.length}</em></span>
        <button type="button" className="collaboration-add-button" onClick={onShowCreateCollaboration} disabled={readOnly} title={gitEnabled ? "新增协作组" : "先启用 Git 机制"} aria-label="新增协作组"><Plus size={13} /><span>新建</span></button>
      </div>
      {!gitEnabled && <p className="collaboration-git-hint"><GitBranch size={12} />启用 Git 机制后可创建协作组</p>}
      {collaborations.map((group) => {
        const refs = collaborationMemberRefs(orchestration, group);
        const scoped = orchestration.schemaVersion === 3;
        const parent = orchestration.scopedWorkflow?.groups.find((entry) => entry.id === group.id)?.parentGroupId;
        return <div className={`library-item collaboration-library-item ${selectedId === group.id ? "is-active" : ""}`} key={group.id}>
        <span className="agent-avatar"><UsersRound size={14} /></span>
        <button type="button" className="library-copy" onClick={() => onSelectCollaboration(group.id)}><strong>{group.displayName}</strong><small>{scoped ? `${refs.length} 个直接节点 · ${parent ? "嵌套协作组" : "根图协作组"}` : `${refs.length} 名成员 · 单一外层节点`}</small><span className="collaboration-library-members">{refs.map((ref) => ref.kind === "gate" ? ref.gateId : ref.kind === "agent" ? ref.agentId : ref.groupId).join(" · ")}</span></button>
        <span className="collaboration-library-fixed">固定</span>
      </div>; })}
    </section>}
    {searchable && <div className="library-search">
      <Search size={15} aria-hidden="true" />
      <input type="text" aria-label="筛选 Agent 模板" placeholder="筛选模板" value={query} onChange={event => setQuery(event.target.value)} />
      {query && <button type="button" title="清空筛选" aria-label="清空筛选" onClick={() => setQuery("")}><X size={14} aria-hidden="true" /></button>}
    </div>}
    <div className="agent-library" aria-label="Agent 模板库">
      {templateGroups.every(group => group.entries.length === 0) && <p className="library-empty" role="status">没有匹配的模板</p>}
      {templateGroups.map(({ label, entries, custom }) => entries.length > 0 && <Fragment key={label}>
        <h3 className="library-category">{label}</h3>
        {entries.map((entry) => {
      const meta = agentMeta(entry.name, entry.template ?? "general");
      const isMain = entry.name === "main";
      const colors = COLORS[meta.color] ?? COLORS.slate!;
      return <div key={entry.name} className={`library-item ${isMain && selectedId === "main" ? "is-active" : ""}`} data-custom-template={custom || undefined} style={{ "--agent-color": colors[0], "--agent-soft": colors[1] } as CSSProperties}>
        <span className="agent-avatar">{meta.shortName.slice(0, 2).toUpperCase()}</span>
        {isMain ? <button type="button" className="library-copy" onClick={onSelectMain}><strong>{meta.name}</strong><small>{entry.description || meta.description}</small></button>
          : <div className="library-copy"><strong>{meta.name}</strong><small>{entry.description || meta.description}</small></div>}
        {isMain ? <span /> : <button type="button" className="library-add" onClick={() => onAddCopy(entry)} disabled={readOnly} title={`添加 ${meta.name} 副本`} aria-label={`添加 ${meta.name} 副本`}><Plus size={15} /></button>}
        {custom ? <button type="button" className="library-delete" onClick={() => onRemoveTemplate(entry.name)} disabled={readOnly} title="删除模板" aria-label={`删除 ${meta.name} 模板`}><Trash2 size={13} /></button> : <span />}
      </div>;
    })}</Fragment>)}</div>
  </section>;
}
