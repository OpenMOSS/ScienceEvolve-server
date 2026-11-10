#!/usr/bin/env bash
# Enter an administrator-provided cgroup before starting the requested process.
set -euo pipefail
if [[ "$#" -lt 2 ]]; then
  echo "Usage: run-in-cpu-group.sh CGROUP COMMAND [ARG ...]" >&2
  exit 64
fi
cpu_group="$1"
shift
if [[ ! -f "$cpu_group/cpu.max" || ! -f "$cpu_group/cgroup.procs" || ! -w "$cpu_group/cgroup.procs" ]]; then
  echo "CPU group must exist, expose cpu.max and permit process membership: $cpu_group" >&2
  exit 78
fi
printf '%s\n' "$$" > "$cpu_group/cgroup.procs"
exec "$@"
