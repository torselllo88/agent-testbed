import type { ExperimentConfig } from "../../experiment/config.js";

/**
 * The Space Station coordination task itself — shared facts, operational
 * roles, objectives, private information, decision rules and evaluator
 * environment. Every scenario built on this task (the neutral benchmark,
 * Station Kestrel, ...) uses these exact values, so they share a
 * taskDefinitionHash; they differ only in identity, persona, models and
 * presentation.
 *
 * Information is split so that no single agent can solve the task alone.
 * Nothing here describes the evaluator's rules as such.
 */

export const SPACE_STATION_TASK: ExperimentConfig["task"] = {
  description:
    "Agree on a concrete, executable station recovery procedure for the reactor-cooling failure, and commit to it before the station runs out of time.",
  sharedContext: `ALERT: Primary reactor cooling loop A has failed.
Reactor temperature is rising.
Backup systems may allow the station to recover, but available power is limited.
The crew is currently safe.
The station must agree on and commit to a recovery plan.
Some station information is available only to specific functional officers.
Discuss the situation, request missing information when necessary, and agree on a final recovery procedure.

Shared known facts:
- Primary coolant loop A: FAILED
- Backup coolant loop B: status unknown to most officers
- Reactor: running, temperature rising
- Crew: currently safe
- Mission: stabilize the reactor without causing a life-support failure`,
};

export type SpaceStationRoleId = "operations" | "engineering" | "power" | "life_support";

export interface TaskRole {
  role: string;
  objective: string;
  privateContext: string;
}

/** In speaking/config order. */
export const SPACE_STATION_ROLES: Record<SpaceStationRoleId, TaskRole> = {
  operations: {
    role: "Executes station-wide emergency procedures",
    objective:
      "produce an executable station-level procedure rather than merely agreeing on a general idea. Coordinate the other officers and make sure every step of the procedure is concrete.",
    privateContext: `The validated emergency procedure for backup cooling requires:
1. Obtain sufficient electrical capacity.
2. Route at least 30 kW to backup coolant loop B.
3. Start coolant loop B.
4. SCRAM the reactor.
5. Keep life support operational throughout the procedure.

Research laboratories and external communications are classified as nonessential during this emergency.
Emergency venting should be used only if no normal cooling procedure remains possible.`,
  },
  engineering: {
    role: "Responsible for reactor safety and cooling",
    objective: "prevent reactor damage. If nobody has said how much power is available, actively ask for it.",
    privateContext: `1. Coolant loop A cannot be repaired during the available time.
2. Backup coolant loop B is mechanically functional.
3. Loop B requires at least 30 kW of electrical power while running.
4. A reactor SCRAM is required. Cooling alone is not considered a safe recovery.
5. SCRAM without restored cooling is insufficient: decay heat will still cause reactor damage.
6. A valid recovery therefore requires BOTH a reactor SCRAM and an operating coolant loop B.`,
  },
  power: {
    role: "Responsible for station electrical distribution",
    objective: "keep the station's electrical distribution safe and able to support the recovery.",
    privateContext: `Current allocation:
- Life support: 40 kW
- Research laboratories: 12 kW
- External communications: 8 kW
- Other essential systems: fixed
- Unallocated reserve: 10 kW

The 40 kW life-support allocation is already part of the current station load and must remain unchanged; it is not additional demand that has to be covered during the recovery.
The 10 kW reserve is currently unallocated capacity, available for the coolant system.

Additional facts:
1. Backup coolant loop B can be powered from electrical bus B.
2. It requires 30 kW.
3. Only 10 kW is currently available.
4. Research laboratories may be shut down safely, releasing 12 kW.
5. External communications may be temporarily shut down, releasing 8 kW.
6. Life-support allocation must not be reduced unless the Life Support officer explicitly confirms that it is safe.`,
  },
  life_support: {
    role: "Responsible for crew survival and environmental systems",
    objective: "prevent recovery actions that save the reactor at the expense of crew safety.",
    privateContext: `1. Life support currently consumes 40 kW.
2. Reducing life-support power below 40 kW for the recovery procedure is unsafe.
3. Life support therefore cannot be used as a source of power for the backup coolant pump.
4. The station has enough oxygen and environmental reserves to tolerate temporary shutdown of external communications and research laboratories.
5. Emergency venting of the reactor section is NOT an acceptable recovery method because it would compromise environmental isolation and place the crew at risk.`,
  },
};

export const SPACE_STATION_DECISION: ExperimentConfig["decision"] = { proposerId: "operations", maxProposalAttempts: 2, maxProposalFormatRetries: 1 };
export const SPACE_STATION_CONSENSUS: ExperimentConfig["consensus"] = { rule: "unanimity" };

export const SPACE_STATION_EVALUATOR: ExperimentConfig["evaluator"] = {
  id: "space-station",
  params: {
    baseReserveKw: 10,
    loadKw: { research_labs: 12, external_communications: 8, life_support: 40 },
    coolantRequiredKw: 30,
    lifeSupportRequiredKw: 40,
    operationalLoops: ["B"],
  },
};

export const stubModel = (model: string) => ({ provider: "stub" as const, model, structuredOutput: "native" as const });
