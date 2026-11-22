import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runtimeProjectFixture } from "../test/runtime-project";
import { TraceView } from "./WorkspacePage";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function traceFixture() {
  let frameId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => {
    frames.set(++frameId, callback); return frameId;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(id => { frames.delete(id); });
  const observed = new Set<Element>();
  let resized: () => void = () => undefined;
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resized = callback; }
    observe(target: Element) { observed.add(target); }
    disconnect() { observed.clear(); }
  });
  const props = { events: [{ seq: 1, type: "agent.started", agent: "main", message: "Started", ts: "2026-10-14T00:00:00Z" }],
    liveStreams: [], liveEvents: [], project: runtimeProjectFixture(), connection: "live" as const,
    totalEventCount: 1, hasOlder: false, historyLoading: false, historyError: "", onLoadOlder: async () => undefined };
  const view = render(<TraceView {...props} />);
  const scroll = view.container.querySelector<HTMLElement>(".trace-scroll")!;
  const follow = screen.getByRole("button", { name: "跟随" });
  let top = 0, height = 1_200, viewport = 400;
  Object.defineProperties(scroll, {
    scrollTop: { configurable: true, get: () => top, set: (value: number) => { top = value; fireEvent.scroll(scroll); } },
    scrollHeight: { configurable: true, get: () => height },
    clientHeight: { configurable: true, get: () => viewport }
  });
  const flush = () => act(() => {
    for (let i = 0; frames.size && i < 10; i++) {
      const batch = [...frames.values()]; frames.clear();
      for (const callback of batch) callback(i * 16);
    }
    expect(frames.size).toBe(0);
  });
  flush();
  return { ...view, scroll, follow, props, observed, flush, get top() { return top; },
    position(value: number) { top = value; fireEvent.scroll(scroll); },
    resize(contentHeight: number, viewportHeight: number) { height = contentHeight; viewport = viewportHeight; act(resized); } };
}

describe("trace follow navigation", () => {
  it("loads deferred diagnostics on expansion and reuses their bodies on reopen", async () => {
    const trace = traceFixture();
    const event = { ...trace.props.events[0], seq: 2, type: "agent.trace", message: "",
      data: { diagnostic: true, traceDetailDeferred: true } };
    const api = vi.fn(async () => new Response(JSON.stringify({
      events: [{ ...event, message: "历史诊断内容", data: { diagnostic: true } }]
    }), { headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", api);
    trace.rerender(<TraceView {...trace.props} events={[event]} />);
    const disclosure = trace.scroll.querySelector<HTMLDetailsElement>(".trace-diagnostics")!;
    expect(disclosure.querySelector("summary")).toHaveTextContent("运行诊断1");
    expect(api).not.toHaveBeenCalled();
    expect(screen.queryByText("历史诊断内容")).not.toBeInTheDocument();
    disclosure.open = true;
    fireEvent(disclosure, new Event("toggle"));
    expect(await screen.findByText("历史诊断内容")).toBeVisible();
    disclosure.open = false;
    fireEvent(disclosure, new Event("toggle"));
    disclosure.open = true;
    fireEvent(disclosure, new Event("toggle"));
    expect(api).toHaveBeenCalledTimes(1);
  });
  it("folds consecutive artifact writes without crossing a trace or invocation boundary", () => {
    const trace = traceFixture();
    const write = (seq: number, path: string, invocationId = "inv_one") => ({
      ...trace.props.events[0], seq, type: "artifact.published", message: `Artifact published: ${path}`,
      data: { invocationId, artifact: { path } }
    });
    const first = write(2, "reports/one.md");
    const second = write(3, "reports/two.md");
    const standalone = write(5, "reports/other-invocation.md", "inv_two");
    const boundary = { ...trace.props.events[0], seq: 6, type: "user.input.queued" };
    const last = write(7, "reports/after-boundary.md", "inv_two");
    const events = [first, second, standalone, boundary, last];
    trace.rerender(<TraceView {...trace.props} events={events} />);

    const disclosure = trace.scroll.querySelector(".trace-artifact-group summary")!;
    expect(disclosure).toHaveTextContent("研究产物已写入");
    expect(disclosure).toHaveTextContent("2");
    expect(screen.getByText("reports/one.md")).not.toBeVisible();
    expect(screen.getByText(standalone.message)).toBeVisible();
    expect(screen.getByText(last.message)).toBeVisible();
    fireEvent.click(disclosure);
    const list = screen.getByRole("region", { name: "研究产物写入列表" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(within(list).getByText("reports/one.md")).toBeVisible();
    expect(within(list).getByText("reports/two.md")).toBeVisible();

    trace.rerender(<TraceView {...trace.props} events={[first, second, write(4, "reports/new.md"), standalone, boundary, last]} />);
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    expect(within(list).getByText("reports/new.md")).toBeVisible();
  });

  it("reports a history batch without matching messages and preserves the reader's position", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const trace = traceFixture();
    const onLoadOlder = vi.fn(async () => {
      trace.resize(1_440, 400);
      return 24;
    });
    trace.rerender(<TraceView {...trace.props} hasOlder onLoadOlder={onLoadOlder} />);
    expect(onLoadOlder).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /加载更早.*条轨迹/ })).not.toBeInTheDocument();
    const search = screen.getByRole("button", { name: "查找更早正文" });
    await act(async () => fireEvent.click(search));
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
    expect(onLoadOlder).toHaveBeenLastCalledWith({ agent: undefined, keyword: undefined });
    const feedback = screen.getByText("这批记录中没有匹配的正文");
    expect(search.closest(".trace-history-loader")?.nextElementSibling).toBe(feedback);
    expect(trace.follow).toHaveAttribute("aria-pressed", "false");
    expect(trace.top).toBe(1_040);
    act(() => { vi.advanceTimersByTime(5_999); });
    expect(feedback).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1); });
    expect(feedback).not.toBeInTheDocument();
  });

  it("starts loaded history at the first message and keeps later diagnostics", async () => {
    const trace = traceFixture();
    const event = (seq: number, message: string) => ({
      ...trace.props.events[0], seq, message, type: "agent.trace",
      ts: new Date(Date.UTC(2026, 9, 14, 0, 0, seq)).toISOString()
    });
    const olderMessage = { ...event(2, "更早的正文"), data: { canonicalEvent: {
      schemaVersion: 1, eventId: "older", invocationId: "inv_older", harnessId: "fixture",
      kind: "assistant.message", itemId: "item"
    } } };
    const diagnostic = (seq: number, message: string) => ({
      ...event(seq, message), data: { traceKind: "status" }
    });
    const newest = { ...trace.props.events[0], seq: 4, ts: event(4, "").ts };
    const onLoadOlder = vi.fn(async () => {
      trace.rerender(<TraceView {...trace.props} events={[
        diagnostic(1, "正文前的诊断"), olderMessage, diagnostic(3, "正文后的诊断"), newest
      ]} />);
      return 3;
    });
    trace.rerender(<TraceView {...trace.props} events={[newest]} hasOlder onLoadOlder={onLoadOlder} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "查找更早正文" })));
    expect(trace.scroll.querySelector(".trace-list")?.firstElementChild).toHaveTextContent("更早的正文");
    expect(screen.queryByText("正文前的诊断")).not.toBeInTheDocument();
    expect(screen.getByText("正文后的诊断")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "查看上一条正文" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "查找更早正文" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("找到 1 条更早的 Agent 消息");
  });

  it("searches message cards by their body and retains attached tool calls", () => {
    const trace = traceFixture();
    const data = { schemaVersion: 1, invocationId: "inv_search", harnessId: "fixture" };
    const events = [
      { ...trace.props.events[0], type: "agent.trace", message: "匹配的正文", data: {
        canonicalEvent: { ...data, eventId: "message", kind: "assistant.message", itemId: "item" }
      } },
      { ...trace.props.events[0], seq: 2, type: "agent.trace", message: "唯一工具关键词", data: {
        canonicalEvent: { ...data, eventId: "tool", kind: "tool.completed", parentItemId: "item",
          tool: { callId: "call", name: "read", status: "completed", input: "唯一工具关键词" } }
      } }
    ];
    trace.rerender(<TraceView {...trace.props} events={events} />);
    const search = screen.getByPlaceholderText("搜索 Agent 消息");
    fireEvent.change(search, { target: { value: "唯一工具关键词" } });
    expect(screen.queryByText("匹配的正文")).not.toBeInTheDocument();
    expect(screen.getByText("0 条 Agent 消息")).toBeInTheDocument();
    fireEvent.change(search, { target: { value: "匹配的正文" } });
    expect(screen.getByText("匹配的正文")).toBeVisible();
    expect(screen.getByText("1 条 Agent 消息")).toBeInTheDocument();
    expect(screen.getByText("工具调用")).toBeVisible();
  });

  it("keeps follow enabled and restores the bottom after a layout or focus scroll", () => {
    const trace = traceFixture();
    expect(trace.top).toBe(800);
    trace.position(200);
    expect(trace.follow).toHaveAttribute("aria-pressed", "true");
    trace.flush();
    expect(trace.top).toBe(800);
  });

  it("keeps the current reading position when an older page arrives after the reader scrolls", () => {
    const trace = traceFixture();
    // Geometry includes user scrolling and the new row inserted above this article.
    const article = trace.scroll.querySelector("article")!;
    let before = 0;
    vi.spyOn(article, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, 850 + before - trace.top, 400, 100));
    const onLoadOlder = vi.fn(async () => undefined);
    const props = { ...trace.props, hasOlder: true, onLoadOlder };
    trace.rerender(<TraceView {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "查找更早正文" }));
    expect(onLoadOlder).toHaveBeenCalledOnce();
    trace.rerender(<TraceView {...props} historyLoading />);
    trace.position(720);
    before = 100;
    trace.rerender(<TraceView {...props} events={[{ ...props.events[0], seq: 0, type: "agent.trace", message: "Older" }, ...props.events]} />);
    expect(trace.top).toBe(820);
    expect(trace.follow).toHaveAttribute("aria-pressed", "false");
  });

  it("observes the trace viewport as well as content and repins after resizing", () => {
    const trace = traceFixture();
    expect(trace.observed.has(trace.scroll)).toBe(true);
    expect(trace.observed.has(trace.scroll.querySelector(".trace-list")!)).toBe(true);
    trace.resize(1_600, 300); trace.flush();
    expect(trace.top).toBe(1_300);
    expect(trace.follow).toHaveAttribute("aria-pressed", "true");
  });

  it("lets an upward wheel interrupt pending automatic scrolling and resumes on the button", () => {
    const trace = traceFixture();
    trace.resize(1_600, 400);
    fireEvent.wheel(trace.scroll, { deltaY: -120 });
    trace.position(600); trace.flush();
    expect(trace.follow).toHaveAttribute("aria-pressed", "false");
    expect(trace.top).toBe(600);
    fireEvent.click(trace.follow); trace.flush();
    expect(trace.top).toBe(1_200);
    expect(trace.follow).toHaveAttribute("aria-pressed", "true");
  });

  it.each(["ArrowUp", "PageUp", "Home", " "])("pauses on the %s history navigation key", key => {
    const trace = traceFixture();
    fireEvent.keyDown(trace.scroll, { key, shiftKey: key === " " });
    trace.position(200); trace.flush();
    expect(trace.follow).toHaveAttribute("aria-pressed", "false");
    expect(trace.top).toBe(200);
  });

  it("pauses when a touch gesture moves back through the trace", () => {
    const trace = traceFixture();
    fireEvent.touchStart(trace.scroll, { touches: [{ clientY: 200 }] });
    fireEvent.touchMove(trace.scroll, { touches: [{ clientY: 260 }] });
    trace.position(200); trace.flush();
    expect(trace.follow).toHaveAttribute("aria-pressed", "false");
  });

  it("pauses when the user operates the trace scrollbar", () => {
    const trace = traceFixture();
    vi.spyOn(trace.scroll, "getBoundingClientRect").mockReturnValue({ left: 0, right: 300, top: 0, bottom: 400, width: 300, height: 400, x: 0, y: 0, toJSON() {} });
    fireEvent.pointerDown(trace.scroll, { clientX: 298, button: 0, pointerType: "mouse" });
    trace.position(200); trace.flush();
    expect(trace.follow).toHaveAttribute("aria-pressed", "false");
  });

  it("keeps follow enabled for downward scrolling, zoom and gestures outside the trace", () => {
    const trace = traceFixture();
    fireEvent.wheel(trace.scroll, { deltaY: 100 });
    fireEvent.wheel(trace.scroll, { deltaY: -100, ctrlKey: true });
    fireEvent.wheel(document.body, { deltaY: -100 });
    fireEvent.touchStart(trace.scroll, { touches: [{ clientY: 200 }] });
    fireEvent.touchMove(trace.scroll, { touches: [{ clientY: 180 }] });
    fireEvent.touchStart(trace.scroll, { touches: [{ clientY: 200 }, { clientY: 240 }] });
    fireEvent.touchMove(trace.scroll, { touches: [{ clientY: 260 }, { clientY: 300 }] });
    fireEvent.pointerDown(trace.scroll, { clientX: 100, button: 0, pointerType: "touch" });
    expect(trace.follow).toHaveAttribute("aria-pressed", "true");
  });

  it("does not pause when an inner scroll area or editable field consumes navigation", () => {
    const trace = traceFixture();
    const inner = document.createElement("div"); inner.style.overflowY = "auto";
    Object.defineProperties(inner, { scrollTop: { value: 100, writable: true }, scrollHeight: { value: 600 }, clientHeight: { value: 100 } });
    const input = document.createElement("textarea"); inner.append(input); trace.scroll.append(inner);
    fireEvent.wheel(inner, { deltaY: -120 });
    fireEvent.keyDown(input, { key: "Home" });
    inner.style.overscrollBehaviorY = "contain";
    inner.scrollTop = 0;
    fireEvent.wheel(inner, { deltaY: -120 });
    expect(trace.follow).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps an explicitly paused trace at its reading position through resize and content updates", () => {
    const trace = traceFixture();
    fireEvent.click(trace.follow); trace.position(200);
    trace.resize(2_000, 300);
    trace.rerender(<TraceView {...trace.props} events={[...trace.props.events, { ...trace.props.events[0], seq: 2, message: "More output" }]} />);
    trace.flush();
    expect(trace.follow).toHaveAttribute("aria-pressed", "false");
    expect(trace.top).toBe(200);
  });
});
