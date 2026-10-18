import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { preparePiSettings } from "../src/harness-runtime/adapters/pi-adapter.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("pi native context budgets", () => {
  it.each([8_192, 65_536, 1_048_576])("fits output and retained history inside a %i-token model window", async (window) => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openfars-pi-context-"));
    roots.push(home);
    await fs.writeFile(path.join(home, "settings.json"), JSON.stringify({ theme: "dark", compaction: { custom: "preserved" } }));
    await preparePiSettings(home, "http://127.0.0.1:9000/v1", "model-a", window);
    const settings = JSON.parse(await fs.readFile(path.join(home, "settings.json"), "utf8"));
    const models = JSON.parse(await fs.readFile(path.join(home, "models.json"), "utf8"));
    const model = models.providers.openfars.models[0];
    expect(settings.theme).toBe("dark");
    expect(settings.compaction.custom).toBe("preserved");
    expect(settings.compaction.enabled).toBe(true);
    expect(model.contextWindow).toBe(window);
    expect(model.maxTokens + (window - settings.compaction.reserveTokens)).toBeLessThan(window);
    expect(settings.compaction.keepRecentTokens).toBeLessThan(window - settings.compaction.reserveTokens);
  });
});
