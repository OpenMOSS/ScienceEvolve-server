import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitHubAuthorizationError } from "../src/collaboration-git/errors.js";
import { GitHubAccountStore } from "../src/github-accounts.js";

const roots: string[] = [];
const callbackUrl = "https://openfars.example.test/api/github/auth/callback";

type FakeIdentity = { id: number; login: string; avatarUrl?: string; scopes?: string };

class FakeGitHubOAuth {
  readonly deletions: string[] = [];
  readonly repositoryRequests: { method: string; redirect?: RequestRedirect }[] = [];
  deleteStatus = 204;
  throwOnDelete = false;
  redirectRepository = false;
  readonly codes = new Map<string, {
    accessToken: string;
    refreshToken?: string;
    scope?: string;
    expiresIn?: number;
  }>();
  readonly identities = new Map<string, FakeIdentity>();
  readonly repositories = new Map<string, {
    id: number;
    ownerId: number;
    admin: boolean;
    htmlUrl: string;
    private: boolean;
    defaultBranch: string;
  }>();
  readonly tokenBodies: URLSearchParams[] = [];
  refreshAccessToken = "secret-refreshed";

  addAccount(code: string, token: string, identity: FakeIdentity, options: {
    refreshToken?: string;
    scope?: string;
    expiresIn?: number;
  } = {}): void {
    this.codes.set(code, {
      accessToken: token,
      refreshToken: options.refreshToken,
      scope: options.scope ?? "repo",
      expiresIn: options.expiresIn
    });
    this.identities.set(token, identity);
  }

  addRepository(owner: string, repository: string, options: {
    id?: number;
    ownerId?: number;
    admin?: boolean;
    private?: boolean;
    defaultBranch?: string;
  } = {}): void {
    this.repositories.set(`${owner}/${repository}`, {
      id: options.id ?? 100 + this.repositories.size, ownerId: options.ownerId ?? 7, admin: options.admin ?? true,
      htmlUrl: `https://github.com/${owner}/${repository}`,
      private: options.private ?? true,
      defaultBranch: options.defaultBranch ?? "main"
    });
  }

  readonly fetch: typeof globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL
      ? input.toString()
      : input.url);
    if (url.hostname === "github.com" && url.pathname === "/login/oauth/access_token") {
      const body = new URLSearchParams(String(init.body ?? ""));
      this.tokenBodies.push(body);
      if (body.get("grant_type") === "refresh_token") {
        this.identities.set(this.refreshAccessToken, {
          id: 7,
          login: "alice",
          scopes: "repo"
        });
        return this.response({
          access_token: this.refreshAccessToken,
          refresh_token: body.get("refresh_token"),
          scope: "repo",
          expires_in: 3_600
        });
      }
      const record = this.codes.get(body.get("code") ?? "");
      if (!record) return this.response({ error: "bad_verification_code" }, 401);
      return this.response({
        access_token: record.accessToken,
        ...(record.refreshToken ? { refresh_token: record.refreshToken } : {}),
        scope: record.scope ?? "",
        ...(record.expiresIn ? { expires_in: record.expiresIn } : {})
      });
    }
    if (url.hostname === "api.github.com" && url.pathname === "/user") {
      const token = new Headers(init.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
      const identity = this.identities.get(token);
      if (!identity) return this.response({ message: "Bad credentials" }, 401);
      return this.response({
        id: identity.id,
        login: identity.login,
        avatar_url: identity.avatarUrl
      }, 200, { "x-oauth-scopes": identity.scopes ?? "repo" });
    }
    if (url.hostname === "api.github.com" && url.pathname.startsWith("/repos/")) {
      this.repositoryRequests.push({ method: init.method ?? "GET", redirect: init.redirect });
      const token = new Headers(init.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
      if (!this.identities.has(token)) return this.response({ message: "Bad credentials" }, 401);
      const identity = decodeURIComponent(url.pathname.slice("/repos/".length));
      if (init.method === "DELETE") {
        this.deletions.push(identity);
        if (this.throwOnDelete) throw new Error("simulated connection failure");
        if (this.deleteStatus !== 204) return this.response({ message: "provider failure" }, this.deleteStatus);
        this.repositories.delete(identity); return new Response(null, { status: 204 });
      }
      if (this.redirectRepository) return new Response(null, { status: 307, headers: { location: "https://other.example.test/repository" } });
      const repository = this.repositories.get(identity);
      if (!repository) return this.response({ message: "Not Found" }, 404);
      return this.response({
        id: repository.id, name: identity.split("/")[1], owner: { id: repository.ownerId, login: identity.split("/")[0] }, permissions: { admin: repository.admin },
        html_url: repository.htmlUrl,
        private: repository.private,
        default_branch: repository.defaultBranch
      });
    }
    return this.response({ message: "not found" }, 404);
  };

  private response(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers }
    });
  }
}

async function root(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "openfars-github-accounts-"));
  roots.push(directory);
  return directory;
}

function stateFrom(url: string): string {
  const state = new URL(url).searchParams.get("state");
  if (!state) throw new Error("OAuth URL omitted state");
  return state;
}

function storeAt(directory: string, fake: FakeGitHubOAuth, now?: () => Date): GitHubAccountStore {
  return new GitHubAccountStore(directory, {
    oauth: {
      clientId: "client-id",
      clientSecret: "client-secret",
      callbackUrl
    },
    fetch: fake.fetch,
    now
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })
  ));
});

describe("GitHubAccountStore", () => {
  it("requests deletion scope only in a separate account-bound authorization and rejects the wrong GitHub identity", async () => {
    const fake = new FakeGitHubOAuth(), store = storeAt(await root(), fake);
    fake.addAccount("initial", "initial-token", { id: 7, login: "alice" });
    const initial = store.startAuthorization();
    expect(new URL(initial.authorizationUrl).searchParams.get("scope")).toBe("repo");
    const { account } = await store.completeAuthorization({ code: "initial", state: stateFrom(initial.authorizationUrl) });
    const authorize = await store.startRepositoryDeletionAuthorization(account.id);
    expect(new URL(authorize.authorizationUrl).searchParams.get("scope")).toBe("repo delete_repo");
    expect(new URL(authorize.authorizationUrl).searchParams.get("login")).toBe("alice");
    fake.addAccount("wrong", "wrong-token", { id: 9, login: "bob", scopes: "repo, delete_repo" }, { scope: "repo, delete_repo" });
    await expect(store.completeAuthorization({ code: "wrong", state: stateFrom(authorize.authorizationUrl) })).rejects.toThrow("所选 GitHub 账号");
    expect(await store.list()).toHaveLength(1);
    expect((await store.get(account.id))!.scopes).toEqual(["repo"]);
    const retry = await store.startRepositoryDeletionAuthorization(account.id);
    fake.addAccount("granted", "deletion-token", { id: 7, login: "alice", scopes: "repo, delete_repo" }, { scope: "repo, delete_repo" });
    const granted = await store.completeAuthorization({ code: "granted", state: stateFrom(retry.authorizationUrl) });
    expect(granted.account.scopes).toEqual(["repo", "delete_repo"]);
  });

  it("rejects a missing deletion grant without replacing the previous account credential", async () => {
    const fake = new FakeGitHubOAuth(), store = storeAt(await root(), fake);
    fake.addAccount("initial", "initial-token", { id: 7, login: "alice" });
    const start = store.startAuthorization();
    const { account } = await store.completeAuthorization({ code: "initial", state: stateFrom(start.authorizationUrl) });
    const request = await store.startRepositoryDeletionAuthorization(account.id);
    fake.addAccount("denied", "denied-token", { id: 7, login: "alice" });
    await expect(store.completeAuthorization({ code: "denied", state: stateFrom(request.authorizationUrl) })).rejects.toThrow("未授予 delete_repo");
    expect((await store.credentialResolver(account.id)()).token).toBe("initial-token");
    await expect(store.inspectRepositoryForDeletion(account.id, "alice", "demo")).rejects.toMatchObject({ status: 403 });
    expect(fake.deletions).toHaveLength(0);
  });

  it("revalidates repository identity and admin rights and never follows deletion redirects", async () => {
    const fake = new FakeGitHubOAuth(), store = storeAt(await root(), fake);
    fake.addAccount("granted", "deletion-token", { id: 7, login: "alice", scopes: "repo, delete_repo" }, { scope: "repo, delete_repo" });
    const start = store.startAuthorization();
    const { account } = await store.completeAuthorization({ code: "granted", state: stateFrom(start.authorizationUrl) });
    fake.addRepository("alice", "demo", { id: 101 });
    const target = await store.inspectRepositoryForDeletion(account.id, "alice", "demo");
    fake.addRepository("alice", "demo", { id: 202 });
    await expect(store.deleteRepository(account.id, target)).rejects.toThrow("仓库 ID 已变化");
    fake.addRepository("alice", "demo", { id: 101, admin: false });
    await expect(store.deleteRepository(account.id, target)).rejects.toThrow("管理员权限");
    fake.addRepository("alice", "demo", { id: 101, ownerId: 9 });
    await expect(store.deleteRepository(account.id, target)).rejects.toThrow("所属账号");
    fake.addRepository("alice", "demo", { id: 101 }); fake.redirectRepository = true;
    await expect(store.deleteRepository(account.id, target)).rejects.toThrow("移动或重命名");
    expect(fake.deletions).toHaveLength(0);
    fake.redirectRepository = false;
    await store.deleteRepository(account.id, target);
    expect(fake.deletions).toEqual(["alice/demo"]);
    expect(fake.repositoryRequests.every(request => request.redirect === "manual")).toBe(true);
    expect(JSON.stringify(target)).not.toContain("deletion-token");
  });

  it.each([403, 404, 500])("never reports a rejected or uncertain DELETE as successful (HTTP %s)", async status => {
    const fake = new FakeGitHubOAuth(), store = storeAt(await root(), fake);
    fake.addAccount("granted", "deletion-token", { id: 7, login: "alice", scopes: "repo, delete_repo" }, { scope: "repo, delete_repo" });
    const start = store.startAuthorization();
    const { account } = await store.completeAuthorization({ code: "granted", state: stateFrom(start.authorizationUrl) });
    fake.addRepository("alice", "demo", { id: 101 }); fake.deleteStatus = status;
    await expect(store.deleteRepository(account.id, { providerId: 101, owner: "alice", name: "demo" })).rejects.toMatchObject({
      status: status === 500 ? 502 : status,
      ...(status === 500 ? { code: "github_repository_deletion_uncertain" } : {})
    });
  });
  it("starts a state-bound PKCE flow with only the required repo scope", async () => {
    const directory = await root();
    const store = storeAt(directory, new FakeGitHubOAuth(), () => new Date("2026-09-24T08:00:00.000Z"));

    const start = store.startAuthorization("https://openfars.example.test");
    const authorization = new URL(start.authorizationUrl);

    expect(authorization.origin).toBe("https://github.com");
    expect(authorization.pathname).toBe("/login/oauth/authorize");
    expect(authorization.searchParams.get("client_id")).toBe("client-id");
    expect(authorization.searchParams.get("redirect_uri")).toBe(callbackUrl);
    expect(authorization.searchParams.get("scope")).toBe("repo");
    expect(authorization.searchParams.get("state")).toHaveLength(43);
    expect(authorization.searchParams.get("code_challenge")).toHaveLength(43);
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("prompt")).toBe("select_account");
    expect(start.expiresAt).toBe("2026-09-24T08:10:00.000Z");
    expect(store.authorizationOpenerOrigin(stateFrom(start.authorizationUrl)))
      .toBe("https://openfars.example.test");
    const noOriginHeader = store.startAuthorization();
    expect(store.authorizationOpenerOrigin(stateFrom(noOriginHeader.authorizationUrl)))
      .toBe("https://openfars.example.test");
    expect(() => store.startAuthorization("https://other.example.test"))
      .toThrow(/callback 所属/);

    const ipv6Store = new GitHubAccountStore(directory, {
      oauth: {
        clientId: "client-id",
        clientSecret: "client-secret",
        callbackUrl: "http://[::1]:4311/api/github/auth/callback"
      },
      fetch: new FakeGitHubOAuth().fetch
    });
    expect(ipv6Store.startAuthorization("http://[::1]:4311").authorizationUrl)
      .toContain("github.com/login/oauth/authorize");
  });

  it("stores two accounts concurrently without exposing or persisting plaintext tokens", async () => {
    const directory = await root();
    const fake = new FakeGitHubOAuth();
    fake.addAccount("alice-code", "secret-alice", {
      id: 7,
      login: "alice",
      avatarUrl: "https://avatars.githubusercontent.com/u/7?v=4"
    });
    fake.addAccount("bob-code", "secret-bob", { id: 9, login: "bob" });
    const store = storeAt(directory, fake);
    const aliceStart = store.startAuthorization("https://openfars.example.test");
    const bobStart = store.startAuthorization("https://openfars.example.test");

    const [aliceResult, bobResult] = await Promise.all([
      store.completeAuthorization({
        code: "alice-code",
        state: stateFrom(aliceStart.authorizationUrl)
      }),
      store.completeAuthorization({
        code: "bob-code",
        state: stateFrom(bobStart.authorizationUrl)
      })
    ]);

    const accounts = await store.list();
    expect(accounts).toHaveLength(2);
    expect(accounts.map((account) => account.login).sort()).toEqual(["alice", "bob"]);
    expect(accounts.find((account) => account.id === aliceResult.account.id)?.isDefault).toBe(true);
    expect(JSON.stringify(accounts)).not.toContain("secret-");

    const aliceReauthorization = store.startAuthorization("https://openfars.example.test");
    const reauthorizedAlice = await store.completeAuthorization({
      code: "alice-code",
      state: stateFrom(aliceReauthorization.authorizationUrl)
    });
    expect(reauthorizedAlice.account.id).toBe(aliceResult.account.id);
    expect(await store.list()).toHaveLength(2);

    await expect(store.credentialResolver(aliceResult.account.id)()).resolves.toEqual({
      token: "secret-alice",
      requestedScopes: ["repo"]
    });
    await expect(store.credentialResolver(bobResult.account.id)()).resolves.toEqual({
      token: "secret-bob",
      requestedScopes: ["repo"]
    });

    const persisted = await fs.readFile(path.join(directory, "github-accounts.json"), "utf8");
    expect(persisted).not.toContain("secret-alice");
    expect(persisted).not.toContain("secret-bob");
    // Windows stat modes do not represent POSIX permission bits.
    if (process.platform !== "win32") {
      expect((await fs.stat(path.join(directory, "github-accounts.json"))).mode & 0o777).toBe(0o600);
      expect((await fs.stat(path.join(directory, "github-accounts.key"))).mode & 0o777).toBe(0o600);
    }

    const reopened = storeAt(directory, fake);
    await expect(reopened.credentialResolver(aliceResult.account.id)()).resolves.toMatchObject({
      token: "secret-alice"
    });
    const updated = await reopened.setDefault(bobResult.account.id);
    expect(updated.isDefault).toBe(true);
    expect((await reopened.list()).find((account) => account.id === aliceResult.account.id)?.isDefault)
      .toBe(false);
  });

  it("refreshes only the credential belonging to the selected account", async () => {
    const directory = await root();
    const fake = new FakeGitHubOAuth();
    fake.addAccount("alice-code", "secret-alice", { id: 7, login: "alice" }, {
      refreshToken: "refresh-alice",
      expiresIn: 3_600
    });
    let clock = new Date("2026-09-24T08:00:00.000Z");
    const store = storeAt(directory, fake, () => clock);
    const start = store.startAuthorization("https://openfars.example.test");
    const result = await store.completeAuthorization({
      code: "alice-code",
      state: stateFrom(start.authorizationUrl)
    });

    clock = new Date("2026-09-24T09:01:00.000Z");
    await expect(store.requireReady(result.account.id)).resolves.toMatchObject({
      id: result.account.id,
      status: "ready"
    });
    await expect(store.credentialResolver(result.account.id)()).resolves.toEqual({
      token: "secret-refreshed",
      requestedScopes: ["repo"]
    });
    expect(fake.tokenBodies.at(-1)?.get("grant_type")).toBe("refresh_token");
    expect(fake.tokenBodies.at(-1)?.get("refresh_token")).toBe("refresh-alice");
    expect(await fs.readFile(path.join(directory, "github-accounts.json"), "utf8"))
      .not.toContain("secret-refreshed");
  });

  it("marks an account revoked when verification resolves to a different provider identity", async () => {
    const directory = await root();
    const fake = new FakeGitHubOAuth();
    fake.addAccount("alice-code", "secret-alice", { id: 7, login: "alice" });
    const store = storeAt(directory, fake);
    const start = store.startAuthorization("https://openfars.example.test");
    const result = await store.completeAuthorization({
      code: "alice-code",
      state: stateFrom(start.authorizationUrl)
    });
    fake.identities.set("secret-alice", { id: 99, login: "mallory" });

    await expect(store.verify(result.account.id)).rejects.toBeInstanceOf(GitHubAuthorizationError);
    await expect(store.requireReady(result.account.id)).rejects.toMatchObject({
      publicData: { status: 401 }
    });
    expect((await store.get(result.account.id))?.status).toBe("revoked");
  });

  it("accepts a renamed login when the stable provider user id is unchanged", async () => {
    const directory = await root();
    const fake = new FakeGitHubOAuth();
    fake.addAccount("alice-code", "secret-alice", { id: 7, login: "alice" });
    const store = storeAt(directory, fake);
    const start = store.startAuthorization("https://openfars.example.test");
    const result = await store.completeAuthorization({
      code: "alice-code",
      state: stateFrom(start.authorizationUrl)
    });
    fake.identities.set("secret-alice", { id: 7, login: "alice-renamed" });

    await expect(store.verify(result.account.id)).resolves.toMatchObject({
      status: "ready",
      login: "alice-renamed",
      providerUserId: 7
    });
  });

  it("distinguishes an available repository from one deleted on GitHub without exposing credentials", async () => {
    const directory = await root();
    const fake = new FakeGitHubOAuth();
    fake.addAccount("alice-code", "secret-alice", { id: 7, login: "alice" });
    fake.addRepository("alice", "active-project", { private: false, defaultBranch: "trunk" });
    const store = storeAt(directory, fake, () => new Date("2026-09-24T08:00:00.000Z"));
    const start = store.startAuthorization("https://openfars.example.test");
    const result = await store.completeAuthorization({
      code: "alice-code",
      state: stateFrom(start.authorizationUrl)
    });

    await expect(store.observeRepository(result.account.id, "alice", "active-project"))
      .resolves.toEqual({
        exists: true,
        observedAt: "2026-09-24T08:00:00.000Z",
        htmlUrl: "https://github.com/alice/active-project",
        private: false,
        defaultBranch: "trunk"
      });
    const deleted = await store.observeRepository(result.account.id, "alice", "deleted-project");
    expect(deleted).toEqual({ exists: false, observedAt: "2026-09-24T08:00:00.000Z" });
    expect(JSON.stringify(deleted)).not.toContain("secret-alice");
  });

  it("consumes cancelled and failed OAuth sessions and never stores under-scoped grants", async () => {
    const directory = await root();
    const fake = new FakeGitHubOAuth();
    fake.addAccount("under-scoped", "secret-read-user", {
      id: 7,
      login: "alice",
      scopes: "read:user"
    }, { scope: "read:user" });
    const store = storeAt(directory, fake);
    const cancelled = store.startAuthorization("https://openfars.example.test");
    const cancelledState = stateFrom(cancelled.authorizationUrl);

    expect(store.cancelAuthorization(cancelledState)).toBe("https://openfars.example.test");
    expect(store.authorizationOpenerOrigin(cancelledState)).toBeUndefined();
    await expect(store.completeAuthorization({ code: "unused", state: cancelledState }))
      .rejects.toMatchObject({ publicData: { status: 401 } });

    const failed = store.startAuthorization("https://openfars.example.test");
    const failedState = stateFrom(failed.authorizationUrl);
    await expect(store.completeAuthorization({ code: "under-scoped", state: failedState }))
      .rejects.toMatchObject({ publicData: { status: 403 } });
    expect(store.authorizationOpenerOrigin(failedState)).toBeUndefined();
    expect(await store.list()).toEqual([]);
  });

  it("fails closed instead of dropping records when the durable account store is corrupt", async () => {
    const directory = await root();
    await fs.writeFile(path.join(directory, "github-accounts.json"), JSON.stringify({
      schemaVersion: 1,
      accounts: [{ id: "broken" }]
    }));
    const store = storeAt(directory, new FakeGitHubOAuth());

    await expect(store.list()).rejects.toThrow("GitHub account store is invalid");
  });
});
