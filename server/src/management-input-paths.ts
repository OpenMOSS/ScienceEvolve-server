import path from "node:path";

/** Server input snapshots are outside all versioned Agent workspaces. */
export function managementInputRoot(projectPath: string, agent: string, invocationId: string): string {
  for (const value of [agent, invocationId]) {
    if (!value || value === "." || value === ".." || path.basename(value) !== value || /[\\\0]/.test(value))
      throw new Error("Management input identity is invalid");
  }
  return path.join(projectPath, "agent-inputs", agent, "management", invocationId);
}

export function isManagementProposal(projectPath: string, workspacePath: string, agent: string,
  proposal: string): boolean {
  const input = path.relative(path.join(projectPath, "agent-inputs", agent, "management"), proposal).split(path.sep).join("/");
  const legacy = path.relative(path.join(workspacePath, ".scienceevolve", "management"), proposal).split(path.sep).join("/");
  return [input, legacy].some(relative => /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}\/proposal\/workflow\.json$/.test(relative));
}
