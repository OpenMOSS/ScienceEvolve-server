import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getWorkflowReplayConfigurationHistory, getWorkflowReplayEventPage } from "../../api";
import { DEFAULT_AGENT_ORCHESTRATION, DEFAULT_AGENTS, normalizeProject } from "../../lib";
import type { AgentEvent } from "../../types";
import { WorkflowCanvasReplay } from "./WorkflowCanvasReplay";
import { WorkflowCanvasRuntime } from "./WorkflowCanvasRuntime";
import { normalizeCanvasLayout } from "./core/canvas-layout";
import { adaptWorkflowToCanvas } from "./core/canvas-adapter";

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
  it("uses the formal layout across revisions while retaining historical nodes and routes", async () => {
    const orchestration = structuredClone(DEFAULT_AGENT_ORCHESTRATION);
    orchestration.canvas = normalizeCanvasLayout(undefined, orchestration);
    orchestration.canvas.nodes.idea = { x: 4200, y: 260 };
    orchestration.agents.push({ name: "retired" });
    orchestration.routes.retired = [{ target: "idea", kind: "weak" }];
    const later = structuredClone(orchestration);
    later.canvas!.nodes.idea = { x: -3600, y: 260 };
    vi.mocked(getWorkflowReplayConfigurationHistory).mockResolvedValue({ revisions: [
      { revision: 1, ts: events[0]!.ts, orchestration },
      { revision: 2, ts: events[2]!.ts, orchestration: later }
    ], configurations: [] });
    vi.mocked(getWorkflowReplayEventPage).mockResolvedValue({
      events: [...events.slice(0, 2), { ...events[2]!, workflowRevision: 2 }], hasMore: false, throughSeq: 5
    });
    const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1280);
    const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
    try {
      const current = project();
      current.orchestration.canvas = normalizeCanvasLayout(undefined, current.orchestration);
      current.orchestration.canvas.nodes.idea = { x: 610, y: 135 };
      render(<WorkflowCanvasReplay project={current} onClose={vi.fn()} />);
      await screen.findByLabelText("历史 Workflow 大画布");
      const canvas = () => screen.getByLabelText("历史 Workflow 大画布");
      const idea = () => canvas().querySelector<HTMLElement>('[data-node-id="idea"]');
      expect(idea()).toHaveStyle({ left: "610px", top: "135px" });
      expect(canvas().querySelector('[data-node-id="retired"]')).toBeInTheDocument();
      expect(canvas().closest("[data-runtime-edge-count]")).toHaveAttribute("data-runtime-edge-count",
        String(adaptWorkflowToCanvas(orchestration).edges.length));
      await waitFor(() => expect(canvas().querySelector('[data-edge-source="retired"][data-edge-target="idea"]')).toBeInTheDocument());
      const zoom = () => parseInt(screen.getByLabelText(/^当前缩放/).textContent ?? "", 10);
      await waitFor(() => expect(zoom()).toBeGreaterThan(50));
      const initialZoom = zoom();
      const slider = screen.getByRole("slider", { name: "历史回顾进度" });
      fireEvent.change(slider, { target: { value: slider.getAttribute("max") } });
      expect(screen.getByText(/ · Workflow v2$/)).toBeVisible();
      expect(idea()).toHaveStyle({ left: "610px", top: "135px" });
      expect(zoom()).toBe(initialZoom);
      expect(orchestration.canvas.nodes.idea.x).toBe(4200);
    } finally {
      width.mockRestore();
      height.mockRestore();
    }
  });

  it("loads older pages at one boundary and seeks without using the final project state", async () => {
    const value = project();
    const view = render(<WorkflowCanvasReplay project={value} onClose={vi.fn()} />);
    const frame = await screen.findByLabelText("历史 Workflow 大画布");
    expect(getWorkflowReplayEventPage).toHaveBeenCalledWith(value.id, { before: 3, through: 5 }, expect.any(AbortSignal));
    fireEvent.click(screen.getByRole("button", { name: "暂停历史回顾" }));
    fireEvent.change(screen.getByRole("slider", { name: "历史回顾进度" }), { target: { value: "1" } });
    expect(frame.querySelector('[data-node-id="idea"] [data-runtime-state]')).toHaveAttribute("data-runtime-state", "running");
    expect(frame.querySelector('[data-node-id="finish"] [data-runtime-state]')).toHaveAttribute("data-runtime-state", "waiting");
    expect(screen.getByText("Idea started")).toBeInTheDocument();
    view.rerender(<WorkflowCanvasReplay project={{ ...value, cycle: 100 }} onClose={vi.fn()} />);
    expect(getWorkflowReplayConfigurationHistory).toHaveBeenCalledTimes(1);
    expect(getWorkflowReplayEventPage).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "从头回顾" }));
    expect(screen.getByRole("button", { name: "暂停历史回顾" })).toBeInTheDocument();
  });

  it("opens history from the runtime card and returns to the existing live canvas", async () => {
    render(<WorkflowCanvasRuntime project={project()} events={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "历史回顾" }));
    await screen.findByLabelText("历史 Workflow 大画布");
    expect(screen.getByRole("dialog", { name: "历史执行回顾" })).toBeInTheDocument();
    const live = screen.getByLabelText("运行 Workflow 大画布");
    fireEvent.click(screen.getByRole("button", { name: "返回实时 Workflow" }));
    expect(screen.queryByLabelText("历史 Workflow 大画布")).toBeNull();
    expect(screen.getByLabelText("运行 Workflow 大画布")).toBe(live);
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
