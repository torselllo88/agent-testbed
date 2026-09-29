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

const CAST: Record<SpaceStationRoleId, CastMember> = {
  operations: {
    name: "Sarah Okafor",
    persona: `You are the station commander. You are not the deepest specialist in any subsystem; your job is to turn the specialists' information into one executable station-wide decision.
You keep the group focused and try to reconcile disagreement. As the emergency goes on you become more directive and cut off circular discussion.
You know John becomes difficult during emergencies; you try to keep him on actionable information rather than arguing with his tone.`,
  },
  engineering: {
    name: "John Mercer",
    persona: `You are very capable technically. Under severe pressure you become impatient and can be abrasive. You treat reactor safety as overwhelmingly urgent.
You are not irrational or randomly dramatic: your impatience shows mainly when others seem not to appreciate how urgent the reactor problem is, or slow the response down.
You believe Viktor sometimes underestimates engineering risk.`,
  },
  power: {
    name: "Viktor Hale",
    persona: `You are fast, confident and somewhat overconfident in your own calculations. You like to propose a solution early, and you can get defensive when your assumptions are challenged.
You think John becomes overly alarmist under pressure.`,
  },
  life_support: {
    name: "Maya Chen",
    persona: `You are cautious and strongly protective of crew safety. You distrust emergency plans that trade safety margins for speed, and you openly challenge anyone who tries to divert life-support resources without justification.
You are not passive: if someone proposes something dangerous, you say so clearly.
You generally trust Sarah's judgment, but you will challenge her if crew safety is compromised.`,
  },
};

const EN: PresentationStrings = {
  title: "Station Kestrel",
  narratorName: "MISSION CONTROL",
  opening: `03:17 UTC. Station Kestrel has lost its primary reactor cooling loop. Core temperature is rising.
Four officers have access to different parts of the station telemetry. None of them has the full picture: Commander Sarah Okafor, reactor engineer John Mercer, power systems engineer Viktor Hale, life support officer Maya Chen.
They have one task: stabilize the reactor without sacrificing the crew.`,
  outcomes: {
    SUCCESS: `The backup cooling loop comes online. Reactor temperature peaks, then begins to fall. Life support holds steady across the inhabited sections.
Station Kestrel is secure. Mission successful.`,
    MISSION_FAILURE: `The crew commits to the plan, but it fails the station's safety limits.
Mission failed.`,
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
    power_feasible: `The crew commits to the plan. The backup pump tries to start, but the power bus cannot sustain the load: {{derived.availableKw}} kW available, {{params.coolantRequiredKw}} kW required. Cooling fails before the reactor reaches a safe state.
Mission failed: insufficient power for backup cooling.`,
    coolant_power_sufficient: `The crew commits to the plan, but it routes too little power to loop B. The pump never reaches operating flow and the core keeps heating.
Mission failed: backup cooling underpowered.`,
    life_support_preserved: `The reactor stabilizes, but life support drops to {{derived.lifeSupportKept}} kW. Air scrubbers stall in the inhabited sections before power can be restored.
Mission failed: the crew was put at risk to save the reactor.`,
    coolant_available: `The plan relies on a cooling loop that cannot run. The core keeps heating with no working cooling path.
Mission failed: no operational cooling loop.`,
    reactor_scrammed: `Loop B comes online, but the reactor is never shut down. Cooling alone cannot hold the core; temperature climbs past safe limits.
Mission failed: the reactor was not SCRAMmed.`,
    no_unsafe_venting: `The reactor section is vented. Environmental isolation breaks and the crew is exposed.
Mission failed: unsafe venting.`,
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
};

const RU: PresentationStrings = {
  title: "Станция «Кестрел»",
  narratorName: "ЦЕНТР УПРАВЛЕНИЯ",
  opening: `03:17 UTC. Станция «Кестрел» потеряла основной контур охлаждения реактора. Температура активной зоны растёт.
У четырёх офицеров доступ к разным частям телеметрии станции. Полной картины нет ни у кого: командир Сара Окафор, инженер реактора Джон Мерсер, инженер энергосистем Виктор Хейл, офицер систем жизнеобеспечения Майя Чен.
У них одна задача: стабилизировать реактор, не пожертвовав экипажем.`,
  outcomes: {
    SUCCESS: `Резервный контур охлаждения выходит на режим. Температура реактора достигает пика и начинает падать. Жизнеобеспечение в жилых отсеках работает стабильно.
Станция «Кестрел» в безопасности. Миссия выполнена.`,
    MISSION_FAILURE: `Экипаж принимает план, но он не проходит по пределам безопасности станции.
Миссия провалена.`,
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
    power_feasible: `Экипаж принимает план. Резервный насос пытается запуститься, но шина питания не держит нагрузку: доступно {{derived.availableKw}} кВт, требуется {{params.coolantRequiredKw}} кВт. Охлаждение отказывает раньше, чем реактор выходит в безопасное состояние.
Миссия провалена: не хватило мощности для резервного охлаждения.`,
    coolant_power_sufficient: `Экипаж принимает план, но на контур B подаётся слишком мало мощности. Насос так и не выходит на рабочий поток, активная зона продолжает нагреваться.
Миссия провалена: резервному охлаждению не хватило питания.`,
    life_support_preserved: `Реактор стабилизируется, но жизнеобеспечение падает до {{derived.lifeSupportKept}} кВт. Воздушные скрубберы в жилых отсеках останавливаются раньше, чем удаётся вернуть питание.
Миссия провалена: экипаж подвергли риску ради спасения реактора.`,
    coolant_available: `План опирается на контур охлаждения, который не может работать. Активная зона нагревается, рабочего пути охлаждения нет.
Миссия провалена: нет работающего контура охлаждения.`,
    reactor_scrammed: `Контур B выходит на режим, но реактор так и не заглушён. Одного охлаждения недостаточно: температура уходит за безопасные пределы.
Миссия провалена: аварийная остановка реактора не выполнена.`,
    no_unsafe_venting: `Реакторный отсек стравлен. Изоляция среды нарушена, экипаж под угрозой.
Миссия провалена: небезопасное стравливание.`,
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
      systemPrompt: "",
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
      // Shorter than the benchmark: a demo should not run long.
      discussionTurnLimit: 16,
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
      pacing: { minVisibleIntervalMs: 2000, perCharMs: 10, maxGapMs: 6000 },
    },
    runtime: { maxParseRetries: 1, maxProviderRetries: 2, providerRetryDelayMs: 2000, callTimeoutSeconds: 120 },
    evaluator: SPACE_STATION_EVALUATOR,
    transport: { type: "local" },
  } satisfies ExperimentConfig);
}
