import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { codexNativeSessionHome, readCodexNativeNotification } from "../src/harness-runtime/adapters/codex-native-input-history.js";
import type { SessionRef } from "../src/harness-runtime/contracts.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
const session: SessionRef = { schemaVersion: 1, harnessId: "codex", nativeId: "01a1220c-aaa6-78c1-b64b-de7b3ef8b27f",
  adapterVersion: "1", generation: 1, durable: true, createdAt: "2026-10-09T19:03:37.899Z" };
async function fixture() {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "codex-input-history-")); roots.push(projectPath);
  const workspacePath = path.join(projectPath, "workspaces"); await fs.mkdir(workspacePath);
  const home = codexNativeSessionHome(projectPath, "experimenter");
  const directory = path.join(home, "sessions", "2026", "10", "09"); await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, `rollout-2026-10-09T19-03-37-${session.nativeId}.jsonl`);
  const notification = "SII system notification (actual-result-batch). " + "complete-known-result-".repeat(2200);
  const meta = { timestamp: session.createdAt, type: "session_meta", payload: { id: session.nativeId, cwd: workspacePath, source: "exec" } };
  const user = { timestamp: "2026-10-09T19:03:38.899Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `Original instruction\n${notification}\nOriginal task` }] } };
  const write = async (rows: unknown[] = [meta, user], finalNewline = true) => fs.writeFile(file, rows.map(row => JSON.stringify(row)).join("\n") + (finalNewline ? "\n" : ""));
  await write();
  return { projectPath, workspacePath, home, directory, file, notification, meta, user, write,
    input: { projectPath, workspacePath, agentId: "experimenter", session, notification } };
}

it("reads the complete exact native user row and records its real byte offset and digest without writing the rollout", async () => {
  const f = await fixture(); const bytes = await fs.readFile(f.file);
  const proof = await readCodexNativeNotification(f.input);
  expect(proof).toEqual({ session, history: { relativePath: path.relative(f.home, f.file), byteOffset: Buffer.byteLength(JSON.stringify(f.meta) + "\n"),
    sha256: createHash("sha256").update(JSON.stringify(f.user)).digest("hex"), nativeTimestamp: f.user.timestamp } });
  expect(await fs.readFile(f.file)).toEqual(bytes);
});

it.each(["session", "cwd", "agent", "harness", "ephemeral", "unsafe_id", "assistant", "reasoning", "partial", "truncated", "stale_batch", "timestamp", "duplicate", "symlink_file", "symlink_parent", "hardlink"] as const)(
  "refuses ambiguous, stale or foreign native history (%s)", async mode => {
    const f = await fixture(); const input = structuredClone(f.input);
    if (mode === "session") f.meta.payload.id = "01a1220c-aaa6-78c1-b64b-de7b3ef8b270";
    if (mode === "cwd") f.meta.payload.cwd = path.dirname(f.workspacePath);
    if (mode === "agent") input.agentId = "another-agent";
    if (mode === "harness") input.session.harnessId = "pi";
    if (mode === "ephemeral") input.session.durable = false;
    if (mode === "unsafe_id") input.session.nativeId = "../../other-thread";
    if (mode === "assistant") f.user.payload.role = "assistant";
    if (mode === "reasoning") f.user.payload.type = "reasoning";
    if (mode === "truncated") f.user.payload.content[0]!.text = f.notification.slice(0, 40000);
    if (mode === "stale_batch") f.user.payload.content[0]!.text = f.notification.replace("actual-result-batch", "old-result-batch");
    if (mode === "timestamp") f.user.timestamp = "not-a-native-timestamp";
    await f.write([f.meta, f.user], mode !== "partial");
    if (mode === "duplicate") await fs.copyFile(f.file, path.join(f.directory, `rollout-other-${session.nativeId}.jsonl`));
    if (mode === "hardlink") await fs.link(f.file, path.join(f.projectPath, "external-link.jsonl"));
    if (mode === "symlink_file") { const original = path.join(f.projectPath, "other-history.jsonl"); await fs.rename(f.file, original); await fs.symlink(original, f.file); }
    if (mode === "symlink_parent") { const original = path.join(f.projectPath, "other-sessions"); await fs.rename(path.join(f.home, "sessions"), original); await fs.symlink(original, path.join(f.home, "sessions")); }
    expect(await readCodexNativeNotification(input)).toBeUndefined();
  });

it("ignores incomplete tail bytes and inspects a bounded tail after a large unrelated native record", async () => {
  const f = await fixture();
  await f.write([f.meta, { type: "unrelated", value: "x".repeat(9 * 1024 * 1024) }, f.user]);
  await fs.appendFile(f.file, '{"type":"response_item","payload":');
  const proof = await readCodexNativeNotification(f.input);
  expect(proof?.history.sha256).toBe(createHash("sha256").update(JSON.stringify(f.user)).digest("hex"));
  expect(proof!.history.byteOffset).toBeGreaterThan(9 * 1024 * 1024);
});

it("matches the same redacted native input as the event observer while retaining only a digest", async () => {
  const f = await fixture();
  f.user.payload.content[0]!.text = "SII actual input api_key=secret-value-123456789";
  await f.write();
  const proof = await readCodexNativeNotification({ ...f.input, notification: "SII actual input api_key=[REDACTED]" });
  expect(proof).toBeDefined();
  expect(JSON.stringify(proof)).not.toContain("secret-value");
});
