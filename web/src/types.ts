import type { ProjectViewStatus } from "./project-status";

export type AgentId = string;
export type WorkflowNodeId = string;
export type NodeRunId = string;
export type GroupRunId = string;
export type TaskId = string;
export type ExecutionId = string;
export type InvocationId = string;
export type PullRequestId = string;
export type OperationId = string;
export type AgentName = AgentId;
export type AgentKind = "main" | "worker";
export const OPENFARS_COLLABORATION_CONTRACT_VERSION = "openfars-collaboration-v2.0" as const;
export const MAIN_AGENT_NAME = "main" as const;
export type AgentTemplate = "main" | "general" | "idea" | "execution" | "writing" | "review";
export const AGENT_TEMPLATES: readonly AgentTemplate[] = [
  "main",
  "general",
  "idea",
  "execution",
  "writing",
  "review"
] as const;
export type WorkflowEdgeKind = "strong" | "weak";
export type WorkflowRouteTarget = WorkflowNodeId | "finish";
export interface WorkflowEdge {
  target: WorkflowRouteTarget;
  kind: WorkflowEdgeKind;
}
export type WorkflowEdgeMap = Record<WorkflowNodeId, WorkflowEdge[]>;

export interface WorkflowLoop {
  id: string;
  from: AgentName;
  to: AgentName;
  maxIterations: number;
  exitTo: AgentName;
}

export type WorkflowCanvasPort = "top" | "right" | "bottom" | "left";

export interface WorkflowCanvasNodeLayout {
  x: number;
  y: number;
}

export interface WorkflowCanvasEdgeLayout {
  sourcePort: WorkflowCanvasPort;
  targetPort: WorkflowCanvasPort;
  sourcePortPinned: boolean;
  targetPortPinned: boolean;
}

/** Presentation-only layout persisted with the Workflow configuration. */
export interface WorkflowCanvasLayout {
  schemaVersion: 1;
  nodes: Record<string, WorkflowCanvasNodeLayout>;
  edges: Record<string, WorkflowCanvasEdgeLayout>;
  viewport: { x: number; y: number; zoom: number };
  layoutMode: "free" | "layered";
  /** Explicit visual connection state for OpenFARS' non-null semantic anchors. */
  connections?: { input: boolean; termination: boolean };
}

export interface ResultFormat {
  presets: string[];
  custom: string;
  none?: boolean;
}

export type NodeRef =
  | { kind: "agent"; nodeId: WorkflowNodeId; agentId: AgentId }
  | { kind: "collaboration"; nodeId: WorkflowNodeId; groupId: string };

export interface CollaborationNode {
  id: string;
  displayName: string;
  memberAgentIds: AgentId[];
  renamePolicy: "editable" | "locked";
  /** Lossless pre-group topology used only when the group is dissolved. */
  formationSnapshot?: CollaborationFormationSnapshot;
}

/** v3 keeps Agent identity separate from a node reference in each scope. */
export interface ScopedWorkflow {
  nodes: NodeRef[];
  input: { source: "input"; edges: Array<{ target: WorkflowNodeId; kind: "parallel" }> };
  routes: WorkflowEdgeMap;
  loops?: WorkflowLoop[];
  canvas?: WorkflowCanvasLayout;
}

export interface ScopedCollaboration {
  id: string;
  parentGroupId?: string;
  leaderAgentId: AgentId;
  decisionBy?: "main" | "agent";
  allowLeaderReconfiguration: boolean;
  workflow: ScopedWorkflow;
}

export interface ScopedWorkflowContract {
  schemaVersion: 1;
  rootAgentIds: AgentId[];
  groups: ScopedCollaboration[];
}

export interface CollaborationFormationSnapshot {
  schemaVersion: 1;
  workflowRevision: number;
  memberRoutes: Record<AgentId, WorkflowEdge[]>;
  memberDecisionPlans: Record<AgentId, string>;
  inboundRoutes: Record<WorkflowNodeId, WorkflowEdge[]>;
  formedRoutes: Record<WorkflowNodeId, WorkflowEdge[]>;
  inputTarget?: WorkflowNodeId;
  terminationAgent?: WorkflowNodeId;
  memberCanvasNodes?: Record<AgentId, WorkflowCanvasNodeLayout>;
}

export interface CollaborationDissolutionPlan {
  mode: "guided";
  incomingTargetBySource: Record<WorkflowNodeId, AgentId>;
  memberRoutes: Record<AgentId, WorkflowEdge[]>;
  inputTarget?: AgentId;
  terminationAgent?: AgentId;
  memberCanvasNodes?: Record<AgentId, WorkflowCanvasNodeLayout>;
}

export type GitRepositoryVisibility = "private" | "public";

export interface ProjectGitInput {
  enabled: boolean;
  provider?: "github";
  accountId?: string;
  repositoryName?: string;
  repositoryVisibility?: GitRepositoryVisibility;
}

export interface GitHubAccountRecord {
  id: string;
  login: string;
  providerUserId: number;
  avatarUrl?: string;
  status: "ready" | "expired" | "revoked";
  scopes: string[];
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
  lastVerifiedAt?: string;
}

export interface GitHubAccountCatalog {
  accounts: GitHubAccountRecord[];
  defaultAccountId?: string;
  oauthConfigured: boolean;
}

export interface GitHubRepositoryObservation {
  exists: boolean;
  observedAt: string;
  htmlUrl?: string;
  private?: boolean;
  defaultBranch?: string;
}

export interface ProjectGitBranchFact {
  name: string;
  head?: string;
  base?: string;
  ownerExecutionId?: ExecutionId;
  worktreePath?: string;
  status: string;
  retained?: true;
  observedAt?: string;
}

export interface ProjectGitCommitFact {
  sha: string;
  htmlUrl?: string;
  message?: string;
  observedAt?: string;
}

export interface GitGraphPullRequest {
  id: string;
  number: number;
  status: PullRequestRecord["status"];
  htmlUrl: string;
  role: "head" | "merge";
}

export interface GitGraphChangedFile {
  path: string;
  status: string;
}

export interface GitGraphCommit {
  sha: string;
  parents: string[];
  subject: string;
  body?: string;
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  committerName: string;
  committerEmail: string;
  committedAt: string;
  refs: string[];
  trailers: Record<string, string>;
  agentId?: string;
  taskId?: string;
  executionId?: string;
  groupRunId?: string;
  pullRequests: GitGraphPullRequest[];
  changedFiles: GitGraphChangedFile[];
  htmlUrl?: string;
  system: boolean;
}

export type GitGraphEmptyReason =
  | "git_disabled"
  | "repository_uninitialized"
  | "repository_initializing"
  | "repository_failed"
  | "before_first_assignment"
  | "branch_without_commits"
  | "commits_without_pull_request";

export interface GitGraphPage {
  commits: GitGraphCommit[];
  refs: Array<{ name: string; sha: string }>;
  emptyReason?: GitGraphEmptyReason;
  nextCursor?: string;
  repositoryUrl?: string;
  githubActor?: string;
  observedAt: string;
}

export interface ProjectGitState {
  enabled: boolean;
  status:
    | "disabled"
    | "authorizing"
    | "creating_repository"
    | "initializing_local"
    | "pushing_main"
    | "ready"
    | "waiting_for_github"
    | "failed";
  provider?: "github";
  account?: {
    id: string;
    login: string;
    providerUserId: number;
    avatarUrl?: string;
  };
  requestedRepositoryName?: string;
  requestedRepositoryVisibility?: GitRepositoryVisibility;
  repository?: {
    owner: string;
    name: string;
    htmlUrl: string;
    private: boolean;
    defaultBranch: "main";
    localPath: string;
  };
  initialization?: {
    operationId: OperationId;
    attempt: number;
    completedSteps: string[];
    error?: string;
  };
  /** Credential-free, provider-observed read model for the UI. */
  branches?: ProjectGitBranchFact[];
  commits?: ProjectGitCommitFact[];
  blockers?: string[];
  observedAt?: string;
  capacity?: {
    retainedWorktreeCount: number;
    warningThreshold?: number;
    warning?: string;
  };
}

export type ProjectStatus = ProjectViewStatus;

export type AgentProgressState =
  | "waiting"
  | "queued"
  | "running"
  | "retrying"
  | "interrupting"
  | "interrupted"
  | "completed"
  | "paused"
  | "cancelled"
  | "failed";

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";
/** Harness identifiers are validated catalog strings, not a closed union. */
export type AgentHarness = string;
export type AgentProtocol = "responses" | "chat-completions" | "anthropic-messages";

export const GATEWAY_REASONING_PARAMETER_PATHS = [
  "reasoning_effort",
  "reasoning.effort",
  "chat_template_kwargs.reasoning_effort",
  "thinking.effort"
] as const;

export type GatewayReasoningParameterPath =
  typeof GATEWAY_REASONING_PARAMETER_PATHS[number];

export interface GatewayReasoningOption {
  id: string;
  label: string;
  value: string;
}

export interface GatewayModelReasoningConfig {
  parameter: GatewayReasoningParameterPath;
  options: GatewayReasoningOption[];
}

export type GatewayModelReasoningConfigs = Record<string, GatewayModelReasoningConfig>;

export interface ResolvedGatewayReasoning {
  mode: "option";
  optionId: string;
  label: string;
  value: string;
  parameter: GatewayReasoningParameterPath;
  fingerprint: string;
}

export type GatewayProbeStageId = "text_ordinary" | "text_stream" | "tool_ordinary" | "tool_stream" | "adapter_smoke";

export interface GatewayProbeStageResult {
  stage: GatewayProbeStageId;
  label: string;
  expectation: "text" | "tool" | "harness";
  stream: boolean;
  status: "queued" | "running" | "passed" | "failed" | "skipped";
  durationMs?: number;
  httpStatus?: number;
  error?: string;
}

export interface GatewayTestState {
  status: "untested" | "passed" | "failed";
  testedAt?: string;
  error?: string;
  durationMs?: number;
  stageResults?: GatewayProbeStageResult[];
  protocol?: AgentProtocol;
  model?: string;
  harness?: AgentHarness;
  nativeProtocol?: AgentProtocol;
  routeMode?: "direct" | "proxy";
  routeDirection?: `${AgentProtocol}->${AgentProtocol}`;
  deliveryMode?: "native-stream" | "buffered-json";
  probeKind?: "route" | "adapter-smoke";
  cacheKey?: string;
  adapterVersion?: string;
  executableFingerprint?: string;
  gatewayRevision?: number;
  routerCompatibilityVersion?: string;
  /** Exact model-level Gateway reasoning selection exercised by this probe. */
  reasoningOptionId?: string;
  reasoningFingerprint?: string;
}

export interface GatewayRecord {
  id: string;
  name: string;
  url: string;
  models: string[];
  modelContextWindows?: Record<string, number>;
  modelReasoning?: GatewayModelReasoningConfigs;
  defaultModel: string;
  protocol: AgentProtocol;
  revision: number;
  builtin?: boolean;
  test: GatewayTestState;
  tests?: GatewayTestState[];
  apiKeyConfigured: boolean;
  createdAt: string;
  updatedAt: string;
}

export type GatewayMatrixProgressEvent =
  | {
      type: "combination-start";
      harness: AgentHarness;
      model: string;
      stageResults: GatewayProbeStageResult[];
    }
  | {
      type: "stage";
      harness: AgentHarness;
      model: string;
      stage: GatewayProbeStageResult;
    }
  | {
      type: "result";
      harness: AgentHarness;
      model: string;
      result: GatewayTestState;
    }
  | {
      type: "complete";
      gateway: GatewayRecord;
      results: GatewayTestState[];
    }
  | {
      type: "error";
      message: string;
    };

export type GatewayTestProgressEvent =
  | {
      type: "stage";
      stage: GatewayProbeStageResult;
    }
  | {
      type: "result";
      result: GatewayTestState;
    }
  | {
      type: "complete";
      gateway: GatewayRecord;
      result: GatewayTestState;
    }
  | {
      type: "error";
      message: string;
    };

export interface GatewayInput {
  name: string;
  url: string;
  apiKey: string;
  models: string[];
  modelContextWindows?: Record<string, number>;
  modelReasoning?: GatewayModelReasoningConfigs;
  defaultModel: string;
  protocol: AgentProtocol;
}

export const DEFAULT_MODEL_CONTEXT_WINDOW = 256 * 1024;
export const MAX_MODEL_CONTEXT_WINDOW = 2_000_000;

/** Safe, server-derived availability metadata for an embedded Agent runner. */
export interface HarnessCatalogEntry {
  schemaVersion?: 1;
  id: AgentHarness;
  label: string;
  adapterVersion: string;
  nativeProtocol?: AgentProtocol;
  purposes: Array<"workflow" | "explainer" | "probe">;
  /** False keeps a legacy Adapter addressable but hides it from new selections. */
  selectable?: boolean;
  default?: boolean;
  /** False for registered compatibility adapters hidden from user selection. */
  userSelectable?: boolean;
  mode?: "workflow" | "readonly-explainer";
  notes: string;
  capabilities: {
    structuredEvents?: boolean;
    toolResults?: boolean;
    durableSession: boolean;
    permissionPrompts?: Array<"workspace" | "compute" | "yolo">;
    workspaceInputs?: boolean;
    autoSkills?: boolean;
    officialEvents: boolean;
    toolEvents: boolean;
    usageEvents: boolean;
    readOnlyExplainer: boolean;
    webSearch: boolean;
    skills: boolean;
    mcp: boolean;
    assistantStreaming?: "native" | "proxy-visible-output" | "terminal";
  };
  available: boolean;
  /** Public diagnostic only; executable paths and credentials are never exposed. */
  availabilityReason?: string;
  executableFingerprint?: string;
  /** Invalidates smoke results when protocol routing semantics change. */
  routerCompatibilityVersion?: string;
}

export type AgentMcpServer = { name: string } & (
  | { url: string; project?: never }
  | { project: string; url?: never }
);


export interface ProjectSkillDefinition {
  files: Record<string, string>;
}

export type ProjectSkillDefinitions = Record<string, ProjectSkillDefinition>;

export interface ProjectMcpDefinition {
  files: Record<string, string>;
  command?: string;
  entrypoint: string;
  args?: string[];
  envFrom?: Record<string, string>;
}

export type ProjectMcpDefinitions = Record<string, ProjectMcpDefinition>;

export interface AgentProgress {
  state: AgentProgressState;
  runs: number;
  /** Business executions; retries and session resumes do not increment it. */
  executions?: number;
  queuePosition?: number;
}

export interface OverallProgress {
  percent: number;
  label: string;
  /** Workflow graph position, rather than elapsed-time progress. */
  estimated: true;
  /** Legacy activity telemetry; does not affect the percentage. */
  successfulCalls: number;
}

export interface QueueItem {
  projectId: string;
  position: number;
  enteredAt: string;
  id?: string;
  agentId?: string;
  executionId?: string;
  groupRunId?: string;
  poolId?: string;
  reason?: string;
}

export interface QueueTask {
  id: string;
  projectId: string;
  agentId?: string;
  invocationId?: string;
  executionId?: string;
  groupRunId?: string;
  startedAt?: string;
  state: "running" | "starting" | "recovering";
}

export interface QueuePool {
  id: string;
  scope: "shared" | "project";
  projectId?: string;
  capacity: number;
  occupied: number;
}

export interface AgentKindQueueSnapshot {
  capacity: number;
  activeProjectIds: string[];
  queued: QueueItem[];
  activeTasks?: QueueTask[];
  recoveringTasks?: QueueTask[];
  pools?: QueuePool[];
}

export type QueueSnapshot = Record<string, AgentKindQueueSnapshot>;

export interface AgentConfig {
  model: string;
  harness?: AgentHarness;
  gatewayId?: string;
  /** Model-level Gateway reasoning option. Absence means provider default. */
  gatewayReasoningOption?: string;
  /** Public, credential-free snapshot captured when a project starts. */
  gatewaySnapshot?: {
    id: string;
    name: string;
    url: string;
    models: string[];
    modelContextWindows?: Record<string, number>;
    modelReasoning?: GatewayModelReasoningConfigs;
    reasoning?: ResolvedGatewayReasoning;
    reasoningMigrationWarning?: string;
    defaultModel: string;
    protocol: AgentProtocol;
    /** Server-derived route metadata captured with the running project. */
    nativeProtocol?: AgentProtocol;
    routeMode?: "direct" | "proxy";
    routeDirection?: `${AgentProtocol}->${AgentProtocol}`;
    deliveryMode?: "native-stream" | "buffered-json";
    testedAt?: string;
  };
  /** @deprecated Compatibility-only input; never written or sent to a Harness. */
  reasoningEffort?: ReasoningEffort;
  /** Client-only hint retained while a legacy saved configuration is migrated. */
  legacyReasoningEffort?: ReasoningEffort;
  /** Client/server generated notice for a legacy value that could not migrate uniquely. */
  reasoningMigrationWarning?: string;
  /** Skills loaded on every invocation. */
  skills: string[];
  /** Skills available for task-driven automatic selection. */
  autoSkills: string[];
  /** Streamable HTTP MCP servers enabled for this Agent. */
  mcpServers: AgentMcpServer[];
  /** Explicit business capability, independent of file modification scope. */
  experimentMcp?: boolean;
  /** Complete prompt used by this Agent. */
  instructions: string;
  permission: "workspace" | "compute" | "yolo";
  webSearch: boolean;
  sessionPersistence: boolean;
  decisionBy: "main" | "agent";
}

export type AgentsConfig = Record<AgentName, AgentConfig>;

export interface AgentDefinition {
  name: AgentName;
  template?: AgentTemplate;
  /** Short user-facing role description shown in the canvas and Inspector. */
  description?: string;
}

export interface AgentOrchestrationTemplate {
  schemaVersion?: 2 | 3;
  agents: AgentDefinition[];
  collaborations?: CollaborationNode[];
  /** Authoritative v3 scope tree; collaborations is a display registry only. */
  scopedWorkflow?: ScopedWorkflowContract;
  /** User-created library templates; canvas Agent instances live in agents. */
  agentTemplates?: AgentDefinition[];
  input: {
    source: "input";
    target: WorkflowNodeId;
  };
  routes: WorkflowEdgeMap;
  loops?: WorkflowLoop[];
  decisionPlans: Record<AgentName, string>;
  allowUserIntervention: boolean;
  /** User-owned policy gate for Main-authored runtime topology changes. */
  allowMainReconfiguration?: boolean;
  termination: {
    agent: WorkflowNodeId;
    condition: string;
    decisionBy: "main";
    automatic: boolean;
  };
  resultFormat?: ResultFormat;
  /** Presentation-only canvas state; never read by the scheduler. */
  canvas?: WorkflowCanvasLayout;
}

export interface AgentOrchestrationTemplateV2 extends AgentOrchestrationTemplate {
  schemaVersion: 2;
  collaborations: CollaborationNode[];
}

export interface AgentOrchestrationTemplateV3 extends AgentOrchestrationTemplate {
  schemaVersion: 3;
  collaborations: CollaborationNode[];
  scopedWorkflow: ScopedWorkflowContract;
}

export interface WorkflowImportSource {
  filename: string;
  text: string;
  notices: Array<{ path: string; message: string }>;
}

export interface AgentConfigPreset {
  schemaVersion: 2;
  kind: "scienceevolve-agent-config-preset";
  id: string;
  name: string;
  builtin: boolean;
  importSource?: WorkflowImportSource;
  sourceProjectId?: string;
  sourceProjectTitle?: string;
  createdAt?: string;
  updatedAt?: string;
  agents: AgentsConfig;
  orchestration: AgentOrchestrationTemplate;
  skillDefinitions?: ProjectSkillDefinitions;
  mcpDefinitions?: ProjectMcpDefinitions;
}

export interface SavedResearchTask {
  schemaVersion: 2;
  kind: "scienceevolve-saved-research-task";
  id: string;
  title: string;
  requirement: string;
  createdAt: string;
  updatedAt: string;
  agents: AgentsConfig;
  orchestration: AgentOrchestrationTemplate;
  skillDefinitions?: ProjectSkillDefinitions;
  mcpDefinitions?: ProjectMcpDefinitions;
  git?: ProjectGitInput;
}

export interface CurrentAssignment {
  target: WorkflowNodeId | "finish" | "user";
  message: string;
  rationale: string;
  successCriteria: string[];
  display?: DisplaySelection | null;
  invocationId: string;
  updatedAt: string;
  overridden?: boolean;
  overrideReason?: string;
}

export interface UserIntervention {
  id: string;
  status: "pending" | "answered";
  requestedAt: string;
  answeredAt?: string;
  message: string;
  rationale: string;
  successCriteria: string[];
  requestedBy?: AgentName;
  requestedInvocationId?: string;
  requestKind?: "main";
  response?: string;
}

export interface DisplayItem {
  agent: AgentName;
  path: string;
  title: string;
  /** Immutable server-owned binding for a Git-backed accepted display. */
  artifactId?: string;
  commitSha?: string;
}

export interface DisplaySelection {
  primary: DisplayItem;
  items: DisplayItem[];
}

export interface ProjectUserInput {
  id: string;
  status: "pending" | "delivered";
  createdAt: string;
  message: string;
  mode?: "wait" | "interrupt";
  requestId?: string;
  targetMainInvocation: number;
  deliveredAt?: string;
  deliveredInvocationId?: string;
}

export interface InterruptionSnapshot {
  status: "requested" | "interrupting" | "interrupted" | "force-terminated";
  inputId: string;
  requestId?: string;
  agent: AgentName;
  kind: AgentKind;
  invocationId: string;
  harness?: AgentHarness;
  gatewayId?: string;
  gatewayName?: string;
  gatewayProtocol?: AgentProtocol;
  model?: string;
  sessionId?: string;
  startedAt?: string;
  requestedAt: string;
  interruptedAt?: string;
  eventSeq: number;
  lastActivityAt?: string;
  activeTools: string[];
  partialOutput?: string;
  partialHandoff?: string;
  traceTail: string[];
  artifacts: Array<{ agent: AgentName; path: string; title?: string }>;
  workspaceSummary?: string;
  forceTerminated?: boolean;
  recoverable: boolean;
}

export interface TokenUsageTotals {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  invocations: number;
  unknownRequests?: number;
  complete?: boolean;
}

export interface ProjectTokenUsage extends TokenUsageTotals {
  byAgent: Record<AgentName, TokenUsageTotals>;
  updatedAt?: string;
}

export interface InvocationPerformance {
  invocationId: string;
  agent: AgentName;
  attempt: number;
  status: "active" | "completed" | "incomplete";
  startedAt: string;
  firstTokenAt?: string;
  completedAt?: string;
  firstTokenLatencyMs?: number;
  currentTokensPerSecond?: number;
  requestActive?: boolean;
  averageTokensPerSecond?: number;
  outputDurationMs?: number;
  outputTokens: number;
  tokenSource: "estimated" | "official";
  streaming: boolean;
}

export interface PerformanceAggregate {
  invocations: number;
  outputTokens: number;
  outputDurationMs: number;
  firstTokenSamples: number;
  totalFirstTokenLatencyMs: number;
  averageFirstTokenLatencyMs?: number;
  averageTokensPerSecond?: number;
  tokenSource: "estimated" | "official" | "mixed";
  updatedAt: string;
}

export interface ProjectPerformance {
  byAgent: Record<AgentName, InvocationPerformance>;
  aggregateByAgent?: Record<AgentName, PerformanceAggregate>;
  aggregate?: PerformanceAggregate;
  history?: InvocationPerformance[];
  latest?: InvocationPerformance;
}

export interface LiveAssistantStream {
  projectId: string;
  invocationId: string;
  agent: AgentName;
  harnessId: string;
  attempt: number;
  itemId: string;
  content: string;
  truncated?: boolean;
  phase: "streaming" | "complete" | "incomplete";
  role: "active" | "process" | "final";
  updatedAt: string;
}

export interface ProjectRuntimeActivity {
  activityId: string;
  projectId: string;
  kind: "resident" | "turn";
  scopeKind?: "scoped-agent" | "scoped-leader" | "scoped-main" | "terminal-push-observation" | "terminal-push-coordinator";
  phase: "resident:starting" | "resident:running" | "model:running";
  invocationId: InvocationId;
  agentId: AgentId;
  nodeRunId: NodeRunId;
  groupRunId?: GroupRunId;
  taskId?: TaskId;
  executionId?: ExecutionId;
  ownershipEpoch?: number;
  coordinatorEpoch?: number;
  inputId?: string;
  startedAt: string;
  writerLeaseEpoch: number;
  leaseState: "current" | "recovering";
}

export interface ProjectRuntimeProjection {
  stateRevision: number;
  status: ProjectStatus;
  phase: string;
  waiting?: {
    kind: "recovery" | "management" | "workflow-adjustment";
    reason: string;
    agentId?: AgentName;
    groupRunId?: string;
    executionId?: string;
    operationId?: string;
  };
  currentAgent?: AgentName;
  activeInvocationId?: InvocationId;
  activityStartedAt?: string;
  nodeRunId?: NodeRunId;
  groupRunId?: GroupRunId;
  taskId?: TaskId;
  executionId?: ExecutionId;
  ownershipEpoch?: number;
  coordinatorEpoch?: number;
  leaseState?: "current" | "recovering";
  executionCount: number;
  primaryActivity?: ProjectRuntimeActivity;
  activities: ProjectRuntimeActivity[];
}

export type FailureAttemptScope =
  | "git"
  | "resident"
  | "tool"
  | "control"
  | "usage"
  | "scheduler";

export interface FailureAttempt {
  attemptId: string;
  projectId: string;
  scope: FailureAttemptScope;
  operation: string;
  status: "failed" | "succeeded";
  errorCode: string | null;
  retryable: boolean;
  redactedMessage: string;
  causeClass: string;
  agentId?: AgentId;
  nodeRunId?: string;
  groupRunId?: string;
  taskId?: string;
  executionId?: string;
  coordinatorEpoch?: number;
  invocationId?: InvocationId;
  ownershipEpoch?: number;
  startedAt: string;
  finishedAt: string;
  metadata: Record<string, unknown>;
}

export interface FailureAttemptOperationSummary {
  scope: FailureAttemptScope;
  operation: string;
  status: FailureAttempt["status"];
  attemptId: string;
  attemptCount: number;
  failureCount: number;
  startedAt: string;
  finishedAt: string;
  lastFailureAt?: string;
  lastSuccessAt?: string;
}

export interface FailureAttemptSummary {
  currentStatus: "healthy" | "failed";
  totalAttempts: number;
  failedAttempts: number;
  succeededAttempts: number;
  unresolvedFailures: number;
  latestAttempt?: FailureAttempt;
  latestFailure?: FailureAttempt;
  operations: FailureAttemptOperationSummary[];
}

export interface ProjectLiveSnapshot {
  projectId: string;
  streams: LiveAssistantStream[];
  events: AgentEvent[];
  performance?: InvocationPerformance;
  runtime?: ProjectRuntimeProjection;
}

export interface AcceleratorCardHours {
  type: string;
  cardHours: number;
}

export interface ProjectComputeUsage {
  source: "inspire";
  totalCardHours: number;
  byAccelerator: AcceleratorCardHours[];
  workloadCount: number;
  activeWorkloadCount: number;
  updatedAt?: string;
}

export type NodeRunStatus =
  | "preparing"
  | "queued"
  | "coordinating"
  | "running"
  | "integrating"
  | "paused"
  | "blocked"
  | "cancelled"
  | "failed"
  | "completed";

export interface NodeRun {
  id: NodeRunId;
  node: NodeRef;
  workflowRevision: number;
  activationRequestId: string;
  inputSnapshotRef: string;
  optionalTask?: string;
  sourceNodeRunId?: NodeRunId;
  sourceAgentId?: AgentId;
  activatedByAgentId: AgentId;
  status: NodeRunStatus;
  routeEmissionId?: string;
  activatedAt?: string;
  updatedAt?: string;
  completedAt?: string;
  output?: string;
  failureReason?: string;
}

export type GroupRunStatus = Exclude<NodeRunStatus, "queued">;

export interface GroupRun {
  id: GroupRunId;
  nodeRunId: NodeRunId;
  /** Present once the recursive runtime publishes scoped group facts. */
  groupId?: string;
  parentGroupRunId?: GroupRunId;
  workflowRevision?: number;
  memberSnapshot: AgentId[];
  leaderAgentId: AgentId;
  actingCoordinatorId?: AgentId;
  coordinatorEpoch: number;
  baseCommit: string;
  groupBranch: string;
  integrationTarget: string;
  branchHead?: string;
  waitReason?: string;
  integrationOwnerExecutionId?: ExecutionId;
  finalPullRequestId?: PullRequestId;
  taskIds: TaskId[];
  status: GroupRunStatus;
  startedAt?: string;
  updatedAt?: string;
  completedAt?: string;
  leaderDecision?: string;
  output?: string;
  failureReason?: string;
}

export interface ScopedGroupRun {
  id: GroupRunId;
  projectId: string;
  groupId: string;
  parentGroupRunId?: GroupRunId;
  parentArrivalRequestId?: string;
  activationRequestId: string;
  workflowRevision: number;
  leaderAgentId: AgentId;
  baseCommit: string;
  groupBranch: string;
  integrationTarget: string;
  status: string;
}

export interface ScopedArrival {
  sequence: number;
  requestId: string;
  groupRunId: GroupRunId;
  sourceRunId: string;
  targetNodeId: WorkflowNodeId;
  targetKind: "agent" | "collaboration";
  agentId?: AgentId;
  childGroupId?: string;
  status: string;
  pathContext?: { pathId: string; loops: Record<string, { batch: number; iterations: number; totalIterations: number }> };
}

export interface ScopedExecution {
  id: ExecutionId;
  projectId: string;
  groupRunId: GroupRunId;
  arrivalRequestId: string;
  agentId: AgentId;
  ownershipEpoch: number;
  executionBranch: string;
  worktreePath: string;
  status: string;
}

/** Durable business result and optional frozen delivery head for one epoch. */
export interface ScopedAgentReport {
  projectId: string;
  executionId: ExecutionId;
  ownershipEpoch: number;
  invocationId: string;
  output: string;
  selectedWeakTarget?: string;
  headSha?: string;
  recordedAt: string;
  headRecordedAt?: string;
}

/** Runtime-only final Git owner, with no Agent identity or worktree/session. */
export interface ScopedFinalIntegration {
  id: ExecutionId;
  projectId: string;
  groupRunId: GroupRunId;
  ownershipEpoch: number;
  executionBranch: string;
  integrationTarget: string;
  expectedHeadSha: string;
  status: "integrating" | "completed";
}

export interface ScopedMergeSynchronization {
  projectId: string;
  operationId: OperationId;
  targetBranch: string;
  temporaryRef: string;
  expectedSourceHead: string;
  mergeCommitSha: string;
  remoteHead: string;
  localHeadBefore: string;
  localHeadAfter: string;
  status: "synchronized" | "already_synchronized";
  observedAt: string;
}

export interface ScopedAgentMerge {
  arrivalRequestId: string;
  executionId: ExecutionId;
  groupRunId: GroupRunId;
  pullRequest: PullRequestRecord;
  synchronization: ScopedMergeSynchronization;
  recordedAt: string;
}

export interface ScopedGroupFinalMerge {
  groupRunId: GroupRunId;
  pullRequest: Pick<PullRequestRecord,
    "id" | "providerNumber" | "htmlUrl" | "head" | "base" | "status" | "headSha" | "mergeCommitSha" | "observedAt">;
  synchronization: ScopedMergeSynchronization;
  recordedAt: string;
}

export type WorkTaskStatus =
  | "pending"
  | "assigned"
  | "working"
  | "waiting"
  | "continuation_pending"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface WorkTask {
  id: TaskId;
  nodeRunId: NodeRunId;
  groupRunId?: GroupRunId;
  assignment: string;
  assigneeAgentId?: AgentId;
  dependencyTaskIds: TaskId[];
  queueOrdinal: number;
  currentExecutionId?: ExecutionId;
  status: WorkTaskStatus;
  predecessorTaskId?: TaskId;
  successorTaskId?: TaskId;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string;
  waitReason?: string;
  failureReason?: string;
  cancelReason?: string;
}

export type MemberExecutionStatus =
  | "queued"
  | "working"
  | "waiting_authorization"
  | "waiting_review"
  | "pr_open"
  | "resolving"
  | "merged"
  | "stop_requested"
  | "stopped"
  | "superseded"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface MemberExecution {
  id: ExecutionId;
  nodeRunId: NodeRunId;
  groupRunId?: GroupRunId;
  taskId: TaskId;
  agentId: AgentId;
  purpose: "delivery" | "final-integration";
  ownershipEpoch: number;
  status: MemberExecutionStatus;
  executionBranch: string;
  worktreePath: string;
  pullRequestId?: PullRequestId;
  invocationId?: InvocationId;
  sessionId?: string;
  predecessorExecutionId?: ExecutionId;
  successorExecutionId?: ExecutionId;
  failureReason?: string;
  queuedAt?: string;
  startedAt?: string;
  updatedAt?: string;
  completedAt?: string;
  waitReason?: string;
  output?: string;
}

export interface PullRequestCheckRecord {
  id: number;
  name: string;
  status: string;
  conclusion?: string;
  htmlUrl?: string;
  observedAt: string;
}

export interface PullRequestRecord {
  id: PullRequestId;
  providerNumber: number;
  htmlUrl: string;
  head: string;
  base: string;
  ownerExecutionId: ExecutionId;
  status: "open" | "conflicted" | "closed" | "merged" | "unknown";
  headSha?: string;
  baseSha?: string;
  mergeable?: boolean;
  mergeCommitSha?: string;
  diffUrl?: string;
  headCommitUrl?: string;
  conflictPaths?: string[];
  checks?: PullRequestCheckRecord[];
  blockers?: string[];
  reconciliation?: {
    status: "pending" | "observed" | "uncertain" | "failed";
    operationId?: OperationId;
    message?: string;
    observedAt?: string;
  };
  observedAt: string;
}

export interface OperationRecord {
  id: OperationId;
  kind:
    | "repository.create"
    | "git.push"
    | "pull.create"
    | "pull.merge"
    | "pull.close"
    | "memory.commit";
  payloadHash: string;
  status: "prepared" | "observed" | "finalized" | "uncertain" | "failed" | "superseded";
  ownerExecutionId?: ExecutionId;
  ownershipEpoch?: number;
  expectedHead?: string;
  expectedBase?: string;
  remoteFact?: Record<string, unknown>;
}

export interface ArchivedWorkflowAgentSessions {
  agentId: AgentName;
  harnesses: string[];
  workflowRevision: number;
  sessionCount: number;
}

export interface FormalProjectState {
  domain: { scheduler: "git" | "serial"; protocol: string };
  checkpoint: { version: string; revision: number; lifecycle: { status?: string; phase?: string; currentAgent?: string; activeInvocationId?: string } };
  invocationCommit: { status: "idle" | "in_progress" | "committed"; invocationId?: string };
  experiments: { version: string; revision: number; ledger: { experiments: Array<{
    id: string; agent: string; taskId: string; runId: string; status: string; required: boolean; observedAt?: string; resultReceived?: boolean;
  }> } };
}

export interface Project {
  collaboration?: { stateRevision: number; businessState?: Array<{
    object: { kind: string; id: string }; extensions: Record<string, unknown>; sequence: number; updatedAt: string
  }>; formalState?: FormalProjectState };
  archivedAgentSessions?: ArchivedWorkflowAgentSessions[];
  id: string;
  title: string;
  requirement: string;
  status: ProjectStatus;
  phase: string;
  currentAgent?: AgentName;
  queuedAgent?: AgentName;
  activeInvocationId?: InvocationId;
  turn: number;
  cycle: number;
  queuePosition?: number;
  queueDepth?: number;
  queueEnteredAt?: string;
  agentProgress: Record<AgentName, AgentProgress>;
  overallProgress: OverallProgress;
  createdAt?: string;
  updatedAt?: string;
  archivedAt?: string;
  cancelledAt?: string;
  cancelledBy?: string;
  cancelReason?: string;
  cancellationRequestedAt?: string;
  cancellationSettledAt?: string;
  workspaceCheckpoints?: Array<{
    id: string;
    agent: string;
    createdAt: string;
    fileCount: number;
    incomplete: boolean;
    status: "unverified_partial_output" | "no_output";
  }>;
  interruptedAt?: string;
  agents: AgentsConfig;
  orchestration: AgentOrchestrationTemplate;
  skillDefinitions?: ProjectSkillDefinitions;
  mcpDefinitions?: ProjectMcpDefinitions;
  loopIterations?: Record<string, number>;
  loopBatches?: Record<string, number>;
  loopTotalIterations?: Record<string, number>;
  latestHandoff?: HandoffRecord;
  latestAssignment?: CurrentAssignment;
  completionGeneration?: number;
  userIntervention?: UserIntervention;
  userInputs?: ProjectUserInput[];
  interruptionSnapshot?: InterruptionSnapshot;
  interruptRequest?: {
    inputId: string;
    invocationId: string;
    agent: AgentName;
    requestedAt: string;
    deadlineAt: string;
    forceTerminated?: boolean;
  };
  tokenUsage?: ProjectTokenUsage;
  performance?: ProjectPerformance;
  computeUsage?: ProjectComputeUsage;
  git?: ProjectGitState;
  workflowRevision?: number;
  activeNodeRunId?: NodeRunId;
  nodeRuns?: NodeRun[];
  groupRuns?: GroupRun[];
  scopedGroupRuns?: ScopedGroupRun[];
  scopedGroupIssues?: Array<{ id: string; groupRunId: string; kind: "plan" | "route" | "final"; sequence: number;
    arrivalRequestId: string; reason: string; finalOwnershipEpoch?: number }>;
  scopedManagementTurns?: Array<{ projectId: string; groupRunId: string; agentId: string; invocationId: string; coordinatorEpoch: number; status: string; runtimePath?: string }>;
  scopedArrivals?: ScopedArrival[];
  scopedExecutions?: ScopedExecution[];
  scopedAgentReports?: ScopedAgentReport[];
  scopedFinalIntegrations?: ScopedFinalIntegration[];
  scopedPullRequests?: PullRequestRecord[];
  scopedAgentMerges?: ScopedAgentMerge[];
  scopedGroupFinalMerges?: ScopedGroupFinalMerge[];
  tasks?: WorkTask[];
  executions?: MemberExecution[];
  pullRequests?: PullRequestRecord[];
  operations?: OperationRecord[];
  runtime?: ProjectRuntimeProjection;
  failureAttempts?: FailureAttempt[];
  failureSummary?: FailureAttemptSummary;
  mainContextSeq?: number;
  mainCapabilities?: MainCapabilitySnapshot;
  configurationLocked?: boolean;
  lockedAt?: string;
  display?: DisplaySelection;
  displayError?: string;
  /** Explicitly published artifact registrations from the project state. */
  artifacts?: Artifact[];
  error?: string;
}

export interface CreateProjectInput {
  /** Carries the same Explainer conversation into a user-started project. */
  explainerConversationId?: string;
  sourceSavedTaskId?: string;
  title: string;
  requirement: string;
  inputUploadId?: string;
  inputDescription?: string;
  agents: AgentsConfig;
  orchestration?: AgentOrchestrationTemplate;
  skillDefinitions?: ProjectSkillDefinitions;
  mcpDefinitions?: ProjectMcpDefinitions;
  git?: ProjectGitInput;
}

export interface SkillDefinition {
  id: string;
  name: string;
  description?: string;
  category?: string;
}

export interface AgentEvent {
  eventId?: string;
  requestId?: string;
  seq: number;
  projectId?: string;
  workflowRevision?: number;
  nodeId?: WorkflowNodeId;
  nodeRunId?: NodeRunId;
  groupRunId?: GroupRunId;
  agentId?: AgentId;
  taskId?: TaskId;
  executionId?: ExecutionId;
  invocationId?: InvocationId;
  ownershipEpoch?: number;
  coordinatorEpoch?: number;
  type: string;
  agent?: AgentName;
  message: string;
  data?: Record<string, unknown>;
  ts: string;
}

export type ProjectExplainerEventKind =
  | "user"
  | "assistant"
  | "reasoning"
  | "tool"
  | "tool_output"
  | "status"
  | "error";

export interface ProjectExplainerEvent {
  id: string;
  projectId: string;
  turnId: string;
  kind: ProjectExplainerEventKind;
  text: string;
  ts: string;
  itemId?: string;
  phase?: "started" | "delta" | "completed";
  data?: Record<string, unknown>;
}

export interface ProjectExplainerHistory {
  events: ProjectExplainerEvent[];
  active: boolean;
}

export interface ProjectExplainerRuntimeConfig {
  schemaVersion: 1 | 2;
  harness: AgentHarness;
  gatewayId?: string;
  nativeProtocol: AgentProtocol;
  gatewayProtocol: AgentProtocol;
  model: string;
  reasoningEffort: ReasoningEffort;
  revision: number;
  updatedAt: string;
  available: boolean;
  validationError?: string;
  validationWarning?: string;
  routeMode: "direct" | "proxy";
  routeDirection?: `${AgentProtocol}->${AgentProtocol}`;
}

export interface ProjectExplainerConfigInput {
  harness: AgentHarness;
  gatewayId?: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
  confirmHarnessSwitch?: boolean;
}

export interface Artifact {
  id?: string;
  path: string;
  name: string;
  kind: "markdown" | "latex" | "text";
  agent?: AgentName;
  origin?: "workspace";
  cycle?: number;
  mediaType?: string;
  size?: number;
  updatedAt?: string;
  title?: string;
  description?: string;
  /** Immutable content identity captured when the Artifact was published. */
  sha256?: string;
  commitSha?: string;
  workspaceId?: string;
  workspaceLabel?: string;
  variants?: Artifact[];
}

export interface MainCapabilitySnapshot {
  schemaVersion: 1;
  controlMode: "autonomous" | "weak-branch";
  routeCandidates: string[];
  canReconfigure: boolean;
  canComplete: boolean;
  canRequestUser: boolean;
}

export interface HandoffRecord {
  agent: AgentName;
  invocationId: string;
  markdown: string;
  excerpt: string;
  updatedAt: string;
}

export interface ArtifactContent extends Artifact {
  content: string;
}

export interface ArtifactCatalogSummary {
  groups: Record<AgentName, number>;
  total: number;
}

export interface ArtifactCatalogPage extends ArtifactCatalogSummary {
  artifacts: Artifact[];
  offset: number;
  limit: number;
  hasMore: boolean;
}

export interface ArtifactDirectoryEntry extends Artifact {
  type: "directory" | "file";
}

export interface ArtifactDirectoryPage {
  agent: AgentName;
  directory: string;
  parent?: string;
  entries: ArtifactDirectoryEntry[];
  offset: number;
  limit: number;
  total: number;
  hasMore: boolean;
}

export interface Catalog {
  skills: SkillDefinition[];
  models: string[];
  gateways?: GatewayRecord[];
  defaultGatewayId?: string;
  harnesses?: HarnessCatalogEntry[];
  defaultHarnessId?: AgentHarness;
  protocols?: AgentProtocol[];
  routerCompatibilityVersion?: string;
  agentPrompts: Record<string, string>;
  /** Fixed protocol prepended by the backend to every Main invocation. */
  mainSystemPrompt?: string;
  /** Server-owned MCP entries; credentials never cross this boundary. */
  mcpDirectory?: FixedMcpDefinition[];
}

export interface FixedMcpDefinition {
  name: string;
  description: string;
  url: string;
}

export type ConnectionState = "connecting" | "live" | "reconnecting" | "offline";
