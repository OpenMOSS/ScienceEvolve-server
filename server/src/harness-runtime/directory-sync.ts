import { closeSync, constants, fsyncSync, openSync, promises as fs } from "node:fs";

// Flush the regular file before publishing it on every platform. Windows
// does not support libuv fsync on directory handles; skipping that operation
// does not skip the preceding file flush or atomic rename.
export async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try { await handle.sync(); } finally { await handle.close(); }
}

export function syncDirectorySync(directory: string): void {
  if (process.platform === "win32") return;
  const handle = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(handle); } finally { closeSync(handle); }
}
