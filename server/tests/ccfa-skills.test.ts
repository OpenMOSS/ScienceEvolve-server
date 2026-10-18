import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const skillRoot = fileURLToPath(
  new URL("../../.agents/skills", import.meta.url)
);

describe("imported CCFA skills", () => {
  it("installs the requested role skills without the exemplar PDF payload", async () => {
    const names = [
      "ccf-common",
      "ccf-idea-optimizer",
      "ccf-idea-reviewer",
      "ccf-literature-monitor",
      "ccf-literature-searcher",
      "ccf-experiment-designer",
      "ccf-visual-composer",
      "ccf-paper-to-exemplar",
      "ccf-paper-writer",
      "ccf-paper-reviewer"
    ];
    for (const name of names) {
      const skill = await fs.readFile(path.join(skillRoot, name, "SKILL.md"), "utf8");
      expect(skill).toContain(`name: ${name}`);
    }
    const writerFiles = await recursiveFiles(
      path.join(skillRoot, "ccf-paper-writer")
    );
    expect(writerFiles.some((file) => /\.pdf$/i.test(file))).toBe(false);
    expect(writerFiles).toContain(
      path.join(
        skillRoot,
        "ccf-paper-writer",
        "references",
        "exemplars",
        "index.md"
      )
    );
  });

  it("adapts the original writer to the generic Worker and self-compile contract", async () => {
    const writer = await fs.readFile(
      path.join(skillRoot, "ccf-paper-writer", "SKILL.md"),
      "utf8"
    );
    expect(writer).toContain("common project workspace");
    expect(writer).toContain("run it yourself");
    expect(writer).toContain("backend does not compile");
    expect(writer).not.toContain("worker-result format");
    expect(writer).not.toContain("**Compile and check**");
    expect(writer).toContain("ccf-latex-templates/NeurIPS/neurips_2026.tex");
    expect(writer).not.toContain("Next CCFA skills available");
  });

  it("adapts the original reviewer to the generic Worker JSON contract", async () => {
    const reviewer = await fs.readFile(
      path.join(skillRoot, "ccf-paper-reviewer", "SKILL.md"),
      "utf8"
    );
    for (const field of ["summary", "markdown", "recommendation"]) {
      expect(reviewer).toContain(`\`${field}\``);
    }
    for (const field of ["paperVersion", "paperSha256", "score", "confidence", "rating"]) {
      expect(reviewer).not.toContain(`\"${field}\"`);
    }
    expect(reviewer).not.toContain("ccfa-review-reports/");
    expect(reviewer).toContain("Main owns every inter-agent transition");
    expect(reviewer).toContain("ordinary Worker");
  });

  it("keeps the original references advisory under the ScienceEvolve role contracts", async () => {
    const read = async (...parts: string[]) =>
      fs.readFile(path.join(skillRoot, ...parts), "utf8");
    const lengthPolicy = await read(
      "ccf-paper-writer",
      "references",
      "length-budget-policy.md"
    );
    const outputPolicy = await read(
      "ccf-paper-writer",
      "references",
      "output-style-policy.md"
    );
    const citationWorkflow = await read(
      "ccf-paper-writer",
      "references",
      "citation-workflow.md"
    );
    const reviewWorkflow = await read(
      "ccf-paper-reviewer",
      "references",
      "review-workflow.md"
    );
    const common = await read("ccf-common", "SKILL.md");

    expect(lengthPolicy).toContain("ScienceEvolve Runtime Note");
    expect(lengthPolicy).not.toContain("backend's asynchronous compiler");
    expect(outputPolicy).toContain(
      "ccf-latex-templates/NeurIPS/neurips_2026.tex"
    );
    expect(citationWorkflow).not.toContain(
      "Route to `ccf-literature-searcher`"
    );
    expect(reviewWorkflow).toContain("JSON `markdown` field");
    expect(reviewWorkflow).not.toContain("Report location:");
    expect(common).toContain("must not run skill-forger/skill-creator validation");
  });
});

async function recursiveFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...(await recursiveFiles(entryPath)));
    else if (entry.isFile()) result.push(entryPath);
  }
  return result;
}
