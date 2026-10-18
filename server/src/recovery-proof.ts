import { createHash } from "node:crypto";
import type {
  ResidentDurableRehydrateProvenance,
  ResidentRecoveryProof,
  ResidentRecoveryProofSeed,
  ResidentRecoveryScope,
  ResidentRecoverySessionIdentity
} from "./types.js";
import { validateSessionRef } from "./harness-runtime/session-ref.js";

const SHA256 = /^[a-f0-9]{64}$/u;

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalValue(value))).digest("hex");
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalValue(item)])
    );
  }
  return value;
}

function exactText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.trim() !== value ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function epoch(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} is invalid`);
  }
  return Number(value);
}

function iso(value: unknown, label: string): string {
  const text = exactText(value, label);
  const parsed = new Date(text);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== text) {
    throw new Error(`${label} is invalid`);
  }
  return text;
}

function recoveryScope(value: unknown): ResidentRecoveryScope {
  if (value !== "main-route" && value !== "group-leader" && value !== "member") {
    throw new Error("Resident recovery scope is invalid");
  }
  return value;
}

function sessionIdentity(
  value: ResidentRecoverySessionIdentity
): ResidentRecoverySessionIdentity {
  const validation = validateSessionRef(value);
  if (!validation.valid) {
    throw new Error("Resident recovery old Session is invalid");
  }
  return structuredClone(validation.session);
}

function stopEvidence(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("Resident recovery stop evidence is invalid");
  }
  const cloned = structuredClone(value as Readonly<Record<string, unknown>>);
  try {
    JSON.stringify(canonicalValue(cloned));
  } catch {
    throw new Error("Resident recovery stop evidence is invalid");
  }
  return cloned;
}

function durableProvenance(
  value: ResidentDurableRehydrateProvenance | undefined
): ResidentDurableRehydrateProvenance | undefined {
  if (value === undefined) return undefined;
  if (!SHA256.test(value.sourceDigest) ||
    !Number.isSafeInteger(value.lastBusinessTurn) || value.lastBusinessTurn < 0 ||
    typeof value.transcript !== "string" || value.transcript.includes("\0") ||
    value.transcript.length > 8 * 1024 * 1024 ||
    createHash("sha256").update(value.transcript).digest("hex") !== value.sourceDigest) {
    throw new Error("Resident durable rehydrate provenance is invalid");
  }
  return {
    sourceDigest: value.sourceDigest,
    lastBusinessTurn: value.lastBusinessTurn,
    lastInputId: exactText(value.lastInputId, "Resident recovery last input ID"),
    transcript: value.transcript
  };
}

export function residentRecoverySessionDigest(
  value: ResidentRecoverySessionIdentity
): string {
  return digest(sessionIdentity(value));
}

export function createResidentRecoveryProofSeed(input: {
  scope: ResidentRecoveryScope;
  projectId: string;
  sourceNodeRunId: string;
  scopeId: string;
  agentId: string;
  stoppedEpoch: number;
  oldSession: ResidentRecoverySessionIdentity;
  observedAt: string;
  evidence: Readonly<Record<string, unknown>>;
  durableRehydrate?: ResidentDurableRehydrateProvenance;
}): ResidentRecoveryProofSeed {
  const oldSession = sessionIdentity(input.oldSession);
  const oldSessionDigest = residentRecoverySessionDigest(oldSession);
  const identity = {
    scope: recoveryScope(input.scope),
    projectId: exactText(input.projectId, "Resident recovery project ID"),
    sourceNodeRunId: exactText(input.sourceNodeRunId, "Resident recovery source node"),
    scopeId: exactText(input.scopeId, "Resident recovery scope ID"),
    agentId: exactText(input.agentId, "Resident recovery Agent ID"),
    stoppedEpoch: epoch(input.stoppedEpoch, "Resident recovery stopped epoch"),
    oldSessionDigest
  };
  const durable = durableProvenance(input.durableRehydrate);
  const stopObservation = {
    observedAt: iso(input.observedAt, "Resident recovery observation time"),
    evidence: stopEvidence(input.evidence)
  };
  return {
    schemaVersion: 1,
    seedId: digest({
      ...identity,
      stopObservation,
      durableRehydrate: durable ?? null
    }),
    ...identity,
    oldSession,
    stopObservation,
    ...(durable ? { durableRehydrate: durable } : {})
  };
}

export function assertResidentRecoveryProofSeed(
  value: ResidentRecoveryProofSeed
): ResidentRecoveryProofSeed {
  const rebuilt = createResidentRecoveryProofSeed({
    scope: value.scope,
    projectId: value.projectId,
    sourceNodeRunId: value.sourceNodeRunId,
    scopeId: value.scopeId,
    agentId: value.agentId,
    stoppedEpoch: value.stoppedEpoch,
    oldSession: value.oldSession,
    observedAt: value.stopObservation.observedAt,
    evidence: value.stopObservation.evidence,
    durableRehydrate: value.durableRehydrate
  });
  if (value.schemaVersion !== 1 || value.seedId !== rebuilt.seedId ||
    value.oldSessionDigest !== rebuilt.oldSessionDigest) {
    throw new Error("Resident recovery proof seed identity is invalid");
  }
  return rebuilt;
}

export function bindResidentRecoveryProof(input: {
  seed: ResidentRecoveryProofSeed;
  newInvocationId: string;
  routeEpoch: number;
  inputId: string;
  createdAt: string;
}): ResidentRecoveryProof {
  const seed = assertResidentRecoveryProofSeed(input.seed);
  const target = {
    newInvocationId: exactText(input.newInvocationId, "Resident recovery invocation ID"),
    routeEpoch: epoch(input.routeEpoch, "Resident recovery route epoch"),
    inputId: exactText(input.inputId, "Resident recovery input ID")
  };
  const createdAt = iso(input.createdAt, "Resident recovery proof creation time");
  if (target.routeEpoch !== seed.stoppedEpoch + 1) {
    throw new Error("Resident recovery proof does not target the next fenced epoch");
  }
  return {
    schemaVersion: 1,
    proofId: digest({ seedId: seed.seedId, ...target, createdAt }),
    seedId: seed.seedId,
    scope: seed.scope,
    projectId: seed.projectId,
    sourceNodeRunId: seed.sourceNodeRunId,
    scopeId: seed.scopeId,
    agentId: seed.agentId,
    oldSession: structuredClone(seed.oldSession),
    oldSessionDigest: seed.oldSessionDigest,
    stopObservation: structuredClone(seed.stopObservation),
    ...target,
    createdAt,
    ...(seed.durableRehydrate
      ? { durableRehydrate: structuredClone(seed.durableRehydrate) }
      : {})
  };
}

export function assertResidentRecoveryProof(
  value: ResidentRecoveryProof
): ResidentRecoveryProof {
  const seed = assertResidentRecoveryProofSeed({
    schemaVersion: 1,
    seedId: value.seedId,
    scope: value.scope,
    projectId: value.projectId,
    sourceNodeRunId: value.sourceNodeRunId,
    scopeId: value.scopeId,
    agentId: value.agentId,
    stoppedEpoch: Number(value.routeEpoch) - 1,
    oldSession: value.oldSession,
    oldSessionDigest: value.oldSessionDigest,
    stopObservation: value.stopObservation,
    ...(value.durableRehydrate
      ? { durableRehydrate: value.durableRehydrate }
      : {})
  });
  const rebuilt = bindResidentRecoveryProof({
    seed,
    newInvocationId: value.newInvocationId,
    routeEpoch: value.routeEpoch,
    inputId: value.inputId,
    createdAt: value.createdAt
  });
  if (value.schemaVersion !== 1 || value.proofId !== rebuilt.proofId) {
    throw new Error("Resident recovery proof identity is invalid");
  }
  return rebuilt;
}
