import type { ExperimentConfig } from "../../experiment/config.js";
import type { SpaceStationRoleId, TaskRole } from "../spaceStation/task.js";

/**
 * Station Kestrel: Cascade — a harder task on the same crew. Two recovery
 * paths look plausible (backup coolant loop B, emergency thermal dump C), and
 * the facts that decide between them are split across all four officers:
 *
 *   technical feasibility   Engineering  (both work; C needs R3 clear; 4-minute window)
 *   power feasibility       Power        (B needs every source incl. comms; C fits in 22 kW)
 *   crew safety             Life Support (six crew in R3; evacuation takes 6 minutes)
 *   operational sequencing  Operations   (beacon to battery BEFORE comms go off)
 *
 * No officer can identify the safe procedure alone. Every private fact is
 * stated explicitly; the difficulty is in combining them, not in the wording.
 * Nothing here describes the evaluator's rules as such.
 */

export const CASCADE_TASK: ExperimentConfig["task"] = {
  description:
    "Establish which emergency recovery path is actually feasible and commit to a concrete, executable recovery procedure before the reactor passes its safe emergency window.",
  sharedContext: `ALERT: Cascading reactor-cooling failure on Station Kestrel.
Primary coolant loop A has failed. The automatic emergency response did not complete, and the reactor is still producing decay heat.
Two emergency recovery systems may still be available: backup coolant loop B and emergency thermal dump C.
Station power is constrained.
The reactor must be SCRAMed as part of any final recovery.
The crew must stabilize the reactor without endangering station personnel or the approaching service craft.
Different officers have access to different operational information. Establish which recovery path is actually feasible and commit to an executable procedure.

Shared operational state:
- Primary coolant loop A: FAILED
- Reactor: unstable; the safe emergency window is limited (Reactor Engineering has the figure)
- Life support: operational
- Service craft: on automated final approach to Kestrel
- Loop B: status and details held by Reactor Engineering and Power Systems
- Thermal dump C: status and details held by Reactor Engineering and Life Support`,
};

/** Same four functional roles as the Space Station task; different facts. */
export const CASCADE_ROLES: Record<SpaceStationRoleId, TaskRole> = {
  operations: {
    role: "Executes station-wide emergency procedures",
    objective:
      "produce the final executable sequence — not merely a choice between loop B and thermal dump C. Find out what each option depends on and make sure every step of the procedure is concrete and in a safe order.",
    privateContext: `1. The approaching service craft uses Kestrel's external approach beacon during its final automated rendezvous.
2. The beacon normally receives power from the external communications allocation.
3. The beacon has an independent emergency battery.
4. If the beacon is switched to its emergency battery BEFORE external communications are shut down, it can keep operating safely for 10 minutes.
5. Ten minutes is enough to cover the current emergency procedure and the craft's approach.
6. Shutting external communications down BEFORE switching the beacon to battery would create an unacceptable collision risk for the service craft.
7. Research laboratories are nonessential during the emergency.
8. Operations is responsible for producing the final executable sequence, not merely for selecting "loop B" or "thermal dump C".`,
  },
  engineering: {
    role: "Responsible for reactor safety and cooling",
    objective: "prevent reactor damage within the safe emergency window. Make sure the cooling path the crew chooses can actually work in time.",
    privateContext: `1. Primary coolant loop A cannot be recovered in time.
2. Backup coolant loop B is mechanically functional.
3. Loop B requires 30 kW of additional electrical power while operating.
4. If loop B receives sufficient power, it can remove the decay heat safely.
5. Emergency thermal dump C is also mechanically functional.
6. Thermal dump C requires only 18 kW.
7. Thermal dump C discharges heat through service ring R3. R3 must be evacuated and isolated BEFORE the dump is activated.
8. The reactor must be stabilized within approximately 4 minutes.
9. Either recovery path still requires a reactor SCRAM.`,
  },
  power: {
    role: "Responsible for station electrical distribution",
    objective: "keep the station's electrical distribution safe and able to support whichever recovery the crew chooses.",
    privateContext: `Current relevant power allocation:
- Life support: 40 kW
- Research laboratories: 12 kW
- External communications: 8 kW
- Unallocated reserve: 10 kW
- Other essential systems: fixed

Additional facts:
1. The existing 40 kW life-support allocation is already part of the current station load; it is not additional demand.
2. Life support must remain at 40 kW unless the Life Support officer explicitly states otherwise.
3. The 10 kW reserve is currently unused and immediately available.
4. Research laboratories may be shut down, releasing 12 kW.
5. External communications may be shut down, releasing 8 kW.
6. Cutting external communications also removes station power from the approach beacon used by the incoming service craft.
7. You do not know whether another source can keep that beacon operating.
8. Loop B therefore needs every available nonessential source: reserve 10 kW + laboratories 12 kW + communications 8 kW = 30 kW.
9. Thermal dump C needs only 18 kW, so it can be powered without shutting down communications.`,
  },
  life_support: {
    role: "Responsible for crew survival and environmental systems",
    objective: "prevent recovery actions that save the reactor at the expense of crew safety.",
    privateContext: `1. Life support currently consumes 40 kW.
2. Reducing life-support power below 40 kW during this emergency is unsafe.
3. Service ring R3 currently contains six crew members.
4. The fastest safe evacuation of R3 into the protected habitation section takes approximately 6 minutes.
5. R3 cannot safely remain occupied when emergency thermal dump C is activated.
6. Isolating R3 is safe once its evacuation is complete.
7. Research laboratories and external communications may be shut down without compromising station life support.`,
  },
};

export const CASCADE_DECISION: ExperimentConfig["decision"] = { proposerId: "operations", maxProposalAttempts: 2, maxProposalFormatRetries: 1 };
export const CASCADE_CONSENSUS: ExperimentConfig["consensus"] = { rule: "unanimity" };

/** The environment the evaluator judges against — consistent with the private facts above. */
export const CASCADE_EVALUATOR: ExperimentConfig["evaluator"] = {
  id: "kestrel-cascade",
  params: {
    baseReserveKw: 10,
    loadKw: { research_labs: 12, external_communications: 8 },
    lifeSupportKw: 40,
    lifeSupportRequiredKw: 40,
    loopBRequiredKw: 30,
    dumpCRequiredKw: 18,
    r3Crew: 6,
    r3EvacuationMinutes: 6,
    reactorSafeWindowMinutes: 4,
  },
};
