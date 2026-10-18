import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveWorkspaceMcpCommand } from "../src/harness-runtime/runtime-support.js";
import {
  PUBLISHED_ARTIFACT_MANIFEST_ENV,
  READ_PUBLISHED_ARTIFACT_TOOL,
  type PublishedArtifactAccessEntry,
  type PublishedArtifactAccessManifest
} from "../src/published-artifact-access.js";

type JsonValue = Record<string, unknown>;

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      fs.rm(root, { recursive: true, force: true })
    )
  );
});

async function runControlMcp(
  root: string,
  requests: JsonValue[],
  environment: Record<string, string> = {}
): Promise<Map<number, JsonValue>> {
  const command = await resolveWorkspaceMcpCommand();
  const child = spawn(
    command.command,
    command.args,
    {
      cwd: root,
      env: {
        ...process.env,
        SCIENCEEVOLVE_APPEND_ROOT: root,
        SCIENCEEVOLVE_AGENT_NAME: "execution",
        ...environment
      },
      stdio: ["pipe", "pipe", "pipe"]
    }
  );
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    }
  );
  child.stdin.end(`${requests.map((request) => JSON.stringify(request)).join("\n")}\n`);
  const result = await closed;
  if (stdout.trim() === "") {
    throw new Error(`control MCP returned no stdout (stderr: ${stderr})`);
  }
  if (result.code !== 0) {
    throw new Error(
      `control MCP failed (code ${result.code ?? "null"}, signal ${result.signal ?? "none"}): ${stderr}`
    );
  }
  return new Map(
    stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as JsonValue)
      .filter((message) => typeof message.id === "number")
      .map((message) => [message.id as number, message])
  );
}

function artifactToolResult(response: JsonValue | undefined): Record<string, unknown> {
  const result = response?.result as {
    content?: Array<{ type?: string; text?: string }>;
  } | undefined;
  const text = result?.content?.[0]?.text;
  if (typeof text !== "string") {
    throw new Error("published artifact tool returned no JSON text result");
  }
  return JSON.parse(text) as Record<string, unknown>;
}

async function writePublishedArtifactManifest(
  root: string,
  projectId: string,
  invocationId: string,
  artifacts: PublishedArtifactAccessEntry[]
): Promise<string> {
  const manifestPath = path.join(root, "published-artifacts.json");
  const manifest: PublishedArtifactAccessManifest = {
    schemaVersion: 1,
    projectId,
    invocationId,
    createdAt: new Date().toISOString(),
    artifacts
  };
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  return manifestPath;
}

describe("scienceevolve append workspace MCP", () => {
  it("appends arbitrary shared files verbatim and rejects unsafe paths", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "scienceevolve-control-mcp-"));
    temporaryRoots.push(root);
    await fs.writeFile(path.join(root, "report.md"), "existing\n", "utf8");
    const outsideName = `${path.basename(root)}-outside.md`;
    const responses = await runControlMcp(root, [
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "scienceevolve_append_file",
          arguments: { path: "report.md", content: "added without reading\n" }
        }
      },
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "scienceevolve_append_file",
          arguments: { path: "notes/new.md", content: "created on append" }
        }
      },
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "scienceevolve_append_file",
          arguments: { path: `../${outsideName}`, content: "must not escape" }
        }
      },
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: {
          name: "scienceevolve_append_file",
          arguments: { path: "report.md", content: "second append\n" }
        }
      },
      {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: {
          name: "scienceevolve_append_file",
          arguments: { path: "cancelled.md", content: "must not be committed" }
        }
      },
      {
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 7, reason: "caller stopped the request" }
      }
    ]);

    const listed = responses.get(2)!;
    const tools = (listed.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((tool) => tool.name)).toContain("scienceevolve_append_file");
    expect(tools.map((tool) => tool.name)).not.toContain("scienceevolve_append_memory");
    expect(tools.map((tool) => tool.name)).not.toContain("scienceevolve_read_smoke_sentinel");
    expect(tools.find((tool) => tool.name === "scienceevolve_append_file")).toMatchObject({
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
    });

    const appended = responses.get(3)!;
    expect(appended.error).toBeUndefined();
    expect(await fs.readFile(path.join(root, "report.md"), "utf8")).toBe(
      "existing\nadded without reading\nsecond append\n"
    );

    expect(await fs.readFile(path.join(root, "notes/new.md"), "utf8")).toBe(
      "created on append"
    );

    const rejected = responses.get(5)!;
    expect(rejected.error).toMatchObject({ code: -32602 });
    const outsidePath = path.join(path.dirname(root), outsideName);
    await expect(fs.access(outsidePath)).rejects.toMatchObject({ code: "ENOENT" });

    expect(responses.get(7)?.error).toMatchObject({
      code: -32800,
      message: "Request cancelled"
    });
    await expect(fs.access(path.join(root, "cancelled.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("exposes a no-argument read-only sentinel tool only to smoke probes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "scienceevolve-control-smoke-"));
    temporaryRoots.push(root);
    const sentinel = "OPENFARS_SMOKE_FIXTURE\n";
    await fs.writeFile(path.join(root, "openfars-smoke-sentinel.txt"), sentinel, "utf8");

    const responses = await runControlMcp(root, [
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "scienceevolve_read_smoke_sentinel", arguments: {} }
      },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "scienceevolve_read_smoke_sentinel",
          arguments: { path: "another-file.txt" }
        }
      }
    ], { SCIENCEEVOLVE_AGENT_NAME: "probe" });

    const listed = responses.get(1)!;
    const tools = (listed.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((tool) => tool.name)).toContain("scienceevolve_read_smoke_sentinel");
    expect(tools.find((tool) => tool.name === "scienceevolve_read_smoke_sentinel")).toMatchObject({
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    });
    expect(responses.get(2)?.result).toEqual({
      content: [{ type: "text", text: sentinel }]
    });
    expect(responses.get(3)?.error).toMatchObject({ code: -32602 });
  });

  it("blocks duplicate H1 documents and all existing artifacts during recovery", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "scienceevolve-control-recovery-"));
    temporaryRoots.push(root);
    await Promise.all([
      fs.writeFile(path.join(root, "existing.md"), "# Existing report\n\nEvidence.\n", "utf8"),
      fs.writeFile(path.join(root, "notes.txt"), "existing notes\n", "utf8"),
      fs.writeFile(path.join(root, "Memory.md"), "# Memory\n\nEarlier note.\n", "utf8")
    ]);

    const normal = await runControlMcp(root, [{
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "scienceevolve_append_file",
        arguments: { path: "existing.md", content: "# Duplicate report\n" }
      }
    }]);
    expect(normal.get(1)?.error).toMatchObject({
      code: -32000,
      message: expect.stringContaining("second Markdown H1")
    });
    expect(await fs.readFile(path.join(root, "existing.md"), "utf8")).toBe(
      "# Existing report\n\nEvidence.\n"
    );

    const recovery = await runControlMcp(root, [
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "scienceevolve_append_file",
          arguments: { path: "notes.txt", content: "must not append\n" }
        }
      },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "scienceevolve_append_file",
          arguments: { path: "replacement-v2.md", content: "# Replacement\n\nValid.\n" }
        }
      },
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "scienceevolve_append_file",
          arguments: { path: "replacement-v2.md", content: "second append must fail\n" }
        }
      },
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "scienceevolve_append_file",
          arguments: { path: "Memory.md", content: "Later recovery note.\n" }
        }
      }
    ], { SCIENCEEVOLVE_APPEND_RECOVERY_GUARD: "1" });

    expect(recovery.get(2)?.error).toMatchObject({
      code: -32000,
      message: expect.stringContaining("recovery guard")
    });
    expect(recovery.get(3)?.error).toBeUndefined();
    expect(recovery.get(4)?.error).toMatchObject({
      code: -32000,
      message: expect.stringContaining("recovery guard")
    });
    expect(recovery.get(5)?.error).toBeUndefined();
    expect(await fs.readFile(path.join(root, "notes.txt"), "utf8")).toBe("existing notes\n");
    expect(await fs.readFile(path.join(root, "replacement-v2.md"), "utf8")).toBe(
      "# Replacement\n\nValid.\n"
    );
    expect(await fs.readFile(path.join(root, "Memory.md"), "utf8")).toContain(
      "Later recovery note."
    );
  });

  it("reads every formally published artifact by id in bounded, lossless chunks", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "scienceevolve-control-artifacts-"));
    temporaryRoots.push(root);
    const producerRoot = path.join(root, "published-artifacts");
    await fs.mkdir(producerRoot);
    const artifacts: PublishedArtifactAccessEntry[] = [];
    const firstContent = `${"0123456789abcdef".repeat(400)}完整结尾\n`;
    for (let index = 0; index < 13; index += 1) {
      const content = index === 0 ? firstContent : `artifact-${index}\n`;
      const sourcePath = path.join(producerRoot, `artifact-${index}.md`);
      await fs.writeFile(sourcePath, content, "utf8");
      const bytes = Buffer.from(content);
      artifacts.push({
        id: `art_${index}`,
        agent: "execution",
        path: `artifact-${index}.md`,
        title: `Artifact ${index}`,
        kind: "document",
        description: `Published fixture ${index}`,
        size: bytes.length,
        mediaType: "text/markdown",
        registeredAt: "2026-09-24T00:00:00.000Z",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        workspaceRoot: producerRoot,
        sourcePath
      });
    }
    const binaryContent = Buffer.from([0x00, 0xff, 0x81, 0x7f, 0x42]);
    const binaryPath = path.join(producerRoot, "artifact-binary.bin");
    await fs.writeFile(binaryPath, binaryContent);
    artifacts.push({
      id: "art_binary",
      agent: "execution",
      path: "artifact-binary.bin",
      title: "Binary artifact",
      kind: "binary",
      description: "Published binary fixture",
      size: binaryContent.length,
      mediaType: "application/octet-stream",
      registeredAt: "2026-09-24T00:00:00.000Z",
      sha256: createHash("sha256").update(binaryContent).digest("hex"),
      workspaceRoot: producerRoot,
      sourcePath: binaryPath
    });
    const projectId = "prj_control_artifact_fixture";
    const invocationId = "inv_control_artifact_fixture";
    const manifestPath = await writePublishedArtifactManifest(
      root,
      projectId,
      invocationId,
      artifacts
    );
    const responses = await runControlMcp(root, [
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: READ_PUBLISHED_ARTIFACT_TOOL,
          arguments: { artifactId: "art_0", offset: 0, limit: 2_048 }
        }
      },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: READ_PUBLISHED_ARTIFACT_TOOL,
          arguments: { artifactId: "art_0", offset: 2_048, limit: 2_048 }
        }
      },
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: READ_PUBLISHED_ARTIFACT_TOOL,
          arguments: { artifactId: "art_0", offset: 4_096, limit: 65_536 }
        }
      },
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: READ_PUBLISHED_ARTIFACT_TOOL,
          arguments: { artifactId: "art_12" }
        }
      },
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: {
          name: READ_PUBLISHED_ARTIFACT_TOOL,
          arguments: { artifactId: "art_binary", offset: 0, limit: 3 }
        }
      }
    ], {
      [PUBLISHED_ARTIFACT_MANIFEST_ENV]: manifestPath,
      SCIENCEEVOLVE_PROJECT_ID: projectId,
      SCIENCEEVOLVE_INVOCATION_ID: invocationId
    });

    const listed = responses.get(1)?.result as {
      tools: Array<{ name: string; annotations?: Record<string, boolean> }>;
    };
    expect(listed.tools.find((tool) => tool.name === READ_PUBLISHED_ARTIFACT_TOOL)).toMatchObject({
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    });
    const chunks = [2, 3, 4].map((id) => artifactToolResult(responses.get(id)));
    expect(chunks.map((chunk) => chunk.offset)).toEqual([0, 2_048, 4_096]);
    expect(chunks.map((chunk) => chunk.nextOffset)).toEqual([2_048, 4_096, Buffer.byteLength(firstContent)]);
    expect(chunks.map((chunk) => chunk.hasMore)).toEqual([true, true, false]);
    expect(chunks.map((chunk) => chunk.content).join("")).toBe(firstContent);
    expect(artifactToolResult(responses.get(5))).toMatchObject({
      artifact: { id: "art_12", producer: "execution" },
      content: "artifact-12\n",
      hasMore: false,
      encoding: "utf8"
    });
    const binaryChunk = artifactToolResult(responses.get(6));
    expect(binaryChunk).toMatchObject({
      artifact: { id: "art_binary", mediaType: "application/octet-stream" },
      offset: 0,
      length: 3,
      nextOffset: 3,
      hasMore: true,
      encoding: "base64"
    });
    expect(Buffer.from(binaryChunk.content as string, "base64")).toEqual(
      binaryContent.subarray(0, 3)
    );
  });

  it("rejects unpublished ids, changed files, symlink escapes, and cross-invocation manifests", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "scienceevolve-control-artifact-guard-"));
    temporaryRoots.push(root);
    const producerRoot = path.join(root, "published-artifacts");
    const outsideRoot = path.join(root, "outside");
    await Promise.all([fs.mkdir(producerRoot), fs.mkdir(outsideRoot)]);
    const mutablePath = path.join(producerRoot, "mutable.md");
    const outsidePath = path.join(outsideRoot, "secret.md");
    await Promise.all([
      fs.writeFile(mutablePath, "published bytes\n", "utf8"),
      fs.writeFile(outsidePath, "outside bytes\n", "utf8")
    ]);
    const escapePath = path.join(producerRoot, "escape.md");
    await fs.symlink(outsidePath, escapePath);
    const entry = (
      id: string,
      relativePath: string,
      sourcePath: string,
      content: string
    ): PublishedArtifactAccessEntry => ({
      id,
      agent: "execution",
      path: relativePath,
      title: id,
      kind: "document",
      description: "guard fixture",
      size: Buffer.byteLength(content),
      mediaType: "text/markdown",
      sha256: createHash("sha256").update(content).digest("hex"),
      workspaceRoot: producerRoot,
      sourcePath
    });
    const projectId = "prj_control_artifact_guard";
    const invocationId = "inv_control_artifact_guard";
    const manifestPath = await writePublishedArtifactManifest(
      root,
      projectId,
      invocationId,
      [
        entry("art_mutable", "mutable.md", mutablePath, "published bytes\n"),
        entry("art_escape", "escape.md", escapePath, "outside bytes\n")
      ]
    );
    await fs.writeFile(mutablePath, "mutated after publication\n", "utf8");
    const environment = {
      [PUBLISHED_ARTIFACT_MANIFEST_ENV]: manifestPath,
      SCIENCEEVOLVE_PROJECT_ID: projectId,
      SCIENCEEVOLVE_INVOCATION_ID: invocationId
    };
    const responses = await runControlMcp(root, [
      ...["../outside/secret.md", "art_missing", "art_mutable", "art_escape"].map(
        (artifactId, index) => ({
          jsonrpc: "2.0",
          id: index + 1,
          method: "tools/call",
          params: {
            name: READ_PUBLISHED_ARTIFACT_TOOL,
            arguments: { artifactId }
          }
        })
      )
    ], environment);
    expect(responses.get(1)?.error).toMatchObject({
      code: -32000,
      message: expect.stringContaining("not present")
    });
    expect(responses.get(2)?.error).toMatchObject({
      code: -32000,
      message: expect.stringContaining("not present")
    });
    expect(responses.get(3)?.error).toMatchObject({
      code: -32000,
      message: expect.stringContaining("changed after publication")
    });
    expect(responses.get(4)?.error).toMatchObject({
      code: -32000,
      message: expect.stringContaining("snapshot is not a regular file")
    });

    const crossInvocation = await runControlMcp(root, [
      { jsonrpc: "2.0", id: 10, method: "tools/list" },
      {
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: {
          name: READ_PUBLISHED_ARTIFACT_TOOL,
          arguments: { artifactId: "art_mutable" }
        }
      }
    ], { ...environment, SCIENCEEVOLVE_INVOCATION_ID: "inv_other" });
    const crossTools = (crossInvocation.get(10)?.result as {
      tools: Array<{ name: string }>;
    }).tools;
    expect(crossTools.map((tool) => tool.name)).not.toContain(READ_PUBLISHED_ARTIFACT_TOOL);
    expect(crossInvocation.get(11)?.error).toMatchObject({
      code: -32000,
      message: expect.stringContaining("invalid for this invocation")
    });

    const crossProject = await runControlMcp(root, [
      { jsonrpc: "2.0", id: 20, method: "tools/list" },
      {
        jsonrpc: "2.0",
        id: 21,
        method: "tools/call",
        params: {
          name: READ_PUBLISHED_ARTIFACT_TOOL,
          arguments: { artifactId: "art_mutable" }
        }
      }
    ], { ...environment, SCIENCEEVOLVE_PROJECT_ID: "prj_other" });
    const crossProjectTools = (crossProject.get(20)?.result as {
      tools: Array<{ name: string }>;
    }).tools;
    expect(crossProjectTools.map((tool) => tool.name)).not.toContain(
      READ_PUBLISHED_ARTIFACT_TOOL
    );
    expect(crossProject.get(21)?.error).toMatchObject({
      code: -32000,
      message: expect.stringContaining("invalid for this invocation")
    });
  });
});
