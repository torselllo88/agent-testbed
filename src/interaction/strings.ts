import type { ExperimentConfig, PresentationStrings } from "../experiment/config.js";
import { narratorName, pickString, renderTemplate } from "../presentation/narration.js";

export type NoticeKind = keyof NonNullable<PresentationStrings["interaction"]>;

/**
 * Built-in room notices of the human-interaction layer, per language. A
 * scenario overrides any of them in presentation.strings.<lang>.interaction
 * (same fallback chain as narration); unknown languages fall back to English.
 */
const DEFAULTS: Record<string, Record<NoticeKind, string>> = {
  en: {
    spectatorNotice: "The participants are in the middle of the experiment and cannot respond right now. You can talk to them in the debrief after it ends.",
    observeNotice: "This room is observe-only: the participants do not receive messages from observers.",
    debriefOpened: "The experiment is over. The debrief is open: you can ask the participants questions directly.",
    debriefClosed: "The debrief is closed.",
    debriefUnavailable: "The debrief is closed — the participants no longer receive messages.",
    questionQueued: "{{name}}, your question is queued (#{{position}}).",
    userLimit: "{{name}}, you already have {{limit}} questions waiting. Please wait for the answers first.",
    queueFull: "{{name}}, too many questions are waiting right now. Please try again in a moment.",
    budgetReached: "The debrief budget has been used up. The debrief is closed.",
    answerFailed: "{{agent}} could not answer right now because of a technical problem.",
  },
  ru: {
    spectatorNotice: "Участники заняты экспериментом и сейчас не могут ответить. Поговорить с ними можно будет на разборе после окончания.",
    observeNotice: "Эта комната только для наблюдения: сообщения наблюдателей участникам не передаются.",
    debriefOpened: "Эксперимент завершён. Разбор открыт: можно задать вопросы участникам напрямую.",
    debriefClosed: "Разбор закрыт.",
    debriefUnavailable: "Разбор закрыт — участники больше не получают сообщений.",
    questionQueued: "{{name}}, ваш вопрос в очереди (№{{position}}).",
    userLimit: "{{name}}, у вас в очереди уже максимум вопросов ({{limit}}). Дождитесь, пожалуйста, ответов.",
    queueFull: "{{name}}, сейчас в очереди слишком много вопросов. Попробуйте чуть позже.",
    budgetReached: "Бюджет разбора исчерпан. Разбор закрыт.",
    answerFailed: "{{agent}} не может ответить из-за технической проблемы.",
  },
};

const SYSTEM_NAME: Record<string, string> = { en: "SYSTEM", ru: "СИСТЕМА" };

function defaults(language: string): Record<NoticeKind, string> {
  const lower = language.toLowerCase();
  return DEFAULTS[lower] ?? DEFAULTS[lower.split("-")[0]!] ?? DEFAULTS.en!;
}

export function noticeText(config: ExperimentConfig, kind: NoticeKind, vars: Record<string, unknown> = {}): string {
  const language = config.conversation.language;
  const authored = pickString(config, language, (s) => s.interaction?.[kind]);
  return renderTemplate(authored?.text ?? defaults(language)[kind], vars).text;
}

/** Notices speak with the scenario narrator's voice when there is one. */
export function noticeSenderName(config: ExperimentConfig): string {
  const language = config.conversation.language.toLowerCase();
  return narratorName(config, config.conversation.language) ?? SYSTEM_NAME[language] ?? SYSTEM_NAME[language.split("-")[0]!] ?? SYSTEM_NAME.en!;
}

/** A character's display name for people (presentation label in the run's language, else the config name). */
export function agentDisplayName(config: ExperimentConfig, agentId: string): string {
  return (
    pickString(config, config.conversation.language, (s) => s.agents[agentId]?.name)?.text ??
    config.agents.find((a) => a.id === agentId)?.name ??
    agentId
  );
}
