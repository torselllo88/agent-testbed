import type { ExperimentConfig, RunOverrides } from "../experiment/config.js";

/**
 * The "About & demo" page (#/demo): a one-screen introduction for someone
 * seeing the testbed for the first time, and one button that starts the
 * demo run — real models when OpenRouter is configured, scripted stub agents
 * otherwise. The text names this repository's scenarios, so it lives here,
 * with them; the page itself only renders it.
 */

export interface DemoSection {
  heading: string;
  paragraphs?: string[];
  /** Shown before the bullets. */
  intro?: string;
  bullets?: string[];
  /** Shown after the bullets. */
  after?: string[];
  /** Short emphasized lines. */
  emphasis?: string[];
}

export interface DemoContent {
  title: string;
  subtitle: string;
  intro: string[];
  pipeline: string;
  hook: string;
  button: { live: string; scripted: string };
  caption: { live: string; scripted: string };
  sections: DemoSection[];
  footnote: string;
}

export const DEMO = {
  /** The built-in scenario the button runs. */
  scenario: "station-kestrel",
  language: "en",
  /** The run's models when OpenRouter is configured; otherwise the scenario's own scripted stub agents. */
  liveModels: {
    agents: { provider: "openrouter", model: "anthropic/claude-haiku-4.5" },
    orchestration: { provider: "openrouter", model: "google/gemini-2.5-flash-lite" },
  } satisfies NonNullable<RunOverrides["models"]>,
  content: {
    title: "Agent Testbed",
    subtitle: "Controlled experiments for multi-agent LLM coordination",
    intro: [
      "Several AI agents receive different pieces of information and must communicate to reach a shared decision.",
      "The testbed records how that decision emerges — and an independent deterministic evaluator checks whether it actually works.",
    ],
    pipeline: "distributed information → interaction → collective decision → objective outcome",
    hook: "Four agents. One emergency. No agent starts with the complete solution.",
    button: { live: "Run the live demo", scripted: "Run the demo" },
    caption: {
      live: "Station Kestrel · real models via OpenRouter · about 3–5 minutes",
      scripted: "Station Kestrel · scripted agents, no model calls — a quick look at the flow",
    },
    sections: [
      {
        heading: "What can we study?",
        paragraphs: ["The testbed connects agent interaction to an objectively measurable task outcome."],
        intro: "It can be used to explore questions such as:",
        bullets: [
          "Does communication improve collective task performance?",
          "Which critical facts reach the group, and which are missed?",
          "Can agents reach consensus on a wrong solution?",
          "How do roles, models or communication rules affect the result?",
          "How do trust, hierarchy or prior interaction affect a group's ability to solve the task?",
        ],
        after: ["Every run preserves the interaction trace, configuration, model metadata, votes and evaluator result, so repeated conditions can be compared."],
      },
      {
        heading: "Adaptable by design",
        paragraphs: [
          "A scenario defines the task, what each participant knows, and how success is evaluated.",
          "Agent roles, private information, models, routing, consensus rules and other protocol settings can be varied experimentally and across repeated batch runs.",
          "Different models can participate in the same group, including models hosted on lab infrastructure through the provider interface.",
          "The same engine can support new tasks, interaction protocols and measurements without rebuilding the core system.",
        ],
      },
      {
        heading: "Try it: Station Kestrel",
        paragraphs: [
          "A cooling failure threatens a space station.",
          "Four officers know different parts of the situation. None initially has enough information to determine the safe recovery procedure alone.",
          "Watch what they share, where they disagree, and whether their final consensus is actually correct.",
        ],
        emphasis: ["The evaluator is hidden from the agents.", "They may all agree — and still fail."],
        after: [
          "Afterwards, you can question individual agents and inspect the votes, evaluator checks and complete trace.",
          "Also built in: a neutral benchmark of the same task, and Cascade — a harder variant where the decisive facts are split across all four officers.",
        ],
      },
    ],
    footnote:
      "The testbed can also complement social-agent experiments: for example, establish trust, hierarchy or conflict between agents and then measure how those relationships affect performance on the same controlled coordination task.",
  } satisfies DemoContent,
};

/**
 * A line of facts about the demo scenario, read from its configuration — so it
 * never drifts from what actually runs. Built for the built-in demo scenario: its
 * mission-failure priority lists every evaluator check (a test enforces that
 * for narrated built-ins).
 */
export function demoFacts(config: ExperimentConfig, live: boolean): string[] {
  const facts = [`${config.agents.length} agents`];
  if (config.agents.every((a) => a.privateContext.trim())) facts.push("private facts for each agent");
  const short = (id: string) => id.split("/").at(-1)!;
  facts.push(live ? `${short(DEMO.liveModels.agents.model)} agents · ${short(DEMO.liveModels.orchestration.model)} routers` : "scripted stand-in agents");
  facts.push(config.scheduler.type === "hybrid" && config.scheduler.classifier ? "turn order decided by a router" : "round-robin turns");
  facts.push(config.consensus.rule === "unanimity" ? "unanimous vote" : config.consensus.rule === "majority" ? "majority vote" : "the proposer decides, no vote");
  const checks = config.presentation.missionFailurePriority.length;
  if (checks) facts.push(`${checks} evaluator checks`);
  const languages = Object.keys(config.presentation.strings);
  if (config.presentation.narrator && languages.length) facts.push(`narration in ${languages.join(", ")}`);
  if (config.humanInteraction?.profile === "DEBRIEF") facts.push("post-run debrief with the characters");
  return facts;
}
