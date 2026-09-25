import { zodResponseFormat } from "openai/helpers/zod";
import type { z } from "zod";

/**
 * zod -> JSON Schema via the `openai` package's own converter (already a
 * dependency — no zod-to-json-schema package needed). Its output marks
 * nullable fields OpenAPI-style (`"nullable": true`); that is normalized to
 * standard JSON Schema (`"type": ["string", "null"]`) because OpenRouter
 * forwards schemas to many different upstream providers.
 */
export function toJsonSchema(schema: z.ZodTypeAny, name: string): Record<string, unknown> {
  const raw = zodResponseFormat(schema, name).json_schema.schema as Record<string, unknown>;
  const normalized = normalize(raw) as Record<string, unknown>;
  delete normalized.$schema;
  return normalized;
}

function normalize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normalize);
  if (!node || typeof node !== "object") return node;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "nullable") continue;
    out[key] = normalize(value);
  }
  if ((node as Record<string, unknown>).nullable === true) {
    if (typeof out.type === "string") out.type = [out.type, "null"];
    if (Array.isArray(out.enum) && !out.enum.includes(null)) out.enum = [...out.enum, null];
    if (out.type === undefined && out.enum === undefined) return { anyOf: [out, { type: "null" }] };
  }
  return out;
}
