import { describe, expect, it } from "vitest";
import type { ProjectExplainerEvent } from "../types";
import { explainerReplyProgress, foldExplainerMessages, isExplainerConversationMessage, mergeExplainerMessages, pendingExplainerMessage, reconcileExplainerHistory, restoreExplainerMessages } from "./project-explainer-events";

const event = (kind: ProjectExplainerEvent["kind"], text: string, extra: Partial<ProjectExplainerEvent> = {}): ProjectExplainerEvent =>
  ({ id: `${kind}:${text}`, projectId: "project", turnId: "current", ts: "2026-10-14T00:00:00Z", kind, text, ...extra });

describe("Explainer conversation presentation", () => {
  it("folds long histories in one pass and preserves item boundaries and replay deduplication", () => {
    const history = Array.from({ length: 2_000 }, (_, index) => event("assistant", `text-${index}`, {
      id: `event-${index}`, itemId: `item-${Math.floor(index / 2)}`, phase: index % 2 ? "completed" : "delta"
    }));
    const folded = foldExplainerMessages([...history, ...history]);
    expect(folded).toHaveLength(1_000);
    expect(folded[0]?.text).toBe("text-1");
    expect(folded.at(-1)?.text).toBe("text-1999");
    expect(mergeExplainerMessages(folded, history[0]!)).toBe(folded);
    expect(foldExplainerMessages(history.slice(0, 10))).toEqual(history.slice(0, 10).reduce(mergeExplainerMessages, []));
  });

  it("keeps malformed-argument diagnostics out of chat and shows recovery as one progress line", () => {
    const quarantined = event("error", "Protocol proxy quarantined a request".repeat(5), {
      phase: "delta", data: { diagnostic: true, errorCode: "PROTOCOL_TOOL_ARGUMENTS_INVALID" }
    });
    const recovery = event("status", "Recovery", { phase: "delta", data: { diagnostic: true, automaticRecovery: true } });
    expect(isExplainerConversationMessage(quarantined)).toBe(false);
    expect(explainerReplyProgress([quarantined, recovery], true)).toEqual({ phase: "working", text: "工具参数格式有误，正在自动恢复…" });
    const failed = event("error", "工具参数格式错误，自动恢复后仍失败。", { phase: "completed" });
    expect(isExplainerConversationMessage(failed)).toBe(true);
    expect(explainerReplyProgress([quarantined, recovery, failed], false)?.phase).toBe("failed");
  });

  it.each(["codex", "pi", "dsh", "fixture-anthropic", "another-harness"])("hides operational logs from %s without hiding errors or actions", harness => {
    const messages = [event("user", "Question"), event("assistant", "Answer", { phase: "delta" }),
      event("reasoning", "Public summary"), event("tool", "get_context"), event("tool_output", "Context"),
      event("error", "Actual failure", { data: { diagnostic: true } }),
      event("status", "Draft saved", { data: { assistantAction: { kind: "draft.saved" } } }),
      event("status", "User configuration changed", { data: { nativeSessionRebuilt: true } }),
      event("status", "Reply interrupted by user configuration", { data: { interrupted: true } })];
    const logs = [event("status", `${harness} native lifecycle`), event("status", "item.completed: error", { data: { diagnostic: true } }),
      event("status", "Model heartbeat", { data: { modelActivity: true } }), event("status", "Usage", { data: { canonicalEvent: { kind: "usage" } } })];
    expect([...messages, ...logs].filter(isExplainerConversationMessage)).toEqual(messages);
  });

  it.each([
    ["assistant", "正在生成回复…"], ["reasoning", "正在思考…"], ["tool", "正在调用工具…"], ["tool_output", "正在处理工具结果…"]
  ] as const)("keeps %s progress despite later diagnostics from the same turn", (kind, text) => {
    const events = [event(kind, "get_context", { phase: "delta" }), event("status", "Do not expose native diagnostic", { data: { diagnostic: true } })];
    const original = JSON.stringify(events);
    expect(explainerReplyProgress(events, true)).toMatchObject({ phase: "working", text });
    expect(JSON.stringify(events)).toBe(original);
  });

  it("does not announce a completed tool as still running", () => {
    expect(explainerReplyProgress([event("tool", "update_draft", { phase: "completed" })], true))
      .toEqual({ phase: "working", text: "正在处理工具结果…" });
  });

  it("uses only the current turn and requires a real terminal outcome", () => {
    const previous = event("error", "Previous failure", { turnId: "previous", phase: "completed" });
    const current = event("user", "New question");
    expect(explainerReplyProgress([previous, current], true)).toEqual({ phase: "working", text: "正在处理…" });
    expect(explainerReplyProgress([previous, current], false)).toBeUndefined();
    expect(explainerReplyProgress([current, event("status", "Native turn completed", { phase: "completed", data: { diagnostic: true } })], false)).toBeUndefined();
    expect(explainerReplyProgress([current, event("status", "回答完成", { data: { turnComplete: true } })], false))
      .toEqual({ phase: "completed", text: "回答完成" });
    expect(explainerReplyProgress([current, event("status", "解说已停止。", { phase: "completed" })], false))
      .toEqual({ phase: "stopped", text: "已停止" });
    expect(explainerReplyProgress([current, event("status", "当前回答已中断。", { phase: "completed", data: { interrupted: true } })], false))
      .toEqual({ phase: "stopped", text: "已停止" });
  });

  it("does not replay a previous answer's status while a new request is starting", () => {
    const completed = event("status", "回答完成", { data: { turnComplete: true } });
    expect(explainerReplyProgress([completed], true)).toEqual({ phase: "working", text: "正在处理…" });
    expect(explainerReplyProgress([], false)).toBeUndefined();
  });
});

const historyEvent = (id: string, text: string, phase: ProjectExplainerEvent["phase"] = "delta"): ProjectExplainerEvent => ({
  id, projectId: "p", turnId: "turn", itemId: "answer", kind: "assistant", text, phase, ts: `2026-10-28T08:00:0${id}.000Z`
});

it("does not remove live replies or action receipts when history temporarily lags", () => {
  const live = [historyEvent("1", "Reply", "completed"), { ...historyEvent("2", "Draft saved", "completed"), kind: "status" as const, data: { assistantAction: {} } }];
  expect(reconcileExplainerHistory(live, [])).toEqual(live);
});
it("reconciles already folded deltas without repeating text", () => {
  const first = historyEvent("1", "A"), second = historyEvent("2", "B");
  const live = foldExplainerMessages([first, second]);
  expect(reconcileExplainerHistory(live, [first])[0].text).toBe("AB");
  expect(reconcileExplainerHistory(live, [first, second])[0].text).toBe("AB");
  expect(reconcileExplainerHistory(live, [first, second, historyEvent("3", "Complete", "completed")])[0].text).toBe("Complete");
});
it("replaces the local user echo with exactly one acknowledged server message", () => {
  const pending = pendingExplainerMessage("p", "Create a draft");
  const ack = { ...pending, id: "server", turnId: "actual-turn", data: undefined, phase: "completed" as const };
  expect(mergeExplainerMessages([pending], ack)).toEqual([ack]);
  const restored = restoreExplainerMessages(JSON.parse(JSON.stringify([pending])));
  expect(restored[0].data?.clientPending).toBe("unconfirmed");
  expect(mergeExplainerMessages(restored, ack)).toEqual([ack]);
});
it("retains aggregated text after a reload with no in-memory delta identity map", () => {
  const first = historyEvent("1", "A");
  const cached = JSON.parse(JSON.stringify(foldExplainerMessages([first, { ...historyEvent("2", "B"), ts: first.ts }])));
  expect(reconcileExplainerHistory(cached, [first])[0].text).toBe("AB");
});
it("does not mistake an earlier identical question for acknowledgement of a newly submitted one", () => {
  const earlier = { ...historyEvent("1", "Same question", "completed"), kind: "user" as const, itemId: undefined };
  const pending = pendingExplainerMessage("p", earlier.text, [earlier]);
  expect(reconcileExplainerHistory([earlier, pending], [earlier])).toHaveLength(2);
  const acknowledged = { ...earlier, id: "new-server-question", turnId: "new-turn" };
  expect(reconcileExplainerHistory([earlier, pending], [earlier, acknowledged])).toHaveLength(2);
});
