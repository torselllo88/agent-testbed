import type { z } from "zod";

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Extracts one JSON object from a model response. Tolerates the common
 * wrappers models add even when asked not to (markdown code fences, a
 * sentence before/after) — but nothing more: the object itself must be
 * valid JSON. Anything cleverer would start guessing at intent.
 */
export function extractJsonObject(text: string): ParseResult<unknown> {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: "empty response" };

  const candidates: string[] = [trimmed];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const first = trimmed.indexOf("{");
  // The first complete, balanced object — tolerates junk after it (seen live:
  // a valid object followed by a stray extra "}").
  const balanced = first === -1 ? null : balancedObjectFrom(trimmed, first);
  if (balanced) candidates.push(balanced);
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1));

  for (const candidate of candidates) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (value && typeof value === "object" && !Array.isArray(value)) return { ok: true, value };
    } catch {
      // try the next candidate
    }
  }
  return { ok: false, error: "response is not a JSON object" };
}

/** Substring from `start` (a "{") to its matching "}", respecting JSON strings and escapes; null if unbalanced. */
function balancedObjectFrom(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export function formatZodError(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

export function parseWithSchema<T>(text: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): ParseResult<T> {
  const extracted = extractJsonObject(text);
  if (!extracted.ok) return extracted;
  const result = schema.safeParse(extracted.value);
  if (!result.success) return { ok: false, error: formatZodError(result.error) };
  return { ok: true, value: result.data };
}
