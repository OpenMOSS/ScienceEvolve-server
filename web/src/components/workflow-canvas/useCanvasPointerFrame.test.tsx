import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useCanvasPointerFrame } from "./useCanvasPointerFrame";

afterEach(() => vi.unstubAllGlobals());
it("draws only the latest pointer sample per frame and cancels pending samples at release or unmount", () => {
  const request = vi.fn<(callback: FrameRequestCallback) => number>().mockReturnValue(17);
  const cancel = vi.fn();
  vi.stubGlobal("requestAnimationFrame", request);
  vi.stubGlobal("cancelAnimationFrame", cancel);
  const view = renderHook(() => useCanvasPointerFrame(true));
  const draw = vi.fn();
  for (let index = 0; index < 50; index++) view.result.current.schedule(() => draw(index));
  expect(request).toHaveBeenCalledTimes(1);
  expect(draw).not.toHaveBeenCalled();
  act(() => request.mock.calls[0]![0](100));
  expect(draw.mock.calls).toEqual([[49]]);
  view.result.current.schedule(() => draw("obsolete"));
  view.result.current.cancel();
  act(() => request.mock.calls[1]![0](200));
  expect(draw.mock.calls).toEqual([[49]]);
  view.result.current.schedule(() => draw("unmounted"));
  view.unmount();
  act(() => request.mock.calls[2]![0](300));
  expect(draw.mock.calls).toEqual([[49]]);
  expect(cancel).toHaveBeenCalledWith(17);
});
