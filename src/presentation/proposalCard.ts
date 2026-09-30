import type { ExperimentConfig, PresentationStrings } from "../experiment/config.js";

type ProposalSpec = NonNullable<PresentationStrings["proposal"]>;

/** The proposal template for the run's language, via the narration fallback chain (requested → base language → fallback). */
function proposalSpec(config: ExperimentConfig): ProposalSpec | null {
  const byLang = Object.fromEntries(Object.entries(config.presentation.strings).map(([k, v]) => [k.toLowerCase(), v]));
  const lang = config.conversation.language.toLowerCase();
  for (const l of new Set([lang, lang.split("-")[0]!, config.presentation.fallbackLanguage.toLowerCase()])) {
    const spec = byLang[l]?.proposal;
    if (spec) return spec;
  }
  return null;
}

/**
 * Human-readable rendering of a submitted proposal for observers, from the
 * scenario's presentation.strings.<lang>.proposal template. The protocol
 * notice agents read (with the raw proposal) is unchanged; this is only what
 * people see. Null when the scenario defines no template.
 * (The viewer page has the same logic client-side.)
 */
export function renderProposalCard(
  config: ExperimentConfig,
  proposal: { body: unknown; rationale: string; attempt: number },
  proposerName: string
): string | null {
  const spec = proposalSpec(config);
  if (!spec) return null;
  const label = (field: string, value: unknown) => spec.values[`${field}.${String(value)}`] ?? spec.values[String(value)] ?? String(value);
  const body = (proposal.body ?? {}) as Record<string, unknown>;
  const ctx: Record<string, string> = { rationale: proposal.rationale, proposer: proposerName, attempt: String(proposal.attempt) };
  return spec.template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, path: string) => {
    if (path.startsWith("proposal.")) {
      const field = path.slice("proposal.".length);
      const value = body[field];
      if (value === undefined) return "";
      if (Array.isArray(value)) return value.length ? value.map((v) => label(field, v)).join(", ") : label(field, "none");
      return label(field, value);
    }
    return ctx[path] ?? "";
  });
}
