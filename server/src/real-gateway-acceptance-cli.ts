import { promises as fs } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.js";
import { HarnessRuntimeFacade } from "./harness-runtime/runtime.js";
import { DEFAULT_HARNESS_ID } from "./harness-runtime/registry.js";
import {
  REAL_ACCEPTANCE_AUTHORIZATION,
  assertRealAcceptanceAuthorized,
  buildRealGatewayAcceptancePlans,
  createRealAcceptanceGatewayTargetValidator,
  expectedRealGatewayAcceptanceInputs,
  parseRealGatewayAcceptancePhase,
  publicRealGatewayAcceptancePlan,
  runRealGatewayAcceptance,
  sanitizeAcceptanceText
} from "./real-gateway-acceptance.js";

const KNOWN_CREDENTIAL_VARIABLES = [
  "AIGW_API_KEY",
  "SII_API_KEY",
  "DEEPSEEK_API_KEY",
  "INF_API_KEY",
  "DS_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN"
] as const;

async function main(): Promise<void> {
  const projectRoot = process.cwd();
  const mode = process.argv.includes("--run") ? "run" : "plan";
  const phaseArgument = process.argv.find((entry) => entry.startsWith("--phase="));
  const phase = parseRealGatewayAcceptancePhase(
    phaseArgument?.slice("--phase=".length)
  );
  const credentialFiles = [
    path.join(projectRoot, ".env"),
    path.resolve(projectRoot, "..", "harness", "gateway.env")
  ];

  if (mode === "plan") {
    console.log(
      JSON.stringify(
        {
          mode: "plan-only",
          phase,
          externalRequestsMade: false,
          credentialValuesLoaded: false,
          credentialFilesOpened: false,
          expected: expectedRealGatewayAcceptanceInputs(),
          authorizationVariable: "OPENFARS_ALLOW_REAL_ACCEPTANCE",
          authorizationValue: REAL_ACCEPTANCE_AUTHORIZATION,
          note: "--run 才会在显式授权后加载凭据并执行；证据只写脱敏字段"
        },
        null,
        2
      )
    );
    return;
  }

  // Check the separately supplied opt-in before parsing either credential file.
  assertRealAcceptanceAuthorized(process.env);
  for (const file of credentialFiles) {
    await fs.access(file);
    process.loadEnvFile(file);
  }
  const config = loadConfig(projectRoot);
  const runtime = new HarnessRuntimeFacade({
    inspireBin: config.inspireBin,
    inspireConfigPath: config.inspireConfigPath,
    inspireNoProxy: config.inspireNoProxy,
    inspireWorkspaceRoot: config.inspireWorkspaceRoot,
    harnessExecutables: { [DEFAULT_HARNESS_ID]: config.codexBin },
    validateGatewayTarget: createRealAcceptanceGatewayTargetValidator()
  });
  const plans = buildRealGatewayAcceptancePlans(process.env, runtime);
  console.log(
    JSON.stringify(
      {
        mode: "authorized-run",
        phase,
        plan: plans.map(publicRealGatewayAcceptancePlan),
        note: "开始外部请求；终端和证据均不输出凭据值"
      },
      null,
      2
    )
  );
  const { evidence, evidencePath } = await runRealGatewayAcceptance({
    plans,
    phase,
    adapterSmokeProbe: runtime,
    authorization: process.env.OPENFARS_ALLOW_REAL_ACCEPTANCE,
    evidenceDirectory: path.join(projectRoot, "temp", "real-acceptance")
  });
  console.log(
    JSON.stringify(
      {
        evidencePath: path.relative(projectRoot, evidencePath),
        summary: evidence.summary,
        temporaryGatewayStoreRemoved:
          evidence.credentialHandling.temporaryGatewayStoreRemoved
      },
      null,
      2
    )
  );
  if (!evidence.summary.allRequestedChecksPassed) process.exitCode = 2;
}

main().catch((error: unknown) => {
  // A diagnostic is useful after explicit authorization, but never stringify
  // an arbitrary error. Replace every known credential first and omit stacks.
  const secrets = KNOWN_CREDENTIAL_VARIABLES.map((name) => process.env[name] ?? "").filter(Boolean);
  const detail = sanitizeAcceptanceText(
    error instanceof Error ? error.message : "unknown acceptance error",
    secrets
  );
  console.error(
    `真实网关验收未启动或未完成：${detail || "未知错误"}`
  );
  process.exitCode = 1;
});
