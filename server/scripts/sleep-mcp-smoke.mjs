import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Exercise the actual compiled server through stdio and the official MCP client.
const entry = fileURLToPath(new URL("../dist/src/sleep-mcp.js", import.meta.url));
const transport = new StdioClientTransport({ command: process.execPath, args: [entry] });
const client = new Client({ name: "scienceevolve-sleep-smoke", version: "1.0.0" });
const watchdog = setTimeout(() => {
  console.error("Sleep MCP smoke exceeded its 20 second deadline");
  void client.close().finally(() => { process.exitCode = 1; });
}, 20_000);
let pid;

async function sleep(duration_ms) {
  const started = performance.now();
  const response = await client.callTool({ name: "sleep", arguments: { duration_ms } });
  assert.notEqual(response.isError, true);
  const payload = JSON.parse(response.content[0].text);
  const roundTrip_ms = Math.round(performance.now() - started);
  assert.equal(payload.duration_ms, duration_ms);
  assert.ok(payload.elapsed_ms >= Math.max(0, duration_ms - 10));
  assert.ok(roundTrip_ms < duration_ms + 2_000);
  console.log(JSON.stringify({ check: "real_sleep_call", ...payload, roundTrip_ms }));
}

try {
  await client.connect(transport);
  pid = transport.pid;
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map(tool => tool.name), ["sleep"]);
  console.log(JSON.stringify({ check: "connected", pid, entry, tools: tools.tools.map(tool => tool.name) }));
  await sleep(1_000);
  await sleep(3_000);

  // Observe the server's cancellation response as well as the client's abort.
  let acknowledge;
  const cancelled = new Promise(resolve => { acknowledge = resolve; });
  const receive = transport.onmessage;
  transport.onmessage = message => {
    if (message.error?.code === -32800) acknowledge(message.error);
    receive?.(message);
  };
  const controller = new AbortController();
  const long = client.callTool({ name: "sleep", arguments: { duration_ms: 43_200_000 } }, undefined, {
    signal: controller.signal, timeout: 43_260_000
  }).then(() => { throw new Error("Cancelled sleep unexpectedly completed"); }, error => error);
  await delay(100);
  const pingStarted = performance.now();
  await client.ping();
  const ping_ms = Math.round(performance.now() - pingStarted);
  assert.ok(ping_ms < 1_000);
  await sleep(1);
  const cancelStarted = performance.now();
  controller.abort(new Error("smoke cancellation"));
  const [rejection, serverError] = await Promise.all([long, cancelled]);
  const cancel_ms = Math.round(performance.now() - cancelStarted);
  assert.match(rejection.message, /smoke cancellation/);
  assert.equal(serverError.code, -32800);
  assert.ok(cancel_ms < 1_000);
  console.log(JSON.stringify({ check: "cancellation_and_concurrency", ping_ms, cancel_ms, serverError }));
  await sleep(100);

  await assert.rejects(client.callTool({ name: "sleep", arguments: { duration_ms: -1 } }), error => error.code === -32602);
  console.log(JSON.stringify({ check: "invalid_arguments_rejected", code: -32602 }));
} finally {
  await client.close();
  clearTimeout(watchdog);
}
assert.ok(pid);
assert.throws(() => process.kill(pid, 0), error => error.code === "ESRCH");
console.log(JSON.stringify({ check: "child_exited", pid }));
console.log("Sleep MCP real stdio smoke passed.");
