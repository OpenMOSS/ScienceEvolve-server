import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { parseWorkflowImport } from '../../server/src/workflow-import.ts';
import { adaptWorkflowToCanvas } from '../../web/src/components/workflow-canvas/core/canvas-adapter.ts';
import { scopedCanvasPlanningOrchestration } from '../../web/src/components/workflow-canvas/core/scoped-canvas-layout.ts';
import { relativePort, withCanvasLoopPresentation } from '../../web/src/components/workflow-canvas/core/canvas-layout.ts';
import { routeCanvasEdges } from '../../web/src/components/workflow-canvas/core/canvas-router.ts';
import { gallery } from './catalog.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const [outputArgument, sdkArgument, sourceArgument] = process.argv.slice(2);
if (!outputArgument || !sdkArgument) throw new Error('Usage: tsx scripts/workflow-gallery/prepare.mts <new-scratch-output> <sdk-repository> [source-repository]');
const output = path.resolve(outputArgument), sdk = path.resolve(sdkArgument), sourceRoot = sourceArgument ? path.resolve(sourceArgument) : root;
await fs.mkdir(output, { recursive: false });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const views: any[] = [];
const records: any[] = [];
const W = 276, H = 132, GAP = 182;

function arrange(model, selected?: string[], hub = 'main') {
  let nodes = model.nodes.filter(node => !selected || selected.includes(node.id)).map(node => ({ ...node, width: W, height: H }));
  const visible = new Set(nodes.map(node => node.id));
  const edges = model.edges.filter(edge => visible.has(edge.source) && visible.has(edge.target));
  const workers = nodes.filter(node => !['input', 'finish', hub].includes(node.id));
  const byId = new Map(nodes.map(node => [node.id, node]));
  const at = (id, x, y) => { const node = byId.get(id); if (node) Object.assign(node, { x, y }); };
  // Three generous columns leave a dedicated lane around the central host.
  const rows = Math.max(1, Math.ceil(workers.length / 2));
  workers.forEach((node, index) => at(node.id, index % 2 === 0 ? 40 : 880, 60 + Math.floor(index / 2) * GAP));
  const center = 60 + Math.floor((rows - 1) / 2) * GAP;
  at(hub, 460, center);
  at('input', 460, center - GAP);
  at('finish', 460, 60 + rows * GAP);
  if (!byId.has(hub)) {
    // Scoped graphs have parallel input, independent workers and group Finish.
    workers.forEach((node, index) => at(node.id, 460, 60 + index * GAP));
    at('input', 40, 60); at('finish', 880, 60);
  }
  const minY = Math.min(...nodes.map(node => node.y));
  nodes.forEach(node => { node.y += 100 - minY; });
  const renderEdges = edges.map(edge => {
    const from = byId.get(edge.source), to = byId.get(edge.target);
    return { ...edge, sourcePort: relativePort(from, to, 'right'), targetPort: relativePort(to, from, 'left'), sourcePortPinned: false, targetPortPinned: false };
  });
  const geometries = withCanvasLoopPresentation(routeCanvasEdges(renderEdges, nodes, { fastEvaluation: true }), renderEdges);
  assert.equal(geometries.length, edges.length, 'Renderer must not drop a visible edge');
  const samples = geometries.flatMap(edge => edge.samples ?? edge.points ?? []);
  const dx = Math.max(0, 32 - Math.min(...nodes.map(node => node.x), ...samples.map(point => point.x)));
  const dy = Math.max(0, 32 - Math.min(...nodes.map(node => node.y), ...samples.map(point => point.y)));
  if (dx || dy) {
    nodes.forEach(node => { node.x += dx; node.y += dy; });
  }
  const routed = dx || dy ? withCanvasLoopPresentation(routeCanvasEdges(renderEdges, nodes, { fastEvaluation: true }), renderEdges) : geometries;
  for (const edge of routed) for (const node of nodes) {
    if (node.id === edge.source || node.id === edge.target) continue;
    assert.ok(!(edge.samples ?? []).some(point => point.x > node.x + 2 && point.x < node.x + W - 2 && point.y > node.y + 2 && point.y < node.y + H - 2), `Edge ${edge.id} crosses node ${node.id}`);
  }
  const points = routed.flatMap(edge => edge.samples ?? edge.points ?? []);
  const width = Math.ceil(Math.max(1220, ...nodes.map(node => node.x + W + 40), ...points.map(point => point.x + 32)));
  const height = Math.ceil(Math.max(480, ...nodes.map(node => node.y + H + 50), ...points.map(point => point.y + 32)));
  return { nodes, edges: routed, width, height };
}

for (const entry of gallery) {
  const repository = ['kosmos', 'alphaevolve'].includes(entry.id) ? sdk : sourceRoot;
  const source = `example/${entry.id}/workflow.json`;
  const raw = await fs.readFile(path.join(repository, source));
  const config = JSON.parse(raw.toString());
  const exported = path.join(output, `${entry.id}.web.json`);
  execFileSync(process.execPath, [path.join(root, 'example/export-web-workflow.mjs'), path.join(repository, source), exported]);
  const imported = parseWorkflowImport({ filename: `${entry.id}.json`, text: await fs.readFile(exported, 'utf8') });
  for (const key of ['routes', 'input', 'termination', 'loops', 'scopedWorkflow']) assert.deepEqual(imported.orchestration[key], config.orchestration[key], `${entry.id}: import changed ${key}`);
  const model = adaptWorkflowToCanvas(imported.orchestration);
  const base = { entry, config: { agents: config.agents, orchestration: config.orchestration }, sourceSha256: hash(raw) };
  const record = { id: entry.id, source, sourceRepository: repository === sdk ? 'ScienceEvolve SDK' : 'ScienceEvolve main', sourceSha256: hash(raw), screenshot: `${entry.id}.jpg`, details: [] as any[] };
  const hub = entry.id === 'chemical-coscientist' ? 'planner' : 'main';
  views.push({ ...base, key: entry.id, filename: record.screenshot, title: '执行路由总览 / Execution routing overview', ...arrange(model, undefined, hub) });
  const coverage = new Set<string>();
  for (const [index, stage] of entry.stages.entries()) {
    for (const id of stage.ids) { assert.ok(model.nodes.some(node => node.id === id), `${entry.id}: missing stage node ${id}`); coverage.add(id); }
    const filename = `${entry.id}--stage-${index + 1}.jpg`;
    const selected = ['input', 'main', 'finish', ...stage.ids];
    const view = { ...base, key: filename.slice(0, -4), filename, title: `${index + 1}. ${stage.title}`, selected, ...arrange(model, selected) };
    views.push(view); record.details.push({ screenshot: filename, title: view.title });
  }
  if (entry.stages.length) for (const node of model.nodes) {
    if (!['input', 'main', 'finish'].includes(node.id)) assert.ok(coverage.has(node.id), `${entry.id}: no readable stage view for ${node.id}`);
  }
  for (const group of config.orchestration.scopedWorkflow?.groups ?? []) {
    const projection = scopedCanvasPlanningOrchestration(group.workflow);
    const scoped = adaptWorkflowToCanvas(projection);
    assert.equal(scoped.edges.filter(edge => edge.source === 'input' && edge.kind === 'parallel').length, group.workflow.input.edges.length);
    const filename = `${entry.id}--group-${group.id}.jpg`;
    const view = { ...base, key: filename.slice(0, -4), filename, title: `组内细节 / Group: ${group.id}`, groupId: group.id, ...arrange(scoped) };
    views.push(view); record.details.push({ screenshot: filename, title: view.title });
  }
  records.push(record);
  console.log(`${entry.id}: ${model.nodes.length} outer nodes, ${record.details.length} detail views`);
}
const frontendCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const captureSources = {};
for (const file of ['scripts/workflow-gallery/catalog.mjs', 'scripts/workflow-gallery/prepare.mts', 'scripts/workflow-gallery/view.tsx', 'scripts/workflow-gallery/view.css', 'scripts/workflow-gallery/capture.mjs', 'web/src/components/workflow-canvas/CanvasWorld.tsx', 'web/src/components/workflow-canvas/CanvasNodes.tsx', 'web/src/components/workflow-canvas/CanvasEdges.tsx', 'web/src/components/workflow-canvas/workflow-canvas.css', 'web/src/components/workflow-canvas/core/canvas-adapter.ts', 'web/src/components/workflow-canvas/core/canvas-layout.ts', 'web/src/components/workflow-canvas/core/canvas-router.ts', 'web/src/components/workflow-canvas/core/scoped-canvas-layout.ts']) captureSources[file] = hash(await fs.readFile(path.join(root, file)));
await fs.writeFile(path.join(output, 'data.json'), JSON.stringify({ views, records, frontendCommit, captureSources }));
await build({ entryPoints: [path.join(root, 'scripts/workflow-gallery/view.tsx')], bundle: true, format: 'esm', target: 'es2022', jsx: 'automatic', outdir: output, logLevel: 'warning' });
await fs.writeFile(path.join(output, 'index.html'), '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="icon" href="data:,"><link rel="stylesheet" href="/view.css"></head><body><div id="root"></div><script type="module" src="/view.js"></script></body></html>');
console.log(`Prepared ${views.length} unscaled views in ${output}`);
