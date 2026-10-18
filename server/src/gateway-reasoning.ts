export * from "./internal/shared/gateway-reasoning.js";
import {
  resolveGatewayReasoning,
  type GatewayModelReasoningConfigs,
  type ResolvedGatewayReasoning
} from "./internal/shared/gateway-reasoning.js";

export type LegacyReasoningEffort = "low" | "medium" | "high" | "xhigh";

/** Map an old effort only when its provider value uniquely identifies an option. */
export function migrateLegacyGatewayReasoning(
  configs: GatewayModelReasoningConfigs | undefined,
  model: string,
  legacyEffort: LegacyReasoningEffort | undefined
): { optionId?: string; reasoning?: ResolvedGatewayReasoning; warning?: string } {
  if (!legacyEffort) return {};
  const matches = (configs?.[model]?.options ?? []).filter((option) => option.value === legacyEffort);
  if (matches.length === 1) {
    const optionId = matches[0]!.id;
    return { optionId, reasoning: resolveGatewayReasoning(configs, model, optionId) };
  }
  return {
    warning: matches.length === 0
      ? `旧 Harness 思考深度“${legacyEffort}”无法精确匹配当前 Gateway/model 选项，已改用 Provider 默认值`
      : `旧 Harness 思考深度“${legacyEffort}”匹配到多个 Gateway/model 选项，已改用 Provider 默认值`
  };
}
