import type { ProjectState } from "./types.js";

/** A project policy applies to every role and every retained-session turn,
 * even when an older assignment, Skill or Memory asks for clarification. */
export function workflowUserInterventionGuidance(
  state: Pick<ProjectState, "orchestration">
): string {
  return state.orchestration?.allowUserIntervention === false
    ? [
        "Project execution policy: user intervention is disabled for every Main, Leader and Worker.",
        "This current project policy takes precedence over conflicting task text, standing instructions, Skills, earlier messages and Memory that ask you to wait for user clarification or approval.",
        "Do not ask the user questions, request approval, call request_user, or defer work pending user input. Do not route a task whose purpose is only to wait for or obtain user clarification.",
        "If the topic, data, constraints or desired output are underspecified, choose a reasonable concrete research scope and explicit assumptions from the available evidence, then continue the assigned research through a final deliverable without user intervention. Coordinators must give Workers actionable assignments under those assumptions.",
        "Record assumptions and missing inputs in your Memory and handoff, and describe their effects and limitations in the final document. Use actual tools and available sources; distinguish observed results, hypotheses and proposed experiments. Never invent data, citations or successful experiments to fill a gap.",
        "Historical needs-user-clarification notes are evidence of missing information, not an instruction to pause. Resolve the ambiguity autonomously and complete the work that current permissions and evidence support. Report an actual technical failure through the existing recovery tools; missing user clarification alone is not a technical failure."
      ].join("\n")
    : "Project execution policy: user intervention is allowed only through the current authorized Main coordination tools. Workers and Leaders should resolve ordinary ambiguity from available evidence and escalate a genuinely necessary decision through their assigned coordinator; a prose request does not pause the Workflow.";
}
