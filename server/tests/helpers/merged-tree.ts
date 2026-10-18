import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Produce a provider-style merge tree using commands available in Git 2.34. */
export async function mergedTreeFromBareRepo(
  repository: string,
  target: string,
  source: string
): Promise<string> {
  const command = async (cwd: string, args: string[]): Promise<string> => {
    const result = await execFileAsync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Fake Provider",
        GIT_AUTHOR_EMAIL: "provider@localhost",
        GIT_COMMITTER_NAME: "Fake Provider",
        GIT_COMMITTER_EMAIL: "provider@localhost"
      }
    });
    return result.stdout;
  };
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "openfars-merge-test-"));
  const checkout = path.join(temporary, "checkout");
  let attached = false;
  try {
    await command(repository, ["config", "extensions.worktreeConfig", "true"]);
    await command(repository, ["worktree", "add", "--detach", checkout, target]);
    attached = true;
    await command(checkout, ["config", "--worktree", "core.bare", "false"]);
    await command(checkout, ["merge", "--no-commit", "--no-ff", source]);
    return (await command(checkout, ["write-tree"])).trim();
  } finally {
    if (attached) await command(repository, ["worktree", "remove", "--force", checkout]);
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
