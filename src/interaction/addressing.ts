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

/**
 * Every name a person might use for each character: the config name and the
 * display labels in any language, and their words. Not ids — an id such as
 * "power" is also an ordinary word; ids count only as explicit mentions.
 */
export function nameVariants(config: ExperimentConfig): Map<string, string[]> {
  const variants = new Map<string, string[]>();
  for (const agent of config.agents) {
    const names = [agent.name, ...Object.values(config.presentation.strings).map((s) => s.agents[agent.id]?.name ?? "")].filter(Boolean);
    const tokens = new Set<string>();
    for (const name of names) {
      for (const word of normalize(name).split(/[^\p{L}\p{N}_]+/u)) if (word.length >= 3) tokens.add(word);
    }
    variants.set(agent.id, [...tokens]);
  }
  return variants;
}

/**
 * Whether a word of the question is a form of a name token. Exact, or an
 * inflected form (Russian cases: Виктор → Виктору, Сара → Саре, Майя → Майей):
 * the token as a prefix, or the token minus a final vowel, with a short ending.
 */
function isNameForm(word: string, token: string): boolean {
  if (word === token) return true;
  if (token.length < 4) return false;
  if (word.startsWith(token) && word.length - token.length <= 3) return true;
  if (/[aeiouyаеёиоуыэюяй]$/.test(token)) {
    const stem = token.slice(0, -1);
    return word.startsWith(stem) && word.length >= token.length && word.length - stem.length <= 3;
  }
  return false;
}

/** The character named earliest in the text (the vocative usually comes first), or null. */
export function findNamedAgent(config: ExperimentConfig, text: string): { agentId: string; word: string } | null {
  const variants = nameVariants(config);
  const words = normalize(text).split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
  for (const word of words) {
    for (const [agentId, tokens] of variants) {
      if (tokens.some((t) => isNameForm(word, t))) return { agentId, word };
    }
  }
  return null;
}

export function resolveAddressee(
  config: ExperimentConfig,
  question: { text: string; replyTo: string | null; mentions: string[] },
  /** Room message id -> the character who posted it (mission messages and debrief answers). */
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
