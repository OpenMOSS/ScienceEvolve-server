import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { launchInputFileManager } from "../src/project-input-uploads.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

let child: ChildProcess;
beforeEach(() => {
  vi.useFakeTimers();
  child = Object.assign(new EventEmitter(), { unref: vi.fn() }) as ChildProcess;
  vi.mocked(spawn).mockReturnValue(child);
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("project input system file manager", () => {
  it.each([
    ["win32", "explorer.exe", "D:\\资料 & inputs"],
    ["darwin", "open", "/tmp/资料 & inputs"],
    ["linux", "xdg-open", "/tmp/资料 & inputs"]
  ] as const)("opens the directory on %s as a single argument without a shell", async (platform, command, directory) => {
    const opened = launchInputFileManager(directory, platform);
    expect(spawn).toHaveBeenCalledWith(command, [directory], { detached: true, stdio: "ignore", windowsHide: false });
    child.emit("spawn");
    child.emit("close", 0);
    await expect(opened).resolves.toBeUndefined();
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it("accepts Explorer handing off to an existing window despite its exit code", async () => {
    const opened = launchInputFileManager("D:\\inputs", "win32");
    child.emit("spawn");
    child.emit("close", 1);
    await expect(opened).resolves.toBeUndefined();
  });

  it.each(["win32", "darwin", "linux"] as const)("reports a missing file manager on %s", async (platform) => {
    const opened = launchInputFileManager("/inputs", platform);
    child.emit("error", Object.assign(new Error("missing launcher"), { code: "ENOENT" }));
    await expect(opened).rejects.toMatchObject({ status: 503, message: expect.stringContaining("选择文件或文件夹上传") });
  });

  it.each(["darwin", "linux"] as const)("reports an immediate launcher failure on %s", async (platform) => {
    const opened = launchInputFileManager("/inputs", platform);
    child.emit("spawn");
    child.emit("close", 3);
    await expect(opened).rejects.toMatchObject({ status: 503, message: expect.stringContaining("桌面会话") });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not keep the request pending when a Linux file manager stays alive", async () => {
    const opened = launchInputFileManager("/inputs", "linux");
    child.emit("spawn");
    await vi.advanceTimersByTimeAsync(1000);
    await expect(opened).resolves.toBeUndefined();
    child.emit("close", 0);
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it("rejects unsupported platforms without starting a process", async () => {
    await expect(launchInputFileManager("/inputs", "freebsd")).rejects.toMatchObject({ status: 501 });
    expect(spawn).not.toHaveBeenCalled();
  });
});
