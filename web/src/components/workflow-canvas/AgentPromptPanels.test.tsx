import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_AGENTS, normalizeAgentOrchestration } from "../../lib";
import { AgentPromptPanels } from "./AgentPromptPanels";
import { CanvasInspector } from "./CanvasInspector";
import { getHarnessPrompt } from "../../api";
import type { HarnessPromptResult } from "../../types";

vi.mock("../../api", async importOriginal => ({ ...await importOriginal<typeof import("../../api")>(),
  getCatalog: vi.fn(async () => ({ mainSystemPrompt: "FIXED_MAIN_SYSTEM" })),
  getHarnessPrompt: vi.fn() }));

function result(model: string): HarnessPromptResult {
  return { harness: "codex", model, resolvedModel: model, installedVersion: "0.153.4", status: "available",
    sourceType: "bundled-default", source: "installed bundled models", scope: "base-default", collectedAt: "2026-10-27T12:00:00Z",
    configurationDigest: "digest", text: `NATIVE_${model}` };
}

describe("canvas Prompt sources", () => {
  it("shows runtime permission rules for workers and updates them with unsaved permission changes", async () => {
    vi.mocked(getHarnessPrompt).mockResolvedValue(result("a"));
    const agent = { ...DEFAULT_AGENTS.writing, harness: "dsh", model: "a", permission: "workspace" as const };
    const { rerender } = render(<AgentPromptPanels agentId="writing" agent={agent} />);
    expect(screen.getByLabelText("System Prompt")).toHaveProperty("value", expect.stringContaining("OpenFARS permission mode: workspace."));
    expect(screen.getByLabelText("System Prompt")).toHaveAttribute("readonly");
    rerender(<AgentPromptPanels agentId="writing" agent={{ ...agent, permission: "compute" }} />);
    expect(screen.getByLabelText("System Prompt")).toHaveProperty("value", expect.stringContaining("OpenFARS permission mode: compute."));
    await waitFor(() => expect(screen.getByRole("button", { name: "刷新提示词" })).toBeEnabled());
  });

  it("forces fresh collection, prevents repeated clicks, and preserves the last text on a failed refresh", async () => {
    vi.mocked(getHarnessPrompt).mockResolvedValueOnce(result("refresh"));
    render(<AgentPromptPanels agentId="writing" agent={{ ...DEFAULT_AGENTS.writing, harness: "pi", model: "refresh" }} />);
    await waitFor(() => expect(screen.getByLabelText("Harness Prompt")).toHaveValue("NATIVE_refresh"));
    let fail!: (reason: Error) => void;
    vi.mocked(getHarnessPrompt).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    fireEvent.click(screen.getByRole("button", { name: "刷新提示词" }));
    expect(screen.getByRole("button", { name: "正在读取提示词…" })).toBeDisabled();
    expect(getHarnessPrompt).toHaveBeenLastCalledWith(expect.objectContaining({ model: "refresh" }), expect.any(AbortSignal), true);
    await act(async () => fail(new Error("读取安装失败")));
    expect(screen.getByRole("alert")).toHaveTextContent("刷新失败：读取安装失败");
    expect(screen.getByLabelText("Harness Prompt")).toHaveValue("NATIVE_refresh");
    expect(screen.getByRole("button", { name: "刷新提示词" })).toBeEnabled();
  });

  it("keeps System/Harness read-only while editing only the original user configuration", async () => {
    vi.mocked(getHarnessPrompt).mockResolvedValue(result("a"));
    const patch = vi.fn();
    const config = { ...DEFAULT_AGENTS.main, harness: "codex", model: "a", instructions: "USER_CONFIGURATION" };
    const props = { node: { id: "main", kind: "agent" as const, name: "main", x: 0, y: 0 }, agent: config,
      orchestration: normalizeAgentOrchestration(undefined), onAgentPatch: patch };
    const { rerender } = render(<CanvasInspector {...props} />);
    await waitFor(() => expect(screen.getByLabelText("System Prompt")).toHaveValue("FIXED_MAIN_SYSTEM"));
    expect(screen.getByLabelText("System Prompt")).toHaveAttribute("readonly");
    expect(screen.getByLabelText("Harness Prompt")).toHaveAttribute("readonly");
    expect(screen.getByLabelText("Harness Prompt")).toHaveValue("NATIVE_a");
    expect(screen.getByText(/基础默认文本/)).toBeVisible();
    expect(patch).not.toHaveBeenCalled();
    const user = screen.getByDisplayValue("USER_CONFIGURATION");
    fireEvent.change(user, { target: { value: "EDITED_USER_CONFIGURATION" } }); fireEvent.blur(user);
    expect(patch).toHaveBeenCalledWith({ instructions: "EDITED_USER_CONFIGURATION" });
    rerender(<CanvasInspector {...props} readOnly />);
    expect(screen.getByDisplayValue("EDITED_USER_CONFIGURATION")).toBeDisabled();
    expect(screen.getByLabelText("Harness Prompt")).toHaveAttribute("readonly");
  });

  it("never shows a prior Agent/model response after a slower query resolves", async () => {
    let finishA!: (value: HarnessPromptResult) => void;
    let finishB!: (value: HarnessPromptResult) => void;
    vi.mocked(getHarnessPrompt).mockImplementation(config => new Promise(resolve => {
      if (config.model === "a") finishA = resolve; else finishB = resolve;
    }));
    const config = { ...DEFAULT_AGENTS.idea, harness: "codex", model: "a" };
    const { rerender } = render(<AgentPromptPanels agentId="analysis" agent={config} />);
    rerender(<AgentPromptPanels agentId="charts" agent={{ ...config, model: "b" }} />);
    await act(async () => finishA(result("a")));
    expect(screen.queryByDisplayValue("NATIVE_a")).toBeNull();
    await act(async () => finishB(result("b")));
    expect(screen.getByLabelText("Harness Prompt")).toHaveValue("NATIVE_b");
    expect(screen.getByLabelText("System Prompt")).toHaveProperty("value", expect.stringContaining("OpenFARS permission mode:"));
    expect(screen.queryByDisplayValue("FIXED_MAIN_SYSTEM")).toBeNull();
  });

  it("shows the exact unavailable state and sends no secret configuration", async () => {
    vi.mocked(getHarnessPrompt).mockResolvedValue({ ...result("custom"), status: "model-unmatched", text: undefined,
      reason: "安装版没有该模型的精确匹配" });
    render(<AgentPromptPanels agentId="worker" agent={{ ...DEFAULT_AGENTS.idea, harness: "codex", model: "custom" }} />);
    await waitFor(() => expect(screen.getByText("安装版没有该模型的精确匹配")).toBeVisible());
    expect(screen.queryByLabelText("Harness Prompt")).toBeNull();
  });

  it("keeps the Harness section visible without querying an empty model", () => {
    vi.mocked(getHarnessPrompt).mockClear();
    render(<AgentPromptPanels agentId="worker" agent={{ ...DEFAULT_AGENTS.idea, harness: "codex", model: "" }} />);
    expect(screen.getByText("Harness Prompt")).toBeVisible();
    expect(screen.getByText("尚未选择模型，选择后可查询 Harness Prompt。")).toBeVisible();
    expect(getHarnessPrompt).not.toHaveBeenCalled();
  });
});
