import { MAIN_AGENT_NAME, type AgentId } from "../types.js";
import type { GroupActivationOrigin } from "./contracts.js";
import { CollaborationStateError } from "./errors.js";

/** Frozen v2 leader table. Display names are deliberately not accepted. */
export function deriveGroupLeader(origin: GroupActivationOrigin): AgentId {
  switch (origin.kind) {
    case "agent-route":
      if (!origin.sourceAgentId || origin.sourceAgentId === MAIN_AGENT_NAME) {
        throw new CollaborationStateError(
          "INVALID_STATE_TRANSITION",
          "An ordinary-Agent route requires a non-Main source Agent"
        );
      }
      return origin.sourceAgentId;
    case "main-selection":
    case "main-direct":
    case "project-input":
    case "group-route":
      return MAIN_AGENT_NAME;
  }
}
