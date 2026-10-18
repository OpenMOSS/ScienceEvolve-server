import {readFileSync, readlinkSync, readdirSync} from 'node:fs';

// Exit codes: 0 exact live service; 1 absent/reused PID; 2 cannot verify.
// /proc can show host PIDs while process.kill uses namespace-local PIDs.
const pid = Number(process.argv[2]);
const entry = process.argv[3];
if (!Number.isSafeInteger(pid) || pid <= 1 || !entry) process.exit(1);
try {
  process.kill(pid, 0);
} catch (error) {
  process.exit(error.code === 'ESRCH' ? 1 : 2);
}
try {
  const namespace = readlinkSync('/proc/self/ns/pid');
  const rows = [...new Set([String(pid), ...readdirSync('/proc')])];
  for (const row of rows) {
    if (!/^\d+$/.test(row)) continue;
    try {
      if (readlinkSync(`/proc/${row}/ns/pid`) !== namespace) continue;
      const status = readFileSync(`/proc/${row}/status`, 'utf8');
      const ids = /^NSpid:\s+(.+)$/m.exec(status)?.[1].trim().split(/\s+/);
      if (Number(ids?.at(-1) ?? row) !== pid) continue;
      if (/^State:\s+Z\b/m.test(status)) process.exit(1);
      const command = readFileSync(`/proc/${row}/cmdline`, 'utf8').split('\0');
      process.exit(command[1] === entry ? 0 : 1);
    } catch (error) {
      if (!['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(error.code)) throw error;
    }
  }
} catch {
  process.exit(2);
}
process.exit(2);
