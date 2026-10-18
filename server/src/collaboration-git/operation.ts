import type { OperationId, OperationRecord } from "../types.js";
import { sha256 } from "../utils.js";
import type {
  CollaborationGitOperationStore,
  OperationTransition
} from "./contracts.js";
import type { GitHubRepositoryFact, PushSupersessionProof } from "./contracts.js";
import {
  OperationPayloadMismatchError,
  OperationStoreViolationError
} from "./errors.js";

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

export function operationPayloadHash(payload: unknown): string {
  return sha256(JSON.stringify(canonicalValue(payload)) ?? "undefined");
}

/** Supersession proves inclusion, never that the original push succeeded. */
export function pushSupersessionProof(operation: OperationRecord,
  repository: Pick<GitHubRepositoryFact, "owner" | "name">): PushSupersessionProof {
  const proof = operation.remoteFact as unknown as PushSupersessionProof | undefined;
  if (operation.status !== "superseded" || operation.kind !== "git.push" ||
    !proof || proof.kind !== "included_in_later_publication" || !proof.publicationOperationId ||
    proof.publicationOperationId === operation.id || !proof.publicationPayloadHash || !proof.verifyingInvocationId ||
    !["prepared", "observed", "uncertain"].includes(proof.originalStatus) || proof.originalHead !== operation.expectedHead ||
    !/^[0-9a-f]{40}$/i.test(proof.originalHead) || !proof.remote || proof.remote.status !== "present" ||
    proof.remote.owner !== repository.owner || proof.remote.repository !== repository.name ||
    proof.remote.ref !== operation.expectedBase || !/^[0-9a-f]{40}$/i.test(proof.remote.sha ?? "") ||
    proof.remote.sha === proof.originalHead || !Number.isFinite(Date.parse(proof.remote.observedAt))) {
    throw new OperationStoreViolationError("Superseded push has no exact inclusion proof");
  }
  return proof;
}

/** Exact provider merge facts determine the idempotent local sync identity. */
export function mergedPullSynchronizationOperationId(
  executionId: string, ownershipEpoch: number, headSha: string, base: string, mergeCommitSha: string
): OperationId {
  const epochIdentity = ownershipEpoch === 1 ? executionId : `${executionId}-epoch-${ownershipEpoch}`;
  const factHash = sha256([headSha, base, mergeCommitSha].join("\0")).slice(0, 24);
  return `reconcile-merged-${epochIdentity}-${factHash}`;
}

function assertStoredOperation(
  expected: OperationRecord,
  actual: OperationRecord
): OperationRecord {
  if (actual.id !== expected.id || actual.kind !== expected.kind) {
    throw new OperationStoreViolationError(
      `Operation store returned another operation for ${expected.id}`
    );
  }
  if (actual.payloadHash !== expected.payloadHash) {
    throw new OperationPayloadMismatchError(expected.id);
  }
  if (
    actual.ownerExecutionId !== expected.ownerExecutionId ||
    actual.ownershipEpoch !== expected.ownershipEpoch ||
    actual.expectedHead !== expected.expectedHead ||
    actual.expectedBase !== expected.expectedBase
  ) {
    throw new OperationStoreViolationError(
      `Operation store changed the authority or expected facts for ${expected.id}`
    );
  }
  return actual;
}

export async function prepareOperation(
  store: CollaborationGitOperationStore,
  input: Omit<OperationRecord, "payloadHash" | "status">,
  payload: unknown
): Promise<OperationRecord> {
  const expected: OperationRecord = {
    ...input,
    payloadHash: operationPayloadHash(payload),
    status: "prepared"
  };
  return assertStoredOperation(expected, await store.prepare(expected));
}

export async function transitionOperation(
  store: CollaborationGitOperationStore,
  prepared: OperationRecord,
  transition: Omit<OperationTransition, "id" | "payloadHash">
): Promise<OperationRecord> {
  const actual = assertStoredOperation(prepared, await store.transition({
    id: prepared.id,
    payloadHash: prepared.payloadHash,
    ...transition
  }));
  if (actual.status !== transition.status) {
    throw new OperationStoreViolationError(
      `Operation store did not persist the ${transition.status} transition for ${prepared.id}`
    );
  }
  if (
    operationPayloadHash(actual.remoteFact) !==
    operationPayloadHash(transition.remoteFact)
  ) {
    throw new OperationStoreViolationError(
      `Operation store changed the remote fact for ${prepared.id}`
    );
  }
  return actual;
}

/**
 * Persist a reconciled external fact without replaying the observed transition
 * after a restart. A process can stop after the store durably commits
 * `observed` but before it commits `finalized`; the next observation will
 * normally carry a different timestamp and therefore is not an idempotent
 * `observed -> observed` transition. In that case the newly verified fact is
 * written directly by the legal `observed -> finalized` transition.
 */
export async function finalizeOperation(
  store: CollaborationGitOperationStore,
  operation: OperationRecord,
  remoteFact: Record<string, unknown>
): Promise<OperationRecord> {
  if (["finalized", "failed", "superseded"].includes(operation.status)) {
    throw new OperationStoreViolationError(
      `Terminal operation ${operation.id} cannot be finalized again`
    );
  }
  const observed = operation.status === "observed"
    ? operation
    : await transitionOperation(store, operation, {
        status: "observed",
        remoteFact
      });
  return transitionOperation(store, observed, {
    status: "finalized",
    remoteFact
  });
}

export function childOperationId(
  parent: OperationId,
  suffix: string
): OperationId {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(parent)) {
    throw new OperationStoreViolationError("Operation id is unsafe");
  }
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(suffix)) {
    throw new OperationStoreViolationError("Operation suffix is unsafe");
  }
  return `${parent}.${suffix}`;
}
