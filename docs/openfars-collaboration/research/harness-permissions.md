# Resident Harness, filesystem authority and memory research

[← Back to README](../../../README.md) · [中文首页](../../../README_zh-CN.md)

Research date: 2026-09-22 UTC
Baseline: `da25bdc4b264ef3bdd9bf1a6d140fba6c58d9ab2`
Installed versions: Codex `0.153.4`, Claude Code `2.1.263`, Pi `0.73.1`, DSH `0.1.2-rc.1`

## Gate interpretation and decision

R1 and R4 are **PASS for implementation research after independent re-audit**.
These are not claims that the baseline already complies.
The baseline product is **non-compliant**: it uses one-shot processes and
inconsistent permissions. It must not expose collaboration execution until the
new resident lease and authority checks pass on the integrated product.

The strict R1 run used each installed native CLI/app-server/SDK against a local
fake provider. For every Harness it observed two actual provider/model turns on
one host PID/startTicks identity, an idle interval, `SIGSTOP` as Linux process
state `T`, `SIGCONT` followed by turn two on the same identity, `SIGKILL`, and a
new PID/epoch continuing from a durable business boundary. This supersedes the
earlier no-model transport-only probe. Product acceptance must repeat the same
invariants through the integrated Adapter and cannot reuse this research result
as AC15/16/18/20 product evidence.

## Baseline lifecycle matrix

| Harness | Native resident entry available | Current OpenFARS behavior | Required implementation |
| --- | --- | --- | --- |
| Codex | `app-server` JSON-RPC, thread/turn start, steer/interrupt and loaded-thread subscription. | `codex exec`/`exec resume`; stdin closes and the process exits after every turn. | One app-server lease with a loaded thread per execution; keep it subscribed while unfinished; distinguish turn idle from execution complete. |
| Claude Code | `--print --input-format stream-json --output-format stream-json` and native background supervisor. | `--print` with a single text input, then stdin closes and the process exits. | Keep the streaming-input process/supervisor handle; correlate each turn/result; do not free lease while task waits. |
| Pi | `--mode rpc`, strict JSONL, state/prompt/steer/follow-up/control commands. | JSON print mode exits after one prompt. | One RPC process per execution with built-ins explicitly allowlisted/overridden; wait idle without exiting. |
| DSH | SDK JSON-RPC initialize/session/prompt and explicit shutdown. | Starts SDK, performs one prompt, then sends shutdown. | Initialize once, retain SDK process and session for the execution, send shutdown only at terminal/cancelled/confirmed-stop state. |

Durable session identity is useful after a crash but never substitutes for process residency. The current `run(): Promise<Result>` Adapter contract and process-host rule that kills any child surviving Adapter return must become an explicit resident lease with `open`, `submit`, `wait`, `pause`, `resume`, `probe` and `close` operations.

## Resident process contract

```ts
interface ResidentProcessLease {
  executionId: string;
  harnessId: string;
  pid: number;
  processGroupId?: number;
  bootId?: string;
  startTicks?: string;
  sessionId: string;
  state: "starting" | "busy" | "waiting" | "pausing" |
    "paused" | "stopping" | "stopped" | "crashed";
  controlSeq: number;
  acknowledgedControlSeq: number;
  lastActivityAt: string;
}
```

PID is paired with boot/start identity to avoid PID reuse. “Waiting” means native process alive, protocol responsive, task nonterminal and business slot retained. It performs no artificial model polling. Pause requires a protocol/process acknowledgement and a durable state/session checkpoint. Crash detection combines exit observation and lease identity; service restart reconciles OS/process and session facts. A handoff cannot begin until the old lease is stopped or confirmed incapable of writes.

## Baseline permission findings

| Harness | workspace | compute | yolo | Baseline verdict |
| --- | --- | --- | --- | --- |
| Codex | native `workspace-write`, single cwd, isolated HOME | still single cwd; no project worktree roots supplied | `danger-full-access` | workspace partial; compute fails; yolo honestly broad |
| Claude Code | restricted read tools, no general write tools | Bash enabled but still single root | same effective command surface as compute | all three differ from the contract |
| Pi | default read/bash/edit/write without native prompt boundary | effectively the same | effectively the same | fail-open unless built-ins are disabled/overridden |
| DSH | default single-root `workspace-write` | still single root | still `workspace-write` | compute/yolo fail |

The current invocation policy is natural-language guidance. Process host validates only cwd, and runtime HOME isolation changes `~` away from the real service-user home. These are not a host-compiled filesystem authority. Current business memory is `<workspace>/Memory.md`; it is not PR-delivered. There is no management-branch memory.

## Unified filesystem authority

```ts
interface FilesystemAuthority {
  serviceUserRoot: string;
  executionWorktree: string;
  ownedMemoryPath: string;
  readRoots: string[];
  writeRoots: string[];
  projectWorktreeRoot: string;
  protectedRoots: string[];
  gitCapability: "none" | "execution" | "project-service";
}
```

The host compiles roots and the Adapter only translates them. `realpath` is a
startup/preflight diagnostic, never the write authorization primitive. The host
maps opaque root IDs to pre-opened directory descriptors; broker calls accept an
opaque root ID plus a normalized relative path, traverse every component relative
to the held descriptor with no-follow semantics, and never reopen an authorized
host pathname later. Every access decision rejects NUL, traversal, symlink escape,
mount crossing and ambiguous shared `.git` paths. Business Agents do not directly
mutate shared refs; service Git operations validate execution/branch/epoch facts.

- `workspace`: reads the real service-user tree subject to OS access; writes only the execution worktree and owned business memory.
- `compute`: same read scope; writes the current project's worktree roots, never another project or OpenFARS state/messages/runtime.
- `yolo`: real service-user OS reach. The UI/log explicitly says that trusted shell can bypass normal service tools; no fictitious control-plane isolation is claimed.

Translation plan:

- Codex: native read-only sandbox plus one dynamic descriptor broker; yolo remains danger-full-access. Raw catalog entries remain harmless only while the native sandbox is actually enforced and fail closed.
- Claude: restricted mode with read-only built-ins and one MCP descriptor broker; yolo uses unrestricted Bash only when the user selected it.
- Pi: `--no-builtin-tools` and one OpenFARS MCP extension exposing the descriptor broker. An extension cannot re-enable raw built-ins; yolo explicitly restores the trusted raw surface.
- DSH: a non-yolo patch removes Bash/write/edit/jobs/subagent/workflow write surfaces and injects one broker. Yolo runs the unpatched trusted tool surface. If a future version cannot compile this catalog, the requested tier fails closed.

The product fails closed when an Adapter/version cannot compile a requested tier. Registry capabilities record installed version, platform, mode and evidence, rather than identical optimistic booleans.

Resident prompts describe descriptor filesystem tools only when that invocation
actually mounts the broker. A yolo launch using native filesystem tools does not
advertise an absent filesystem MCP; selected business MCPs remain independent.

## Memory and role transition

Git-enabled business memory lives at `agent-memory/<agentId>/Memory.md` inside the execution branch and reaches the group/main only through the required PR. A later execution reads the latest relevant branch version. Cancelled/failed worktree memory is retained as evidence but cannot overwrite the accepted version.

Main/leader management memory is service-committed to a dedicated management branch. Business prompts receive only a provenance-labelled snapshot when needed; Inbox, full conversation logs, runtime state and credentials are never committed. Git-off projects keep the legacy `Memory.md` path.

Role switching is serialized by Agent/session. A caller becoming temporary leader receives a management-only prompt and capabilities; its ordinary delivery prompt/write tools are not simultaneously active. On exit, the leader lease closes before that identity resumes normal business work. This is enforced by purpose/epoch and capability checks, not prompt etiquette.

## Strict R1 lifecycle evidence

The final research report is
`/tmp/openfars-r1-r4-harness-evidence-report-20260922.md`, SHA-256
`3b6a72b587e9e8e66c0bb982533311a7b59dd3c12b6b658375aa9c515a70f5e5`.
An independent reviewer checked its driver, provider/session, PID observer and
evidence artifacts rather than relying on the report summary.

| Harness | Resident and pause evidence | Crash/recovery evidence | Research result |
| --- | --- | --- | --- |
| Codex 0.153.4 | Host `1048397` / startTicks `1142277097`; same app-server thread completed provider rounds 1 and 2; idle `S`, four `T` samples, then CONT and turn 2. | SIGKILL; new `1049022` / `1142277382`; `thread/resume` on the original thread completed the only round 3 request. | PASS |
| Claude Code 2.1.263 | Host `1114134` / `1142291549`; one stream-json process completed two successful provider results; `S/T/CONT`, then result 2 on the same identity. | SIGKILL; new `1115418` / `1142291841`; `--resume` on the original session completed one round 3. | PASS |
| Pi 0.73.1 | Host `725311` / `1142187165`; RPC rounds 1 and 2 changed message count 2→4; four `T` observations and CONT on the same identity. | SIGKILL; new `727025` / `1142187506` loaded the same JSONL at count 4 and completed the only round 3 at count 6. | PASS |
| DSH 0.1.2-rc.1 | Host `1281904` / `1142328769`; one SDK session completed provider rounds 1 and 2 and durable cache boundary 2; `S/T/CONT` preceded round 2. | SIGKILL and old-epoch fence; new `1283501` / `1142329468`. Same-ID SDK resume returned the expected persisted-log collision and is **unsupported**. A new SDK session rehydrated the committed boundary; the unique third provider request contained the turn-1, turn-2 and input-3 markers exactly once. Its native turn is 1 and business turn is 3. | Product-level durable rehydrate PASS; native SDK resume UNSUPPORTED |

Core evidence hashes are Codex
`1126924261d09390ffad483a043e5c9f22c0a1fcd2b0dd555c9d1149c3576a00`,
Claude `b39028814954e8fd48b371aae0a84f937dfb0650076409c2f7597940026a5da7`,
Pi `c74246519b4e7aec33c0b1a3bb57d6ecb92f059f5256ad04983b367e8a655cba`
and DSH `917ca0b8c164abbc625cea14ad6822e32e0b6c3349c79158e573742405229966`.
The auditor independently decoded DSH's source append-only session log and pinned
it at `3b85f257adcb819be4da53c4412fbb587c711a4f34a25bf74f1d6877af27dc49`;
the projection cache is rebuildable and is not the sole recovery authority.

DSH core persistence exposes prepare/load/replay, but the installed SDK wire only
exposes initialize, prompt and shutdown. Implementation should first bridge the
core recovery path. The tested rehydrate fallback must bind source session,
source digest, last committed business turn and a deduplicated input ID; it must
never be described as native session resume.

## Strict R4 permission evidence

The final R4 report is
`/tmp/openfars-r4-fd-broker-report-final-20260922T1940Z.md`, SHA-256
`596e75b923590d4abff88134a06a9a74ce660a287684256459995e62a15e3e8b`.
Its immutable manifest is
`/tmp/openfars-r4-final-manifest-20260922T1940Z.json`, SHA-256
`0ee69901dd7e55676ed0552a3c51bfd7bfae32a4ad34180248b0009356a2710c`.
The descriptor primitive passed 23/23 attack cases. The four installed native
Adapters passed 24/24 assertions across 12 workspace/compute/yolo launches with
zero launch errors and no paid provider calls.

Every non-yolo launch first called one tagged `openfars_r4_broker` with exactly
`{action:"read", rootId:"service-user-root", relativePath:<relative>}`, then
called the same tool with exactly `{action:"matrix"}`. The real root stayed in
trusted launch state and was never supplied by the model. All eight launches read
the same 33-byte marker outside their execution workspace through a held root FD,
then passed the 23-case matrix. Audit logs retain byte count and SHA-256 rather
than file content.

| Adapter | workspace / compute enforcement observed | yolo observation |
| --- | --- | --- |
| Codex 0.153.4 | App-server dynamic broker with thread sandbox `read-only`; direct read-only `command/exec` write attempts failed closed and produced no target. This host failed early on a bundled-bwrap lock, so the result is not misreported as a clean target-path denial. | `dangerFullAccess` wrote the cross-directory target. |
| Claude Code 2.1.263 | Restricted launch exposed only `Read` and the broker; Bash/Write/Edit were absent. Both modes read the marker and passed 23/23. | Unrestricted Bash wrote the cross-directory target. |
| Pi 0.73.1 | `--no-builtin-tools`; the only tool was the broker. Both modes read the marker and passed 23/23. | Explicit built-in Bash wrote the cross-directory target. |
| DSH 0.1.2-rc.1 | Patch removed raw write plugins; catalog retained read/control tools and the broker. Both modes read the marker and passed 23/23. | Unpatched full tool surface wrote the cross-directory target. |

The primitive covers workspace own allow; workspace peer/cross-project deny;
compute same-project peer and explicit-root allow; compute cross-project deny;
existing, dangling and intermediate symlink attacks; hardlink replacement;
ancestor-swap TOCTOU; nonexistent descendants; absolute/dot-dot rejection;
linked-worktree `.git` denial; and a fixed-argv trusted Git broker. Writes use a
random `0600` temporary inode, fsync, descriptor-relative rename and parent fsync.
The hardlink test proves the outside inode is not truncated; the ancestor-swap
test proves a later pathname replacement cannot redirect the held FD.

Core immutable evidence SHA-256 values are descriptor JSON
`41660674b2fdf32b777f006c050416e06a486fb2368e688ddf45cdb0cda0592a`,
Adapter JSON
`e63fcb96af69a7aeecf48b15a020db3812f4aaa39bdf770bc46a9480e4d729a3`
and provider frames
`bb2e8b29579cf6c8252cf41e04b66ab29f1090b2df52a63ebcdde9f5f89c662c`.
Node 24 lacks the required descriptor-relative bindings, so the research uses a
small Python helper. Production must use an in-process native binding or a
byte-pinned helper installed outside Agent-writable space; `/tmp` is not a trusted
production location. The baseline product has not integrated any of this and
remains R4-noncompliant.

The independent audit corrected one phrase in the immutable report: the tagged
broker is the only trusted filesystem-authority/write broker, not literally the
only visible tool. Codex also exposes native exec/apply tools behind its read-only
sandbox, Claude exposes `Read`, and DSH exposes read/control tools. Codex's three
raw writes failed while bundled bwrap was initializing a read-only lock, so this
is fail-closed evidence rather than a clean destination-level `EROFS` test;
`apply_patch` also needs an integrated test on a host where that sandbox starts.
The research service-user root was a disposable cross-worktree fixture, proving
the mapping without exposing real user data; product acceptance must bind the
actual service-user root. Finally, the Python helper's `st_dev` check does not
prove rejection of a same-device bind mount. Production must use
`openat2(RESOLVE_NO_XDEV|RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS)` or a separately
proven equivalent and add that case to the integrated matrix.

## Existing evidence

Targeted baseline suite:

```text
npm test -- --maxWorkers=1 \
  tests/process-host.test.ts \
  tests/builtin-adapters.test.ts \
  tests/session-coordinator.test.ts \
  tests/harness-registry.test.ts \
  tests/harness-runtime.test.ts
```

Result: five files, 157 passed, one skipped, exit 0. These prove existing session identities, one-shot cleanup and some arguments; several tests positively confirm the behavior that v2 must replace.

Native no-model probe observations:

- Codex app-server: native PID remained sleeping and answered initialize.
- Claude Code realtime stream process: native PID remained sleeping with input open.
- Pi RPC: same PID answered `get_state` with idle state.
- DSH SDK: same PID answered initialize and stayed until shutdown.

Installed CLI/help and source evidence also confirms Claude `--add-dir`, realtime stream input, restricted/bypass modes; Pi RPC plus built-in-tool allowlist/disable and extension overrides; DSH's explicit SDK shutdown; and Codex app-server subscription/turn controls.

## Mandatory implementation/acceptance matrix

| Area | Assertion |
| --- | --- |
| resident continuation | Native PID/start identity is unchanged across business turn → waiting authorization/review → management event → continuation. |
| slot retention | Unfinished waiting execution still owns its business lease while management lane remains available. |
| pause | Control acknowledgement and durable session state exist; no model tokens are generated while paused. |
| crash/restart | Real native crash is detected; restart reconciles session/process and never creates two writers. |
| permissions | Four Harnesses × three tiers exercise allowed read/write and denied paths. |
| compute | Can write another worktree in the same project and cannot write another project's worktree/state. |
| path safety | Symlink escape, nonexistent descendant, shared `.git`, traversal and case/normalization boundaries are tested. |
| role transition | Worker→leader loses delivery tools and cannot create a leader PR; one session is never driven by two roles. |
| yolo disclosure | Bypass limitation is visible and tested; no absolute isolation claim appears. |
| memory | Business memory follows PR; management memory is separate; no credential/log bulk commit. |

## Gate limitation

The baseline cannot pass AC15, AC17, AC20, AC25 or AC26. Implementation remains disabled until the new resident/authority tests run on the integrated SHA. The research gate is sufficient because the native mechanism and fail-closed mapping are known; the final product acceptance must not reuse the idle-only probe as proof of business waiting.
