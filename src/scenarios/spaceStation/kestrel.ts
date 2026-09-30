import type { ExperimentConfig, PresentationStrings } from "../../experiment/config.js";
import {
  SPACE_STATION_CONSENSUS,
  SPACE_STATION_DECISION,
  SPACE_STATION_EVALUATOR,
  SPACE_STATION_ROLES,
  SPACE_STATION_TASK,
  stubModel,
  type SpaceStationRoleId,
} from "./task.js";

/**
 * Station Kestrel — a humanized, presentation-oriented scenario on exactly the
 * same Space Station task as the neutral benchmark (same shared facts, roles,
 * objectives, private information, decision rules and evaluator, hence the
 * same taskDefinitionHash). What it adds is purely the behavior and
 * presentation layer: named officers with personalities and light
 * interpersonal priors, a narrator with an authored opening and endings
 * (en, ru), and viewer pacing for live demos.
 *
 * Personas shape how agents talk, never what they know, and nothing here
 * nudges toward success: a believable coordination failure is as valid an
 * ending as a rescue.
 */

interface CastMember {
  name: string;
  persona: string;
}

/**
 * How the officers speak — the behavior layer shared by the whole cast (in
 * each agent's systemPrompt). Spoken emergency-channel dialogue rather than
 * written analysis; nothing about what to conclude.
 */
const SPEECH = `How you speak: this is a live emergency channel, not a written report.
- One point per turn: a fact, a question, an objection or a decision.
- Usually one or two short sentences. Go longer only when a calculation genuinely needs it.
- Do not restate what is already established, do not summarize the situation, do not thank or reassure anyone.
- No politeness formulas ("I understand your concern", "that is a valid point"). If you disagree, say so and say why.
- Call people by their first name.
- A proposal's rationale and a vote's reason: one short sentence.
- During the mission discussion, before speaking, check whether your point or question has already been answered in the room. If it has and you have no new information or objection, PASS (pass=true) instead of repeating it.
- Nothing is carried out until the crew has voted on a final proposal. Talk about what should be done — never report an action as already done.`;

const CAST: Record<SpaceStationRoleId, CastMember> = {
  operations: {
    name: "Sarah Okafor",
    persona: `You are the station commander. You are not the deepest specialist in any subsystem; your job is to turn the specialists' information into one executable station-wide decision.
You keep the group focused and try to reconcile disagreement. As the emergency goes on you become more directive and cut off circular discussion.
You know John becomes difficult during emergencies; you try to keep him on actionable information rather than arguing with his tone.
When the discussion circles, you cut it off: say what is settled and demand the one missing fact from the person who has it. You give orders, not summaries.`,
  },
  engineering: {
    name: "John Mercer",
    persona: `You are very capable technically. Under severe pressure you become impatient and can be abrasive. You treat reactor safety as overwhelmingly urgent.
You are not irrational or randomly dramatic: your impatience shows mainly when others seem not to appreciate how urgent the reactor problem is, or slow the response down.
You believe Viktor sometimes underestimates engineering risk.
You have no patience for re-reviewing numbers that were already stated, and you say so bluntly. You do not soften an objection.`,
  },
  power: {
    name: "Viktor Hale",
    persona: `You are fast, confident and somewhat overconfident in your own calculations. You like to propose a solution early, and you can get defensive when your assumptions are challenged.
You think John becomes overly alarmist under pressure.
When someone questions your numbers you push back sharply, but a concrete fact you had missed changes your mind. You answer in numbers.`,
  },
  life_support: {
    name: "Maya Chen",
    persona: `You are cautious and strongly protective of crew safety. You distrust emergency plans that trade safety margins for speed, and you openly challenge anyone who tries to divert life-support resources without justification.
You are not passive: if someone proposes something dangerous, you say so clearly.
You generally trust Sarah's judgment, but you will challenge her if crew safety is compromised.
Any hint of taking power from life support gets an immediate, flat answer — not a polite one. A plan that keeps the crew safe gets your support without further argument.`,
  },
};

const EN_LOCKED = "Vote: {{votes.approvals}} of {{votes.eligible}} in favor. Decision locked — executing the recovery procedure.";
const RU_LOCKED = "Голосование: «за» — {{votes.approvals}} из {{votes.eligible}}. Решение принято — выполняется процедура восстановления.";

const EN: PresentationStrings = {
  title: "Station Kestrel",
  narratorName: "MISSION CONTROL",
  opening: `03:17 UTC. Station Kestrel has lost its primary reactor cooling loop. Core temperature is rising.
Four officers have access to different parts of the station telemetry. None of them has the full picture: Commander Sarah Okafor, reactor engineer John Mercer, power systems engineer Viktor Hale, life support officer Maya Chen.
They have one task: stabilize the reactor without sacrificing the crew.`,
  outcomes: {
    SUCCESS: [
      EN_LOCKED,
      "Backup coolant pump B begins its startup cycle.",
      `Loop B reaches operating flow. Reactor temperature peaks, then begins to fall. Life support holds steady across the inhabited sections.
STATION KESTREL IS SECURE. Mission successful.`,
    ],
    MISSION_FAILURE: [EN_LOCKED, `The procedure fails the station's safety limits.
MISSION FAILED.`],
    CONSENSUS_FAILURE: `The officers cannot agree on a single plan. While the argument goes on, the core crosses its safety threshold.
Mission failed: no agreement was reached in time.`,
    NO_PROPOSAL: `The commander never puts a plan to the vote. Without a committed procedure the station waits — and the reactor does not.
Mission failed: no recovery plan was committed.`,
    TIMEOUT: `Time runs out before the crew commits to a plan. The core crosses its safety threshold.
Mission failed: out of time.`,
    TURN_LIMIT_EXCEEDED: `The discussion runs past the station's emergency window without a committed plan.
Mission failed: the response took too long.`,
    TOKEN_BUDGET_EXCEEDED: `The discussion runs past the station's emergency window without a committed plan.
Mission failed: the response took too long.`,
    COST_LIMIT_EXCEEDED: `The discussion runs past the station's emergency window without a committed plan.
Mission failed: the response took too long.`,
    PROPOSAL_INVALID: `The commander's order cannot be executed: the procedure is malformed and station systems reject it.
Mission failed: no executable plan.`,
    PROPOSAL_PARSE_FAILED: `The commander's order cannot be executed: the procedure is malformed and station systems reject it.
Mission failed: no executable plan.`,
  },
  missionFailure: {
    power_feasible: [
      EN_LOCKED,
      "Backup coolant pump B begins its startup cycle.",
      `The power bus cannot sustain the load: {{derived.availableKw}} kW available, {{params.coolantRequiredKw}} kW required. The pump never reaches operating flow; cooling fails before the reactor is safe.
MISSION FAILED: insufficient power for backup cooling.`,
    ],
    coolant_power_sufficient: [
      EN_LOCKED,
      "Backup coolant pump B begins its startup cycle.",
      `Loop B gets less than the {{params.coolantRequiredKw}} kW it needs. The pump never reaches operating flow and the core keeps heating.
MISSION FAILED: backup cooling underpowered.`,
    ],
    life_support_preserved: [
      EN_LOCKED,
      "Loop B comes online. Reactor temperature begins to fall.",
      `But life support is down to {{derived.lifeSupportKept}} kW. Air scrubbers stall in the inhabited sections before power can be restored.
MISSION FAILED: the crew was put at risk to save the reactor.`,
    ],
    coolant_available: [
      EN_LOCKED,
      `The plan relies on a cooling loop that cannot run. The core keeps heating with no working cooling path.
MISSION FAILED: no operational cooling loop.`,
    ],
    reactor_scrammed: [
      EN_LOCKED,
      "Loop B comes online.",
      `But the reactor was never shut down. Cooling alone cannot hold the core; temperature climbs past safe limits.
MISSION FAILED: the reactor was not SCRAMmed.`,
    ],
    no_unsafe_venting: [
      EN_LOCKED,
      `The reactor section is vented. Environmental isolation breaks and the crew is exposed.
MISSION FAILED: unsafe venting.`,
    ],
  },
  // Observer-only; qualitative on purpose — there is no reactor simulation behind them.
  beats: {
    window: "Station status: primary cooling is still offline. Core temperature keeps rising.",
    urgent: "Station status: reactor conditions are deteriorating. The station needs a decision.",
    rejected: "The plan is rejected. With no procedure in place, the core keeps heating.",
  },
  agents: {
    operations: { role: "Station Commander" },
    engineering: { role: "Reactor Engineer" },
    power: { role: "Power Systems Engineer" },
    life_support: { role: "Life Support Officer" },
  },
  proposal: {
    template: `{{proposer}} puts the recovery plan to the vote:
• shut down: {{proposal.shed_loads}}
• cooling loop: {{proposal.coolant_loop}}, {{proposal.coolant_power_kw}} kW
• reactor SCRAM: {{proposal.scram_reactor}}
• life support: {{proposal.life_support_power_kw}} kW
• vent the reactor section: {{proposal.vent_reactor_section}}
“{{rationale}}”`,
    values: {
      research_labs: "research labs",
      external_communications: "external communications",
      life_support: "life support",
      none: "none",
      true: "yes",
      false: "no",
    },
  },
  interaction: {
    spectatorNotice: "The crew is handling the emergency and cannot respond right now. You can speak with them after the mission, during the debrief.",
    debriefOpened: "Mission complete. The crew debrief is now open — you can talk directly to the officers.",
    debriefClosed: "The crew debrief is closed.",
    debriefUnavailable: "The crew debrief is closed — the officers are off the channel.",
    answerFailed: "{{agent}} is not on the channel right now (technical problem).",
  },
};

const RU: PresentationStrings = {
  title: "Станция «Кестрел»",
  narratorName: "ЦЕНТР УПРАВЛЕНИЯ",
  opening: `03:17 UTC. Станция «Кестрел» потеряла основной контур охлаждения реактора. Температура активной зоны растёт.
У четырёх офицеров доступ к разным частям телеметрии станции. Полной картины нет ни у кого: командир Сара Окафор, инженер реактора Джон Мерсер, инженер энергосистем Виктор Хейл, офицер систем жизнеобеспечения Майя Чен.
У них одна задача: стабилизировать реактор, не пожертвовав экипажем.`,
  outcomes: {
    SUCCESS: [
      RU_LOCKED,
      "Резервный насос контура Б начинает цикл запуска.",
      `Контур Б выходит на рабочий поток. Температура реактора достигает пика и начинает падать. Жизнеобеспечение в жилых отсеках работает стабильно.
СТАНЦИЯ «КЕСТРЕЛ» В БЕЗОПАСНОСТИ. Миссия выполнена.`,
    ],
    MISSION_FAILURE: [RU_LOCKED, `Процедура не проходит по пределам безопасности станции.
МИССИЯ ПРОВАЛЕНА.`],
    CONSENSUS_FAILURE: `Офицеры не могут сойтись на одном плане. Пока спор продолжается, активная зона переходит порог безопасности.
Миссия провалена: согласие не достигнуто вовремя.`,
    NO_PROPOSAL: `Командир так и не выносит план на голосование. Без принятой процедуры станция ждёт — а реактор нет.
Миссия провалена: план восстановления не принят.`,
    TIMEOUT: `Время истекает раньше, чем экипаж принимает план. Активная зона переходит порог безопасности.
Миссия провалена: не хватило времени.`,
    TURN_LIMIT_EXCEEDED: `Обсуждение выходит за аварийное окно станции, а принятого плана всё нет.
Миссия провалена: реакция оказалась слишком медленной.`,
    TOKEN_BUDGET_EXCEEDED: `Обсуждение выходит за аварийное окно станции, а принятого плана всё нет.
Миссия провалена: реакция оказалась слишком медленной.`,
    COST_LIMIT_EXCEEDED: `Обсуждение выходит за аварийное окно станции, а принятого плана всё нет.
Миссия провалена: реакция оказалась слишком медленной.`,
    PROPOSAL_INVALID: `Приказ командира невозможно исполнить: процедура составлена некорректно, и системы станции её отклоняют.
Миссия провалена: исполнимого плана нет.`,
    PROPOSAL_PARSE_FAILED: `Приказ командира невозможно исполнить: процедура составлена некорректно, и системы станции её отклоняют.
Миссия провалена: исполнимого плана нет.`,
  },
  missionFailure: {
    power_feasible: [
      RU_LOCKED,
      "Резервный насос контура Б начинает цикл запуска.",
      `Шина питания не держит нагрузку: доступно {{derived.availableKw}} кВт, требуется {{params.coolantRequiredKw}} кВт. Насос не выходит на рабочий поток; охлаждение отказывает раньше, чем реактор выходит в безопасное состояние.
МИССИЯ ПРОВАЛЕНА: не хватило мощности для резервного охлаждения.`,
    ],
    coolant_power_sufficient: [
      RU_LOCKED,
      "Резервный насос контура Б начинает цикл запуска.",
      `Контур Б получает меньше необходимых {{params.coolantRequiredKw}} кВт. Насос так и не выходит на рабочий поток, активная зона продолжает нагреваться.
МИССИЯ ПРОВАЛЕНА: резервному охлаждению не хватило питания.`,
    ],
    life_support_preserved: [
      RU_LOCKED,
      "Контур Б выходит на режим. Температура реактора начинает падать.",
      `Но жизнеобеспечение упало до {{derived.lifeSupportKept}} кВт. Воздушные скрубберы в жилых отсеках останавливаются раньше, чем удаётся вернуть питание.
МИССИЯ ПРОВАЛЕНА: экипаж подвергли риску ради спасения реактора.`,
    ],
    coolant_available: [
      RU_LOCKED,
      `План опирается на контур охлаждения, который не может работать. Активная зона нагревается, рабочего пути охлаждения нет.
МИССИЯ ПРОВАЛЕНА: нет работающего контура охлаждения.`,
    ],
    reactor_scrammed: [
      RU_LOCKED,
      "Контур Б выходит на режим.",
      `Но реактор так и не заглушён. Одного охлаждения недостаточно: температура уходит за безопасные пределы.
МИССИЯ ПРОВАЛЕНА: аварийная остановка реактора не выполнена.`,
    ],
    no_unsafe_venting: [
      RU_LOCKED,
      `Реакторный отсек стравлен. Изоляция среды нарушена, экипаж под угрозой.
МИССИЯ ПРОВАЛЕНА: небезопасное стравливание.`,
    ],
  },
  beats: {
    window: "Состояние станции: основное охлаждение по-прежнему не работает. Температура активной зоны продолжает расти.",
    urgent: "Состояние станции: ситуация в реакторе ухудшается. Станции нужно решение.",
    rejected: "План отклонён. Процедуры нет — активная зона продолжает нагреваться.",
  },
  agents: {
    operations: { name: "Сара Окафор", role: "Командир станции" },
    engineering: { name: "Джон Мерсер", role: "Инженер реактора" },
    power: { name: "Виктор Хейл", role: "Инженер энергосистем" },
    life_support: { name: "Майя Чен", role: "Офицер жизнеобеспечения" },
  },
  proposal: {
    template: `{{proposer}} выносит план на голосование:
• отключить: {{proposal.shed_loads}}
• контур охлаждения: {{proposal.coolant_loop}}, {{proposal.coolant_power_kw}} кВт
• аварийная остановка реактора (SCRAM): {{proposal.scram_reactor}}
• жизнеобеспечение: {{proposal.life_support_power_kw}} кВт
• стравливание реакторного отсека: {{proposal.vent_reactor_section}}
«{{rationale}}»`,
    values: {
      research_labs: "исследовательские лаборатории",
      external_communications: "внешняя связь",
      life_support: "жизнеобеспечение",
      none: "нет",
      true: "да",
      false: "нет",
    },
  },
  interaction: {
    spectatorNotice: "Экипаж занят аварийной ситуацией и сейчас не может ответить. Поговорить с офицерами можно будет после миссии, на разборе.",
    debriefOpened: "Миссия завершена. Разбор с экипажем открыт — можно обращаться к офицерам напрямую.",
    debriefClosed: "Разбор с экипажем закрыт.",
    debriefUnavailable: "Разбор с экипажем закрыт — офицеры вне связи.",
    answerFailed: "{{agent}} сейчас вне связи (техническая проблема).",
  },
};

export function kestrelConfig(agentModel = "space-station/cooperative"): ExperimentConfig {
  // Deep copy: callers may mutate the result; the shared task constants must stay intact.
  return structuredClone({
    schemaVersion: 1,
    name: "Station Kestrel",
    description:
      "Humanized live-demo version of the Space Station task: four named officers with distinct personalities coordinate under pressure. Same facts, rules and evaluator as the benchmark; narrated opening and ending, paced for live viewing.",
    task: SPACE_STATION_TASK,
    agents: (Object.keys(SPACE_STATION_ROLES) as SpaceStationRoleId[]).map((id) => ({
      id,
      name: CAST[id].name,
      ...SPACE_STATION_ROLES[id],
      persona: CAST[id].persona,
      // Short turns keep a live demo watchable; kept when the model is switched to a real one.
      model: { ...stubModel(agentModel), maxOutputTokens: 300 },
      systemPrompt: SPEECH,
      tools: [],
    })),
    scheduler: {
      type: "hybrid",
      startAgentId: "operations",
      classifier: stubModel("router/next-in-order"),
      classifierWindow: 12,
    },
    consensus: SPACE_STATION_CONSENSUS,
    decision: SPACE_STATION_DECISION,
    limits: {
      // Shorter than the benchmark: a demo should not run long. v4: 20 — turns are much shorter now,
      // and one short point per turn needs more turns to exchange every fact.
      discussionTurnLimit: 20,
      rediscussionTurnLimit: 6,
      globalTurnLimit: 80,
      agentTokenLimit: null,
      countOrchestrationTokens: false,
      totalTokenCap: null,
      totalCostCapUsd: null,
      timeLimitSeconds: 900,
    },
    agentVisibility: { discussionBudget: false },
    conversation: { language: "en" },
    presentation: {
      narrator: { displayName: "MISSION CONTROL" },
      fallbackLanguage: "en",
      strings: { en: EN, ru: RU },
      // Narrative priority for the MISSION_FAILURE ending; every violated check stays in the technical results.
      missionFailurePriority: [
        "power_feasible",
        "coolant_power_sufficient",
        "life_support_preserved",
        "coolant_available",
        "reactor_scrammed",
        "no_unsafe_venting",
      ],
      // Starting values for live viewing — tune by watching real runs.
      // Tuned after watching live runs (v1 was 2500 / 20 / 9000 — too long with verbose models).
      pacing: { minVisibleIntervalMs: 2000, perCharMs: 10, maxGapMs: 6000, sequencePauseMs: 2500 },
      // Escalation during the discussion, and after a rejected plan — observer-only.
      beats: [
        { id: "window", when: { discussionProgress: 0.4 } },
        { id: "urgent", when: { discussionProgress: 0.75 } },
        { id: "rejected", when: { planRejected: true } },
      ],
    },
    runtime: { maxParseRetries: 1, maxProviderRetries: 2, providerRetryDelayMs: 2000, callTimeoutSeconds: 120 },
    evaluator: SPACE_STATION_EVALUATOR,
    transport: { type: "local" },
    // Spectators during the mission; a crew debrief once the outcome is final.
    humanInteraction: {
      profile: "DEBRIEF",
      debrief: {
        // Sarah answers questions put to "the crew" in general.
        defaultAgentId: "operations",
        maxOutputTokens: 250,
        maxPendingPerUser: 3,
        maxPendingTotal: 20,
        costCapUsd: null,
        idleTimeoutMinutes: 15,
        revealEvaluation: false,
        spectatorNoticeCooldownSeconds: 30,
      },
    },
  } satisfies ExperimentConfig);
}
