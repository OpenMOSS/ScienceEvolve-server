import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolveSleepMcpCommand } from "../src/harness-runtime/runtime-support.js";

const children: ChildProcess[] = [];
afterEach(() => { for (const child of children.splice(0)) child.kill(); });

async function start() {
  const command = await resolveSleepMcpCommand();
  const child = spawn(command.command, command.args, { stdio: ["pipe", "pipe", "pipe"] });
  children.push(child);
  const replies = new Map<number, (response: any) => void>();
  readline.createInterface({ input: child.stdout }).on("line", line => {
    const response = JSON.parse(line);
    replies.get(response.id)?.(response);
    replies.delete(response.id);
  });
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("close", resolve);
    child.once("error", reject);
  });
  const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
  function request(id: number, method: string, params?: unknown): Promise<any> {
    const reply = new Promise(resolve => { replies.set(id, resolve); });
    send({ jsonrpc: "2.0", id, method, params });
    return reply;
  }
  const sleep = (id: number, args: unknown) => request(id, "tools/call", { name: "sleep", arguments: args });
  return { child, closed, send, request, sleep };
}

describe("built-in sleep MCP", () => {
  it("works with the MCP SDK and waits for the requested duration", async () => {
    const command = await resolveSleepMcpCommand();
    const client = new Client({ name: "sleep-test", version: "1.0.0" });
    const transport = new StdioClientTransport(command);
    try {
      await client.connect(transport);
      const list = await client.listTools();
      expect(list.tools.map(tool => tool.name)).toEqual(["sleep"]);
      expect(list.tools[0]?.inputSchema.properties?.duration_ms).toMatchObject({ minimum: 1, maximum: 43_200_000 });
      const response = await client.callTool({ name: "sleep", arguments: { duration_ms: 100 } });
      expect(response.isError).not.toBe(true);
      const payload = JSON.parse((response.content as Array<{ text: string }>)[0]!.text);
      expect(payload.duration_ms).toBe(100);
      expect(payload.elapsed_ms).toBeGreaterThanOrEqual(90);
      const shortest = await client.callTool({ name: "sleep", arguments: { duration_ms: 1 } });
      expect(shortest.isError).not.toBe(true);
    } finally { await client.close(); }
  });

  it.each([{}, { duration_ms: -1 }, { duration_ms: 43_200_001 }, { duration_ms: 0 }, { duration_ms: 1.5 },
    { duration_ms: "1" }, { duration_ms: null }, { duration_ms: 0, extra: true }, []])(
    "rejects invalid arguments %j", async args => {
      const server = await start();
      expect(await server.sleep(1, args)).toMatchObject({ error: { code: -32602 } });
      server.child.stdin.end();
      expect(await server.closed).toBe(0);
    }
  );

  it("serves ping and concurrent sleeps while a long sleep is pending, and cancels promptly", async () => {
    const server = await start();
    const long = server.sleep(1, { duration_ms: 43_200_000 });
    expect(await server.request(2, "ping")).toMatchObject({ result: {} });
    expect(await server.sleep(3, { duration_ms: 1 })).toHaveProperty("result");
    server.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } });
    expect(await long).toMatchObject({ error: { code: -32800 } });
    expect(await server.sleep(4, { duration_ms: 1 })).toHaveProperty("result");
    server.child.stdin.end();
    expect(await server.closed).toBe(0);
  });

  it("cancels pending timers on stdin close without keeping the child alive", async () => {
    const server = await start();
    const long = server.sleep(1, { duration_ms: 43_200_000 });
    await server.request(2, "ping");
    server.child.stdin.end();
    expect(await long).toMatchObject({ error: { code: -32800 } });
    expect(await server.closed).toBe(0);
  });
});
