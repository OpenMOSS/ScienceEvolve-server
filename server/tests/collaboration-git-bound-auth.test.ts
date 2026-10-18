import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExecFileGitCommandRunner } from "../src/collaboration-git/command-runner.js";
import { createCollaborationGitFacade } from "../src/collaboration-git/factory.js";
import { LocalCollaborationGitService } from "../src/collaboration-git/local-git.js";
import { GitHubAuthorizationError, GitOwnershipStaleError } from "../src/collaboration-git/errors.js";
import type { CollaborationGitOperationStore, GitHubCredentialResolver, GitExecutionAuthority } from "../src/collaboration-git/contracts.js";
import type { OperationRecord } from "../src/types.js";

const run = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
const tokens = ["bound=alice/fixture+token", "bound-bob-fixture-token", "bound-refreshed-fixture-token"];
const credential = (token = tokens[0]) => ({ token, requestedScopes: ["repo"] });
const pushArgs = (branch = "main") => ["push", "--porcelain", "origin", `refs/heads/${branch}:refs/heads/${branch}`];
const fetchArgs = (branch = "main") => ["fetch", "--no-tags", "--no-write-fetch-head", "origin", `refs/heads/${branch}:refs/openfars/sync/${branch}`];

async function fixture(mode: "normal" | "diagnostic" | "factory" = "normal") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openfars-bound-git-")); roots.push(root);
  const script = path.join(root, "git");
  const marker = path.join(root, "spawned.json");
  const source = String.raw`#!${process.execPath}
    const { spawnSync } = require('node:child_process');
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    const command = args[0] === '-c' ? args[2] : args[0];
    const git = input => spawnSync('/usr/bin/git', input, { encoding: 'utf8', env: process.env });
    if (command === 'remote' && args.includes('get-url')) {
      process.stdout.write('https://github.com/example/openfars.git\n'); process.exit(0);
    }
    if (!['push','fetch'].includes(command)) {
      const result = git(args); process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exit(result.status ?? 1);
    }
    fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ command, argv: args }));
    const resolved = git(['config','--get-urlmatch','http.extraHeader','https://github.com/example/openfars.git']).stdout.trim();
    const foreign = git(['config','--get-urlmatch','http.extraHeader','https://example.net/openfars.git']).stdout.trim();
    const allowed = ${JSON.stringify(tokens)}.map(token => 'Authorization: Basic ' + Buffer.from('x-access-token:' + token).toString('base64'));
    const expected = args.at(-1).includes('bob') ? allowed[1] : args.at(-1).includes('refreshed') ? allowed[2] : allowed[0];
    if (resolved !== expected || foreign || args.some(arg => allowed.includes(arg) || ${JSON.stringify(tokens)}.some(token => arg.includes(token)))) {
      process.stderr.write('fatal: could not read Username; bound Git command has no private credential'); process.exit(128);
    }
    if (${JSON.stringify(mode)} === 'diagnostic') {
      const token = Buffer.from(resolved.split(' ').at(-1), 'base64').toString().slice('x-access-token:'.length);
      process.stdout.write('raw=' + token + '; encoded=' + encodeURIComponent(token));
      process.stderr.write('failed ' + resolved + '; raw=' + token); process.exit(128);
    }
    if (${JSON.stringify(mode)} === 'factory') {
      const refspec = args.at(-1); const [source, target] = refspec.split(':');
      const head = git(['rev-parse', source]).stdout.trim();
      fs.writeFileSync(require('node:path').join(process.cwd(), 'published-ref.json'), JSON.stringify({ head, target }));
    }
    process.stdout.write('authenticated private Git command\n');
  `;
  await fs.writeFile(script, source, { mode: 0o700 });
  return { root, script, marker };
}

describe("project-account-bound local Git authentication", () => {
  it.each(["push", "fetch"])("authenticates %s through real Git URL config without repository changes, secret argv or host/Agent environment changes", async command => {
    const f = await fixture();
    await run("/usr/bin/git", ["init", "--bare", f.root]);
    const original = await fs.readFile(path.join(f.root, "config"));
    const resolver = vi.fn(async () => credential());
    const runner = new ExecFileGitCommandRunner({ gitBinary: f.script, credentialResolver: resolver });
    const environmentBefore = { ...process.env };
    const request = { cwd: f.root, args: command === "push" ? pushArgs() : fetchArgs(), environment: {} };
    const before = structuredClone(request);
    expect((await runner.run(request)).stdout).toContain("authenticated private Git command");
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(request).toEqual(before); expect(process.env).toEqual(environmentBefore);
    expect(await fs.readFile(path.join(f.root, "config"))).toEqual(original);
    const argv = JSON.parse(await fs.readFile(f.marker, "utf8")).argv;
    for (const token of tokens) expect(JSON.stringify(argv)).not.toContain(token);
  });

  it("keeps concurrent project accounts independent and resolves refreshed credentials per network command", async () => {
    const f = await fixture();
    let calls = 0;
    const alice = vi.fn(async () => credential(tokens[calls++ === 0 ? 0 : 2]));
    const bob = vi.fn(async () => credential(tokens[1]));
    const a = new ExecFileGitCommandRunner({ gitBinary: f.script, credentialResolver: alice });
    const b = new ExecFileGitCommandRunner({ gitBinary: f.script, credentialResolver: bob });
    const results = await Promise.all([a.run({ cwd: f.root, args: pushArgs("alice") }),
      b.run({ cwd: f.root, args: fetchArgs("bob") })]);
    expect(results.every(result => result.code === 0)).toBe(true);
    expect((await a.run({ cwd: f.root, args: pushArgs("refreshed") })).code).toBe(0);
    expect(alice).toHaveBeenCalledTimes(2); expect(bob).toHaveBeenCalledTimes(1);
  });

  it("does not resolve credentials for local work and rejects caller-supplied credential environment before resolving", async () => {
    const f = await fixture();
    await run("/usr/bin/git", ["init", "--bare", f.root]);
    const resolver = vi.fn(async () => credential());
    const runner = new ExecFileGitCommandRunner({ gitBinary: f.script, credentialResolver: resolver });
    expect((await runner.run({ cwd: f.root, args: ["rev-parse", "--is-bare-repository"] })).stdout.trim()).toBe("true");
    await expect(runner.run({ cwd: f.root, args: pushArgs(),
      environment: { GIT_CONFIG_VALUE_0: tokens[1] } })).rejects.toThrow(/service allowlist/);
    await expect(runner.run({ cwd: f.root, args: ["push", "--force", "origin", "main"] })).rejects.toThrow(/forbidden/);
    expect(resolver).not.toHaveBeenCalled();
  });

  it.each(["empty", "newline", "scope"])("refuses %s credentials before starting Git without falling back to a different helper", async mode => {
    const f = await fixture();
    const resolver = vi.fn(async () => mode === "scope" ? { token: tokens[0], requestedScopes: ["repo", "workflow"] }
      : credential(mode === "empty" ? "" : tokens[0] + "\nextra"));
    const runner = new ExecFileGitCommandRunner({ gitBinary: f.script, credentialResolver: resolver });
    await expect(runner.run({ cwd: f.root, args: pushArgs() })).rejects.toBeInstanceOf(GitHubAuthorizationError);
    expect(await fs.stat(f.marker).catch(() => undefined)).toBeUndefined();
  });

  it("redacts raw, encoded and Basic credentials from command results, public errors and their causes", async () => {
    const f = await fixture("diagnostic");
    const runner = new ExecFileGitCommandRunner({ gitBinary: f.script, credentialResolver: async () => credential() });
    const request = { cwd: f.root, args: pushArgs() };
    const result = await runner.run({ ...request, acceptedExitCodes: [128] });
    const error = await runner.run(request).catch(error => error);
    const diagnostics = JSON.stringify([result, error.publicData, error.message, error.cause?.message, error.cause?.stack]);
    expect(diagnostics).toContain("[REDACTED]");
    for (const secret of [tokens[0], encodeURIComponent(tokens[0]), Buffer.from('x-access-token:' + tokens[0]).toString('base64')])
      expect(diagnostics).not.toContain(secret);
    expect(error).toMatchObject({ code: "GIT_COMMAND_FAILED", exitCode: 128, publicData: { command: "push" } });
  });

  it("rechecks exact ownership after resolving credentials and stops a cancelled launch before spawning", async () => {
    const f = await fixture(); const controller = new AbortController();
    const runner = new ExecFileGitCommandRunner({ gitBinary: f.script, credentialResolver: async () => credential() });
    const guard = vi.fn(async () => { throw new GitOwnershipStaleError("exec-retained", 2); });
    await expect(runner.run({ cwd: f.root, args: pushArgs(), beforeSpawn: guard })).rejects.toBeInstanceOf(GitOwnershipStaleError);
    expect(guard).toHaveBeenCalledOnce();
    const cancelled = new ExecFileGitCommandRunner({ gitBinary: f.script, credentialResolver: async () => { controller.abort(); return credential(); } });
    await expect(cancelled.run({ cwd: f.root, args: pushArgs(), signal: controller.signal })).rejects.toThrow();
    expect(await fs.stat(f.marker).catch(() => undefined)).toBeUndefined();
  });

  it("does not return a credential resolver's secret-bearing failure or start Git", async () => {
    const f = await fixture();
    const runner = new ExecFileGitCommandRunner({ gitBinary: f.script, credentialResolver: async () => { throw new Error(tokens[0]); } });
    const error = await runner.run({ cwd: f.root, args: pushArgs() }).catch(error => error);
    expect(error).toBeInstanceOf(GitHubAuthorizationError);
    expect(JSON.stringify([error.message, error.publicData, error.cause])).not.toContain(tokens[0]);
    expect(await fs.stat(f.marker).catch(() => undefined)).toBeUndefined();
  });

  it.each(["owner", "branch", "retained-owner", "retained-journal"])("rejects a %s change during authentication in the actual local Git service before any network child starts", async mode => {
    const f = await fixture(); const projectId = "p"; const projectRoot = path.join(f.root, projectId);
    const records = new Map<string, OperationRecord>(); let active = true;
    const store: CollaborationGitOperationStore = {
      recordedOperation: async id => structuredClone(records.get(id)),
      prepare: async record => { records.set(record.id, structuredClone(record)); return record; },
      transition: async transition => { const next = { ...records.get(transition.id)!, ...transition }; records.set(transition.id, next); return next; },
      assertExecutionOwnership: async () => { if (!active) throw new Error("Original owner was revoked"); },
      recordMergedSynchronization: async () => undefined, checkpointInitialization: async () => undefined
    };
    let service: LocalCollaborationGitService; let execution: GitExecutionAuthority;
    const resolver = vi.fn(async () => {
      if (mode.includes("owner")) active = false;
      else if (mode === "retained-journal") records.set("retained-push", { ...records.get("retained-push")!, status: "finalized" });
      else {
        await run("/usr/bin/git", ["-C", execution.worktreePath, "-c", "user.name=fixture", "-c", "user.email=fixture@localhost",
          "commit", "--allow-empty", "-m", "Agent changed its branch during authorization"]);
      }
      return credential();
    });
    service = new LocalCollaborationGitService({ projectId, projectRoot, operationStore: store,
      runner: new ExecFileGitCommandRunner({ gitBinary: f.script, credentialResolver: resolver }) });
    const main = await service.initializeMain({ title: "auth race", operationId: "init-auth-race" });
    await service.configureOrigin("https://github.com/example/openfars.git");
    execution = { id: "e", agentId: "worker", purpose: "delivery", ownershipEpoch: 2,
      executionBranch: service.deliveryBranch("e"), worktreePath: service.canonicalWorktree("e") };
    const checkout = await service.createDeliveryWorktree(execution, 2, { kind: "main" });
    records.set("retained-push", { id: "retained-push", kind: "git.push", ownerExecutionId: execution.id, ownershipEpoch: 2,
      payloadHash: "original-payload", status: "prepared", expectedHead: checkout.head, expectedBase: execution.executionBranch });
    expect(resolver).not.toHaveBeenCalled();
    const pending = mode.startsWith("retained")
      ? service.pushRetainedExecution(execution, 2, "retained-push", checkout.head)
      : service.pushExecution(execution, 2);
    if (mode.includes("owner")) await expect(pending).rejects.toBeInstanceOf(GitOwnershipStaleError);
    else await expect(pending).rejects.toThrow(mode === "branch" ? /branch moved during credential resolution/ : /authorization changed during credential resolution/);
    expect(resolver).toHaveBeenCalledOnce();
    expect(await fs.stat(f.marker).catch(() => undefined)).toBeUndefined();
    expect((await run("/usr/bin/git", ["--git-dir", service.repositoryPath, "rev-parse", "refs/heads/main"])).stdout.trim()).toBe(main.head);
  });

  it.each([false, true])("wires the project-bound account into production facade Git push and preserves pre-spawn auth rejection as prepared (reject=%s)", async reject => {
    const f = await fixture("factory"); const projectId = "p"; const projectRoot = path.join(f.root, projectId);
    const repo = path.join(projectRoot, "repository"); const seed = path.join(f.root, "seed");
    await fs.mkdir(projectRoot); await run("/usr/bin/git", ["init", "--bare", repo]);
    await run("/usr/bin/git", ["init", seed]);
    await run("/usr/bin/git", ["-C", seed, "-c", "user.name=fixture", "-c", "user.email=fixture@localhost", "commit", "--allow-empty", "-m", "seed"]);
    const head = (await run("/usr/bin/git", ["-C", seed, "rev-parse", "HEAD"])).stdout.trim();
    await run("/usr/bin/git", ["-C", seed, "push", repo, "HEAD:refs/heads/main"]);
    await run("/usr/bin/git", ["--git-dir", repo, "symbolic-ref", "HEAD", "refs/heads/main"]);
    await run("/usr/bin/git", ["--git-dir", repo, "remote", "add", "origin", "https://github.com/example/openfars.git"]);
    const records = new Map<string, OperationRecord>();
    const store: CollaborationGitOperationStore = { prepare: async record => { records.set(record.id, record); return record; },
      transition: async transition => { const next = { ...records.get(transition.id)!, ...transition }; records.set(transition.id, next); return next; },
      assertExecutionOwnership: async () => undefined, recordMergedSynchronization: async () => undefined,
      checkpointInitialization: async () => undefined };
    vi.stubEnv("PATH", f.root + path.delimiter + process.env.PATH);
    const resolver: GitHubCredentialResolver = vi.fn(async () => credential());
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/user')) return new Response(JSON.stringify({ id: 1, login: 'example' }));
      const ref = decodeURIComponent(url.split('/git/ref/')[1] ?? '');
      const published = await fs.readFile(path.join(repo, 'published-ref.json'), 'utf8').then(JSON.parse).catch(() => undefined);
      if (ref === 'heads/main') return new Response(JSON.stringify({ ref: 'refs/heads/main', object: { sha: head } }));
      if (published) return new Response(JSON.stringify({ ref: published.target, object: { sha: published.head } }));
      return new Response('{}', { status: 404 });
    });
    const facade = createCollaborationGitFacade({ projectId, projectRoot, operationStore: store,
      credentialResolver: resolver, expectedIdentity: { id: 1, login: 'example' }, fetch });
    if (reject) {
      const original = ExecFileGitCommandRunner.prototype.run;
      vi.spyOn(ExecFileGitCommandRunner.prototype, 'run').mockImplementation(function (request) {
        return request.args[0] === 'push' ? Promise.reject(new GitHubAuthorizationError(403, 'Account no longer permits this command')) : original.call(this, request);
      });
    }
    const repository = { provider: 'github' as const, providerId: 1, owner: 'example', name: 'openfars', private: true,
      defaultBranch: 'main', htmlUrl: 'https://github.com/example/openfars', cloneUrl: 'https://github.com/example/openfars.git', observedAt: new Date().toISOString() };
    const request = { repository, groupRunId: 'G', baseCommit: head, integrationTarget: 'main', operationId: 'retained-group-birth' };
    if (reject) {
      await expect(facade.beginGroup(request)).rejects.toBeInstanceOf(GitHubAuthorizationError);
      expect(records.get(request.operationId)?.status).toBe('prepared');
      expect(await fs.stat(f.marker).catch(() => undefined)).toBeUndefined();
    } else {
      expect((await facade.beginGroup(request)).remote).toMatchObject({ status: 'present', ref: 'groups/G', sha: head });
      expect(records.get(request.operationId)?.status).toBe('finalized');
      expect(await fs.readFile(path.join(repo, 'config'), 'utf8')).not.toContain(tokens[0]);
      expect(JSON.stringify([...records.values()])).not.toContain(tokens[0]);
    }
  });
});
