import { describe, expect, it } from "vitest";
import { containsCredentialMaterial, isSensitiveCredentialKey, redactTrace } from "../src/utils.js";

describe("platform HTTP error cookie redaction", () => {
  it.each(["\n", "\\n"])("retains the transport failure while removing all Cookie header values (separator=%j)", separator => {
    const error = ["APIRequestContext.post: TLS connection failed", "  - cookie: inspire-session=FAKE-SESSION; csrf=FAKE-CSRF", "  - content-type: application/json"].join(separator);
    expect(containsCredentialMaterial(error)).toBe(true);
    const result = redactTrace(error);
    expect(result).not.toContain("FAKE-SESSION");
    expect(result).not.toContain("FAKE-CSRF");
    expect(result).toContain("TLS connection failed");
    expect(result).toContain("content-type: application/json");
    expect(containsCredentialMaterial(result)).toBe(false);
  });

  it("redacts structured and nested platform errors without dropping ordinary result/session identities", () => {
    const value = { sessionId: "original-native-session", run_id: "original-run", status: "unknown", headers: {
      Cookie: "inspire-session=FAKE-SESSION; csrf=FAKE-CSRF", "Set-Cookie": ["auth=FAKE-AUTH; HttpOnly", "xsrf=FAKE-XSRF"] },
      error: { message: "APIRequestContext.post failed\n  - cookie: inspire-session=FAKE-NESTED; csrf=FAKE-NESTED-CSRF" } };
    for (const key of ["Cookie", "Set-Cookie", "cookies"]) expect(isSensitiveCredentialKey(key)).toBe(true);
    const result = redactTrace(JSON.stringify(value));
    expect(result).not.toContain("FAKE-");
    expect(JSON.parse(result)).toMatchObject({ sessionId: value.sessionId, run_id: value.run_id, status: "unknown",
      headers: { Cookie: "[REDACTED]", "Set-Cookie": "[REDACTED]" } });
    expect(result).toContain("APIRequestContext.post failed");
  });
});
