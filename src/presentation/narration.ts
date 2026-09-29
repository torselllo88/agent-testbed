import type { EvaluationResult } from "../evaluation/types.js";
import type { ExperimentConfig, PresentationStrings } from "../experiment/config.js";
import type { Termination } from "../experiment/outcome.js";
import { runtimeStrings } from "./runtimeStrings.js";

/**
 * Deterministic narration for observers: an opening and an ending, rendered
 * from the scenario's authored strings and the run's actual state. No model
 * call is ever involved — the ending says what the evaluator found, nothing more.
 */

/** Outcomes that are not part of the story: they get short neutral messages unless a scenario explicitly authors one. */
const TECHNICAL_OUTCOMES = new Set(["PROVIDER_ERROR", "ERROR", "INTERRUPTED", "STOPPED_BY_OPERATOR"]);

export interface Narration {
  text: string;
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
function pickString(
  config: ExperimentConfig,
  language: string,
  pick: (s: PresentationStrings) => string | undefined
): { text: string; language: string } | null {
  const byLang = Object.fromEntries(Object.entries(config.presentation.strings).map(([k, v]) => [k.toLowerCase(), v]));
  for (const lang of candidates(language, config.presentation.fallbackLanguage)) {
    const strings = byLang[lang];
    const text = strings ? pick(strings) : undefined;
    if (text) return { text, language: lang };
  }
  return null;
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
  return { text, source: "opening", language: picked.language, missing };
}

export function endingNarration(
  config: ExperimentConfig,
  language: string,
  termination: Termination,
  evaluation: EvaluationResult | null,
  evaluatorParams: unknown
): Narration | null {
  if (!config.presentation.narrator) return null;
  const outcome = termination.outcome;
  const violated = evaluation?.violated ?? [];
  const primaryCheck =
    outcome === "MISSION_FAILURE"
      ? (config.presentation.missionFailurePriority.find((c) => violated.includes(c)) ?? violated[0] ?? null)
      : null;

  let picked: { text: string; language: string } | null = null;
  let source = "";
  if (primaryCheck) {
    picked = pickString(config, language, (s) => s.missionFailure[primaryCheck]);
    source = `missionFailure.${primaryCheck}`;
  }
  if (!picked) {
    picked = pickString(config, language, (s) => s.outcomes[outcome]);
    source = `outcomes.${outcome}`;
  }
  if (!picked && !TECHNICAL_OUTCOMES.has(outcome)) {
    picked = pickString(config, language, (s) => s.outcomes.default);
    source = "outcomes.default";
  }
  if (!picked) {
    return { text: runtimeStrings(language).neutralEnding(outcome, termination.reason), source: "runtime.neutral", language, missing: [] };
  }

  const { text, missing } = renderTemplate(picked.text, {
    scenario: config.name,
    outcome,
    category: termination.category,
    reason: termination.reason,
    derived: evaluation?.derived ?? {},
    params: evaluatorParams ?? {},
    checks: evaluation?.checks ?? {},
    violated,
    primaryCheck,
  });
  return { text, source, language: picked.language, missing };
}
