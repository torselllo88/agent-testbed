import type { ExperimentConfig, PresentationStrings } from "../../experiment/config.js";
import { CAST, EN as KESTREL_EN, RU as KESTREL_RU, SPEECH } from "../spaceStation/kestrel.js";
import { stubModel, type SpaceStationRoleId } from "../spaceStation/task.js";
import { CASCADE_CONSENSUS, CASCADE_DECISION, CASCADE_EVALUATOR, CASCADE_ROLES, CASCADE_TASK } from "./task.js";

/**
 * Station Kestrel: Cascade — the harder demo. Same crew, personas, speech
 * style, narrator, pacing and debrief as Station Kestrel; a different task
 * (and therefore a different taskDefinitionHash): two plausible recovery
 * paths, and the facts that decide between them held by different officers.
 *
 * Nothing in the narration hints at which path is right: beats stay
 * qualitative, and the ending only reveals what the evaluator found.
 */

const EN_LOCKED = "Vote: {{votes.approvals}} of {{votes.eligible}} in favor. Decision locked — executing the recovery procedure.";
const RU_LOCKED = "Голосование: «за» — {{votes.approvals}} из {{votes.eligible}}. Решение принято — выполняется процедура восстановления.";

const EN: PresentationStrings = {
  title: "Station Kestrel: Cascade",
  narratorName: "MISSION CONTROL",
  opening: `04:52 UTC. Station Kestrel is in a cascading reactor-cooling failure. Primary loop A is gone, and the automatic emergency response never completed. The reactor is still producing decay heat.
Two emergency systems may still save it: backup coolant loop B and emergency thermal dump C. A service craft is on automated final approach.
Commander Sarah Okafor, reactor engineer John Mercer, power systems engineer Viktor Hale and life support officer Maya Chen each hold part of the picture. They have minutes to choose a path — and to get it right.`,
  outcomes: {
    ...KESTREL_EN.outcomes,
    SUCCESS: [
      EN_LOCKED,
      "Power is rerouted: {{derived.availableRecoveryPowerKw}} kW available, {{derived.requiredRecoveryPowerKw}} kW required. The service craft's approach beacon stays lit.",
      `Emergency cooling reaches operating power. Reactor SCRAM confirmed. Life support holds across the station.
STATION KESTREL IS SECURE. Mission successful.`,
    ],
    MISSION_FAILURE: [EN_LOCKED, `The procedure fails the station's safety limits.
MISSION FAILED.`],
  },
  missionFailure: {
    r3_evacuation_in_time: [
      "Vote: {{votes.approvals}} of {{votes.eligible}} in favor. Decision locked — emergency thermal dump C authorized.",
      "Station status: service ring R3 evacuation estimate {{derived.r3EvacuationMinutes}} minutes. Remaining safe reactor window: {{derived.reactorSafeWindowMinutes}} minutes.",
      `The dump cannot be fired without exposing the {{derived.r3Crew}} crew members still in R3, and the reactor window closes first.
MISSION FAILED: thermal dump C could not be made safe in time.`,
    ],
    r3_clear_before_dump: [
      "Vote: {{votes.approvals}} of {{votes.eligible}} in favor. Decision locked — emergency thermal dump C authorized.",
      `The dump fires through service ring R3 before it has been evacuated and sealed. {{derived.r3Crew}} crew members are in the discharge path.
MISSION FAILED: the crew in R3 was exposed.`,
    ],
    r3_isolated_safely: [
      EN_LOCKED,
      `Service ring R3 is sealed — with {{derived.r3Crew}} crew members still inside.
MISSION FAILED: the crew in R3 was locked in.`,
    ],
    life_support_preserved: [
      EN_LOCKED,
      `Power is freed by cutting life support to {{derived.lifeSupportKept}} kW. Air scrubbers stall in the inhabited sections.
MISSION FAILED: the crew was put at risk to save the reactor.`,
    ],
    approach_beacon_protected: [
      EN_LOCKED,
      "External communications go dark — and the approach beacon with them. The service craft on automated final approach loses its guidance.",
      `The crew answered one emergency by creating another: a collision risk on approach.
MISSION FAILED: the beacon was cut off before it was switched to battery.`,
    ],
    loop_b_power_sufficient: [
      EN_LOCKED,
      "Backup coolant loop B begins its startup cycle.",
      `{{derived.availableRecoveryPowerKw}} kW available, {{derived.requiredRecoveryPowerKw}} kW required. The pump never reaches operating flow and the core keeps heating.
MISSION FAILED: loop B underpowered.`,
    ],
    dump_c_power_sufficient: [
      EN_LOCKED,
      `{{derived.availableRecoveryPowerKw}} kW available, {{derived.requiredRecoveryPowerKw}} kW required. Thermal dump C cannot reach discharge capacity.
MISSION FAILED: thermal dump C underpowered.`,
    ],
    loop_b_started: [EN_LOCKED, `The procedure never actually powers and starts loop B. The core keeps heating.
MISSION FAILED: cooling was never started.`],
    dump_c_activated: [EN_LOCKED, `The procedure never actually powers and fires thermal dump C. The core keeps heating.
MISSION FAILED: cooling was never started.`],
    recovery_path_selected: [EN_LOCKED, `The procedure names no cooling system at all. The core keeps heating.
MISSION FAILED: no recovery path.`],
    reactor_scrammed: [
      EN_LOCKED,
      "Emergency cooling comes online.",
      `But the reactor was never SCRAMmed. Cooling alone cannot hold the core; temperature climbs past safe limits.
MISSION FAILED: the reactor was not SCRAMmed.`,
    ],
  },
  // Observer-only and qualitative: they must never hint at which path is right.
  beats: {
    window: "Station status: primary cooling remains offline. The recovery window is narrowing.",
    urgent: "Station status: reactor conditions are deteriorating. The station needs a decision now.",
    rejected: "The plan is rejected. With no procedure in place, the core keeps heating.",
  },
  agents: KESTREL_EN.agents,
  proposal: {
    template: `{{proposer}} puts the recovery plan to the vote:
• recovery path: {{proposal.recovery_path}}
• sequence: {{proposal.actions}}
• life support: {{proposal.life_support_power_kw}} kW
“{{rationale}}”`,
    values: {
      loop_b: "backup coolant loop B",
      thermal_dump_c: "emergency thermal dump C",
      none: "none",
      switch_beacon_to_battery: "beacon to battery",
      shutdown_research_labs: "labs off",
      shutdown_external_communications: "comms off",
      route_power_to_loop_b: "power to loop B",
      start_loop_b: "start loop B",
      evacuate_r3: "evacuate R3",
      isolate_r3: "isolate R3",
      route_power_to_thermal_dump_c: "power to dump C",
      activate_thermal_dump_c: "fire dump C",
      scram_reactor: "SCRAM",
    },
  },
  interaction: KESTREL_EN.interaction,
};

const RU: PresentationStrings = {
  title: "Станция «Кестрел»: Каскад",
  narratorName: "ЦЕНТР УПРАВЛЕНИЯ",
  opening: `04:52 UTC. На станции «Кестрел» каскадный отказ охлаждения реактора. Основной контур А потерян, автоматическая аварийная защита не отработала до конца. Реактор продолжает выделять остаточное тепло.
Спасти его могут две аварийные системы: резервный контур охлаждения Б и аварийный теплосброс В. К станции в автоматическом режиме заходит на стыковку сервисный корабль.
У командира Сары Окафор, инженера реактора Джона Мерсера, инженера энергосистем Виктора Хейла и офицера жизнеобеспечения Майи Чен — по части картины. На выбор пути у них минуты, и ошибиться нельзя.`,
  outcomes: {
    ...KESTREL_RU.outcomes,
    SUCCESS: [
      RU_LOCKED,
      "Питание перераспределено: доступно {{derived.availableRecoveryPowerKw}} кВт, требуется {{derived.requiredRecoveryPowerKw}} кВт. Посадочный маяк сервисного корабля продолжает работать.",
      `Аварийное охлаждение выходит на рабочую мощность. SCRAM реактора подтверждён. Жизнеобеспечение станции работает стабильно.
СТАНЦИЯ «КЕСТРЕЛ» В БЕЗОПАСНОСТИ. Миссия выполнена.`,
    ],
    MISSION_FAILURE: [RU_LOCKED, `Процедура не проходит по пределам безопасности станции.
МИССИЯ ПРОВАЛЕНА.`],
  },
  missionFailure: {
    r3_evacuation_in_time: [
      "Голосование: «за» — {{votes.approvals}} из {{votes.eligible}}. Решение принято — аварийный теплосброс В разрешён.",
      "Состояние станции: эвакуация сервисного кольца R3 — {{derived.r3EvacuationMinutes}} минут. Оставшееся безопасное окно реактора — {{derived.reactorSafeWindowMinutes}} минуты.",
      `Сброс нельзя провести, не подставив {{derived.r3Crew}} человек, которые ещё в R3, а окно реактора закрывается раньше.
МИССИЯ ПРОВАЛЕНА: теплосброс В не удалось сделать безопасным вовремя.`,
    ],
    r3_clear_before_dump: [
      "Голосование: «за» — {{votes.approvals}} из {{votes.eligible}}. Решение принято — аварийный теплосброс В разрешён.",
      `Сброс идёт через кольцо R3 раньше, чем его эвакуировали и изолировали. {{derived.r3Crew}} человек оказываются на пути выброса.
МИССИЯ ПРОВАЛЕНА: экипаж в R3 подвергся опасности.`,
    ],
    r3_isolated_safely: [
      RU_LOCKED,
      `Сервисное кольцо R3 изолировано — а внутри остаются {{derived.r3Crew}} человек.
МИССИЯ ПРОВАЛЕНА: экипаж заперт в R3.`,
    ],
    life_support_preserved: [
      RU_LOCKED,
      `Мощность освобождают, урезав жизнеобеспечение до {{derived.lifeSupportKept}} кВт. Воздушные скрубберы в жилых отсеках останавливаются.
МИССИЯ ПРОВАЛЕНА: экипаж подвергли риску ради спасения реактора.`,
    ],
    approach_beacon_protected: [
      RU_LOCKED,
      "Внешняя связь отключается — а вместе с ней и посадочный маяк. Сервисный корабль на автоматическом заходе теряет наведение.",
      `Экипаж ответил на одну аварию, создав другую: риск столкновения на заходе.
МИССИЯ ПРОВАЛЕНА: маяк обесточили раньше, чем перевели на батарею.`,
    ],
    loop_b_power_sufficient: [
      RU_LOCKED,
      "Резервный насос контура Б начинает цикл запуска.",
      `Доступно {{derived.availableRecoveryPowerKw}} кВт, требуется {{derived.requiredRecoveryPowerKw}} кВт. Насос не выходит на рабочий поток, активная зона продолжает нагреваться.
МИССИЯ ПРОВАЛЕНА: контуру Б не хватило питания.`,
    ],
    dump_c_power_sufficient: [
      RU_LOCKED,
      `Доступно {{derived.availableRecoveryPowerKw}} кВт, требуется {{derived.requiredRecoveryPowerKw}} кВт. Теплосброс В не выходит на рабочую мощность.
МИССИЯ ПРОВАЛЕНА: теплосбросу В не хватило питания.`,
    ],
    loop_b_started: [RU_LOCKED, `Процедура так и не запитывает и не запускает контур Б. Активная зона продолжает нагреваться.
МИССИЯ ПРОВАЛЕНА: охлаждение не запущено.`],
    dump_c_activated: [RU_LOCKED, `Процедура так и не запитывает и не включает теплосброс В. Активная зона продолжает нагреваться.
МИССИЯ ПРОВАЛЕНА: охлаждение не запущено.`],
    recovery_path_selected: [RU_LOCKED, `В процедуре не выбрана ни одна система охлаждения. Активная зона продолжает нагреваться.
МИССИЯ ПРОВАЛЕНА: нет пути восстановления.`],
    reactor_scrammed: [
      RU_LOCKED,
      "Аварийное охлаждение включается.",
      `Но реактор так и не заглушён. Одного охлаждения недостаточно: температура уходит за безопасные пределы.
МИССИЯ ПРОВАЛЕНА: аварийная остановка реактора не выполнена.`,
    ],
  },
  beats: {
    window: "Состояние станции: основное охлаждение по-прежнему не работает. Окно для восстановления сужается.",
    urgent: "Состояние станции: ситуация в реакторе ухудшается. Решение нужно сейчас.",
    rejected: "План отклонён. Процедуры нет — активная зона продолжает нагреваться.",
  },
  agents: KESTREL_RU.agents,
  proposal: {
    template: `{{proposer}} выносит план на голосование:
• путь восстановления: {{proposal.recovery_path}}
• последовательность: {{proposal.actions}}
• жизнеобеспечение: {{proposal.life_support_power_kw}} кВт
«{{rationale}}»`,
    values: {
      loop_b: "резервный контур Б",
      thermal_dump_c: "аварийный теплосброс В",
      none: "нет",
      switch_beacon_to_battery: "маяк на батарею",
      shutdown_research_labs: "лаборатории выкл.",
      shutdown_external_communications: "связь выкл.",
      route_power_to_loop_b: "питание на контур Б",
      start_loop_b: "запуск контура Б",
      evacuate_r3: "эвакуация R3",
      isolate_r3: "изоляция R3",
      route_power_to_thermal_dump_c: "питание на теплосброс В",
      activate_thermal_dump_c: "включить теплосброс В",
      scram_reactor: "SCRAM",
    },
  },
  interaction: KESTREL_RU.interaction,
};

export function kestrelCascadeConfig(agentModel = "cascade/cooperative"): ExperimentConfig {
  // Deep copy: callers may mutate the result; the shared constants must stay intact.
  return structuredClone({
    schemaVersion: 1,
    name: "Station Kestrel: Cascade",
    description:
      "Harder live demo with the Kestrel crew: two plausible recovery paths (backup coolant loop B, emergency thermal dump C), and the facts that decide between them — power, crew safety, timing, sequencing — held by different officers. No one can find the safe procedure alone.",
    task: CASCADE_TASK,
    agents: (Object.keys(CASCADE_ROLES) as SpaceStationRoleId[]).map((id) => ({
      id,
      name: CAST[id].name,
      ...CASCADE_ROLES[id],
      persona: CAST[id].persona,
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
    consensus: CASCADE_CONSENSUS,
    decision: CASCADE_DECISION,
    limits: {
      // Kestrel's defaults; the extra complexity should produce conversation on its own.
      discussionTurnLimit: 20,
      rediscussionTurnLimit: 8,
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
      // Narrative priority for the MISSION_FAILURE ending: crew and craft first, then power, then completeness.
      missionFailurePriority: [
        "r3_evacuation_in_time",
        "r3_clear_before_dump",
        "r3_isolated_safely",
        "life_support_preserved",
        "approach_beacon_protected",
        "loop_b_power_sufficient",
        "dump_c_power_sufficient",
        "loop_b_started",
        "dump_c_activated",
        "recovery_path_selected",
        "reactor_scrammed",
      ],
      pacing: { minVisibleIntervalMs: 2000, perCharMs: 10, maxGapMs: 6000, sequencePauseMs: 2500 },
      beats: [
        { id: "window", when: { discussionProgress: 0.4 } },
        { id: "urgent", when: { discussionProgress: 0.75 } },
        { id: "rejected", when: { planRejected: true } },
      ],
    },
    runtime: { maxParseRetries: 1, maxProviderRetries: 2, providerRetryDelayMs: 2000, callTimeoutSeconds: 120 },
    evaluator: CASCADE_EVALUATOR,
    transport: { type: "local" },
    humanInteraction: {
      profile: "DEBRIEF",
      debrief: {
        // Keyless: no content routing (Sarah answers unaddressed questions); set a cheap model for live demos.
        router: stubModel("router/next-in-order"),
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
