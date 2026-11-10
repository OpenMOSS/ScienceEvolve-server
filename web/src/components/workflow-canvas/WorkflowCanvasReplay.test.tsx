import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getWorkflowReplayConfigurationHistory, getWorkflowReplayEventPage } from "../../api";
import { DEFAULT_AGENT_ORCHESTRATION, DEFAULT_AGENTS, normalizeProject } from "../../lib";
import type { AgentEvent } from "../../types";
import { WorkflowCanvasReplay } from "./WorkflowCanvasReplay";
import { WorkflowCanvasRuntime } from "./WorkflowCanvasRuntime";

vi.mock("../../api", () => ({ getWorkflowReplayConfigurationHistory: vi.fn(), getWorkflowReplayEventPage: vi.fn(),
  getCatalog: vi.fn(async () => ({ mainSystemPrompt: "", defaultHarnessId: "codex", harnesses: [] })),
  getGitHubRepositoryStatus: vi.fn(), getProjectGitGraph: vi.fn(), ensureExecutionSummary: vi.fn(), getHarnessPrompt: vi.fn()
}));
const events: AgentEvent[] = [
  { seq: 1, type: "agent.started", agent: "idea", message: "Idea started", ts: "2026-10-01T00:00:00Z", data: { invocationId: "i1" } },
  { seq: 3, type: "agent.completed", agent: "idea", message: "Idea completed", ts: "2026-10-01T02:00:00Z", data: { invocationId: "i1" } },
  { seq: 5, type: "project.completed", message: "Project completed", ts: "2026-10-01T03:00:00Z" }
];
function project() {
  return normalizeProject({ id: "replay-ui", title: "Execution history", status: "completed", cycle: 99,
    orchestration: structuredClone(DEFAULT_AGENT_ORCHESTRATION), agents: structuredClone(DEFAULT_AGENTS),
    agentProgress: { idea: { state: "completed", executions: 99 } } });
}
beforeEach(() => {
  vi.mocked(getWorkflowReplayConfigurationHistory).mockResolvedValue({
    revisions: [{ revision: 1, ts: "2026-10-01T00:00:00Z", orchestration: structuredClone(DEFAULT_AGENT_ORCHESTRATION) }], configurations: []
  });
  vi.mocked(getWorkflowReplayEventPage).mockImplementation(async (_id, input) => input?.before
    ? { events: [events[0]!], hasMore: false, throughSeq: 5 }
    : { events: events.slice(1), hasMore: true, throughSeq: 5 });
});
afterEach(() => { vi.clearAllMocks(); });

describe("Workflow history playback controls", () => {
  it("loads older pages at one boundary and seeks without using the final project state", async () => {
    const value = project();
    const view = render(<WorkflowCanvasReplay project={value} onClose={vi.fn()} />);
    const frame = await screen.findByTitle("历史 Workflow 大画布") as HTMLIFrameElement;
    expect(getWorkflowReplayEventPage).toHaveBeenCalledWith(value.id, { before: 3, through: 5 }, expect.any(AbortSignal));
    fireEvent.click(screen.getByRole("button", { name: "暂停历史回顾" }));
    const send = vi.spyOn(frame.contentWindow!, "postMessage");
    fireEvent.change(screen.getByRole("slider", { name: "历史回顾进度" }), { target: { value: "1" } });
    fireEvent.load(frame);
    const snapshot = send.mock.calls.at(-1)![0].snapshot;
    expect(snapshot.nodeStates.idea).toBe("running");
    expect(snapshot.nodeStates.finish).toBe("waiting");
    expect(snapshot.cycle).toBe(0);
    expect(snapshot.playback).toMatchObject({ playing: false, reset: true });
    expect(snapshot.logs.map((entry: { seq: number }) => entry.seq)).toEqual([1]);
    view.rerender(<WorkflowCanvasReplay project={{ ...value, cycle: 100 }} onClose={vi.fn()} />);
    expect(getWorkflowReplayConfigurationHistory).toHaveBeenCalledTimes(1);
    expect(getWorkflowReplayEventPage).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "从头回顾" }));
    expect(screen.getByRole("button", { name: "暂停历史回顾" })).toBeInTheDocument();
  });

  it("opens history from the runtime card and returns to the existing live iframe", async () => {
    render(<WorkflowCanvasRuntime project={project()} events={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "历史回顾" }));
    await screen.findByTitle("历史 Workflow 大画布");
    expect(screen.getByRole("dialog", { name: "历史执行回顾" })).toBeInTheDocument();
    const live = screen.getByTitle("运行 Workflow 大画布");
    fireEvent.click(screen.getByRole("button", { name: "返回实时 Workflow" }));
    expect(screen.queryByTitle("历史 Workflow 大画布")).toBeNull();
    expect(screen.getByTitle("运行 Workflow 大画布")).toBe(live);
  });

  it("reports history errors and rejects a page that cannot advance", async () => {
    vi.mocked(getWorkflowReplayEventPage).mockResolvedValue({ events: [], hasMore: true, throughSeq: 5 });
    render(<WorkflowCanvasReplay project={project()} onClose={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("缺少事件游标");
    expect(screen.queryByText("暂无可回顾的执行记录。")).toBeNull();
    expect(getWorkflowReplayEventPage).toHaveBeenCalledTimes(1);
  });

  it("cancels history reads when the playback dialog closes", async () => {
    vi.mocked(getWorkflowReplayEventPage).mockImplementation(() => new Promise(() => {}));
    const view = render(<WorkflowCanvasReplay project={project()} onClose={vi.fn()} />);
    await waitFor(() => expect(getWorkflowReplayEventPage).toHaveBeenCalled());
    const signal = vi.mocked(getWorkflowReplayEventPage).mock.calls[0]![2]!;
    view.unmount();
    await act(async () => {});
    expect(signal.aborted).toBe(true);
  });
});
