/** Run against an isolated Vite dev server, never the live project service.
 * node acceptance/run-scoped-canvas.mjs /absolute/playwright/index.mjs <url> <output-dir> [expected-sha]
 * Playwright is optional acceptance tooling, not a production dependency. */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
const [entry, base = "http://127.0.0.1:54173", output = "/tmp/openfars-canvas-acceptance", expectedSha] = process.argv.slice(2);
if (!entry) throw new Error("Pass an absolute Playwright module path");
const repository = fileURLToPath(new URL("../../", import.meta.url));
const git = (...args) => execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
const sourceSha = git("rev-parse", "HEAD");
const sourceTrackedDirty = Boolean(git("status", "--porcelain", "--untracked-files=no"));
if (expectedSha) { assert.equal(sourceSha, expectedSha); assert.equal(sourceTrackedDirty, false); }
const { chromium } = await import(pathToFileURL(entry).href);
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1800, height: 1100 }, locale: "zh-CN" });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.route("**/*", (route) => new URL(route.request().url()).origin === new URL(base).origin
  ? route.continue() : route.abort());
await mkdir(output, { recursive: true });
// An SVG group's bounding-box centre can lie on a node rather than its curve.
// Find a genuinely exposed point on the hit path, then use a real pointer click.
async function clickEdge(edge) {
  await edge.waitFor({ state: "visible" });
  const point = await edge.evaluate((element) => {
    const curve = element.querySelector(".edge-hit");
    const matrix = curve?.getScreenCTM();
    if (!curve || !matrix) return undefined;
    const length = curve.getTotalLength();
    for (let index = 10; index <= 90; index += 2) {
      const local = curve.getPointAtLength(length * index / 100);
      const screen = new DOMPoint(local.x, local.y).matrixTransform(matrix);
      if (document.elementFromPoint(screen.x, screen.y)?.closest("[data-edge-id]") === element)
        return { x: screen.x, y: screen.y };
    }
    return undefined;
  });
  assert.ok(point, "The edge must have an exposed, clickable curve");
  await page.mouse.click(point.x, point.y);
}
async function layout(scoped, label, menuLabel = label) {
  const direct = scoped.getByRole("button", { name: label, exact: true });
  if (await direct.isVisible()) await direct.click();
  else {
    await scoped.getByRole("button", { name: "更多布局操作", exact: true }).click();
    await scoped.getByRole("menuitem", { name: menuLabel, exact: true }).click();
  }
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
try {
  await page.goto(`${base}/acceptance/scoped-canvas.html`);
  await page.locator('[data-node-id="G"]').click();
  await page.getByRole("button", { name: "进入组内 Workflow", exact: true }).click();
  const scoped = page.getByLabel("Research 组内 Workflow 编辑器", { exact: true });
  await layout(scoped, "适应画布");
  await scoped.locator('[data-node-id="input"]').getByText("进入协作组", { exact: true }).waitFor();
  await scoped.locator('[data-node-id="finish"]').getByText("结束协作组", { exact: true }).waitFor();
  const ids = await page.evaluate(() => window.__openfarsAcceptance.ids);
  const parallel = scoped.locator("[data-edge-id].is-parallel");
  assert.equal(await parallel.count(), 3);
  await scoped.locator('[data-node-id="finish"]').click();
  await clickEdge(parallel.first());
  assert.equal(await scoped.locator("[data-edge-id].is-parallel.is-selected").count(), 3);
  await scoped.locator('[data-node-id="input"]').click();
  assert.equal(await scoped.locator("[data-edge-id].is-parallel.is-selected").count(), 3);
  await scoped.locator('[data-node-id="finish"]').click();
  const incoming = await page.evaluate(() => {
    const { orchestration } = window.__openfarsAcceptance;
    return Object.values(orchestration.scopedWorkflow.groups.find((item) => item.id === "G").workflow.routes).flat().filter((edge) => edge.target === "finish").length;
  });
  assert.equal(await scoped.locator("[data-edge-id].is-selected").count(), incoming);
  await clickEdge(scoped.locator('[data-loop-id="verification"][data-loop-role="member"]').first());
  await scoped.getByRole("spinbutton", { name: "Loop 每批迭代数", exact: true }).fill("3");
  assert.equal(await page.evaluate(() => window.__openfarsAcceptance.orchestration.scopedWorkflow.groups.find((item) => item.id === "G").workflow.loops[0].maxIterations), 3);
  await scoped.getByRole("button", { name: "撤销", exact: true }).click();
  assert.equal(await page.evaluate(() => window.__openfarsAcceptance.orchestration.scopedWorkflow.groups.find((item) => item.id === "G").workflow.loops[0].maxIterations), 2);
  await clickEdge(scoped.locator(`[data-edge-source="${ids.review}"][data-edge-target="H"]`));
  await scoped.getByRole("button", { name: "弱边", exact: true }).last().click();
  assert.equal(await page.evaluate((node) => window.__openfarsAcceptance.orchestration.scopedWorkflow.groups.find((item) => item.id === "G").workflow.routes[node][0].kind, ids.review), "weak");
  await page.screenshot({ path: path.join(output, "scoped-edge-kinds.png"), fullPage: true });
  await scoped.getByRole("button", { name: "撤销", exact: true }).click();
  assert.equal(await page.evaluate((node) => window.__openfarsAcceptance.orchestration.scopedWorkflow.groups.find((item) => item.id === "G").workflow.routes[node][0].kind, ids.review), "strong");
  await scoped.locator(`[data-node-id="${ids.idea}"]`).click();
  await page.getByRole("textbox", { name: "Agent 指令", exact: true }).fill("Browser-verified shared standing instructions");
  await page.getByRole("textbox", { name: "Agent 指令", exact: true }).blur();
  const confirmation = page.getByRole("dialog", { name: "确认修改共享 Agent" });
  await confirmation.getByRole("button", { name: "取消", exact: true }).click();
  assert.notEqual(await page.evaluate(() => window.__openfarsAcceptance.agents.idea.instructions), "Browser-verified shared standing instructions");
  await page.getByRole("textbox", { name: "Agent 指令", exact: true }).fill("Browser-verified shared standing instructions");
  await page.getByRole("textbox", { name: "Agent 指令", exact: true }).blur();
  await confirmation.getByRole("button", { name: "应用到所有引用", exact: true }).click();
  assert.equal(await page.evaluate(() => window.__openfarsAcceptance.agents.idea.instructions), "Browser-verified shared standing instructions");
  await scoped.locator('[data-node-id="H"]').click();
  await scoped.getByRole("button", { name: "进入 Review team", exact: true }).click();
  await page.getByLabel("Review team 组内 Workflow 编辑器", { exact: true }).waitFor();
  await page.getByRole("button", { name: "返回父图", exact: true }).click();
  await scoped.waitFor();
  await layout(scoped, "智能整理布局", "智能整理");
  await page.waitForFunction(() => document.querySelector('[aria-label="Research 组内 Workflow 编辑器"] button[aria-label="智能整理布局"]')?.disabled !== true);
  await layout(scoped, "适应画布");
  await page.screenshot({ path: path.join(output, "scoped-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 1200, height: 900 });
  await layout(scoped, "适应画布");
  assert.equal(await parallel.count(), 3);
  await page.screenshot({ path: path.join(output, "scoped-compact.png"), fullPage: true });
  await page.getByRole("button", { name: "返回父图", exact: true }).click();
  await page.locator('[data-node-id="idea"]').click();
  assert.equal(await page.getByRole("textbox", { name: "Agent 指令", exact: true }).inputValue(), "Browser-verified shared standing instructions");
  assert.deepEqual(errors, []);
  assert.equal(git("rev-parse", "HEAD"), sourceSha, "Source commit changed during acceptance");
  assert.equal(Boolean(git("status", "--porcelain", "--untracked-files=no")), sourceTrackedDirty, "Tracked source state changed during acceptance");
  const captures = await Promise.all(["scoped-desktop.png", "scoped-compact.png", "scoped-edge-kinds.png"].map(async (filename) => {
    const data = await readFile(path.join(output, filename));
    return { filename, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") };
  }));
  const manifest = { kind: "scoped-shared-canvas-browser-v1", status: "passed", sourceSha, sourceTrackedDirty,
    capturedAt: new Date().toISOString(), checks: ["shared canvas", "Input/Finish labels", "3 parallel edges and bundled selection", "Loop editing and undo", "edge editing and undo", "shared Agent cancel/apply", "nested breadcrumbs", "desktop/compact layout", "outer Agent config persistence"],
    viewports: [{ width: 1800, height: 1100 }, { width: 1200, height: 900 }], captures, errors, output };
  await writeFile(path.join(output, "scoped-canvas-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify({ ...manifest, captures: captures.map((capture) => capture.filename) }));
} catch (error) {
  await page.screenshot({ path: path.join(output, "scoped-failure.png"), fullPage: true });
  throw error;
} finally { await browser.close(); }
