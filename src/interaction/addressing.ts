import type { ExperimentConfig } from "../experiment/config.js";

/**
 * Deterministic addressee resolution for a debrief question — tried before
 * any model is asked: an explicit reply to a character's message, then an
 * explicit mention, then a character's name in the text.
 */

export type AddressSource = "reply" | "mention" | "name";

export interface Addressee {
  agentId: string;
  source: AddressSource;
  detail: string;
}

const normalize = (s: string) => s.toLowerCase().replace(/ё/g, "е");

const words = (s: string) => normalize(s).split(/[^\p{L}\p{N}_]+/u).filter(Boolean);

/**
 * Every name a person might use for each character, as word sequences: the
 * config name and the display labels in any language, each of their words
 * (3+ letters: "Viktor" for "Viktor Hale"), and the scenario's aliases
 * (humanInteraction.aliases — e.g. inflected forms: Виктору, Майей). Not ids —
 * an id such as "power" is also an ordinary word; ids count only as explicit
 * mentions.
 */
export function nameVariants(config: ExperimentConfig): Map<string, string[][]> {
  const variants = new Map<string, string[][]>();
  for (const agent of config.agents) {
    const names = [agent.name, ...Object.values(config.presentation.strings).map((s) => s.agents[agent.id]?.name ?? "")].filter(Boolean);
    const phrases = new Map<string, string[]>();
    const add = (w: string[]) => w.length > 0 && phrases.set(w.join(" "), w);
    for (const name of names) {
      add(words(name));
      for (const word of words(name)) if (word.length >= 3) add([word]);
    }
    for (const alias of config.humanInteraction?.aliases?.[agent.id] ?? []) add(words(alias));
    variants.set(agent.id, [...phrases.values()]);
  }
  return variants;
}

/**
 * The character named earliest in the text (the vocative usually comes first),
 * or null. Whole words only — no stems or prefixes, so "maybe" is not Maya and
 * "half" is not Hale; other word forms come from the scenario's aliases. At one
 * position the longest name wins ("Maya Chen" over "Maya").
 */
export function findNamedAgent(config: ExperimentConfig, text: string): { agentId: string; word: string } | null {
  const variants = nameVariants(config);
  const tokens = words(text);
  for (let i = 0; i < tokens.length; i++) {
    let best: { agentId: string; phrase: string[] } | null = null;
    for (const [agentId, phrases] of variants) {
      for (const phrase of phrases) {
        const fits = phrase.every((w, k) => tokens[i + k] === w);
        if (fits && (!best || phrase.length > best.phrase.length)) best = { agentId, phrase };
      }
    }
    if (best) return { agentId: best.agentId, word: best.phrase.join(" ") };
  }
  return null;
}

export function resolveAddressee(
  config: ExperimentConfig,
  question: { text: string; replyTo: string | null; mentions: string[] },
  /** Room message id -> the character who posted it (run messages and debrief answers). */
  authorOf: (messageId: string) => string | null
): Addressee | null {
  if (question.replyTo) {
    const agentId = authorOf(question.replyTo);
    if (agentId) return { agentId, source: "reply", detail: `reply to ${question.replyTo}` };
  }
  for (const mention of question.mentions) {
    const byId = config.agents.find((a) => a.id === mention);
    if (byId) return { agentId: byId.id, source: "mention", detail: mention };
    const named = findNamedAgent(config, mention);
    if (named) return { agentId: named.agentId, source: "mention", detail: mention };
  }
  const named = findNamedAgent(config, question.text);
  return named ? { agentId: named.agentId, source: "name", detail: named.word } : null;
}
