import { createHash } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { nativeSessionHome, type NativeInputHistoryRequest, type NativeInputHistoryEvidence } from "../native-input-history.js";
import { redactTrace } from "../../utils.js";

export function codexNativeSessionHome(projectPath: string, agentId: string): string {
  return nativeSessionHome(projectPath, agentId, "codex");
}

/** One bounded read of this Agent's exact native rollout. Never read host
 * CODEX_HOME, other threads, reasoning, or a partial/truncated user row. */
export async function readCodexNativeNotification(input: NativeInputHistoryRequest): Promise<NativeInputHistoryEvidence | undefined> {
  const { session } = input;
  if (session.harnessId !== "codex" || !session.durable || !input.notification ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(session.nativeId)) return undefined;
  try {
    const project = path.resolve(input.projectPath);
    const home = codexNativeSessionHome(project, input.agentId);
    const sessions = path.join(home, "sessions");
    // Reject parent redirects as well as a symlinked rollout.
    if (await fs.realpath(project) !== project || await fs.realpath(sessions) !== sessions) return undefined;
    const matches: string[] = [];
    let entriesObserved = 0;
    const descend = async (directory: string, depth: number): Promise<void> => {
      for await (const entry of await fs.opendir(directory)) {
        if (++entriesObserved > 4096) throw new Error("Native rollout lookup exceeded its bounded directory scan");
        if (entry.isSymbolicLink()) continue;
        if (depth < 3 && entry.isDirectory() && (depth === 0 ? /^\d{4}$/ : /^\d{2}$/).test(entry.name)) {
          await descend(path.join(directory, entry.name), depth + 1);
        } else if (depth === 3 && entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(`-${session.nativeId}.jsonl`)) {
          matches.push(path.join(directory, entry.name));
        }
      }
    };
    await descend(sessions, 0);
    if (matches.length !== 1 || await fs.realpath(matches[0]!) !== matches[0]) return undefined;
    const file = await fs.open(matches[0]!, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1) return undefined;
      const header = Buffer.alloc(Math.min(stat.size, 64 * 1024));
      const headerRead = await file.read(header, 0, header.length, 0);
      const end = header.subarray(0, headerRead.bytesRead).indexOf(10);
      if (end < 0) return undefined;
      const meta = JSON.parse(header.subarray(0, end).toString("utf8"));
      if (meta.type !== "session_meta" || meta.payload?.id !== session.nativeId ||
        meta.payload?.cwd !== path.resolve(input.workspacePath) || meta.payload?.source !== "exec") return undefined;
      const start = Math.max(0, stat.size - 8 * 1024 * 1024);
      const tail = Buffer.alloc(stat.size - start);
      const read = await file.read(tail, 0, tail.length, start);
      const bytes = tail.subarray(0, read.bytesRead);
      let offset = start ? bytes.indexOf(10) + 1 : 0;
      if (offset < 0 || (start && offset === 0)) return undefined;
      let evidence: NativeInputHistoryEvidence | undefined;
      for (;;) {
        const newline = bytes.indexOf(10, offset);
        if (newline < 0) break;
        const line = bytes.subarray(offset, newline);
        let row: Record<string, any>;
        try { row = JSON.parse(line.toString("utf8")); } catch { offset = newline + 1; continue; }
        if (row.type === "response_item" && row.payload?.type === "message" && row.payload?.role === "user" &&
          typeof row.timestamp === "string" && Number.isFinite(Date.parse(row.timestamp)) && Array.isArray(row.payload.content)) {
          const text = row.payload.content.filter((part: Record<string, unknown>) => part.type === "input_text" && typeof part.text === "string")
            .map((part: { text: string }) => part.text).join("\n");
          if (redactTrace(text).includes(input.notification)) evidence = { session: structuredClone(session), history: {
            relativePath: path.relative(home, matches[0]!), byteOffset: start + offset,
            sha256: createHash("sha256").update(line).digest("hex"), nativeTimestamp: row.timestamp } };
        }
        offset = newline + 1;
      }
      return evidence;
    } finally { await file.close(); }
  } catch { return undefined; }
}
