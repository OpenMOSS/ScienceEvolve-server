import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadConfig,
  resolveExplainerSandboxConfiguration
} from "../src/config.js";

describe("application configuration", () => {
  beforeEach(() => {
    for (const name of Object.keys(process.env)) {
      if (name.startsWith("SCIENCEEVOLVE_") || name.startsWith("SCION_AR_")) {
        vi.stubEnv(name, undefined);
      }
    }
  });
  afterEach(() => vi.unstubAllEnvs());

  it("loads only explicit absolute per-project directory aliases from internal deployment configuration", () => {
    const id = "prj_99999999999999999999999999999999";
    const directory = path.join(path.sep, "original-deployment", "data", "projects", id);
    vi.stubEnv("SCIENCEEVOLVE_PROJECT_DIRECTORY_ALIASES", JSON.stringify({ [id]: directory }));
    expect(loadConfig(path.join(path.sep, "workspace", "scienceevolve")).projectDirectoryAliases).toEqual({ [id]: directory });
    vi.stubEnv("SCIENCEEVOLVE_PROJECT_DIRECTORY_ALIASES", "");
    expect(loadConfig(path.join(path.sep, "workspace", "scienceevolve")).projectDirectoryAliases).toBeUndefined();
  });

  it.each(["[]", "null", "bad-json", '{"other":"/data"}',
    '{"prj_99999999999999999999999999999999":"relative"}',
    '{"prj_99999999999999999999999999999999":"/data/another-project"}'])
    ("rejects invalid internal project directory alias configuration %s", (value) => {
      vi.stubEnv("SCIENCEEVOLVE_PROJECT_DIRECTORY_ALIASES", value);
      expect(() => loadConfig(path.join(path.sep, "workspace", "scienceevolve")))
        .toThrow(/PROJECT_DIRECTORY_ALIASES/);
    });

  it("keeps user-authored Skills under the persistent data directory and catalogues them", () => {
    const config = loadConfig(path.join(path.sep, "workspace", "scienceevolve"));

    expect(config.userSkillRoot).toBe(path.join(config.dataDir, "skills"));
    expect(config.skillRoots).toContain(config.userSkillRoot);
    expect(config.skillRoots.indexOf(config.userSkillRoot)).toBeGreaterThan(0);
  });

  it("selects an installed embedded Codex while preserving the missing-install fallback and explicit override", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "scienceevolve-codex-config-"));
    const embedded = path.join(root, "harness", "codex", "node_modules", ".bin", "codex");
    try {
      expect(loadConfig(root).codexBin).toBe("codex");
      mkdirSync(path.dirname(embedded), { recursive: true });
      writeFileSync(embedded, "fixture executable\n");
      expect(loadConfig(root).codexBin).toBe(embedded);
      expect(loadConfig(path.join(root, "server")).codexBin).toBe(embedded);
      const explicit = path.join(root, "custom", "codex");
      vi.stubEnv("SCIENCEEVOLVE_CODEX_BIN", explicit);
      expect(loadConfig(root).codexBin).toBe(explicit);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("configures long-turn DSH and protocol inactivity deadlines", () => {
    vi.stubEnv("SCIENCEEVOLVE_AGENT_ACTIVITY_IDLE_WINDOW_MS", "300000");
    vi.stubEnv("SCIENCEEVOLVE_AGENT_TOOL_ACTIVITY_IDLE_WINDOW_MS", "2400000");
    vi.stubEnv("SCIENCEEVOLVE_DSH_HANDSHAKE_TIMEOUT_MS", "45000");
    vi.stubEnv("SCIENCEEVOLVE_DSH_TURN_IDLE_TIMEOUT_MS", "1200000");
    vi.stubEnv("SCIENCEEVOLVE_RESIDENT_MODEL_INACTIVITY_TIMEOUT_MS", "900000");
    vi.stubEnv("SCIENCEEVOLVE_RESIDENT_TOOL_INACTIVITY_TIMEOUT_MS", "7200000");
    vi.stubEnv("SCIENCEEVOLVE_PROTOCOL_PROXY_TIMEOUT_MS", "1200000");
    const config = loadConfig(path.join(path.sep, "workspace", "scienceevolve"));
    expect(config.agentActivityIdleWindowMs).toBe(300_000);
    expect(config.agentToolActivityIdleWindowMs).toBe(2_400_000);
    expect(config.dshHandshakeTimeoutMs).toBe(45_000);
    expect(config.residentModelInactivityTimeoutMs).toBe(900_000);
    expect(config.residentToolInactivityTimeoutMs).toBe(7_200_000);
    expect(config.dshTurnIdleTimeoutMs).toBe(1_200_000);
    expect(config.protocolProxyTimeoutMs).toBe(1_200_000);
  });

  it("loads the server-only GitHub OAuth application settings", () => {
    vi.stubEnv("SCIENCEEVOLVE_GITHUB_OAUTH_CLIENT_ID", " oauth-client ");
    vi.stubEnv("SCIENCEEVOLVE_GITHUB_OAUTH_CLIENT_SECRET", " oauth-secret ");
    vi.stubEnv(
      "SCIENCEEVOLVE_GITHUB_OAUTH_CALLBACK_URL",
      " https://openfars.example.test/api/github/auth/callback "
    );
    const config = loadConfig(path.join(path.sep, "workspace", "scienceevolve"));

    expect(config.githubOAuthClientId).toBe("oauth-client");
    expect(config.githubOAuthClientSecret).toBe("oauth-secret");
    expect(config.githubOAuthCallbackUrl)
      .toBe("https://openfars.example.test/api/github/auth/callback");
  });

  it("loads the GitHub OAuth client secret from a server-only file", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "openfars-github-secret-"));
    const secretFile = path.join(directory, "client-secret");
    writeFileSync(secretFile, " oauth-secret-from-file\n", { mode: 0o600 });
    try {
      vi.stubEnv("SCIENCEEVOLVE_GITHUB_OAUTH_CLIENT_SECRET", "");
      vi.stubEnv("SCIENCEEVOLVE_GITHUB_OAUTH_CLIENT_SECRET_FILE", secretFile);

      const config = loadConfig(path.join(path.sep, "workspace", "scienceevolve"));

      expect(config.githubOAuthClientSecret).toBe("oauth-secret-from-file");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves GitHub OAuth settings from deployments using the old prefix", () => {
    vi.stubEnv("SCION_AR_GITHUB_OAUTH_CLIENT_ID", " legacy-client ");
    vi.stubEnv("SCION_AR_GITHUB_OAUTH_CLIENT_SECRET", " legacy-secret ");
    vi.stubEnv("SCION_AR_GITHUB_OAUTH_CALLBACK_URL", " https://legacy.example.test/api/github/auth/callback ");

    const config = loadConfig(path.join(path.sep, "workspace", "scienceevolve"));

    expect(config.githubOAuthClientId).toBe("legacy-client");
    expect(config.githubOAuthClientSecret).toBe("legacy-secret");
    expect(config.githubOAuthCallbackUrl).toBe("https://legacy.example.test/api/github/auth/callback");
  });

  it("loads a relative OAuth secret file configured with the old prefix", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "openfars-legacy-github-secret-"));
    writeFileSync(path.join(directory, "client-secret"), " legacy-secret-from-file\n", { mode: 0o600 });
    try {
      vi.stubEnv("SCION_AR_GITHUB_OAUTH_CLIENT_ID", "legacy-client");
      vi.stubEnv("SCION_AR_GITHUB_OAUTH_CLIENT_SECRET_FILE", "client-secret");
      vi.stubEnv("SCION_AR_GITHUB_OAUTH_CALLBACK_URL", "https://legacy.example.test/api/github/auth/callback");

      const config = loadConfig(directory);

      expect(config.githubOAuthClientId).toBe("legacy-client");
      expect(config.githubOAuthClientSecret).toBe("legacy-secret-from-file");
      expect(config.githubOAuthCallbackUrl).toBe("https://legacy.example.test/api/github/auth/callback");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(["inline", "file"] as const)("prefers new OAuth %s credentials when both prefixes are configured", (source) => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "openfars-github-secret-precedence-"));
    writeFileSync(path.join(directory, "client-secret"), "current-secret\n", { mode: 0o600 });
    try {
      vi.stubEnv("SCION_AR_GITHUB_OAUTH_CLIENT_ID", "legacy-client");
      vi.stubEnv("SCION_AR_GITHUB_OAUTH_CLIENT_SECRET", "legacy-secret");
      vi.stubEnv("SCION_AR_GITHUB_OAUTH_CALLBACK_URL", "https://legacy.example.test/api/github/auth/callback");
      vi.stubEnv("SCIENCEEVOLVE_GITHUB_OAUTH_CLIENT_ID", "current-client");
      vi.stubEnv(
        `SCIENCEEVOLVE_GITHUB_OAUTH_CLIENT_SECRET${source === "file" ? "_FILE" : ""}`,
        source === "file" ? "client-secret" : "current-secret"
      );
      vi.stubEnv("SCIENCEEVOLVE_GITHUB_OAUTH_CALLBACK_URL", "https://current.example.test/api/github/auth/callback");

      const config = loadConfig(directory);

      expect(config.githubOAuthClientId).toBe("current-client");
      expect(config.githubOAuthClientSecret).toBe("current-secret");
      expect(config.githubOAuthCallbackUrl).toBe("https://current.example.test/api/github/auth/callback");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("allows explicit empty new OAuth settings to disable legacy credentials", () => {
    for (const name of ["CLIENT_ID", "CLIENT_SECRET", "CALLBACK_URL"]) {
      vi.stubEnv(`SCION_AR_GITHUB_OAUTH_${name}`, "legacy-value");
      vi.stubEnv(`SCIENCEEVOLVE_GITHUB_OAUTH_${name}`, "");
    }
    vi.stubEnv("SCION_AR_GITHUB_OAUTH_CLIENT_SECRET_FILE", "missing-legacy-secret");

    const config = loadConfig(path.join(path.sep, "workspace", "scienceevolve"));

    expect(config.githubOAuthClientId).toBeUndefined();
    expect(config.githubOAuthClientSecret).toBeUndefined();
    expect(config.githubOAuthCallbackUrl).toBeUndefined();
  });

  it("does not hide an invalid new secret file behind old inline credentials", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "openfars-github-empty-secret-"));
    writeFileSync(path.join(directory, "client-secret"), "\n", { mode: 0o600 });
    try {
      vi.stubEnv("SCION_AR_GITHUB_OAUTH_CLIENT_SECRET", "legacy-secret");
      vi.stubEnv("SCIENCEEVOLVE_GITHUB_OAUTH_CLIENT_SECRET_FILE", "client-secret");

      expect(() => loadConfig(directory)).toThrow(/SCIENCEEVOLVE_GITHUB_OAUTH_CLIENT_SECRET_FILE.*为空/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("preserves other server settings from the old prefix and prefers explicit new values", () => {
    const root = path.join(path.sep, "workspace", "scienceevolve");
    vi.stubEnv("SCION_AR_DATA_DIR", "legacy-data");
    vi.stubEnv("SCION_AR_INSPIRE_BIN", "legacy-inspire");
    vi.stubEnv("SCION_AR_RETRY_BASE_MS", "3000");

    const legacy = loadConfig(root);
    expect(legacy.dataDir).toBe(path.join(root, "legacy-data"));
    expect(legacy.inspireBin).toBe("legacy-inspire");
    expect(legacy.retryBaseMs).toBe(3000);

    vi.stubEnv("SCIENCEEVOLVE_DATA_DIR", "current-data");
    vi.stubEnv("SCIENCEEVOLVE_INSPIRE_BIN", "current-inspire");
    vi.stubEnv("SCIENCEEVOLVE_RETRY_BASE_MS", "4000");

    const current = loadConfig(root);
    expect(current.dataDir).toBe(path.join(root, "current-data"));
    expect(current.inspireBin).toBe("current-inspire");
    expect(current.retryBaseMs).toBe(4000);
  });

  it("never turns a missing read-only Explainer backend into danger-full-access", async () => {
    await expect(resolveExplainerSandboxConfiguration({
      env: {}
    })).resolves.toEqual({
      verified: false,
      unavailableReason: "宿主快照隔离包装与边界探针尚未实现"
    });
  });

  it("does not claim host snapshot isolation merely because a sandbox binary may exist", async () => {
    await expect(resolveExplainerSandboxConfiguration({
      env: { SCIENCEEVOLVE_EXPLAINER_SANDBOX_MODE: "read-only" }
    })).resolves.toEqual({
      mode: "read-only",
      verified: false,
      unavailableReason: "宿主快照隔离包装与边界探针尚未实现"
    });
  });

  it("preserves a dangerous legacy Explainer setting only as an explicit rejection", async () => {
    await expect(resolveExplainerSandboxConfiguration({
      env: { SCIENCEEVOLVE_EXPLAINER_SANDBOX_MODE: "danger-full-access" }
    })).resolves.toEqual({
      mode: "danger-full-access",
      verified: false,
      unavailableReason: "Project Explainer 禁止使用 danger-full-access"
    });
  });
});
