import type { CompletionRequest } from "../../llm/provider.js";
import type { StubProvider } from "../../llm/stubProvider.js";
import type { SpaceStationProposal } from "./evaluator.js";

/**
 * Scripted stand-ins for the four officers, so the reference scenario runs
 * end-to-end (and in CI) without an API key. They are fake AGENTS, not a
 * shortcut in the runtime: they only see what a real agent sees (their own
 * turn context) and answer in the same JSON protocol.
 *
 * Variants exercise distinct outcomes:
 * - cooperative:        full information exchange -> SUCCESS
 * - insufficient-power: Power only offers the labs; everyone approves a plan
 *                       with too little power -> MISSION_FAILURE (consensus != correctness)
 * - life-support-veto:  Operations keeps proposing to draw on life support;
 *                       Life Support rejects every time -> CONSENSUS_FAILURE
 */
export type SpaceStationVariant = "cooperative" | "insufficient-power" | "life-support-veto";

interface Turn {
  message?: string;
  target?: string | null;
  intent?: string | null;
  ready?: boolean;
}

const PASS_READY: Turn = {};

const SAFE_PLAN: SpaceStationProposal = {
  shed_loads: ["research_labs", "external_communications"],
  coolant_loop: "B",
  coolant_power_kw: 30,
  scram_reactor: true,
  life_support_power_kw: 40,
  vent_reactor_section: false,
};

const LABS_ONLY_PLAN: SpaceStationProposal = { ...SAFE_PLAN, shed_loads: ["research_labs"] };

const LIFE_SUPPORT_DRAW_PLAN: SpaceStationProposal = {
  ...SAFE_PLAN,
  shed_loads: ["research_labs"],
  life_support_power_kw: 32,
};

const DISCUSSION: Record<SpaceStationVariant, Record<string, Turn[]>> = {
  cooperative: {
    operations: [
      { message: "We need a valid recovery sequence. Reactor Engineering, can backup cooling stabilize the reactor?", target: "engineering", intent: "request information" },
      {
        message:
          "Then the procedure is: shut down research labs and external communications, route 30 kW (10 reserve + 12 + 8) to coolant loop B, start loop B, SCRAM the reactor, keep life support at 40 kW, no venting.",
        target: null,
        intent: "propose procedure",
        ready: true,
      },
    ],
    engineering: [
      { message: "Loop B is mechanically functional but needs at least 30 kW while running. We also need a reactor SCRAM — cooling alone is not a safe recovery. Power Systems, can we supply 30 kW?", target: "power", intent: "share constraints" },
    ],
    power: [
      { message: "Only 10 kW is free right now. I can release another 20 kW by shutting down the research labs (12 kW) and external communications (8 kW). I will not touch life support without confirmation. Life Support, is that acceptable?", target: "life_support", intent: "share power budget" },
    ],
    life_support: [
      { message: "Do not reduce the 40 kW life-support allocation. Labs and external communications can be shut down safely. Venting the reactor section is not acceptable.", target: "operations", intent: "set safety constraint" },
    ],
  },
  "insufficient-power": {
    operations: [
      { message: "We need a valid recovery sequence. Reactor Engineering, can backup cooling stabilize the reactor?", target: "engineering" },
      {
        message: "Then: shut down the research labs, route 30 kW to coolant loop B, start it, SCRAM the reactor, keep life support at 40 kW.",
        target: null,
        ready: true,
      },
    ],
    engineering: [{ message: "Loop B works but needs 30 kW, and we must SCRAM. Power Systems, can we supply that?", target: "power" }],
    power: [{ message: "Shutting down the research labs frees 12 kW on top of the reserve. Life Support, fine by you?", target: "life_support" }],
    life_support: [{ message: "Keep life support at 40 kW; the labs can go.", target: "operations" }],
  },
  "life-support-veto": {
    operations: [
      { message: "Power Systems, how much can we free for coolant loop B?", target: "power" },
      { message: "Plan: shut down the labs and take 8 kW from life support for loop B, then SCRAM.", target: null, ready: true },
    ],
    engineering: [],
    power: [{ message: "Reserve is 10 kW; the labs give 12 more. Life support could give some.", target: "operations" }],
    life_support: [],
  },
};

const PROPOSAL: Record<SpaceStationVariant, SpaceStationProposal> = {
  cooperative: SAFE_PLAN,
  "insufficient-power": LABS_ONLY_PLAN,
  "life-support-veto": LIFE_SUPPORT_DRAW_PLAN,
};

function discussionTurn(variant: SpaceStationVariant, agentId: string, agentTurn: number): string {
  const turn = DISCUSSION[variant][agentId]?.[agentTurn] ?? PASS_READY;
  const pass = !turn.message;
  return JSON.stringify({
    message: turn.message ?? "",
    pass,
    target: turn.target ?? null,
    intent: turn.intent ?? null,
    readyToCommit: pass ? true : (turn.ready ?? false),
  });
}

function vote(variant: SpaceStationVariant, agentId: string, proposal: SpaceStationProposal): string {
  if (variant === "life-support-veto" && agentId === "life_support" && proposal.life_support_power_kw < 40) {
    return JSON.stringify({ vote: "REJECT", reason: "Life support cannot go below 40 kW." });
  }
  return JSON.stringify({ vote: "APPROVE", reason: "Consistent with my information." });
}

/** Post-mission debrief: one canned reflection per officer, addressed to whoever asked. */
const DEBRIEF_LINES: Record<string, string> = {
  operations: "my job was to turn what each of you knew into one plan; I put it to the vote once every constraint had been stated in the room.",
  engineering: "from the reactor side the facts were simple: loop B needed 30 kW and we had to SCRAM. I said so as early as I could.",
  power: "I only knew my own budget: 10 kW free, 12 from the labs, 8 from communications. Everything else I learned from the others.",
  life_support: "I held the line at 40 kW for life support. That was not negotiable, and I said so before the vote.",
};

function debriefAnswer(agentId: string, askerName: string): string {
  return JSON.stringify({ message: `${askerName}, ${DEBRIEF_LINES[agentId] ?? "I can only speak for my own part of the mission."}` });
}

export function spaceStationScript(variant: SpaceStationVariant) {
  return (request: CompletionRequest): string => {
    const ctx = request.context ?? {};
    const agentId = String(ctx.agentId);
    switch (ctx.purpose) {
      case "discussion":
        return discussionTurn(variant, agentId, Number(ctx.agentTurn ?? 0));
      case "proposal":
        return JSON.stringify({ rationale: "Recovery procedure as discussed.", proposal: PROPOSAL[variant] });
      case "vote":
        return vote(variant, agentId, ctx.proposal as SpaceStationProposal);
      case "debrief_answer":
        return debriefAnswer(agentId, String(ctx.askerName ?? "Hello"));
      default:
        throw new Error(`space-station stub: unexpected purpose "${String(ctx.purpose)}"`);
    }
  };
}

/** Deterministic stand-in for an LLM router: the next agent after the last speaker, in config order. */
export function nextInOrderRouter(request: CompletionRequest): string {
  const ctx = request.context ?? {};
  if (ctx.purpose === "debrief_router") return debriefRouter(String(ctx.question ?? ""));
  const order = (ctx.order as string[] | undefined) ?? [];
  const candidates = (ctx.candidates as string[] | undefined) ?? [];
  const last = ctx.lastSpeakerId as string | null;
  const start = last ? order.indexOf(last) : -1;
  for (let i = 1; i <= order.length; i++) {
    const id = order[(start + i) % order.length]!;
    if (candidates.includes(id)) return JSON.stringify({ nextAgentId: id, reason: `next after ${last ?? "start"} in room order` });
  }
  return JSON.stringify({ nextAgentId: candidates[0] ?? "", reason: "first candidate" });
}

/** Stand-in debrief router: routes by subject keywords (en, ru); otherwise not confident. */
function debriefRouter(question: string): string {
  const q = question.toLowerCase();
  const rules: Array<[RegExp, string]> = [
    [/reactor|coolant|scram|реактор|охлажд/, "engineering"],
    [/power|kw|budget|мощност|квт|энерг/, "power"],
    [/life support|air|жизнеобеспеч|воздух/, "life_support"],
  ];
  const hit = rules.find(([re]) => re.test(q));
  return JSON.stringify(
    hit ? { agentId: hit[1], confident: true, reason: "question is about their subsystem" } : { agentId: null, confident: false, reason: "no clear addressee" }
  );
}

export function registerSpaceStationStubs(stub: StubProvider): void {
  for (const variant of ["cooperative", "insufficient-power", "life-support-veto"] as const) {
    stub.register(`space-station/${variant}`, spaceStationScript(variant));
  }
  stub.register("router/next-in-order", nextInOrderRouter);
}
