import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  AgentConfig,
  AgentName,
  AgentConfigPreset,
  AgentOrchestrationTemplate,
  ProjectState
} from "./types.js";
import {
  mergeAgentConfigs,
  normalizeAgentOrchestrationTemplate,
  publicAgentConfigs
} from "./validation.js";
import {
  skillDefinitionsSchema,
  validateProjectSkillReferences,
  type ProjectSkillDefinitions
} from "./project-skills.js";
import {
  mcpDefinitionsSchema,
  validateProjectMcpReferences,
  type ProjectMcpDefinitions
} from "./project-mcp.js";
import { cloneAgentOrchestrationTemplate } from "./agent-orchestration.js";
import { newId, nowIso } from "./utils.js";
import { parseWorkflowImport, workflowImportSourceSchema } from "./workflow-import.js";
import { scopedWorkflowContractSchema } from "./scoped-workflow-contract.js";

export const DEFAULT_AGENT_CONFIG_PRESET_ID = "default";

interface PresetFile {
  schemaVersion: 2;
  presets: AgentConfigPreset[];
}

type PresetSourceProject = Pick<
  ProjectState,
  "id" | "title" | "agents" | "skillDefinitions" | "mcpDefinitions"
> & {
  orchestration?: AgentOrchestrationTemplate;
};
type PresetConfigInput = {
  importSource?: AgentConfigPreset["importSource"];
  name: string;
  agents?: Partial<Record<AgentName, Partial<AgentConfig>>>;
  orchestration: AgentOrchestrationTemplate;
  skillDefinitions?: ProjectSkillDefinitions;
  mcpDefinitions?: ProjectMcpDefinitions;
};

export class AgentConfigPresetStore {
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly root: string) {}

  async list(): Promise<AgentConfigPreset[]> {
    await this.mutationTail;
    return [this.defaultPreset(), ...(await this.readPersisted())];
  }

  async saveFromProject(
    project: PresetSourceProject,
    requestedName?: string
  ): Promise<AgentConfigPreset> {
    return this.serialize(async () => {
      const presets = await this.readPersisted();
      const timestamp = nowIso();
      const existingIndex = presets.findIndex(
        (preset) => preset.sourceProjectId === project.id
      );
      const existing =
        existingIndex >= 0 ? presets[existingIndex] : undefined;
      const name = (
        requestedName?.trim() || `${project.title} · Agent 配置`
      ).slice(0, 160);
      const orchestration = normalizeAgentOrchestrationTemplate(
        structuredClone(project.orchestration)
      );
      const agents = publicAgentConfigs(project.agents);
      const skillDefinitions = skillDefinitionsSchema.parse(project.skillDefinitions ?? {});
      const mcpDefinitions = mcpDefinitionsSchema.parse(project.mcpDefinitions ?? {});
      validateProjectSkillReferences(agents, skillDefinitions);
      validateProjectMcpReferences(agents, mcpDefinitions);
      const preset: AgentConfigPreset = {
        schemaVersion: 2,
        kind: "scienceevolve-agent-config-preset",
        id: existing?.id ?? newId("cfg"),
        name,
        builtin: false,
        sourceProjectId: project.id,
        sourceProjectTitle: project.title,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
        agents,
        orchestration,
        ...(Object.keys(skillDefinitions).length ? { skillDefinitions } : {}),
        ...(Object.keys(mcpDefinitions).length ? { mcpDefinitions } : {})
      };
      if (existingIndex >= 0) presets[existingIndex] = preset;
      else presets.push(preset);
      presets.sort((left, right) =>
        (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "")
      );
      await this.writePersisted(presets);
      return structuredClone(preset);
    });
  }

  async create(input: PresetConfigInput): Promise<AgentConfigPreset> {
    return this.serialize(async () => {
      const presets = await this.readPersisted();
      const timestamp = nowIso();
      const imported = input.importSource ? parseWorkflowImport({ filename: input.importSource.filename, text: input.importSource.text }) : undefined;
      const orchestration = imported?.orchestration ?? normalizeAgentOrchestrationTemplate(structuredClone(input.orchestration));
      const agents = imported?.agents ?? publicAgentConfigs(mergeAgentConfigs(input.agents as Parameters<typeof mergeAgentConfigs>[0], orchestration));
      const skillDefinitions = skillDefinitionsSchema.parse(input.skillDefinitions ?? {});
      const mcpDefinitions = mcpDefinitionsSchema.parse(input.mcpDefinitions ?? {});
      if (!input.importSource) validateProjectSkillReferences(agents, skillDefinitions);
      if (!imported) validateProjectMcpReferences(agents, mcpDefinitions);
      const preset: AgentConfigPreset = {
        schemaVersion: 2,
        kind: "scienceevolve-agent-config-preset",
        id: newId("cfg"),
        name: input.name.trim().slice(0, 160),
        ...(imported ? { importSource: imported.importSource } : {}),
        builtin: false,
        createdAt: timestamp,
        updatedAt: timestamp,
        agents,
        orchestration,
        ...(Object.keys(skillDefinitions).length ? { skillDefinitions } : {}),
        ...(Object.keys(mcpDefinitions).length ? { mcpDefinitions } : {})
      };
      presets.push(preset);
      presets.sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""));
      await this.writePersisted(presets);
      return structuredClone(preset);
    });
  }

  async update(presetId: string, input: PresetConfigInput): Promise<AgentConfigPreset | undefined> {
    return this.serialize(async () => {
      if (presetId === DEFAULT_AGENT_CONFIG_PRESET_ID) return undefined;
      const presets = await this.readPersisted();
      const index = presets.findIndex((preset) => preset.id === presetId);
      if (index < 0) return undefined;
      const current = presets[index]!;
      if (current.importSource) throw new Error("SDK Workflow visualization is read-only");
      const orchestration = normalizeAgentOrchestrationTemplate(structuredClone(input.orchestration));
      const agents = publicAgentConfigs(mergeAgentConfigs(input.agents as Parameters<typeof mergeAgentConfigs>[0], orchestration));
      const skillDefinitions = skillDefinitionsSchema.parse(input.skillDefinitions ?? {});
      const mcpDefinitions = mcpDefinitionsSchema.parse(input.mcpDefinitions ?? {});
      validateProjectSkillReferences(agents, skillDefinitions);
      validateProjectMcpReferences(agents, mcpDefinitions);
      const updated: AgentConfigPreset = {
        ...current,
        name: input.name.trim().slice(0, 160),
        updatedAt: nowIso(),
        agents,
        orchestration,
        ...(Object.keys(skillDefinitions).length ? { skillDefinitions } : { skillDefinitions: undefined }),
        ...(Object.keys(mcpDefinitions).length ? { mcpDefinitions } : { mcpDefinitions: undefined })
      };
      presets[index] = updated;
      presets.sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""));
      await this.writePersisted(presets);
      return structuredClone(updated);
    });
  }

  async delete(presetId: string): Promise<boolean> {
    return this.serialize(async () => {
      if (presetId === DEFAULT_AGENT_CONFIG_PRESET_ID) return false;
      const presets = await this.readPersisted();
      const remaining = presets.filter((preset) => preset.id !== presetId);
      if (remaining.length === presets.length) return false;
      await this.writePersisted(remaining);
      return true;
    });
  }

  private defaultPreset(): AgentConfigPreset {
    const orchestration = cloneAgentOrchestrationTemplate();
    return {
      schemaVersion: 2,
      kind: "scienceevolve-agent-config-preset",
      id: DEFAULT_AGENT_CONFIG_PRESET_ID,
      name: "系统默认配置",
      builtin: true,
      agents: publicAgentConfigs(mergeAgentConfigs(undefined, orchestration)),
      orchestration
    };
  }

  private filePath(): string {
    return path.join(this.root, "agent-config-presets.json");
  }

  private async readPersisted(): Promise<AgentConfigPreset[]> {
    let raw: unknown;
    try {
      raw = JSON.parse(await fs.readFile(this.filePath(), "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      // A malformed/legacy library must not prevent current presets from
      // loading.  Old data is intentionally ignored rather than migrated.
      return [];
    }
    if (!isRecord(raw) || raw.schemaVersion !== 2 || !Array.isArray(raw.presets)) {
      return [];
    }
    return raw.presets.flatMap((value) => {
      try {
        return [parsePersistedPreset(value)];
      } catch {
        // Pre-Main and malformed presets are intentionally hidden.
        return [];
      }
    });
  }

  private async writePersisted(presets: AgentConfigPreset[]): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    const destination = this.filePath();
    const temporary = `${destination}.${process.pid}.${newId("tmp")}`;
    const document: PresetFile = { schemaVersion: 2, presets };
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

function parsePersistedPreset(value: unknown): AgentConfigPreset {
  if (!isRecord(value)) throw new Error("Agent 配置预设条目无效");
  if (
    value.schemaVersion !== 2 ||
    value.kind !== "scienceevolve-agent-config-preset" ||
    typeof value.id !== "string" ||
    !/^cfg_[a-f0-9]{32}$/.test(value.id) ||
    typeof value.name !== "string" ||
    !value.name.trim() ||
    value.name.length > 160 ||
    value.builtin !== false ||
    (value.sourceProjectId !== undefined && (typeof value.sourceProjectId !== "string" || !/^prj_[a-f0-9]{32}$/.test(value.sourceProjectId))) ||
    (value.sourceProjectTitle !== undefined && typeof value.sourceProjectTitle !== "string") ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    !isRecord(value.agents) ||
    !isRecord(value.orchestration)
  ) {
    throw new Error("Agent 配置预设条目格式无效");
  }
  if (value.importSource !== undefined) {
    const source = workflowImportSourceSchema.parse(value.importSource);
    const imported = parseWorkflowImport({ filename: source.filename, text: source.text });
    return { schemaVersion: 2, kind: "scienceevolve-agent-config-preset", id: value.id, builtin: false,
      createdAt: value.createdAt, updatedAt: value.updatedAt, ...imported, name: value.name };
  }
  if (hasLegacyControllerSemantics(value)) {
    throw new Error("Agent 配置预设使用旧 Controller 格式");
  }
  const orchestration = normalizeAgentOrchestrationTemplate(value.orchestration);
  const agents = publicAgentConfigs(mergeAgentConfigs(
    value.agents as Parameters<typeof mergeAgentConfigs>[0],
    orchestration
  ));
  const skillDefinitions = skillDefinitionsSchema.parse(value.skillDefinitions ?? {});
  const mcpDefinitions = mcpDefinitionsSchema.parse(value.mcpDefinitions ?? {});
  validateProjectSkillReferences(agents, skillDefinitions);
  validateProjectMcpReferences(agents, mcpDefinitions);
  return {
    schemaVersion: 2,
    kind: "scienceevolve-agent-config-preset",
    id: value.id,
    name: value.name,
    builtin: false,
    ...(typeof value.sourceProjectId === "string" ? { sourceProjectId: value.sourceProjectId } : {}),
    ...(typeof value.sourceProjectTitle === "string" ? { sourceProjectTitle: value.sourceProjectTitle } : {}),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    agents,
    orchestration,
    ...(Object.keys(skillDefinitions).length ? { skillDefinitions } : {}),
    ...(Object.keys(mcpDefinitions).length ? { mcpDefinitions } : {})
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasLegacyControllerSemantics(value: Record<string, unknown>): boolean {
  const agents = value.agents;
  const orchestration = value.orchestration;
  if (!isRecord(agents) || !isRecord(orchestration)) return true;
  if ("__system_controller__" in agents || !Array.isArray(orchestration.agents)) return true;
  const names = new Set<string>();
  for (const definition of orchestration.agents) {
    if (!isRecord(definition) || typeof definition.name !== "string") return true;
    if (Object.prototype.hasOwnProperty.call(definition, "kind")) return true;
    names.add(definition.name);
  }
  if (!names.has("main")) return true;
  if (!isRecord(orchestration.termination) || orchestration.termination.decisionBy !== "main") return true;
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
  ) return true;
  return Object.values(orchestration.routes).some(
    (routes) => Array.isArray(routes) && routes.some((edge) => {
      if (!isRecord(edge)) return true;
      return edge.target === "__system_controller__" ||
        (edge.target === "controller" && !names.has("controller"));
    })
  );
}

/** Inspect the persisted outer projection without canonicalizing stale routes. */
function persistedOuterNodeIds(
  orchestration: Record<string, unknown>,
  names: Set<string>
): string[] | undefined {
  if (orchestration.schemaVersion === 3) {
    const scoped = scopedWorkflowContractSchema.safeParse(orchestration.scopedWorkflow);
    if (!scoped.success) return undefined;
    // v3 references share identities; nested groups and their members do not
    // replace the explicit root references or become additional Main targets.
    return [
      ...scoped.data.rootAgentIds.filter((id) => id !== "main"),
      ...scoped.data.groups.filter((group) => !group.parentGroupId).map((group) => group.id)
    ];
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
