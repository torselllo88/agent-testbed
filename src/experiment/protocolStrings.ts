/**
 * The moderator's protocol notices — part of the experiment, because agents
 * read them (proposal submitted, proposal not approved) — in a small set of
 * authored languages with English fallback. Deliberately not an i18n
 * framework: a handful of deterministic templates. Machine values (proposal
 * ids, APPROVE/REJECT) stay unchanged in the trace; only the visible text is
 * localized.
 */

export interface ProtocolStrings {
  proposalSubmitted(p: { attempt: number; proposerName: string; body: string; rationale: string }): string;
  proposalNotApproved(p: { attempt: number; approvals: number; eligible: number; rule: string; required: number }): string;
  voteLine(p: { agentName: string; vote: "APPROVE" | "REJECT" | "INVALID"; reason: string }): string;
}

const en: ProtocolStrings = {
  proposalSubmitted: ({ attempt, proposerName, body, rationale }) =>
    `Final proposal #${attempt} submitted by ${proposerName}:\n${body}\nRationale: ${rationale || "(none)"}\nVoting is open.`,
  proposalNotApproved: ({ attempt, approvals, eligible, rule, required }) =>
    `Proposal #${attempt} was not approved (${approvals} of ${eligible} approved; ${rule} requires ${required}).`,
  voteLine: ({ agentName, vote, reason }) => `- ${agentName}: ${vote}${reason ? ` — ${reason}` : ""}`,
};

const RU_RULES: Record<string, string> = { unanimity: "единогласие", majority: "большинство" };
const RU_VOTES: Record<string, string> = { APPROVE: "за", REJECT: "против", INVALID: "голос не распознан" };

const ru: ProtocolStrings = {
  proposalSubmitted: ({ attempt, proposerName, body, rationale }) =>
    `Итоговое предложение №${attempt} от ${proposerName}:\n${body}\nОбоснование: ${rationale || "(нет)"}\nГолосование открыто.`,
  proposalNotApproved: ({ attempt, approvals, eligible, rule, required }) =>
    `Предложение №${attempt} не принято: «за» — ${approvals} из ${eligible}, правило «${RU_RULES[rule] ?? rule}» требует ${required}.`,
  voteLine: ({ agentName, vote, reason }) => `- ${agentName}: ${RU_VOTES[vote] ?? vote}${reason ? ` — ${reason}` : ""}`,
};

const AUTHORED: Record<string, ProtocolStrings> = { en, ru };

/** Exact match, then the base language ("ru-RU" -> "ru"), then English. */
export function protocolStrings(language: string): ProtocolStrings {
  const lower = language.toLowerCase();
  return AUTHORED[lower] ?? AUTHORED[lower.split("-")[0]!] ?? en;
}

export const AUTHORED_PROTOCOL_LANGUAGES = Object.keys(AUTHORED);
