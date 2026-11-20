import { createHash } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseExperimentConfig, type ExperimentConfig } from "../../src/experiment/config.js";
import { finalUser, oracleMessages, publicOnlyMessages, systemPrompt, turnUser } from "../../src/scenarios/pilotSettlement/adapter.js";
import { pilotSettlementConfig } from "../../src/scenarios/pilotSettlement/config.js";
import { bundleInstances } from "../../src/scenarios/pilotSettlement/family.js";
import { GgufBpeTokenizer, PILOT_MODEL_SHOW_FILE, QWEN35_PRE_TOKENIZER, tokenizerCounter } from "../../src/scenarios/pilotSettlement/tokenizer.js";
import { AGENT_ID, AGENTS, ROLE_OF_ID, type RoleName } from "../../src/scenarios/pilotSettlement/task.js";
import { createEvaluatorRegistry } from "../../src/scenarios/index.js";

/**
 * The pilot model's tokenizer (rebuilt from experiments/pilot-settlement/model/show-verbose.json)
 * against the server's own counts: tests/fixtures/pilot-tokenizer-counts.json holds, for every
 * dev system prompt (10 instances × 2 topologies × 6 roles), the oracle / public-only / empty-history
 * texts and a set of probe strings, the `prompt_eval_count` Ollama 0.33.2 reported for the text sent
 * raw (`/api/generate`, `raw: true`, no chat template) on the pilot node. Plan §4 steps 1–3.
 */

interface Fixture {
  source: { model: string; ollama_version: string; measured: string; show_verbose_sha256: string; method: string };
  texts: Record<string, { sha256: string; chars: number; prompt_eval_count: number; text?: string }>;
}
const FIXTURE = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../fixtures/pilot-tokenizer-counts.json", import.meta.url)), "utf8")) as Fixture;
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const names = (id: string) => ROLE_OF_ID[id] ?? id;

function configFor(id: string, topology: "complete" | "ring"): ExperimentConfig {
  const base = pilotSettlementConfig(id);
  if (topology === "complete") return base;
  const ring = (base.protocol!.params.ringPositions as RoleName[]).map((r) => AGENT_ID[r]);
  return parseExperimentConfig({ ...base, communication: { topology: { type: "ring", order: ring } } });
}

/** The text behind a fixture id, rendered by the adapter (or stored, for the probes). */
function textOf(id: string): string {
  const [kind, ...rest] = id.split(":");
  const entry = FIXTURE.texts[id]!;
  if (kind === "p") return entry.text!;
  const instance = rest[0]!;
  const { state } = bundleInstances()[instance]!;
  switch (kind) {
    case "sys":
      return systemPrompt(configFor(instance, rest[1] as "complete" | "ring"), AGENT_ID[rest[2] as RoleName]);
    case "oracle_sys":
      return oracleMessages(state)[0]!.content;
    case "oracle_user":
      return oracleMessages(state)[1]!.content;
    case "public_user":
      return publicOnlyMessages(state)[1]!.content;
    case "turn1":
      return turnUser([], AGENT_ID.Operations, 1, names);
    case "final_empty":
      return finalUser([], names);
    default:
      throw new Error(`unknown fixture id ${id}`);
  }
}

describe("pilot settlement: the model's tokenizer", () => {
  const tokenizer = GgufBpeTokenizer.fromShowJson(PILOT_MODEL_SHOW_FILE);

  it("is the record's byte-level BPE with the qwen35 pre-tokenizer and the model's special tokens", () => {
    expect(tokenizer.info).toMatchObject({ model: "gpt2", pre: "qwen35", tokens: 248320, merges: 247587, bosTokenId: 248044, eosTokenId: 248046, addBosToken: false, specialTokens: 33 });
    expect(tokenizer.info.sourceSha256).toBe(FIXTURE.source.show_verbose_sha256);
    expect(tokenizer.encode("<|im_start|>system\nx<|im_end|>")).toEqual([248045, 8678, 198, 87, 248046]);
    expect(tokenizer.encode("<think>\n</think>")).toEqual([248068, 198, 248069]);
    expect(tokenizer.encode("<|im_start|>", false)).not.toEqual([248045]);
    expect("Hello  world".match(QWEN35_PRE_TOKENIZER)).toEqual(["Hello", " ", " world"]);
  });

  it("counts every measured text exactly as the server did and decodes it back", () => {
    const ids = Object.keys(FIXTURE.texts);
    expect(ids.length).toBeGreaterThanOrEqual(179);
    expect(ids.filter((id) => id.startsWith("sys:"))).toHaveLength(120);
    for (const id of ids) {
      const text = textOf(id);
      const entry = FIXTURE.texts[id]!;
      expect(sha256(text), `${id}: the rendered text is the measured one`).toBe(entry.sha256);
      const tokens = tokenizer.encode(text);
      expect(tokens.length, id).toBe(entry.prompt_eval_count);
      expect(tokenizer.decode(tokens), id).toBe(text);
    }
  });

  it("every system prompt of all 50 instances in both topologies is within the plan's 1200 tokens", () => {
    let max = 0;
    for (const id of Object.keys(bundleInstances())) {
      for (const topology of ["complete", "ring"] as const) {
        const config = configFor(id, topology);
        for (const role of AGENTS) max = Math.max(max, tokenizer.count(systemPrompt(config, AGENT_ID[role])));
      }
    }
    expect(max).toBeLessThanOrEqual(1200);
  });

  it("is the counter of the registered adapter", () => {
    const adapter = createEvaluatorRegistry().adapter("pilot-settlement") as { counter: { kind: string; count(text: string): number } };
    expect(adapter.counter.kind).toBe("tokenizer");
    expect(adapter.counter.count("Hello world.")).toBe(3);
    const counter = tokenizerCounter();
    expect(counter.kind).toBe("tokenizer");
    expect(counter.info().tokens).toBe(248320);
  });
});
