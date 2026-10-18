import { fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_AGENT_ORCHESTRATION, DEFAULT_AGENTS } from "../../lib";
import type { AgentEvent, Project } from "../../types";
import { adaptWorkflowToCanvas } from "./core/canvas-adapter";
import { addScopedGroup, upgradeLegacyGroups } from "./core/scoped-workflow";
import { buildWorkflowRuntimeState } from "./core/workflow-runtime";
import { buildScopedRuntimeView } from "./core/scoped-runtime-view";
import { buildLiveCanvasSnapshot, WorkflowCanvasLive } from "./WorkflowCanvasLive";

const project = {
  id: "live-topic", title: "真实课题", requirement: "实际需求", status: "running", phase: "agent:writing:running",
  currentAgent: "writing", cycle: 1, turn: 1, agents: structuredClone(DEFAULT_AGENTS),
  orchestration: structuredClone(DEFAULT_AGENT_ORCHESTRATION)
} as Project;
const events: AgentEvent[] = [{
  seq: 1, type: "agent.started", agent: "writing", message: "写作已开始", ts: "2026-09-30T06:00:00Z",
  data: { invocationId: "inv_writing", sourceAgent: "main" }
}];
const propsFor = (p = project, timeline = events) => ({
  model: adaptWorkflowToCanvas(p.orchestration), runtime: buildWorkflowRuntimeState(p, timeline), project: p, events: timeline
});

function scopedProject() {
  const p = structuredClone(project);
  upgradeLegacyGroups(p.orchestration);
  addScopedGroup(p.orchestration, { id: "research", displayName: "Research <img src=x>", leaderAgentId: "main", memberAgentIds: ["idea", "execution"] });
  addScopedGroup(p.orchestration, { id: "inner", displayName: "Inner", parentGroupId: "research", leaderAgentId: "main", memberAgentIds: ["idea", "execution"] });
  p.orchestration.input.target = "research";
  p.orchestration.termination.agent = "research";
  p.scopedGroupRuns = ["previous", "current"].map((id) => ({ id, projectId: p.id, groupId: "research", activationRequestId: `activate-${id}`,
    workflowRevision: 2, leaderAgentId: "main", baseCommit: "a".repeat(40), groupBranch: `groups/${id}`, integrationTarget: "main",
    status: id === "previous" ? "completed" : "running" }));
  const first = p.orchestration.scopedWorkflow!.groups[0]!.workflow.nodes.find((ref) => ref.kind === "agent" && ref.agentId === "idea")!;
  p.scopedArrivals = [
    { sequence: 1, requestId: "old", groupRunId: "previous", sourceRunId: "input:previous", targetNodeId: first.nodeId, targetKind: "agent", agentId: "idea", status: "completed" },
    { sequence: 2, requestId: "new", groupRunId: "current", sourceRunId: "input:current", targetNodeId: first.nodeId, targetKind: "agent", agentId: "idea", status: "running" }
  ];
  return p;
}

describe("live workflow canvas", () => {
  it.each(["research", "inner"])("renders the %s parallel inputs with their own labels, arrows and colors through runtime updates", async scopeId => {
    const { JSDOM } = createRequire(import.meta.url)("jsdom");
    const read = (file: string) => readFileSync(resolve(process.cwd(), "public/workflow-canvas-demo", file), "utf8");
    const dom = new JSDOM(read("index.html"), { url: "http://localhost/workflow-canvas-demo/index.html?runtime=1&project=live-topic", runScripts: "outside-only", pretendToBeVisual: true });
    const win = dom.window;
    try {
      for (const file of ["styles.css", "runtime.css"]) {
        const style = win.document.createElement("style"); style.textContent = read(file); win.document.head.appendChild(style);
      }
      Object.defineProperty(win.HTMLElement.prototype, "offsetWidth", { configurable: true, get() { return 194; } });
      Object.defineProperty(win.HTMLElement.prototype, "offsetHeight", { configurable: true, get() { return 110; } });
      win.eval(read("runtime-bootstrap.js")); win.eval(read("app.js")); win.eval(read("runtime.js"));
      const doc = win.document as Document;
      const p = scopedProject(), original = JSON.stringify(p);
      const scoped = buildScopedRuntimeView(p, scopeId)!;
      const snapshot = buildLiveCanvasSnapshot({ project: p, model: scoped.model, runtime: scoped.runtime, events: [], scopeId });
      const expected = snapshot.workflow.edges.filter(edge => edge.kind === "parallel").length;
      expect(expected).toBeGreaterThan(1);
      for (const state of ["configured", "candidate", "active", "traversed"] as const) {
        snapshot.workflow.edges = snapshot.workflow.edges.map(edge => ({ ...edge, runtimeState: state }));
        win.dispatchEvent(new win.MessageEvent("message", { origin: win.location.origin, source: win.parent,
          data: { type: "scienceevolve.workflow.runtime.snapshot", snapshot } }));
        await new Promise(resolve => win.requestAnimationFrame(resolve));
        await new Promise(resolve => win.requestAnimationFrame(resolve));
        const paths = Array.from(doc.querySelectorAll<SVGPathElement>("path.workflow-edge.parallel"));
        expect(paths).toHaveLength(expected);
        for (const path of paths) {
          expect(path.getAttribute("d")).toMatch(/^M/);
          expect(path.getAttribute("data-runtime-state")).toBe(state);
          expect(win.getComputedStyle(path).stroke).toBe("#2159b5");
          expect(win.getComputedStyle(path).strokeDasharray).toBe("14 4 2 4");
          expect(win.getComputedStyle(path).getPropertyValue("marker-end")).toMatch(/arrow-parallel/);
          expect(path.parentElement!.querySelector(".edge-label text")?.textContent).toBe("并行");
        }
        if (state === "active") {
          const particles = Array.from(doc.querySelectorAll(".flow-particle.parallel"));
          expect(particles).toHaveLength(expected);
          for (const particle of particles) {
            for (const selector of [".flow-particle-core", ".flow-particle-tail", ".flow-particle-halo"]) {
              expect(win.getComputedStyle(particle.querySelector(selector)!).fill).toBe("#4588e6");
            }
            expect(win.getComputedStyle(particle.querySelector(".flow-particle-tail-line")!).stroke).toBe("#4588e6");
          }
        }
      }
      expect(win.document.querySelector("#arrow-parallel path")?.getAttribute("fill")).toBe("none");
      expect(win.document.querySelector("#arrow-parallel-highlight path")?.getAttribute("fill")).toBe("none");
      expect(JSON.stringify(p)).toBe(original);
    } finally { win.close(); }
  });

  it("sends the current graph and real overlay on load, handshake and subsequent events", () => {
    const initial = propsFor();
    const view = render(<WorkflowCanvasLive {...initial} onClose={vi.fn()} />);
    const frame = screen.getByTitle("运行 Workflow 大画布") as HTMLIFrameElement;
    const send = vi.spyOn(frame.contentWindow!, "postMessage");
    fireEvent.load(frame);
    expect(send).toHaveBeenLastCalledWith({ type: "scienceevolve.workflow.runtime.snapshot", snapshot: buildLiveCanvasSnapshot(initial) }, window.location.origin);
    fireEvent(window, new MessageEvent("message", { origin: window.location.origin, source: frame.contentWindow, data: { type: "scienceevolve.workflow.runtime.ready" } }));
    expect(send).toHaveBeenCalledTimes(2);
    const next = propsFor({ ...project, status: "completed", currentAgent: undefined }, [...events, {
      seq: 2, type: "agent.completed", agent: "writing", message: "写作已完成", ts: "2026-09-30T06:00:10Z", data: { invocationId: "inv_writing" }
    }]);
    view.rerender(<WorkflowCanvasLive {...next} onClose={vi.fn()} />);
    expect(send).toHaveBeenLastCalledWith({ type: "scienceevolve.workflow.runtime.snapshot", snapshot: buildLiveCanvasSnapshot(next) }, window.location.origin);
    expect(buildLiveCanvasSnapshot(next).nodeStates.writing).toBe("completed");
  });

  it("accepts selection and Escape only from its own frame and current origin", () => {
    const onSelectNode = vi.fn();
    const onClose = vi.fn();
    const props = propsFor();
    render(<WorkflowCanvasLive {...props} onSelectNode={onSelectNode} onClose={onClose} />);
    const frame = screen.getByTitle("运行 Workflow 大画布") as HTMLIFrameElement;
    const send = (origin: string, source: Window | null, data: unknown) => fireEvent(window, new MessageEvent("message", { origin, source, data }));
    send("https://other.test", frame.contentWindow, { type: "scienceevolve.workflow.runtime.close" });
    send(window.location.origin, window, { type: "scienceevolve.workflow.runtime.close" });
    send(window.location.origin, frame.contentWindow, { type: "scienceevolve.workflow.runtime.select", nodeId: "not-in-topic" });
    expect(onClose).not.toHaveBeenCalled();
    expect(onSelectNode).not.toHaveBeenCalled();
    send(window.location.origin, frame.contentWindow, { type: "scienceevolve.workflow.runtime.select", nodeId: "writing" });
    expect(onSelectNode).toHaveBeenCalledWith(props.model.nodes.find((node) => node.id === "writing"));
    send(window.location.origin, frame.contentWindow, { type: "scienceevolve.workflow.runtime.close" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("projects current scoped arrivals, nested references and Leader without borrowing flat or historical state", () => {
    const p = scopedProject();
    const before = JSON.stringify(p);
    const input = propsFor(p, []);
    input.runtime.nodeStates.research = "completed";
    input.runtime.nodeStates.execution = "completed";
    const snapshot = buildLiveCanvasSnapshot({ ...input, expandedGroupIds: new Set(["research"]) });
    const group = snapshot.workflow.nodes.find((node) => node.id === "research")!;
    expect(group).toMatchObject({ type: "collaboration", name: "Research <img src=x>", groupId: "research", expanded: true, canEnter: true });
    expect(snapshot.nodeStates.research).toBe("running");
    expect(group.leaderAgentId).toBe("main");
    expect(group.members).toHaveLength(3);
    expect(group.members).toEqual([
      expect.objectContaining({ state: "running", label: "运行中" }),
      expect.objectContaining({ state: "waiting", label: "尚未执行" }),
      expect.objectContaining({ groupId: "inner", name: "Inner", state: "waiting", label: "尚未执行" })
    ]);
    expect(JSON.stringify(p)).toBe(before);
    p.scopedGroupRuns = [];
    const fresh = buildLiveCanvasSnapshot(propsFor(p, []));
    expect(fresh.nodeStates.research).toBe("waiting");
    expect(fresh.workflow.nodes.find((node) => node.id === "research")!.members?.every((member) => member.label === "尚未执行")).toBe(true);
    expect(JSON.stringify(input.model)).not.toContain('"expanded":true');
  });

  it("accepts group actions only for the owning frame and configured group targets", () => {
    const p = scopedProject();
    const onToggleGroup = vi.fn(), onNavigateGroup = vi.fn();
    render(<WorkflowCanvasLive {...propsFor(p, [])} onToggleGroup={onToggleGroup} onNavigateGroup={onNavigateGroup} onClose={vi.fn()} />);
    const frame = screen.getByTitle("运行 Workflow 大画布") as HTMLIFrameElement;
    const send = (type: string, nodeId: string, groupId?: string, source = frame.contentWindow, origin = window.location.origin) =>
      fireEvent(window, new MessageEvent("message", { source, origin, data: { type: `scienceevolve.workflow.runtime.${type}`, nodeId, groupId } }));
    send("toggle-group", "research", undefined, window);
    send("toggle-group", "research", undefined, frame.contentWindow, "https://other.test");
    send("toggle-group", "writing");
    send("navigate-group", "research", "unrelated");
    send("navigate-group", "writing", "research");
    expect(onToggleGroup).not.toHaveBeenCalled();
    expect(onNavigateGroup).not.toHaveBeenCalled();
    send("toggle-group", "research");
    send("navigate-group", "research", "research");
    send("navigate-group", "research", "inner");
    expect(onToggleGroup).toHaveBeenCalledExactlyOnceWith("research");
    expect(onNavigateGroup.mock.calls).toEqual([["research"], ["inner"]]);
  });

  it("renders clickable group controls and reroutes actual iframe edges after expansion", async () => {
    const { JSDOM } = createRequire(import.meta.url)("jsdom");
    const read = (file: string) => readFileSync(resolve(process.cwd(), "public/workflow-canvas-demo", file), "utf8");
    const dom = new JSDOM(read("index.html"), { url: "http://localhost/workflow-canvas-demo/index.html?runtime=1&project=live-topic", runScripts: "outside-only", pretendToBeVisual: true });
    const win = dom.window;
    try {
      // Simulate measurable card sizes, including the height of expanded members.
      Object.defineProperty(win.HTMLElement.prototype, "offsetWidth", { configurable: true, get() { return this.matches(".is-collaboration") ? 240 : 194; } });
      Object.defineProperty(win.HTMLElement.prototype, "offsetHeight", { configurable: true, get() { return this.querySelector(".runtime-group-members") ? 248 : 110; } });
      win.eval(read("runtime-bootstrap.js")); win.eval(read("app.js")); win.eval(read("runtime.js"));
      const p = scopedProject();
      const original = JSON.stringify(p);
      const input = propsFor(p, []);
      const push = (expanded: boolean) => win.dispatchEvent(new win.MessageEvent("message", {
        origin: win.location.origin, source: win.parent, data: { type: "scienceevolve.workflow.runtime.snapshot",
          snapshot: buildLiveCanvasSnapshot({ ...input, expandedGroupIds: new Set(expanded ? ["research"] : []) }) }
      }));
      push(false);
      await new Promise((resolve) => setTimeout(resolve, 60));
      const group = win.document.querySelector('[data-node="research"]')!;
      expect(group.textContent).toContain("Research <img src=x>");
      expect(group.textContent).toContain("GROUP");
      expect(group.classList.contains("is-runtime-running")).toBe(true);
      expect(win.document.getElementById("flow-summary")?.textContent).toContain("结束：Research <img src=x>");
      expect(group.querySelector("img")).toBeNull();
      const toggle = group.querySelector('[data-runtime-action="toggle-group"]')!;
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(group.querySelector(".runtime-group-members")).toBeNull();
      const messages = vi.spyOn(win.parent, "postMessage");
      toggle.dispatchEvent(new win.MouseEvent("mousedown", { bubbles: true }));
      toggle.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
      expect(messages).toHaveBeenCalledExactlyOnceWith({ type: "scienceevolve.workflow.runtime.toggle-group", nodeId: "research", groupId: undefined, scopeId: null }, win.location.origin);
      const paths = () => Array.from(win.document.querySelectorAll("[data-edge-group] path.workflow-edge"), (path: Element) => path.getAttribute("d"));
      const before = paths();
      expect(before.length).toBeGreaterThan(0);
      push(true);
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(win.document.querySelector('[data-node="research"]')).toBe(group);
      expect(group.querySelector('[data-runtime-action="toggle-group"]')?.getAttribute("aria-expanded")).toBe("true");
      expect(group.querySelectorAll(".runtime-group-members li")).toHaveLength(3);
      expect(group.querySelector(".runtime-group-leader")?.textContent).toContain("Leader · main");
      expect(group.querySelectorAll('[data-member-state="waiting"]')).toHaveLength(2);
      expect(paths()).not.toEqual(before);
      expect(win.document.querySelector('path.workflow-edge[data-source="input"][data-target="research"]')).not.toBeNull();
      expect(win.document.querySelector('path.workflow-edge[data-source="research"][data-target="finish"]')).not.toBeNull();
      group.querySelector('[data-group-id="research"]')!.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
      group.querySelector('[data-group-id="inner"]')!.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
      expect(messages.mock.calls.slice(-2).map((call) => call[0])).toEqual([
        { type: "scienceevolve.workflow.runtime.navigate-group", nodeId: "research", groupId: "research", scopeId: null },
        { type: "scienceevolve.workflow.runtime.navigate-group", nodeId: "research", groupId: "inner", scopeId: null }
      ]);
      p.scopedArrivals![1]!.status = "completed";
      push(true);
      expect(group.querySelector('[data-member-state="completed"]')).not.toBeNull();
      p.scopedArrivals![1]!.status = "running";
      expect(JSON.stringify(p)).toBe(original);
    } finally { win.close(); }
  });

  it("does not treat a local Agent alias as a group or accept navigation from a stale scope", () => {
    const p = scopedProject();
    const workflow = p.orchestration.scopedWorkflow!.groups.find((group) => group.id === "research")!.workflow;
    workflow.nodes.find((node) => node.kind === "collaboration")!.nodeId = "child-ref";
    workflow.nodes.find((node) => node.kind === "agent")!.nodeId = "inner";
    const scoped = buildScopedRuntimeView(p, "research")!;
    const input = { project: p, model: scoped.model, runtime: scoped.runtime, events: [], scopeId: "research", expandedGroupIds: new Set(["inner"]) };
    const snapshot = buildLiveCanvasSnapshot(input);
    expect(snapshot.workflow.nodes.find((node) => node.id === "inner")!.type).toBe("agent");
    expect(snapshot.workflow.nodes.find((node) => node.id === "child-ref")).toMatchObject({ type: "collaboration", groupId: "inner", expanded: true });
    const onNavigateGroup = vi.fn(), onToggleGroup = vi.fn();
    render(<WorkflowCanvasLive {...input} onNavigateGroup={onNavigateGroup} onToggleGroup={onToggleGroup} onClose={vi.fn()} />);
    const frame = screen.getByTitle("运行 Workflow 大画布") as HTMLIFrameElement;
    const send = (action: string, nodeId: string, scopeId: string) => fireEvent(window,
      new MessageEvent("message", { source: frame.contentWindow, origin: window.location.origin,
        data: { type: `scienceevolve.workflow.runtime.${action}`, nodeId, groupId: "inner", scopeId } }));
    send("navigate-group", "inner", "research");
    send("navigate-group", "child-ref", "inner");
    send("toggle-group", "child-ref", "inner");
    expect(onNavigateGroup).not.toHaveBeenCalled();
    expect(onToggleGroup).not.toHaveBeenCalled();
    send("navigate-group", "child-ref", "research");
    send("toggle-group", "child-ref", "research");
    expect(onNavigateGroup).toHaveBeenCalledExactlyOnceWith("inner");
    expect(onToggleGroup).toHaveBeenCalledExactlyOnceWith("inner");
  });

  it("keeps runtime node drags presentation-only and preserves them across snapshot refreshes", async () => {
    const { JSDOM } = createRequire(import.meta.url)("jsdom");
    const read = (file: string) => readFileSync(resolve(process.cwd(), "public/workflow-canvas-demo", file), "utf8");
    const dom = new JSDOM(read("index.html"), { url: "http://localhost/workflow-canvas-demo/index.html?runtime=1&project=live-topic", runScripts: "outside-only", pretendToBeVisual: true });
    const win = dom.window;
    try {
      Object.defineProperty(win.HTMLElement.prototype, "offsetWidth", { configurable: true, get() { return this.matches(".is-collaboration") ? 240 : 194; } });
      Object.defineProperty(win.HTMLElement.prototype, "offsetHeight", { configurable: true, get() { return this.querySelector(".runtime-group-members") ? 248 : 110; } });
      const canvas = win.document.getElementById("canvas")!;
      Object.defineProperty(canvas, "clientWidth", { configurable: true, value: 1200 });
      Object.defineProperty(canvas, "clientHeight", { configurable: true, value: 760 });
      win.eval(read("runtime-bootstrap.js")); win.localStorage.setItem("scienceevolve-agent-flow-draft-direct", "existing draft"); win.eval(read("app.js")); win.eval(read("runtime.js"));
      const snapshot = buildLiveCanvasSnapshot(propsFor());
      const push = (value: typeof snapshot) => win.dispatchEvent(new win.MessageEvent("message", {
        origin: win.location.origin, source: win.parent, data: { type: "scienceevolve.workflow.runtime.snapshot", snapshot: value }
      }));
      push(snapshot);
      await new Promise((resolve) => setTimeout(resolve, 60));
      const node = win.document.querySelector('[data-node="writing"]') as HTMLElement;
      const beforeLeft = node.style.left;
      const beforePath = (win.document.querySelector('path.workflow-edge[data-source="writing"]') as SVGPathElement | null)?.getAttribute("d");
      node.dispatchEvent(new win.MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 700, clientY: 260 }));
      win.dispatchEvent(new win.MouseEvent("mousemove", { bubbles: true, button: 0, clientX: 820, clientY: 340 }));
      win.dispatchEvent(new win.MouseEvent("mouseup", { bubbles: true, button: 0, clientX: 820, clientY: 340 }));
      await new Promise((resolve) => setTimeout(resolve, 60));
      const movedLeft = node.style.left;
      const movedPath = (win.document.querySelector('path.workflow-edge[data-source="writing"]') as SVGPathElement | null)?.getAttribute("d");
      expect(movedLeft).not.toBe(beforeLeft);
      expect(movedPath).not.toBe(beforePath);
      expect(win.localStorage.getItem("scienceevolve-agent-flow-draft-direct")).toBe("existing draft");

      push(snapshot);
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect((win.document.querySelector('[data-node="writing"]') as HTMLElement | null)?.style.left).toBe(movedLeft);
    } finally { win.close(); }
  });

  it.each(["writing", "research"])("keeps %s edges attached when a live snapshot arrives during dragging", async (nodeId) => {
    const { JSDOM } = createRequire(import.meta.url)("jsdom");
    const read = (file: string) => readFileSync(resolve(process.cwd(), "public/workflow-canvas-demo", file), "utf8");
    const dom = new JSDOM(read("index.html"), { url: "http://localhost/workflow-canvas-demo/index.html?runtime=1&project=live-topic", runScripts: "outside-only", pretendToBeVisual: true });
    const win = dom.window;
    try {
      Object.defineProperty(win.HTMLElement.prototype, "offsetWidth", { configurable: true, get() { return this.matches(".is-collaboration") ? 240 : 194; } });
      Object.defineProperty(win.HTMLElement.prototype, "offsetHeight", { configurable: true, get() { return 110; } });
      const canvas = win.document.getElementById("canvas")!;
      Object.defineProperty(canvas, "clientWidth", { configurable: true, value: 1800 });
      Object.defineProperty(canvas, "clientHeight", { configurable: true, value: 1200 });
      win.eval(read("runtime-bootstrap.js")); win.eval(read("app.js")); win.eval(read("runtime.js"));
      const snapshot = buildLiveCanvasSnapshot(propsFor(nodeId === "research" ? scopedProject() : project, []));
      const original = JSON.stringify(snapshot);
      const push = () => win.dispatchEvent(new win.MessageEvent("message", {
        origin: win.location.origin, source: win.parent, data: { type: "scienceevolve.workflow.runtime.snapshot", snapshot }
      }));
      const frame = () => new Promise((resolve) => win.requestAnimationFrame(resolve));
      const doc = win.document as Document;
      const attached = () => {
        const card = doc.querySelector<HTMLElement>(`[data-node="${nodeId}"]`)!;
        const paths = Array.from(doc.querySelectorAll<SVGPathElement>("path.workflow-edge"))
          .filter((path) => path.dataset.source === nodeId || path.dataset.target === nodeId);
        expect(paths.length).toBeGreaterThan(0);
        for (const path of paths) {
          const points = path.getAttribute("d")!.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)!.map(Number);
          const [x, y] = path.dataset.source === nodeId ? points.slice(0, 2) : points.slice(-2);
          const left = parseFloat(card.style.left), top = parseFloat(card.style.top);
          expect(x).toBeGreaterThanOrEqual(left - 1);
          expect(x).toBeLessThanOrEqual(left + card.offsetWidth + 1);
          expect(y).toBeGreaterThanOrEqual(top - 1);
          expect(y).toBeLessThanOrEqual(top + card.offsetHeight + 1);
          expect(Math.min(Math.abs(x - left), Math.abs(x - left - card.offsetWidth), Math.abs(y - top), Math.abs(y - top - card.offsetHeight))).toBeLessThanOrEqual(1);
        }
      };
      push(); await frame(); await frame();
      const card = win.document.querySelector(`[data-node="${nodeId}"]`)!;
      card.dispatchEvent(new win.MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 600, clientY: 250 }));
      win.dispatchEvent(new win.MouseEvent("mousemove", { clientX: 670, clientY: 300 }));
      await frame(); attached();
      push(); await frame();
      win.dispatchEvent(new win.MouseEvent("mousemove", { clientX: 790, clientY: 400 }));
      await frame(); attached();
      const beforeRelease = (card as HTMLElement).style.left;
      win.dispatchEvent(new win.MouseEvent("mouseup", { clientX: 840, clientY: 440 }));
      await frame(); attached();
      expect((card as HTMLElement).style.left).not.toBe(beforeRelease);
      push(); await frame(); attached();
      // A host layout update also moves undragged nodes; cached curves must follow it.
      const untouched = snapshot.workflow.nodes.find((node) => node.id === "finish")!;
      untouched.x += 150;
      untouched.y += 100;
      push(); await frame();
      const finish = doc.querySelector<HTMLElement>('[data-node="finish"]')!;
      for (const path of doc.querySelectorAll<SVGPathElement>('path.workflow-edge[data-target="finish"]')) {
        const points = path.getAttribute("d")!.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)!.map(Number);
        const [x, y] = points.slice(-2);
        expect(x).toBeGreaterThanOrEqual(parseFloat(finish.style.left) - 1);
        expect(x).toBeLessThanOrEqual(parseFloat(finish.style.left) + finish.offsetWidth + 1);
        expect(y).toBeGreaterThanOrEqual(parseFloat(finish.style.top) - 1);
        expect(y).toBeLessThanOrEqual(parseFloat(finish.style.top) + finish.offsetHeight + 1);
      }
      untouched.x -= 150;
      untouched.y -= 100;
      expect(JSON.stringify(snapshot)).toBe(original);
    } finally { win.close(); }
  });

  it("isolates nested drag and viewport state and applies Main topology/layout updates through the same renderer", async () => {
    const { JSDOM } = createRequire(import.meta.url)("jsdom");
    const read = (file: string) => readFileSync(resolve(process.cwd(), "public/workflow-canvas-demo", file), "utf8");
    const dom = new JSDOM(read("index.html"), { url: "http://localhost/workflow-canvas-demo/index.html?runtime=1&project=live-topic", runScripts: "outside-only", pretendToBeVisual: true });
    const win = dom.window;
    try {
      Object.defineProperty(win.HTMLElement.prototype, "offsetWidth", { configurable: true, get() { return 194; } });
      Object.defineProperty(win.HTMLElement.prototype, "offsetHeight", { configurable: true, get() { return 110; } });
      win.eval(read("runtime-bootstrap.js")); win.eval(read("app.js")); win.eval(read("runtime.js"));
      const p = scopedProject();
      const original = structuredClone(p);
      const doc = win.document as Document;
      const tick = () => new Promise<void>((resolve) => win.requestAnimationFrame(() => resolve()));
      const push = (scopeId?: string) => {
        const view = scopeId ? buildScopedRuntimeView(p, scopeId)! : propsFor(p, []);
        const snapshot = buildLiveCanvasSnapshot({ model: view.model, runtime: view.runtime, project: p, events: [], scopeId });
        win.dispatchEvent(new win.MessageEvent("message", { origin: win.location.origin, source: win.parent,
          data: { type: "scienceevolve.workflow.runtime.snapshot", snapshot } }));
        return snapshot;
      };
      const card = (id: string) => doc.querySelector<HTMLElement>(`[data-node="${id}"]`)!;
      const drag = async (id: string) => {
        card(id).dispatchEvent(new win.MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 300, clientY: 200 }));
        win.dispatchEvent(new win.MouseEvent("mousemove", { clientX: 470, clientY: 300 }));
        await tick();
        win.dispatchEvent(new win.MouseEvent("mouseup", { clientX: 480, clientY: 320 }));
        await tick();
      };
      push(); await tick(); await tick();
      await drag("input");
      const rootInput = card("input").style.left;
      win.ScienceEvolveRuntimeCanvas.pan(90, 40);
      doc.getElementById("zoom-in-button")!.click();
      const rootViewport = doc.getElementById("nodes")!.style.transform;
      const research = push("research"); await tick(); await tick();
      expect(card("input").style.left).toBe(`${research.workflow.nodes.find((node) => node.id === "input")!.x}px`);
      expect(card("input").classList.contains("is-runtime-added")).toBe(false);
      expect(doc.getElementById("flow-summary")?.textContent).toContain("2 条并行入口");
      expect(doc.getElementById("flow-summary")?.textContent).toContain("结束：结束协作组");
      await drag("input");
      const groupInput = card("input").style.left;
      win.ScienceEvolveRuntimeCanvas.pan(-40, 120);
      const groupViewport = doc.getElementById("nodes")!.style.transform;
      const messages = vi.spyOn(win.parent, "postMessage");
      card("inner").querySelector<HTMLButtonElement>('[data-runtime-action="navigate-group"]')!.click();
      expect(messages).toHaveBeenLastCalledWith({ type: "scienceevolve.workflow.runtime.navigate-group", nodeId: "inner", groupId: "inner", scopeId: "research" }, win.location.origin);
      const inner = push("inner"); await tick(); await tick();
      expect(card("input").style.left).toBe(`${inner.workflow.nodes.find((node) => node.id === "input")!.x}px`);
      await drag(p.orchestration.scopedWorkflow!.groups.find((group) => group.id === "inner")!.workflow.nodes.find((node) => node.kind === "agent")!.nodeId);
      expect(messages).toHaveBeenLastCalledWith(expect.objectContaining({ type: "scienceevolve.workflow.runtime.select", scopeId: "inner" }), win.location.origin);
      // Scoped nodes use exactly the outer selection and directional flow effects.
      expect(doc.querySelectorAll(".flow-particle.is-related-flow").length).toBeGreaterThan(0);
      push("research"); await tick();
      expect(card("input").style.left).toBe(groupInput);
      expect(doc.getElementById("nodes")!.style.transform).toBe(groupViewport);
      push(); await tick();
      expect(card("input").style.left).toBe(rootInput);
      expect(doc.getElementById("nodes")!.style.transform).toBe(rootViewport);
      expect(p).toEqual(original); // Local gestures never edit the actual Workflow.
      push("research"); await tick();
      const workflow = p.orchestration.scopedWorkflow!.groups.find((group) => group.id === "research")!.workflow;
      workflow.canvas!.nodes.input = { x: 120, y: 160 };
      workflow.nodes.push({ kind: "agent", nodeId: "new-ref", agentId: "writing" });
      workflow.input.edges.push({ kind: "parallel", target: "new-ref" });
      workflow.routes["new-ref"] = [{ target: "finish", kind: "strong" }];
      push("research"); await tick();
      expect(card("input").style.left).toBe("120px"); // Main supersedes a local drag.
      expect(card("input")).toHaveClass("is-runtime-moving");
      expect(card("new-ref")).toHaveClass("is-runtime-added");
      expect(doc.querySelector('path.workflow-edge[data-source="input"][data-target="new-ref"]')).toHaveClass("is-runtime-added");
      // Main can remove a node during a gesture without leaving a dangling route.
      card("new-ref").dispatchEvent(new win.MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 300, clientY: 200 }));
      workflow.nodes = workflow.nodes.filter((node) => node.nodeId !== "new-ref");
      workflow.input.edges = workflow.input.edges.filter((edge) => edge.target !== "new-ref");
      delete workflow.routes["new-ref"];
      push("research"); await tick();
      win.dispatchEvent(new win.MouseEvent("mousemove", { clientX: 400, clientY: 400 }));
      win.dispatchEvent(new win.MouseEvent("mouseup", { clientX: 400, clientY: 400 }));
      expect(doc.querySelector('[data-node="new-ref"]')).toBeNull();
      expect(doc.querySelector('path[data-target="new-ref"], path[data-source="new-ref"]')).toBeNull();
    } finally { win.close(); }
  });

  it("animates selected runtime node inputs and outputs with directional particles", async () => {
    const { JSDOM } = createRequire(import.meta.url)("jsdom");
    const read = (file: string) => readFileSync(resolve(process.cwd(), "public/workflow-canvas-demo", file), "utf8");
    const dom = new JSDOM(read("index.html"), { url: "http://localhost/workflow-canvas-demo/index.html?runtime=1&project=live-topic", runScripts: "outside-only", pretendToBeVisual: true });
    const win = dom.window;
    try {
      Object.defineProperty(win.HTMLElement.prototype, "offsetWidth", { configurable: true, get() { return 194; } });
      Object.defineProperty(win.HTMLElement.prototype, "offsetHeight", { configurable: true, get() { return 110; } });
      win.eval(read("runtime-bootstrap.js")); win.eval(read("app.js")); win.eval(read("runtime.js"));
      const snapshot = structuredClone(buildLiveCanvasSnapshot(propsFor()));
      snapshot.selectedNodeId = "writing";
      snapshot.workflow.edges = snapshot.workflow.edges.map((edge) => ({ ...edge, runtimeState: "configured" }));
      win.dispatchEvent(new win.MessageEvent("message", {
        origin: win.location.origin, source: win.parent, data: { type: "scienceevolve.workflow.runtime.snapshot", snapshot }
      }));
      await new Promise((resolve) => setTimeout(resolve, 60));
      const related = (Array.from(win.document.querySelectorAll("path.workflow-edge")) as SVGPathElement[]).filter((path) => path.dataset.source === "writing" || path.dataset.target === "writing");
      expect(related.length).toBeGreaterThan(0);
      expect(related.some((path) => path.classList.contains("is-related-highlight"))).toBe(true);
      const nonFixedRelated = related.filter((path) => path.dataset.source !== "main");
      expect(nonFixedRelated.length).toBeGreaterThan(0);
      for (const path of nonFixedRelated) {
        const edgeId = path.dataset.edge!;
        const particle = (Array.from(win.document.querySelectorAll(".flow-particle")) as SVGGElement[]).find((item) => item.dataset.flowEdge === edgeId);
        expect(particle).toBeDefined();
        expect(particle).toHaveClass("is-related-flow");
        expect(particle).toHaveClass(path.dataset.source === "writing" ? "is-outgoing-flow" : "is-incoming-flow");
      }
    } finally { win.close(); }
  });

  it("renders the imported page with actual topology, preserves drafts, and updates to completion", async () => {
    const { JSDOM } = createRequire(import.meta.url)("jsdom");
    const read = (file: string) => readFileSync(resolve(process.cwd(), "public/workflow-canvas-demo", file), "utf8");
    const dom = new JSDOM(read("index.html"), { url: "http://localhost/workflow-canvas-demo/index.html?runtime=1&project=live-topic", runScripts: "outside-only", pretendToBeVisual: true });
    const win = dom.window;
    try {
      expect(win.document.querySelectorAll("script:not([src])")).toHaveLength(0);
      win.eval(read("runtime-bootstrap.js"));
      win.localStorage.setItem("scienceevolve-agent-flow-draft-direct", "existing draft");
      win.eval(read("app.js"));
      win.eval(read("runtime.js"));
      const input = propsFor();
      const snapshot = buildLiveCanvasSnapshot(input);
      const push = (value: typeof snapshot) => win.dispatchEvent(new win.MessageEvent("message", {
        origin: win.location.origin, source: win.parent, data: { type: "scienceevolve.workflow.runtime.snapshot", snapshot: value }
      }));
      push(snapshot);
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(win.document.querySelectorAll("[data-node]")).toHaveLength(input.model.nodes.length);
      expect(win.document.querySelectorAll("[data-edge]")).toHaveLength(input.model.edges.length);
      expect(win.document.querySelector('[data-node="writing"]')?.classList.contains("is-runtime-running")).toBe(true);
      expect(win.document.querySelector('[data-node="planner"]')).toBeNull();
      expect(win.document.getElementById("run-scenario-label")?.textContent).toBe("实时运行");
      expect(win.document.getElementById("run-log-list")?.textContent).toContain("写作已开始");
      expect(win.localStorage.getItem("scienceevolve-agent-flow-draft-direct")).toBe("existing draft");
      const before = JSON.stringify(input.model);
      const completed = buildLiveCanvasSnapshot(propsFor({ ...project, status: "completed", currentAgent: undefined }, [...events, {
        seq: 2, type: "agent.completed", agent: "writing", message: "<img src=x onerror=alert(1)>", ts: "2026-09-30T06:00:10Z", data: { invocationId: "inv_writing" }
      }]));
      push(completed);
      expect(win.document.querySelector('[data-node="writing"]')?.classList.contains("is-runtime-completed")).toBe(true);
      expect(win.document.getElementById("run-status-label")?.textContent).toBe("执行完成");
      expect(win.document.querySelector("#run-log-list img")).toBeNull();
      expect(JSON.stringify(input.model)).toBe(before);
      expect(win.document.querySelector('[data-node="finish"]')).not.toBeNull();
    } finally { win.close(); }
  });
});
