import { isDeepStrictEqual } from "node:util";
import type { ControlAction } from "./types.js";

/** A retry may explain the same Git request differently. The first envelope
 * and its original reason remain canonical; target, PR, mode, content and
 * ownership must still match exactly. This never joins different call IDs. */
export function sameControlActionRequest(left: ControlAction, right: ControlAction): boolean {
  if (isDeepStrictEqual(left, right)) return true;
  if (left.tool !== right.tool || !["git_push", "github_merge_pr", "github_close_pr"].includes(left.tool)) return false;
  const omitReason = (action: ControlAction) => Object.fromEntries(
    Object.entries(action).filter(([key]) => key !== "reason")
  );
  return isDeepStrictEqual(omitReason(left), omitReason(right));
}
