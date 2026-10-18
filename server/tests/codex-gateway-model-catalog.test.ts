import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareCodexGatewayModelCatalog } from "../src/codex-gateway-model-catalog.js";

const roots: string[] = [];
afterEach(async () => {
  const temporaryDirectory = path.resolve(os.tmpdir());
  await Promise.all(roots.splice(0).map((root) => {
    const target = path.resolve(root);
    if (!target.startsWith(`${temporaryDirectory}${path.sep}`)) throw new Error("Unexpected test cleanup path");
    return fs.rm(target, { recursive: true, force: true });
  }));
});

describe("Codex external gateway model catalog", () => {
  it("keeps the selected GPT-5.6 slug while enabling ordinary Responses tools", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-gateway-catalog-test-"));
    roots.push(root);
    const executable = path.join(root, "catalog.mjs");
    await fs.writeFile(executable, `process.stdout.write(JSON.stringify({models:[
      {slug:"gpt-5.6-terra",use_responses_lite:true,tool_mode:"code_mode_only",shell_type:"unified_exec"},
      {slug:"gpt-5.5",use_responses_lite:false,tool_mode:null}
    ]}));`);
    const output = await prepareCodexGatewayModelCatalog(executable, "gpt-5.6-terra", root);
    expect(output).toBe(path.join(root, "codex-gateway-model-catalog.json"));
    const parsed = JSON.parse(await fs.readFile(output!, "utf8"));
    expect(parsed.models).toEqual([{
      slug: "gpt-5.6-terra", use_responses_lite: false, tool_mode: null, shell_type: "unified_exec"
    }]);
  });

  it("does not inspect the executable for a model outside the affected family", async () => {
    expect(await prepareCodexGatewayModelCatalog("missing", "gpt-5.5", os.tmpdir())).toBeUndefined();
  });
});
