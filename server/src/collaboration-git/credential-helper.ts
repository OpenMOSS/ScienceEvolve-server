import { spawn } from "node:child_process";
import type { GitHubCredential, GitHubCredentialResolver } from "./contracts.js";
import { GitHubAuthorizationError, GitInputError } from "./errors.js";

const MAX_CREDENTIAL_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const SAFE_ENVIRONMENT_KEYS = [
  "HOME",
  "PATH",
  "LANG",
  "LC_CTYPE",
  "XDG_CONFIG_HOME",
  "SYSTEMROOT",
  "WINDIR"
] as const;

export interface GitCredentialHelperResolverOptions {
  gitBinary?: string;
  host?: string;
  timeoutMs?: number;
  hostEnvironment?: Readonly<NodeJS.ProcessEnv>;
}

/**
 * Resolve an authenticated-user token through Git's installed credential
 * helper. The raw helper response is consumed only in this process and is
 * never copied into a diagnostic, project record, argv, or Agent environment.
 */
export function gitCredentialHelperResolver(
  options: GitCredentialHelperResolverOptions = {}
): GitHubCredentialResolver {
  const gitBinary = options.gitBinary ?? "git";
  const host = validateHost(options.host ?? "github.com");
  const timeoutMs = Math.max(500, Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 120_000));
  const hostEnvironment = options.hostEnvironment ?? process.env;
  return (signal) => resolveCredential({
    gitBinary,
    host,
    timeoutMs,
    hostEnvironment,
    signal
  });
}

async function resolveCredential(input: {
  gitBinary: string;
  host: string;
  timeoutMs: number;
  hostEnvironment: Readonly<NodeJS.ProcessEnv>;
  signal?: AbortSignal;
}): Promise<GitHubCredential> {
  if (input.signal?.aborted) {
    throw new GitHubAuthorizationError(401, "GitHub credential resolution was cancelled");
  }
  const environment: NodeJS.ProcessEnv = {
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
    LC_ALL: "C"
  };
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    const value = input.hostEnvironment[key];
    if (value !== undefined) environment[key] = value;
  }

  return new Promise<GitHubCredential>((resolve, reject) => {
    const child = spawn(input.gitBinary, ["credential", "fill"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: environment,
      windowsHide: true,
      signal: input.signal
    });
    let stdout = Buffer.alloc(0);
    let oversized = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, input.timeoutMs);
    timer.unref();

    child.stdout.on("data", (chunk: Buffer) => {
      if (oversized) return;
      stdout = Buffer.concat([stdout, chunk]);
      if (stdout.byteLength > MAX_CREDENTIAL_OUTPUT_BYTES) {
        oversized = true;
        stdout.fill(0);
        stdout = Buffer.alloc(0);
        child.kill("SIGKILL");
      }
    });
    // Drain stderr without retaining it: credential helpers have historically
    // printed credential-adjacent diagnostics on failure.
    child.stderr.resume();
    child.stdin.on("error", () => {
      // A helper may close stdin before consuming the fixed request. Its exit
      // status remains the single fail-closed result; never surface EPIPE data.
    });
    child.once("error", () => {
      clearTimeout(timer);
      stdout.fill(0);
      reject(new GitHubAuthorizationError(401, "GitHub credential helper could not be started"));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (oversized || code !== 0 || signal !== null) {
        stdout.fill(0);
        reject(new GitHubAuthorizationError(401, "GitHub credential helper did not return a credential"));
        return;
      }
      try {
        const fields = parseCredential(stdout.toString("utf8"));
        const token = fields.get("password");
        if (!token || token.length > 8_192 || /[\0\r\n]/.test(token)) {
          throw new GitHubAuthorizationError(401, "GitHub credential helper returned no usable token");
        }
        if (fields.get("protocol") !== "https" || fields.get("host") !== input.host) {
          throw new GitHubAuthorizationError(401, "GitHub credential helper returned another host identity");
        }
        resolve({ token, requestedScopes: ["repo"] });
      } catch (error) {
        reject(error instanceof GitHubAuthorizationError
          ? error
          : new GitHubAuthorizationError(401, "GitHub credential helper returned malformed data"));
      } finally {
        stdout.fill(0);
      }
    });
    child.stdin.end(`protocol=https\nhost=${input.host}\n\n`, "utf8");
  });
}

function parseCredential(value: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const line of value.split(/\r?\n/)) {
    if (!line) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) throw new GitInputError("Credential helper response is malformed");
    const key = line.slice(0, separator);
    const field = line.slice(separator + 1);
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(key) || result.has(key) || field.includes("\0")) {
      throw new GitInputError("Credential helper response is malformed");
    }
    result.set(key, field);
  }
  return result;
}

function validateHost(value: string): string {
  const host = value.trim().toLowerCase();
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host)) {
    throw new GitInputError("Git credential host is invalid");
  }
  return host;
}
