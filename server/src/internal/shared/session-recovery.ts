/**
 * Shared durable-session recovery guidance. A missing tool result is not
 * evidence that the tool never ran, so every resume/replacement path must
 * verify durable effects before it repeats a mutation.
 */
export function sessionRecoveryNote(reason?: string): string {
  return [
    "Session continuation safety: before continuing, inspect the previous terminal or tool calls and their actual durable results. A missing tool response does not mean the operation did not run.",
    "Inspect existing deliverables and memory before repeating any write, append, computation, publication, or other side effect.",
    "Check the accessible command output, files, logs, published artifacts, handoff, checkpoint, and Memory.md; distinguish completed work from unfinished work and repeat only the unfinished part.",
    "If the original native-session history is unavailable, use the project evidence that is still accessible. If the result remains uncertain, state which evidence you checked and which operation is uncertain in the handoff so Main can decide.",
    reason ? `Recovery reason: ${reason}` : undefined
  ].filter((item): item is string => Boolean(item)).join("\n");
}
