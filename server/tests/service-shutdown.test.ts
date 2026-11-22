import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { CollaborationStateDatabase } from "../src/collaboration-state/store.js";

it.runIf(process.platform === "linux")("retains the writer process through a slow and then unconfirmed signal drain", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "scienceevolve-signal-drain-"));
  const options = { databasePath: path.join(root, "state.sqlite"), topology: "single-host" as const, hostId: "fixture", serviceId: "signal-host" };
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
    import { MessageChannel } from 'node:worker_threads';
    import { CollaborationStateDatabase } from ${JSON.stringify(new URL("../src/collaboration-state/store.ts", import.meta.url).href)};
    import { installServiceShutdown } from ${JSON.stringify(new URL("../src/service-shutdown.ts", import.meta.url).href)};
    const database = CollaborationStateDatabase.open(${JSON.stringify(options)});
    const serving = new MessageChannel(); serving.port1.ref();
    let attempt = 0;
    installServiceShutdown(async signal => {
      console.log('drain', ++attempt, signal);
      if (attempt === 1) {
        serving.port1.close(); serving.port2.close();
        await new Promise(resolve => process.once('SIGUSR2', resolve));
        throw new Error('fixture native Stop still unconfirmed');
      }
      database.close();
    });
    console.log('serving epoch', database.writerLease().epoch);
  `], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { output += chunk; });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const peer = () => CollaborationStateDatabase.open({ ...options, serviceId: "peer" });
  const waitFor = (text: string) => vi.waitFor(() => expect(output).toContain(text), { timeout: 5_000, interval: 20 });
  try {
    await waitFor("serving epoch 1"); child.kill("SIGTERM"); await waitFor("drain 1 SIGTERM");
    child.kill("SIGINT"); // A second signal cannot bypass a still-pending drain.
    await Promise.race([delay(15_500), exit.then(status => { throw new Error(`Premature exit ${JSON.stringify(status)}: ${output}`); })]);
    expect(output).not.toContain("drain 2");
    expect(() => peer()).toThrow(expect.objectContaining({ code: "WRITER_LEASE_HELD" }));
    child.kill("SIGUSR2"); await waitFor("fixture native Stop still unconfirmed");
    expect(() => peer()).toThrow(expect.objectContaining({ code: "WRITER_LEASE_HELD" }));
    child.kill("SIGTERM");
    expect(await exit).toEqual({ code: 0, signal: null }); expect(output).toContain("drain 2 SIGTERM");
    const next = peer(); try { expect(next.writerLease().epoch).toBe(2); } finally { next.close(); }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exit; await fs.rm(root, { recursive: true, force: true });
  }
}, 30_000);
