import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { enablePiProtocolBackpressure } from "../src/harness-runtime/adapters/pi-protocol-stdio.js";

const installedRoot = path.resolve("../harness/pi/node_modules/@mariozechner/pi-coding-agent/dist");
const officialWriter = path.join(installedRoot, "core/output-guard.js");
const officialJsonl = path.join(installedRoot, "modes/rpc/jsonl.js");

it.runIf(process.platform === "linux" && existsSync(officialWriter) && existsSync(officialJsonl))(
  "keeps the installed Pi RPC writer bounded and byte-exact behind a slow pipe consumer", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "openfars-pi-output-pressure-"));
    const producer = path.join(directory, "producer.mjs");
    await writeFile(producer, `
      import {takeOverStdout,writeRawStdout,flushRawStdout} from ${JSON.stringify(pathToFileURL(officialWriter).href)};
      import {serializeJsonLine} from ${JSON.stringify(pathToFileURL(officialJsonl).href)};
      takeOverStdout();
      (${enablePiProtocolBackpressure.toString()})();
      const partial={role:'assistant',content:[{type:'thinking',thinking:'synthetic-only-pressure-fixture-'.repeat(4000)}]};
      let maxStdoutQueueBytes=0;
      for(let i=0;i<2000;i++) {
        writeRawStdout(serializeJsonLine({type:'message_update',sequence:i,
          assistantMessageEvent:{type:'thinking_delta',delta:'fixture',partial},message:partial}));
        maxStdoutQueueBytes=Math.max(maxStdoutQueueBytes,process.stdout.writableLength);
      }
      await flushRawStdout();
      process.stderr.write(JSON.stringify({maxStdoutQueueBytes,maxRssKiB:process.resourceUsage().maxRSS})+'\\n');
    `);
    const child = spawn(process.execPath, ["--max-old-space-size=64", producer], { stdio: ["ignore", "pipe", "pipe"] });
    const completed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-32_000); });
    const decoder = new StringDecoder("utf8");
    let pending = "", frames = 0, bytes = 0;
    try {
      for await (const chunk of child.stdout) {
        bytes += chunk.length;
        pending += decoder.write(chunk);
        for (let newline; (newline = pending.indexOf("\n")) >= 0;) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          const frame = JSON.parse(line);
          expect(frame.sequence).toBe(frames++);
          expect(frame.type).toBe("message_update");
          expect(frame.assistantMessageEvent.delta).toBe("fixture");
          expect(frame.message).toEqual(frame.assistantMessageEvent.partial);
          expect(frame.message.content[0].thinking).toBe("synthetic-only-pressure-fixture-".repeat(4000));
          await new Promise(resolve => setTimeout(resolve, 3));
        }
      }
      pending += decoder.end();
      expect(pending).toBe("");
      expect(await completed, stderr).toEqual({ code: 0, signal: null });
      expect(frames).toBe(2000);
      expect(bytes).toBe(512526890);
      const metrics = JSON.parse(stderr.trim());
      expect(metrics.maxStdoutQueueBytes).toBeLessThan(512_000);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await completed.catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  }, 45_000
);
