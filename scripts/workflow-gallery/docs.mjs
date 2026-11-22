import fs from 'node:fs/promises';
import path from 'node:path';
import { gallery } from './catalog.mjs';

const [repositoryArgument, imagesArgument, mode] = process.argv.slice(2);
if (!repositoryArgument || !imagesArgument || !['main', 'sdk'].includes(mode)) throw new Error('Usage: node docs.mjs <repository> <captured-images> <main|sdk>');
const repository = path.resolve(repositoryArgument), images = path.resolve(imagesArgument);
const manifest = JSON.parse(await fs.readFile(path.join(images, 'manifest.json'), 'utf8'));
const entries = gallery.filter(entry => mode === 'sdk' || !['kosmos', 'alphaevolve'].includes(entry.id));
const target = path.join(repository, 'docs/readme/workflows');
await fs.mkdir(target, { recursive: true });
const selected = entries.map(entry => {
  const record = manifest.find(record => record.id === entry.id);
  if (!record) throw new Error(`Missing capture: ${entry.id}`);
  return record;
});
for (const record of selected) for (const capture of [record, ...record.details]) await fs.copyFile(path.join(images, capture.screenshot), path.join(target, capture.screenshot));
await fs.writeFile(path.join(target, 'manifest.json'), JSON.stringify(selected, null, 2) + '\n');

for (const entry of entries) {
  const record = selected.find(record => record.id === entry.id);
  const source = entry.source.startsWith('https:') ? entry.source : `../../../${entry.source}`;
  const prose = `# ${entry.title}\n\n[← 画廊 / Gallery](README.md) · [English index](README_en.md) · [Workflow JSON](../../../example/${entry.id}/workflow.json)\n\n## 方法与边界 / Method and scope\n\n${entry.scope}\n\n> **方法顺序，不是执行路由 / Method guide, not executable routes**\n>\n> ${entry.method.join(' → ')}\n\n${entry.feedback}\n\n[原始依据 / Source](${source}) · [方法映射 / Method mapping](../../../example/METHODS.md#${entry.id})\n\n## 执行路由 / Execution routing\n\n真实前端 CanvasWorld / CanvasNodes / CanvasEdges 的文档展示；单独配置展示坐标和可读字号，不改 JSON 路由。不是完整应用界面截图。静态配置，未连接模型或执行科研任务。\n\n${record.details.length ? '先读下方阶段／组内细节；总览用于核对全图。阶段图只显示所选角色之间的真实边，跨阶段边见总览。\n\n<details>\n<summary>展开完整路由总览 / Full routing overview</summary>\n\n' : ''}![${entry.title} · routing overview](${record.screenshot})\n\n${record.details.length ? '</details>\n\n## 可读细节 / Readable details\n\n' + record.details.map(detail => `### ${detail.title}\n\n![${entry.title} · ${detail.title}](${detail.screenshot})\n\n[打开原图 / Open image](${detail.screenshot})\n`).join('\n') : ''}\n[完整图片 / Full image](${record.screenshot}) · [来源和截图校验 / Manifest](manifest.json)\n`;
  await fs.writeFile(path.join(target, `${entry.id}.md`), prose);
}
const count = selected.reduce((total, record) => total + 1 + record.details.length, 0);
const index = `# ScienceEvolve Workflow 图册\n\n[← README](../../../README_zh-CN.md#examples) · [English](README_en.md) · [方法映射](../../../example/METHODS.md)\n\n${entries.length} 个示例，${entries.length} 张总览 + ${count - entries.length} 张阶段／组内细节。**大流程先读细节，不把全图缩到节点不可读。** ScientistTwo 提供 9 张阶段图；协作组有独立的组内并行图。\n\n截图使用真实前端 CanvasWorld / CanvasNodes / CanvasEdges 与语义适配器、路由器；经导出及通用导入解析器检查。文档页面单独排版：画布缩放固定为 100%，节点标题 16 CSS px，长名称换行，设备像素比 1.5。它们不是完整应用窗口截图。正文方法导读不参与执行，也不伪造角色间直接路由。\n\nMain 星形图是宿主调度关系，不能单凭它判断论文方法是否完整。每页分别说明方法顺序、反馈、外部工具／人类实验和适配限制。**没有连接模型、训练、湿实验或科研端到端执行；配置和截图验证不等于论文结果复现。**\n\n| 示例 | 方法定位 | 图与配置 |\n| --- | --- | --- |\n${entries.map(entry => `| [${entry.title}](${entry.id}.md) | ${entry.scope} | [总览](${entry.id}.jpg) · [细节与说明](${entry.id}.md) · [JSON](../../../example/${entry.id}/workflow.json) |`).join('\n')}\n\n[Manifest](manifest.json) 记录源配置与每张图片的 SHA-256、尺寸、字号、实际节点和前端文件哈希。[重新截图说明](${mode === 'main' ? '../../../scripts/workflow-gallery/README.md' : '/../main/scripts/workflow-gallery/README.md'})。\n`;
await fs.writeFile(path.join(target, 'README.md'), index);
await fs.writeFile(path.join(target, 'README_en.md'), `# ScienceEvolve Workflow atlas\n\n[← README](../../../README.md#examples) · [简体中文](README.md) · [Method mapping](../../../example/METHODS.md)\n\n${entries.length} examples: ${entries.length} routing overviews and ${count - entries.length} stage/group details. Start with the detail pages for large workflows; ScientistTwo has nine stage views.\n\nThese are documentation presentations rendered with the actual frontend CanvasWorld, CanvasNodes, CanvasEdges, semantic adapter and router, with export/import validation. They use separate print layouts, **100% canvas zoom, 16 CSS-pixel node titles and 1.5 device scale**; they are not screenshots of the complete application window. Long names wrap instead of being truncated. Stage views contain only real edges between selected nodes; consult the overview for cross-stage edges.\n\nThe method guides are explanatory, not executable routes. Main-centered scheduling is not a complete paper-method diagram. Each page states synchronous/serial adaptations, tool/state boundaries, external experiments, and unverified capabilities. **No models or scientific experiments were run. Static validation does not reproduce paper results.**\n\n| Example | Overview | Readable detail and method notes |\n| --- | --- | --- |\n${entries.map(entry => `| ${entry.title} | [Image](${entry.id}.jpg) | [Open](${entry.id}.md) |`).join('\n')}\n\n[Manifest](manifest.json) records source/image hashes, dimensions, node IDs, font size and frontend source hashes. The method notes and captions are bilingual where practical; detailed limitations are in Chinese.\n`);
console.log(`${mode}: ${entries.length} example pages, ${count} images installed`);
