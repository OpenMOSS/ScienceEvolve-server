import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CODE_MODE_MODEL = /^gpt-5\.6-(?:sol|terra|luna)$/;

/**
 * The Codex 0.152 bundled catalog sends no tools for GPT-5.6 through a
 * custom Responses provider when Responses Lite and code-only tools are both
 * selected. Keep the actual model slug and its other metadata, but use the
 * ordinary Responses tool loop for OpenFARS gateway invocations.
 */
export async function prepareCodexGatewayModelCatalog(
  executable: string,
  model: string,
  runtimePath: string
): Promise<string | undefined> {
  if (!CODE_MODE_MODEL.test(model)) return undefined;
  const script = /\.(?:[cm]?js)$/i.test(executable);
  const command = script ? process.execPath : executable;
  const args = [...(script ? [executable] : []), "debug", "models", "--bundled"];
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(command, args, {
      timeout: 15_000,
      maxBuffer: 4_000_000,
      windowsHide: true
    }));
  } catch {
    throw new Error("Unable to inspect the installed Codex model catalog");
  }
  let catalog: unknown;
  try { catalog = JSON.parse(stdout); }
  catch { throw new Error("Installed Codex returned an invalid model catalog"); }
  const models = catalog && typeof catalog === "object" && "models" in catalog
    ? (catalog as { models: unknown }).models : undefined;
  if (!Array.isArray(models)) throw new Error("Installed Codex returned an invalid model catalog");
  const selected = models.find((entry) => entry && typeof entry === "object" && entry.slug === model);
  if (!selected) return undefined;
  if (selected.use_responses_lite !== true || selected.tool_mode !== "code_mode_only") return undefined;
  const outputPath = path.join(runtimePath, "codex-gateway-model-catalog.json");
  await fs.writeFile(outputPath, JSON.stringify({ models: [{
    ...selected,
    use_responses_lite: false,
    tool_mode: null
  }] }), { encoding: "utf8", mode: 0o600 });
  return outputPath;
}
