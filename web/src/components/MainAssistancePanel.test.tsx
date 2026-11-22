import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MainAssistancePanel } from "./MainAssistancePanel";
import { normalizeProject } from "../lib";
import type { MainAssistanceRecord } from "../types";
afterEach(cleanup);
const record: MainAssistanceRecord = { id: "request-1", status: "replied", question: "How can I compare?",
  origin: { projectId: "p", agentId: "worker", taskId: "loop1-task", invocationId: "original" },
  main: { invocationId: "main1", receivedAt: "2026-11-16T00:00:00Z" },
  reply: { text: "Compare the actual baseline.", savedAt: "2026-11-16T00:01:00Z", invocationId: "main1", callId: "reply1" },
  delivery: { status: "offered" }, createdAt: "2026-11-16T00:00:00Z", updatedAt: "2026-11-16T00:01:00Z" };
describe("Main assistance presentation", () => {
  it("keeps saved replies distinct from confirmed receipt", () => {
    const project = normalizeProject({ id: "p", mainAssistance: [record] });
    render(<MainAssistancePanel records={project.mainAssistance!} />);
    expect(screen.getByText("答复已发出，接收未确认")).toBeInTheDocument();
    expect(screen.queryByText("原任务已收到答复")).not.toBeInTheDocument();
    expect(screen.getByText(record.reply!.text)).toBeInTheDocument();
  });
  it("shows retained late replies and processing failures without task restart controls", () => {
    render(<MainAssistancePanel records={[{ ...record, delivery: { status: "late" } }, { ...record, id: "failed", status: "failed", reply: undefined, delivery: undefined, error: "Main invocation failed" }]} />);
    expect(screen.getByText("原任务已结束，迟到答复已保留")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Main invocation failed");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
