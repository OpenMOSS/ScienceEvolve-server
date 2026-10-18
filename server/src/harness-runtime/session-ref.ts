import type { SessionRef } from "./contracts.js";

const HARNESS_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,63})$/;
const ISO_UTC_PATTERN =
  /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/;
const UNSAFE_SESSION_TEXT_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const MAX_NATIVE_ID_LENGTH = 8_192;
const SESSION_REF_FIELDS = new Set([
  "schemaVersion",
  "harnessId",
  "adapterVersion",
  "generation",
  "nativeId",
  "durable",
  "createdAt",
  "resumedAt"
]);

export type SessionRefValidation =
  | { valid: true; session: SessionRef }
  | { valid: false; reason: string };

/**
 * Validate a persisted or Adapter-provided SessionRef without consulting the
 * live Registry. A syntactically safe historical Harness ID remains valid even
 * when that Harness is no longer installed; same-Harness recovery decides what
 * to do with it later.
 */
export function validateSessionRef(value: unknown): SessionRefValidation {
  if (!isRecord(value)) {
    return invalid("SessionRef must be an object");
  }
  const prototype = Object.getPrototypeOf(value);
  if ((prototype !== Object.prototype && prototype !== null) ||
    Reflect.ownKeys(value).some((key) =>
      typeof key !== "string" || !SESSION_REF_FIELDS.has(key)
    )) {
    return invalid("SessionRef must contain only canonical fields");
  }
  if (value.schemaVersion !== 1) {
    return invalid("SessionRef.schemaVersion must equal 1");
  }
  if (typeof value.harnessId !== "string" || !HARNESS_ID_PATTERN.test(value.harnessId)) {
    return invalid("SessionRef.harnessId must be a safe non-empty Harness ID");
  }
  if (
    !isSafeSessionText(value.adapterVersion, 128)
  ) {
    return invalid("SessionRef.adapterVersion must be a safe non-empty version");
  }
  if (
    !Number.isSafeInteger(value.generation) ||
    (value.generation as number) < 0
  ) {
    return invalid("SessionRef.generation must be a non-negative safe integer");
  }
  if (!isSafeNativeId(value.nativeId)) {
    return invalid("SessionRef.nativeId must be a safe non-empty string");
  }
  if (typeof value.durable !== "boolean") {
    return invalid("SessionRef.durable must be a boolean");
  }
  if (!isIsoUtcTimestamp(value.createdAt)) {
    return invalid("SessionRef.createdAt must be a valid ISO timestamp");
  }
  if (value.resumedAt !== undefined && !isIsoUtcTimestamp(value.resumedAt)) {
    return invalid("SessionRef.resumedAt must be a valid ISO timestamp when present");
  }
  return {
    valid: true,
    session: {
      schemaVersion: 1,
      harnessId: value.harnessId,
      adapterVersion: value.adapterVersion,
      generation: value.generation as number,
      nativeId: value.nativeId,
      durable: value.durable,
      createdAt: value.createdAt,
      ...(value.resumedAt === undefined ? {} : { resumedAt: value.resumedAt })
    }
  };
}

export function isSessionRef(value: unknown): value is SessionRef {
  return validateSessionRef(value).valid;
}

function invalid(reason: string): SessionRefValidation {
  return { valid: false, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeNativeId(value: unknown): value is string {
  return isSafeSessionText(value, MAX_NATIVE_ID_LENGTH);
}

function isSafeSessionText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= maxLength && value === value.trim() &&
    !UNSAFE_SESSION_TEXT_PATTERN.test(value);
}

function isIsoUtcTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = ISO_UTC_PATTERN.exec(value);
  if (!match) return false;
  const milliseconds = (match[3] ?? "").padEnd(3, "0");
  const canonical = `${match[1]}T${match[2]}.${milliseconds}Z`;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === canonical;
}
