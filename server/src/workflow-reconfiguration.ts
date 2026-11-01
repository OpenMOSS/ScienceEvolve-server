import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { WorkflowConfigurationVersion } from "./workflow-adjustments.js";
import type {
  AgentConfigMap,
  AgentOrchestrationTemplate
} from "./types.js";
import {
  mergeAgentConfigs,
  normalizeAgentOrchestrationTemplate
} from "./validation.js";

export const MAIN_WORKFLOW_FILE = "workflow.json";
export const MAX_WORKFLOW_FILE_BYTES = 2 * 1024 * 1024;

export interface MainWorkflowDocument {
  schemaVersion: 1;
  projectId: string;
  baseHash: string;
  baseVersion?: WorkflowConfigurationVersion;
  editableFields: readonly ["orchestration"];
  editingInstructions: {
    routes: string;
    invariants: string[];
  };
  orchestration: AgentOrchestrationTemplate;
}

export interface WorkflowProposal {
  orchestration: AgentOrchestrationTemplate;
  agents: AgentConfigMap;
}

/**
 * Deterministically align credential-bearing file state with a credential-free
 * workflow snapshot. Existing Agents keep their complete runtime config,
 * removed Agents disappear, and newly introduced Agents inherit only the
 * verified execution route from Main (or the first surviving seed) before
 * template defaults are applied.
 */
export function reconcileAgentConfigsForWorkflow(
  currentAgents: AgentConfigMap,
  nextOrchestration: AgentOrchestrationTemplate
): AgentConfigMap {
  const preservedSnapshots: Record<
    string,
    NonNullable<AgentConfigMap[string]["gatewaySnapshot"]>
  > = {};
  const seed = currentAgents.main ?? Object.values(currentAgents)[0];
  const preserved = Object.fromEntries(
    nextOrchestration.agents.flatMap((definition) => {
      const current = currentAgents[definition.name];
      if (current) {
        const clone = structuredClone(current);
        // Gateway snapshots contain server-only credentials and are not part
        // of create-project input validation. Preserve them out-of-band and
        // restore them after macro defaults/invariants are reconciled.
        if (clone.gatewaySnapshot) {
          preservedSnapshots[definition.name] = structuredClone(
            clone.gatewaySnapshot
          );
          delete clone.gatewaySnapshot;
        }
        return [[definition.name, clone]];
      }
      if (!seed) return [];
      if (seed.gatewaySnapshot) {
        preservedSnapshots[definition.name] = structuredClone(
          seed.gatewaySnapshot
        );
      }
      return [[definition.name, {
        model: seed.model,
        ...(seed.nativeCodexProfileId ? { nativeCodexProfileId: seed.nativeCodexProfileId } : {}),
        ...(seed.harness ? { harness: seed.harness } : {}),
        ...(seed.gatewayId ?? seed.gatewaySnapshot?.id
          ? { gatewayId: seed.gatewayId ?? seed.gatewaySnapshot?.id }
          : {})
      }]];
    })
  ) as Parameters<typeof mergeAgentConfigs>[0];
  const agents = mergeAgentConfigs(preserved, nextOrchestration, {
    restoreRuntimeState: true
  });
  for (const [name, snapshot] of Object.entries(preservedSnapshots)) {
    const agent = agents[name];
    if (!agent) continue;
    agent.gatewaySnapshot = snapshot;
    if (!agent.gatewayReasoningOption && snapshot.reasoningMigrationWarning) {
      agent.reasoningMigrationWarning = snapshot.reasoningMigrationWarning;
    } else {
      delete agent.reasoningMigrationWarning;
    }
  }
  return agents;
}

function workflowHashInput(
  orchestration: AgentOrchestrationTemplate
): Pick<WorkflowProposal, "orchestration"> {
  return {
    orchestration: normalizeAgentOrchestrationTemplate(orchestration)
  };
}

export function workflowBaseHash(
  orchestration: AgentOrchestrationTemplate
): string {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, canonical(entry)])) : value;
  return createHash("sha256")
    .update(JSON.stringify(canonical(workflowHashInput(orchestration))), "utf8")
    .digest("hex");
}

export function mainWorkflowDocument(
  projectId: string,
  orchestration: AgentOrchestrationTemplate,
  baseVersion?: WorkflowConfigurationVersion
): MainWorkflowDocument {
  return {
    schemaVersion: 1,
    projectId,
    ...(baseVersion ? { baseVersion: structuredClone(baseVersion) } : {}),
    baseHash: workflowBaseHash(orchestration),
    editableFields: ["orchestration"],
    editingInstructions: {
      routes:
        "Every route is an object with exactly { target, kind }; kind must be \"strong\" or \"weak\". Example: [{ \"target\": \"main\", \"kind\": \"strong\" }].",
      invariants: [
        "Keep the required main Agent and a decisionPlans entry for every Agent.",
        "Route targets, input.target, and termination.agent must reference configured Agents; only the termination Agent may route to finish.",
        "Main's outgoing routes are server-maintained fan-out edges to the configured ordinary Agents; edit ordinary Agent routes instead of trying to remove or retarget main's edges.",
        `Do not change schemaVersion, projectId, baseHash, ${baseVersion ? "baseVersion, " : ""}editableFields, editingInstructions, or allowMainReconfiguration.`,
        "Agent runtime configuration, including harness, model, Gateway, Skills, permissions, and session policy, is server-owned and is not editable here.",
        "Changing an existing Agent's template changes only its macro role label; it does not change that Agent's existing Harness, model, Gateway, Skills, permissions, or session policy. Choose the required runtime configuration before project start. New Agents receive a template's server-owned defaults when they are created.",
        "New Agents receive a server-selected verified model/harness/Gateway route plus template defaults; this file cannot select or change that route."
      ]
    },
    orchestration: structuredClone(orchestration)
  };
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Parse a Main-authored macro-workflow proposal through the same graph
 * normalizer used by project creation. Agent runtime configuration stays
 * server-owned: existing configs are preserved and new Agents inherit the
 * server-selected execution route before receiving template defaults. The
 * user-owned authorization flag is immutable.
 */
export function parseWorkflowProposal(
  raw: string,
  projectId: string,
  currentOrchestration: AgentOrchestrationTemplate,
  currentAgents: AgentConfigMap,
  options: { baseVersion?: WorkflowConfigurationVersion } = {}
): WorkflowProposal {
  if (Buffer.byteLength(raw, "utf8") > MAX_WORKFLOW_FILE_BYTES) {
    throw new Error("workflow.json exceeds the 2 MiB limit");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("workflow.json is not valid JSON");
  }
  const document = record(parsed, "workflow document");
  if (Object.prototype.hasOwnProperty.call(document, "agents")) {
    throw new Error(
      "workflow.json must not contain Agent runtime configuration"
    );
  }
  const allowedDocumentFields = new Set([
    "schemaVersion",
    "projectId",
    "baseHash",
    "baseVersion",
    "editableFields",
    "editingInstructions",
    "orchestration"
  ]);
  const unsupportedField = Object.keys(document).find(
    (field) => !allowedDocumentFields.has(field)
  );
  if (unsupportedField) {
    throw new Error(`workflow.json contains unsupported field: ${unsupportedField}`);
  }
  if (document.schemaVersion !== 1) {
    throw new Error("workflow.json schemaVersion must be 1");
  }
  if (document.projectId !== projectId) {
    throw new Error("workflow.json belongs to a different project");
  }
  if (!isDeepStrictEqual(document.baseVersion, options.baseVersion)) {
    throw new Error("workflow.json is stale; its original configuration version does not match the current accepted version. Preserve the draft and explicitly reconcile it with the current authoritative document");
  }
  const expectedDocument = mainWorkflowDocument(
    projectId,
    currentOrchestration,
    options.baseVersion
  );
  if (!same(document.editableFields, expectedDocument.editableFields)) {
    throw new Error("workflow.json editableFields is server-owned and immutable");
  }
  const editingInstructions = record(
    document.editingInstructions,
    "editingInstructions"
  );
  const expectedEditingInstructions = expectedDocument.editingInstructions;
  const editingInstructionFields = Object.keys(editingInstructions).sort();
  if (
    editingInstructionFields.length !== 2 ||
    editingInstructionFields[0] !== "invariants" ||
    editingInstructionFields[1] !== "routes" ||
    editingInstructions.routes !== expectedEditingInstructions.routes ||
    !same(
      editingInstructions.invariants,
      expectedEditingInstructions.invariants
    )
  ) {
    throw new Error(
      "workflow.json editingInstructions is server-owned and immutable"
    );
  }
  if (
    document.baseHash !==
    workflowBaseHash(currentOrchestration)
  ) {
    throw new Error(
      "workflow.json is stale; Main must reread the refreshed snapshot"
    );
  }
  const orchestration = normalizeAgentOrchestrationTemplate(
    record(document.orchestration, "orchestration")
  );
  if (
    (orchestration.allowMainReconfiguration === true) !==
    (currentOrchestration.allowMainReconfiguration === true)
  ) {
    throw new Error(
      "Main cannot change its workflow-reconfiguration authority"
    );
  }
  const agents = reconcileAgentConfigsForWorkflow(currentAgents, orchestration);

  const current = workflowHashInput(currentOrchestration);
  const proposed = workflowHashInput(orchestration);
  if (same(proposed, current)) {
    throw new Error("workflow.json does not contain a configuration change");
  }
  return { orchestration, agents };
}

/**
 * Return only collaboration nodes whose definition or incident topology
 * changes. Both legacy Main and the Git-owned Main node use this exact lock
 * projection before committing a workflow revision.
 */
export function affectedCollaborationGroupIds(
  previous: AgentOrchestrationTemplate,
  next: AgentOrchestrationTemplate
): string[] {
  const previousGroups = new Map(
    (previous.collaborations ?? []).map((group) => [group.id, group])
  );
  const nextGroups = new Map(
    (next.collaborations ?? []).map((group) => [group.id, group])
  );
  const allGroupIds = new Set([...previousGroups.keys(), ...nextGroups.keys()]);
  const affected = new Set<string>();
  for (const groupId of allGroupIds) {
    if (JSON.stringify(previousGroups.get(groupId)) !== JSON.stringify(nextGroups.get(groupId)) ||
      JSON.stringify(previous.decisionPlans[groupId]) !== JSON.stringify(next.decisionPlans[groupId]) ||
      JSON.stringify(previous.canvas?.nodes[groupId]) !== JSON.stringify(next.canvas?.nodes[groupId])) {
      affected.add(groupId);
    }
  }
  const routeSources = new Set([
    ...Object.keys(previous.routes),
    ...Object.keys(next.routes)
  ]);
  for (const source of routeSources) {
    const before = new Map((previous.routes[source] ?? []).map((edge) => [edge.target, edge]));
    const after = new Map((next.routes[source] ?? []).map((edge) => [edge.target, edge]));
    const changedTargets = [...new Set([...before.keys(), ...after.keys()])]
      .filter((target) => JSON.stringify(before.get(target)) !== JSON.stringify(after.get(target)));
    if (changedTargets.length === 0) continue;
    if (allGroupIds.has(source)) affected.add(source);
    for (const target of changedTargets) {
      if (allGroupIds.has(target)) affected.add(target);
    }
  }
  if (previous.input.target !== next.input.target) {
    if (allGroupIds.has(previous.input.target)) affected.add(previous.input.target);
    if (allGroupIds.has(next.input.target)) affected.add(next.input.target);
  }
  if (previous.termination.agent !== next.termination.agent) {
    if (allGroupIds.has(previous.termination.agent)) affected.add(previous.termination.agent);
    if (allGroupIds.has(next.termination.agent)) affected.add(next.termination.agent);
  }
  return [...affected].sort();
}
