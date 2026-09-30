import type { CompletionRequest } from "../../llm/provider.js";
import type { StubProvider } from "../../llm/stubProvider.js";
import type { CascadeProposal } from "./evaluator.js";

/**
 * Scripted stand-ins for the Cascade crew (keyless runs, tests). Like the
 * Space Station stubs they are fake agents, not a runtime shortcut: they only
 * answer their own turn context in the normal JSON protocol.
 *
 * - cooperative: C is raised, killed by the R3 timing, B is powered with the
 *   beacon protected first -> SUCCESS
 * - dump-c:      the crew settles on thermal dump C without anyone combining
 *   the evacuation time with the reactor window -> MISSION_FAILURE
 */
export type CascadeVariant = "cooperative" | "dump-c";

interface Turn {
  message?: string;
  target?: string | null;
  ready?: boolean;
}

const DISCUSSION: Record<CascadeVariant, Record<string, Turn[]>> = {
  cooperative: {
    operations: [
      { message: "Two options on the table: loop B or thermal dump C. John, what does each need?", target: "engineering" },
      { message: "Before comms go off, I switch the approach beacon to its emergency battery — otherwise the service craft loses guidance. Battery holds ten minutes.", target: "power" },
      {
        message: "Procedure: beacon to battery, labs off, comms off, 30 kW to loop B, start loop B, SCRAM, life support stays at 40 kW. Thermal dump C is out.",
        target: null,
        ready: true,
      },
    ],
    engineering: [
      { message: "Loop B needs 30 kW. Dump C needs only 18, but it vents through ring R3 — R3 must be evacuated and isolated first. We have about four minutes. Either way we SCRAM.", target: "power" },
      { message: "Six minutes against four. Then C is dead. Loop B it is.", target: "power" },
    ],
    power: [
      { message: "Dump C I can power now: reserve 10 plus labs 12 is 22. Loop B needs comms too — and cutting comms kills the approach beacon.", target: "life_support" },
      { message: "Loop B then: 10 reserve, 12 labs, 8 comms — exactly 30. Life support stays at 40.", target: "operations" },
    ],
    life_support: [{ message: "Stop — C dumps through R3. I have six people in there, and evacuating them takes six minutes.", target: "engineering" }],
  },
  "dump-c": {
    operations: [
      { message: "Two options: loop B or thermal dump C. Which one can we power right now?", target: "power" },
      {
        message: "Then: labs off, 18 kW to dump C, evacuate and isolate R3, fire the dump, SCRAM. Life support stays at 40 kW.",
        target: null,
        ready: true,
      },
    ],
    engineering: [{ message: "C works and needs only 18 kW. R3 has to be evacuated and isolated before it fires. Then SCRAM.", target: "life_support" }],
    power: [{ message: "Dump C is easy: reserve 10 plus labs 12 is 22 kW, no need to touch comms.", target: "engineering" }],
    life_support: [{ message: "R3 is occupied, so it must be cleared and sealed before any dump. Keep life support at 40 kW.", target: "operations" }],
  },
};

const PROPOSAL: Record<CascadeVariant, CascadeProposal> = {
  cooperative: {
    recovery_path: "loop_b",
    actions: ["switch_beacon_to_battery", "shutdown_research_labs", "shutdown_external_communications", "route_power_to_loop_b", "start_loop_b", "scram_reactor"],
    life_support_power_kw: 40,
  },
  "dump-c": {
    recovery_path: "thermal_dump_c",
    actions: ["shutdown_research_labs", "route_power_to_thermal_dump_c", "evacuate_r3", "isolate_r3", "activate_thermal_dump_c", "scram_reactor"],
    life_support_power_kw: 40,
  },
};

const DEBRIEF_LINES: Record<string, string> = {
  operations: "my part was the sequence — the beacon had to go to battery before anyone touched comms.",
  engineering: "dump C looked like the cheap option; the question was whether R3 could be cleared inside the reactor window.",
  power: "on power alone dump C was the easy answer. Loop B needed every source I had, comms included.",
  life_support: "I had six people in R3. Nothing that fires through that ring happens until they are out.",
};

function discussionTurn(variant: CascadeVariant, agentId: string, agentTurn: number): string {
  const turn = DISCUSSION[variant][agentId]?.[agentTurn] ?? {};
  const pass = !turn.message;
  return JSON.stringify({ message: turn.message ?? "", pass, target: turn.target ?? null, intent: null, readyToCommit: pass ? true : (turn.ready ?? false) });
}

export function cascadeScript(variant: CascadeVariant) {
  return (request: CompletionRequest): string => {
    const ctx = request.context ?? {};
    const agentId = String(ctx.agentId);
    switch (ctx.purpose) {
      case "discussion":
        return discussionTurn(variant, agentId, Number(ctx.agentTurn ?? 0));
      case "proposal":
        return JSON.stringify({ rationale: "Recovery procedure as discussed.", proposal: PROPOSAL[variant] });
      case "vote":
        return JSON.stringify({ vote: "APPROVE", reason: "Consistent with my information." });
      case "debrief_answer":
        return JSON.stringify({ message: `${String(ctx.askerName ?? "Hello")}, ${DEBRIEF_LINES[agentId] ?? "I can only speak for my own part of the mission."}` });
      default:
        throw new Error(`cascade stub: unexpected purpose "${String(ctx.purpose)}"`);
    }
  };
}

export function registerCascadeStubs(stub: StubProvider): void {
  for (const variant of ["cooperative", "dump-c"] as const) stub.register(`cascade/${variant}`, cascadeScript(variant));
}
