import {
  constants as fsConstants,
  existsSync,
  promises as fs
} from "node:fs";
import path from "node:path";
import {
  loadConfig,
  resolveExplainerSandboxConfiguration
} from "./config.js";
import { EventHub } from "./event-hub.js";
import { ProjectStorage } from "./storage.js";
import { SkillCatalog } from "./skill-catalog.js";
import { HarnessRuntimeFacade } from "./harness-runtime/runtime.js";
import { createProductionHarnessRuntimeResidentAdapter } from "./harness-runtime/resident-runtime-adapter.js";
import { ProjectExplainerService } from "./project-explainer.js";
import { SavedResearchTaskStore } from "./saved-research-tasks.js";
import { SavedTaskLauncher, savedTaskProjectInput } from "./saved-task-launcher.js";
import { workflowAdjustmentSubmissionBodySchema } from "./workflow-adjustments.js";
import { ConfigRecommendationService } from "./config-recommendations.js";
import { AgentToolRecommendationService } from "./agent-tool-recommendations.js";
import { ExecutionSummaryService } from "./execution-summary.js";
import { Orchestrator } from "./orchestrator.js";
import {
  CollaborationRuntimeCoordinator,
  ProductionCollaborationExecutionInputBuilder,
  ProductionCollaborationInvocationDispatcher
} from "./collaboration-runtime.js";
import { createProductionCollaborationResidentLauncher } from "./collaboration-resident-launcher.js";
import { createApp } from "./app.js";
import { installServiceShutdown } from "./service-shutdown.js";
import {
  GatewayStore,
  systemGatewayInputFromEnvironment
} from "./agent-runtime.js";
import { GitHubAccountStore } from "./github-accounts.js";
import { DEFAULT_HARNESS_ID } from "./harness-runtime/registry.js";
import { SiiExperimentService } from "./sii-experiments.js";
import {
  InspireComputeUsageCollector,
  InspireComputeUsageMonitor
} from "./inspire-compute-usage.js";

async function main(): Promise<void> {
  loadLocalEnv();
  const config = loadConfig();
  const inspireBin = await resolveExecutable(config.inspireBin);
  const boundProjectId = process.env.SCIENCEEVOLVE_BOUND_SDK_PROJECT;
  const resolveProjectWorkspace = async (id: string): Promise<string | undefined> => {
    if (!boundProjectId || id !== boundProjectId) return undefined;
    if (!/^prj_[a-f0-9]{32}$/.test(id)) throw new Error("Invalid bound SDK project");
    const registry = JSON.parse(await fs.readFile(path.join(config.dataDir, "workspace-bindings.json"), "utf8"));
    const marker = JSON.parse(await fs.readFile(path.join(config.dataDir, "projects", id, ".sdk-workspace.json"), "utf8"));
    const binding = registry.projects?.[id];
    if (registry.schemaVersion !== 1 || !binding || binding.path !== marker.path || binding.dev !== marker.dev ||
      binding.ino !== marker.ino || !path.isAbsolute(binding.path)) throw new Error("Inconsistent SDK workspace binding");
    const info = await fs.lstat(binding.path, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink() || await fs.realpath(binding.path) !== binding.path ||
      info.dev.toString() !== binding.dev || info.ino.toString() !== binding.ino) throw new Error("SDK workspace identity changed");
    return binding.path;
  };
  if (boundProjectId) await resolveProjectWorkspace(boundProjectId);

  const eventHub = new EventHub();
  const storage = new ProjectStorage(config.dataDir, eventHub, {
    projectDirectoryAliases: config.projectDirectoryAliases,
    workspaceResolver: resolveProjectWorkspace
  });
  const gatewayStore = new GatewayStore(config.dataDir);
  const githubAccounts = new GitHubAccountStore(config.dataDir, {
    oauth: {
      clientId: config.githubOAuthClientId,
      clientSecret: config.githubOAuthClientSecret,
      callbackUrl: config.githubOAuthCallbackUrl
    }
  });
  const systemGateway = systemGatewayInputFromEnvironment(
    process.env,
    config.modelSuggestions
  );
  if (systemGateway) await gatewayStore.seedBuiltin(systemGateway);
  const skills = new SkillCatalog(config.skillRoots, config.userSkillRoot);
  const explainerSandbox = await resolveExplainerSandboxConfiguration();
  const siiExperiments = new SiiExperimentService({ projectsRoot: storage.projectsDir(), inspireBin,
    configPath: config.inspireConfigPath, noProxy: config.inspireNoProxy, workspaceRoot: config.inspireWorkspaceRoot,
    knowledgeRoot: path.join(config.skillRoots[0]!, "general", "inspire"),
    refreshMs: Math.max(1000, Number(process.env.SCIENCEEVOLVE_SII_REFRESH_MS) || 30_000) });
  const runner = new HarnessRuntimeFacade({
    resolveProjectWorkspace,
    siiExperiments,
    inspireBin,
    inspireConfigPath: config.inspireConfigPath,
    inspireNoProxy: config.inspireNoProxy,
    inspireWorkspaceRoot: config.inspireWorkspaceRoot,
    validateGatewayTarget: (url) => gatewayStore.assertAllowedNetworkTarget(url),
    ...(explainerSandbox.mode
      ? { explainerSandboxMode: explainerSandbox.mode }
      : {}),
    explainerSandboxVerified: explainerSandbox.verified,
    explainerSandboxUnavailableReason: explainerSandbox.unavailableReason,
    dshHandshakeTimeoutMs: config.dshHandshakeTimeoutMs,
    dshTurnIdleTimeoutMs: config.dshTurnIdleTimeoutMs,
    residentModelInactivityTimeoutMs: config.residentModelInactivityTimeoutMs,
    residentToolInactivityTimeoutMs: config.residentToolInactivityTimeoutMs,
    // Let transport recovery settle before either outer model watchdog expires.
    protocolProxyTimeoutMs: Math.floor(Math.min(config.protocolProxyTimeoutMs,
      config.agentActivityIdleWindowMs, config.residentModelInactivityTimeoutMs) * 0.9),
    // Backward-compatible configuration is normalized into the same generic
    // executable map consumed by every Adapter.
    harnessExecutables: { [DEFAULT_HARNESS_ID]: config.codexBin }
  });
  const harnessVersion = await runner.defaultHarnessVersion();
  gatewayStore.setAdapterSmokeProbe(runner);
  const residentAdapter = createProductionHarnessRuntimeResidentAdapter(runner);
  let orchestrator: Orchestrator;
  const collaborationRuntime = new CollaborationRuntimeCoordinator({
    storage,
    credentialResolverForAccount: (accountId) => githubAccounts.credentialResolver(accountId),
    executionInputBuilder: new ProductionCollaborationExecutionInputBuilder(storage, skills),
    invocationDispatcher: new ProductionCollaborationInvocationDispatcher(storage),
    residentLauncher: createProductionCollaborationResidentLauncher(runner, residentAdapter),
    validateWorkflowConfiguration: (state, proposal) => orchestrator.prepareWorkflowConfiguration(state, proposal)
  });
  orchestrator = new Orchestrator(
    storage,
    skills,
    runner,
    config,
    gatewayStore,
    collaborationRuntime,
    githubAccounts
  );
  const savedResearchTasks = new SavedResearchTaskStore(storage.root);
  const savedTaskLauncher = new SavedTaskLauncher(storage.root, savedResearchTasks,
    task => orchestrator.createProject(savedTaskProjectInput(task)));
  const projectExplainer = new ProjectExplainerService(
    runner,
    storage,
    { gatewayStore, assistant: { tasks: savedResearchTasks, skills, accounts: () => githubAccounts.list(),
      startProjects: (input, signal) => savedTaskLauncher.start(input, signal),
      workflow: async id => {
        const result = await orchestrator.queryWorkflowAdjustments(id);
        if (!result.context) throw new Error("Workflow context is unavailable");
        return { current: { version: result.context.current.version, snapshot: result.context.current.snapshot as unknown as Record<string, unknown> } };
      },
      submitWorkflow: (id, input) => orchestrator.submitWorkflowAdjustment(id, { ...workflowAdjustmentSubmissionBodySchema.parse(input), projectId: id })
    } }
  );
  runner.configureContextOrganizer((job, signal) => projectExplainer.organizeContext(job, signal));
  storage.configureContextIndexPublisher(input => runner.publishContextIndex(input));
  const configRecommendations = new ConfigRecommendationService(runner, gatewayStore, skills, projectExplainer,
    event => console.info("[configuration-recommendation]", JSON.stringify(event)));
  const agentToolRecommendations = new AgentToolRecommendationService(runner, skills, projectExplainer);
  const executionSummaries = new ExecutionSummaryService(storage, eventHub,
    (projectId, output, signal) => projectExplainer.summarizeOutput(projectId, output, signal));
  await collaborationRuntime.initialize();
  siiExperiments.configureDocumentStore(collaborationRuntime.projectStateDocuments());
  await orchestrator.initialize();
  await siiExperiments.start();
  const computeUsageMonitor = new InspireComputeUsageMonitor(
    new InspireComputeUsageCollector(inspireBin, {
      configPath: config.inspireConfigPath,
      projectsRoot: storage.projectsDir()
    }),
    orchestrator
  );

  const app = createApp({
    orchestrator,
    storage,
    eventHub,
    skills,
    projectExplainer,
    savedResearchTasks,
    savedTaskLauncher,
    configRecommendations,
    agentToolRecommendations,
    executionSummaries,
    gatewayStore,
    githubAccounts,
    harnessCatalog: () => runner.harnessCatalog(),
    config,
    runtimeHealth: () => collaborationRuntime.writerLeaseHealth(),
    harnessVersion
  });
  const server = app.listen(config.port, config.host, () => {
    console.log(
      `ScienceEvolve listening on http://${config.host}:${config.port} · ${harnessVersion}`
    );
  });
  computeUsageMonitor.start();

  installServiceShutdown(async signal => {
    console.log(`Received ${signal}; closing HTTP server`);
    server.close();
    await gatewayStore.close();
    await computeUsageMonitor.stop();
    await executionSummaries.shutdown();
    await runner.contextIndexes.close();
    await projectExplainer.shutdown();
    await configRecommendations.shutdown();
    agentToolRecommendations.shutdown();
    await orchestrator.shutdown();
    await siiExperiments.stop();
  });
}

function loadLocalEnv(): void {
  const candidates = [
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.cwd(), "..", ".env")
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    process.loadEnvFile(candidate);
    return;
  }
}

async function resolveExecutable(command: string): Promise<string> {
  const candidates = path.isAbsolute(command)
    ? [command]
    : (process.env.PATH ?? "")
        .split(path.delimiter)
        .filter(Boolean)
        .map((directory) => path.join(directory, command));
  for (const candidate of candidates) {
    try {
      await fs.access(candidate, fsConstants.X_OK);
      return await fs.realpath(candidate);
    } catch {
      // Continue searching PATH.
    }
  }
  throw new Error(
    `Unable to find executable '${command}'. Install it or configure the corresponding SCIENCEEVOLVE_*_BIN path.`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
