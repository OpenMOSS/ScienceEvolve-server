import { execFile } from "node:child_process";
import path from "node:path";
import type {
  GitCommandRequest,
  GitCommandResult,
  GitCommandRunner,
  GitHubCredentialResolver
} from "./contracts.js";
import { containsCredentialMaterial, redactTrace } from "../utils.js";
import { GitCommandError, GitInputError } from "./errors.js";
import { resolveGitHubCredential } from "./credential.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const SAFE_ENVIRONMENT = [
  "HOME",
  "PATH",
  "LANG",
  "LC_CTYPE",
  "XDG_CONFIG_HOME",
  "SSH_AUTH_SOCK",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "GIT_SSL_CAINFO",
  "SYSTEMROOT",
  "WINDIR"
] as const;
const SERVICE_ENVIRONMENT = new Set([
  "GIT_OPTIONAL_LOCKS",
  "GIT_INDEX_FILE",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL"
]);
const ALLOWED_COMMANDS = new Set([
  "add",
  "cat-file",
  "check-ignore",
  "check-attr",
  "commit",
  "commit-tree",
  "config",
  "diff",
  "diff-tree",
  "fetch",
  "hash-object",
  "init",
  "log",
  "ls-files",
  "ls-tree",
  "merge",
  "merge-base",
  "merge-tree",
  "mktree",
  "push",
  "read-tree",
  "remote",
  "rev-parse",
  "revert",
  "restore",
  "show",
  "status",
  "switch",
  "symbolic-ref",
  "update-index",
  "update-ref",
  "worktree",
  "write-tree"
]);

export interface ExecFileGitCommandRunnerOptions {
  gitBinary?: string;
  timeoutMs?: number;
  maxBufferBytes?: number;
  hostEnvironment?: Readonly<NodeJS.ProcessEnv>;
  /** Server-only project account; never part of Agent request or Git argv. */
  credentialResolver?: GitHubCredentialResolver;
}

/** Remove credentials from every diagnostic before it can leave this package. */
export function redactGitDiagnostic(value: string): string {
  return redactTrace(value).slice(0, 16_000);
}

function assertFixedGitArguments(request: GitCommandRequest): void {
  const { args } = request;
  if (args.length === 0 || args.length > 64) {
    throw new GitInputError("Git command argument count is invalid");
  }
  for (const argument of args) {
    if (
      !argument ||
      argument.length > 8_192 ||
      argument.includes("\0") ||
      argument.includes("\n") ||
      argument.includes("\r")
    ) {
      throw new GitInputError("Git command contains an unsafe argument");
    }
  }
  const normalized = args.map((item) => item.toLowerCase());
  const command = normalized[0];
  if (!command || command.startsWith("-") || !ALLOWED_COMMANDS.has(command)) {
    throw new GitInputError("Git command is outside the fixed-operation allowlist");
  }
  if (request.completeOutput && !["diff", "show", "log", "ls-files", "status", "cat-file", "merge-base", "rev-parse", "symbolic-ref"].includes(command)) {
    throw new GitInputError("Complete output is restricted to fixed read operations");
  }
  const joined = normalized.join(" ");
  if (command === "revert") {
    const start = args[1] === "--no-commit" && args[2] === "--no-rerere-autoupdate" && (
      args.length === 4 && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(args[3]!) ||
      args.length === 6 && args[3] === "--mainline" && /^[1-9][0-9]*$/.test(args[4]!) && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(args[5]!));
    if (!start && !(args.length === 2 && args[1] === "--quit")) throw new GitInputError("Revert requires one exact target or operation-bound metadata cleanup");
  }
  if (command === "restore" && !(args.length >= 6 && /^--source=(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(args[1]!) &&
    args[2] === "--staged" && args[3] === "--worktree" && args[4] === "--" &&
    args.slice(5).every(file => !file.startsWith("/") && !/[\\\x00-\x1f\x7f:*?\[\]]/.test(file) &&
      file.split("/").every(part => part && part !== "." && part !== ".." && part.toLowerCase() !== ".git")))) {
    throw new GitInputError("Revert abort restoration requires an exact original commit and explicit operation paths");
  }
  const previewCheckout = args[3];
  const previewCleanup = request.previewCleanup === true &&
    command === "worktree" && args.length === 4 &&
    args[1] === "remove" && args[2] === "--force" &&
    path.basename(request.cwd) === "repository" &&
    typeof previewCheckout === "string" && path.isAbsolute(previewCheckout) &&
    path.basename(previewCheckout) === "checkout" &&
    /^preview-[A-Za-z0-9]{6}$/.test(path.basename(path.dirname(previewCheckout))) &&
    path.dirname(path.dirname(previewCheckout)) === path.join(path.dirname(request.cwd), "merge-previews");
  if (command === "config") {
    const sharedWorktreeConfig = args.length === 3 &&
      args[1] === "extensions.worktreeConfig" && args[2] === "true";
    const repositoryConfigPreparation = path.basename(request.cwd) === "repository" && (
      (args.length === 5 && args[1] === "--local" && args[2] === "--bool" &&
        args[3] === "--get" && args[4] === "extensions.worktreeConfig") ||
      (args.length === 5 && args[1] === "--file" && args[2] === "config.worktree" &&
        args[3] === "core.bare" && args[4] === "true") ||
      (args.length === 4 && args[1] === "--local" && args[2] === "--unset" && args[3] === "core.bare")
    );
    const worktreeSetting = args.length === 4 && args[1] === "--worktree" && (
      (args[2] === "user.name" && args[3]!.startsWith("OpenFARS Agent ")) ||
      (args[2] === "user.email" && /^openfars-agent\+[a-f0-9]{16}@localhost$/.test(args[3]!)) ||
      (args[2] === "user.useConfigOnly" && args[3] === "true") ||
      (args[2] === "commit.gpgSign" && args[3] === "false") ||
      (args[2] === "core.bare" && args[3] === "false") ||
      (args[2] === "core.hooksPath" && args[3] === "/dev/null")
    );
    if (!sharedWorktreeConfig && !repositoryConfigPreparation && !worktreeSetting) {
      throw new GitInputError("Git config command is outside the fixed identity allowlist");
    }
  }
  if (command === "diff-tree" && !(args.length === 9 &&
    args.slice(1, 6).join(" ") === "--no-commit-id -r --raw -z --no-renames" &&
    /^[0-9a-f]{40}$/i.test(args[6]!) && /^[0-9a-f]{40}$/i.test(args[7]!) && args[8] === "--")) {
    throw new GitInputError("Closing tree observation requires two exact commits and fixed raw diff options");
  }
  if (command === "check-attr" && !(args.length >= 5 && args.slice(1, 4).join(" ") === "-z filter --" &&
    args.slice(4).every(file => !file.startsWith("/") && !/[\\\x00-\x1f\x7f:*?\[\]]/.test(file) &&
      file.split("/").every(part => part && part !== "." && part !== ".." && part.toLowerCase() !== ".git")))) {
    throw new GitInputError("Closing filter observation requires fixed options and exact relative files");
  }
  if (command === "switch") {
    const branch = args[1] === "-c" ? args[2] : args[1];
    const ownedBranch = typeof branch === "string" &&
      /^(?:executions|groups)\/[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(branch) &&
      !branch.includes("..") && !branch.endsWith(".") && !branch.toLowerCase().endsWith(".lock");
    const existing = args.length === 2 && ownedBranch;
    const created = args.length === 4 && args[1] === "-c" && ownedBranch &&
      /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(args[3]!);
    if (!existing && !created) {
      throw new GitInputError("Git switch requires one owned branch and an optional exact base commit");
    }
  }
  if (
    normalized.some((item) =>
      (item === "--force" && !previewCleanup) ||
      item === "--force-with-lease" ||
      item.startsWith("--force=") ||
      item.startsWith("--force-with-lease=") ||
      item === "-d"
    ) || args.some((item) => item === "-f") ||
    joined.includes("-xours") ||
    joined.includes("-xtheirs") ||
    joined.includes("--ours") ||
    joined.includes("--theirs") ||
    joined.includes("strategy-option=ours") ||
    joined.includes("strategy-option=theirs") ||
    command === "clean" ||
    command === "gc" ||
    command === "prune" ||
    command === "rebase" ||
    (command === "reset" && normalized.includes("--hard")) ||
    (command === "worktree" && normalized.some((item) => item === "prune" || (item === "remove" && !previewCleanup)))
  ) {
    throw new GitInputError(
      "Destructive, forced, cleanup, and automatic ours/theirs Git operations are forbidden"
    );
  }
}

export class ExecFileGitCommandRunner implements GitCommandRunner {
  private readonly gitBinary: string;
  private readonly timeoutMs: number;
  private readonly maxBufferBytes: number;
  private readonly hostEnvironment: Readonly<NodeJS.ProcessEnv>;
  private readonly credentialResolver?: GitHubCredentialResolver;

  constructor(options: ExecFileGitCommandRunnerOptions = {}) {
    this.gitBinary = options.gitBinary ?? "git";
    this.timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 600_000));
    this.maxBufferBytes = Math.max(
      64 * 1024,
      Math.min(options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES, 64 * 1024 * 1024)
    );
    this.hostEnvironment = options.hostEnvironment ?? process.env;
    this.credentialResolver = options.credentialResolver;
  }

  async run(request: GitCommandRequest): Promise<GitCommandResult> {
    assertFixedGitArguments(request);
    request.signal?.throwIfAborted();
    if (!path.isAbsolute(request.cwd)) {
      throw new GitInputError("Git command cwd must be an absolute service path");
    }
    const environment: NodeJS.ProcessEnv = {
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "Never",
      GIT_PAGER: "cat",
      GIT_EDITOR: "true",
      LC_ALL: "C"
    };
    for (const key of SAFE_ENVIRONMENT) {
      if (this.hostEnvironment[key] !== undefined) {
        environment[key] = this.hostEnvironment[key];
      }
    }
    for (const [key, value] of Object.entries(request.environment ?? {})) {
      if (!SERVICE_ENVIRONMENT.has(key)) {
        throw new GitInputError("Git command environment key is outside the service allowlist");
      }
      if (value.includes("\0") || value.includes("\n") || value.includes("\r") || value.length > 4_096) {
        throw new GitInputError("Git command environment value is unsafe");
      }
      if (key === "GIT_INDEX_FILE") {
        const resolved = path.resolve(value);
        const relative = path.relative(path.resolve(request.cwd), resolved);
        if (
          !path.isAbsolute(value) ||
          relative === "" ||
          relative === ".." ||
          relative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relative) ||
          !path.basename(resolved).startsWith("openfars-management-") ||
          !path.basename(resolved).endsWith(".index")
        ) {
          throw new GitInputError("Git index path is outside the fixed management namespace");
        }
      }
      environment[key] = value;
    }

    // Authentication serves the Agent's explicit tool request. The system
    // supplies transport and facts; it does not choose or retry business Git.
    const secrets: string[] = [];
    if (this.credentialResolver && ["push", "fetch"].includes(request.args[0]!)) {
      const push = request.args[0] === "push";
      const fixed = push
        ? request.args.length === 4 && request.args[1] === "--porcelain" && request.args[2] === "origin"
        : request.args.length === 5 && request.args[1] === "--no-tags" &&
          request.args[2] === "--no-write-fetch-head" && request.args[3] === "origin";
      if (!fixed) throw new GitInputError("Authenticated Git transport requires a fixed origin operation");
      // Git expands insteadOf/pushInsteadOf here. Reject unsafe effective URLs
      // before resolving a token, including multiple push destinations.
      const remote = await this.execute({
        cwd: request.cwd,
        args: ["remote", "get-url", ...(push ? ["--push"] : []), "--all", "origin"],
        signal: request.signal
      }, environment);
      const urls = remote.stdout.trim().split(/\r?\n/);
      const remoteUrl = urls[0]!;
      let url: URL;
      try { url = new URL(remoteUrl); } catch { throw new GitInputError("Git origin is not a GitHub HTTPS repository"); }
      if (urls.length !== 1 || url.protocol !== "https:" || url.hostname !== "github.com" ||
        url.port || url.username || url.password || url.search || url.hash ||
        !/^\/[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(url.pathname)) {
        throw new GitInputError("Git origin is not one GitHub HTTPS repository");
      }
      const credential = await resolveGitHubCredential(this.credentialResolver, request.signal);
      const basic = Buffer.from(`x-access-token:${credential.token}`, "utf8").toString("base64");
      secrets.push(credential.token, encodeURIComponent(credential.token), basic);
      // Process-only config: never put the credential in argv, remote URLs,
      // repository config, or Agent environments. Reset ambient credentials.
      const config = [
        ["credential.helper", ""],
        [`credential.${remoteUrl}.helper`, ""],
        [`http.${remoteUrl}.extraHeader`, ""],
        [`http.${remoteUrl}.extraHeader`, `Authorization: Basic ${basic}`],
        [`http.${remoteUrl}.sslVerify`, "true"],
        [`http.${remoteUrl}.followRedirects`, "false"]
      ];
      environment.GIT_CONFIG_COUNT = String(config.length);
      config.forEach(([key, value], index) => {
        environment[`GIT_CONFIG_KEY_${index}`] = key;
        environment[`GIT_CONFIG_VALUE_${index}`] = value;
      });
    }
    // Credential resolution and origin inspection can await other work.
    // Recheck the same Agent's authority and branch immediately before Git
    // starts, including cancellation received while authentication was pending.
    await request.beforeSpawn?.();
    request.signal?.throwIfAborted();
    return this.execute(request, environment, secrets);
  }

  private execute(
    request: GitCommandRequest,
    environment: NodeJS.ProcessEnv,
    secrets: readonly string[] = []
  ): Promise<GitCommandResult> {
    const accepted = new Set(request.acceptedExitCodes ?? [0]);
    const redact = (value: string): string => redactGitDiagnostic(
      secrets.reduce((safe, secret) => safe.split(secret).join("[REDACTED]"), value)
    );
    // Repository hooks are never part of a fixed OpenFARS Git operation.
    const args = ["-c", "core.hooksPath=/dev/null",
      ...(request.args[0] === "revert" ? ["-c", "rerere.enabled=false"] : []),
      ...(process.platform === "win32" ? ["-c", "core.longpaths=true"] : []),
      ...request.args];
    return new Promise<GitCommandResult>((resolve, reject) => {
      const child = execFile(
        this.gitBinary,
        args,
        {
          cwd: request.cwd,
          env: { ...environment },
          encoding: "utf8",
          timeout: this.timeoutMs,
          maxBuffer: this.maxBufferBytes,
          windowsHide: true,
          signal: request.signal
        },
        (error, stdout, stderr) => {
          if (request.completeOutput && (containsCredentialMaterial(stdout ?? "") || secrets.some(secret => (stdout ?? "").includes(secret)))) {
            reject(new GitInputError("Git read output contains credential material and cannot be disclosed"));
            return;
          }
          const code = typeof error?.code === "number" ? error.code : error ? null : 0;
          const result: GitCommandResult = {
            code: code ?? -1,
            stdout: request.completeOutput ? stdout ?? "" : redact(stdout ?? ""),
            stderr: redact(stderr ?? "")
          };
          if (!error && accepted.has(0)) {
            resolve(result);
            return;
          }
          if (code !== null && accepted.has(code)) {
            resolve({ ...result, code });
            return;
          }
          reject(
            new GitCommandError(
              code,
              request.signal?.aborted
                ? "Git command was cancelled"
                : `Git command failed${code === null ? "" : ` with exit code ${code}`}`,
              {
                command: request.args[0],
                stderr: result.stderr,
                cancelled: request.signal?.aborted === true
              },
              // execFile's error can contain raw stdout/stderr. Preserve a
              // sanitized cause only, before failure metadata walks the chain.
              error ? { cause: new Error(redact(error.message)) } : undefined
            )
          );
        }
      );
      if (request.stdin !== undefined) {
        child.stdin?.end(request.stdin, "utf8");
      }
    });
  }
}
