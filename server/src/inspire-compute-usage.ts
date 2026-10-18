import { execFile } from "node:child_process";
import type {
  AcceleratorAllocation,
  InspireWorkloadUsage,
  ProjectComputeUsage,
  ProjectView
} from "./types.js";
import {
  INSPIRE_WORKLOAD_KINDS,
  ProjectInspireWorkloadRegistry,
  type InspireWorkloadRegistration
} from "./inspire-workload-registry.js";

const DEFAULT_REFRESH_MS = 10 * 60_000;
const STATUS_CONCURRENCY = 2;
const PROJECT_CONCURRENCY = 4;

type JsonRunner = (
  args: string[],
  signal?: AbortSignal
) => Promise<unknown>;

interface CollectorOptions {
  configPath?: string;
  statusConcurrency?: number;
  runJson?: JsonRunner;
  projectsRoot?: string;
  registry?: Pick<ProjectInspireWorkloadRegistry, "prepare" | "list">;
}

interface ComputeUsageTarget {
  listProjects(includeArchived?: boolean): Promise<ProjectView[]>;
  updateComputeUsage(
    projectId: string,
    usage: ProjectComputeUsage
  ): Promise<ProjectView>;
}

interface JobObservation {
  projectId: string;
  workload: InspireWorkloadUsage;
}

export function emptyProjectComputeUsage(): ProjectComputeUsage {
  return {
    source: "inspire",
    totalCardHours: 0,
    byAccelerator: [],
    workloadCount: 0,
    activeWorkloadCount: 0,
    workloads: []
  };
}

export function isProjectComputeUsage(
  value: unknown
): value is ProjectComputeUsage {
  const usage = record(value);
  if (usage.source !== "inspire") return false;
  if (!nonNegativeNumber(usage.totalCardHours)) return false;
  if (!nonNegativeInteger(usage.workloadCount)) return false;
  if (!nonNegativeInteger(usage.activeWorkloadCount)) return false;
  if (!Array.isArray(usage.byAccelerator) || !Array.isArray(usage.workloads)) {
    return false;
  }
  return (
    usage.byAccelerator.every((item) => {
      const accelerator = record(item);
      return (
        nonEmptyString(accelerator.type) &&
        nonNegativeNumber(accelerator.cardHours)
      );
    }) &&
    usage.workloads.every((item) => {
      const workload = record(item);
      return (
        typeof workload.kind === "string" &&
        (INSPIRE_WORKLOAD_KINDS as readonly string[]).includes(
          workload.kind
        ) &&
        nonEmptyString(workload.name) &&
        nonEmptyString(workload.workspace) &&
        typeof workload.status === "string" &&
        nonNegativeNumber(workload.runningTimeMs) &&
        nonEmptyString(workload.observedAt) &&
        Array.isArray(workload.accelerators) &&
        workload.accelerators.every((allocation) => {
          const accelerator = record(allocation);
          return (
            nonEmptyString(accelerator.type) &&
            nonNegativeInteger(accelerator.count) &&
            accelerator.count > 0
          );
        })
      );
    })
  );
}

export class InspireComputeUsageCollector {
  private readonly runJson: JsonRunner;
  private readonly statusConcurrency: number;
  private readonly registry: Pick<
    ProjectInspireWorkloadRegistry,
    "prepare" | "list"
  >;

  constructor(
    inspireBin: string,
    options: CollectorOptions = {}
  ) {
    this.statusConcurrency = Math.max(
      1,
      Math.floor(options.statusConcurrency ?? STATUS_CONCURRENCY)
    );
    this.runJson =
      options.runJson ?? createJsonRunner(inspireBin, options.configPath);
    if (options.registry) {
      this.registry = options.registry;
    } else if (options.projectsRoot) {
      this.registry = new ProjectInspireWorkloadRegistry(options.projectsRoot);
    } else {
      throw new Error(
        "Inspire compute usage collector requires a project workload registry"
      );
    }
  }

  async collect(
    previousByProject: ReadonlyMap<string, ProjectComputeUsage>,
    signal?: AbortSignal
  ): Promise<Map<string, ProjectComputeUsage>> {
    throwIfAborted(signal);
    const results = await mapWithConcurrency(
      [...previousByProject.entries()],
      PROJECT_CONCURRENCY,
      async ([projectId, previous]) =>
        [
          projectId,
          await this.collectProject(projectId, previous, signal)
        ] as const,
      signal
    );
    return new Map(results);
  }

  async collectProject(
    projectId: string,
    previous: ProjectComputeUsage,
    signal?: AbortSignal
  ): Promise<ProjectComputeUsage> {
    throwIfAborted(signal);
    await this.registry.prepare(projectId);
    const candidates = (await this.registry.list(projectId))
      .filter((registration) => registration.requestedGpuCount !== 0)
      .map((registration) => ({ projectId, registration }));
    const registeredWorkloadKeys = new Set(
      candidates.map(({ registration }) => registrationKey(registration))
    );
    const retainedPrevious = previous.workloads.filter((workload) =>
      registeredWorkloadKeys.has(workloadKey(workload))
    );
    const previousWorkloads = new Map<string, InspireWorkloadUsage>(
      retainedPrevious.map((workload) => [
        `${projectId}\u0000${workloadKey(workload)}`,
        workload
      ])
    );
    const refreshCandidates = candidates.filter((candidate) => {
      const previous = previousWorkloads.get(candidateKey(candidate));
      return !previous || workloadCanStillChange(previous.status);
    });
    const observations = await mapWithConcurrency(
      refreshCandidates,
      this.statusConcurrency,
      async (candidate) => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            const statusPayload = await this.runJson(
              [
                "--no-env-file",
                "--json",
                candidate.registration.kind,
                "status",
                candidate.registration.name,
                "--workspace",
                candidate.registration.workspace
              ],
              signal
            );
            const workload = workloadFromStatus(
              candidate.registration,
              statusPayload
            );
            return workload
              ? ({ projectId: candidate.projectId, workload } satisfies JobObservation)
              : undefined;
          } catch (error) {
            if (signal?.aborted || isAbortError(error)) throw error;
            if (attempt === 1) return undefined;
          }
        }
        return undefined;
      },
      signal
    );
    throwIfAborted(signal);

    const ledger = new Map(
      retainedPrevious.map((workload) => [workloadKey(workload), workload])
    );
    for (const observation of observations) {
      if (observation) {
        ledger.set(workloadKey(observation.workload), observation.workload);
      }
    }
    return summarizeComputeUsage(
      [...ledger.values()],
      new Date().toISOString()
    );
  }
}

export class InspireComputeUsageMonitor {
  private timer?: NodeJS.Timeout;
  private controller?: AbortController;
  private inFlight?: Promise<void>;

  constructor(
    private readonly collector: InspireComputeUsageCollector,
    private readonly target: ComputeUsageTarget,
    private readonly refreshMs = DEFAULT_REFRESH_MS
  ) {}

  start(): void {
    if (this.timer) return;
    void this.refreshNow();
    this.timer = setInterval(() => void this.refreshNow(), this.refreshMs);
    this.timer.unref();
  }

  refreshNow(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    const refresh = this.refresh(signal)
      .catch((error) => {
        if (!signal.aborted && !isAbortError(error)) {
          console.warn("Failed to refresh Inspire compute usage", error);
        }
      })
      .finally(() => {
        if (this.inFlight === refresh) this.inFlight = undefined;
        if (this.controller?.signal === signal) this.controller = undefined;
      });
    this.inFlight = refresh;
    return refresh;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.controller?.abort();
    await this.inFlight;
  }

  private async refresh(signal: AbortSignal): Promise<void> {
    const projects = await this.target.listProjects(true);
    throwIfAborted(signal);
    await mapWithConcurrency(
      projects,
      PROJECT_CONCURRENCY,
      async (project) => {
        const previous = isProjectComputeUsage(project.computeUsage)
          ? project.computeUsage
          : emptyProjectComputeUsage();
        const usage = await this.collector.collectProject(
          project.id,
          previous,
          signal
        );
        throwIfAborted(signal);
        await this.target.updateComputeUsage(project.id, usage);
      },
      signal
    );
  }
}

function createJsonRunner(
  inspireBin: string,
  configPath?: string
): JsonRunner {
  return (args, signal) =>
    new Promise((resolve, reject) => {
      const environment = { ...process.env };
      for (const key of [
        "http_proxy",
        "https_proxy",
        "HTTP_PROXY",
        "HTTPS_PROXY"
      ]) {
        delete environment[key];
      }
      if (configPath) environment.INSPIRE_GLOBAL_CONFIG_PATH = configPath;
      execFile(
        inspireBin,
        args,
        {
          encoding: "utf8",
          env: environment,
          maxBuffer: 32 * 1024 * 1024,
          timeout: 120_000,
          signal
        },
        (error, stdout, stderr) => {
          if (error) {
            reject(
              new Error(
                `Inspire command failed: ${stderr.trim() || error.message}`,
                { cause: error }
              )
            );
            return;
          }
          try {
            resolve(JSON.parse(stdout));
          } catch (parseError) {
            reject(
              new Error("Inspire command returned invalid JSON", {
                cause: parseError
              })
            );
          }
        }
      );
    });
}

function workloadFromStatus(
  candidate: InspireWorkloadRegistration,
  payload: unknown
): InspireWorkloadUsage | undefined {
  const root = record(payload);
  if (root.success !== true) {
    throw new Error("Inspire workload status did not succeed");
  }
  const data = record(root.data);
  const workload =
    candidate.kind === "job"
      ? record(data.job)
      : Object.keys(record(data[candidate.kind])).length > 0
        ? record(data[candidate.kind])
        : data;
  const runningTimeMs = runningTimeFromStatus(workload);
  if (runningTimeMs === undefined) {
    throw new Error("Inspire workload status omitted usable runtime fields");
  }
  const allocations = allocationsFromWorkload(workload, candidate);
  if (allocations.length === 0) return undefined;
  return {
    kind: candidate.kind,
    name: candidate.name,
    workspace: candidate.workspace,
    status: stringValue(
      workload.status ?? workload.phase ?? workload.state
    ),
    runningTimeMs,
    accelerators: allocations,
    observedAt: new Date().toISOString()
  };
}

function allocationsFromWorkload(
  workload: Record<string, unknown>,
  candidate: InspireWorkloadRegistration
): AcceleratorAllocation[] {
  const totals = new Map<string, number>();
  const specCollections = [
    workload.framework_config,
    workload.frameworkConfig,
    workload.worker_groups,
    workload.workerGroups,
    workload.workers,
    workload.resource_specs,
    workload.resourceSpecs
  ];
  for (const collection of specCollections) {
    if (!Array.isArray(collection)) continue;
    for (const spec of collection) addAllocation(totals, record(spec));
  }
  if (totals.size === 0) {
    for (const value of [
      workload,
      workload.quota,
      workload.resource,
      workload.resource_spec,
      workload.resourceSpec,
      workload.resource_spec_price,
      workload.resourceSpecPrice,
      workload.instance_spec_price_info,
      workload.instanceSpecPriceInfo
    ]) {
      addAllocation(totals, record(value));
      if (totals.size > 0) break;
    }
  }
  if (totals.size === 0 && candidate.requestedGpuCount) {
    totals.set(
      acceleratorType(candidate.requestedAcceleratorType ?? "") || "GPU",
      candidate.requestedGpuCount
    );
  }
  return [...totals]
    .filter(([, count]) => count > 0)
    .map(([type, count]) => ({ type, count }))
    .sort((left, right) => left.type.localeCompare(right.type));
}

function addAllocation(
  totals: Map<string, number>,
  spec: Record<string, unknown>
): void {
  if (Object.keys(spec).length === 0) return;
  const price = record(
    spec.instance_spec_price_info ??
      spec.instanceSpecPriceInfo ??
      spec.resource_spec_price ??
      spec.resourceSpecPrice
  );
  const gpuInfo = record(
    price.gpu_info ?? price.gpuInfo ?? spec.gpu_info ?? spec.gpuInfo
  );
  const type = acceleratorType(
    stringValue(
      gpuInfo.gpu_product_simple ??
        gpuInfo.gpuProductSimple ??
        gpuInfo.gpu_type_display ??
        gpuInfo.gpuTypeDisplay ??
        gpuInfo.gpu_type ??
        gpuInfo.gpuType ??
        spec.gpu_type_display ??
        spec.gpuTypeDisplay ??
        spec.gpu_type ??
        spec.gpuType
    )
  );
  const perInstance = positiveInteger(
    spec.gpu_count ?? spec.gpuCount ?? price.gpu_count ?? price.gpuCount
  );
  const instances = positiveInteger(
    spec.instance_count ??
      spec.instanceCount ??
      spec.replicas ??
      spec.replica_count ??
      spec.replicaCount,
    1
  );
  if (perInstance > 0) {
    const resolvedType = type || "GPU";
    totals.set(
      resolvedType,
      (totals.get(resolvedType) ?? 0) + perInstance * instances
    );
  }
}

function runningTimeFromStatus(
  workload: Record<string, unknown>
): number | undefined {
  const direct = nonNegativeNumericValue(
    workload.running_time_ms ??
      workload.runningTimeMs ??
      workload.runtime_ms ??
      workload.runtimeMs
  );
  if (direct !== undefined) return direct;

  const status = stringValue(
    workload.status ?? workload.phase ?? workload.state
  ).toLowerCase();
  const startedAt = timestampMs(
    workload.started_at ??
      workload.startedAt ??
      workload.start_time ??
      workload.startTime ??
      workload.running_at ??
      workload.runningAt ??
      workload.created_at ??
      workload.createdAt
  );
  if (startedAt === undefined) return undefined;
  const terminal = !workloadCanStillChange(status);
  const endedAt = timestampMs(
    workload.finished_at ??
      workload.finishedAt ??
      workload.completed_at ??
      workload.completedAt ??
      workload.stopped_at ??
      workload.stoppedAt ??
      workload.ended_at ??
      workload.endedAt
  );
  const effectiveEnd = endedAt ?? (terminal ? undefined : Date.now());
  if (effectiveEnd === undefined) return undefined;
  return Math.max(0, effectiveEnd - startedAt);
}

function timestampMs(value: unknown): number | undefined {
  if (typeof value === "number" || typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) {
      return numeric < 10_000_000_000 ? numeric * 1_000 : numeric;
    }
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function acceleratorType(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const commonModel = trimmed.match(
    /\b(?:H\d{2,4}|A\d{2,4}|L\d{2,4}S?|V\d{2,4})\b/i
  )?.[0];
  return commonModel ? commonModel.toUpperCase() : trimmed;
}

function summarizeComputeUsage(
  workloads: InspireWorkloadUsage[],
  updatedAt: string
): ProjectComputeUsage {
  const totals = new Map<string, number>();
  let totalCardHours = 0;
  for (const workload of workloads) {
    const runtimeHours = workload.runningTimeMs / 3_600_000;
    for (const allocation of workload.accelerators) {
      const cardHours = runtimeHours * allocation.count;
      totals.set(allocation.type, (totals.get(allocation.type) ?? 0) + cardHours);
      totalCardHours += cardHours;
    }
  }
  const sortedWorkloads = [...workloads].sort(
    (left, right) =>
      left.workspace.localeCompare(right.workspace) ||
      left.name.localeCompare(right.name)
  );
  return {
    source: "inspire",
    totalCardHours: roundOne(totalCardHours),
    byAccelerator: [...totals]
      .map(([type, cardHours]) => ({ type, cardHours: roundOne(cardHours) }))
      .sort(
        (left, right) =>
          right.cardHours - left.cardHours || left.type.localeCompare(right.type)
      ),
    workloadCount: sortedWorkloads.length,
    activeWorkloadCount: sortedWorkloads.filter((workload) =>
      workload.status.toLowerCase().includes("running")
    ).length,
    workloads: sortedWorkloads,
    updatedAt
  };
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
  signal?: AbortSignal
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (cursor < values.length) {
        throwIfAborted(signal);
        const index = cursor;
        cursor += 1;
        results[index] = await operation(values[index]!);
      }
    }
  );
  await Promise.all(workers);
  return results;
}

function workloadKey(workload: InspireWorkloadUsage): string {
  return `${workload.kind}\u0000${workload.workspace}\u0000${workload.name}`;
}

function registrationKey(registration: InspireWorkloadRegistration): string {
  return `${registration.kind}\u0000${registration.workspace}\u0000${registration.name}`;
}

function candidateKey(candidate: {
  projectId: string;
  registration: InspireWorkloadRegistration;
}): string {
  return `${candidate.projectId}\u0000${candidate.registration.kind}\u0000${candidate.registration.workspace}\u0000${candidate.registration.name}`;
}

function workloadCanStillChange(status: string): boolean {
  const normalized = status.toLowerCase();
  return ![
    "succeeded",
    "completed",
    "failed",
    "cancelled",
    "canceled",
    "stopped"
  ].some((terminal) => normalized.includes(terminal));
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function nonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return nonNegativeNumber(value) && Number.isSafeInteger(value);
}

function nonNegativeNumericValue(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function positiveInteger(value: unknown, fallback = 0): number {
  const parsed = nonNegativeNumericValue(value);
  return parsed !== undefined && parsed > 0 ? Math.floor(parsed) : fallback;
}

function roundOne(value: number): number {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.message.toLowerCase().includes("abort"))
  );
}
