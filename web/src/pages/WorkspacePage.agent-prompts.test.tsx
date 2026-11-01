import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { getCatalog, getHarnessPrompt, getRecommendationExplainerConfig } from "../api";
import { runtimeProjectFixture } from "../test/runtime-project";
import type { HarnessCatalogEntry } from "../types";
import { AgentModelEditor } from "./WorkspacePage";

vi.mock("../api", async original => ({ ...await original<typeof import("../api")>(),
  getHarnessPrompt: vi.fn(), getCatalog: vi.fn(), getRecommendationExplainerConfig: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getRecommendationExplainerConfig).mockResolvedValue({ fingerprint: "fixture", config: {
    harness: "codex", model: "native-a", available: false
  } } as Awaited<ReturnType<typeof getRecommendationExplainerConfig>>);
  vi.mocked(getHarnessPrompt).mockImplementation(async config => ({
    harness: config.harness ?? "codex", model: config.model, resolvedModel: config.model,
    installedVersion: "0.153.4", status: "available", sourceType: "bundled-default",
    source: "installed bundled models", scope: "base-default", collectedAt: "2026-10-28T07:00:00Z",
    configurationDigest: "fixture", text: `NATIVE_${config.model}`
  }));
});

it("shows project Agent prompt sources for the latest unsaved model without including them in applied configuration", async () => {
  const project = runtimeProjectFixture();
  for (const [role, config] of Object.entries(project.agents)) {
    Object.assign(config, { harness: "codex", model: "native-a", instructions: `USER_${role}` });
  }
  const apply = vi.fn(async () => true);
  const props = { project, gateways: [], models: ["native-a", "native-b"], skills: [], mcpDirectory: [],
    defaultPrompts: {}, mainSystemPrompt: "FIXED_MAIN_SYSTEM", saving: false, error: "", notice: "",
    harnesses: [{ id: "codex", label: "Codex", adapterVersion: "fixture", available: true, default: true,
      purposes: ["workflow", "explainer", "probe"], mode: "workflow", nativeProtocol: "responses",
      capabilities: { skills: true, mcp: true, webSearch: true } } as HarnessCatalogEntry],
    onClose: vi.fn(), onAddSkill: vi.fn(), onApply: apply };
  const view = render(<AgentModelEditor {...props} />);
  const main = screen.getByRole("region", { name: "main 提示词来源" });
  expect(within(main).getByLabelText("System Prompt")).toHaveValue("FIXED_MAIN_SYSTEM");
  expect(within(main).getByLabelText("System Prompt")).toHaveAttribute("readonly");
  expect(getCatalog).not.toHaveBeenCalled();
  const idea = screen.getByRole("region", { name: "idea 提示词来源" });
  expect(within(idea).getByLabelText("System Prompt")).toHaveProperty("value", expect.stringContaining("OpenFARS permission mode:"));
  await waitFor(() => expect(within(idea).getByLabelText("Harness Prompt")).toHaveValue("NATIVE_native-a"));
  expect(within(idea).getByLabelText("Harness Prompt")).toBeVisible();

  fireEvent.change(screen.getByLabelText("idea模型"), { target: { value: "native-b" } });
  await waitFor(() => expect(within(idea).getByLabelText("Harness Prompt")).toHaveValue("NATIVE_native-b"));
  expect(project.agents.idea.model).toBe("native-a");
  expect(apply).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("idea自定义 Prompt"), { target: { value: "EDITED_USER_INSTRUCTIONS" } });
  const row = screen.getByLabelText("idea模型").closest(".agent-model-edit-row") as HTMLElement;
  fireEvent.click(within(row).getByRole("button", { name: "应用到该 Agent" }));
  expect(apply).toHaveBeenCalledWith({ idea: expect.objectContaining({ model: "native-b", instructions: "EDITED_USER_INSTRUCTIONS" }) });
  expect(JSON.stringify(apply.mock.calls)).not.toContain("FIXED_MAIN_SYSTEM");
  expect(JSON.stringify(apply.mock.calls)).not.toContain("NATIVE_");

  view.rerender(<AgentModelEditor {...props} saving />);
  expect(screen.getByLabelText("idea自定义 Prompt")).toBeDisabled();
  expect(within(idea).getByLabelText("Harness Prompt")).toHaveAttribute("readonly");
  expect(within(idea).getByLabelText("Harness Prompt")).toBeVisible();
});
