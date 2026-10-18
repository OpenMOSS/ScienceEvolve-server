import { describe, expect, it } from "vitest";
import { acceptedGitHandoff, projectResultSelection } from "./project-results";
import { DEFAULT_AGENTS, DEFAULT_AGENT_ORCHESTRATION, normalizeProject } from "./lib";

const source = () => ({ id: "prj_results", status: "completed", agents: DEFAULT_AGENTS, orchestration: DEFAULT_AGENT_ORCHESTRATION,
  git: { enabled: true }, artifacts: [{ id: "art-1", agent: "idea", path: "report.md", title: "Published report", gitSource: { commitSha: "a".repeat(40) } }] });
describe("project result presentation", () => {
  it("shows pinned published files when a completed Git project has no explicit display selection", () => {
    const project = normalizeProject(source());
    expect(projectResultSelection(project)?.primary).toEqual({ agent: "idea", path: "report.md", title: "Published report", artifactId: "art-1", commitSha: "a".repeat(40) });
    expect(projectResultSelection({ ...project, status: "running" })).toBeUndefined();
    expect(projectResultSelection({ ...project, orchestration: { ...project.orchestration, resultFormat: { none: true, presets: [], custom: "" } } })).toBeUndefined();
  });
  it("retains an explicit display choice and never invents a Git binding", () => {
    const project = normalizeProject(source());
    const display = { primary: { agent: "main", path: "selected.md", title: "Selected report", artifactId: "selected", commitSha: "b".repeat(40) }, items: [] };
    expect(projectResultSelection({ ...project, display })).toBe(display);
    const retiredDisplay = { ...display, primary: { ...display.primary, agent: "retired" } };
    expect(normalizeProject({ ...source(), display: retiredDisplay, artifacts: [{ id: "selected", agent: "retired", path: "selected.md", gitSource: { commitSha: "b".repeat(40) } }] }).display).toEqual(retiredDisplay);
    expect(projectResultSelection({ ...project, artifacts: [{ path: "report.md", agent: "idea", name: "report.md", kind: "markdown" }] })).toBeUndefined();
  });
  it("adapts accepted Git task summaries but ignores pending completions and memory", () => {
    const project = normalizeProject({ ...source(), taskCompletions: {
      accepted: { status: "accepted", agent: "main", invocationId: "inv_1", acceptedAt: "2026-10-13T12:00:00Z", summary: "# Verified result" },
      pending: { status: "requested", agent: "idea", invocationId: "inv_2", acceptedAt: "2026-10-13T13:00:00Z", summary: "Unaccepted result" },
      memory: { status: "accepted", agent: "main", invocationId: "inv_3", acceptedAt: "2026-10-13T14:00:00Z", memory: "Private working memory" }
    } });
    expect(project.latestHandoff).toMatchObject({ agent: "main", markdown: "# Verified result" });
  });
  it("uses a scoped business report only for its completed execution and exact ownership epoch", () => {
    const data = { git: { enabled: true }, scopedExecutions: [{ id: "execution", agentId: "idea", ownershipEpoch: 2, status: "completed" }], scopedAgentReports: [
      { executionId: "execution", ownershipEpoch: 2, invocationId: "inv_1", output: "Accepted analysis", recordedAt: "2026-10-13T12:00:00Z" },
      { executionId: "execution", ownershipEpoch: 1, invocationId: "inv_stale", output: "Stale analysis", recordedAt: "2026-10-13T14:00:00Z" }
    ] };
    expect(acceptedGitHandoff(data)?.markdown).toBe("Accepted analysis");
    expect(acceptedGitHandoff({ ...data, scopedExecutions: [{ ...data.scopedExecutions[0], status: "failed" }] })).toBeUndefined();
  });
});
