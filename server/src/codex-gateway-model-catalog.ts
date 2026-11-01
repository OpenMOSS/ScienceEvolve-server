import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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
  const known = models.find((entry) => entry && typeof entry === "object" && entry.slug === model);
  // An unknown gateway slug can inherit the CLI's first, code-only catalog
  // entry. Use a normal tool-loop template, without renaming the actual model.
  const template = known ?? models.find((entry) => entry && typeof entry === "object" &&
    entry.use_responses_lite === false && entry.tool_mode == null);
  if (!template) throw new Error("Installed Codex has no ordinary Responses tool-loop template");
  if (known && known.use_responses_lite !== true && known.tool_mode !== "code_mode_only") return undefined;
  const selected = known ?? { ...template, slug: model, display_name: model,
    supported_reasoning_levels: [], default_reasoning_level: null,
    supports_reasoning_summary_parameter: false, input_modalities: ["text"] };
  const outputPath = path.join(runtimePath, "codex-gateway-model-catalog.json");
  await fs.writeFile(outputPath, JSON.stringify({ models: [{
    ...selected,
    use_responses_lite: false,
    tool_mode: null
  }] }), { encoding: "utf8", mode: 0o600 });
  return outputPath;
}
