import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { AgentOrchestrationProposal } from "./agent-orchestration-reconfiguration.js";
import { agentConfigSchema, agentNameSchema, agentOrchestrationTemplateSchema,
  mergeAgentConfigs, normalizeAgentOrchestrationTemplate } from "./validation.js";
import { mcpDefinitionsSchema, mcpRevision, validateProjectMcpReferences } from "./project-mcp.js";
import { skillDefinitionsSchema, skillRevision, validateProjectSkillReferences } from "./project-skills.js";

export type WorkflowAdjustmentSnapshot = AgentOrchestrationProposal;
export type { WorkflowConfigurationVersion, WorkflowAdjustmentSource, WorkflowAdjustmentStatus,
  WorkflowAdjustmentChange, WorkflowAdjustmentTransition, WorkflowAdjustmentPublication } from "./internal/shared/workflow-adjustment-contracts.js";
import type { WorkflowConfigurationVersion, WorkflowAdjustmentChange,
  WorkflowAdjustmentPublication } from "./internal/shared/workflow-adjustment-contracts.js";
import type * as AdjustmentContract from "./internal/shared/workflow-adjustment-contracts.js";
export type WorkflowAdjustmentSubmission = AdjustmentContract.WorkflowAdjustmentSubmission<WorkflowAdjustmentSnapshot>;
export type WorkflowAdjustmentRecord = AdjustmentContract.WorkflowAdjustmentRecord<WorkflowAdjustmentSnapshot>;
export type SubmitUserWorkflowAdjustmentInput = AdjustmentContract.SubmitUserWorkflowAdjustmentInput<WorkflowAdjustmentSnapshot>;
export type WorkflowAdjustmentContext = AdjustmentContract.WorkflowAdjustmentContext<WorkflowAdjustmentSnapshot>;
export type WorkflowAdjustmentQueryResult = { etag?: string; context?: WorkflowAdjustmentContext };
export type { WorkflowAdjustmentSummary, WorkflowAdjustmentPageInput } from "./internal/shared/workflow-adjustment-contracts.js";
export type WorkflowAdjustmentPage = AdjustmentContract.WorkflowAdjustmentPage<WorkflowAdjustmentSnapshot>;
export type WorkflowAdjustmentDetail = AdjustmentContract.WorkflowAdjustmentDetail<WorkflowAdjustmentSnapshot>;
export type WorkflowAdjustmentPageResult = { etag: string; page?: WorkflowAdjustmentPage };
export const workflowAdjustmentDetailQuerySchema = z.object({ expectedVersion: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
export const workflowAdjustmentPageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  before: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
  expectedVersion: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  watchRequestId: z.string().min(1).max(512).optional()
}).strict().refine(value => value.before === undefined || value.expectedVersion !== undefined,
  { message: "后续记录页须核对首页日志版本", path: ["expectedVersion"] });

export type WorkflowAdjustmentSubmissionResult = AdjustmentContract.WorkflowAdjustmentSubmissionResult<WorkflowAdjustmentSnapshot>;
export type WorkflowAdjustmentWithdrawalResult = AdjustmentContract.WorkflowAdjustmentWithdrawalResult<WorkflowAdjustmentSnapshot>;
export type UserWorkflowAdjustmentPublicationPreparation = {
  ready: false; publication: WorkflowAdjustmentPublication; revision: number;
} | {
  ready: true; record: WorkflowAdjustmentRecord; validationToken: string; revision: number;
};
export type WorkflowAdjustmentPreparation = { replay: true; result: WorkflowAdjustmentSubmissionResult }
  | { replay: false; proposal: WorkflowAdjustmentSnapshot };
export const WORKFLOW_ADJUSTMENT_STALE_MESSAGE = "配置已发生修改，请基于最新版本核对后重新提交";

const snapshotSchema = z.object({
  orchestration: agentOrchestrationTemplateSchema,
  agents: z.record(agentNameSchema, agentConfigSchema),
  skillDefinitions: skillDefinitionsSchema, mcpDefinitions: mcpDefinitionsSchema
}).strict();
const requestIdSchema = z.string().min(1).max(200).refine(value => value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value), "Invalid request identity");
export const workflowAdjustmentVersionSchema = z.object({ revision: z.number().int().positive(), hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const workflowAdjustmentSubmissionEnvelopeSchema = z.object({
  projectId: requestIdSchema, requestId: requestIdSchema, base: workflowAdjustmentVersionSchema,
  proposal: z.unknown(), explanation: z.string().max(20_000).optional(), replacesRequestId: requestIdSchema.optional()
}).strict();
export const submitUserWorkflowAdjustmentSchema = workflowAdjustmentSubmissionEnvelopeSchema.extend({ proposal: snapshotSchema });
export const withdrawWorkflowAdjustmentSchema = z.object({ projectId: requestIdSchema, requestId: requestIdSchema,
  operationId: requestIdSchema, note: z.string().max(20_000).optional() }).strict();
export const workflowAdjustmentSubmissionBodySchema = workflowAdjustmentSubmissionEnvelopeSchema.omit({ projectId: true });
export const workflowAdjustmentWithdrawalBodySchema = withdrawWorkflowAdjustmentSchema.omit({ projectId: true, requestId: true });

/** Trusted read projection only. Runtime route snapshots and removed legacy
 * fields remain in their original S facts, outside editable snapshots. */
export function workflowAdjustmentReadSnapshot(input: WorkflowAdjustmentSnapshot): WorkflowAdjustmentSnapshot {
  return { orchestration: structuredClone(input.orchestration),
    agents: Object.fromEntries(Object.entries(input.agents).map(([id, config]) => [id,
      agentConfigSchema.parse(Object.fromEntries(Object.keys(agentConfigSchema.shape)
        .filter(key => Object.hasOwn(config, key)).map(key => [key, config[key as keyof typeof config]])))])),
    skillDefinitions: skillDefinitionsSchema.parse(input.skillDefinitions), mcpDefinitions: mcpDefinitionsSchema.parse(input.mcpDefinitions) };
}

/** Submission validation never strips unknown fields or merges old drafts. */
export function validateWorkflowAdjustmentSnapshot(input: unknown, current: WorkflowAdjustmentSnapshot): WorkflowAdjustmentSnapshot {
  if (Buffer.byteLength(JSON.stringify(input), "utf8") > 2 * 1024 * 1024) throw new Error("Workflow adjustment exceeds 2 MiB");
  const parsed = snapshotSchema.parse(input);
  const orchestration = normalizeAgentOrchestrationTemplate(parsed.orchestration);
  const names = orchestration.agents.map(agent => agent.name).sort();
  if (!isDeepStrictEqual(names, Object.keys(parsed.agents).sort())) throw new Error("Every declared Agent requires exactly one complete configuration");
  const agents = mergeAgentConfigs(parsed.agents, orchestration);
  validateProjectSkillReferences(agents, parsed.skillDefinitions);
  validateProjectMcpReferences(agents, parsed.mcpDefinitions);
  for (const [name, definition] of Object.entries(current.skillDefinitions)) {
    if (!parsed.skillDefinitions[name] || skillRevision(definition) !== skillRevision(parsed.skillDefinitions[name]))
      throw new Error(`Existing project Skill is immutable: ${name}`);
  }
  for (const [name, definition] of Object.entries(current.mcpDefinitions)) {
    if (!parsed.mcpDefinitions[name] || mcpRevision(definition) !== mcpRevision(parsed.mcpDefinitions[name]))
      throw new Error(`Existing project MCP is immutable: ${name}`);
  }
  return { orchestration, agents, skillDefinitions: parsed.skillDefinitions, mcpDefinitions: parsed.mcpDefinitions };
}

/** Values come from the two actual snapshots; no model reasoning or invented
 * business summary is used for the record's diff. Arrays stay whole. */
export function workflowAdjustmentChanges(before: unknown, after: unknown, path: string[] = []): WorkflowAdjustmentChange[] {
  if (isDeepStrictEqual(before, after)) return [];
  const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
  if (record(before) && record(after)) return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
    .flatMap(key => workflowAdjustmentChanges(before[key], after[key], [...path, key]));
  return [{ path, kind: before === undefined ? "added" : after === undefined ? "removed" : "changed",
    ...(before === undefined ? {} : { before: structuredClone(before) }), ...(after === undefined ? {} : { after: structuredClone(after) }) }];
}

export function sameWorkflowConfigurationVersion(left: WorkflowConfigurationVersion, right: WorkflowConfigurationVersion): boolean {
  return left.revision === right.revision && left.hash === right.hash;
}

/** Compare actual changed fields. Keyed graph collections retain their node,
 * Agent and group identities; unrelated array entries are not one conflict. */
export function workflowAdjustmentsConflict(left: WorkflowAdjustmentSubmission, right: WorkflowAdjustmentSubmission): boolean {
  const keyed = (value: unknown, path: string[] = []): unknown => {
    if (Array.isArray(value)) {
      const field = path.at(-1);
      const key = field === "agents" && path.length === 2 ? "name"
        : field === "nodes" ? "nodeId" : ["collaborations", "groups", "loops"].includes(field ?? "") ? "id" : undefined;
      if (key && value.every(item => item && typeof item === "object" && typeof item[key] === "string") &&
        new Set(value.map(item => item[key])).size === value.length) {
        // Order is retained separately: parallel input and graph presentation
        // order can also be an explicitly changed part of the proposal.
        return { order: value.map(item => item[key]), entries: Object.fromEntries(value.map(item =>
          [item[key], keyed(item, [...path, item[key]])])) };
      }
      return value;
    }
    return value && typeof value === "object" ? Object.fromEntries(Object.entries(value)
      .map(([key, item]) => [key, keyed(item, [...path, key])])) : value;
  };
  const changes = (request: WorkflowAdjustmentSubmission) => workflowAdjustmentChanges(keyed(request.baseSnapshot), keyed(request.proposal));
  const leftChanges = changes(left), rightChanges = changes(right);
  return leftChanges.some(a => rightChanges.some(b => a.path.every((part, index) => b.path[index] === part) ||
    b.path.every((part, index) => a.path[index] === part)));
}
