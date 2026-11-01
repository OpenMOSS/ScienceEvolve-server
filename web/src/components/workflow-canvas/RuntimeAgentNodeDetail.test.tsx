import { render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { getHarnessPrompt } from "../../api";
import { runtimeProjectFixture } from "../../test/runtime-project";
import { RuntimeAgentNodeDetail } from "./RuntimeAgentNodeDetail";

vi.mock("../../api", () => ({
  getCatalog: vi.fn(async () => ({ mainSystemPrompt: "FIXED_MAIN_SYSTEM", defaultHarnessId: "codex", harnesses: [] })),
  getHarnessPrompt: vi.fn(async config => ({ harness: config.harness, model: config.model, resolvedModel: config.model,
    installedVersion: "0.153.4", status: "available", text: "NATIVE_RUNTIME_PROMPT", source: "installed bundled models", collectedAt: "2026-10-28" }))
}));

it("shows all three read-only prompt sources in runtime node details and resolves the catalog default Harness", async () => {
  const project = runtimeProjectFixture();
  delete project.agents.main.harness;
  project.agents.main.instructions = "USER_RUNTIME_PROMPT";
  render(<RuntimeAgentNodeDetail node={{ id: "main", name: "main", kind: "agent", x: 0, y: 0 }} project={project}
    title="Main" state="running" executionCount={1} />);
  await waitFor(() => expect(screen.getByLabelText("System Prompt")).toHaveValue("FIXED_MAIN_SYSTEM"));
  await waitFor(() => expect(screen.getByLabelText("Harness Prompt")).toHaveValue("NATIVE_RUNTIME_PROMPT"));
  expect(getHarnessPrompt).toHaveBeenCalledWith(expect.objectContaining({ harness: "codex", model: project.agents.main.model }), expect.any(AbortSignal), false);
  for (const label of ["System Prompt", "Harness Prompt", "用户 Prompt"]) {
    expect(screen.getByLabelText(label)).toBeVisible();
    expect(screen.getByLabelText(label)).toHaveAttribute("readonly");
  }
});
