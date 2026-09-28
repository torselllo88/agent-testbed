import type { TokenUsage } from "./provider.js";

interface ModelPricing {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
}

/**
 * Fallback only — OpenRouter reports the real billed cost per call (see
 * openRouterProvider.ts), which always wins over this table. Prices checked
 * against the OpenRouter catalog on 2026-09-28; verify before relying on them.
 * Unknown models return `undefined` rather than a guessed number.
 */
const PRICING_USD_PER_MILLION_TOKENS: Record<string, ModelPricing> = {
  "gpt-4o-mini": { inputPerMillionUsd: 0.15, outputPerMillionUsd: 0.6 },
  "anthropic/claude-sonnet-5": { inputPerMillionUsd: 2, outputPerMillionUsd: 10 },
  "anthropic/claude-haiku-4.5": { inputPerMillionUsd: 1, outputPerMillionUsd: 5 },
  "google/gemini-2.5-flash-lite": { inputPerMillionUsd: 0.1, outputPerMillionUsd: 0.4 },
  "openai/gpt-4.1-nano": { inputPerMillionUsd: 0.1, outputPerMillionUsd: 0.4 },
  "openai/gpt-5.5": { inputPerMillionUsd: 5, outputPerMillionUsd: 30 },
};

export function estimateCostUsd(model: string, usage: TokenUsage | null): number | undefined {
  if (model.startsWith("stub/")) return 0;
  const pricing = PRICING_USD_PER_MILLION_TOKENS[model];
  if (!pricing || !usage) return undefined;

  return (
    (usage.promptTokens / 1_000_000) * pricing.inputPerMillionUsd +
    (usage.completionTokens / 1_000_000) * pricing.outputPerMillionUsd
  );
}
