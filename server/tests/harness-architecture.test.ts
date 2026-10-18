import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

async function sourceFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  return (await Promise.all(entries.flatMap((entry) => {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) return [sourceFiles(target)];
    return /\.(?:ts|tsx)$/.test(entry.name) ? [Promise.resolve([target])] : [];
  }))).flat();
}

async function read(relativePath: string): Promise<string> {
  return fs.readFile(path.resolve(process.cwd(), relativePath), "utf8");
}

function normalizedPath(file: string): string {
  return file.split(path.sep).join("/");
}

function relativeServerSource(file: string): string {
  return normalizedPath(path.relative(path.resolve(process.cwd(), "src"), file));
}

const CONCRETE_HARNESS_ID = /["'](?:codex|dsh|pi|claude-code)["']/;
const BUSINESS_EXECUTION_CALLERS = [
  "src/orchestrator.ts",
  "src/project-explainer.ts",
  "src/protocol-router.ts",
  "src/real-gateway-acceptance.ts"
] as const;

function isAdapterImplementation(relativePath: string): boolean {
  return relativePath === "codex-runner.ts" ||
    relativePath.startsWith("harness-runtime/adapters/");
}

describe("Harness architecture boundaries", () => {
  it("keeps concrete Harness identities inside the Registry and Adapter modules", async () => {
    const roots = [
      path.resolve(process.cwd(), "src"),
      path.resolve(process.cwd(), "..", "web", "src")
    ];
    const files = (await Promise.all(roots.map(sourceFiles))).flat();
    const offenders: string[] = [];
    for (const file of files) {
      const normalized = normalizedPath(file);
      if (/\.test\.(?:ts|tsx)$/.test(normalized)) continue;
      if (normalized.endsWith("/server/src/harness-runtime/registry.ts") ||
        (normalized.includes("/server/src/") &&
          isAdapterImplementation(relativeServerSource(file)))) continue;
      if (CONCRETE_HARNESS_ID.test(await fs.readFile(file, "utf8"))) {
        offenders.push(path.relative(path.resolve(process.cwd(), ".."), file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps business callers behind the Facade instead of concrete Adapters or CLI flags", async () => {
    const callers = await Promise.all(BUSINESS_EXECUTION_CALLERS.map(async (file) => ({
      file,
      source: await read(file)
    })));
    for (const { file, source } of callers) {
      expect(source, file).not.toMatch(CONCRETE_HARNESS_ID);
      expect(source, file).not.toMatch(/(?:from|import\s*\()\s*["'][^"']*(?:harness-runtime\/adapters|codex-runner|multi-harness-runner)/);
      expect(source, file).not.toMatch(/node:child_process|\b(?:spawn|execFile|fork)\s*\(/);
      expect(source, file).not.toMatch(/["']--(?:output-format|session-id|resume|mode|permission-mode|print|json)["']/);
    }
  });

  it("keeps protocol routing and the shared event bridge Harness-neutral", async () => {
    const [router, bridge] = await Promise.all([
      read("src/protocol-router.ts"),
      read("src/harness-runtime/official-event-bridge.ts")
    ]);
    expect(router).not.toMatch(CONCRETE_HARNESS_ID);
    expect(router).not.toMatch(/harness-runtime\/(?:registry|adapters)/);
    expect(bridge).not.toMatch(CONCRETE_HARNESS_ID);
    expect(bridge).not.toMatch(/switch\s*\(|\.id\s*===/);
  });

  it("keeps model-brand and vendor-private request adaptations out of production runtime", async () => {
    const serverSource = path.resolve(process.cwd(), "src");
    const files = (await sourceFiles(serverSource)).filter((file) =>
      ![
        "real-gateway-acceptance.ts",
        // This module is a Harness-neutral, declarative allow-list for a
        // user-configured outbound field. It does not branch on a model or
        // provider identity and is the sole production boundary allowed to
        // name such a nested field.
        "internal/shared/gateway-reasoning.ts"
      ].includes(relativeServerSource(file))
    );
    const offenders: string[] = [];
    for (const file of files) {
      const source = await fs.readFile(file, "utf8");
      if (/qwen|qwenBuffer|chat_template_kwargs|enable_thinking|thinkingFormat/i.test(source)) {
        offenders.push(relativeServerSource(file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("allows concrete Adapter imports only in the runtime composition root", async () => {
    const serverSource = path.resolve(process.cwd(), "src");
    const files = await sourceFiles(serverSource);
    const adapterImporters: string[] = [];
    const codexRunnerImporters: string[] = [];
    for (const file of files) {
      const source = await fs.readFile(file, "utf8");
      if (/(?:from|import\s*\()\s*["'][^"']*(?:harness-runtime\/adapters|\.\/adapters\/)/.test(source)) {
        adapterImporters.push(relativeServerSource(file));
      }
      if (/(?:from|import\s*\()\s*["'][^"']*codex-runner(?:\.js)?["']/.test(source)) {
        codexRunnerImporters.push(relativeServerSource(file));
      }
    }
    expect(adapterImporters.sort()).toEqual(["harness-runtime/runtime.ts"]);
    expect(codexRunnerImporters.sort()).toEqual([
      "harness-runtime/adapters/codex-adapter.ts",
      // The resident Codex launch is also Adapter-owned translation; product
      // callers still reach it only through the runtime composition root.
      "harness-runtime/adapters/resident-adapter-factory.ts"
    ]);
  });

  it("keeps literal Harness-ID branches out of Adapter-external business code", async () => {
    const roots = [
      path.resolve(process.cwd(), "src"),
      path.resolve(process.cwd(), "..", "web", "src")
    ];
    const files = (await Promise.all(roots.map(sourceFiles))).flat();
    const literalId = `["'][a-z0-9](?:[a-z0-9._-]{0,63})["']`;
    const harnessValue = String.raw`\b(?:[A-Za-z_$][\w$]*\.)*(?:harnessId|harness|selectedHarnessId)`;
    const literalBranch = new RegExp([
      `${harnessValue}\\s*(?:===|!==|==|!=)\\s*${literalId}`,
      `${literalId}\\s*(?:===|!==|==|!=)\\s*${harnessValue}`,
      `switch\\s*\\(\\s*${harnessValue}\\s*\\)`
    ].join("|"), "i");
    const offenders: string[] = [];
    for (const file of files) {
      const normalized = normalizedPath(file);
      if (/\.test\.(?:ts|tsx)$/.test(normalized) ||
        normalized.endsWith("/server/src/harness-runtime/registry.ts") ||
        normalized.includes("/server/src/harness-runtime/adapters/")) continue;
      const source = (await fs.readFile(file, "utf8"))
        // Runtime validation such as `typeof value.harness === "string"` is
        // schema handling, not dispatch based on a concrete Harness identity.
        .replace(/\btypeof\s+(?:[A-Za-z_$][\w$]*\.)*(?:harnessId|harness|selectedHarnessId)\b/g, "");
      if (literalBranch.test(source)) {
        offenders.push(path.relative(path.resolve(process.cwd(), ".."), file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps Adapters independent from product state machines and HTTP/UI layers", async () => {
    const adapterRoot = path.resolve(process.cwd(), "src", "harness-runtime", "adapters");
    const files = await sourceFiles(adapterRoot);
    const forbiddenImports = /(?:from\s+|import\s*\()\s*["'][^"']*(?:\/(?:orchestrator|project-explainer|storage|app)(?:\.js)?|web\/src)["']/;
    const offenders: string[] = [];
    for (const file of files) {
      if (forbiddenImports.test(await fs.readFile(file, "utf8"))) {
        offenders.push(relativeServerSource(file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("has one CLI process host and no legacy multi-Harness implementation", async () => {
    const serverSource = path.resolve(process.cwd(), "src");
    const files = await sourceFiles(serverSource);
    const spawnOwners: string[] = [];
    for (const file of files) {
      const relative = relativeServerSource(file);
      if (!isAdapterImplementation(relative) &&
        !relative.startsWith("harness-runtime/")) continue;
      if (/\b(?:spawn|execFile(?:Async)?|fork)\s*\(/.test(await fs.readFile(file, "utf8"))) {
        spawnOwners.push(relativeServerSource(file));
      }
    }
    expect(spawnOwners.sort()).toEqual([
      "harness-runtime/adapters/pi-mcp-extension.ts",
      // Standalone MCP sidecar retains the byte-pinned openat2 helper; it is
      // not an Adapter-owned model CLI process.
      "harness-runtime/descriptor-broker-mcp.ts",
      "harness-runtime/process-host.ts",
      // Windows helpers control the process host's Job Object and compile
      // its pinned patch launcher; neither is a second model CLI host.
      "harness-runtime/windows-codex-patch.ts",
      "harness-runtime/windows-resident.ts"
    ]);
    await expect(fs.access(path.join(serverSource, "multi-harness-runner.ts"))).rejects.toMatchObject({
      code: "ENOENT"
    });
    await expect(fs.access(path.join(serverSource, "harness.ts"))).rejects.toMatchObject({
      code: "ENOENT"
    });
    const allSource = await Promise.all(files.map((file) => fs.readFile(file, "utf8")));
    const joined = allSource.join("\n");
    expect(joined).not.toMatch(/MultiHarnessRunner|CodexProjectExplainer|multi-harness-runner/);
    expect(joined).not.toMatch(/(?:LEGACY|ROLLOUT|USE_NEW|USE_LEGACY|ENABLE_LEGACY)_[A-Z0-9_]*HARNESS|HARNESS_[A-Z0-9_]*(?:ROLLOUT|LEGACY_RUNNER)/);
  });

  it("centralizes process construction and recovery accounting in the common host", async () => {
    const serverSource = path.resolve(process.cwd(), "src");
    const files = await sourceFiles(serverSource);
    const commonHostConstructors: string[] = [];
    const directRecoveryAccounting: string[] = [];
    const commonHostOwners: string[] = [];
    const childProcessImporters: string[] = [];

    for (const file of files) {
      const relative = relativeServerSource(file);
      const source = await fs.readFile(file, "utf8");
      if (/\bnew\s+CommonProcessHost\s*\(/.test(source)) {
        commonHostConstructors.push(relative);
      }
      if (!isAdapterImplementation(relative)) continue;
      if (/\brecoveryBudget\s*\.\s*startAttempt\s*\(/.test(source)) {
        directRecoveryAccounting.push(relative);
      }
      if (/import\s+(?:type\s+)?\{[^}]*\bCommonProcessHost\b[^}]*\}\s+from\s+["'][^"']*process-host(?:\.js)?["']/s.test(source) ||
        /:\s*CommonProcessHost\b/.test(source)) {
        commonHostOwners.push(relative);
      }
      if (/(?:from\s+|require\s*\(\s*)["']node:child_process["']/.test(source)) {
        childProcessImporters.push(relative);
      }
    }

    expect(commonHostConstructors).toEqual(["harness-runtime/runtime.ts"]);
    expect(directRecoveryAccounting).toEqual([]);
    expect(commonHostOwners).toEqual([]);
    expect(childProcessImporters).toEqual([
      "harness-runtime/adapters/pi-mcp-extension.ts"
    ]);

    const piMcpExtension = await read("src/harness-runtime/adapters/pi-mcp-extension.ts");
    expect(piMcpExtension).not.toMatch(
      /\.\.\.\s*process\.env\b|\benv\s*:\s*process\.env\b|Object\.assign\s*\([^)]*\bprocess\.env\b/s
    );
  });

  it("keeps legacy provider event names inside the historical usage reader", async () => {
    const orchestrator = await read("src/orchestrator.ts");
    const historicalReader = orchestrator.indexOf("function tokenUsageFromEvents(");
    expect(historicalReader).toBeGreaterThan(0);
    expect(orchestrator.slice(0, historicalReader)).not.toMatch(/Codex thread started|Codex turn completed/);
  });

  it("keeps the production frontend Catalog-driven", async () => {
    const frontendRoot = path.resolve(process.cwd(), "..", "web", "src");
    const productionFiles = (await sourceFiles(frontendRoot)).filter((file) =>
      !/\.test\.(?:ts|tsx)$/.test(file)
    );
    const content = (await Promise.all(productionFiles.map((file) => fs.readFile(file, "utf8")))).join("\n");
    expect(content).not.toMatch(/HARNESS_NATIVE_PROTOCOL/);
    expect(content).not.toMatch(CONCRETE_HARNESS_ID);
    expect(content).not.toMatch(/(?:HARNESS_(?:LABELS|PROTOCOLS|OPTIONS)|DEFAULT_HARNESS_ID)\s*=/);
  });

  it("keeps the built-in metadata and default declaration in the Registry", async () => {
    const serverSource = path.resolve(process.cwd(), "src");
    const files = await sourceFiles(serverSource);
    const descriptorOwners: string[] = [];
    const defaultOwners: string[] = [];
    for (const file of files) {
      const source = await fs.readFile(file, "utf8");
      if (/\b(?:const|let|var)\s+BUILTIN_HARNESS_DESCRIPTORS\b/.test(source)) {
        descriptorOwners.push(relativeServerSource(file));
      }
      if (/\b(?:const|let|var)\s+DEFAULT_HARNESS_ID\b/.test(source)) {
        defaultOwners.push(relativeServerSource(file));
      }
    }
    expect(descriptorOwners).toEqual(["harness-runtime/registry.ts"]);
    expect(defaultOwners).toEqual(["harness-runtime/registry.ts"]);
  });
});
