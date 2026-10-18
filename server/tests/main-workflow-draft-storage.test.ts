import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectStorage } from "../src/storage.js";
import { EventHub } from "../src/event-hub.js";
import { cloneAgentOrchestrationTemplate } from "../src/agent-orchestration.js";
import { mergeAgentConfigs } from "../src/validation.js";
import { MAIN_AGENT_ORCHESTRATION_CURRENT_FILE, MAIN_AGENT_ORCHESTRATION_FILE,
  mainAgentOrchestrationDocument, parseAgentOrchestrationProposal } from "../src/agent-orchestration-reconfiguration.js";
import { scanWorkspace } from "../src/workspace-checkpoint.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(tmpdir(), "openfars-main-draft-")); roots.push(root);
  const storage = new ProjectStorage(root, new EventHub()), projectId = `prj_${"6".repeat(32)}`;
  const orchestration = cloneAgentOrchestrationTemplate(), agents = mergeAgentConfigs(undefined, orchestration);
  orchestration.allowMainReconfiguration = true;
  const original = mainAgentOrchestrationDocument(projectId, orchestration, agents);
  const workspace = await storage.roleWorkspace(projectId, "main", "inv_original_main_draft");
  const draft = path.join(workspace, MAIN_AGENT_ORCHESTRATION_FILE), current = path.join(workspace, MAIN_AGENT_ORCHESTRATION_CURRENT_FILE);
  const changedAgents = structuredClone(agents); changedAgents.main.instructions = "Current accepted Main instructions";
  const changed = mainAgentOrchestrationDocument(projectId, orchestration, changedAgents);
  const refresh = (document = original, writer = storage) => writer.writeMainAgentOrchestrationSnapshot(projectId, MAIN_AGENT_ORCHESTRATION_FILE, document);
  return { root, projectId, storage, orchestration, agents, changedAgents, original, changed, workspace, draft, current, refresh };
}

describe("Main's retained authoring draft and separate current configuration reference", () => {
  it("publishes a management reference in the assigned original cwd while preserving its exact authoring file", async () => {
    const f = await fixture(); await f.refresh();
    const bytes = Buffer.from(" unfinished original management draft\n"); await fs.writeFile(f.draft, bytes);
    await f.storage.writeManagementWorkflowCurrentSnapshot(f.workspace, f.changed, () => true);
    expect(await fs.readFile(f.draft)).toEqual(bytes);
    expect(JSON.parse(await fs.readFile(f.current, "utf8"))).toEqual(f.changed);
    await f.storage.writeManagementWorkflowCurrentSnapshot(f.workspace, f.original, () => false);
    expect(JSON.parse(await fs.readFile(f.current, "utf8"))).toEqual(f.changed);
  });

  it("rejects an alias of the assigned management cwd without publishing a current reference", async () => {
    const f = await fixture(), alias = path.join(f.root, "management-alias");
    await fs.symlink(f.workspace, alias);
    await expect(f.storage.writeManagementWorkflowCurrentSnapshot(alias, f.changed)).rejects.toThrow(/original canonical workspace/);
    await expect(fs.stat(f.current)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates the original draft once and keeps the current reference outside recoverable business output", async () => {
    const f = await fixture(); expect(await f.refresh()).toBe(f.draft);
    expect(JSON.parse(await fs.readFile(f.draft, "utf8"))).toEqual(f.original);
    expect(JSON.parse(await fs.readFile(f.current, "utf8"))).toEqual(f.original);
    expect((await scanWorkspace(f.workspace)).files.some(file => file.path === MAIN_AGENT_ORCHESTRATION_CURRENT_FILE)).toBe(false);
  });

  it("preserves exact unsent edits and their old base across a configuration change and a new storage instance", async () => {
    const f = await fixture(); await f.refresh();
    const proposal = structuredClone(f.original); proposal.agents.main.instructions = "Original unfinished 中文 edits\nwith intentional formatting";
    const bytes = Buffer.from(`  ${JSON.stringify(proposal)}\n\n`); await fs.writeFile(f.draft, bytes); const stamp = await fs.stat(f.draft);
    await f.refresh(f.changed); const reopened = new ProjectStorage(f.root, new EventHub()); await f.refresh(f.changed, reopened);
    expect(await fs.readFile(f.draft)).toEqual(bytes);
    expect(await fs.stat(f.draft)).toMatchObject({ ino: stamp.ino, mtimeMs: stamp.mtimeMs, size: stamp.size });
    expect(JSON.parse(await fs.readFile(f.current, "utf8"))).toEqual(f.changed);
    expect(() => parseAgentOrchestrationProposal(bytes.toString("utf8"), f.projectId, f.orchestration, f.changedAgents)).toThrow("workflow.json is stale");
    // Only Main's explicit authoring action changes the draft/base.
    const reconciled = JSON.parse(await fs.readFile(f.current, "utf8")); reconciled.agents.main.instructions = proposal.agents.main.instructions;
    await fs.writeFile(f.draft, JSON.stringify(reconciled));
    expect(parseAgentOrchestrationProposal(await fs.readFile(f.draft, "utf8"), f.projectId, f.orchestration, f.changedAgents).agents.main.instructions).toBe(proposal.agents.main.instructions);
  });

  it("preserves even a partial invalid draft rather than replacing unfinished authoring work", async () => {
    const f = await fixture(), partial = Buffer.from('{ "schemaVersion": 2, "unfinished": "原始草稿');
    await fs.writeFile(f.draft, partial); await f.refresh(f.changed);
    expect(await fs.readFile(f.draft)).toEqual(partial);
    expect(JSON.parse(await fs.readFile(f.current, "utf8"))).toEqual(f.changed);
  });

  it("updates the accepted read reference without creating an authoring file outside a Main call", async () => {
    const f = await fixture(); await f.storage.writeMainAgentOrchestrationCurrentSnapshot(f.projectId, f.changed);
    await expect(fs.stat(f.draft)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await fs.readFile(f.current, "utf8"))).toEqual(f.changed);
  });

  it("serializes overlapping reference writes and checks a queued old writer against current authority before it can replace a newer reference", async () => {
    const f = await fixture(); await f.refresh(); const draft = await fs.readFile(f.draft);
    let release!: () => void, entered!: () => void, authority = 1, block = true;
    const blocked = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      if (destination === f.current && block) { block = false; entered(); await blocked; }
      return rename(source, destination);
    });
    const old = f.storage.writeMainAgentOrchestrationCurrentSnapshot(f.projectId, f.original, () => authority === 1);
    await ready; authority = 2;
    const current = f.storage.writeMainAgentOrchestrationCurrentSnapshot(f.projectId, f.changed, () => authority === 2);
    const lateOld = f.storage.writeMainAgentOrchestrationCurrentSnapshot(f.projectId, f.original, () => authority === 1);
    release(); await Promise.all([old, current, lateOld]);
    expect(JSON.parse(await fs.readFile(f.current, "utf8"))).toEqual(f.changed); expect(await fs.readFile(f.draft)).toEqual(draft);
  });

  it.each(["symlink", "hardlink", "directory"])("rejects a %s draft without writing through or replacing it", async kind => {
    const f = await fixture(), outside = path.join(f.root, "original-outside.txt"); await fs.writeFile(outside, "Original outside bytes");
    if (kind === "symlink") await fs.symlink(outside, f.draft);
    else if (kind === "hardlink") await fs.link(outside, f.draft);
    else await fs.mkdir(f.draft);
    await expect(f.refresh()).rejects.toThrow("canonical regular file");
    expect(await fs.readFile(outside, "utf8")).toBe("Original outside bytes");
    expect((await fs.lstat(f.draft)).isSymbolicLink()).toBe(kind === "symlink");
  });

  it.each(["directory", "file"])("rejects a redirected current-reference %s and preserves the draft and external content", async target => {
    const f = await fixture(); await f.refresh(); const draft = await fs.readFile(f.draft);
    const outside = path.join(f.root, "external-current"); await fs.mkdir(outside); const externalFile = path.join(outside, "workflow-current.json"); await fs.writeFile(externalFile, "Original external reference");
    if (target === "directory") { await fs.rm(path.dirname(f.current), { recursive: true }); await fs.symlink(outside, path.dirname(f.current)); }
    else { await fs.unlink(f.current); await fs.symlink(externalFile, f.current); }
    await expect(f.refresh(f.changed)).rejects.toThrow(/canonical/);
    expect(await fs.readFile(f.draft)).toEqual(draft); expect(await fs.readFile(externalFile, "utf8")).toBe("Original external reference");
  });

  it("retains a concurrently created draft when exclusive initialization loses the race", async () => {
    const f = await fixture(), write = fs.writeFile.bind(fs), bytes = Buffer.from("Concurrent original Main edits");
    vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
      if (args[0] === f.draft && typeof args[2] === "object" && args[2]?.flag === "wx") await write(f.draft, bytes);
      return write(...args);
    });
    await f.refresh(); expect(await fs.readFile(f.draft)).toEqual(bytes);
    expect(JSON.parse(await fs.readFile(f.current, "utf8"))).toEqual(f.original);
  });

  it("keeps both the original draft and complete prior reference when atomic refresh fails, then retries without rebasing", async () => {
    const f = await fixture(); await f.refresh();
    const draft = Buffer.from("Original Main unfinished draft"); await fs.writeFile(f.draft, draft); const current = await fs.readFile(f.current);
    const rename = fs.rename.bind(fs); let fail = true;
    vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      if (destination === f.current && fail) { fail = false; throw new Error("Original reference write failed"); }
      return rename(source, destination);
    });
    await expect(f.refresh(f.changed)).rejects.toThrow("Original reference write failed");
    expect(await fs.readFile(f.draft)).toEqual(draft); expect(await fs.readFile(f.current)).toEqual(current);
    await f.refresh(f.changed, new ProjectStorage(f.root, new EventHub()));
    expect(await fs.readFile(f.draft)).toEqual(draft); expect(JSON.parse(await fs.readFile(f.current, "utf8"))).toEqual(f.changed);
  });

  it("reports the retained old base as stale before treating its old server-owned model view as tampering", async () => {
    const f = await fixture(); const changed = structuredClone(f.agents); changed.main.model = "new-current-model";
    expect(() => parseAgentOrchestrationProposal(JSON.stringify(f.original), f.projectId, f.orchestration, changed)).toThrow("workflow.json is stale");
  });
});
