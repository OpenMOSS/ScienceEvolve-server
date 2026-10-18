import path from "node:path";
import { MAIN_AGENT_ORCHESTRATION_CURRENT_FILE } from "../main-workflow-files.js";
import { SII_AGENT_GUIDANCE } from "../sii-experiments.js";
import type { AgentConfig, AgentPermission, AgentRunRequest } from "../types.js";
import type {
  HarnessDescriptor,
  InvocationInputs,
  InvocationPolicy
} from "./contracts.js";
import { HarnessRuntimeError } from "./errors.js";
import { resolvedMcpServers } from "../mcp-directory.js";
import { visibleToolNamesForPrompt } from "../orchestration-control-mcp.js";
import { AGENT_PERMISSION_METADATA } from "../internal/shared/agent-permission-metadata.js";
import { PROJECT_STATE_GUIDANCE, MAIN_STATE_RECORDS_GUIDANCE } from "../internal/shared/project-state-policy.js";
import { workflowUserInterventionGuidance } from "../workflow-user-intervention-policy.js";
export { sessionRecoveryNote } from "../internal/shared/session-recovery.js";

const PERMISSION_PROMPTS: Record<AgentPermission, string> = {
  workspace: [
    "OpenFARS permission mode: workspace.",
    `File modification scope: ${AGENT_PERMISSION_METADATA.workspace.label}.`,
    "Writes are limited to the worktree assigned to this task; reads follow the injected authorized roots.",
    "Do not use shell execution or direct file-write tools.",
    "Perform state-changing workspace operations only through the injected OpenFARS MCP tools."
  ].join(" "),
  compute: [
    "OpenFARS permission mode: compute.",
    `File modification scope: ${AGENT_PERMISSION_METADATA.compute.label}.`,
    "Host-authorized reads may use the service-user tree subject to operating-system access.",
    "Writes are limited to explicitly registered worktrees for this project; other projects and OpenFARS state are forbidden.",
    "Route filesystem writes through the descriptor-relative OpenFARS broker. Business tools are selected separately; this scope grants no experimental capability."
  ].join(" "),
  yolo: [
    "OpenFARS permission mode: yolo.",
    `File modification scope: ${AGENT_PERMISSION_METADATA.yolo.label}.`,
    "The CLI's native permission mode remains authoritative.",
    "Keep all actions scoped to this project and never expose credentials or hidden reasoning."
  ].join(" ")
};

export function compileInvocationPolicy(
  config: AgentConfig,
  request: Pick<AgentRunRequest,
    "permission" | "skillPaths" | "autoSkillPaths" | "control" | "executionContext" | "terminalPushObservation" | "terminalPushCoordination" | "worktreeClosing" | "siiMcp">
): InvocationPolicy {
  if (request.worktreeClosing) {
    return {
      permission: "workspace",
      constraintPrompt: "OpenFARS permission mode: workspace. This finite turn closes only the exact files in your original Leader's grant. Read evidence through the injected tools; write or remove only authorized regular files through the descriptor broker. Use the invocation-bound Git tools for necessary checkpoint/publication. Shell, native writes, independent Git, external MCP, experiments, Skills and Web Search are unavailable.",
      skillPaths: [], autoSkillPaths: [], mcpServers: [], webSearch: false,
      reasoningEffort: config.reasoningEffort
    };
  }
  if (request.terminalPushCoordination) {
    return {
      permission: "workspace",
      constraintPrompt: "OpenFARS permission mode: workspace. This invocation coordinates one assigned Agent receipt issue in the running workflow. Read its actual evidence, Inbox and persistent memory through the injected read tools. Submit only your own coordination decision, finish_task and memory through the assigned control tools. The system transports your decision; it must not perform another Agent's work or choose retry/escalation/user help for you.",
      skillPaths: [], autoSkillPaths: [], mcpServers: [], webSearch: false,
      reasoningEffort: config.reasoningEffort
    };
  }
  if (request.terminalPushObservation) {
    return {
      permission: "workspace",
      constraintPrompt: "OpenFARS permission mode: workspace. This is a completed-task historical push receipt turn. Read the original Inbox, persistent memory and workspace evidence through the injected read tools. Business files are read-only. Only the injected invocation-bound control tools may record this supplement's receipt and Agent-authored memory.",
      skillPaths: [], autoSkillPaths: [], mcpServers: [], webSearch: false,
      reasoningEffort: config.reasoningEffort
    };
  }
  return {
    permission: request.permission,
    constraintPrompt: PERMISSION_PROMPTS[request.permission],
    skillPaths: uniqueNonEmpty(request.skillPaths),
    autoSkillPaths: uniqueNonEmpty(request.autoSkillPaths ?? []),
    // Only the invocation-bound runtime may supply this built-in endpoint.
    mcpServers: resolvedMcpServers([...config.mcpServers.filter(server => server.name.trim().toLowerCase() !== "scienceevolve-sii"), ...(request.siiMcp ? [{ name: "scienceevolve-sii", url: request.siiMcp.url }] : [])]),
    webSearch: config.webSearch,
    reasoningEffort: config.reasoningEffort
  };
}

/** Reject configured features that the selected Adapter cannot actually expose. */
export function assertInvocationPolicySupported(
  descriptor: HarnessDescriptor,
  policy: InvocationPolicy
): void {
  const unsupported = [
    policy.webSearch && !descriptor.capabilities.webSearch ? "Web Search" : undefined,
    policy.skillPaths.length > 0 && !descriptor.capabilities.skills ? "Skills" : undefined,
    policy.autoSkillPaths.length > 0 && !descriptor.capabilities.autoSkills ? "Auto Skills" : undefined,
    policy.mcpServers.length > 0 && !descriptor.capabilities.mcp ? "MCP" : undefined,
    !descriptor.capabilities.permissionPrompts.includes(policy.permission)
      ? `${policy.permission} permission prompt`
      : undefined
  ].filter((item): item is string => Boolean(item));
  if (!unsupported.length) return;
  throw new HarnessRuntimeError(
    "HARNESS_CAPABILITY_UNSUPPORTED",
    `${descriptor.label} does not support the configured ${unsupported.join(", ")}`,
    { harnessId: descriptor.id, unsupported },
    { source: "policy" }
  );
}

export function compileWorkflowPrompt(
  request: AgentRunRequest,
  inputs: InvocationInputs,
  policy: InvocationPolicy,
  options: { inlineInbox?: string; recoveryNote?: string } = {}
): string {
  const config = request.project.agents[request.agent];
  const mandate = config.instructions.trim();
  const inlineInbox = request.terminalControlRepair ? undefined : options.inlineInbox;
  const businessTurn = !request.terminalPushObservation && !request.terminalPushCoordination && !request.worktreeClosing;
  const currentInstruction = (label: string, text: unknown) => businessTurn && typeof text === "string" && text.trim() && !inlineInbox?.includes(text)
    ? `${label}:\n${text}` : undefined;
  const repairReminder = request.terminalControlRepair
    ? [
        "The preceding turn returned a handoff without a required terminal control action.",
        "Re-read the Inbox, workspace and project evidence needed to validate that handoff; do not assume the business work or completion condition is satisfied.",
        'The full previous handoff is available as source="terminal-control-repair" in the on-demand context index. Inspect the relevant evidence before supplying the missing action.',
        "After resolving any evidence gap, commit exactly one currently legal terminal action through the orchestration-control server."
      ].join("\n")
    : undefined;
  const roleContext = invocationRoleContext(request);
  const controlTools = request.control
    ? visibleToolNamesForPrompt({ ...request.control, agent: request.agent,
      ...(request.onProjectStateRequest ? { projectState: true } : {}) }, request.kind)
    : [];
  return [
    policy.constraintPrompt,
    request.purpose === undefined || request.purpose === "workflow"
      ? inlineInbox?.includes(workflowUserInterventionGuidance(request.project)) ? undefined : workflowUserInterventionGuidance(request.project) : undefined,
    currentInstruction("Current canonical project research requirement", request.project.requirement),
    currentInstruction("Current user instructions for supplied inputs", request.project.inputDescription),
    currentInstruction("Current project acceptance/termination condition", request.project.orchestration?.termination?.condition),
    businessTurn && request.project.orchestration?.resultFormat && !inlineInbox
      ? `Current requested result format:\n${JSON.stringify(request.project.orchestration.resultFormat)}` : undefined,
    mandate && !request.terminalPushObservation && !request.terminalPushCoordination && !request.worktreeClosing
      ? inlineInbox?.includes(mandate) ? undefined : `Standing Agent mandate:\n${mandate}`
      : request.worktreeClosing
        ? "Your standing business mandate is retained. This turn is solely the original Leader-authorized worktree closing supplement."
      : request.terminalPushObservation
        ? "Your standing business mandate is retained for later business invocations. This turn is solely the assigned historical push observation supplement."
        : request.terminalPushCoordination
          ? "Your standing business mandate is retained for later Worker invocations. This turn is solely the assigned receipt coordination; your current role and assigned tools determine what you may do."
          : "No additional standing Agent mandate is configured.",
    inlineInbox
      ? `Current task Inbox: ${inputs.inboxPath}. Its exact current instructions are included below; use the context index for background and do not reload unchanged material.`
      : `Current task Inbox: ${inputs.inboxPath}. Open it for your assigned task; use the context index for background records and read details only when needed.`,
    `Persistent project memory: ${inputs.memoryPath}. Consult relevant portions when needed; do not reload unchanged memory or entire histories by default.`,
    request.control?.projectState || request.onProjectStateRequest ? PROJECT_STATE_GUIDANCE : undefined,
    (request.control?.projectState || request.onProjectStateRequest) &&
      (request.control?.collaboration?.role === "scoped-main" || request.terminalPushCoordination?.role === "main" ||
        request.kind === "main" && !request.executionContext?.groupRunId) ? MAIN_STATE_RECORDS_GUIDANCE : undefined,
    inputs.userInputsPath
      ? `User-supplied files and images are in the shared input directory ${inputs.userInputsPath}. Read relevant inputs there as supplementary evidence for the User requirement, including files added later. This directory is outside collaboration Git worktrees; preserve originals and write outputs in your assigned workspace.`
      : undefined,
    inputs.workflowAuthoringPath
      ? `Your sole writable management area is ${path.dirname(inputs.workflowAuthoringPath)}. For a permitted configuration revision, edit the proposal at ${inputs.workflowAuthoringPath}, then submit apply_workflow with path "workflow.json". Do not edit business code, the checkout's workflow.json, or Git branches.`
      : undefined,
    inputs.workflowAuthoringPath
      ? `Your original proposal and its baseHash/baseVersion are retained. Read the current accepted authoring reference at ${inputs.workflowCurrentPath ?? path.join(inputs.workspacePath, MAIN_AGENT_ORCHESTRATION_CURRENT_FILE)}. If the original version differs or is missing, preserve and explicitly reconcile your intended edits with that current document; the server does not merge or rebase your draft. The reference is read-only and is not the submission path.`
      : undefined,
    inputs.workflowAuthoringPath
      ? "Preserve the proposal's full JSON structure and every unrelated field. In a schemaVersion=2 proposal, the outer schemaVersion stays 2 even when orchestration.schemaVersion is 3. The graph stays inside orchestration; orchestration.agents is the identity array, while the separate top-level agents is the editable configuration object keyed by Agent name. Keep both, plus skillDefinitions, mcpDefinitions, baseHash, editingInstructions and lockedRuntime. Do not flatten the graph, replace one agents field with the other, or copy lockedRuntime into graph identities. The read-only workflow/definition.json publication has a different wrapper; do not copy its outer schemaVersion/workflowRevision/workflow fields over your authoring proposal. For a Loop-only change, edit only the intended maxIterations inside orchestration.scopedWorkflow.groups; preserve existing resource text exactly. Reread the written proposal and the actual apply_workflow diagnostic before proceeding."
      : undefined,
    inlineInbox ? `Current assigned task Inbox:\n\n${inlineInbox}` : undefined,
    inputs.workflowContext?.preview,
    inputs.contextIndex?.preview,
    ...(request.nativeInputNotices ?? []),
    repairReminder,
    request.toolCatalog && request.agent === "main" && request.kind === "main" &&
      request.project.orchestration?.allowMainReconfiguration === true &&
      request.control?.allowWorkflowReconfiguration === true &&
      (request.purpose === undefined || request.purpose === "workflow") &&
      !request.terminalPushObservation && !request.terminalPushCoordination && !request.worktreeClosing
      ? "Available Agent Skill/MCP directory: use the agent-tool-catalog sources in the on-demand context index. These describe available selections and do not grant tools."
      : undefined,
    request.siiMcp && !request.worktreeClosing ? SII_AGENT_GUIDANCE : undefined,
    request.worktreeClosing ? undefined : request.siiResumePrompt,
    roleContext,
    controlTools.length
      ? `The authoritative orchestration tools/list for this invocation exposes exactly: ${controlTools.map((name) => `\`${name}\``).join(", ")}. These are raw MCP tool names; call each tool by the name exposed by your current Harness, including its MCP namespace when present. A raw name alone is not a separate built-in function. Do not call or claim any other orchestration tool; the list and structured errors are authoritative.`
      : "No orchestration control tools are exposed in this invocation. Do not invent a control-tool name; return a natural-language handoff.",
    "Read large Inbox, memory, and artifact files in bounded sections as needed; do not load entire logs or repeatedly reload unchanged evidence.",
    policy.skillPaths.length
      ? `Read and follow only these selected SKILL.md files when relevant:\n${policy.skillPaths.map((item) => `- ${item}`).join("\n")}`
      : "No fixed Skills are selected for this invocation.",
    policy.autoSkillPaths.length
      ? `These Skills may be selected when relevant:\n${policy.autoSkillPaths.map((item) => `- ${item}`).join("\n")}`
      : "No automatic Skills are exposed for this invocation.",
    `Web Search is ${policy.webSearch ? "enabled" : "disabled"} for this invocation.`,
    options.recoveryNote,
    request.worktreeClosing
      ? "Inspect the actual closing and delivery results, submit your own separate finish_task and concise handoff, including any unresolved blocker. Optional finish_task memory is a supplement record; it does not rewrite the original business Memory or report. A receipt or clean checkout alone does not settle this issue."
      : request.terminalPushObservation
      ? "Inspect the real observation result yourself, then call finish_task for this supplement and return a concise handoff. Include any unresolved provider evidence or blocker; neither your handoff nor finish_task alone confirms that a push succeeded."
      : request.terminalPushCoordination
        ? "Read the assigned issue and actual Agent output, submit your own finish_task and permitted coordination decision, then return your concise handoff. Missing provider evidence remains a blocker; do not infer or manufacture success."
        : "Complete the assigned work in the current project workspace.",
    request.terminalPushObservation || request.terminalPushCoordination || request.worktreeClosing ? undefined
      : "Use the injected OpenFARS workspace/control tools for state changes, then return one concise natural-language handoff.",
    request.kind === "main"
      ? "When an orchestration decision is ready, record it with one of the injected control tools. An accepted decision does not end the native Harness turn; finish the turn naturally after completing any remaining non-conflicting work and return a concise handoff."
      : undefined
  ].filter((item): item is string => Boolean(item)).join("\n\n");
}

function invocationRoleContext(request: AgentRunRequest): string {
  const context = request.executionContext;
  const role = context?.role ?? (request.kind === "main" ? "main" : "worker");
  const scope = context
    ? context.role === "leader"
      ? ("groupRunId" in context ? `group:${context.groupRunId}` : `route:${context.routeScopeId}`)
      : `${context.role}:${context.executionId}`
    : "project";
  const wakeReason = request.worktreeClosing ? "worktree-closing" : request.terminalPushCoordination ? "terminal-push-coordination" : request.terminalPushObservation ? "terminal-push-observation" : request.project.pendingMainDecision?.reason ??
    (request.terminalControlRepair ? "terminal-control-repair" : "workflow-dispatch");
  const stage = request.project.phase || "unknown";
  return [
    "## Current role and execution stage",
    `- role: ${role}`,
    `- scope: ${scope}`,
    `- stage: ${stage}`,
    `- wake reason: ${wakeReason}`,
    `- task session: ${request.taskSessionId ?? "none"}`,
    "Role and scope apply only to this invocation. On a later Worker/Leader return, re-read this section and the Inbox instead of retaining a temporary management mandate.",
    "Use finish_task for your own task completion; a natural model return is not a completion receipt. Main/Leader routing, complete_group and complete_project remain separate authorized actions.",
    ...(request.worktreeClosing ? [
      "The original task, report, completion status, branch and persistent session remain retained. This is a separate finite closing invocation in that same session, authorized by your original direct Leader.",
      `Immutable original report A: ${request.worktreeClosing.reportHeadSha}. Authorized exact files: ${JSON.stringify(request.worktreeClosing.paths)}.`,
      "Inspect the retained Inbox, original session and actual file evidence yourself. Decide the necessary correction or removal within that manifest. Do not perform new business work or change another file. Write your business Memory only if its exact path is explicitly authorized; finish_task memory is saved separately.",
      "After any necessary correction, explicitly call git_push with your own nonempty reason. It checkpoints only authorized pending files. If the current head differs from A, use your own PR tools to deliver that exact B to the direct target supplied in the Inbox. The original report and A delivery are immutable; a prior A PR cannot deliver B. If nothing changed from A, do not create an empty commit or a substitute PR.",
      "Read each actual Git result and decide any retry yourself. git_get_operation and git_reconcile_push refer only to this closing invocation's separate operations; historical reconciliation, conflict preparation, routing, artifact publication and group/project completion are unavailable. Report a real blocker through your own finish_task and handoff."
    ] : []),
    ...(request.terminalPushCoordination ? [
      `Your current receipt role is ${request.terminalPushCoordination.role}, level ${request.terminalPushCoordination.level}, issue ${JSON.stringify(request.terminalPushCoordination.incidentId)}.`,
      "Coordinate this exact assigned issue yourself using coordinate_agent_receipt. Retry asks the original Agent to inspect its receipt; a Leader escalation goes only to the direct parent coordinator. This tool never wakes an arbitrary Agent.",
      request.terminalPushCoordination.canRequestUser
        ? "As the assigned GLOBAL Main, you may request_user if you cannot resolve this issue; explain the actual blocker and needed user input."
        : "User requests are not assigned in this turn; follow the direct parent coordination path if needed. Main acting as a group Leader retains that Leader role.",
      "Finish and write memory for your own coordination turn, then return your actual handoff. Do not replace the other Agent's handoff, business output, Git result or decision."
    ] : []),
    ...(request.terminalPushObservation ? [
      "The original business task is already complete. Its completion, handoff, report, branch and session remain retained; this is a separate finite receipt turn in that same persistent session.",
      `Read your original memory, inbox and any saved original tool results supplied before this input. If the inbox identifies an unfinished push, call git_reconcile_push with operationId=${JSON.stringify(request.terminalPushObservation.operationId)}, historical=true, and retry omitted or false. If that push is already finalized or superseded, receive the saved results without repeating its query or publication. Superseded preserves the unknown original push outcome and proves only inclusion in a later publication.`,
      "The provider returns its actual result directly to you. Inspect it and explain what it proves or what remains unresolved in your own handoff. The system does not retry Git operations or decide that remote work succeeded.",
      "Do not modify business files or create new commits, push, create/merge PRs, route work, or end a group/project in this receipt turn. Missing evidence is a blocker to report, not renewed business authority."
    ] : []),
    ...(request.project.git?.enabled && context && context.role !== "leader" && !request.terminalPushObservation && !request.worktreeClosing ? [
      "This invocation has business/delivery authority. You may perform the assigned Worker work even if an earlier invocation was management-only.",
      context.executionId.startsWith("group-final-")
        ? "For this canonical delivery, the group head is already published. Explicitly use github_get_pr/github_create_pr/github_merge_pr for its exact assigned head and direct target; preserve your existing business checkout."
        : `For this Git-enabled task, inspect the Inbox's current task and retained work-record stage before writing agent-memory/${request.agent}/Memory.md. A continuation of the same logical task does not require repeating a completed work-record step or appending a new entry solely because the physical invocation changed; use your actual handoff for supplemental operational observations. When a work record is still required, append verified facts, decisions, handoff and any no-code review, preserving earlier entries, and commit it with the business changes or by itself. Then call git_push and use github_create_pr/github_get_pr/github_merge_pr for execution ${context.executionId}. Any commit made after a PR was merged is a new head requiring its own matching delivery; a clean checkout does not establish that coverage. Keep existing report/completion bindings immutable and report unavailable authority through the existing handoff. Use the direct target documented in the inbox; an owned group member targets its direct group, a root delivery targets main.`,
      ...(context.role === "final-integration" ? [
        "When your legacy canonical task publishes its assigned group branch, git_push may return already_published for its exact existing remote head without a new business commit. Inspect that real result, then use your PR tools; repair tasks on executions/ branches still publish their own intended repair commit."
      ] : []),
      "Every file in your Git workspace, including Memory, hidden files and configuration, belongs to the versioned project. On a writable business task use git_status and git_stage with paths=[\".\"] to include every workspace change, then commit and deliver them. finish_task saves its Agent-authored memory/summary as one append-only record for that logical business task in your actual worktree; inspect git_status after finish_task and deliver any newly saved record before returning. A resumed physical turn reuses the same task record and must not append it repeatedly. Canonical publication-only and immutable-report continuations preserve their assigned original head and business Memory: finish_task saves their supplement outside the business checkout and does not authorize business changes or a replacement report.",
      "Every provider result returns directly to you. Inspect it and decide whether to retry, repair with your allowed tools, or report the real blocker in your existing handoff. The system will not publish or repair business work after your natural exit.",
      "Git MCP responses distinguish the returned outcome from gitDeliveryReady. A successful query, saved control receipt, successful later push or merged PR does not settle an earlier unknown operation. If Git delivery is not ready, inspect missingActions and unresolvedOperations, then use the original operation's nextAction and actual result. A journal query alone does not reconcile it. Preserve already verified work; do not repeat research or declare delivery complete while an original operation remains unsettled. finish_task records your handoff separately from these Git gates.",
      ...(!context.executionId.startsWith("group-final-") ? [
        "If a Git/GitHub response timed out or was lost, read git_get_operation with its exact operationId from your original session/inbox first. It returns the stored original request and distinguishes unconfirmed remote outcome from confirmed remote success with pending local stages. It does not retry, finalize or release anything. You decide waiting, provider observation, original-request/local recovery or escalation from the actual facts.",
        "If your original task retains an unfinished git.push journal, call git_reconcile_push with its exact operationId from your original session/inbox. It defaults to remote observation. Inspect an unconfirmed result: only if you decide to re-send its original commit, explicitly set retry=true. Your original local head and ownership must match; no new commit or force push is made. You decide retry or escalation.",
        "To observe a push from your own older task or ownership epoch, explicitly set historical=true on git_reconcile_push. This only queries the original remote ref and confirms the exact old receipt; it cannot retry, restore an expired task's Git permissions or provide the current task's PR head. Preserve the current task and inspect your retained session before selecting the original operationId."
      ] : []),
      "If you decide to abandon your own PR, use github_close_pr and inspect its actual result. Closing a PR does not complete this task or select a repair owner; report any remaining blocker through the existing handoff."
    ] : [])
  ].join("\n");
}

function uniqueNonEmpty(values: readonly string[]): string[] {
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))];
}
