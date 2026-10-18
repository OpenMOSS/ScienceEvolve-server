import { createContext } from "react";
import type { CanvasTextDrafts } from "../../workflowAdjustmentDraft";

/** Optional host persistence for unfinished fields; normal blur/shared-Agent
 * confirmation still controls when a field enters the editable snapshot. */
export const CanvasTextDraftContext = createContext<{
  drafts: CanvasTextDrafts;
  update(path: string[], value: string): void;
  remove(key: string): void;
} | undefined>(undefined);
