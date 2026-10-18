# SII experiment MCP: implementation and usage contract

[← Back to README](../README.md#configuration) · **English** | [简体中文](inspire-async-experiments.md)

Implemented in `server/src/sii-experiments.ts`, this integration supports ordinary workflows and resident Agents across four Harnesses. Platform operations use the built-in `scienceevolve-sii` MCP. The original Inspire Skill and references remain available as on-demand knowledge and compatibility entry points for older projects.

## 1. Responsibilities

Agents select resources, prepare programs, submit experiments, decide whether to continue independent work or yield their turn, and handle analysis, resubmission, cleanup, and task completion after results arrive. The system executes parameterized operations, persists facts, queries state in code, delivers notifications, and resumes the original session.

Submission alone does not end a model turn, complete a task, or change routing. After calling `sii_defer_task`, the Agent naturally ends its turn. The runtime releases the model execution slot while the logical task's Promise remains unresolved. Existing missing-report/`finish_task`/Git follow-up mechanisms run only after the final return. Dependent successors remain blocked; independent branches can continue under the existing rules.

Platform success means an experiment reached a terminal state. The Agent must receive the facts and satisfy its own task objective before using ordinary completion/routing tools.

## 2. Enable the integration

1. Install and initialize Inspire CLI as the operating-system user running Server, including account, workspace, and billing-project configuration.
2. Set `SCIENCEEVOLVE_INSPIRE_BIN`. `SCIENCEEVOLVE_INSPIRE_WORKSPACE_ROOT` must include actual Agent workspaces.
3. Explicitly enable “SII 实验工具” (SII experiment tools, `experimentMcp: true`) for experiment Workers. File scopes `workspace / compute / yolo` are configured separately. SII tools are unavailable to unselected Agents and Main/Leader/coordination/terminal-reconciliation turns. Old configurations without this field do not gain authorization automatically.
4. Optionally set `SCIENCEEVOLVE_SII_REFRESH_MS`: default 30000 ms, minimum 1000 ms. Active experiments are queried serially, with per-call timeouts and failure backoff up to 300 seconds.

Each experiment also has `check_interval_minutes`, an integer from 5 to 60, default 5. This wakes the original waiting Agent to inspect progress independently of background platform polling. Detected success, failure, or cancellation triggers immediate notification without waiting for that interval, including experiments shorter than five minutes.

New Execution templates no longer load `builtin:inspire` by default. Old projects may retain it, and compatibility wrappers remain. New asynchronous notifications use MCP-registered experiments; old ledgers cannot establish the original Agent session.

The runtime generates the built-in `scienceevolve-sii` address for the current invocation. Custom remote or Project MCP definitions cannot reuse that reserved name. Text configuration, all canvas levels, Main proposals, and save/load use the same `experimentMcp` field; instruction keywords or permission names never implicitly enable it.

Local SCP upload/download, Notebook artifact downloads, and CLI file options obey the invocation's file scope. Resident execution uses the existing file broker's trusted project-worktree registration. Wrong-task directories, out-of-scope paths, and symlink/hardlink aliases are rejected. Completion files must remain inside the original task directory and match this run's `run_id`. Agents select remote resources and research commands; the system does not parse commands to plan experiments.

Native Harness tools under `yolo` retain their native/OS permission contract. SII business MCP local transfers still validate authorized paths. An assigned worktree outside the service user's home can upload/download normally, and the service-user root follows its trusted binding. `yolo` does not bypass other task directories, protected state, traversal, or file-alias checks. Protected files cannot be upload sources.

CLI operations use `execFile` with literal argument arrays and no shell expansion. They retain `--no-env-file --json`, optional global configuration, proxy handling, the specified billing project, and shared-path restrictions. Do not override the reserved name `scienceevolve-sii`.

The integration accepts CLI progress text followed by JSON and successful text-only operations such as connection preparation. Ordinary commands preserve actual text and exit codes. Resource submissions and experiment-status queries still require JSON facts; successful-looking progress text is insufficient evidence.

Notebook CLI normally waits for startup, and configured post-start actions force waiting. MCP creation adds `--no-wait --post-start none`. Explicit post-start scripts/actions are rejected before remote submission, with instructions to split the steps: submit the resource, defer until `resource_ready`, then configure the connection, register the experiment, and start the background program. This preserves platform operations without hidden submission waits.

Ordinary and resident Codex entry points auto-approve only the runtime-injected `scienceevolve-sii` whose URL matches the current trusted binding. Other external MCP authorization rules remain unchanged; the name alone grants nothing. See the [Codex configuration reference](https://developers.openai.com/codex/config-reference/) for native configuration.

## 3. Tools

| Tool | Contract |
| :--- | :--- |
| `sii_command({args})` | One-shot CLI operations: help, accounts/context, resources, Notebook exec/scp, images, models, diagnostics, cleanup. Creation enters registration. Follow/watch/wait forms are rejected. |
| `sii_submit_experiment({args,request_id,completion_file?,required_for_task?,check_interval_minutes?})` | Submit one job/hpc/notebook/ray/serving create, register monitoring, and return current facts and guidance. Results are required by default. Supports periodic checks by the original Agent. |
| `sii_register_experiment({kind,name,workspace,request_id,completion_file?,required_for_task?,check_interval_minutes?})` | Register monitoring on an existing resource confirmed available for this task. Does not create, restart, or automatically start a program. |
| `sii_submit_batch({experiments})` | Apply the same submission contract per item, including its own check interval. Return success, explicit failure, or unknown outcome for each. Agents specify resources and arguments. |
| `sii_get_experiment({experiment_id})` | Read persistent state owned by this task without waiting or automatically invoking a model. Receipt is acknowledged only after the original native session actually receives the terminal tool result. |
| `sii_defer_task({experiment_ids,context,check_interval_minutes?})` | Save the Agent's continuation context and required experiments; immediately return a task-incomplete receipt. Optionally update all listed intervals; omission preserves individual settings. The Agent then naturally ends its turn. |
| `sii_read_knowledge({path?})` | Without a path, list original knowledge documents. Start with `SKILL.md` and read references as needed. |

Use `sii_command` log/event/metric queries instead of a dedicated output-reader tool. Replace CLI batch resource creation with `sii_submit_batch`, giving each item a stable key and session ownership. CLI batch help and dry-run remain available.

Every create explicitly supplies `--name`, `--workspace`, and `--project 具有能动性的科学大模型`. Use a stable `request_id`. If a response is lost, replay the same ID and arguments to retrieve the receipt rather than allocate another resource. New experiments need a new ID and unique name. Reusing an ID with different resource arguments is rejected, as is duplicate creation for the same account/type/workspace/name within a project ledger. Check intervals are separate from submission identity: explicitly updating an unfinished experiment's interval does not recreate it; omitting the interval during replay preserves its settings and deadline.

Responses include `experiment` (ID, status, runId, original session and submission ownership), `monitoring`, and a natural-language `message`. Confirmed submission, explicit platform rejection, and uncertain outcomes remain distinct. Guidance describes independent work or defer options without choosing for the Agent.

Example; Agents must still complete resource arguments using live discovery. The Chinese billing-project value is an actual platform identifier and must retain its exact spelling:

```json
{
  "args": ["job", "create", "--name", "training-a", "--workspace", "your-workspace", "--project", "具有能动性的科学大模型", "--command", "python train.py"],
  "request_id": "training-a-v1",
  "check_interval_minutes": 10,
  "required_for_task": true
}
```

After receiving `experiment.id`, yield execution when needed:

```json
{
  "experiment_ids": ["exp_..."],
  "context": "Task incomplete. Inspect current logs and metrics and compare the baseline. After the experiment ends, validate metrics.json and decide whether more experiments are needed."
}
```

The tool returns immediately. The Agent then returns a pending handoff without `finish_task` or successor routing. The system saves and returns that handoff and context.

The first check is timed from experiment registration. Re-saving waiting context does not postpone it. At the deadline, an explicit periodic-check notification resumes the original session. The Agent uses `sii_command` to inspect actual logs/metrics and decides whether to continue, adjust, or stop. Call `sii_defer_task` again to keep waiting, optionally changing the next interval, for example to 15 minutes. Intervals and deadlines persist across restarts. A periodic check does not acknowledge completion or release successors.

For existing Notebook/Ray/Serving programs: verify account/workspace/project ownership → register a new request ID and completion file with `sii_register_experiment` → start the Agent-prepared background program through `sii_command` → continue independent work or defer. One resource can host multiple registered experiments. Registration rejects an existing completion file containing this run ID, or a completion-path/run-ID pair already used by another task; choose a fresh run ID.

## 4. Task-completion gates

`required_for_task` defaults to true. If a required experiment is running, unknown, or terminal but not received, the runtime rejects `finish_task`, `route_to_agent`, `complete_project`, and `complete_group` before their side effects, with a reason. Returning a final result directly must pass the same check.

Entering system wait closes MCP access but retains completion gates. They are released only when the logical task ends, is cancelled, or its binding closes. Acceptance checks cover completion attempts during wait as well as active model turns.

A system notification is acknowledged only when the original persistent session's actual native `user.message` fully contains the batch notification. If ordinary Codex `exec` emits no such event, the existing completion gate can perform a bounded read-only check of that Agent's isolated project `CODEX_HOME` and exact thread's native rollout. It requires matching session_meta thread/cwd/source and a native user response_item containing the full batch. Evidence records source, relative file location, byte offset, digest, and native timestamp. It neither synthesizes official events nor reads reasoning or other threads. Directory lookup is limited to 4096 entries; reads cover a 64 KiB prefix and 8 MiB tail. Missing, ambiguous, truncated, incomplete, or linked evidence remains unacknowledged.

Ordinary Adapters and resident entry points privately observe complete redacted native user input; displayed events retain their length limits. Ordinary Claude with SII uses official stream-json input and `--replay-user-messages`, sending one user frame to the exact session. Acknowledgment requires actual native echo receipt. Echo does not prove model understanding or research success.

Preparing notifications, queuing input, or receiving a model return does not prove delivery. The original experiment ledger retains event, invocation, native evidence, and session proof. Both execution paths retain completion gates. Each bounded notification includes complete results where possible; results that do not fit are listed by ID and remain unacknowledged until read through `sii_get_experiment`. Agents judge whether results meet objectives; the system neither performs scientific acceptance nor proves semantic understanding.

Synchronous `sii_get_experiment` follows the same gate. The MCP handler stores a pending snapshot and result marker, rather than acknowledging response generation or socket writes. The runtime matches the original session, invocation, real tool call, and marker in the actual native completion event before recording `native_tool_result`. Claude's unnamed result frames correlate through a prior real tool-call ID. Duplicate markers in content/structuredContent are deduplicated. Different markers, wrong sessions, old calls, or failed events cannot acknowledge receipt. After disconnection/restart without receipt, the existing waiting/notification path redelivers terminal facts to the same original session without resubmitting the experiment.

Old `acknowledged:true` records without native receipt evidence cannot release current unfinished tasks. On normal invocation of that original task, the runtime still requires the exact original session and redelivers through existing notifications. Only later real receipt confirms delivery. It does not migrate all historical ledgers or reopen completed projects; unrelated old records remain unchanged.

Receipt proves delivery to the native CLI tool-result boundary. CLIs may compact model context or save large results to original-session files and provide summaries/paths, as Claude does. Receipt does not prove the Agent read or understood all evidence. Agents must inspect actual files/tools to make research judgments. Controlled provider/platform tests do not replace real experiment acceptance.

Any experiment reaching a check deadline, ending, or suffering persistent monitoring errors may wake the Agent. Other missing required results continue blocking completion. After handling available facts, the Agent can defer again for the remaining results.

`required_for_task:false` supports resource startup, long-lived services, or delegations requiring only a submission receipt. It does not allow tasks that depend on experiment results to finish early. Task completion or project cancellation does not automatically reopen the Workflow; resource cleanup remains with the Agent/user.

For Notebook/Ray/Serving resource startup marked false with no completion file, RUNNING/READY triggers `resource_ready` with `completion_scope:resource_startup`. An Agent can defer for that notification, then register and start the scientific program. This ends startup observation only and does not claim experiment success.

## 5. State and completion files

| Resource | Facts read by the system | Agent responsibility |
| :--- | :--- | :--- |
| Job/HPC | Explicit CLI terminal success, failure, or cancellation | Artifact acceptance, log analysis, further experiments, cleanup |
| Notebook/Ray/Serving | Resource failure/cancellation or this run's completion file | Prepare background programs, write exit information, validate outcomes, reuse resources |

RUNNING/READY does not mean experiment completion. If results are required, supply a `completion_file` inside the current Agent's actual working directory. The system reads regular files only, enforcing size and path limits. Programs should write atomically, for example through a same-directory temporary file followed by rename:

```json
{"run_id":"training-a-v1","exit_code":0,"result_path":"results/metrics.json"}
```

`run_id` must equal the submission's `request_id`. Exit code 0 means program success; other integers mean failure. Old-run markers do not complete new experiments. Resource-only startup of long-lived notebook/ray/serving resources may be optional; Agents still arrange scientific programs themselves.

Unknown platform state remains unknown. A single query failure does not mean experiment failure. Three consecutive query failures deliver one monitoring-error notification to the waiting task while polling continues with backoff. The same persistent error does not repeatedly wake the model. Successful polling resets that error period.

## 6. Persistence, sessions, and lifecycle

Per-project `runtime/sii-experiments.json` stores experiments, original Harness/native SessionRef/generation, task/execution ownership, working directory, account, workspace, run ID, query evidence, and incomplete-task receipts. Writes use a per-project serial queue and temporary-file rename. Intent is persisted before remote creation. Uncertain outcomes reconcile the same name without automatic resubmission.

Monitoring is independent of MCP connections and model processes. Server scans project ledgers on startup to restore polling. Waiting runs in code without a model. MCP-created workloads also enter the original `inspire-workloads.jsonl` for usage accounting; reused resources retain existing registrations. CPU monitoring is independent of GPU collector filters.

Notifications carry a persistent event ID, real observations, and the Agent's original context and handoff. Waiting ordinary workflows release global model slots and rejoin the fair queue on an event. Resident Agents wait outside physical turns, retaining pause/resume/close and the same logical submit.

Both paths serially resume the original session, generation, and working directory rather than replace the session. Failed continuation retains unacknowledged events. Events stay ready until the continuation turn ends and can replay after restart; final logical return clears the waiting receipt. External platform/model side effects have no absolute exactly-once guarantee, so Agents should use files and submission IDs to avoid duplicates.

Ordinary and resident DSH share a trusted SDK plugin using the official Agent resume API. Ordinary calls validate the persistent file, send the exact session/resume, verify the returned Session ID and last native sequence, then send the current prompt. Old recovery state cannot satisfy the current idle wait. Reusing IDs alone does not prove history was loaded. Identity/sequence mismatches preserve the original SII session and unacknowledged results rather than replace it to deliver notifications.

Experiment events do not interrupt running Agents; they wait for the safe boundary after voluntary defer. Pause follows existing scheduler/process rules; resume precedes model execution. Cancel/close stops local waiting without restarting workflows or automatically stopping/deleting platform resources.

The current CLI uses active-account storage. Submissions pin the alias read from `~/.inspire/current`; explicit account arguments must match. If the active alias changes, monitoring reports a query error instead of reading a same-named task under the wrong account. Restoring the bound account resumes monitoring. Unverified per-task multi-account CLI arguments are not assumed.

## 7. Mapping existing operations

Reference paths below are within the built-in Inspire Skill.

| Existing knowledge / operation | Entry point |
| :--- | :--- |
| Accounts, configuration, context, initialization, installation | `sii_command` + `references/setup/install-and-config.md`; the Server OS user completes interactive authentication beforehand |
| Project/workspace/group/quota/availability, shared storage, networking, resource selection | `sii_command` + `references/resources-and-paths.md`, `references/paths.md`, `references/network-and-sources.md` |
| Notebook creation, exec, scp, logs, connection, reuse | `sii_submit_experiment` / `sii_register_experiment` / `sii_command` + `references/notebook.md` |
| Job/HPC/Ray/Serving, profiles, batch resources, lifecycle | `sii_submit_experiment` / `sii_submit_batch` / `sii_command` + `references/compute-workloads.md` |
| Images, model registry, result acceptance, cleanup | `sii_command` + `references/image-management.md`, `references/model.md`, `references/workflows.md`; Agents retain decisions |
| Long experiment observation, Notebook Sentinel | System monitor + `sii_defer_task`; one-shot Agent diagnostics as needed |

The main Skill and Notebook guide's model-polling instructions were updated. Other operational rules and domain judgments remain available on demand, without injecting every reference into each model call.

## 8. Validation and deployment scope

The records below describe the implementation's historical acceptance. They are not a fresh verification of your deployment.

Tests cover real MCP clients, creation deduplication/lost responses, state errors and CPU/HPC, old completion files, deduplicated monitoring errors, ownership, post-submission completion gates, existing GPU registration, Server restarts, and original-session retention. Ordinary Harness tests check that intermediate turns do not finalize tasks. Four fixture native processes cover resident pause and same-process/session continuation. Scheduler tests cover slot release and fair continuation.

Recorded acceptance passed frontend/backend type checks and full builds, 279 relevant regressions across SII, Harnesses, four resident processes, Main, scheduler queues, invocation policy, and templates, plus 48 new-project-page tests. Old template assertions found by the full scan were updated. Complex nested workflows passed with a 15-second test-runner timeout after exceeding the default five seconds; a watchdog timing assertion from the high-load full scan also passed in the relevant regressions. Business runtime timeouts were unchanged. The initial full scan was not reported as entirely passing.

Commands for rechecking:

```bash
npm run typecheck
npm run build
npm run test -w server -- tests/sii-experiments.test.ts tests/harness-runtime.test.ts tests/resident-adapter-factory.test.ts tests/orchestrator-main.test.ts tests/orchestrator-queue.test.ts tests/invocation-policy.test.ts tests/validation.test.ts --maxWorkers=2 --testTimeout=15000
npm run test -w web -- src/pages/NewProjectPage.test.tsx
```

Code and fixtures validate local submission, waiting, and continuation. Live-platform scope is recorded separately below.

### Historical CLI setup and real queries (2026-10-07)

Inspire CLI 6.2.0 and Playwright 1.62.0 were restored using a Python 3.12 virtual environment in the workspace. The old entry point referenced a pre-migration directory and its interpreter no longer matched. The new environment did not overwrite the original deployment.

- Terminal entry: `/usr/local/bin/inspire`.
- Project entry: `/inspire/qb-ilm2/project/cq-scientific-cooperation-zone/ky26306/.tools/inspire/bin/inspire`.
- Account: the service user's `~/.inspire` linked to the original deployment's `openfars/.home/.inspire`; the requested `ky26306` account was added and activated. Passwords remained in its account directory, with configuration/session permissions `0600`, outside Git, command arguments, and validation records.
- Browser: reused the original Chromium installation and installed missing shared libraries. The CLI launcher cleared generic HTTP(S)/ALL proxies for direct SII access; account-specific proxies remained the CLI's responsibility.
- Notebook connection: installed local rtunnel from the platform's official bootstrap kit; `~/.local/bin` linked to the workspace CLI directory. A separately generated SSH key in `.tools/inspire/ssh` used `0600` private-key permissions and linked to a previously absent default path, without overwriting existing keys.
- Ignored `main-fix/.env` contained the absolute CLI path, `/inspire/qb-ilm2` workspace boundary, direct SII domains, and a 30-second background polling interval.

Actual `--version`, `--help`, `config check` (`auth_ok=true`), project/Notebook queries across workspaces, and `sii_command` through a real MCP client were exercised. Real Notebook state queries and normalization were verified.

The original `sii` account could not see the required billing project `具有能动性的科学大模型`. After the requested switch to `ky26306`, login, project/compute-group initialization, and live queries confirmed visibility. The missing Docker Registry was filled using that account's live official image URL, `docker.sii.shaipower.online`, rather than inferred from the old account.

A further real MCP check confirmed account/identity `ky26306`, `auth_ok=true`, and billing-project visibility. Credential-free evidence was saved at `.tools/inspire/account-verification.json`. Account setup used local initialization and read-only queries; live experiment results and cleanup were recorded separately.

### Repeatable live acceptance

Running `node server/live-sii-acceptance.mjs` at the repository root displays scope only. `--run` performs the real test. The script uses configured CLI, account `ky26306`, the existing AIGW gateway's `kimi-k3` model, and native Codex to create an isolated local project and temporary Notebook. It queries live CPU quota and uses the official image of the running `openfars` Notebook without changing that Notebook.

The test Notebook requests 1 CPU / 4 GiB and uses 30-second code polling. The driver prepares programs/files; the native Agent submits resources, registers experiments, starts background execution, defers, receives results, and stops resources. Programs atomically write exit codes 0 and deliberate failure 7. Background commands are grouped so CLI's `cd … &&` prefix does not keep SSH waiting for program completion. `SCIENCEEVOLVE_SII_TEST_PUBLIC_KEY` can select the public key; the recorded environment defaults to `.tools/inspire/ssh/id_ed25519.pub`.

The script checks real submission, readiness, success/failure, original native session/generation continuity, unresolved logical tasks, completion gates before required results, unchanged model-request counts while waiting, and final waiting-receipt cleanup. Its `finally` stops only the uniquely named resource from that run; release succeeds only after platform-confirmed `STOPPED`. Failure/timeout fails acceptance. Reports/native events stay in ignored `temp/sii-live-*/`; gateway credentials are excluded.

After receiving results, a model sometimes describes cleanup without doing it. The driver allows at most one explicit cleanup follow-up, retaining the original taskSessionId, native session, generation, and working directory without allocating again. This is post-result acceptance cleanup rather than model-based polling. Existing Workflow completion checks retain scientific-objective acceptance.

After native MCP authorization fixes, 131 regressions across three files covering `codex-runner`, four resident entry points, and SII passed. Completion gates during wait and CLI text-result compatibility were then covered by 182 regressions across four files for SII, ordinary Harnesses, scheduler queues, and resident entry points. Frontend/backend type checks and builds passed; Server was rebuilt after final changes. Live acceptance covered CPU Notebook only. Job/HPC/Ray/Serving, partial batch failures, and resident lifecycle remained regression coverage rather than proof of live validation for every resource type.

### Final historical live record (2026-10-07 UTC)

Resource: `sii-mcp-muyaygbk`; account: `ky26306`; 1 CPU / 4 GiB. Original evidence directory: ignored `temp/sii-live-2026-10-07T16-08-53-786Z/` in the acceptance workspace.

| Check | Observed result |
| :--- | :--- |
| Submission/startup | Submission returned queued; system polling delivered `resource_ready` |
| Resource wait | 49.6 seconds; model requests 6 → 6 |
| Experiment wait | Defer while both required experiments were running; 70.9 seconds; model requests 11 → 11 |
| Completion gate | `finish_task` during system wait was rejected |
| Success/failure | Atomic completion files for fresh run IDs reported exit codes 0 and 7; both `sum_squares` results were 285 |
| Staggered results | Received succeeded while the other remained running; deferred again, then received failed |
| Session continuity | All continuation and cleanup checks used the same native session, generation 0 |
| Resource release | Driver confirmed STOPPED; the same-session Agent confirmed it through MCP |
| Final state | All required results acknowledged, waiting receipt cleared, original Notebook untouched |

The original driver required a fixed English cleanup marker. After the main flow, the Agent only said it was preparing to stop the resource, so original `report.json` retained its strict failure. A same-session cleanup follow-up executed two `sii_get_experiment` calls and one Notebook-status MCP query, returning exit codes 0/7 and STOPPED without creating/starting resources. The combined facts and follow-up yielded `passed:true` in local `verified-result.json`; the strict original report was preserved. The repeatable driver incorporates the same one-follow-up limit and accepts program facts, continuity, gates, waiting, and release. These ignored evidence files are not distributed with a clone.

Integration fixed hidden Notebook waits, built-in Codex MCP approval, premature completion-gate release during system wait, and CLI progress/text compatibility. Read-only prechecks retried HTTP 429 every 30 seconds; creation did not automatically retry. Native local Shell in isolation encountered a bubblewrap read-only-lock error; acceptance used prepared programs and Agent platform operations through MCP. The production Server was not restarted, and this did not establish full deployed-UI acceptance.
