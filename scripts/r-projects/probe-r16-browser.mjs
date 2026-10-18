import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertBinding, sha256 } from "./catalog.mjs";

const repo = fileURLToPath(new URL("../../", import.meta.url)), exec = promisify(execFile);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fixture = `<!doctype html><meta charset="utf-8"><title>Independent browser capability probe</title>
<style>body{font:20px sans-serif;background:#f2f4f8;padding:30px}button{padding:12px}#node{position:absolute;left:80px;top:300px;padding:25px;background:#ccdfff;touch-action:none;cursor:grab}svg{position:absolute;top:470px;left:60px}</style>
<h1>Independent browser capability probe</h1><p>Local browser fixture. No project page or runtime acceptance.</p>
<button id="expand" aria-expanded="false">Expand probe</button><div id="details" hidden>Rendered and clicked in Chromium</div>
<div id="node">Drag probe</div><svg width="600" height="100"><path id="path" d="M 0 40 L 400 40" stroke="#456" fill="none"/>
<circle id="moving" r="8" fill="#1769aa"><animateMotion dur="1s" repeatCount="indefinite"><mpath href="#path"/></animateMotion></circle></svg>
<script>
document.querySelector('#expand').onclick=e=>{e.target.setAttribute('aria-expanded','true');document.querySelector('#details').hidden=false;};
const node=document.querySelector('#node');let drag;
node.onpointerdown=e=>{drag={x:e.clientX,y:e.clientY,left:node.offsetLeft,top:node.offsetTop};node.setPointerCapture(e.pointerId);};
node.onpointermove=e=>{if(drag){node.style.left=drag.left+e.clientX-drag.x+'px';node.style.top=drag.top+e.clientY-drag.y+'px';}};
node.onpointerup=()=>{drag=undefined;};
</script>`;

/** This is browser availability evidence only. A real R16 project must still
 * be observed independently after service/start prerequisites are satisfied. */
export async function probeBrowser({ moduleFile, executable, output }) {
  const { chromium } = await import(pathToFileURL(path.resolve(moduleFile)).href);
  const browser = await chromium.launch({ headless: true, executablePath: path.resolve(executable) });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 650 } });
    page.setDefaultTimeout(10_000);
    const errors = []; page.on("pageerror", (error) => errors.push(error.message));
    await page.setContent(fixture);
    await page.getByRole("button", { name: "Expand probe" }).click();
    const expanded = await page.locator("#details").isVisible();
    assert.equal(expanded, true, "Browser click did not expand the fixture");
    const before = await page.locator("#node").boundingBox();
    assert.ok(before, "Browser did not render the drag target");
    await page.mouse.move(before.x + 30, before.y + 20); await page.mouse.down();
    await page.mouse.move(before.x + 130, before.y + 80, { steps: 10 }); await page.mouse.up();
    const after = await page.locator("#node").boundingBox();
    assert.ok(after && after.x - before.x >= 90 && after.y - before.y >= 50, "Browser pointer drag was not observed");
    const motionBefore = await page.locator("#moving").evaluate((node) => node.getCTM().e);
    await page.waitForFunction((start) => Math.abs(document.querySelector("#moving").getCTM().e - start) > 15, motionBefore);
    const motionAfter = await page.locator("#moving").evaluate((node) => node.getCTM().e);
    assert.deepEqual(errors, [], "Browser fixture raised a page error");
    await page.screenshot({ path: path.join(output, "capability.png") });
    const observation = { schemaVersion: 1, at: new Date().toISOString(), scope: "local-browser-capability-only",
      version: browser.version(), userAgent: await page.evaluate(() => navigator.userAgent), expanded, drag: { before, after },
      motion: { before: motionBefore, after: motionAfter }, pageErrors: errors };
    await fs.writeFile(path.join(output, "observation.json"), JSON.stringify(observation, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    return observation;
  } finally { await browser.close(); }
}

export async function verifyR16BrowserObserver({ observer, manifest, entry, head, readArtifact }) {
  assert.equal(observer.status, "available"); assert.equal(observer.runId, manifest.binding.runId);
  assert.equal(observer.commit, head, "R16 browser observer belongs to another source commit");
  assert.equal(observer.manifestSha256, sha256(manifest), "R16 browser observer belongs to another manifest");
  assert.equal(observer.payloadSha256, entry.payloadSha256);
  assert.equal(observer.scope, "local-browser-capability-only", "Browser capability cannot substitute for live R16 UI acceptance");
  assert.ok(observer.command?.argv?.length && observer.command.env, "Missing reproducible browser command");
  await readArtifact(observer.browserExecutable, false); await readArtifact(observer.playwrightModule, false);
  await readArtifact(observer.screenshot, false);
  const observation = await readArtifact(observer.observation);
  assert.equal(observation.scope, observer.scope); assert.equal(observation.version, observer.browserVersion);
  assert.ok(observation.version && /Chrom(e|ium)/.test(observation.userAgent), "No actual Chromium observation");
  assert.equal(observation.expanded, true); assert.deepEqual(observation.pageErrors, []);
  assert.ok(observation.drag?.after?.x - observation.drag?.before?.x >= 90 &&
    observation.drag?.after?.y - observation.drag?.before?.y >= 50, "No actual browser pointer drag");
  assert.ok(Math.abs(observation.motion?.after - observation.motion?.before) > 15, "No actual browser animation observation");
}

async function main() {
  const args = process.argv.slice(2), value = (flag) => args[args.indexOf(flag) + 1];
  for (const flag of ["--input", "--output", "--module", "--executable"]) assert.ok(args.includes(flag) && value(flag), `Missing ${flag}`);
  const directory = path.resolve(value("--input")), output = path.resolve(value("--output"));
  const moduleFile = path.resolve(value("--module")), executable = path.resolve(value("--executable"));
  const manifest = JSON.parse(await fs.readFile(path.join(directory, "manifest.json"), "utf8")); assertBinding(manifest.binding);
  const entry = manifest.cases.find((e) => e.code === "R16");
  assert.ok(entry && entry.payloadSha256 === sha256(entry.payload), "R16 payload provenance mismatch");
  const git = async (...gitArgs) => (await exec("git", gitArgs, { cwd: repo })).stdout.trim();
  const head = await git("rev-parse", "HEAD"); assert.equal(await git("status", "--porcelain"), "", "Commit observer source before creating readiness evidence");
  await fs.mkdir(output, { mode: 0o700 });
  const observation = await probeBrowser({ moduleFile, executable, output });
  assert.equal(await git("rev-parse", "HEAD"), head); assert.equal(await git("status", "--porcelain"), "");
  const ref = async (file) => ({ path: path.relative(directory, file), sha256: hash(await fs.readFile(file)) });
  const observer = { schemaVersion: 1, status: "available", scope: observation.scope, runId: manifest.binding.runId,
    commit: head, manifestSha256: sha256(manifest), payloadSha256: entry.payloadSha256, browserVersion: observation.version,
    command: { argv: [process.execPath, fileURLToPath(import.meta.url), ...args], env: {
      ...(process.env.LD_LIBRARY_PATH ? { LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH } : {}),
      ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH } : {}) } },
    browserExecutable: await ref(executable), playwrightModule: await ref(moduleFile),
    screenshot: await ref(path.join(output, "capability.png")), observation: await ref(path.join(output, "observation.json")),
    observationLimit: "Browser availability on a local fixture only. R16's actual invocation counts, modal drag, edge direction and authoritative runtime/event agreement remain unverified." };
  await verifyR16BrowserObserver({ observer, manifest, entry, head, readArtifact: async (reference, parse = true) => {
    const bytes = await fs.readFile(path.resolve(directory, reference.path)); assert.equal(hash(bytes), reference.sha256);
    return parse ? JSON.parse(bytes.toString("utf8")) : bytes;
  } });
  await fs.writeFile(path.join(output, "observer.json"), JSON.stringify(observer, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ status: observer.status, observer: path.join(output, "observer.json"), scope: observer.scope }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
