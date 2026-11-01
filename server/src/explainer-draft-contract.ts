import { zodToJsonSchema } from "zod-to-json-schema";
import { orchestrationShapeSchema, savedResearchTaskInputSchema } from "./validation.js";

const fields = savedResearchTaskInputSchema.innerType().shape;
// The public draft parser starts with z.unknown().transform() for legacy graph
// migration. Publish its actual structural validator rather than an empty any.
const contracts = { draft: savedResearchTaskInputSchema.innerType().extend({ orchestration: orchestrationShapeSchema }), orchestration: orchestrationShapeSchema,
  agents: fields.agents, git: fields.git, skillDefinitions: fields.skillDefinitions, mcpDefinitions: fields.mcpDefinitions };
export const EXPLAINER_SCHEMA_KEYS = Object.keys(contracts);
const schemas = new Map<string, Record<string, unknown>>();

/** The actual server validators supply structural schemas only when requested.
 * Cross-field workflow validation still runs before every write. */
export function explainerDraftContract(key?: string, entry?: string): unknown {
  if (!key) return { fields: EXPLAINER_SCHEMA_KEYS,
    instructions: "Use key for an input schema. Use entry=<top-level property> to read just that field. Server validation also checks routes, Agent identity, permissions and resources." };
  if (!Object.hasOwn(contracts, key)) throw new Error("未找到配置结构，请从 schema 字段列表复制 key。");
  let schema = schemas.get(key);
  if (!schema) {
    schema = zodToJsonSchema(contracts[key as keyof typeof contracts], { $refStrategy: "none", effectStrategy: "input" }) as Record<string, unknown>;
    schemas.set(key, schema);
  }
  if (entry !== undefined) {
    const properties = schema.properties as Record<string, unknown> | undefined;
    if (!properties || !Object.hasOwn(properties, entry)) throw new Error("未找到配置字段，请从该 schema 的 properties 复制 entry。");
    return { key, entry, schema: structuredClone(properties[entry]),
      required: Array.isArray(schema.required) && schema.required.includes(entry) };
  }
  return { key, schema: structuredClone(schema) };
}
