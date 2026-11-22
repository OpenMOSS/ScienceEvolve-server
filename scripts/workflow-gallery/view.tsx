import React from 'react';
import { createRoot } from 'react-dom/client';
import { CanvasWorld } from '../../web/src/components/workflow-canvas/CanvasWorld';
import { CanvasNodes } from '../../web/src/components/workflow-canvas/CanvasNodes';
import { CanvasEdges } from '../../web/src/components/workflow-canvas/CanvasEdges';
import './view.css';

const data = await fetch('/data.json').then(response => {
  if (!response.ok) throw new Error(`Gallery data: HTTP ${response.status}`);
  return response.json();
});
const page = new URLSearchParams(location.search).get('view');
const view = data.views.find(item => item.key === page);
if (!view) throw new Error(`Unknown gallery view: ${page}`);
const { entry, config, nodes, edges, height, width } = view;
const group = config.orchestration.scopedWorkflow?.groups.find(item => item.id === view.groupId);
const presentation = (node) => {
  const ref = group?.workflow.nodes.find(item => item.nodeId === node.id);
  const actor = ref?.agentId ?? node.id;
  const agent = config.agents[actor];
  const collaboration = config.orchestration.scopedWorkflow?.groups.find(item => item.id === node.id);
  if (node.kind === 'input') return { title: 'Input', description: group ? '组内并行入口 / Parallel' : '任务入口 / Task', modelLabel: 'CONFIGURATION ONLY', color: '#446b9b', softColor: '#eaf0f7' };
  if (node.kind === 'finish') return { title: 'Finish', description: group ? '组内完成 / Group completion' : '声明的结束条件 / Termination', modelLabel: 'NOT AN EXECUTION RECEIPT', color: '#a65365', softColor: '#f9eaed' };
  if (collaboration) return { title: node.id, description: `Leader: ${collaboration.leaderAgentId}`, modelLabel: `${collaboration.workflow.nodes.length} 个组内节点 · 见细节图`, initials: '组', color: '#5c5bd6', softColor: '#eeedff' };
  if (!agent) throw new Error(`Missing presentation agent: ${actor}`);
  const definition = config.orchestration.agents.find(item => item.name === actor);
  return { title: actor, description: definition?.description ?? (group ? `节点 / Node: ${node.id}` : actor === 'main' ? '宿主协调 / Host coordination' : '执行角色 / Execution role'), modelLabel: `${agent.harness} · ${agent.model}`, color: '#25714e', softColor: '#e7f1e9' };
};
createRoot(document.getElementById('root')!).render(<main className="gallery" style={{ width: width + 64 }}>
  <header><div className="brand">ScienceEvolve <span>WORKFLOW ATLAS · 配置展示</span></div><h1>{entry.title}</h1><p className="scope">{entry.scope}</p></header>
  <section className="method"><h2>方法导读 / Method guide <small>非可执行连线 · Not executable routes</small></h2>
    <ol>{entry.method.map((label, index) => <li key={label}><b>{index + 1}</b>{label}</li>)}</ol><p>{entry.feedback}</p>
  </section>
  <section className="graph">
    <div className="graph-heading"><div><h2>{view.title}</h2><p>{view.groupId ? `组内图 / Scoped workflow · Leader: ${group.leaderAgentId}` : view.selected ? '阶段聚焦 / Stage focus · 仅显示所选角色之间的真实边；跨阶段边见总览' : '完整外层路由 / Complete outer routing · 分组内部另见细节'}</p></div><b>{nodes.length} nodes · {edges.length} edges</b></div>
    <CanvasWorld viewport={{ x: 0, y: 0, zoom: 1 }} worldWidth={width} worldHeight={height} style={{ width, height, minHeight: height }}>
      <CanvasEdges edges={edges} nodes={nodes} interactive={false} />
      <CanvasNodes nodes={nodes} readOnly showPorts={false} suppressGroupMembers resolvePresentation={presentation} />
    </CanvasWorld>
    <div className="legend"><span className="strong">━ 强边 / Strong</span><span className="weak">┄ 条件选择 / Weak</span><span className="parallel">═ 并行入口 / Parallel</span><span className="dispatch">┄ Main 调度 / Dispatch</span><span className="finish">━ 结束 / Termination</span></div>
  </section>
  <footer><strong>静态配置 · 未连接模型 · 未运行科研任务</strong><span>Source: example/{entry.id}/workflow.json · {view.sourceSha256.slice(0, 12)}</span></footer>
</main>);
requestAnimationFrame(() => requestAnimationFrame(() => { document.documentElement.dataset.ready = 'true'; }));
