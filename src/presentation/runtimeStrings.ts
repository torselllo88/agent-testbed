/**
 * The runtime's own participant-visible text (moderator notices, neutral
 * endings), in a small set of authored languages with English fallback.
 * Deliberately not an i18n framework: a handful of deterministic templates.
 * Machine values (proposal ids, APPROVE/REJECT, outcome codes) stay unchanged
 * in the trace; only what is shown in the room is localized.
 */

export interface RuntimeStrings {
  proposalSubmitted(p: { attempt: number; proposerName: string; body: string; rationale: string }): string;
  proposalNotApproved(p: { attempt: number; approvals: number; eligible: number; rule: string; required: number }): string;
  voteLine(p: { agentName: string; vote: "APPROVE" | "REJECT" | "INVALID"; reason: string }): string;
  /** Short neutral endings for technical / operator outcomes, and the fallback for anything unauthored. */
  neutralEnding(outcome: string, reason: string): string;
}

const en: RuntimeStrings = {
  proposalSubmitted: ({ attempt, proposerName, body, rationale }) =>
    `Final proposal #${attempt} submitted by ${proposerName}:\n${body}\nRationale: ${rationale || "(none)"}\nVoting is open.`,
  proposalNotApproved: ({ attempt, approvals, eligible, rule, required }) =>
    `Proposal #${attempt} was not approved (${approvals} of ${eligible} approved; ${rule} requires ${required}).`,
  voteLine: ({ agentName, vote, reason }) => `- ${agentName}: ${vote}${reason ? ` — ${reason}` : ""}`,
  neutralEnding: (outcome) =>
    ({
      STOPPED_BY_OPERATOR: "The run was stopped by the operator.",
      PROVIDER_ERROR: "The run ended because a model provider failed. This is a technical interruption, not an outcome of the mission.",
      ERROR: "The run ended because of an internal error. This is a technical interruption, not an outcome of the mission.",
      INTERRUPTED: "The run was interrupted.",
    })[outcome] ?? `The run ended: ${outcome}.`,
};

const RU_RULES: Record<string, string> = { unanimity: "единогласие", majority: "большинство" };
const RU_VOTES: Record<string, string> = { APPROVE: "за", REJECT: "против", INVALID: "голос не распознан" };

const ru: RuntimeStrings = {
  proposalSubmitted: ({ attempt, proposerName, body, rationale }) =>
    `Итоговое предложение №${attempt} от ${proposerName}:\n${body}\nОбоснование: ${rationale || "(нет)"}\nГолосование открыто.`,
  proposalNotApproved: ({ attempt, approvals, eligible, rule, required }) =>
    `Предложение №${attempt} не принято: «за» — ${approvals} из ${eligible}, правило «${RU_RULES[rule] ?? rule}» требует ${required}.`,
  voteLine: ({ agentName, vote, reason }) => `- ${agentName}: ${RU_VOTES[vote] ?? vote}${reason ? ` — ${reason}` : ""}`,
  neutralEnding: (outcome) =>
    ({
      STOPPED_BY_OPERATOR: "Прогон остановлен оператором.",
      PROVIDER_ERROR: "Прогон прерван из-за сбоя провайдера модели. Это техническая остановка, а не исход миссии.",
      ERROR: "Прогон прерван из-за внутренней ошибки. Это техническая остановка, а не исход миссии.",
      INTERRUPTED: "Прогон был прерван.",
    })[outcome] ?? `Прогон завершён: ${outcome}.`,
};

const AUTHORED: Record<string, RuntimeStrings> = { en, ru };

/** Exact match, then the base language ("ru-RU" -> "ru"), then English. */
export function runtimeStrings(language: string): RuntimeStrings {
  const lower = language.toLowerCase();
  return AUTHORED[lower] ?? AUTHORED[lower.split("-")[0]!] ?? en;
}

export const AUTHORED_RUNTIME_LANGUAGES = Object.keys(AUTHORED);
