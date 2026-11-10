import { describe, expect, it } from "vitest";
import { artifactRelativeResourceUrl } from "./artifact-html";
import { getArtifactHtmlPreviewUrl } from "./api";
import type { Artifact } from "./types";

const artifact = { id: "published-html", agent: "研究总编", path: "reports/index.html", commitSha: "a".repeat(40),
  name: "index.html", kind: "text", origin: "workspace", size: 100, updatedAt: "2026-11-08T00:00:00Z" } as Artifact;

describe("published HTML preview", () => {
  it("keeps Markdown links and figures at the selected immutable source without reusing the source artifact id", () => {
    for (const [reference, path] of [["../figures/diagram.svg", "figures/diagram.svg"], ["../figures/plot.png", "figures/plot.png"], ["summary.md#conclusion", "reports/summary.md"]]) {
      const url = new URL(artifactRelativeResourceUrl("project", artifact, reference!));
      expect(decodeURIComponent(url.pathname)).toBe(`/api/projects/project/artifacts/content/agent/研究总编/${artifact.commitSha}/${path}`);
      expect(url.searchParams.has("path")).toBe(false);
      expect(url.searchParams.has("agent")).toBe(false);
      expect(url.searchParams.has("commitSha")).toBe(false);
      expect(url.searchParams.has("artifactId")).toBe(false);
    }
    expect(artifactRelativeResourceUrl("project", artifact, "summary.md#conclusion")).toContain("#conclusion");
    expect(artifactRelativeResourceUrl("project", artifact, "https://example.org/paper")).toBe("https://example.org/paper");
    expect(artifactRelativeResourceUrl("project", artifact, "#local")).toBe("#local");
  });

  it("opens relative HTML links at their own isolated preview without the Markdown artifact id", () => {
    const url = new URL(artifactRelativeResourceUrl("project", artifact, "index.html#evidence"));
    expect(decodeURIComponent(url.pathname)).toContain(`/api/projects/project/artifacts/preview/agent/研究总编/${artifact.commitSha}/reports/index.html`);
    expect(url.hash).toBe("#evidence");
    expect(url.searchParams.has("artifactId")).toBe(false);
  });

  it("retains the chosen live workspace for both document links and HTML preview", () => {
    const live = { ...artifact, id: undefined, commitSha: undefined, workspaceId: "worktree_" + "a".repeat(24) };
    const url = new URL(artifactRelativeResourceUrl("project", live, "../figures/plot.png"));
    expect(url.pathname).toBe(`/api/projects/project/artifacts/content/workspace/${live.workspaceId}/live/figures/plot.png`);
    expect(url.searchParams.has("commitSha")).toBe(false);
    expect(getArtifactHtmlPreviewUrl("project", live)).toContain(`/artifacts/preview/workspace/${live.workspaceId}/live/reports/index.html`);
    expect(getArtifactHtmlPreviewUrl("project", { ...live, id: "workspace-file" })).not.toContain("artifactId");
  });

  it("binds the initial HTML document to its exact publication and rejects an absent or mixed source", () => {
    const url = new URL(getArtifactHtmlPreviewUrl("project", artifact), document.baseURI);
    expect(url.searchParams.get("artifactId")).toBe(artifact.id);
    expect(decodeURIComponent(url.pathname)).toContain(`/preview/agent/研究总编/${artifact.commitSha}/reports/index.html`);
    expect(() => getArtifactHtmlPreviewUrl("project", { ...artifact, agent: undefined })).toThrow("requires an Agent or workspace source");
    expect(() => getArtifactHtmlPreviewUrl("project", { ...artifact, workspaceId: "shared" })).toThrow("cannot use a publication commit");
  });
});
