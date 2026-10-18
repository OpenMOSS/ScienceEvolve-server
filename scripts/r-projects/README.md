# R-series acceptance preparation

[← Back to README](../../README.md) · [中文首页](../../README_zh-CN.md)

`catalog.mjs` materializes the sixteen cases from the external OpenFARS follow-up plan. The ordinary cases use the prescribed base graph; R05/R06 add sibling groups, R07/R16 have three group levels, R08 returns the coordinator through Worker→Leader→Worker, and R10 has actual ordinary/group weak decisions. Main changes every named Loop from 1 to 2. R15 adds previously absent resources with precise content and references.

The catalog does not choose a runtime or claim acceptance. Supply an observed binding containing `runId`, `gatewayId`, `model`, `harness`, `githubAccountId`, `observedAt`, and `evidencePath`. Use a unique stable run ID so later creation can retain its payload and submission journal. The binding must come from the configured runtime/GitHub catalogs; a saved observation is still subject to fresh route verification before launch.

From the repository root:

```bash
npm run r-projects:validate -- --binding temp/r-projects-preflight/binding.json --output temp/r-projects-preflight/catalog
npm run test -w server -- tests/r-project-catalog.test.ts
```

Validation builds the server, parses all payloads with its authoritative schemas, checks resource references, and parses Main's complete planned changes using the real proposal parser. It writes normalized create payloads (including each Agent's final instructions), canonical resource revisions, every Loop's endpoints, decision ownership and unresolved gates. It does not call project creation or apply workflow on a running project.

`validation-report.json` proves offline schema/proposal checks only. The tests additionally assert the specified structures and business data and invoke the supplied protected/new MCPs through the real project MCP host. Raw JSON graph uniqueness is not a coverage criterion.

All entries initially have `launchReady: false`. S09 current native-protocol regression acceptance, final repository checks, running-service version proof and current route verification remain prerequisites. Missing historical N03 wire logs remain a documented investigation gap rather than a prerequisite for every new project. Fault entries list exact intended boundaries, triggers and required receipts; `ready: false` means their project-local controller is **not yet bound and armed for a real project**. These plans are not evidence that an error was injected. R16 browser interactions require an actual independent observer. Neither output volume nor project `completed` alone proves acceptance.

The read-only monitor accepts the stable run directory containing `launch-result.json`. It refuses an empty registration list and preserves full state snapshots, paginated raw events, original errors, per-arrival Loop counters/FIFO facts and observed native lifecycle events. Event gaps retain the old cursor for re-reading. A `completed` projection is always labelled as needing evidence review.

```bash
npm run r-projects:monitor -- --input temp/r-projects-run --once --local-projects-root data/projects
```

With a local projects root, the monitor reads the recorded PR head/merge and report commit trees separately and records actual worktree branch/status. It never fetches, changes Git state, repairs business work or writes the database. Missing local access is reported as unverified. Full raw snapshots/events live under each case directory; monitor summaries are observations, not acceptance decisions.

The launcher requires a stable input directory and exactly one batch or explicit case list. Its default is a read-only plan:

```bash
npm run r-projects:launch -- --input temp/r-projects-preflight/catalog --cases R01,R02,R09,R15
```

Creation additionally requires `--create --readiness <file>`. This is an implementation-evidence gate required by the follow-up plan, not a new approval step. The readiness JSON binds `manifestSha256` and the following content-addressed artifacts (`{path, sha256}`, resolved relative to the run directory):

- `finalChecks`: current `commit` plus all four exact final commands, successful exit codes and hashed log references.
- `s09`: current functional acceptance with `status: accepted`, `acceptanceBasis: native-protocol-regression`, current `commit`, a conclusion and a hashed `nativeController`. The existing native verifier checks current source/manifest/package hashes, raw recover/exhaust RPC sequences, authority held during retry, adjacent-turn isolation and actual process stop. `historicalInvestigation` explicitly records `status: evidence-incomplete`, the original invocation and missing logs; this is not historical diagnosis acceptance. The existing complete original-protocol receipt format is also supported if those logs become available.
- `service`: actual running commit/base URL, PID/start ticks, observed Harness version, hashed startup log and build files. The launcher compares the live process identity, health and unchanged build artifacts; HEAD alone is insufficient.
- `cases[code]`: exact payload hash, each fault variant's isolated-controller receipt, and an available real UI observer for R16. Controller receipts name the run/case/variant, executable command and binding rule, and their hashed isolation-test log.

The launcher also rereads the runtime/account catalogs. It requires successful matching gateway/model/Harness protocol and smoke probes from the last 24 hours, with current gateway revision, router compatibility, adapter version and executable fingerprint. Missing or stale evidence blocks the entire selected batch before any POST. Current generated manifests do not have these prerequisites satisfied.

After committing the candidate source and generating its manifest, produce the functional S09 receipt using the existing real-Pi verifier:

```bash
node scripts/r-projects/verify-r16-native.mjs --input temp/r-projects-preflight/catalog --output temp/s09-current-native
```

Use its `functional-acceptance.json` as the hashed `s09` reference, with paths relative to the run directory. The command runs isolated localhost-only Pi regressions and preserves raw evidence; it does not deploy the service or create projects. A new source commit or manifest requires new bound evidence. Service, final-check and current-route requirements still apply.

A project is reused only from this run's accepted receipt. An existing title without provenance is rejected. Before POST, a pending request/payload hash is written and synced; a timeout leaves it pending and never retries automatically. Earlier accepted cases remain registered even when a later case fails. A run-directory lock prevents concurrent launchers. After interruption, inspect the recorded process, pending request and original API/event evidence before resolving the lock/receipt; never clear a project or alter its database to repair the launcher.

No R project has been created by the validation, monitoring or launch tests. Preserve all N-series projects, sessions, worktrees and historical evidence.

While a server is serving this checkout, use `npm run build:check` for build verification. It runs the existing `npm run build` in a fresh snapshot of current tracked source under `temp/build-checks/`, reuses installed packages, and keeps build caches and outputs in that snapshot. Its receipt records source hashes, the build log and before/after hashes of the original `web/dist` and `server/dist`; any change to those original artifacts fails the check. Stage newly added source files first so the snapshot includes them. This verifies the recorded source snapshot; final checks still require a clean committed source tree. Ordinary `npm run build` writes the serving directories and belongs to the service update step.

R12's optional controller requires `OPENFARS_R12_FAULT_DIRECTORY` on the future acceptance server. Use a dedicated operator directory outside every Agent project directory. The ordinary service has no controller configured. After all launch gates pass, the R12 creation is accepted and its first implementer is running, the observer can bind its exact execution and invocation from the monitor:

```bash
node scripts/r-projects/arm-r12.mjs --input temp/r-projects-run --directory temp/r-projects-run/controllers --execution <observed-execution> --invocation <observed-invocation>
```

The command only reads the project API and writes operator evidence. It requires the matching accepted submission/payload, original implementer/epoch, current native activity, child group and initialized repository; it rejects late/reporting/already-merged targets. It does not start or resume projects. The server compares the bound identity on every selected merge, then requires the actual finalized operation and valid PR/local synchronization receipt. It durably saves `<project>.consumed.json` before returning one `TimeoutError` through the existing Agent control tool. This models loss at the **Agent tool return boundary after provider success and local sync**; it does not simulate a GitHub HTTP transport timeout. The Agent's ordinary `github_get_pr` or original-request replay handles the loss. No controller retry, Git mutation or database edit is performed.

An arm does not affect an earlier tool request or another invocation, ownership epoch, Agent, project or PR target. The exclusive consumed file prevents another injection after process restart or concurrent callback; an interrupted file is retained and cannot be cleared to force a pass. If arming misses the selected request, retain that fact as unverified. The saved controller receipt proves where the response was withheld; actual tool traces must separately prove receipt of the error, the Agent's chosen query/replay and absence of duplicate writes. Isolation tests use controlled provider fixtures with the real scoped runtime, journal and control staging, and do not count as R12 live-project acceptance.

```bash
npm run test -w server -- tests/r-fault-controller.test.ts tests/scoped-project-runtime.test.ts tests/agent-git-tools.test.ts
```

R14 uses the same operator-file identity checks and durable once-only latch, with `OPENFARS_R14_FAULT_DIRECTORY` on the future acceptance server:

```bash
node scripts/r-projects/arm-fault.mjs --case R14 --input temp/r-projects-run --directory temp/r-projects-run/controllers --execution <observed-execution> --invocation <observed-invocation>
```

Arm its first implementer while that native invocation is still running and before its report exists. At confirmed native stop, the controller requires the actual merged/synchronized delivery and omits one head association from the normal report-persistence input. It records the original output and SHA-256, head, PR/sync and stop evidence. It never edits the database or replaces the business report. The existing report repair must reopen the retained session and obtain the missing association from the Agent's explicit tools. Repair invocations and other arrivals cannot trigger this fault. The live acceptance evidence must show the initial partial report, the same session/branch/epoch, unchanged output hash and restored head, without repeated business commits or PRs. Controller isolation tests alone leave this acceptance unverified.

R03 uses `OPENFARS_R03_FAULT_DIRECTORY` and the same arming command with `--case R03`. The command additionally requires `sessionPersistence=false`, the initial native model `inputId` and no accepted task completion. In that one initial model turn, `finish_task` receives an explicit controlled rejection with a durably recorded random marker. No successful receipt or memory mirror is fabricated. Repeated attempts in the same model turn remain rejected with that marker; the error asks the Agent to complete any outstanding assigned Git work and return its handoff. The existing missing-action supplement has a different inputId and can call the original finish tool normally. The controller does not create a supplement or retry itself, and cannot invalidate a previously accepted finish receipt if arming loses the race.

R03 acceptance requires native/tool evidence of the first completed model turn lacking finish_task after real Git delivery, a supplemental turn in the retained session recalling the marker, the accepted finish receipt, and no repeated business writes. A model that never returns from the first turn does not pass; existing activity/repair limits remain in force. Isolation tests use a simulated Agent through the real scoped control service and verify a single resident handle, two model submissions and one push/PR/merge sequence. No actual R03 project is armed by those tests.

R04's **registered but unopened preparation** variant uses `OPENFARS_R04_PREPARATION_FAULT_DIRECTORY`. It must be bound before the observed queued implementer arrival gets an execution; for example, the arrival can still be queued behind its group's planning Leader. Use a separate controller directory for this variant:

```bash
node scripts/r-projects/arm-r04-preparation.mjs --input temp/r-projects-run --directory temp/r-projects-run/r04-preparation --arrival <observed-queued-arrival>
```

The command checks accepted creation/payload provenance, the queued arrival ID/sequence/node, active child group and repository. It does not predict or create execution IDs, branches or native invocations. The runner binds those actual identities after its normal reservation and saved base, then throws once before `sessionBegin` or native launch. Ordinary stopped/unopened recording and Leader recovery remain responsible for retry. Evidence must show one arrival/execution, no initial checkout/open, preserved original base and later authorized preparation of that same task. A missed queue boundary stays unverified. This controller does not manufacture dirty files and does not cover R04's separate original-Agent pending-file/closing variant.

All operator arms are published atomically from a synced temporary file, with exclusive creation of the final name. Readers cannot consume a partial arm, and rerunning an arm command never overwrites its earlier registration.

R04's **owned pending file** variant uses a separate `OPENFARS_R04_PENDING_FAULT_DIRECTORY` and the live invocation selector:

```bash
node scripts/r-projects/arm-fault.mjs --case R04 --input temp/r-projects-run --directory temp/r-projects-run/pending-controller --execution <observed-execution> --invocation <observed-invocation>
```

It must be armed on the first implementer's initial model input before that PR merges. After its explicit merge succeeds with a finalized journal and local synchronization, the actual tool return preserves the merge fact and adds one `acceptancePendingFile` request. The Agent uses its ordinary file tool to write the exact new disposable diagnostic; the controller never writes or removes workspace files. Existing files are preserved. The initial handoff leaves it uncommitted so ordinary closing wakes the original session; that Agent chooses its cleanup or lawful delivery. Supplements, later tasks and replays cannot issue another request.

The durable `.consumed.json` proves only that the one request was issued. On Linux the initial model-return observer checks the exact open file descriptor, content and trusted Git pending-path observation, then saves a separate exclusive `.observed.json` with its hash. Missing, changed, already committed or ignored files do not count as pending-file observation. Preserve interrupted receipts; do not delete them to force reinjection. Neither receipt proves the Agent received the tool response, completed closing, or preserved FIFO: require actual tool/native/arrival traces. Both R04 variants must use independent registered projects and controller directories. No R04 controller is armed by these tests.

R11 uses `OPENFARS_R11_FAULT_DIRECTORY` on the future acceptance server and independent registered projects/directories for its two variants. Arm the observed **first queued implementer arrival**, before any implementer execution is reserved:

```bash
node scripts/r-projects/arm-r11.mjs --input <registered-run-directory> --directory <r11-controller-directory> --arrival <observed-queued-arrival> --variant gateway-error-once
```

Use `--variant gateway-unavailable` in the independent persistent variant. The command only reads the project API and saves operator files. It checks accepted creation/payload, queue sequence/node/group, initialized repository and the captured gateway/model/Harness/protocol/delivery mode. It saves an endpoint hash, never the gateway key. Missing the queue boundary remains unverified; no predicted execution/invocation IDs, database writes or project restarts are used to force the test.

At the initial resident model turn, the scoped runtime binds the actual execution/epoch/invocation/inputId and creates an invocation-only model transport. The proxy's ordinary model POST and buffered model POST use it through their **existing** two-attempt retry and required-tool-choice fallback. Model discovery, Web Search, unrelated models, other projects, supplements and later epochs are outside the boundary. A late arm cannot change an already opened route. The transient variant durably claims one synthetic 503 before upstream dispatch; the persistent variant returns that 503 on each attempt of the same initial route, including re-opening that exact binding. Native retries and ordinary scoped escalation remain responsible for recovery; the controller never retries or switches model.

The exclusive `.consumed.json` binds the fault **before** returning the synthetic response; it does not prove the response was delivered. The invocation's `R11 controlled model transport response` trace records each returned attempt with identities and status, without keys, prompts or provider output. Preserve incomplete receipts. Acceptance additionally needs actual native/proxy error and success/exhaustion traces, the unchanged configured model and retained session/branch, real stop facts, and existing Leader/Main escalation. Local HTTP/proxy and simulated Agent tests verify isolation and wiring only; neither variant is armed or accepted by those tests.

R16's native fixture readiness is generated from a clean committed checkout with the installed Pi CLI, private temporary sessions/configuration and a localhost-only provider. It does not use the project's model account:

```bash
node scripts/r-projects/verify-r16-native.mjs --input <validated-run-directory> --output <new-evidence-directory>
```

The output directory must not exist. The command runs both native retry recovery and exhaustion, saves the raw RPC frames, the process identity and held authority observed during backoff, concurrent-turn/pause rejection, adjacent-turn result, native session hash and actual process-stop proof. The controller receipt binds the current commit, manifest/payload, installed Pi version and relevant package bytes to hashed observations/logs. Launch readiness rereads those raw facts and installed package hashes; changed source, manifest, package, early release, live/foreign process stop or missing adjacent-turn evidence fails validation. A subsequent source commit requires regenerating this proof. Existing S09 and all other launch prerequisites still apply. This receipt proves isolated fixture readiness only; it cannot accept the original N03 invocation or the R16 project's running UI.

R16 browser availability also requires a real independent Chromium process:

```bash
node scripts/r-projects/probe-r16-browser.mjs --input <validated-run-directory> --output <new-browser-evidence-directory> --module <absolute-playwright-index.mjs> --executable <absolute-chromium-executable>
```

Install Playwright/browser and any required libraries in an isolated operator directory. If private libraries are needed, set `LD_LIBRARY_PATH` for that command; the receipt records the required environment without model credentials. The probe loads only a local capability fixture, performs an actual click and pointer drag, observes moving SVG geometry, and saves a screenshot plus observations. It writes an `available` observer receipt only from a clean committed checkout after successful browser interaction, binding manifest/payload/commit and browser executable/module hashes. Launch readiness reads the artifacts and rejects an unsubstantiated `available` flag. This proves the browser can observe a future project; it **does not** accept R16's real invocation counts, nested groups, modal dragging, selected-edge direction or agreement with runtime events. Those observations require the actual registered R16 project on the verified updated service after all existing prerequisites pass.
