import { promises as fs } from "node:fs";
import path from "node:path";
import {
  parse,
  TomlDate,
  type TomlTable,
  type TomlValue
} from "smol-toml";

export interface CodexProviderSettings {
  modelProvider?: string;
  /** Safe fallback overrides used only when no invocation route is present. */
  configOverrides: string[];
  /** Host preferences that remain applicable to an invocation-local route. */
  routeConfigOverrides: string[];
  environmentKeys: string[];
}

const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export async function loadCodexProviderSettings(
  codexHome: string | undefined
): Promise<CodexProviderSettings> {
  if (!codexHome) return emptyProviderSettings();

  const configPath = path.join(codexHome, "config.toml");
  let source: string;
  try {
    source = await fs.readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyProviderSettings();
    }
    throw new Error(`Unable to read Codex provider config at ${configPath}`, {
      cause: error
    });
  }

  let config: TomlTable;
  try {
    config = parse(source);
  } catch (error) {
    throw new Error(`Unable to parse Codex provider config at ${configPath}`, {
      cause: error
    });
  }

  const rawProvider = config.model_provider;
  if (rawProvider === undefined) return emptyProviderSettings();
  if (typeof rawProvider !== "string" || rawProvider.trim() === "") {
    throw new Error(
      `Codex model_provider must be a non-empty string in ${configPath}`
    );
  }
  const modelProvider = rawProvider.trim();
  const rawServiceTier = config.service_tier;
  if (
    rawServiceTier !== undefined &&
    (typeof rawServiceTier !== "string" || rawServiceTier.trim() === "")
  ) {
    throw new Error(
      `Codex service_tier must be a non-empty string in ${configPath}`
    );
  }
  const serviceTier = rawServiceTier?.trim();

  const rawProviders = config.model_providers;
  if (rawProviders !== undefined && !isTomlTable(rawProviders)) {
    throw new Error(`Codex model_providers must be a table in ${configPath}`);
  }

  const selectedProvider = rawProviders?.[modelProvider];
  if (selectedProvider !== undefined && !isTomlTable(selectedProvider)) {
    throw new Error(
      `Codex model_providers.${modelProvider} must be a table in ${configPath}`
    );
  }

  // Never serialize the host provider table verbatim. Codex accepts literal
  // bearer tokens, headers and query parameters in that table; putting the
  // raw table in `-c` would expose those credentials through the child argv.
  // Only fields that are either public connection metadata or names of
  // environment variables cross that boundary.
  const selectedProviders: TomlTable | undefined = selectedProvider
    ? { [modelProvider]: argvSafeProvider(selectedProvider) }
    : undefined;
  const routeConfigOverrides = serviceTier
    ? [`service_tier=${tomlValue(serviceTier)}`]
    : [];
  return {
    modelProvider,
    configOverrides: [
      `model_provider=${tomlValue(modelProvider)}`,
      ...(selectedProviders
        ? [`model_providers=${tomlValue(selectedProviders)}`]
        : []),
      ...routeConfigOverrides
    ],
    routeConfigOverrides,
    environmentKeys: providerEnvironmentKeys(selectedProvider)
  };
}

function emptyProviderSettings(): CodexProviderSettings {
  return {
    configOverrides: [],
    routeConfigOverrides: [],
    environmentKeys: []
  };
}

function argvSafeProvider(provider: TomlTable): TomlTable {
  const safe: TomlTable = {};
  copyString(provider, safe, "name");
  copyCredentialFreeUrl(provider, safe, "base_url");
  copyString(provider, safe, "wire_api");
  copyEnvironmentReference(provider, safe, "env_key");
  copyBoolean(provider, safe, "requires_openai_auth");
  copyNumber(provider, safe, "request_max_retries");
  copyNumber(provider, safe, "stream_max_retries");
  copyNumber(provider, safe, "stream_idle_timeout_ms");

  if (isTomlTable(provider.env_http_headers)) {
    const headers: TomlTable = {};
    for (const [header, environmentName] of Object.entries(
      provider.env_http_headers
    )) {
      if (
        HEADER_NAME.test(header) &&
        typeof environmentName === "string" &&
        ENVIRONMENT_NAME.test(environmentName)
      ) {
        headers[header] = environmentName;
      }
    }
    if (Object.keys(headers).length > 0) safe.env_http_headers = headers;
  }
  return safe;
}

function copyString(source: TomlTable, target: TomlTable, key: string): void {
  const value = source[key];
  if (typeof value === "string" && !/[\0\r\n]/.test(value)) {
    target[key] = value;
  }
}

function copyCredentialFreeUrl(
  source: TomlTable,
  target: TomlTable,
  key: string
): void {
  const value = source[key];
  if (typeof value !== "string") return;
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash
    ) {
      target[key] = value;
    }
  } catch {
    // Invalid or non-URL provider endpoints are not safe argv metadata.
  }
}

function copyEnvironmentReference(
  source: TomlTable,
  target: TomlTable,
  key: string
): void {
  const value = source[key];
  if (typeof value === "string" && ENVIRONMENT_NAME.test(value)) {
    target[key] = value;
  }
}

function copyBoolean(source: TomlTable, target: TomlTable, key: string): void {
  const value = source[key];
  if (typeof value === "boolean") target[key] = value;
}

function copyNumber(source: TomlTable, target: TomlTable, key: string): void {
  const value = source[key];
  if (
    (typeof value === "number" && Number.isFinite(value)) ||
    typeof value === "bigint"
  ) {
    target[key] = value;
  }
}

function providerEnvironmentKeys(
  provider: TomlTable | undefined
): string[] {
  if (!provider) return [];
  const candidates: unknown[] = [provider.env_key];
  if (isTomlTable(provider.env_http_headers)) {
    candidates.push(...Object.values(provider.env_http_headers));
  }
  return [
    ...new Set(
      candidates.filter(
        (value): value is string =>
          typeof value === "string" &&
          ENVIRONMENT_NAME.test(value)
      )
    )
  ];
}

function isTomlTable(value: unknown): value is TomlTable {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  );
}

function tomlValue(value: TomlValue): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "nan";
    if (value === Number.POSITIVE_INFINITY) return "inf";
    if (value === Number.NEGATIVE_INFINITY) return "-inf";
    if (Object.is(value, -0)) return "-0";
    return String(value);
  }
  if (value instanceof TomlDate) return value.toISOString();
  if (Array.isArray(value)) {
    return `[${value.map((item) => tomlValue(item)).join(", ")}]`;
  }
  return `{ ${Object.entries(value)
    .map(([key, item]) => `${tomlKey(key)} = ${tomlValue(item)}`)
    .join(", ")} }`;
}

function tomlKey(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : JSON.stringify(value);
}
