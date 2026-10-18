import { randomUUID } from "node:crypto";
import { createReadStream, promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import readline from "node:readline";

export const INSPIRE_WORKLOAD_KINDS = [
  "job",
  "hpc",
  "notebook",
  "ray",
  "serving"
] as const;

export type InspireWorkloadKind = (typeof INSPIRE_WORKLOAD_KINDS)[number];

export interface InspireWorkloadRegistration {
  schemaVersion: 1 | 2;
  projectId: string;
  invocationId: string;
  kind: InspireWorkloadKind;
  name: string;
  workspace: string;
  registeredAt: string;
  source: "wrapper" | "trace-backfill";
  requestedGpuCount?: number;
  requestedAcceleratorType?: string;
}

interface BackfillCursor {
  schemaVersion: 3;
  files: Record<string, number>;
  updatedAt: string;
}

interface RegistrationContext {
  projectId: string;
  invocationId: string;
  registeredAt?: string;
  source: InspireWorkloadRegistration["source"];
}

interface CreateHint {
  kind: InspireWorkloadKind;
  name: string;
  workspace: string;
  requestedGpuCount?: number;
  requestedAcceleratorType?: string;
}

const PROJECT_ID_PATTERN = /^prj_[a-f0-9]{32}$/;
const INVOCATION_ID_PATTERN = /^inv_[a-z0-9_-]+$/i;
const LEDGER_FILE = "inspire-workloads.jsonl";
const BACKFILL_CURSOR_FILE = "inspire-workloads.backfill.json";

export function inspireWorkloadLedgerPath(projectPath: string): string {
  return path.join(projectPath, "runtime", LEDGER_FILE);
}

/** Extract accounting metadata from literal MCP arguments, never the program text. */
export function registrationFromCreateArgs(
  args: string[],
  context: RegistrationContext
): InspireWorkloadRegistration | undefined {
  const kind = args[0];
  if (!kind || !isWorkloadKind(kind) || args[1] !== "create") return undefined;
  const keys = ["--name", "--workspace", "--quota", "-q", "--nodes", "--instance-count", "--replicas", "--nodes-per-replica", "--group"];
  const metadata: string[] = [];
  for (const key of keys) {
    const inline = args.find(value => value.startsWith(`${key}=`));
    const index = args.indexOf(key);
    const value = inline?.slice(key.length + 1) ?? (index >= 0 ? args[index + 1] : undefined);
    if (value !== undefined) metadata.push(key, `"${value.replace(/["\n\r]/g, "")}"`);
  }
  const command = `inspire ${kind} create ${metadata.join(" ")}`;
  return registrationsFromTrace(command, JSON.stringify({ success: true, data: { sub_code: 0 } }), context)[0];
}

/**
 * Project-scoped workload identity ledger.
 *
 * The registry deliberately records the successful create operation while it
 * is still inside a project invocation. It never tries to infer ownership by
 * inspecting a workload's remote startup command.
 */
export class ProjectInspireWorkloadRegistry {
  constructor(private readonly projectsRoot: string) {}

  async prepare(projectId: string): Promise<void> {
    const projectPath = this.projectPath(projectId);
    await fs.mkdir(path.join(projectPath, "runtime"), { recursive: true });
    await this.backfill(projectId);
  }

  async list(projectId: string): Promise<InspireWorkloadRegistration[]> {
    const ledgerPath = inspireWorkloadLedgerPath(this.projectPath(projectId));
    let contents: string;
    try {
      contents = await fs.readFile(ledgerPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const registrations = contents
      .split("\n")
      .flatMap((line) => {
        if (!line.trim()) return [];
        try {
          const registration = parseRegistration(JSON.parse(line));
          return registration?.projectId === projectId ? [registration] : [];
        } catch {
          return [];
        }
      });
    return deduplicateRegistrations(registrations);
  }

  async backfill(projectId: string): Promise<number> {
    const projectPath = this.projectPath(projectId);
    const runtimePath = path.join(projectPath, "runtime");
    let entries: Dirent[];
    try {
      entries = await fs.readdir(runtimePath, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }

    const cursorPath = path.join(runtimePath, BACKFILL_CURSOR_FILE);
    const cursor = await readBackfillCursor(cursorPath);
    const known = new Map(
      (await this.list(projectId)).map((registration) => [
        registrationKey(registration),
        registration
      ])
    );
    const discovered: InspireWorkloadRegistration[] = [];
    const invocationDirectories = entries
      .filter(
        (entry) =>
          entry.isDirectory() && INVOCATION_ID_PATTERN.test(entry.name)
      )
      .map((entry) => entry.name)
      .sort();

    for (const invocationId of invocationDirectories) {
      const relativePath = path.join(invocationId, "codex-events.jsonl");
      const eventPath = path.join(runtimePath, relativePath);
      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await fs.stat(eventPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (!stat.isFile()) continue;
      const previousOffset = cursor.files[relativePath] ?? 0;
      const start = previousOffset <= stat.size ? previousOffset : 0;
      if (start === stat.size) continue;

      let consumed = start;
      const input = createReadStream(eventPath, {
        encoding: "utf8",
        start,
        end: Math.max(start, stat.size - 1)
      });
      const lines = readline.createInterface({ input, crlfDelay: Infinity });
      for await (const line of lines) {
        const encodedBytes = Buffer.byteLength(line) + 1;
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          // Leave an incomplete trailing line for the next refresh.
          if (consumed + encodedBytes > stat.size) break;
          consumed = Math.min(stat.size, consumed + encodedBytes);
          continue;
        }
        const eventRecord = record(event);
        const item = record(eventRecord.item);
        if (
          eventRecord.type === "item.completed" &&
          item.type === "command_execution" &&
          Number(item.exit_code) === 0
        ) {
          const registrations = registrationsFromTrace(
            stringValue(item.command),
            stringValue(item.aggregated_output),
            {
              projectId,
              invocationId,
              source: "trace-backfill"
            }
          );
          for (const registration of registrations) {
            const key = registrationKey(registration);
            const previous = known.get(key);
            if (previous && !registrationAddsEvidence(previous, registration)) {
              continue;
            }
            known.set(key, { ...previous, ...registration });
            discovered.push(registration);
          }
        }
        consumed = Math.min(stat.size, consumed + encodedBytes);
      }
      cursor.files[relativePath] = consumed;
    }

    if (discovered.length > 0) {
      await appendRegistrations(
        inspireWorkloadLedgerPath(projectPath),
        discovered
      );
    }
    cursor.updatedAt = new Date().toISOString();
    await atomicJson(cursorPath, cursor);
    return discovered.length;
  }

  private projectPath(projectId: string): string {
    if (!PROJECT_ID_PATTERN.test(projectId)) {
      throw new Error("Invalid project id for Inspire workload registry");
    }
    return path.join(this.projectsRoot, projectId);
  }
}

export function registrationsFromTrace(
  command: string,
  output: string,
  context: RegistrationContext
): InspireWorkloadRegistration[] {
  if (!PROJECT_ID_PATTERN.test(context.projectId)) return [];
  if (!INVOCATION_ID_PATTERN.test(context.invocationId)) return [];

  const hints = createHintsFromCommand(command);
  const registrations: InspireWorkloadRegistration[] = [];
  const singleKind = new Set(hints.map((hint) => hint.kind));
  const singleWorkspace = new Set(
    hints.map((hint) => hint.workspace).filter((item) => item !== "all")
  );
  let unnamedCreateAcknowledgements = 0;

  for (const document of jsonDocuments(output)) {
    const root = record(document);
    if (root.success !== true) continue;
    const data = record(root.data);
    if (data.dry_run === true || data.dryRun === true) continue;
    if (Number(data.sub_code ?? data.subCode) === 0) {
      unnamedCreateAcknowledgements += 1;
    }
    const candidate = data.job && typeof data.job === "object"
      ? record(data.job)
      : data;
    const name = stringValue(candidate.name);
    if (!validWorkloadName(name) || stringValue(candidate.status)) continue;
    const matchingHint = hints.find((hint) => hint.name === name);
    const kind =
      matchingHint?.kind ??
      (singleKind.size === 1 ? [...singleKind][0] : inferCreateKind(candidate));
    if (!kind) continue;
    const payloadWorkspace = stringValue(
      candidate.workspace_name ??
        candidate.workspaceName ??
        candidate.workspace
    );
    const workspace =
      payloadWorkspace ||
      matchingHint?.workspace ||
      (singleWorkspace.size === 1 ? [...singleWorkspace][0]! : "all");
    const allocation = requestedAllocationFromPayload(candidate);
    registrations.push(
      registrationFromHint(
        {
          kind,
          name,
          workspace: workspace || "all",
          requestedGpuCount:
            allocation.count ?? matchingHint?.requestedGpuCount,
          requestedAcceleratorType:
            allocation.type || matchingHint?.requestedAcceleratorType
        },
        context
      )
    );
  }
  if (
    hints.length > 0 &&
    unnamedCreateAcknowledgements >= hints.length
  ) {
    registrations.push(
      ...hints.map((hint) => registrationFromHint(hint, context))
    );
  }
  for (const success of successfulCreatesFromOutput(output)) {
    const matchingHint = hints.find(
      (hint) => hint.kind === success.kind && hint.name === success.name
    );
    registrations.push(
      registrationFromHint(
        {
          ...success,
          workspace:
            success.workspace || matchingHint?.workspace || "all",
          requestedGpuCount:
            success.requestedGpuCount ?? matchingHint?.requestedGpuCount,
          requestedAcceleratorType:
            success.requestedAcceleratorType ??
            matchingHint?.requestedAcceleratorType
        },
        context
      )
    );
  }
  return deduplicateRegistrations(registrations);
}

/** Source for the tiny helper staged beside each project-specific wrapper. */
export function inspireWorkloadRecorderSource(): string {
  return `import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
const kinds = new Set(["job", "hpc", "notebook", "ray", "serving"]);
const rawArgs = process.argv.slice(2);
const outputIndex = rawArgs.indexOf("--scienceevolve-output-file");
let output = "";
if (outputIndex >= 0) {
  try { output = readFileSync(rawArgs[outputIndex + 1], "utf8"); } catch {}
  rawArgs.splice(outputIndex, 2);
}
const args = rawArgs.filter((arg, index) => !(arg === "--" && index === 0));
const groupIndex = args.findIndex((arg) => kinds.has(arg));
if (groupIndex < 0 || args.includes("--dry-run")) process.exit(0);
const kind = args[groupIndex];
const action = args[groupIndex + 1];
if (action !== "create" && action !== "batch") process.exit(0);
const option = (...names) => {
  for (let index = 0; index < args.length; index += 1) {
    for (const name of names) {
      if (args[index] === name) return args[index + 1] || "";
      if (args[index].startsWith(name + "=")) return args[index].slice(name.length + 1);
    }
  }
  return "";
};
const positive = (value, fallback = 1) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};
const nonNegative = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : undefined;
};
const validName = (value) => /^[\\p{L}\\p{N}][\\p{L}\\p{N}._-]{0,254}$/u.test(value);
const acceleratorFrom = (value) => (value.match(/\\b(?:H\\d{2,4}|A\\d{2,4}|L\\d{2,4}S?|V\\d{2,4})\\b/i) || [""])[0].toUpperCase();
const statusHints = new Map();
for (const match of output.matchAll(/Check status with:\\s*inspire\\s+(job|hpc|notebook|ray|serving)\\s+status\\s+(?:"([^"\\n]+)"|'([^'\\n]+)'|([^\\s]+))\\s+--workspace\\s+(?:"([^"\\n]+)"|'([^'\\n]+)'|([^\\s]+))/gi)) {
  const statusKind = (match[1] || "").toLowerCase();
  const statusName = (match[2] || match[3] || match[4] || "").trim();
  const statusWorkspace = (match[5] || match[6] || match[7] || "").trim();
  if (validName(statusName) && statusWorkspace) statusHints.set(statusKind + "\\0" + statusName, statusWorkspace);
}
const base = {
  schemaVersion: 2,
  projectId: process.env.SCIENCEEVOLVE_PROJECT_ID,
  invocationId: process.env.SCIENCEEVOLVE_INVOCATION_ID,
  registeredAt: new Date().toISOString(),
  source: "wrapper"
};
if (!/^prj_[a-f0-9]{32}$/.test(base.projectId || "")) process.exit(0);
if (!/^inv_[a-z0-9_-]+$/i.test(base.invocationId || "")) process.exit(0);
const ledger = process.env.SCIENCEEVOLVE_INSPIRE_WORKLOAD_LEDGER;
if (!ledger) process.exit(0);
const records = [];
if (action === "create") {
  const name = option("--name", "-n");
  if (!validName(name)) process.exit(0);
  const workspace = option("--workspace") || statusHints.get(kind + "\\0" + name) || "all";
  const quota = option("--quota", "-q");
  const quotaGpu = quota ? nonNegative(quota.split(",")[0]) : undefined;
  let scale = 1;
  if (kind === "job") scale = positive(option("--nodes"), 1);
  if (kind === "hpc") scale = positive(option("--instance-count"), 1);
  if (kind === "serving") scale = positive(option("--replicas"), 1) * positive(option("--nodes-per-replica"), 1);
  const accelerator = acceleratorFrom(option("--group"));
  records.push({
    ...base,
    kind,
    name,
    workspace,
    ...(quotaGpu !== undefined ? { requestedGpuCount: quotaGpu * scale } : {}),
    ...(accelerator ? { requestedAcceleratorType: accelerator } : {})
  });
} else {
  const markers = [...output.matchAll(/\\bOK\\s+(Job|HPC\\s+job|Notebook|Ray|Serving)\\s+created:\\s*([^\\s]+)/gi)];
  for (let index = 0; index < markers.length; index += 1) {
    const marker = markers[index];
    const label = (marker[1] || "").toLowerCase();
    const batchKind = label === "hpc job" ? "hpc" : label;
    const name = (marker[2] || "").trim();
    if (!kinds.has(batchKind) || !validName(name)) continue;
    const blockStart = index === 0 ? 0 : (markers[index - 1].index || 0);
    const blockEnd = markers[index + 1]?.index || output.length;
    const block = output.slice(blockStart, blockEnd);
    const quotaMatches = [...block.matchAll(/\\bQuota:\\s*([0-9]+)\\s*,/gi)];
    const quotaGpu = quotaMatches.length ? nonNegative(quotaMatches.at(-1)[1]) : undefined;
    const groupMatches = [...block.matchAll(/\\bUsing compute group:\\s*([^\\n\\r]+)/gi)];
    const accelerator = acceleratorFrom(groupMatches.at(-1)?.[1] || "");
    records.push({
      ...base,
      kind: batchKind,
      name,
      workspace: statusHints.get(batchKind + "\\0" + name) || "all",
      ...(quotaGpu !== undefined ? { requestedGpuCount: quotaGpu } : {}),
      ...(accelerator ? { requestedAcceleratorType: accelerator } : {})
    });
  }
}
if (records.length === 0) process.exit(0);
mkdirSync(dirname(ledger), { recursive: true });
appendFileSync(ledger, records.map((record) => JSON.stringify(record)).join("\\n") + "\\n", { encoding: "utf8", mode: 0o600 });
`;
}

function createHintsFromCommand(command: string): CreateHint[] {
  const starts = [
    ...command.matchAll(
      /\binspire(?:\s+--[a-z0-9-]+(?:=[^\s]+)?)*\s+(job|hpc|notebook|ray|serving)\s+create\b/gi
    )
  ];
  return starts.flatMap((match, index) => {
    const kind = match[1]?.toLowerCase() as InspireWorkloadKind | undefined;
    if (!kind || !isWorkloadKind(kind)) return [];
    const start = match.index ?? 0;
    const end = starts[index + 1]?.index ?? command.length;
    const segment = command.slice(start, end);
    if (/(?:^|\s)--dry-run(?:\s|$)/.test(segment)) return [];
    const name = shellOption(segment, ["--name", "-n"]);
    if (!validWorkloadName(name)) return [];
    const workspace = shellOption(segment, ["--workspace"]) || "all";
    const quota = shellOption(segment, ["--quota", "-q"]);
    const gpuPerInstance = quota
      ? nonNegativeInteger(quota.split(",")[0])
      : undefined;
    let scale = 1;
    if (kind === "job") {
      scale = positiveInteger(shellOption(segment, ["--nodes"]), 1);
    } else if (kind === "hpc") {
      scale = positiveInteger(
        shellOption(segment, ["--instance-count"]),
        1
      );
    } else if (kind === "serving") {
      scale =
        positiveInteger(shellOption(segment, ["--replicas"]), 1) *
        positiveInteger(
          shellOption(segment, ["--nodes-per-replica"]),
          1
        );
    }
    const group = shellOption(segment, ["--group"]);
    return [
      {
        kind,
        name,
        workspace,
        ...(gpuPerInstance !== undefined
          ? { requestedGpuCount: gpuPerInstance * scale }
          : {}),
        ...(acceleratorType(group)
          ? { requestedAcceleratorType: acceleratorType(group) }
          : {})
      }
    ];
  });
}

function successfulCreatesFromOutput(output: string): CreateHint[] {
  const statusHints = statusHintsFromOutput(output);
  const markers = [
    ...output.matchAll(
      /\bOK\s+(Job|HPC\s+job|Notebook|Ray|Serving)\s+created:\s*([^\s]+)/gi
    )
  ];
  return markers.flatMap((marker, index) => {
    const kind = workloadKindFromLabel(marker[1] ?? "");
    const name = (marker[2] ?? "").trim();
    if (!kind || !validWorkloadName(name)) return [];
    const statusHint = statusHints.find(
      (hint) => hint.kind === kind && hint.name === name
    );
    const blockStart = index === 0 ? 0 : (markers[index - 1]?.index ?? 0);
    const blockEnd = markers[index + 1]?.index ?? output.length;
    const block = output.slice(blockStart, blockEnd);
    const quota = [...block.matchAll(/\bQuota:\s*([0-9]+)\s*,/gi)].at(-1);
    const gpuPerInstance = quota
      ? nonNegativeInteger(quota[1])
      : undefined;
    const groups = [
      ...block.matchAll(/\bUsing compute group:\s*([^\n\r]+)/gi)
    ];
    const group = groups.at(-1)?.[1] ?? "";
    const accelerator = knownAcceleratorType(group);
    return [
      {
        kind,
        name,
        workspace: statusHint?.workspace ?? "all",
        ...(gpuPerInstance !== undefined
          ? { requestedGpuCount: gpuPerInstance }
          : {}),
        ...(accelerator
          ? { requestedAcceleratorType: accelerator }
          : {})
      }
    ];
  });
}

function statusHintsFromOutput(output: string): CreateHint[] {
  return [
    ...output.matchAll(
      /Check status with:\s*inspire\s+(job|hpc|notebook|ray|serving)\s+status\s+(?:"([^"\n]+)"|'([^'\n]+)'|([^\s]+))\s+--workspace\s+(?:"([^"\n]+)"|'([^'\n]+)'|([^\s]+))/gi
    )
  ].flatMap((match) => {
    const kind = (match[1] ?? "").toLowerCase();
    const name = (match[2] ?? match[3] ?? match[4] ?? "").trim();
    const workspace = (match[5] ?? match[6] ?? match[7] ?? "").trim();
    return isWorkloadKind(kind) &&
      validWorkloadName(name) &&
      validWorkspace(workspace)
      ? [{ kind, name, workspace }]
      : [];
  });
}

function workloadKindFromLabel(
  value: string
): InspireWorkloadKind | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "hpc job") return "hpc";
  return isWorkloadKind(normalized) ? normalized : undefined;
}

function shellOption(segment: string, names: string[]): string {
  const options = names
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const match = segment.match(
    new RegExp(
      `(?:^|\\s)(?:${options})(?:=|\\s+)(?:"([^"\\n]*)"|'([^'\\n]*)'|([^\\s;&|]+))`
    )
  );
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim();
}

function inferCreateKind(
  payload: Record<string, unknown>
): InspireWorkloadKind | undefined {
  const explicitKind = stringValue(payload.kind).toLowerCase();
  if (isWorkloadKind(explicitKind)) return explicitKind;
  if (Array.isArray(payload.framework_config) || "auto_fault_tolerance" in payload) {
    return "job";
  }
  if ("slurm_config" in payload || "number_of_tasks" in payload) return "hpc";
  if ("worker_groups" in payload || "ray_version" in payload) return "ray";
  if ("inference_serving_type" in payload || "model_version" in payload) {
    return "serving";
  }
  if ("notebook_url" in payload || "auto_stop" in payload) return "notebook";
  return undefined;
}

function requestedAllocationFromPayload(
  payload: Record<string, unknown>
): { type: string; count?: number } {
  const framework = payload.framework_config ?? payload.frameworkConfig;
  if (Array.isArray(framework)) {
    let count = 0;
    let type = "";
    let sawGpuCount = false;
    for (const item of framework) {
      const spec = record(item);
      const price = record(
        spec.instance_spec_price_info ??
          spec.instanceSpecPriceInfo ??
          spec.resource_spec_price
      );
      const gpu = record(price.gpu_info ?? price.gpuInfo);
      type ||= acceleratorType(
        stringValue(
          gpu.gpu_product_simple ??
            gpu.gpuProductSimple ??
            gpu.gpu_type_display ??
            gpu.gpuTypeDisplay ??
            gpu.gpu_type ??
            gpu.gpuType
        )
      );
      const rawGpuCount = spec.gpu_count ?? spec.gpuCount;
      sawGpuCount ||= rawGpuCount !== undefined;
      count +=
        (nonNegativeInteger(rawGpuCount) ?? 0) *
        positiveInteger(spec.instance_count ?? spec.instanceCount, 1);
    }
    if (sawGpuCount) return { type, count };
  }
  const quota = record(payload.quota ?? payload.resource ?? payload.resource_spec);
  const rawCount =
    quota.gpu_count ?? quota.gpuCount ?? payload.gpu_count ?? payload.gpuCount;
  return {
    type: acceleratorType(
      stringValue(
        quota.gpu_type ?? quota.gpuType ?? payload.gpu_type ?? payload.gpuType
      )
    ),
    ...(rawCount !== undefined
      ? { count: nonNegativeInteger(rawCount) }
      : {})
  };
}

function registrationFromHint(
  hint: CreateHint,
  context: RegistrationContext
): InspireWorkloadRegistration {
  return {
    schemaVersion: 2,
    projectId: context.projectId,
    invocationId: context.invocationId,
    kind: hint.kind,
    name: hint.name,
    workspace: hint.workspace || "all",
    registeredAt: context.registeredAt ?? new Date().toISOString(),
    source: context.source,
    ...(hint.requestedGpuCount !== undefined && hint.requestedGpuCount >= 0
      ? { requestedGpuCount: hint.requestedGpuCount }
      : {}),
    ...(hint.requestedAcceleratorType
      ? { requestedAcceleratorType: hint.requestedAcceleratorType }
      : {})
  };
}

function deduplicateRegistrations(
  registrations: InspireWorkloadRegistration[]
): InspireWorkloadRegistration[] {
  const exact = new Map<string, InspireWorkloadRegistration>();
  for (const registration of registrations) {
    const key = registrationKey(registration);
    const previous = exact.get(key);
    exact.set(key, {
      ...(previous ?? registration),
      ...registration,
      registeredAt:
        previous && previous.registeredAt < registration.registeredAt
          ? previous.registeredAt
          : registration.registeredAt,
      requestedGpuCount:
        registration.requestedGpuCount ?? previous?.requestedGpuCount,
      requestedAcceleratorType:
        registration.requestedAcceleratorType ??
        previous?.requestedAcceleratorType
    });
  }
  const explicit = new Set(
    [...exact.values()]
      .filter((registration) => registration.workspace !== "all")
      .map((registration) => `${registration.kind}\u0000${registration.name}`)
  );
  return [...exact.values()]
    .filter(
      (registration) =>
        registration.workspace !== "all" ||
        !explicit.has(`${registration.kind}\u0000${registration.name}`)
    )
    .sort(
      (left, right) =>
        left.registeredAt.localeCompare(right.registeredAt) ||
        left.kind.localeCompare(right.kind) ||
        left.name.localeCompare(right.name)
    );
}

function registrationKey(registration: InspireWorkloadRegistration): string {
  return `${registration.kind}\u0000${registration.workspace}\u0000${registration.name}`;
}

function registrationAddsEvidence(
  previous: InspireWorkloadRegistration,
  next: InspireWorkloadRegistration
): boolean {
  if (previous.source === "wrapper") return false;
  return (
    (next.requestedGpuCount !== undefined &&
      next.requestedGpuCount !== previous.requestedGpuCount) ||
    Boolean(
      next.requestedAcceleratorType &&
        next.requestedAcceleratorType !== previous.requestedAcceleratorType
    )
  );
}

function parseRegistration(value: unknown): InspireWorkloadRegistration | undefined {
  const item = record(value);
  const kind = stringValue(item.kind);
  const requestedGpuCount = optionalNonNegativeInteger(item.requestedGpuCount);
  const source = stringValue(item.source);
  const schemaVersion = Number(item.schemaVersion);
  if (
    !(
      (source === "wrapper" &&
        (schemaVersion === 1 || schemaVersion === 2)) ||
      (source === "trace-backfill" && schemaVersion === 2)
    ) ||
    !PROJECT_ID_PATTERN.test(stringValue(item.projectId)) ||
    !INVOCATION_ID_PATTERN.test(stringValue(item.invocationId)) ||
    !isWorkloadKind(kind) ||
    !validWorkloadName(stringValue(item.name)) ||
    !validWorkspace(stringValue(item.workspace)) ||
    !stringValue(item.registeredAt) ||
    (source !== "wrapper" && source !== "trace-backfill")
  ) {
    return undefined;
  }
  return {
    schemaVersion: schemaVersion as 1 | 2,
    projectId: stringValue(item.projectId),
    invocationId: stringValue(item.invocationId),
    kind,
    name: stringValue(item.name),
    workspace: stringValue(item.workspace),
    registeredAt: stringValue(item.registeredAt),
    source,
    ...(requestedGpuCount !== undefined ? { requestedGpuCount } : {}),
    ...(stringValue(item.requestedAcceleratorType)
      ? {
          requestedAcceleratorType: acceleratorType(
            stringValue(item.requestedAcceleratorType)
          )
        }
      : {})
  };
}

async function appendRegistrations(
  ledgerPath: string,
  registrations: InspireWorkloadRegistration[]
): Promise<void> {
  await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
  await fs.appendFile(
    ledgerPath,
    registrations.map((item) => JSON.stringify(item)).join("\n") + "\n",
    { encoding: "utf8", mode: 0o600 }
  );
  await fs.chmod(ledgerPath, 0o600);
}

async function readBackfillCursor(cursorPath: string): Promise<BackfillCursor> {
  try {
    const parsed = record(JSON.parse(await fs.readFile(cursorPath, "utf8")));
    const files = record(parsed.files);
    if (parsed.schemaVersion === 3) {
      return {
        schemaVersion: 3,
        files: Object.fromEntries(
          Object.entries(files).flatMap(([file, offset]) =>
            Number.isSafeInteger(offset) && Number(offset) >= 0
              ? [[file, Number(offset)]]
              : []
          )
        ),
        updatedAt: stringValue(parsed.updatedAt) || new Date().toISOString()
      };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      // A corrupt cursor is safe to rebuild because the ledger is deduplicated.
    }
  }
  return {
    schemaVersion: 3,
    files: {},
    updatedAt: new Date().toISOString()
  };
}

async function atomicJson(filePath: string, value: unknown): Promise<void> {
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  await fs.rename(temporary, filePath);
}

function jsonDocuments(value: string): unknown[] {
  const documents: unknown[] = [];
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (start < 0) {
      if (character === "{") {
        start = index;
        depth = 1;
        quoted = false;
        escaped = false;
      }
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth !== 0) continue;
      try {
        documents.push(JSON.parse(value.slice(start, index + 1)));
      } catch {
        // Non-JSON braces in ordinary command output are ignored.
      }
      start = -1;
    }
  }
  return documents;
}

function isWorkloadKind(value: string): value is InspireWorkloadKind {
  return (INSPIRE_WORKLOAD_KINDS as readonly string[]).includes(value);
}

function acceleratorType(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const commonModel = trimmed.match(
    /\b(?:H\d{2,4}|A\d{2,4}|L\d{2,4}S?|V\d{2,4})\b/i
  )?.[0];
  return commonModel ? commonModel.toUpperCase() : trimmed;
}

function knownAcceleratorType(value: string): string {
  return value.trim().match(
    /\b(?:H\d{2,4}|A\d{2,4}|L\d{2,4}S?|V\d{2,4})\b/i
  )?.[0]?.toUpperCase() ?? "";
}

function positiveInteger(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function nonNegativeInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0
    ? Math.floor(parsed)
    : undefined;
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
  return value === undefined ? undefined : nonNegativeInteger(value);
}

function validWorkloadName(value: string): boolean {
  return /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,254}$/u.test(value);
}

function validWorkspace(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 255 &&
    !/[\p{Cc}\\/"'`$;&|<>]/u.test(value)
  );
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
