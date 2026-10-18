import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "smol-toml";
import { loadCodexProviderSettings } from "../src/codex-provider-config.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      fs.rm(root, { recursive: true, force: true })
    )
  );
});

describe("loadCodexProviderSettings", () => {
  it("forwards only the selected provider and its referenced environment", async () => {
    const codexHome = await temporaryCodexHome();
    await fs.writeFile(
      path.join(codexHome, "config.toml"),
      [
        'model = "ignored-model"',
        'model_reasoning_effort = "low"',
        'service_tier = "fast"',
        'sandbox_mode = "read-only"',
        'model_provider = "moss"',
        "",
        "[features]",
        "multi_agent = true",
        "",
        "[model_providers.moss]",
        'name = "Moss"',
        'base_url = "https://provider.example/v1"',
        'wire_api = "responses"',
        'env_key = "MOSS_API_KEY"',
        'env_http_headers = { "X-Tenant" = "MOSS_TENANT" }',
        'experimental_bearer_token = "selected-inline-bearer-secret"',
        'http_headers = { Authorization = "Bearer selected-header-secret" }',
        'query_params = { api_key = "selected-query-secret" }',
        "",
        "[model_providers.unused]",
        'name = "Unused"',
        'experimental_bearer_token = "must-not-be-forwarded"',
        ""
      ].join("\n"),
      "utf8"
    );

    const settings = await loadCodexProviderSettings(codexHome);

    expect(settings.modelProvider).toBe("moss");
    expect(settings.environmentKeys).toEqual(["MOSS_API_KEY", "MOSS_TENANT"]);
    expect(settings.configOverrides).toHaveLength(3);
    expect(settings.routeConfigOverrides).toEqual(['service_tier="fast"']);
    const forwarded = parse(settings.configOverrides.join("\n"));
    expect(forwarded).toMatchObject({
      service_tier: "fast",
      model_provider: "moss",
      model_providers: {
        moss: {
          name: "Moss",
          base_url: "https://provider.example/v1",
          wire_api: "responses",
          env_key: "MOSS_API_KEY",
          env_http_headers: { "X-Tenant": "MOSS_TENANT" }
        }
      }
    });
    expect(Object.keys(forwarded)).toEqual([
      "model_provider",
      "model_providers",
      "service_tier"
    ]);
    expect(settings.configOverrides.join(" ")).not.toContain("ignored-model");
    expect(settings.configOverrides.join(" ")).not.toContain("multi_agent");
    expect(settings.configOverrides.join(" ")).not.toContain("Unused");
    expect(settings.configOverrides.join(" ")).not.toContain(
      "must-not-be-forwarded"
    );
    expect(settings.configOverrides.join(" ")).not.toContain(
      "selected-inline-bearer-secret"
    );
    expect(settings.configOverrides.join(" ")).not.toContain(
      "selected-header-secret"
    );
    expect(settings.configOverrides.join(" ")).not.toContain(
      "selected-query-secret"
    );
  });

  it("re-reads provider changes for every invocation", async () => {
    const codexHome = await temporaryCodexHome();
    const configPath = path.join(codexHome, "config.toml");
    await fs.writeFile(
      configPath,
      [
        'service_tier = "fast"',
        'model_provider = "first"',
        "[model_providers.first]",
        'base_url = "https://first.example/v1"',
        'wire_api = "responses"',
        ""
      ].join("\n"),
      "utf8"
    );
    const first = await loadCodexProviderSettings(codexHome);

    await fs.writeFile(
      configPath,
      [
        'service_tier = "priority"',
        'model_provider = "second"',
        "[model_providers.second]",
        'base_url = "https://second.example/v1"',
        'wire_api = "responses"',
        ""
      ].join("\n"),
      "utf8"
    );
    const second = await loadCodexProviderSettings(codexHome);

    expect(first.modelProvider).toBe("first");
    expect(first.configOverrides.join(" ")).toContain("first.example");
    expect(first.configOverrides).toContain('service_tier="fast"');
    expect(first.routeConfigOverrides).toEqual(['service_tier="fast"']);
    expect(second.modelProvider).toBe("second");
    expect(second.configOverrides.join(" ")).toContain("second.example");
    expect(second.configOverrides.join(" ")).not.toContain("first.example");
    expect(second.configOverrides).toContain('service_tier="priority"');
    expect(second.routeConfigOverrides).toEqual(['service_tier="priority"']);
  });

  it("never projects credential-bearing provider URLs into argv overrides", async () => {
    const codexHome = await temporaryCodexHome();
    await fs.writeFile(
      path.join(codexHome, "config.toml"),
      [
        'model_provider = "moss"',
        "[model_providers.moss]",
        'name = "Moss"',
        'base_url = "https://inline-user:inline-password@provider.example/v1?api_key=query-secret#fragment-secret"',
        'wire_api = "responses"',
        ""
      ].join("\n"),
      "utf8"
    );

    const settings = await loadCodexProviderSettings(codexHome);
    const serialized = settings.configOverrides.join(" ");
    const forwarded = parse(settings.configOverrides.join("\n"));

    expect(serialized).not.toContain("inline-user");
    expect(serialized).not.toContain("inline-password");
    expect(serialized).not.toContain("query-secret");
    expect(serialized).not.toContain("fragment-secret");
    expect(forwarded.model_providers).toEqual({
      moss: { name: "Moss", wire_api: "responses" }
    });
  });

  it("returns no overrides when config or model_provider is absent", async () => {
    const codexHome = await temporaryCodexHome();
    expect(await loadCodexProviderSettings(codexHome)).toEqual({
      configOverrides: [],
      routeConfigOverrides: [],
      environmentKeys: []
    });
    await fs.writeFile(
      path.join(codexHome, "config.toml"),
      'model = "ignored"\n',
      "utf8"
    );
    expect(await loadCodexProviderSettings(codexHome)).toEqual({
      configOverrides: [],
      routeConfigOverrides: [],
      environmentKeys: []
    });
  });

  it("rejects malformed provider fields without exposing config contents", async () => {
    const codexHome = await temporaryCodexHome();
    await fs.writeFile(
      path.join(codexHome, "config.toml"),
      "model_provider = 42\n",
      "utf8"
    );
    await expect(loadCodexProviderSettings(codexHome)).rejects.toThrow(
      "model_provider must be a non-empty string"
    );
  });

  it("rejects a malformed service tier", async () => {
    const codexHome = await temporaryCodexHome();
    await fs.writeFile(
      path.join(codexHome, "config.toml"),
      [
        'model_provider = "moss"',
        "service_tier = 42",
        "[model_providers.moss]",
        'base_url = "https://provider.example/v1"',
        ""
      ].join("\n"),
      "utf8"
    );
    await expect(loadCodexProviderSettings(codexHome)).rejects.toThrow(
      "service_tier must be a non-empty string"
    );
  });
});

async function temporaryCodexHome(): Promise<string> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "scienceevolve-codex-provider-")
  );
  temporaryRoots.push(root);
  const codexHome = path.join(root, ".codex");
  await fs.mkdir(codexHome, { recursive: true });
  return codexHome;
}
