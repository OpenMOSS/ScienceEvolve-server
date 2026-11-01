import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { SavedResearchTask } from "./types.js";
import { workflowOuterNodeIds } from "./agent-orchestration.js";
import {
  mergeAgentConfigs,
  normalizeDraftAgentOrchestrationTemplate,
  publicAgentConfigs,
  savedResearchTaskInputSchema,
  withoutLegacyAgentProxy
} from "./validation.js";
import {
  skillDefinitionsSchema,
  validateProjectSkillReferences
} from "./project-skills.js";
import {
  mcpDefinitionsSchema,
  validateProjectMcpReferences
} from "./project-mcp.js";
import { newId, nowIso } from "./utils.js";

interface SavedResearchTaskFile {
  schemaVersion: 2;
  tasks: SavedResearchTask[];
  deletionReceipts?: Record<string, { signature: string; tasks: DeletedSavedResearchTask[] }>;
}

export type DeletedSavedResearchTask = Pick<SavedResearchTask, "id" | "title" | "updatedAt">;
export const savedTaskDeletionSchema = z.object({
  operationId: z.string().regex(/^[A-Za-z0-9_-]{8,160}$/),
  tasks: z.array(z.object({ taskId: z.string().regex(/^task_[a-f0-9]{32}$/), expectedUpdatedAt: z.string().datetime() }).strict())
    .min(1).max(100).refine(tasks => new Set(tasks.map(task => task.taskId)).size === tasks.length, "不能重复删除同一份草稿")
}).strict();
type SavedTaskDeletionInput = z.infer<typeof savedTaskDeletionSchema> & { requestSignature?: string };
const internalDeletionSchema = savedTaskDeletionSchema.extend({ requestSignature: z.string().regex(/^[a-f0-9]{64}$/).optional() });
const deletionReceiptsSchema = z.record(z.string().regex(/^[A-Za-z0-9_-]{8,160}$/), z.object({
  signature: z.string().regex(/^[a-f0-9]{64}$/), tasks: z.array(z.object({
    id: z.string().regex(/^task_[a-f0-9]{32}$/), title: z.string(), updatedAt: z.string().datetime()
  }).strict())
}).strict());

type SavedResearchTaskInput = z.input<typeof savedResearchTaskInputSchema>;

export class SavedResearchTaskStore {
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly root: string) {}

  async list(): Promise<SavedResearchTask[]> {
    await this.mutationTail;
    return structuredClone(await this.readPersisted());
  }

  async get(taskId: string): Promise<SavedResearchTask | undefined> {
    await this.mutationTail;
    const task = (await this.readPersisted()).find((item) => item.id === taskId);
    return task ? structuredClone(task) : undefined;
  }

  async create(input: SavedResearchTaskInput, taskId?: string): Promise<SavedResearchTask> {
    return this.serialize(async () => {
      const parsed = savedResearchTaskInputSchema.parse(input);
      const tasks = await this.readPersisted();
      if (taskId && !/^task_[a-f0-9]{32}$/.test(taskId)) throw new Error("Invalid saved research task id");
      if (taskId && Object.values((await this.readDocument()).deletionReceipts ?? {}).some(receipt => receipt.tasks.some(task => task.id === taskId)))
        throw Object.assign(new Error("这份草稿已被删除，请使用新的操作编号新建独立草稿。"), { status: 409 });
      // Assistant save operations use a deterministic identity. Retrying the
      // same committed operation cannot create a second project draft.
      const existing = taskId && tasks.find(task => task.id === taskId);
      const timestamp = nowIso();
      const orchestration = normalizeDraftAgentOrchestrationTemplate(
        parsed.orchestration
      );
      const agents = publicAgentConfigs(mergeAgentConfigs(parsed.agents, orchestration));
      const skillDefinitions = skillDefinitionsSchema.parse(parsed.skillDefinitions ?? {});
      const mcpDefinitions = mcpDefinitionsSchema.parse(parsed.mcpDefinitions ?? {});
      validateProjectSkillReferences(agents, skillDefinitions);
      validateProjectMcpReferences(agents, mcpDefinitions);
      const task: SavedResearchTask = {
        schemaVersion: 2,
        kind: "scienceevolve-saved-research-task",
        id: taskId ?? newId("task"),
        title: parsed.title,
        requirement: parsed.requirement,
        createdAt: timestamp,
        updatedAt: timestamp,
        agents,
        orchestration,
        git: parsed.git,
        ...(Object.keys(skillDefinitions).length ? { skillDefinitions } : {}),
        ...(Object.keys(mcpDefinitions).length ? { mcpDefinitions } : {})
      };
      if (existing) {
        const content = ({ id: _id, createdAt: _created, updatedAt: _updated, ...value }: SavedResearchTask) => value;
        if (!isDeepStrictEqual(content(existing), content(task))) throw new Error("同一草稿编号不能用于不同内容。");
        return structuredClone(existing);
      }
      tasks.unshift(task);
      await this.writePersisted(tasks);
      return structuredClone(task);
    });
  }

  async update(
    taskId: string,
    input: SavedResearchTaskInput,
    expectedUpdatedAt?: string
  ): Promise<SavedResearchTask | undefined> {
    return this.serialize(async () => {
      const parsed = savedResearchTaskInputSchema.parse(input);
      const tasks = await this.readPersisted();
      const index = tasks.findIndex((task) => task.id === taskId);
      if (index < 0) return undefined;
      const current = tasks[index];
      if (expectedUpdatedAt !== undefined && current.updatedAt !== expectedUpdatedAt) {
        throw Object.assign(new Error("已保存草稿已有新的修改，请重新读取后再编辑，避免覆盖其他窗口的内容。"), { status: 409 });
      }
      const orchestration = normalizeDraftAgentOrchestrationTemplate(
        parsed.orchestration
      );
      const agents = publicAgentConfigs(mergeAgentConfigs(parsed.agents, orchestration));
      const skillDefinitions = skillDefinitionsSchema.parse(parsed.skillDefinitions ?? {});
      const mcpDefinitions = mcpDefinitionsSchema.parse(parsed.mcpDefinitions ?? {});
      validateProjectSkillReferences(agents, skillDefinitions);
      validateProjectMcpReferences(agents, mcpDefinitions);
      const updated: SavedResearchTask = {
        ...current,
        title: parsed.title,
        requirement: parsed.requirement,
        updatedAt: new Date(Math.max(Date.now(), Date.parse(current.updatedAt) + 1)).toISOString(),
        agents,
        orchestration,
        git: parsed.git,
        ...(Object.keys(skillDefinitions).length ? { skillDefinitions } : { skillDefinitions: undefined }),
        ...(Object.keys(mcpDefinitions).length ? { mcpDefinitions } : { mcpDefinitions: undefined })
      };
      tasks[index] = updated;
      tasks.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      await this.writePersisted(tasks);
      return structuredClone(updated);
    });
  }

  async delete(taskId: string): Promise<boolean> {
    return this.serialize(async () => {
      const tasks = await this.readPersisted();
      const remaining = tasks.filter((task) => task.id !== taskId);
      if (remaining.length === tasks.length) return false;
      await this.writePersisted(remaining);
      return true;
    });
  }

  async getDeletionReceipt(input: SavedTaskDeletionInput): Promise<DeletedSavedResearchTask[] | undefined> {
    const parsed = internalDeletionSchema.parse(input);
    await this.mutationTail;
    return this.deletionReceipt(await this.readDocument(), parsed);
  }

  /** Selection, version checks, deletion and its retry receipt share one atomic
   * file replacement. No successful item can be deleted again after a crash. */
  async deleteMany(input: SavedTaskDeletionInput, signal?: AbortSignal): Promise<DeletedSavedResearchTask[]> {
    const parsed = internalDeletionSchema.parse(input);
    return this.serialize(async () => {
      signal?.throwIfAborted();
      const document = await this.readDocument();
      const replay = this.deletionReceipt(document, parsed);
      if (replay) return replay;
      const deleted = parsed.tasks.map(selection => {
        const task = document.tasks.find(task => task.id === selection.taskId);
        if (!task) throw Object.assign(new Error("项目草稿不存在或已被删除，请重新读取草稿列表。"), { status: 404 });
        if (task.updatedAt !== selection.expectedUpdatedAt)
          throw Object.assign(new Error("草稿已有新的修改，请重新读取最新版本后决定是否删除。"), { status: 409 });
        return { id: task.id, title: task.title, updatedAt: task.updatedAt };
      });
      const ids = new Set(deleted.map(task => task.id));
      const receipts = { ...document.deletionReceipts, [parsed.operationId]: {
        signature: this.deletionSignature(parsed), tasks: deleted
      } };
      signal?.throwIfAborted();
      await this.writePersisted(document.tasks.filter(task => !ids.has(task.id)), receipts);
      return structuredClone(deleted);
    });
  }

  private deletionSignature(input: SavedTaskDeletionInput) {
    return createHash("sha256").update(JSON.stringify({ tasks: input.tasks, requestSignature: input.requestSignature })).digest("hex");
  }
  private deletionReceipt(document: SavedResearchTaskFile, input: SavedTaskDeletionInput) {
    const receipt = document.deletionReceipts?.[input.operationId];
    if (!receipt) return undefined;
    if (receipt.signature !== this.deletionSignature(input))
      throw Object.assign(new Error("同一删除操作编号不能用于不同草稿或版本。"), { status: 409 });
    return structuredClone(receipt.tasks);
  }

  private filePath(): string {
    return path.join(this.root, "saved-research-tasks.json");
  }

  private async readPersisted(): Promise<SavedResearchTask[]> {
    return (await this.readDocument()).tasks;
  }

  private async readDocument(): Promise<SavedResearchTaskFile> {
    let raw: unknown;
    try {
      raw = JSON.parse(await fs.readFile(this.filePath(), "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 2, tasks: [] };
      // Saved tasks are deliberately hard-cut to the current format.  A
      // stale or malformed file is hidden, never migrated and never allowed
      // to block newly-created tasks.
      return { schemaVersion: 2, tasks: [] };
    }
    if (!isRecord(raw) || raw.schemaVersion !== 2 || !Array.isArray(raw.tasks)) {
      return { schemaVersion: 2, tasks: [] };
    }
    const tasks = raw.tasks
      .flatMap((value) => {
        try {
          return [parsePersistedTask(value)];
        } catch {
          // Pre-Main and malformed saved tasks are intentionally hidden.
          return [];
        }
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return { schemaVersion: 2, tasks, ...(raw.deletionReceipts === undefined ? {}
      : { deletionReceipts: deletionReceiptsSchema.parse(raw.deletionReceipts) }) };
  }

  private async writePersisted(tasks: SavedResearchTask[], deletionReceipts?: SavedResearchTaskFile["deletionReceipts"]): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    const destination = this.filePath();
    const temporary = `${destination}.${process.pid}.${newId("tmp")}`;
    const receipts = deletionReceipts ?? (await this.readDocument()).deletionReceipts;
    const document: SavedResearchTaskFile = { schemaVersion: 2, tasks, ...(receipts ? { deletionReceipts: receipts } : {}) };
    try {
      await fs.writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx"
      });
      await fs.rename(temporary, destination);
    } catch (error) {
      await fs.rm(temporary, { force: true });
      throw error;
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

function parsePersistedTask(value: unknown): SavedResearchTask {
  if (!isRecord(value)) throw new Error("已保存科研任务条目无效");
  if (
    value.schemaVersion !== 2 ||
    value.kind !== "scienceevolve-saved-research-task" ||
    typeof value.id !== "string" ||
    !/^task_[a-f0-9]{32}$/.test(value.id) ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    !isRecord(value.agents) ||
    !isRecord(value.orchestration)
  ) {
    throw new Error("已保存科研任务条目格式无效");
  }
  if (hasLegacyControllerSemantics(value)) {
    throw new Error("已保存科研任务使用旧 Controller 格式");
  }
  const parsed = savedResearchTaskInputSchema.parse({
    title: value.title,
    requirement: value.requirement,
    agents: Object.fromEntries(Object.entries(value.agents).map(([name, config]) =>
      [name, isRecord(config) ? withoutLegacyAgentProxy(config) : config])),
    orchestration: value.orchestration,
    git: value.git,
    skillDefinitions: value.skillDefinitions,
    mcpDefinitions: value.mcpDefinitions
  });
  const orchestration = normalizeDraftAgentOrchestrationTemplate(parsed.orchestration);
  const agents = publicAgentConfigs(mergeAgentConfigs(parsed.agents, orchestration));
  const skillDefinitions = skillDefinitionsSchema.parse(parsed.skillDefinitions ?? {});
  const mcpDefinitions = mcpDefinitionsSchema.parse(parsed.mcpDefinitions ?? {});
  validateProjectSkillReferences(agents, skillDefinitions);
  validateProjectMcpReferences(agents, mcpDefinitions);
  return {
    schemaVersion: 2,
    kind: "scienceevolve-saved-research-task",
    id: value.id,
    title: parsed.title,
    requirement: parsed.requirement,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    agents,
    orchestration,
    git: parsed.git,
    ...(Object.keys(skillDefinitions).length ? { skillDefinitions } : {}),
    ...(Object.keys(mcpDefinitions).length ? { mcpDefinitions } : {})
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasLegacyControllerSemantics(value: Record<string, unknown>): boolean {
  if (!isRecord(value.agents) || !isRecord(value.orchestration)) return true;
  if ("__system_controller__" in value.agents) return true;
  const orchestration = value.orchestration;
  if (!Array.isArray(orchestration.agents)) return true;
  const names = new Set<string>();
  for (const definition of orchestration.agents) {
    if (!isRecord(definition) || typeof definition.name !== "string") return true;
    if (Object.prototype.hasOwnProperty.call(definition, "kind")) return true;
    names.add(definition.name);
  }
  if (!names.has("main")) return true;
  if (!isRecord(orchestration.termination) || orchestration.termination.decisionBy !== "main") {
    return true;
  }
  if (!isRecord(orchestration.routes)) return true;
  const children = persistedOuterNodeIds(orchestration, names);
  if (!children) return true;
  const mainRoutes = orchestration.routes.main;
  if (
    !Array.isArray(mainRoutes) ||
    mainRoutes.length !== children.length ||
    mainRoutes.some((edge, index) =>
      !isRecord(edge) ||
      edge.kind !== "weak" ||
      edge.target !== children[index]
    )
  ) {
    return true;
  }
  return Object.values(orchestration.routes).some(
    (routes) => Array.isArray(routes) && routes.some((edge) => {
      if (!isRecord(edge)) return true;
      return edge.target === "__system_controller__" ||
        (edge.target === "controller" && !names.has("controller"));
    })
  );
}

/** Compute expected nodes separately so stale Main routes are never repaired on read. */
function persistedOuterNodeIds(
  orchestration: Record<string, unknown>,
  names: Set<string>
): string[] | undefined {
  if (orchestration.schemaVersion === 3) {
    try {
      return workflowOuterNodeIds(normalizeDraftAgentOrchestrationTemplate(orchestration))
        .filter((name) => name !== "main");
    } catch {
      return undefined;
    }
  }
  const rawGroups = orchestration.collaborations;
  if (rawGroups !== undefined && !Array.isArray(rawGroups)) return undefined;
  const groupByMember = new Map<string, string>();
  for (const value of rawGroups ?? []) {
    if (!isRecord(value) || typeof value.id !== "string" || !Array.isArray(value.memberAgentIds)) return undefined;
    for (const memberId of value.memberAgentIds) {
      if (typeof memberId !== "string" || !names.has(memberId) || groupByMember.has(memberId)) return undefined;
      groupByMember.set(memberId, value.id);
    }
  }
  const emittedGroups = new Set<string>();
  const result: string[] = [];
  for (const name of names) {
    if (name === "main") continue;
    const groupId = groupByMember.get(name);
    if (!groupId) result.push(name);
    else if (!emittedGroups.has(groupId)) {
      emittedGroups.add(groupId);
      result.push(groupId);
    }
  }
  return result;
}
