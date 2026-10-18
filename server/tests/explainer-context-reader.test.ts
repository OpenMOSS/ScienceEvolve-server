import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { openExplainerAssistantMcp, readExplainerContext } from "../src/explainer-assistant-mcp.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function fixture() { const root = await fs.mkdtemp(path.join(os.tmpdir(), "explainer-context-reader-")); roots.push(root); return root; }

describe("Explainer on-demand context reading", () => {
  it("reads complete UTF-8 source data through the actual MCP endpoint without exposing mutation tools", async () => {
    const root = await fixture(), original = "当前实验结果与摘要证据。".repeat(20);
    await fs.writeFile(path.join(root, "selected.json"), original);
    const endpoint = await openExplainerAssistantMcp(undefined, "summary", new AbortController().signal, async () => undefined, root);
    const client = new Client({ name: "summary-agent", version: "1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url)));
      expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(["read_context"]);
      let offset = 0, text = "";
      for (;;) {
        const result = await client.callTool({ name: "read_context", arguments: { path: "selected.json", offset, maxBytes: 17 } });
        expect(result.isError).not.toBe(true);
        const read = JSON.parse((result.content as Array<{ text: string }>)[0].text);
        expect(read.nextOffset).toBeGreaterThan(offset); text += read.text; offset = read.nextOffset;
        if (read.eof) break;
      }
      expect(text).toBe(original); expect(await fs.readFile(path.join(root, "selected.json"), "utf8")).toBe(original);
    } finally { await client.close(); await endpoint.close(); }
  });

  it("rejects paths outside supplied roots, symlink escapes and linked files", async () => {
    const root = await fixture(), outside = await fixture();
    await fs.writeFile(path.join(outside, "secret"), "not context");
    await fs.symlink(path.join(outside, "secret"), path.join(root, "escape"));
    await fs.link(path.join(outside, "secret"), path.join(root, "linked"));
    for (const value of [path.join(outside, "secret"), "../secret", "escape", "linked"])
      await expect(readExplainerContext(root, { path: value })).rejects.toThrow();
    await expect(readExplainerContext(root, { path: "anything", maxBytes: 500000 })).rejects.toThrow(/range/);
  });

  it("rejects a read root replaced after the invocation was opened", async () => {
    const parent = await fixture(), root = path.join(parent, "authorized"); await fs.mkdir(root);
    await fs.writeFile(path.join(root, "record.json"), "original authorized data");
    const endpoint = await openExplainerAssistantMcp(undefined, "summary", new AbortController().signal, async () => undefined, root);
    const client = new Client({ name: "root-identity", version: "1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url)));
      await fs.rename(root, path.join(parent, "archived")); await fs.mkdir(root);
      await fs.writeFile(path.join(root, "record.json"), "REPLACEMENT_MUST_NOT_BE_READ");
      const result = await client.callTool({ name: "read_context", arguments: { path: "record.json" } });
      expect(result.isError).toBe(true); expect(JSON.stringify(result.content)).not.toContain("REPLACEMENT_MUST_NOT_BE_READ");
    } finally { await client.close(); await endpoint.close(); }
  });
});
