import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [inputArgument, outputArgument, playwrightArgument, browserArgument, only] = process.argv.slice(2);
if (!inputArgument || !outputArgument || !playwrightArgument || !browserArgument) throw new Error('Usage: node capture.mjs <prepared-directory> <new-image-directory> <playwright-entry> <chromium-executable> [view-key]');
const input = path.resolve(inputArgument), output = path.resolve(outputArgument);
const { chromium } = await import(pathToFileURL(path.resolve(playwrightArgument)).href);
const data = JSON.parse(await fs.readFile(path.join(input, 'data.json'), 'utf8'));
const views = only ? data.views.filter(view => view.key === only) : data.views;
assert.ok(views.length, `Unknown view: ${only}`);
await fs.mkdir(output, { recursive: false });
const files = new Map(await Promise.all(['index.html', 'view.js', 'view.css', 'data.json'].map(async file => [file, await fs.readFile(path.join(input, file))])));
const server = http.createServer((request, response) => {
  const file = new URL(request.url, 'http://localhost').pathname.slice(1) || 'index.html';
  if (!files.has(file)) { response.writeHead(404).end(); return; }
  response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.json') ? 'application/json' : 'text/html');
  response.end(files.get(file));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  // Chromium's sandbox stays enabled. On root-only hosts use an unprivileged
  // account with a writable HOME; do not pass --no-sandbox.
  browser = await chromium.launch({ executablePath: path.resolve(browserArgument), headless: true, chromiumSandbox: true });
  const context = await browser.newContext({ deviceScaleFactor: 1.5, reducedMotion: 'reduce' });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  const captures = new Map();
  for (const view of views) {
    await page.setViewportSize({ width: view.width + 64, height: 1000 });
    await page.goto(`${origin}/?view=${encodeURIComponent(view.key)}`);
    await page.waitForSelector('html[data-ready="true"]');
    await page.evaluate(() => document.fonts.ready);
    const metrics = await page.evaluate(() => {
      const canvas = document.querySelector('.workflow-canvas').getBoundingClientRect();
      const cards = [...document.querySelectorAll('.agent-node')].map(element => {
        const rect = element.getBoundingClientRect(), title = element.querySelector('strong');
        return { id: element.dataset.nodeId, x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom,
          width: rect.width, height: rect.height, font: parseFloat(getComputedStyle(title).fontSize),
          clippedTitle: title.scrollWidth > title.clientWidth + 1 || element.querySelector('.node-copy').getBoundingClientRect().bottom > rect.bottom,
          contained: rect.x >= canvas.x && rect.y >= canvas.y && rect.right <= canvas.right && rect.bottom <= canvas.bottom };
      });
      const overlaps = cards.flatMap((a, index) => cards.slice(index + 1).filter(b => a.x < b.right && a.right > b.x && a.y < b.bottom && a.bottom > b.y).map(b => [a.id, b.id]));
      return { cards, overlaps, width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight };
    });
    assert.deepEqual(errors, [], `${view.key}: browser errors`);
    assert.equal(metrics.cards.length, view.nodes.length, `${view.key}: node count`);
    assert.deepEqual(metrics.overlaps, [], `${view.key}: overlapping nodes`);
    for (const card of metrics.cards) {
      assert.ok(card.contained, `${view.key}: clipped node ${card.id}`);
      assert.ok(!card.clippedTitle, `${view.key}: truncated title ${card.id}`);
      assert.equal(card.width, 276, `${view.key}: DOM/router width mismatch`);
      assert.equal(card.height, 132, `${view.key}: DOM/router height mismatch`);
      assert.ok(card.font >= 16, `${view.key}: unreadable node title`);
    }
    const image = await page.screenshot({ path: path.join(output, view.filename), fullPage: true, type: 'jpeg', quality: 92, animations: 'disabled' });
    captures.set(view.filename, { screenshot: view.filename, screenshotSha256: createHash('sha256').update(image).digest('hex'),
      viewport: { width: view.width + 64, height: 1000, deviceScaleFactor: 1.5 },
      imageSize: { width: Math.round(metrics.width * 1.5), height: Math.round(metrics.height * 1.5) },
      canvasZoom: 1, nodeTitleCssPx: Math.min(...metrics.cards.map(card => card.font)),
      nodeIds: view.nodes.map(node => node.id), edgeCount: view.edges.length,
      ...(view.groupId ? { groupId: view.groupId } : {}), ...(view.selected ? { selectedNodeIds: view.selected } : {}) });
    console.log(`Captured ${view.filename}: ${metrics.cards.length} readable nodes, no overlap/clipping`);
  }
  const manifest = data.records.filter(record => captures.has(record.screenshot)).map(record => ({ ...record,
    ...captures.get(record.screenshot), details: record.details.filter(detail => captures.has(detail.screenshot)).map(detail => ({ ...detail, ...captures.get(detail.screenshot) })),
    capture: 'Isolated documentation presentation using actual CanvasWorld / CanvasNodes / CanvasEdges and semantic adapter/router; export + generic import validated; custom print card sizing/layout; no backend or model execution',
    frontendCommit: data.frontendCommit, captureDate: new Date().toISOString().slice(0, 10), browserVersion: browser.version(),
    captureSources: data.captureSources }));
  await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await context.close();
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
