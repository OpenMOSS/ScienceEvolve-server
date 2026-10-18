import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gitCredentialHelperResolver } from "../src/collaboration-git/credential-helper.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, {
    recursive: true,
    force: true
  })));
});

describe("gitCredentialHelperResolver", () => {
  it("returns only the token and fixed minimal requested scope", async () => {
    const helper = await fakeGit(`
      process.stdin.resume();
      process.stdin.on('end', () => process.stdout.write(
        'protocol=https\\nhost=github.com\\nusername=alice\\npassword=secret-with=equals\\n\\n'
      ));
    `);
    const credential = await gitCredentialHelperResolver({
      gitBinary: helper,
      hostEnvironment: { PATH: process.env.PATH }
    })();
    expect(credential).toEqual({
      token: "secret-with=equals",
      requestedScopes: ["repo"]
    });
    expect(credential).not.toHaveProperty("username");
  });

  it.each([
    ["wrong host", "protocol=https\\nhost=example.com\\npassword=secret-value\\n\\n"],
    ["duplicate token", "protocol=https\\nhost=github.com\\npassword=one\\npassword=two\\n\\n"],
    ["missing token", "protocol=https\\nhost=github.com\\nusername=alice\\n\\n"]
  ])("fails closed for %s without returning helper output", async (_label, output) => {
    const helper = await fakeGit(`
      process.stdin.resume();
      process.stdin.on('end', () => process.stdout.write(${JSON.stringify(output)}));
    `);
    await expect(gitCredentialHelperResolver({
      gitBinary: helper,
      hostEnvironment: { PATH: process.env.PATH }
    })()).rejects.toThrow(/credential helper/);
  });

  it("cancels or times out without exposing credential-adjacent stderr", async () => {
    const helper = await fakeGit(`
      process.stderr.write('password=must-never-escape\\n');
      setInterval(() => {}, 1000);
    `);
    await expect(gitCredentialHelperResolver({
      gitBinary: helper,
      timeoutMs: 500,
      hostEnvironment: { PATH: process.env.PATH }
    })()).rejects.not.toThrow(/must-never-escape/);
  });
});

async function fakeGit(source: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openfars-credential-helper-"));
  roots.push(root);
  const script = path.join(root, "git-fixture");
  await fs.writeFile(script, `#!${process.execPath}\n${source}\n`, { mode: 0o700 });
  return script;
}
