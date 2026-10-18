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
  readonly codes = new Map<string, {
    accessToken: string;
    refreshToken?: string;
    scope?: string;
    expiresIn?: number;
  }>();
  readonly identities = new Map<string, FakeIdentity>();
  readonly repositories = new Map<string, {
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
    private?: boolean;
    defaultBranch?: string;
  } = {}): void {
    this.repositories.set(`${owner}/${repository}`, {
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
      const token = new Headers(init.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
      if (!this.identities.has(token)) return this.response({ message: "Bad credentials" }, 401);
      const identity = decodeURIComponent(url.pathname.slice("/repos/".length));
      const repository = this.repositories.get(identity);
      if (!repository) return this.response({ message: "Not Found" }, 404);
      return this.response({
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
