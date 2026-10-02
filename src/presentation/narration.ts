import type { ConsensusResult } from "../consensus/index.js";
import type { EvaluationResult } from "../evaluation/types.js";
import type { ExperimentConfig, PresentationStrings } from "../experiment/config.js";
import type { Termination } from "../experiment/outcome.js";
import type { DeepReadonly } from "../experiment/immutable.js";

/**
 * Deterministic narration for observers: an opening and an ending, rendered
 * from the scenario's authored strings and the run's actual state. No model
 * call is ever involved — the ending says what the evaluator found, nothing more.
 */

/** Short neutral endings for technical / operator outcomes (and anything unauthored), per authored language. */
const NEUTRAL_ENDINGS: Record<string, Record<string, string>> = {
  en: {
    STOPPED_BY_OPERATOR: "The run was stopped by the operator.",
    PROVIDER_ERROR: "The run ended because a model provider failed. This is a technical interruption, not an outcome of the run.",
    ERROR: "The run ended because of an internal error. This is a technical interruption, not an outcome of the run.",
    INTERRUPTED: "The run was interrupted.",
  },
  ru: {
    STOPPED_BY_OPERATOR: "Прогон остановлен оператором.",
    PROVIDER_ERROR: "Прогон прерван из-за сбоя провайдера модели. Это техническая остановка, а не исход прогона.",
    ERROR: "Прогон прерван из-за внутренней ошибки. Это техническая остановка, а не исход прогона.",
    INTERRUPTED: "Прогон был прерван.",
  },
};

export function neutralEnding(language: string, outcome: string): string {
  const lower = language.toLowerCase();
  const table = NEUTRAL_ENDINGS[lower] ?? NEUTRAL_ENDINGS[lower.split("-")[0]!] ?? NEUTRAL_ENDINGS.en!;
  return table[outcome] ?? (lower.startsWith("ru") ? `Прогон завершён: ${outcome}.` : `The run ended: ${outcome}.`);
}

/** Outcomes that are not part of the story: they get short neutral messages unless a scenario explicitly authors one. */
const TECHNICAL_OUTCOMES = new Set(["PROVIDER_ERROR", "ERROR", "INTERRUPTED", "STOPPED_BY_OPERATOR"]);

export interface Narration {
  /** The whole narration (all parts, blank-line separated). */
  text: string;
  /** Posted one by one when the authored text is a sequence (the ending reveal); otherwise one part. */
  parts: string[];
  /** Which authored entry produced it, e.g. "opening", "outcomes.SUCCESS", "missionFailure.power_feasible", "runtime.neutral". */
  source: string;
  /** Language of the strings actually used (may be the fallback). */
  language: string;
  /** Template placeholders that had no value. */
  missing: string[];
}

function candidates(language: string, fallback: string): string[] {
  const lower = language.toLowerCase();
  return [...new Set([lower, lower.split("-")[0]!, fallback.toLowerCase()])];
}

/** The first language (requested → base language → fallback) whose strings define `pick`. */
export function pickString<T extends string | string[] = string>(
  config: ExperimentConfig,
  language: string,
  pick: (s: PresentationStrings) => T | undefined
): { text: T; language: string } | null {
  const byLang = Object.fromEntries(Object.entries(config.presentation.strings).map(([k, v]) => [k.toLowerCase(), v]));
  for (const lang of candidates(language, config.presentation.fallbackLanguage)) {
    const strings = byLang[lang];
    const text = strings ? pick(strings) : undefined;
    if (text && text.length) return { text, language: lang };
  }
  return null;
}

function rendered(texts: string | string[], ctx: Record<string, unknown>): { text: string; parts: string[]; missing: string[] } {
  const results = (Array.isArray(texts) ? texts : [texts]).map((t) => renderTemplate(t, ctx));
  const parts = results.map((r) => r.text);
  return { text: parts.join("\n\n"), parts, missing: [...new Set(results.flatMap((r) => r.missing))] };
}

function lookup(ctx: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), ctx);
}

export function renderTemplate(template: string, ctx: Record<string, unknown>): { text: string; missing: string[] } {
  const missing: string[] = [];
  const text = template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, path: string) => {
    const value = lookup(ctx, path);
    if (value === undefined || value === null) {
      missing.push(path);
      return "";
    }
    return Array.isArray(value) ? value.join(", ") : String(value);
  });
  return { text, missing };
}

export function narratorName(config: ExperimentConfig, language: string): string | null {
  if (!config.presentation.narrator) return null;
  return pickString(config, language, (s) => s.narratorName)?.text ?? config.presentation.narrator.displayName;
}

export function openingNarration(config: ExperimentConfig, language: string): Narration | null {
  if (!config.presentation.narrator) return null;
  const picked = pickString(config, language, (s) => s.opening);
  if (!picked) return null;
  const { text, missing } = renderTemplate(picked.text, { scenario: config.name });
  return { text, parts: [text], source: "opening", language: picked.language, missing };
}

/** An observer-only beat during the run (see PresentationConfig.beats); null when the language has no text for it. */
export function beatNarration(config: ExperimentConfig, language: string, beatId: string): Narration | null {
  if (!config.presentation.narrator) return null;
  const picked = pickString(config, language, (s) => s.beats?.[beatId]);
  if (!picked) return null;
  const { text, missing } = renderTemplate(picked.text, { scenario: config.name });
  return { text, parts: [text], source: `beats.${beatId}`, language: picked.language, missing };
}

export function endingNarration(
  config: ExperimentConfig,
  language: string,
  termination: Termination,
  evaluation: DeepReadonly<EvaluationResult> | null,
  evaluatorParams: unknown,
  consensus: ConsensusResult | null = null
): Narration | null {
  if (!config.presentation.narrator) return null;
  const outcome = termination.outcome;
  const violated = evaluation?.violated ?? [];
  const primaryCheck =
    outcome === "MISSION_FAILURE"
      ? (config.presentation.missionFailurePriority.find((c) => violated.includes(c)) ?? violated[0] ?? null)
      : null;

  let picked: { text: string | string[]; language: string } | null = null;
  let source = "";
  if (primaryCheck) {
    picked = pickString<string | string[]>(config, language, (s) => s.missionFailure[primaryCheck]);
    source = `missionFailure.${primaryCheck}`;
  }
  if (!picked) {
    picked = pickString<string | string[]>(config, language, (s) => s.outcomes[outcome]);
    source = `outcomes.${outcome}`;
  }
  if (!picked && !TECHNICAL_OUTCOMES.has(outcome)) {
    picked = pickString<string | string[]>(config, language, (s) => s.outcomes.default);
    source = "outcomes.default";
  }
  if (!picked) {
    const text = neutralEnding(language, outcome);
    return { text, parts: [text], source: "runtime.neutral", language, missing: [] };
  }

  const { text, parts, missing } = rendered(picked.text, {
    scenario: config.name,
    outcome,
    category: termination.category,
    reason: termination.reason,
    derived: evaluation?.derived ?? {},
    params: evaluatorParams ?? {},
    checks: evaluation?.checks ?? {},
    violated,
    primaryCheck,
    votes: consensus ? { approvals: consensus.approvals, eligible: consensus.eligible, rejections: consensus.rejections } : {},
  });
  return { text, parts, source, language: picked.language, missing };
}
