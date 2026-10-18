import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentContextSources, publishAgentContextIndex } from "../src/agent-context-index.js";
import { ContextIndexOrganizer, validateContextOrganization, type ContextOrganizationJob } from "../src/context-index-organizer.js";
import type { SessionRef } from "../src/harness-runtime/contracts.js";

const roots: string[] = [], managers: ContextIndexOrganizer[] = [];
afterEach(async () => { await Promise.all(managers.splice(0).map(manager => manager.close()));
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "context-organization-")); roots.push(projectPath);
  const stage = path.join(projectPath, "runtime", "temporary-chat"); await fs.mkdir(stage, { recursive: true });
  const manager = new ContextIndexOrganizer(); managers.push(manager);
  const sources = new AgentContextSources();
  sources.list("experiments", "Experiment results", Array.from({ length: 65 }, (_, index) => ({ id: `exp-${index}`, status: "completed", output: `original-${index}` })));
  const publish = () => publishAgentContextIndex(path.join(stage, "Inbox.md"), sources.sources,
    { lookup: manager.lookup("project", projectPath) });
  return { projectPath, stage, manager, sources, publish };
}
const organize = (job: ContextOrganizationJob) => ({ summary: `Explainer summary for ${job.children.length} items`,
  items: job.children.map(child => ({ id: child.id, summary: `Explainer result ${child.metadata.id ?? child.id}` })),
  groups: [job.children.slice(0, 5), job.children.slice(5)].filter(group => group.length).map((group, index) => ({
    summary: `Explainer topic ${index}`, members: group.map(child => child.id) })) });

describe("Project Explainer context organization", () => {
  it("retains exact source coverage when the organizer chooses topic groups", async () => {
    const f = await fixture();
    f.manager.configure(async job => organize(job));
    await f.publish(); await f.manager.drain();
    const index = (await f.publish())!;
    expect(index.preview).toContain("Explainer");
    const catalog = JSON.parse(await fs.readFile(index.indexPath, "utf8"));
    const found: string[] = [];
    const visit = async (file: string): Promise<void> => {
      const node = JSON.parse(await fs.readFile(path.join(f.stage, file), "utf8"));
      for (const child of node.entries) {
        if (child.detail) found.push(JSON.parse(await fs.readFile(path.join(f.stage, child.detail.path), "utf8")).id);
        else await visit(child.path);
      }
    };
    await visit(catalog.entries[0].tree.path);
    expect(found).toHaveLength(65); expect(new Set(found).size).toBe(65);
  });

  it("reuses summaries across turns and process restarts without re-running unchanged groups", async () => {
    const f = await fixture(), call = vi.fn(async (job: ContextOrganizationJob) => organize(job));
    f.manager.configure(call); await f.publish(); await f.manager.drain();
    const count = call.mock.calls.length; expect(count).toBeGreaterThan(0);
    await f.publish(); await f.manager.drain(); expect(call).toHaveBeenCalledTimes(count);
    const next = new ContextIndexOrganizer(); managers.push(next); next.configure(call);
    await publishAgentContextIndex(path.join(f.stage, "next.md"), f.sources.sources, { lookup: next.lookup("project", f.projectPath) });
    await next.drain(); expect(call).toHaveBeenCalledTimes(count);
  });

  it("preserves background input when a temporary chat snapshot is removed", async () => {
    const f = await fixture(); let ready!: () => void;
    const gate = new Promise<void>(resolve => { ready = resolve; });
    const observed: string[] = [];
    f.manager.configure(async job => {
      await gate;
      for (const child of job.children) observed.push(await fs.readFile(path.join(job.baseDirectory, child.path), "utf8"));
      return organize(job);
    });
    await f.publish(); await fs.rm(f.stage, { recursive: true }); ready(); await f.manager.drain();
    expect(observed.some(text => text.includes("original-0"))).toBe(true);
    expect(observed.some(text => text.includes("original-64"))).toBe(true);
  });

  it("retains nested directory references before temporary snapshots are removed", async () => {
    const f = await fixture(); let ready!: () => void;
    const gate = new Promise<void>(resolve => { ready = resolve; });
    f.sources.sources[0].records = Array.from({ length: 250 }, (_, index) => ({ id: `exp-${index}`.padEnd(250, "x"),
      name: "历史实验名称".repeat(200), agentId: "a".repeat(120), path: "p".repeat(500), status: "completed", output: `original-${index}` }));
    const observed: string[] = [];
    f.manager.configure(async job => {
      await gate;
      const visit = async (relative: string): Promise<void> => {
        const value = JSON.parse(await fs.readFile(path.join(job.baseDirectory, relative), "utf8"));
        if (/^context-index-/.test(value.kind ?? "")) for (const child of value.entries) await visit(child.path);
        else observed.push(value.output);
      };
      for (const child of job.children) await visit(child.path);
      return organize(job);
    });
    await f.publish(); await fs.rm(f.stage, { recursive: true }); ready(); await f.manager.drain();
    expect(observed).toContain("original-0"); expect(observed).toContain("original-249");
    expect(new Set(observed).size).toBe(250);
  });

  it("continues with an expandable factual index when summaries fail or omit source records", async () => {
    const f = await fixture();
    f.manager.configure(async job => ({ ...organize(job), items: [] }));
    const first = (await f.publish())!; await f.manager.drain();
    const second = (await f.publish())!;
    expect(second.preview).toContain("Context index:"); expect(second.preview).not.toContain("Explainer result");
    expect(JSON.parse(await fs.readFile(first.indexPath, "utf8")).entries[0].total).toBe(65);
  });

  it("does not acknowledge preparation/failure, and persists successful delivery per native session", async () => {
    const f = await fixture(), index = (await f.publish())!;
    const session: SessionRef = { schemaVersion: 1, harnessId: "codex", adapterVersion: "1", nativeId: "session-1", generation: 0,
      durable: true, createdAt: "2026-10-18T00:00:00Z" };
    const unsent = await f.manager.delivery(index, f.projectPath, "main", session);
    const retried = await f.manager.delivery(index, f.projectPath, "main", session);
    expect(unsent?.preview).toBe(retried?.preview); expect(retried?.preview).not.toContain("unchanged;");
    await f.manager.acknowledge(index, f.projectPath, "main", session);
    const restarted = new ContextIndexOrganizer(); managers.push(restarted);
    const delivered = (await restarted.delivery(index, f.projectPath, "main", session))!;
    expect(delivered.preview).toContain("unchanged;"); expect(delivered.preview).not.toContain('"id":"exp-64"');
    expect(delivered.preview).toContain(index.indexPath);
    expect((await restarted.delivery(index, f.projectPath, "main", { ...session, nativeId: "session-2" }))?.preview).not.toContain("unchanged;");
  });

  it("rejects invented, duplicate and missing membership rather than trusting a model's completeness claim", () => {
    const children = [{ id: "a", metadata: {}, path: "a", total: 1 }, { id: "b", metadata: {}, path: "b", total: 1 }];
    const base = { summary: "all", items: [{ id: "a", summary: "a" }, { id: "b", summary: "b" }] };
    for (const members of [["a"], ["a", "a", "b"], ["a", "b", "invented"]])
      expect(() => validateContextOrganization({ ...base, groups: [{ summary: "all", members }] }, children)).toThrow();
  });

  it("keeps immutable summaries cached when a new result is prepended to a newest-first provider list", async () => {
    const f = await fixture(), call = vi.fn(async (job: ContextOrganizationJob) => organize(job));
    f.manager.configure(call); await f.publish(); await f.manager.drain();
    const previous = call.mock.calls.length;
    f.sources.sources[0].records.unshift({ id: "new-result", status: "completed", createdAt: "2026-10-18T01:00:00Z", output: "new evidence" });
    await f.publish(); await f.manager.drain();
    expect(call.mock.calls.length - previous).toBeLessThanOrEqual(2);
  });
});
