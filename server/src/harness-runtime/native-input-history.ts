import path from "node:path";
import type { SessionRef } from "./contracts.js";

/** Proof supplied by the selected Adapter from its exact visible user input. */
export interface NativeInputHistoryEvidence {
  session: SessionRef;
  history: { relativePath: string; byteOffset: number; sha256: string; nativeTimestamp: string };
}

export interface NativeInputHistoryRequest {
  projectPath: string;
  workspacePath: string;
  agentId: string;
  session: SessionRef;
  notification: string;
}

export function nativeSessionHome(projectPath: string, agentId: string, harnessId: string): string {
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,63})$/.test(harnessId)) throw new Error("Invalid native session Harness identity");
  const segment = agentId.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 128) || "agent";
  return path.join(projectPath, "runtime", "harness-sessions", segment, harnessId);
}
