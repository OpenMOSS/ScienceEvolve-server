import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterSmokeProbeRunner } from "../src/agent-runtime.js";
import { PROTOCOL_ROUTER_COMPATIBILITY_VERSION } from "../src/protocol-router.js";
import {
  REAL_ACCEPTANCE_AUTHORIZATION,
  assertRealAcceptanceAuthorized,
  buildRealGatewayAcceptancePlans,
  createRealAcceptanceGatewayTargetValidator,
  parseRealGatewayAcceptancePhase,
  publicRealGatewayAcceptancePlan,
  runRealGatewayAcceptance,
  sanitizeAcceptanceText,
  sanitizeGatewayTestResult
} from "../src/real-gateway-acceptance.js";

function smokeIdentity(harness: string) {
  return {
    cacheKey: `acceptance-cache-${harness}`,
    adapterVersion: "acceptance-adapter-1",
    executableFingerprint: `acceptance-executable-${harness}`,
    routerCompatibilityVersion: PROTOCOL_ROUTER_COMPATIBILITY_VERSION
  };
}

const acceptanceHarnessCatalog: AdapterSmokeProbeRunner = {
  harnessIds: () => ["dsh", "pi", "codex", "claude-code"],
  nativeProtocol: (harness: string) => ({
    dsh: "chat-completions",
    pi: "chat-completions",
    codex: "responses",
    "claude-code": "anthropic-messages"
  } as const)[harness as "dsh" | "pi" | "codex" | "claude-code"],
  cacheKey: async ({ harness }) => smokeIdentity(harness),
  runSmoke: async ({ harness }) => smokeIdentity(harness)
};

function successfulResponsesAcceptanceFetch(): typeof fetch {
  return async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const authorization = new Headers(init?.headers).get("authorization") ?? "";
    if (authorization.includes("openfars-deliberately-invalid-credential")) {
      return Response.json({ error: "invalid credential" }, { status: 401 });
    }
    if (body.model === "openfars-deliberately-invalid-model") {
      return Response.json({ error: "invalid model" }, { status: 400 });
    }
    const toolProbe = body.tool_choice !== undefined;
    if (body.stream === true) {
      const frames = toolProbe ? [
        'data: {"type":"response.output_item.added","output_index":0,"item":{"id":"probe-item","type":"function_call","call_id":"probe-call","name":"openfars_probe","arguments":""}}',
        'data: {"type":"response.completed","response":{"status":"completed"}}',
        ""
      ] : [
        'data: {"type":"response.output_text.delta","delta":"ok"}',
        'data: {"type":"response.completed","response":{"status":"completed"}}',
        ""
      ];
      return new Response(frames.join("\n\n"), {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    }
    return Response.json(toolProbe
      ? {
          status: "completed",
          error: null,
          output: [{
            type: "function_call",
            call_id: "probe-call",
            name: "openfars_probe",
            arguments: '{"value":"ok"}'
          }]
        }
      : {
          status: "completed",
          error: null,
          output_text: "ok",
          output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }]
        });
  };
}

function configuredEnvironment(): NodeJS.ProcessEnv {
  return {
    AIGW_API_KEY: "aigw-test-secret-value",
    AIGW_BASE_URL: "https://gateway.example/v1",
    OPENFARS_AIGW_ACCEPTANCE_MODELS: "kimi-k3",
    OPENFARS_AIGW_ACCEPTANCE_PROTOCOLS:
      "responses,chat-completions,anthropic-messages",
    SII_API_KEY: "sii-test-secret-value",
    SII_BASE_URL: "https://sii.example/v1",
    SII_MODEL: "dsv4-flash-0731",
    OPENFARS_ACCEPTANCE_GATEWAYS: "aigw,sii"
  };
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true })
    )
  );
});

describe("real gateway acceptance safety boundary", () => {
  it("requires an exact, separately supplied external-call authorization", () => {
    expect(() => assertRealAcceptanceAuthorized({})).toThrow(
      "真实验收默认关闭"
    );
    expect(() =>
      assertRealAcceptanceAuthorized({
        OPENFARS_ALLOW_REAL_ACCEPTANCE: "yes"
      })
    ).toThrow("真实验收默认关闭");
    expect(() =>
      assertRealAcceptanceAuthorized({
        OPENFARS_ALLOW_REAL_ACCEPTANCE: REAL_ACCEPTANCE_AUTHORIZATION
      })
    ).not.toThrow();
  });

  it("allows RFC1918 routes without a per-host opt-in and still blocks dangerous targets", async () => {
    const hostname = "sii-private.example.test";
    const resolvePrivate = vi.fn(async () => ["10.23.45.67"]);
    const privateTarget = createRealAcceptanceGatewayTargetValidator(resolvePrivate);
    const metadataTarget = createRealAcceptanceGatewayTargetValidator(
      async () => ["169.254.169.254"]
    );

    await expect(privateTarget(`https://${hostname}/v1`)).resolves.toBe(
      `https://${hostname}/v1`
    );
    await expect(metadataTarget(`https://${hostname}/v1`)).rejects.toThrow(
      "被禁止的本机、链路本地、元数据、CGNAT、组播或保留地址"
    );
  });

  it("builds an explicit three-protocol/four-harness plan without exposing keys", () => {
    const plans = buildRealGatewayAcceptancePlans(
      configuredEnvironment(),
      acceptanceHarnessCatalog
    );
    expect(plans).toHaveLength(2);
    expect(plans[0]?.protocols).toEqual([
      "responses",
      "chat-completions",
      "anthropic-messages"
    ]);
    expect(plans[0]?.harnesses).toEqual([
      "dsh",
      "pi",
      "codex",
      "claude-code"
    ]);
    const publicPlan = publicRealGatewayAcceptancePlan(plans[0]!);
    expect(publicPlan.matrixCombinations).toBe(12);
    expect(publicPlan.minimumMatrixRequests).toBe(60);
    expect(publicPlan.maximumMatrixRequests).toBe(108);
    expect(JSON.stringify(publicPlan)).not.toContain("aigw-test-secret-value");
    expect(publicPlan).not.toHaveProperty("apiKey");
  });

  it("accepts a fifth probe Adapter from the injected Runtime Catalog", () => {
    const environment = configuredEnvironment();
    environment.OPENFARS_ACCEPTANCE_GATEWAYS = "aigw";
    const dynamicCatalog = {
      harnessIds: () => [
        ...acceptanceHarnessCatalog.harnessIds(),
        "fixture-five"
      ],
      nativeProtocol: (harness: string) => harness === "fixture-five"
        ? "responses" as const
        : acceptanceHarnessCatalog.nativeProtocol(harness)
    };

    const [plan] = buildRealGatewayAcceptancePlans(environment, dynamicCatalog);

    expect(plan?.harnesses).toContain("fixture-five");
  });

  it("rejects missing credentials and unsupported protocols before a run", () => {
    const missing = configuredEnvironment();
    delete missing.SII_API_KEY;
    expect(() => buildRealGatewayAcceptancePlans(missing, acceptanceHarnessCatalog)).toThrow(
      "缺少 SII_API_KEY"
    );

    const invalid = configuredEnvironment();
    invalid.OPENFARS_AIGW_ACCEPTANCE_PROTOCOLS = "responses,not-a-protocol";
    expect(() => buildRealGatewayAcceptancePlans(invalid, acceptanceHarnessCatalog)).toThrow(
      "验收协议只能是"
    );

    const selected = configuredEnvironment();
    selected.OPENFARS_ACCEPTANCE_GATEWAYS = "aigw";
    expect(buildRealGatewayAcceptancePlans(selected, acceptanceHarnessCatalog)).toHaveLength(1);
    selected.OPENFARS_ACCEPTANCE_GATEWAYS = "unknown";
    expect(() => buildRealGatewayAcceptancePlans(selected, acceptanceHarnessCatalog)).toThrow(
      "验收网关只能是"
    );
  });

  it("supports an explicitly configured DeepSeek gateway alongside SII", () => {
    const environment = configuredEnvironment();
    environment.DEEPSEEK_API_KEY = "deepseek-test-secret-value";
    environment.DEEPSEEK_BASE_URL = "https://deepseek.example/v1";
    environment.DEEPSEEK_MODEL = "dsv4-flash-0731";
    environment.OPENFARS_ACCEPTANCE_GATEWAYS = "sii,deepseek";
    environment.OPENFARS_ACCEPTANCE_REQUIRED_GATEWAYS = "sii,deepseek";
    const plans = buildRealGatewayAcceptancePlans(environment, acceptanceHarnessCatalog);
    expect(plans.map((plan) => plan.id)).toEqual(["sii", "deepseek"]);
    expect(plans[0]?.name).toBe("SII Qwen3.8-27B");
    expect(plans[0]?.protocols).toEqual(["chat-completions"]);
    expect(plans[1]?.models).toEqual(["dsv4-flash-0731"]);
    expect(JSON.stringify(plans.map(publicRealGatewayAcceptancePlan))).not.toContain(
      "deepseek-test-secret-value"
    );
  });

  it("accepts the user-supplied INF_API_KEY as the SII Qwen credential alias", () => {
    const environment = configuredEnvironment();
    delete environment.SII_API_KEY;
    environment.INF_API_KEY = "qwen-inf-test-secret-value";
    environment.OPENFARS_ACCEPTANCE_GATEWAYS = "sii";
    const [plan] = buildRealGatewayAcceptancePlans(environment, acceptanceHarnessCatalog);
    expect(plan?.apiKeyVariable).toBe("INF_API_KEY");
    expect(plan?.models).toEqual(["dsv4-flash-0731"]);
  });

  it("redacts exact configured secrets and credential-shaped provider errors", () => {
    const secrets = ["opaque-aigw-value", "opaque-sii-value"];
    const text = sanitizeAcceptanceText(
      "provider echoed opaque-aigw-value and api_key=provider-secret-value",
      secrets
    );
    expect(text).not.toContain("opaque-aigw-value");
    expect(text).not.toContain("provider-secret-value");
    expect(text).toContain("[REDACTED]");

    const result = sanitizeGatewayTestResult(
      {
        status: "failed",
        protocol: "responses",
        model: "model-a",
        testedAt: "2026-09-12T00:00:00.000Z",
        error: "Authorization: Bearer opaque-sii-value",
        httpStatus: 401,
        harness: "codex",
        nativeProtocol: "responses",
        routeMode: "direct"
      },
      secrets
    );
    expect(JSON.stringify(result)).not.toContain("opaque-sii-value");
    expect(result.httpStatus).toBe(401);
  });

  it("parses only the documented acceptance phases", () => {
    expect(parseRealGatewayAcceptancePhase(undefined)).toBe("all");
    expect(parseRealGatewayAcceptancePhase("matrix")).toBe("matrix");
    expect(parseRealGatewayAcceptancePhase("faults")).toBe("faults");
    expect(() => parseRealGatewayAcceptancePhase("projects")).toThrow(
      "phase 只能是"
    );
  });

  it("enforces the opt-in again inside the core runner before I/O", async () => {
    await expect(
      runRealGatewayAcceptance({
        plans: [],
        phase: "matrix",
        evidenceDirectory: "/tmp/openfars-must-not-be-created",
        authorization: undefined,
        adapterSmokeProbe: acceptanceHarnessCatalog,
        fetch: () => {
          throw new Error("fetch must not run");
        }
      })
    ).rejects.toThrow("真实验收默认关闭");
  });

  it("runs the fault suite through a fifth Adapter supplied by the Runtime Catalog", async () => {
    const evidenceDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "openfars-dynamic-fault-evidence-test-")
    );
    temporaryDirectories.push(evidenceDirectory);
    const cacheKey = vi.fn(async ({ harness }: { harness: string }) =>
      smokeIdentity(harness)
    );
    const runSmoke = vi.fn(async ({ harness }: { harness: string }) =>
      smokeIdentity(harness)
    );
    const dynamicProbe: AdapterSmokeProbeRunner = {
      harnessIds: () => ["fixture-five"],
      nativeProtocol: (harness) => harness === "fixture-five"
        ? "responses"
        : undefined,
      cacheKey,
      runSmoke
    };
    const environment = configuredEnvironment();
    environment.OPENFARS_ACCEPTANCE_GATEWAYS = "aigw";
    environment.OPENFARS_AIGW_ACCEPTANCE_PROTOCOLS = "responses";
    environment.OPENFARS_ACCEPTANCE_HARNESSES = "fixture-five";
    const plans = buildRealGatewayAcceptancePlans(environment, dynamicProbe);
    const fetchMock = vi.fn<typeof fetch>()
      .mockImplementation(successfulResponsesAcceptanceFetch());

    const { evidence } = await runRealGatewayAcceptance({
      authorization: REAL_ACCEPTANCE_AUTHORIZATION,
      phase: "faults",
      evidenceDirectory,
      plans,
      adapterSmokeProbe: dynamicProbe,
      resolveHostname: async () => ["93.184.216.34"],
      fetch: fetchMock
    });

    expect(evidence.faults).toHaveLength(1);
    expect(evidence.faults[0]).toMatchObject({
      harness: "fixture-five",
      protocol: "responses",
      passed: true,
      retry: {
        passed: true,
        result: {
          status: "passed",
          harness: "fixture-five",
          nativeProtocol: "responses",
          probeKind: "adapter-smoke",
          cacheKey: "acceptance-cache-fixture-five"
        }
      }
    });
    expect(cacheKey).toHaveBeenCalledTimes(1);
    expect(runSmoke).toHaveBeenCalledTimes(1);
    expect(cacheKey).toHaveBeenCalledWith(expect.objectContaining({
      harness: "fixture-five",
      model: "kimi-k3"
    }));
    expect(runSmoke).toHaveBeenCalledWith(
      expect.objectContaining({ harness: "fixture-five", model: "kimi-k3" }),
      expect.any(AbortSignal)
    );
  });

  it("does not treat an unrelated Gateway failure as credential or model rejection", async () => {
    const evidenceDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "openfars-fault-classification-test-")
    );
    temporaryDirectories.push(evidenceDirectory);
    const dynamicProbe: AdapterSmokeProbeRunner = {
      harnessIds: () => ["fixture-five"],
      nativeProtocol: () => "responses",
      cacheKey: async ({ harness }) => smokeIdentity(harness),
      runSmoke: async ({ harness }) => smokeIdentity(harness)
    };
    const environment = configuredEnvironment();
    environment.OPENFARS_ACCEPTANCE_GATEWAYS = "aigw";
    environment.OPENFARS_AIGW_ACCEPTANCE_PROTOCOLS = "responses";
    environment.OPENFARS_ACCEPTANCE_HARNESSES = "fixture-five";
    const plans = buildRealGatewayAcceptancePlans(environment, dynamicProbe);
    const successful = successfulResponsesAcceptanceFetch();
    const fetchMock: typeof fetch = async (input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const authorization = new Headers(init?.headers).get("authorization") ?? "";
      if (authorization.includes("openfars-deliberately-invalid-credential") ||
        body.model === "openfars-deliberately-invalid-model") {
        return Response.json({ error: "unrelated upstream outage" }, { status: 502 });
      }
      return successful(input, init);
    };

    const { evidence } = await runRealGatewayAcceptance({
      authorization: REAL_ACCEPTANCE_AUTHORIZATION,
      phase: "faults",
      evidenceDirectory,
      plans,
      adapterSmokeProbe: dynamicProbe,
      resolveHostname: async () => ["93.184.216.34"],
      fetch: fetchMock
    });

    expect(evidence.faults[0]).toMatchObject({
      invalidCredential: {
        passed: false,
        kind: "gateway-route-invalid-credential",
        result: { httpStatus: 502 }
      },
      invalidModel: {
        passed: false,
        kind: "gateway-route-invalid-model",
        result: { httpStatus: 502 }
      },
      passed: false
    });
  });

  it("accepts AIGW's explicit missing-channel response as an invalid-model rejection", async () => {
    const evidenceDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "openfars-aigw-invalid-model-test-")
    );
    temporaryDirectories.push(evidenceDirectory);
    const environment = configuredEnvironment();
    environment.OPENFARS_ACCEPTANCE_GATEWAYS = "aigw";
    environment.OPENFARS_AIGW_ACCEPTANCE_PROTOCOLS = "responses";
    environment.OPENFARS_ACCEPTANCE_HARNESSES = "codex";
    const plans = buildRealGatewayAcceptancePlans(
      environment,
      acceptanceHarnessCatalog
    );
    const successful = successfulResponsesAcceptanceFetch();
    const fetchMock: typeof fetch = async (input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      if (body.model === "openfars-deliberately-invalid-model") {
        return Response.json(
          { error: { message: "no available channel for provider openai" } },
          { status: 503 }
        );
      }
      return successful(input, init);
    };

    const { evidence } = await runRealGatewayAcceptance({
      authorization: REAL_ACCEPTANCE_AUTHORIZATION,
      phase: "faults",
      evidenceDirectory,
      plans,
      adapterSmokeProbe: acceptanceHarnessCatalog,
      resolveHostname: async () => ["93.184.216.34"],
      fetch: fetchMock
    });

    expect(evidence.faults[0]?.invalidModel).toMatchObject({
      passed: true,
      expectedHttpStatuses: [400, 404, 422, 503],
      result: { status: "failed", httpStatus: 503 }
    });
  });

  it("removes its credential store and writes only redacted whitelisted evidence", async () => {
    const evidenceDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "openfars-acceptance-evidence-test-")
    );
    temporaryDirectories.push(evidenceDirectory);
    const apiKey = "opaque-core-runner-secret";
    const { evidence, evidencePath } = await runRealGatewayAcceptance({
      authorization: REAL_ACCEPTANCE_AUTHORIZATION,
      phase: "matrix",
      evidenceDirectory,
      adapterSmokeProbe: acceptanceHarnessCatalog,
      plans: [
        {
          id: "test",
          name: "Test gateway",
          url: "https://8.8.8.8/v1",
          apiKey,
          apiKeyVariable: "TEST_API_KEY",
          models: ["model-a"],
          protocols: ["responses"],
          harnesses: ["codex"]
        }
      ],
      // Ordinary JSON is deliberately returned for the stream probe. The
      // production validator must record that as a failure, while this test
      // focuses on lifecycle and evidence safety rather than provider shape.
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { stream?: boolean };
        return Response.json(
          body.stream
            ? { output_text: `api_key=${apiKey}` }
            : { output_text: "ok", output: [] },
          { status: 200 }
        );
      }
    });
    const serialized = await fs.readFile(evidencePath, "utf8");
    expect(evidence.credentialHandling.temporaryGatewayStoreRemoved).toBe(true);
    expect(evidence.summary.matrixFailed).toBe(1);
    expect(evidence.coverage.allProtocolsPerGateway).toBe(false);
    expect(evidence.coverage.allSixDirectedRoutes).toBe(false);
    expect(evidence.summary.fullDocumentMatrixPassed).toBe(false);
    expect(serialized).not.toContain(apiKey);
    expect(serialized).not.toContain('"apiKey"');
  });
});
