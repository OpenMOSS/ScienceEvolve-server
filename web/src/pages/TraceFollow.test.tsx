import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runtimeProjectFixture } from "../test/runtime-project";
import { TraceView } from "./WorkspacePage";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

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
  it("keeps follow enabled and restores the bottom after a layout or focus scroll", () => {
    const trace = traceFixture();
    expect(trace.top).toBe(800);
    trace.position(200);
    expect(trace.follow).toHaveAttribute("aria-pressed", "true");
    trace.flush();
    expect(trace.top).toBe(800);
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
    Object.defineProperties(inner, { scrollTop: { value: 100 }, scrollHeight: { value: 600 }, clientHeight: { value: 100 } });
    const input = document.createElement("textarea"); inner.append(input); trace.scroll.append(inner);
    fireEvent.wheel(inner, { deltaY: -120 });
    fireEvent.keyDown(input, { key: "Home" });
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
