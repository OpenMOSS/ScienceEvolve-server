# ScienceEvolve architecture

[← Back to README](../README.md#configuration) · [返回中文 README](../README_zh-CN.md#configuration)

## Components

```text
React/Vite UI
  ├─ project and saved-task configuration
  ├─ global GitHub account library and project account selector
  ├─ SSE trajectory client with cursor de-duplication
  ├─ shared-workspace file browser
  └─ Agent roster, Main decisions and intervention panels
          │ HTTP + SSE
Express API
  ├─ Orchestrator (the only project-state writer)
  ├─ AgentScheduler (separate Main and Worker queues)
  ├─ shared workflow core (Main capabilities, Loop, recovery, ledgers)
  ├─ public Main routing and generic Worker routing
  ├─ ProjectStorage (atomic state, events and workspace files)
  ├─ EventHub (live wake-up; disk remains authoritative)
  ├─ SkillCatalog (trusted roots and real paths)
  ├─ GitHubAccountStore (OAuth, encrypted tokens and account-scoped resolvers)
  └─ HarnessRuntimeFacade
       ├─ Registry / Catalog / SessionCoordinator
       ├─ InvocationInputs / Policy / GatewayRoute
       ├─ CommonProcessHost → invocation-bound ProcessHost capability
       └─ Adapter (native CLI plan and official-event envelope mapping)
```

## GitHub account authority

The global GitHub account library is a server-owned credential boundary. The
browser sees only account id, mutable login/avatar display facts, stable numeric
provider user id, scope/status and timestamps. OAuth authorization uses an
opaque single-use state, PKCE S256, a ten-minute session and an opener origin
pinned to the configured callback origin. The callback reports a bounded
success/error message to that exact origin; tokens never cross the browser API.

Access and refresh tokens are encrypted with AES-256-GCM before an atomic
`github-accounts.json` write. The local 256-bit key and account document are
created with mode `0600`. A malformed document, invalid key or authentication
tag fails closed rather than dropping accounts or reverting to an ambient Git
credential. Production Git composition receives only an account-scoped
credential resolver.

Project creation requires one ready account when Git is enabled and persists a
credential-free binding `{ id, providerUserId, login, avatarUrl? }`. The stable
numeric provider id is checked before repository mutation; a changed login is
display metadata, while a different numeric identity is rejected. The account
binding, requested repository name, and requested visibility remain in every
initialization checkpoint, retry and restart. Legacy Git projects without a
binding pause at `git:waiting_for_github`; they never silently inherit the
service user's credential helper. A bound account cannot be removed from the
local library.

## Harness runtime boundary

Orchestrator, Project Explainer and Gateway Acceptance call one
`HarnessRuntimeFacade`; they do not choose CLI arguments, parse native events or
fall back to another Harness. The Registry is the sole Harness metadata source.
It publishes safe Catalog entries to the API and resolves the Adapter selected
in the persisted project snapshot.

Common code owns authoritative Inbox mirroring, the shared `Memory.md`, permission
constraints, invocation-local protocol proxy, request-level token accounting,
separate model/tool activity deadlines, SessionRef lifecycle and validation,
invocation recovery budget, process cleanup, canonical event sequencing and
stable errors. `runtime.ts` is the only production
composition root that constructs `CommonProcessHost`. For each invocation it
hands the selected Adapter a narrower `InvocationProcessHost` already bound to
the authoritative identity/environment, workspace, Gateway route, cancellation
signal, process marker and shared retry budget. Starting any native process
through that capability automatically consumes the common budget. Adapter code
does not construct a host, call the budget directly or implement another
spawn/signal/orphan-cleanup path; Pi's allowlisted MCP subprocess bridge is the
only explicit internal-process exception.

An Adapter owns only its descriptor, executable discovery, native
arguments/non-secret environment additions, native session ID format and shallow
mapping of the CLI's official structured event stream. The common launch host
rejects a changed cwd, SessionRef identity, protected authority field, route
credential or undeclared environment addition. OpenFARS never reconstructs tool
calls from prose or executes a model tool call on an Adapter's behalf.

The activity monitor accepts only canonical model events and structured tool
start/progress/completion events. Each active tool call owns an independent idle
window; raw stdout and transport keep-alives cannot extend either deadline. A
provider request is charged exactly once by `usageId`. Missing usage remains an
explicit unknown request and may later be repaired to known without double
counting; it is never rendered as zero usage.

Built-in descriptors remain in the Registry's built-in table. A code-level
extension carries its own descriptor and is registered exactly once through the
Facade composition option `additionalAdapters`; Registry and Catalog incorporate
it automatically. The replacement option `adapters` is reserved for isolated
tests. Business callers and the frontend neither import concrete Adapters nor
branch on Harness IDs.

Every invocation crosses the local GatewayRoute, including same-protocol
traffic. A Gateway/model/Harness combination is usable only after both its wire
route probe and an identity-bound real Adapter smoke probe pass. The latter goes
through the Facade's public smoke path, starts the selected real CLI in an
isolated workspace, reads a sentinel with a native read-only tool, and requires
paired official tool events plus the final handoff. The smoke cache includes
Gateway revision, Adapter version, executable fingerprint, protocol router
compatibility version and the selected Gateway reasoning fingerprint.

Gateway reasoning is a Gateway/model contract rather than a Harness guess. A
Gateway stores one supported parameter path and bounded option list per model;
the selected option is resolved into the outbound body only for that exact
request. An absent selection emits no field. `reasoningEffort` remains a
separate native Harness option.

The frontend consumes the public Catalog and canonical official-event envelope.
A Harness ID is diagnostic metadata, not a component or CSS selector. Tool
results and runtime diagnostics are collapsed by default. Missing runtime
Catalog injection and removed/unknown Harnesses fail closed as unavailable.
See [Adding a Harness](adding-a-harness.md) for the extension contract.

Purpose support is explicit. A workflow Adapter is not automatically an
Explainer Adapter, and a purpose-specific Adapter is not automatically included
in the Gateway smoke matrix. Project Explainer options are published only when
the Adapter can mechanically prevent model tool access outside the generated
evidence snapshot. Codex, pi, and DSH receive the snapshot as quoted prompt
evidence with native tools disabled; Codex remains the default. Switching the
Explainer Harness replaces its native session while preserving product history.

## Agents and configuration

Every project has exactly one Agent named `main`. It is a first-class entry in
the orchestration and configuration maps and is always serialized first. The
name is system-owned: it cannot be deleted, renamed or duplicated. There is no
user-facing identity field for distinguishing Main; runtime identity is derived
from the exact name `main`. Other names, including `Main`, are ordinary names.

Templates such as `idea`, `execution`, `writing` and `review` provide initial
Prompt, Skills and runtime defaults only. Main uses the same editable
configuration surface as every other Agent: model, reasoning effort, Prompt,
fixed/automatic Skills, MCP servers, Web Search and one of
`workspace`, `compute` or `yolo` permissions. Main defaults to `yolo`.

Agent invocations have no user-configurable wall-clock duration limit. Process
cancellation and the internal model/tool activity watchdogs remain independent
failure and resource-recovery mechanisms.

Project-level result format, user-intervention permission, Main workflow
reconfiguration, Git enablement and the selected GitHub account are editable
from both the creation form and the full workflow canvas. The canvas “flow
settings” inspector writes the same orchestration/Git draft owned by its parent;
it does not maintain a second configuration model. Ordinary orchestration
changes participate in the canvas history, while Git/account selection remains
project-creation state and is immutable after launch.

The Main system Prompt is separate from the user Prompt. The system portion is
returned by `/api/skills`, rendered read-only in the UI and always prepended by
the backend. It contains routing, completion, user-intervention, workspace and
control-tool rules plus a permanent orchestration policy: reconstruct the root
contract, assess delegation value, assign bounded work with dependency/write
ownership, monitor health, verify actual artifacts/tests/logs, and integrate the
root result without treating Worker reports as proof. This policy is injected
only into Main; it is not an optional Skill and is not given to Workers.
Project context is provided through the Inbox and context index.

## Permissions

`workspace` uses the project workspace sandbox and an isolated HOME.
`compute` inherits the authorized compute environment, Inspire wrapper and
workload accounting. `yolo` maps to the selected CLI's highest native access
mode and does not add product-level restrictions. Permission is independent of
the Worker output protocol and can be selected for Main or any child Agent.

## Routing state machine

The persisted `queuedAgent` is the continuation token. Main's outgoing routes
are rebuilt from the current child Agent list as weak edges. The list excludes
Main itself and `finish`; it is not editable by clients. Adding or deleting a
child Agent automatically adds or removes the corresponding Main edge.

Child Agents use strong and weak edges:

- one strong edge is deterministic;
- multiple weak edges are alternatives and are never run in parallel;
- the source Agent stores one `decisionPlans` string beside its weak-edge group;
- a child may point strongly or weakly to Main;
- if Main is selected from a weak group, the same durable Main thread receives
  another turn under a capability snapshot derived for that wake-up.

Main has exactly two control modes. `autonomous` is used for initial input,
deterministic routes, termination review, exception recovery, user input,
Loop-limit return and reconfiguration continuation; its route candidates are
all configured ordinary Agents. `weak-branch` is used only for a local group of
multiple weak candidates (and its route-missing repair); it can route only to
that captured set. `canComplete`, `canRequestUser` and `canReconfigure` are
orthogonal booleans on the same immutable snapshot. Prompt construction,
control-tool schemas, persisted pending state and action validation consume that
one snapshot.

Only the configured termination Agent may have a `finish` edge. In a
weak-branch decision, selecting `finish` queues a new autonomous termination
review; it never completes in the restricted turn. By default the termination
Agent hands evidence to Main for final acceptance. With
`termination.automatic=true`, a non-Main termination Agent receives only a
bounded completion action in the legal termination context. If its condition is
not met, the configured fallback route or Main continues the project; automatic
termination does not grant general routing, intervention or reconfiguration.

`orchestration.loops` decorates one deterministic `from -> to` return edge with
an ID, per-batch `maxIterations` and an `exitTo` target. The scheduler persists
current iteration, batch number and total iterations. Entering the group from
outside starts a batch; returning from `from` advances it; exhaustion follows
the virtual exit. Pause/resume, retry and ordinary reconfiguration retain the
counters. A Loop exit to Main is autonomous but does not create completion
authority outside the original termination contract.

The first user input uses `orchestration.input.target`. Every later project
input is persisted and delivered to Main, including input submitted while a
child is running or after a completed project is reopened. A running Main
invocation is safely superseded so the next turn sees the new input.

## Main and Worker protocols

Main and Workers return natural-language handoffs. The legacy `nextAgent` JSON
shape is not a response format. State changes happen only through validated,
invocation-bound control actions:

- `route_to_agent` chooses one target from the current Main capability (or a
  Worker-owned weak candidate set) and carries an optional assignment;
- `request_user` is Main-only and appears only when the snapshot permits it;
- `apply_workflow` is Main-only, requires the advanced gate and must be the
  invocation's sole terminal action;
- `complete_project` appears only in a legal Main or automatic-termination
  context;
- `publish_artifact` binds a Workspace file to its content identity, while
  `select_display` commits validated published artifacts for presentation.

Main receives the source Agent, decision plan, capability snapshot, event
increment, handoffs, failures, user inputs, publication catalog, current display
and Workspace index. The server validates target identity, state version,
capability secret and artifact integrity. Mentioning a target, completion or
display in prose has no state-changing effect.

## Durability and context

Each project owns one durable Main SessionRef in its selected Harness. Every Main
invocation resumes the Adapter's native session; the session is retained for the
entire project lifecycle, including Main-to-Main turns, user replies, reopened
projects and manual recovery. An authorized Agent-orchestration reconfiguration
intentionally resets Main's context so it cannot carry a stale topology or
configuration plan across the commit. It also resets any Agent whose editable
configuration changed; unaffected Worker sessions remain available.
A Worker is durable only when its
`sessionPersistence` setting is enabled. Resume failure creates generation + 1
inside the same Harness and resynchronizes authoritative context; it never
switches Harness or restarts the project.

The user API cannot mutate a running project's Gateway, model or Agent map.
Normal continuation and recovery retain the committed route. When the user has
enabled advanced reconfiguration, `apply_workflow` may change an Agent's model,
Harness and `gatewayId`, but only to a server-configured and validated route;
native and Gateway reasoning selections, credentials and runtime snapshots stay
locked. A changed execution fingerprint gives that Agent a fresh Session.
Every supported Harness implements native create/resume; the
durability policy decides whether a Worker SessionRef is persisted, not whether
that Harness is capable of resuming.

Every durable invocation receives a self-contained full synchronization of the
current server-authoritative project context. Native session resume still
preserves the Harness conversation, but correctness never depends on that
history: a missing or invalid native artifact causes a generation + 1
same-Harness replacement that can continue immediately from the full Inbox.
`mainContextSeq` remains audit/recovery metadata and advances only after a
successful Main decision; it is not used to omit authoritative context from a
later prompt. State, event log, timeline, inboxes, handoffs and traces are
written through the project write queue and recoverable journal.

## User intervention and failure recovery

Only Main can request a user response, through the validated `request_user`
control action. The intervention record stores Main's message, rationale and
the pending routing snapshot. A response queues Main on the same durable
thread; it never resumes a child directly and never creates a second Main
session.

Children never receive `request_user` or Main reconfiguration authority. They
may publish artifacts, and receive a bounded route or completion action only
when the Workflow explicitly gives them weak-edge ownership or automatic
termination. Errors inside one native turn are the child's responsibility. A whole invocation failure (process exit,
timeout, provider/API error, protocol error or equivalent) is retried with
backoff. Five consecutive failed whole invocations for one child clear its
retry counter and wake Main with the last five error records, trace paths,
original task and route candidates. Main can retry, reassign or ask the user.

Main automatically retries one failed whole invocation. If the retry fails,
the project enters `main-recovery-required`. The UI exposes only “恢复 Main”; a
manual recovery resumes the original thread and leaves configuration unchanged.

## Configuration locking

Creating/starting a project sets `configurationLocked` and `lockedAt`. Runtime
Agent configuration updates through the user API still return HTTP 409.
Saved-task editing happens before project creation
and may change the full Agent map, normal routes, decision plans, input target,
termination Agent and result-format requirements. Main's identity and fixed
routes are canonicalized on every persistence/API boundary.

`allowMainReconfiguration` is a user-owned, opt-in exception and defaults to
false. When enabled, the server writes a server-generated
`workflow.json` into the shared project Workspace for an autonomous Main whose
capability snapshot permits reconfiguration. The document contains macro
orchestration, explicitly editable Agent configuration, Project Skill/MCP
definitions, read-only `lockedRuntime` values, editing instructions and a
`baseHash`.

Main may add/remove/rename ordinary Agents; change input, routes, decision
plans, Loops, termination, result format and user intervention; create/version
Project Skills and Project stdio MCP services; and change instructions, model,
Harness, server-configured `gatewayId`, Skills and MCP assignments.
The authorization flag, permission, Web Search, Session persistence, weak-edge
decision ownership, native reasoning effort, Gateway reasoning, credentials,
host paths and runtime snapshots are server-owned.

`apply_workflow` remains a Main-only terminal control action. The server rejects
stale hashes, invalid graphs/references, locked-field edits and unsupported
runtime combinations before the invocation journal atomically commits anything.
A rejected change preserves state and emits a diagnostic. Successful changes
materialize versioned Project resources, reset affected Sessions, persist the
new state and queue a fresh autonomous Main invocation.
Changing an existing Agent's `template` is only a macro role-label change;
template defaults apply to newly added Agents only.
There is no one-time reconfiguration limit: a later autonomous Main may submit
another proposal whenever its new capability snapshot permits it.

The same proposal can carry `skillDefinitions` and `mcpDefinitions`. Project
Skills are immutable, content-addressed revisions staged for the selected
invocation and referenced as `project:<name>`. Project MCP definitions contain
stdio service sources; the server starts a private loopback HTTP proxy for the
selected invocation and tears it down afterward. These definitions belong to
the project state and are separate from the global Skill and MCP catalogs.

## Workspaces and artifacts

```text
data/projects/<project-id>/
  request.md
  state.json
  events.jsonl
  timeline.md
  messages/<turn>_<agent>_*.md
  traces/<turn>_<agent>_*.md
  runtime/<invocation>/
  workspaces/
    Memory.md
    user_inputs/       # original files and images supplied by the user
    ... project files
  skills/<content-digest>/
  mcp/<content-digest>/
```

All Agents use the same business Workspace and `Memory.md`; identity, Session,
trace and invocation runtime remain isolated. Legacy `<agent>/shared/` trees are
left in place and are used only as a compatible fallback when no root-level file
exists. Migration never merges or overwrites them.

New-project attachments are placed in a temporary session's real `user_inputs/`
folder, then copied into `workspaces/user_inputs/` before the first Agent is
queued. Browser file and folder selection preserve relative paths. A local-only
endpoint opens the temporary folder with Windows Explorer, macOS `open`, or Linux
`xdg-open` so users can add files directly; the server rescans it before recommendation
and project creation. File naming follows the server's host platform, and replacement
and deletion honor the actual filesystem's case sensitivity. Desktop-launch failures
remain visible without blocking browser uploads, recommendation, or project creation.
The UI lists at most five top-level entries until expanded and groups nested
files under their top-level folder. Every Agent can read the final folder. Collaboration
Agent invocations receive its canonical path and a read-only filesystem root even
when their current directory is a separate Git worktree. Originals stay in the
shared workspace and are not automatically copied or committed to Git. The optional user note and
initial file list are included in each Agent inbox. File contents remain
untrusted evidence, and input files are not published artifacts by default.

Before a project exists, configuration recommendation reads the current
temporary `user_inputs/` folder. The advisor receives the title,
requirement, optional file-purpose note, extracted UTF-8/Office text and image/PDF
bytes in one model request. The advisor's system policy treats all file content
as untrusted evidence. Project creation installs the selected files into its
shared `user_inputs/` directory.
Unsupported or oversized recommendation inputs fail explicitly instead of
silently generating a recommendation from incomplete evidence.

`publish_artifact` records producer, invocation, relative path, size, media type,
mtime and SHA-256. Preview, `select_display`, Explainer evidence, final reads and
downloads revalidate size and hash. Changed bytes invalidate the publication and
the producer must publish again. Legacy records without hash remain explicitly
unverified. Artifact access validates relative paths, hidden components,
symlinks and regular-file boundaries; formal publication remains separate from
ordinary shared file access.

Project Skills and MCP sources are immutable content-addressed versions outside
the business Workspace. Invocation copies and private MCP process state are
runtime material, not user-authored source of truth. `envFrom` names host
environment variables; definitions never contain inline credentials.

## Compatibility and security

Structured SessionRef data is preferred while legacy session strings remain
readable during the compatibility window. Unknown or removed Harness IDs are
preserved and surfaced as unavailable; they are never replaced with the current
default. Historical loose trace events remain readable, while all new Adapter
events use the canonical schema. No migration fabricates historical tool
results. Resume/replacement context carries an idempotent recovery marker and
is injected only into an actual resumed or replacement Session; a fresh Session
does not receive fake recovery instructions. Ephemeral Codex Workers disable
native Goals, while persistent Main keeps the product policy.

Legacy pending Main decisions migrate to `weak-branch` only when their source
can be proven to have multiple weak candidates; all other old pending states
become `autonomous`. Loop counters, token ledgers, Explainer history and legacy
Workspace fallback migrate idempotently.

All Agent names, project IDs, display paths and workspace paths are validated.
Absolute paths, traversal, hidden components, escaping symlinks, directories
used as files and unknown Agents are rejected. User MCP servers are separate
from the internal append-only workspace bridge. Secrets are written only to
the current compute workspace when the task explicitly requires them.

## Configuration recommendation and Project Explainer

Configuration recommendation is a stateless shared service. It receives the
project title, requirement, current Workflow and an advisor route, then returns
a complete `agents + orchestration + warnings` draft. It has no tools, does not
mutate the project, and validates the entire result with the normal Workflow,
Harness, Gateway, Skill and MCP rules before the UI may apply it.

Project Explainer has its own persisted config, history and Session. One active
turn per project reads a generated read-only evidence snapshot containing
bounded project state, events, published artifacts, Workspace files and product
history. Explainer purpose support is explicit in the Harness Catalog; Shell,
Skills, MCP, Web Search, file writes and Workflow controls are disabled, and a
Harness that cannot enforce that boundary fails closed. Harness changes replace
the native Session while preserving product history. Progress suggestions are
bounded by the shared service and remain subject to Orchestrator validation.

The shared runtime semantics and cross-host synchronization contract are
summarized in [main / SDK feature parity](main-sdk-parity-zh.md).
