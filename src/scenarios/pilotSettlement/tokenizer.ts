/**
 * The pilot model's tokenizer, rebuilt from Ollama's `/api/show` record (`verbose: true`):
 * a GPT-2-style byte-level BPE over `tokenizer.ggml.tokens` / `tokenizer.ggml.merges`, with the
 * `qwen35` pre-tokenizer of llama.cpp (`src/llama-vocab.cpp`, LLAMA_VOCAB_PRE_TYPE_QWEN35) and the
 * model's control / user-defined tokens matched literally. Checked against the server's own counts
 * (`/api/generate` with `raw: true`, `prompt_eval_count`) in `tests/scenarios/pilotTokenizer.test.ts`.
 *
 * The frozen record is `experiments/pilot-settlement/model/show-verbose.json`; the adapter counts
 * every prompt and every visible message with it (`tokenCounter: "tokenizer"` on the call).
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { TokenCounter } from "./adapter.js";

/** llama.cpp's regex for `tokenizer.ggml.pre = "qwen35"` (the `(?i:'s|…)` group written out, as llama.cpp does). */
export const QWEN35_PRE_TOKENIZER =
  /(?:'[sS]|'[tT]|'[rR][eE]|'[vV][eE]|'[mM]|'[lL][lL]|'[dD])|[^\r\n\p{L}\p{N}]?[\p{L}\p{M}]+|\p{N}| ?[^\s\p{L}\p{M}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/gu;

/** GGUF token types (gguf-py `TokenType`). */
const TOKEN_TYPE = { normal: 1, unknown: 2, control: 3, userDefined: 4, unused: 5, byte: 6 } as const;

/** The default record: the model's `/api/show` with `verbose: true`, sanitized, in the experiment folder. */
export const PILOT_MODEL_SHOW_FILE = fileURLToPath(new URL("../../../experiments/pilot-settlement/model/show-verbose.json", import.meta.url));

/** GPT-2 `bytes_to_unicode`: every byte to a printable code point, printable ASCII/Latin-1 to itself. */
function byteToUnicode(): string[] {
  const bs: number[] = [];
  for (let b = 33; b <= 126; b++) bs.push(b);
  for (let b = 161; b <= 172; b++) bs.push(b);
  for (let b = 174; b <= 255; b++) bs.push(b);
  const cs = bs.slice();
  let n = 0;
  for (let b = 0; b < 256; b++) {
    if (!bs.includes(b)) {
      bs.push(b);
      cs.push(256 + n);
      n++;
    }
  }
  const table = new Array<string>(256);
  bs.forEach((b, i) => (table[b] = String.fromCodePoint(cs[i]!)));
  return table;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface GgufTokenizerInfo {
  model: string;
  pre: string;
  tokens: number;
  merges: number;
  specialTokens: number;
  bosTokenId: number | null;
  eosTokenId: number | null;
  addBosToken: boolean;
  /** sha256 of the record file the vocabulary was read from. */
  sourceSha256: string;
  sourceFile: string;
}

export class GgufBpeTokenizer {
  private readonly vocab = new Map<string, number>();
  private readonly ranks = new Map<string, number>();
  private readonly byteChar = byteToUnicode();
  private readonly charByte = new Map<string, number>();
  private readonly special = new Map<string, number>();
  private readonly specialSplit: RegExp | null;
  private readonly cache = new Map<string, number[]>();
  readonly info: GgufTokenizerInfo;
  readonly tokens: string[];

  private constructor(
    tokens: string[],
    merges: string[],
    types: number[] | null,
    info: Omit<GgufTokenizerInfo, "tokens" | "merges" | "specialTokens">,
  ) {
    this.tokens = tokens;
    tokens.forEach((t, i) => this.vocab.set(t, i));
    merges.forEach((m, i) => this.ranks.set(m, i));
    this.byteChar.forEach((c, b) => this.charByte.set(c, b));
    if (types) {
      types.forEach((ty, i) => {
        if (ty === TOKEN_TYPE.control || ty === TOKEN_TYPE.userDefined) this.special.set(tokens[i]!, i);
      });
    }
    const specials = [...this.special.keys()].sort((a, b) => b.length - a.length);
    this.specialSplit = specials.length ? new RegExp(`(${specials.map(escapeRegex).join("|")})`, "g") : null;
    this.info = { ...info, tokens: tokens.length, merges: merges.length, specialTokens: this.special.size };
  }

  /** Build from the JSON of `POST /api/show {"model", "verbose": true}` (`model_info.tokenizer.ggml.*`). */
  static fromShowJson(file: string = PILOT_MODEL_SHOW_FILE): GgufBpeTokenizer {
    const raw = fs.readFileSync(file);
    const sourceSha256 = createHash("sha256").update(raw).digest("hex");
    const record = JSON.parse(raw.toString("utf8")) as { model_info?: Record<string, unknown> };
    const mi = record.model_info ?? {};
    const model = String(mi["tokenizer.ggml.model"] ?? "");
    const pre = String(mi["tokenizer.ggml.pre"] ?? "");
    const tokens = mi["tokenizer.ggml.tokens"];
    const merges = mi["tokenizer.ggml.merges"];
    const types = mi["tokenizer.ggml.token_type"];
    if (model !== "gpt2") throw new Error(`pilot tokenizer: ${file}: tokenizer.ggml.model is "${model}", only byte-level BPE ("gpt2") is implemented`);
    if (pre !== "qwen35" && pre !== "qwen2") throw new Error(`pilot tokenizer: ${file}: tokenizer.ggml.pre is "${pre}", only the qwen35 / qwen2 pre-tokenizer is implemented`);
    if (!Array.isArray(tokens) || !Array.isArray(merges)) {
      throw new Error(`pilot tokenizer: ${file}: no tokenizer.ggml.tokens / merges — request /api/show with "verbose": true`);
    }
    return new GgufBpeTokenizer(tokens as string[], merges as string[], Array.isArray(types) ? (types as number[]) : null, {
      model,
      pre,
      bosTokenId: typeof mi["tokenizer.ggml.bos_token_id"] === "number" ? (mi["tokenizer.ggml.bos_token_id"] as number) : null,
      eosTokenId: typeof mi["tokenizer.ggml.eos_token_id"] === "number" ? (mi["tokenizer.ggml.eos_token_id"] as number) : null,
      addBosToken: mi["tokenizer.ggml.add_bos_token"] === true,
      sourceSha256,
      sourceFile: file,
    });
  }

  /** Token ids of `text`. Control and user-defined tokens written in the text are matched literally (`parseSpecial`), as llama.cpp's `parse_special` does. */
  encode(text: string, parseSpecial = true): number[] {
    const out: number[] = [];
    const pieces = parseSpecial && this.specialSplit ? text.split(this.specialSplit) : [text];
    for (const piece of pieces) {
      if (piece === "") continue;
      const sp = parseSpecial ? this.special.get(piece) : undefined;
      if (sp !== undefined) {
        out.push(sp);
        continue;
      }
      for (const m of piece.matchAll(QWEN35_PRE_TOKENIZER)) {
        for (const id of this.bpe(m[0])) out.push(id);
      }
    }
    return out;
  }

  count(text: string, parseSpecial = true): number {
    return this.encode(text, parseSpecial).length;
  }

  /** The text of `ids` (bytes decoded as UTF-8; a special token by its string). */
  decode(ids: number[]): string {
    const bytes: number[] = [];
    for (const id of ids) {
      const tok = this.tokens[id];
      if (tok === undefined) throw new Error(`pilot tokenizer: unknown token id ${id}`);
      if (this.special.has(tok)) {
        for (const b of Buffer.from(tok, "utf8")) bytes.push(b);
        continue;
      }
      for (const ch of tok) {
        const b = this.charByte.get(ch);
        if (b === undefined) throw new Error(`pilot tokenizer: token ${id} has a character outside the byte alphabet`);
        bytes.push(b);
      }
    }
    return Buffer.from(bytes).toString("utf8");
  }

  /** Byte-level BPE of one pre-token. */
  private bpe(word: string): number[] {
    const hit = this.cache.get(word);
    if (hit) return hit;
    let symbols: string[] = [];
    for (const b of Buffer.from(word, "utf8")) symbols.push(this.byteChar[b]!);
    while (symbols.length > 1) {
      let best = -1;
      let bestRank = Number.POSITIVE_INFINITY;
      for (let i = 0; i < symbols.length - 1; i++) {
        const rank = this.ranks.get(`${symbols[i]} ${symbols[i + 1]}`);
        if (rank !== undefined && rank < bestRank) {
          bestRank = rank;
          best = i;
        }
      }
      if (best < 0) break;
      const merged: string[] = [];
      const a = symbols[best]!;
      const b = symbols[best + 1]!;
      for (let i = 0; i < symbols.length; i++) {
        if (i < symbols.length - 1 && symbols[i] === a && symbols[i + 1] === b) {
          merged.push(a + b);
          i++;
        } else merged.push(symbols[i]!);
      }
      symbols = merged;
    }
    const ids = symbols.map((s) => {
      const id = this.vocab.get(s);
      if (id === undefined) throw new Error(`pilot tokenizer: no token for ${JSON.stringify(s)} in ${JSON.stringify(word)}`);
      return id;
    });
    if (this.cache.size > 100_000) this.cache.clear();
    this.cache.set(word, ids);
    return ids;
  }
}

/**
 * A `TokenCounter` over the model's tokenizer, loaded from the show record on first use.
 * `kind: "tokenizer"` marks every count in the run log; the record's sha256 is in `info()`.
 */
export function tokenizerCounter(file: string = PILOT_MODEL_SHOW_FILE): TokenCounter & { info(): GgufTokenizerInfo; tokenizer(): GgufBpeTokenizer } {
  let instance: GgufBpeTokenizer | undefined;
  const tokenizer = () => (instance ??= GgufBpeTokenizer.fromShowJson(file));
  return {
    kind: "tokenizer",
    count: (text) => tokenizer().count(text),
    info: () => tokenizer().info,
    tokenizer,
  };
}

/** Whether the frozen show record is present (the adapter then counts with the tokenizer, otherwise approximately). */
export function pilotModelRecordPresent(file: string = PILOT_MODEL_SHOW_FILE): boolean {
  return fs.existsSync(file);
}
