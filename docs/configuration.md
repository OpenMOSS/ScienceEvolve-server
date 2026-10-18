# Setup and configuration

**English** | [简体中文](./configuration_zh-CN.md) | [← Back to README](../README.md)

For a first local task, follow the README's [quick start](../README.md#quick-start). This guide covers complete installation, gateways, Agents, Workflows, Git collaboration, experiment resources, and production deployment.

[Installation](#quick-start) · [Gateways](#global-gateways) · [Git collaboration](#github-accounts-and-git-collaboration) · [Workflow](#workflow) · [Production](#production)

## Quick start

### 1. Requirements

- Node.js 24 or later. Collaboration's authoritative SQLite state requires Node 24.
- npm 10 or later.
- Executable Codex and [Inspire CLIs](../.agents/skills/inspire/references/setup/install-and-config.md#1-安装). SII experiments also require account and project initialization.
- At least one working model gateway.
- Git when enabling Git collaboration.

At startup, Server resolves the Inspire executable and reads the default Codex version. Codex can use the bundled installation or an external executable selected by an environment variable; Inspire is discovered on `PATH` by default. The current startup entry requires an available Inspire CLI even when no SII experiment is planned. Configure SII accounts, Projects, and resource context before using the experiment tools.

### 2. Install dependencies

Install the Web and Server dependencies:

```bash
npm ci
```

Install the required bundled Codex Harness:

```bash
npm ci --prefix harness/codex
```

Install other Harnesses as needed:

```bash
npm ci --prefix harness/dsh
npm ci --prefix harness/pi
npm ci --prefix "harness/claude code"
```

If a CLI is already installed, you can skip its bundled installation and configure its absolute path in `.env`.

### 3. Create the configuration

For a new installation without a root `.env`, run the command below. For an existing installation, update the required variables in the existing file.

```bash
cp .env.example .env
```

Leave `SCIENCEEVOLVE_CODEX_BIN` empty when using the bundled Codex and complete the Harness installation above. Setting it to `codex` selects discovery on `PATH`. Before using SII, set `SCIENCEEVOLVE_INSPIRE_WORKSPACE_ROOT` to an absolute directory containing the actual Agent workspaces. With the default `SCIENCEEVOLVE_DATA_DIR=./data`, use the absolute repository root printed by `pwd` there. If the data directory is outside the repository, use its actual parent directory.

Minimal configuration example:

Fill in GitHub OAuth settings only when using Web Git collaboration. First register an OAuth App as described under [GitHub accounts and Git collaboration](#github-accounts-and-git-collaboration), then enter its real values. Leaving these settings empty allows ordinary projects to start, with GitHub sign-in disabled. Configure the model gateway API key separately from the GitHub OAuth Client Secret.

```dotenv
HOST=127.0.0.1
PORT=4311
SCIENCEEVOLVE_DATA_DIR=./data

# Usually unnecessary after installing bundled Codex; use an absolute path for an external CLI.
# SCIENCEEVOLVE_CODEX_BIN=/absolute/path/to/codex
SCIENCEEVOLVE_INSPIRE_BIN=inspire

# These can remain empty; configure the gateway library after startup.
AIGW_BASE_URL=https://example.com/v1
AIGW_API_KEY=
SCIENCEEVOLVE_MODELS=model-a,model-b

# Configure a GitHub OAuth App for the Git account library; local development allows a loopback callback.
SCIENCEEVOLVE_GITHUB_OAUTH_CLIENT_ID=
SCIENCEEVOLVE_GITHUB_OAUTH_CLIENT_SECRET=
SCIENCEEVOLVE_GITHUB_OAUTH_CLIENT_SECRET_FILE=
SCIENCEEVOLVE_GITHUB_OAUTH_CALLBACK_URL=http://127.0.0.1:5173/api/github/auth/callback
```

### 4. Start development

```bash
npm run dev
```

- Web: <http://127.0.0.1:5173>
- API: <http://127.0.0.1:4311>
- Health check: <http://127.0.0.1:4311/api/health>

### 5. Check before the first run

| Check | Action and expected result |
| --- | --- |
| API and frontend proxy | Open `http://127.0.0.1:4311/api/health` and `http://127.0.0.1:5173/api/health` in the browser. Both should return JSON containing `"status":"ok"`. Failure at the second address means the frontend is not forwarding `/api` correctly. |
| Harness | Check that the CLI selected for the project is available on the gateway page. External paths must point to real executables. |
| Model | Save the actual gateway, API key, model, and reasoning options, then test the connection and the actual Harness/model combinations. Saving a URL or passing a health check does not establish model readiness. |
| Git collaboration | When needed, finish OAuth App configuration, Web sign-in, and account verification below, then select that account for the project. Skip this for projects without Git. |
| Project resources | Check each Agent's gateway, model, Harness, Skills/MCP services, and inputs. Workers using SII must also select the experiment tools and complete platform initialization. |

## Configuration

Configure in this order: server environment → global gateway → GitHub account, if needed → Harness → Agent → Workflow.

### Server environment

Use the repository root `.env` consistently. When started through npm workspace scripts, Server first checks `server/.env`; if it exists, that file takes precedence over the root `.env`. Existing process environment variables may also override file values. Restart the service after changes and check for other configuration sources that override the intended values. Pass Vite's `SCIENCEEVOLVE_WEB_HOST`, `SCIENCEEVOLVE_API_URL`, and `SCIENCEEVOLVE_WEB_BASE` through the startup process environment, as shown under [Frontend and reverse proxy](#frontend-and-reverse-proxy).

| Variable | Default | Description |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Listening address for the API and production Web UI. |
| `PORT` | `4311` | Listening port for the API and production Web UI. |
| `SCIENCEEVOLVE_DATA_DIR` | `./data` | Persistent root for projects, gateways, presets, user Skills, and run traces. |
| `SCIENCEEVOLVE_CODEX_BIN` | Bundled Codex or `codex` | Codex executable; use an absolute path for an external installation. |
| `SCIENCEEVOLVE_INSPIRE_BIN` | `inspire` | Inspire CLI path or command name. |
| `SCIENCEEVOLVE_SII_REFRESH_MS` | `30000` | CPU/GPU experiment polling interval in milliseconds; polling backs off on errors. |
| `SCIENCEEVOLVE_MODELS` | Built-in suggestions | Comma-separated model suggestions, also used for initial AIGW gateway setup. |
| `SCIENCEEVOLVE_AGENT_CONCURRENCY` | `10` | Maximum concurrent calls in each shared Main and Worker queue. Git collaboration projects use their own management and Worker queues. |
| `SCIENCEEVOLVE_RETRY_BASE_MS` | `2000` | Initial retry backoff. |
| `SCIENCEEVOLVE_RETRY_MAX_MS` | `60000` | Maximum retry backoff. |
| `SCIENCEEVOLVE_DSH_HANDSHAKE_TIMEOUT_MS` | `60000` | DSH initialization, prompt acknowledgment, and shutdown handshake timeout; does not limit total turn duration. |
| `SCIENCEEVOLVE_DSH_TURN_IDLE_TIMEOUT_MS` | `1200000` | Inactivity window for a normal DSH Adapter turn with no native events. |
| `SCIENCEEVOLVE_RESIDENT_MODEL_INACTIVITY_TIMEOUT_MS` | `1200000` | Shared inactivity window while resident Harnesses await valid model/provider activity. |
| `SCIENCEEVOLVE_RESIDENT_TOOL_INACTIVITY_TIMEOUT_MS` | `7200000` | Shared inactivity window for active tools in resident Harnesses with no valid updates. |
| `SCIENCEEVOLVE_PROTOCOL_PROXY_TIMEOUT_MS` | `1200000` | Inactivity timeout for one upstream protocol-proxy request; SSE frames reset the timer. |
| `SCIENCEEVOLVE_INTERRUPT_FORCE_TIMEOUT_MS` | `8000` | Wait before forced cleanup of an interrupted call. |
| `SCIENCEEVOLVE_MAX_EVENT_HISTORY` | `10000` | Maximum events in a normal project snapshot; SSE can still recover the full history. |
| `SCIENCEEVOLVE_GITHUB_OAUTH_CLIENT_ID` | Empty | GitHub OAuth App Client ID. When empty, accounts remain viewable but sign-in is disabled. |
| `SCIENCEEVOLVE_GITHUB_OAUTH_CLIENT_SECRET` | Empty | Server-side GitHub OAuth App Client Secret; never sent to the browser. |
| `SCIENCEEVOLVE_GITHUB_OAUTH_CLIENT_SECRET_FILE` | Empty | File containing the Client Secret, used when the inline Secret is unset. |
| `SCIENCEEVOLVE_GITHUB_OAUTH_CALLBACK_URL` | Empty | Full OAuth callback URL, with the browser page's origin and path `/api/github/auth/callback`. Production requires HTTPS; local loopback HTTP is allowed. |

Keep real credentials out of committed `.env` files. `SCIENCEEVOLVE_DATA_DIR` contains gateway credentials, research materials, and run logs and should also be treated as sensitive.

The Agent queue dashboard reads both shared queues and Git project scheduling state. It counts actual parallel calls and shows running, waiting, and awaiting recovery. Git project concurrency limits are displayed separately; historical process records and current model calls do not count twice.

### Global gateways

There are two configuration routes.

#### Option 1: Configure in the UI (recommended)

After startup, open “全局网关库” (global gateway library):

1. Click “新增网关” (add gateway).
2. Enter a display name, HTTPS endpoint, and API key. Connect to the relevant VPN or private network first when required.
3. Select the gateway's actual protocol: Responses, Chat Completions, or Anthropic Messages.
4. Refresh or manually add available models. Set each model's context length, defaulting to 256K with a maximum of 1M, then choose a default model.
5. Save and click “测试连接” (test connection).
6. Run “验证全部 Harness / model” (validate all Harness/model combinations) to check the combinations required by the project.
7. Set the gateway as default if desired.

The selected `Harness + gateway + model` configuration is validated before project startup. When the Harness and gateway use different native protocols, the runtime routes between them automatically. Missing, failed, or stale connection tests produce a warning; configuration can still be saved, recommendations generated, and execution attempted. Actual call failures are reported.

Each Gateway can declare a reasoning parameter path and candidate values per model, from which the Agent selects an option. Supported paths are `reasoning_effort`, `reasoning.effort`, `chat_template_kwargs.reasoning_effort`, and `thinking.effort`. If no option is selected, the parameter is omitted. Changes to mappings, candidates, or the Gateway revision invalidate old combination probes. Revalidate with the new option or attempt execution directly. Gateway reasoning and the Harness-native `reasoningEffort` are separate fields; Main cannot change either through dynamic reconfiguration.

Gateway endpoints must use HTTPS on port 443. Public and RFC1918 private addresses are accepted; private gateways require network access from the machine running ScienceEvolve. Loopback, CGNAT, link-local metadata, multicast, documentation, benchmark, other reserved addresses, and DNS results mixing public and private addresses are rejected. Saving checks URL format; connection tests and startup checks verify actual network and protocol compatibility.

#### Option 2: Initialize from environment variables

```dotenv
AIGW_BASE_URL=https://gateway.example.com/v1
AIGW_API_KEY=replace-with-real-key
SCIENCEEVOLVE_MODELS=model-a,model-b
```

When `AIGW_API_KEY` is nonempty and `${SCIENCEEVOLVE_DATA_DIR}/gateways.json` does not yet exist, Server creates an AIGW system gateway. Once the library has been written, persisted UI records take precedence. Later `.env` changes do not overwrite gateways the user edited or deleted.

### GitHub accounts and Git collaboration

The research artifact browser follows file and publication records, including shared files and authors who have left the current Workflow. Git artifacts are read from the commits recorded at publication, so cleaning up execution worktrees does not affect published content. Historical versions at the same path retain their own publication IDs and commit checks. Final results also show accepted Git handoff summaries. If a completed project has no explicit display list, published artifacts are listed with their provenance; unaccepted workspace files are excluded from final delivery.

Web Git collaboration uses a **GitHub OAuth App and user authorization**. The deployment owner registers the App once. Site users sign in with their own accounts through “GitHub 账号库” (GitHub account library) and do not need separate Apps. When hosting your own deployment, configure an App for your access URL. SDK Git uses host-provided credentials; see [SDK GitHub authentication](https://github.com/OpenMOSS/ScienceEvolve#github-authentication-and-git-collaboration).

#### 1. Register an OAuth App as the deployment owner

Sign in to the GitHub account used to manage the deployment and open **Settings → Developer settings → OAuth Apps → New OAuth App**, or use the [OAuth App registration page](https://github.com/settings/applications/new). The current implementation uses OAuth Apps. See [GitHub's official instructions](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app).

Enter an Application name, such as `ScienceEvolve Local`, and choose the Homepage URL and Authorization callback URL for the actual deployment:

| Deployment | Homepage URL / browser address | Authorization callback URL |
| --- | --- | --- |
| Local development, `npm run dev` | `http://127.0.0.1:5173` | `http://127.0.0.1:5173/api/github/auth/callback` |
| Local production, `npm start` | `http://127.0.0.1:4311` | `http://127.0.0.1:4311/api/github/auth/callback` |
| Public HTTPS deployment | `https://research.example.com`, replaced with your actual site | `https://research.example.com/api/github/auth/callback` |

Copy the **Client ID**, then generate and save a **Client Secret** from the App details. These identify the application. A GitHub password, PAT, or model API key cannot replace the Client Secret. The service uses a browser authorization callback and does not require Device Flow.

#### 2. Configure Server and restart

Enter the App's real values in the root `.env`. This example uses the development frontend address:

```dotenv
SCIENCEEVOLVE_GITHUB_OAUTH_CLIENT_ID=YOUR_OAUTH_APP_CLIENT_ID
SCIENCEEVOLVE_GITHUB_OAUTH_CLIENT_SECRET=YOUR_OAUTH_APP_CLIENT_SECRET
SCIENCEEVOLVE_GITHUB_OAUTH_CALLBACK_URL=http://127.0.0.1:5173/api/github/auth/callback
```

Alternatively, save the Client Secret in a server-readable plain-text file. Leave the inline Secret empty and set `SCIENCEEVOLVE_GITHUB_OAUTH_CLIENT_SECRET_FILE=/absolute/path/to/client-secret`. Restart Server after changes. The Client Secret belongs only on the server; keep it out of frontend configuration and Git commits.

**Keep the browser address, `.env` Callback URL, and the App's Authorization callback URL aligned.** This project requires the callback to share the browser page's origin. `localhost` and `127.0.0.1` are different origins, as are ports 5173 and 4311. Development callbacks pass through Vite: a browser on port 5173 must use the port 5173 callback rather than the separate API port 4311. For remote access, use the actual HTTPS site. Notebook and subpath proxies must preserve the full browser-accessible prefix and forward the callback to Server.

#### 3. Sign in and verify the user's account

Open “GitHub 账号库” (GitHub account library), click “登录新账号” (sign in with a new account), allow the popup, and authorize the GitHub account that will execute the project. ScienceEvolve requests the classic OAuth `repo` scope for personal repositories and PR operations. It does not request `workflow`/Actions permission; see [GitHub OAuth scopes](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps). After returning, confirm that the account appears with healthy authorization, then run account verification.

Open the site's `/api/github/accounts` to inspect `oauthConfigured`. A value of `true` only means all three server configuration values are present. **Successful sign-in and account verification complete the authentication check.** Projects without Git can start without OAuth configuration.

The account library supports multiple accounts, authorization verification, and a default account. A new Git-enabled project must explicitly select a healthy account. Enter a repository name and choose Private, the default, or Public in the form or canvas dialog. The repository is created only after project startup. If the library is empty, the UI preserves the draft and opens sign-in. Projects bind to the account's numeric GitHub user ID, so a login rename does not change the binding. They do not silently fall back to the server process's Git credential helper. Historical Git projects without a binding wait at `git:waiting_for_github`.

Access and refresh tokens are stored only on Server, encrypted with AES-256-GCM in `${SCIENCEEVOLVE_DATA_DIR}/github-accounts.json`. The local key is `github-accounts.key` in the same directory with mode `0600`. Account lists, project snapshots, logs, and browser APIs do not return tokens. An account still bound to a project cannot be removed from the local library. Removing an account deletes only local authorization records; it does not delete GitHub repositories or revoke the OAuth grant on GitHub.

#### Troubleshooting

| Symptom | What to check |
| --- | --- |
| Sign-in disabled / OAuth not configured | Check Client ID, Secret or Secret file, Callback URL, the Server restart, and overrides from `server/.env` or the process environment. |
| Callback mismatch / sign-in restricted to the callback's site | Compare the browser origin, App settings, and `.env` with the table above. Update both callback settings when switching development/production ports. |
| Popup does not open | Allow popups for the current site and retry. |
| Invalid Client Secret / authorization exchange failure | Use the Client ID and Secret from the same App. Check the Secret file and server access to `github.com` and `api.github.com`. |
| Expired sign-in session | Start again from the account library. Avoid restarting Server during authorization; sessions expire after 10 minutes. |
| Waiting for GitHub / 401 / 403 | Reauthorize and verify the account, then check the project binding, `repo` scope, and new repository name. |

### Harness

| Harness | Native protocol | Bundled directory | External executable variable |
| --- | --- | --- | --- |
| Codex | OpenAI Responses | `harness/codex` | `SCIENCEEVOLVE_CODEX_BIN` |
| DSH | OpenAI Chat Completions | `harness/dsh` | `SCIENCEEVOLVE_DSH_BIN` |
| pi | OpenAI Chat Completions | `harness/pi` | `SCIENCEEVOLVE_PI_BIN` |
| Claude Code | Anthropic Messages | `harness/claude code` | `SCIENCEEVOLVE_CLAUDE_CODE_BIN` |

Use absolute executable paths for external Harness installations. `SCIENCEEVOLVE_HARNESS_ROOT` can point to a custom root containing `codex/`, `dsh/`, `pi/`, and `claude code/`. With a custom root, explicitly setting `SCIENCEEVOLVE_CODEX_BIN` is still recommended.

After configuration, check Harness availability on the gateway page. Use the gateway matrix to run the protocol route probe and actual Adapter smoke probe. A combination is verified when both pass and its cached identity still matches the current Gateway revision, Adapter version, and executable. Test status is advisory and does not prevent an execution attempt. See the [Harness runtime overview](../harness/README_en.md) and [adding a Harness](adding-a-harness-en.md).

Harness availability is published separately for each Catalog capability. Workflow support does not automatically make a Harness available in Project Explainer. Explainer supports Codex, pi, and DSH, defaulting to Codex. Claude Code compatibility data is retained, but it is no longer selectable there. The interactive assistant's native Harness keeps files read-only and disables Shell and browser access. Only the dedicated product MCP is injected for the current turn, allowing context reads, draft edits and saves, undo, and Workflow change submissions for existing projects. Independent configuration recommendation calls still disable all MCP services. Switching Harness recreates the native session while preserving Explainer history.

### Agent

Configure each Agent on “新建项目” (new project) or the Workflow canvas:

| Setting | Purpose |
| --- | --- |
| Harness | CLI that executes the Agent. |
| Gateway and model | Select from the global gateway library. Unverified combinations show a warning and can still be attempted. |
| Harness reasoning level | `low`, `medium`, `high`, or `xhigh`, passed to the selected Harness. |
| Gateway reasoning | Select a candidate from the Gateway/model configuration; omission sends no upstream parameter. |
| Prompt | Complete responsibilities, input constraints, and output requirements. |
| Fixed Skills | Loaded on every call. |
| Automatic Skills | Available as candidates for the Agent to select for the current task. |
| MCP | Streamable HTTP MCP services connected on each call. |
| Permission | Task workspace (`workspace`), project workspace (`compute`), or native full access (`yolo`). |
| Web Search | Whether a capable Harness may search the Web. |
| Session persistence | Whether a Worker reuses its thread within the project. Main always persists. |
| Weak-edge decision | Main or the current Worker decides ordinary weak branches; Main decides its own branches. |

`main` is the sole required Agent in each project and cannot be deleted or renamed. It handles project scheduling, user input, recovery, and completion decisions. Each Main turn uses a server-generated capability snapshot: `autonomous` can schedule any ordinary Agent, while `weak-branch` can select only that turn's candidates. Completion, user intervention, and reconfiguration are separately controlled by the snapshot. After startup, the direct configuration-update API remains locked. Users may submit allowed changes through the dedicated Workflow update mechanism (see [Project Explainer](#configuration-recommendations-and-project-explainer)). For autonomous Main reconfiguration, “允许 Main 动态重配置（高级权限）” (allow Main dynamic reconfiguration, advanced permission) must also be explicitly enabled before creation; permitted Main turns then submit whitelisted changes through the generated `workflow.json`. The switch defaults to off and cannot be toggled by Main.

### Workflow

#### Reuse repository workflows manually

The [example/](../example/README_en.md) index presents 21 workflow examples as source and documentation. The application does not display or automatically load them, register their Skills, or package them in the Server build. Select the JSON, requirement, and resources you need and configure them yourself.

Original SDK files contain top-level Git deployment settings, and some older workflows omit the Web orchestration version. Export a separate copy on the Server host from the repository root: `node example/export-web-workflow.mjs example/aris/workflow.json /tmp/aris.web.json`. Use the homepage's existing generic importer to inspect and load it. The script resolves local relative Skill paths and preserves the research protocol without changing the original.

Paste requirements separately, and select model gateways and Git accounts manually. Re-export or update Skill paths when moving between machines; experimental dependencies are not installed automatically. See [manual usage](../example/README_en.md#manual-use-in-web) and the [README tutorial](../README.md#tutorial).

#### Import an SDK configuration manually

The homepage's “Agent 配置预设” (Agent configuration presets) can import one SDK `workflow.json`, up to 1 MB with UTF-8 BOM support. Import saves the original in the library and opens a read-only preview of Agents, edges, and raw JSON. The original can be downloaded or the entry deleted. Load an imported entry through the homepage quick-start selector or saved canvas workflows to create an editable copy. Save changes as a new configuration; the original stays immutable.

The preview preserves SDK Main routing and session settings and shows the server's actual Harness catalog without executing resources. Quick-start copies are converted to Web scheduling rules, including Main routing and session constraints, and are not guaranteed equivalent to the SDK CLI. Before startup, select a Web gateway for every Agent and check models, Harnesses, Skills, and MCP services. Gateways are not automatically imported from SDK environment variables or profiles. A failed import leaves existing presets and the current draft intact. The new-project page has no import entry; saved ordinary configurations can be reused there.

The Workflow canvas configures:

- The Agent receiving the first user input.
- Strong and weak edges between Workers.
- Loops formed by closing a valid path of strong edges, with iterations per batch and an exit target.
- The Agent that triggers completion evaluation.
- Whether a non-Main terminal Agent may complete automatically using natural-language conditions.
- Whether autonomous Main may reconfigure dynamically, an advanced permission disabled by default.
- Node positions, ports, and layout.

A strong edge proceeds directly to its single target. Multiple weak edges define candidates selected by the configured decision maker. New Agents and template copies do not automatically receive outgoing edges; connect them manually. System-managed Main-to-Worker dispatch edges are unaffected. Main verifies completion by default. A non-Main terminal Agent receives limited completion capability only when automatic completion is explicitly enabled and it is in a valid terminal context; this does not grant general routing or advanced permissions.

A Loop adds no node. When a new strong edge closes a valid cycle of ordinary Agents, it becomes the `from -> to` return edge and the canvas writes `orchestration.loops[]`. All strong edges in one Loop share a color; different Loops and ordinary strong edges are distinguished. Click any member edge to select the Loop and edit its ID, iterations per batch, and exit target on the right. A selected edge shows its own direction marker; a selected Loop shows markers on all member edges and the virtual exit edge while other edges fade. `from -> exitTo` is a read-only batch exit edge, dashed like a weak edge but differently colored. Its marker indicates direction, not an exit on every iteration. Breaking the cycle removes its Loop configuration; invalid cycles are rejected and Agent renames update references. The runtime canvas shows batch, iteration, and total. Pause, resume, retry, and ordinary reconfiguration preserve counters. Returning to Main after exhausting a batch does not bypass the original termination condition.

Agent scripts use the service's shared startup environment. Agent proxy fields in old files are ignored when read; new configuration offers no per-Agent proxy selection.

With advanced permission enabled, permitted autonomous Main turns receive a `workflow.json` proposal containing `orchestration`, editable Agent fields, Project Skills/MCP services, read-only `lockedRuntime`, editing instructions, and a `baseHash` protecting newer state. Main may edit Agent membership, input, routing, Loops, termination, result format, user intervention, instructions, model, Harness, configured `gatewayId`, Skills, MCP services, SII tool selection through `experimentMcp`, and weak-edge decision ownership through `decisionBy`. Permission, Web Search, session persistence, Harness reasoning, Gateway reasoning, credentials, runtime snapshots, and the authorization switch remain locked. Accepted Project Skill/MCP definitions are immutable; change content by adding a new definition name and updating Agent references.

After editing, Main must call `apply_workflow` as the turn's sole terminal control action. Server validates the complete document, references, graph, and runtime capabilities, then commits atomically through the invocation journal. A stale base hash or any validation error preserves the previous state with no partial application. On success, the accepted configuration is saved and scheduling continues. Subsequent calls load it according to runtime session-continuity rules. Reconfiguration can be submitted again whenever a later Main capability snapshot permits it.

Changing an existing Agent's `template` changes only its high-level role label. It does not reset the Harness, permissions, or other runtime settings to template defaults. Configure execution capabilities before startup. Template defaults apply only to newly added Agents.

### Skills and MCP

All workflow Agents, including Main, Workers, and resident collaboration Agents, automatically receive the built-in `scienceevolve-sleep` stdio MCP. It supports Codex, Claude Code, DSH, and pi without manual Agent configuration. `sleep({ "duration_ms": 1000 })` accepts an integer from 1 to 43200000 milliseconds, up to 12 hours, matching Codex's built-in sleep range, and returns requested and actual duration. MCP cancellation and connection closure cancel the wait. Immediate user interruption cancels it; queued messages follow normal scheduling. Codex's built-in sleep MCP has a sufficiently long call timeout. Sleep pauses only the current tool call and does not change workflow state or end an Agent turn. Project Explainer and configuration recommendations do not receive it. `scienceevolve-sleep` is reserved and cannot be overridden by custom MCP services.

Run `npm run smoke:sleep-mcp -w server` to build and launch a real sleep MCP subprocess. The official MCP client checks one- and three-second waits, concurrency, cancellation, argument validation, and process shutdown. No model gateway or credentials are needed.

Skills are merged from:

- Built-in project Skills: `.agents/skills`.
- User-created Skills: `${SCIENCEEVOLVE_DATA_DIR}/skills`.
- User directories: `~/.agents/skills` and `${CODEX_HOME}/skills`.
- Additional directories: `SCIENCEEVOLVE_SKILL_ROOTS`.

Separate extra directories with the OS path delimiter: `:` on Linux/macOS and `;` on Windows. Each Skill directory must contain `SKILL.md`.

Custom MCP services use a name and HTTP(S) URL, with up to 32 entries per Agent. System MCP names and URLs are fixed. If the deployment provides system MCP credentials, configure:

```dotenv
SCIENCEEVOLVE_FIXED_MCP_TOKEN=replace-with-system-mcp-token
```

This credential is injected only into calls that actually select the system MCP.

Workflows can also define Project Skills and Project stdio MCP services. A Project Skill is a complete text-file mapping with a nonempty `SKILL.md`, assigned using `project:<name>`. A Project MCP stores source, entrypoint, command/args, and `envFrom` references to host environment variable names; assign it with `{ "name": "...", "project": "definition-name" }`. Edit definitions in “项目级 Skill 与 MCP” (project-level Skills and MCP) on the new-project page. Server validates them on save or start, with no partial application on failure. Preconfigured resources work with advanced permission off. With it on, Main can add definitions and change assignments; same-name rewriting, replacement, or deletion of accepted definitions is rejected.

### Configuration recommendations and Project Explainer

In “新建项目 → 01 研究任务” (new project → research task), “推荐配置” (recommend configuration) uses the selected advisor model and gateway. It takes the project name, requirements, intended use, and current files/images in `user_inputs/` to generate a complete draft and warnings. Supported attachments are UTF-8 text, DOCX, XLSX, PPTX, PDF, and PNG/JPEG/GIF/WebP. Unreadable or oversized attachments produce an explicit error. Recommendations use no tools, modify no project, and do not start execution. Results populate the editable form only after normal Workflow/Harness/Gateway/Skill/MCP validation.

The recommendation dialog shows preparation, generation, validation, and application stages with elapsed time. It supports cancellation and retry. On success, it fills the Agents and complete Workflow, runs layered canvas layout and cleanup, and lists actual changes in the same dialog. It also reports when execution orchestration was unchanged. Disabling Main workflow adjustment restricts runtime changes, not recommendation-stage design.

Project lists and details estimate progress from the current outer Workflow node: progress equals the shortest distance from entry to the current node divided by that distance plus the shortest distance to completion. Branches use shortest reachable paths, Loop returns may lower progress, and each collaboration group counts as one node. Call counts, time, and Explainer suggestions do not affect the percentage. Incomplete projects are capped at 99%; confirmed completion is 100%. For A → B → C → D → end, progress is 0%, 25%, 50%, 75%, and 100%.

The homepage, new-project form and canvas, and project details share a floating Project Explainer assistant. It runs as a native Agent of the selected Harness and decides tool calls and discussion order. Users can adjust Workflows, collaboration groups, and Agent Harness/model/prompt settings in natural language. Creating a project through the assistant saves only a research draft on the homepage and provides an entry for the user to inspect and start it. Its tools cannot start research or create Git repositories. Draft navigation and user-started projects retain the same conversation and history, shared with the existing details panel.

The assistant and details panel share Harness execution traces. Visible replies, public reasoning summaries, and tool statuses update from events; arguments, result previews, and failures can be expanded, and refresh restores the same history. Only content explicitly published as a summary is shown as one. Without a public summary, the UI shows analysis status; internal reasoning remains an activity signal with no body displayed.

Set the assistant's Harness, gateway, model, and reasoning level in the floating panel. Manual edits made during a change are not automatically overwritten. Repeated actions do not duplicate drafts, and conflicting saves across windows require a fresh read. Changes to running projects use the existing Workflow update mechanism, preserving the base version and safe application timing. Native filesystem access remains read-only. Shell, Skill execution, business MCP services, and Web Search are disabled; only dedicated product tools are allowed. A Harness unable to enforce read-only access is rejected. Switching Harness changes the native Session while retaining product history. Only one turn may be active per conversation. Explainer explains progress; the system calculates it from Workflow position.

### Workspaces and artifact integrity

Without Git collaboration, Main and all Workers share the business workspace and `Memory.md` under `${SCIENCEEVOLVE_DATA_DIR}/projects/<project-id>/workspaces/`. Sessions, logs, and invocation temporary directories remain isolated. Git projects use isolated worktrees, publication, and integration according to their scoped Workflow; see [scoped collaboration workflows (v3)](openfars-collaboration/scoped-workflow-v3-en.md). Historical `<agent>/shared/` files remain in place without automatic merging or overwriting.

For a new task, select files, images, or folders, or click “打开目录” (open directory) on the host to add materials directly to temporary `user_inputs/` through Windows Explorer, macOS Finder, or Linux `xdg-open`. This requires a graphical desktop session on the service host; file/folder upload remains available if opening fails. The list initially shows up to five files or top-level folders and can be expanded. It refreshes after upload or returning from the file manager. Filenames, duplicate uploads, and deletion follow the host filesystem's rules and case sensitivity. On creation, files enter the shared workspace's `user_inputs/`, where more files can be added later. All Agents can read them. Originals are reference material and are not automatically published. Limits are 50 MiB per file, 1000 files and 200 MiB per upload.

`publish_artifact` records path, size, producer, invocation, media type, mtime, and SHA-256. Preview, selection, reading, and downloading recheck integrity. Modifying a published file causes an integrity error and requires the producer to publish it again. Old records without hashes remain legacy/unverified.

### Execution permissions

| Permission | Behavior |
| --- | --- |
| Task workspace (`workspace`) | Allows changes in the current task's assigned trusted directory. Other directories follow their actual read-only grants. |
| Project workspace (`compute`) | Allows changes in the current task and registered project directories, excluding other projects and protected system directories. |
| Native full access (`yolo`) | Uses the selected Harness's native permission mode, subject to OS and invocation constraints. |

These compatibility identifiers describe file modification scope. Leader, coordination, and terminal reconciliation calls retain their role-specific authority. Renaming labels changes neither directory permissions nor completed projects. Skills and business MCP services are configured separately.

Main defaults to `yolo`; Workers can be configured individually. Experiments require all three layers:

1. Select “SII 实验工具” (SII experiment tools), or `experimentMcp: true`, for the actual execution Worker and use an MCP-capable Harness. Without selection, tools are not injected. Main, Leader, coordination, and terminal reconciliation turns do not receive them.
2. Agents use `sii_read_knowledge` as needed for Inspire resource selection, submission, acceptance, and cleanup. New Execution templates do not need `builtin:inspire`; existing projects can retain it.
3. The OS user running Server has completed Inspire/SII account authentication, project discovery, and resource-context initialization.

File permissions and experiment selection are independent. All three permission levels can explicitly select experiment tools, which do not expand directory authority. Setting `compute` or `yolo` alone grants no SII tools, login, or reserved resources; Agents submit resources for the actual task.

Long experiments use `sii_submit_experiment`, which returns immediately while Server monitors results in code. An Agent may continue independent work or call `sii_defer_task` to save continuation context and finish the current turn. Runtime retains the unfinished task, releases its model scheduling slot, and resumes the same native session after experiment success or failure. Completion and onward routing are rejected while required experiments remain unfinished or unacknowledged. Notebook/Ray/Serving jobs must atomically write a completion marker with the current `request_id` and exit code; a resource's RUNNING status does not establish experiment completion.

Full CLI operations use `sii_command`; batch submissions are individually registered through `sii_submit_batch`. Agents request logs, resources, retries, and cleanup as needed. The system does not make research or routing decisions on their behalf. Monitoring binds to the submitting account. Switching the active account pauses effective polling for that account's experiments and reports a monitoring error. See [SII experiment MCP](inspire-async-experiments-en.md) for contracts, recovery, and acceptance rules.

Before running another program on an existing Notebook/Ray/Serving resource, register a new run ID and completion file through `sii_register_experiment`, then launch the background program. A new resource is not required for every experiment.

#### ScienceEvolve local binding

Configure the CLI and local workspace boundary in `.env`:

```dotenv
SCIENCEEVOLVE_INSPIRE_BIN=/absolute/path/to/inspire
SCIENCEEVOLVE_INSPIRE_WORKSPACE_ROOT=/absolute/path/containing-your-data-dir
SCIENCEEVOLVE_INSPIRE_CONFIG_PATH=
SCIENCEEVOLVE_INSPIRE_NO_PROXY=
```

Replace the paths with actual local paths. Without a configured boundary, the current runtime falls back to `/inspire/qb-ilm`, which does not fit every installation. `SCIENCEEVOLVE_INSPIRE_WORKSPACE_ROOT` is a local filesystem boundary containing the actual Agent workspaces, normally `${SCIENCEEVOLVE_DATA_DIR}/projects/...`. It is separate from the SII platform's Workspace name. `SCIENCEEVOLVE_INSPIRE_CONFIG_PATH` is an optional compatibility configuration layer and does not replace the Inspire CLI 6.x account directory. `SCIENCEEVOLVE_INSPIRE_NO_PROXY` adds comma-separated direct-access hosts and does not replace account login or platform-proxy setup.

#### Inspire/SII account initialization

Run these commands as the same OS user that runs ScienceEvolve Server. Replace `your-account-alias` with the local alias you want to use. Account configuration is stored in `~/.inspire/accounts/<account-alias>/`. If `inspire` is outside `PATH`, use the absolute `SCIENCEEVOLVE_INSPIRE_BIN` executable instead.

```bash
SCIENCEEVOLVE_INSPIRE_ACCOUNT_ALIAS=your-account-alias
inspire --version
inspire account add "$SCIENCEEVOLVE_INSPIRE_ACCOUNT_ALIAS"
inspire account use "$SCIENCEEVOLVE_INSPIRE_ACCOUNT_ALIAS"
inspire config check
inspire init
```

Then initialize project context from the ScienceEvolve repository and explicitly select the required billing Project:

```bash
cd /path/to/ScienceEvolve
inspire init --scope project --select-project "具有能动性的科学大模型"
```

`inspire account add` asks for the platform login ID, platform URL, and optional proxy. Use the actual username rather than the Web display name. If SII Proxy is needed, configure it in the Inspire account. ScienceEvolve's compute wrapper clears generic Shell HTTP(S) proxy variables to keep experiment commands from accidentally using an ordinary public-network proxy.

#### Project and resource requirements

The current ScienceEvolve deployment requires experiment workloads to bill the Project `具有能动性的科学大模型`. Execution Agents creating Notebook, Job, HPC, Ray, or Serving workloads must explicitly pass this `--project`, rather than relying on Active Project or silently selecting another Project.

Before submitting, check the account and live resource state:

```bash
inspire account current
inspire config check
inspire config context
inspire project detail "具有能动性的科学大模型" --workspace "<TARGET_WORKSPACE>"
inspire notebook quota --workspace "CPU资源空间"
inspire job quota --workspace "分布式训练空间"
inspire resources availability --workspace all --include-cpu
```

Use the platform's exact Project and Workspace names; replace `<TARGET_WORKSPACE>` with the actual target.

| Scheduling condition | Meaning |
| --- | --- |
| Workspace | Resource area, for example `CPU资源空间` or `分布式训练空间`. |
| Project | Billing owner, fixed to `具有能动性的科学大模型` in the current deployment. |
| Compute Group | Hardware and scheduling area, using the complete name returned by live discovery. |
| Quota | The `gpu,cpu,mem` tuple from the relevant Workload's live Quota row. |
| Image | Runtime image for the Notebook, Job, or other Workload. |

These conditions have no safe implicit defaults. Reusable combinations can be saved with `inspire <workload> profile set`, but creation commands must explicitly select the Profile. Availability changes over time. Before each submission, query Quota and Availability; afterward check Events, Logs, Metrics, Instances, and Status, and clean up unused resources.

See [installation and account setup](../.agents/skills/inspire/references/setup/install-and-config.md) and [resources and scheduling](../.agents/skills/inspire/references/resources-and-paths.md). Use the installed version's `inspire --help` and subcommand `--help` for exact arguments.

### Frontend and reverse proxy

Vite listens on `0.0.0.0:5173` by default and proxies `/api` to `http://127.0.0.1:4311`. Override these through the startup process environment:

```bash
SCIENCEEVOLVE_WEB_HOST=127.0.0.1 \
SCIENCEEVOLVE_API_URL=http://127.0.0.1:4311 \
npm run dev
```

Use `SCIENCEEVOLVE_WEB_BASE` for subpath deployment. In Inspire/Notebook environments, Vite derives the proxy prefix automatically when `VSCODE_PROXY_URI` is present.

The default `HOST=127.0.0.1` permits only local access. When binding to `0.0.0.0`, configure TLS, authentication, and access control at the reverse proxy, and keep management interfaces protected.

## Production

```bash
npm run build
npm start
```

In production, Server serves both the API and `web/dist` static files on `HOST:PORT`. Restart Server after changing environment variables, gateway settings, or Harness executable paths. Project state and workspace files recover from `SCIENCEEVOLVE_DATA_DIR`.

## Verification

```bash
npm run typecheck
npm run build
npm test
git diff --check
```

See [architecture](architecture.md) for state machines, persistence, and recovery details.
