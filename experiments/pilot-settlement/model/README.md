# Pilot model record

The frozen record of the pilot model, as the plan's §4 step 1 and the freeze record
(§12) ask for: Ollama's `/api/show` answer for `qwen3.8:27b` on the pilot node.

| File | What it is |
|---|---|
| `show.json` | `POST /api/show {"model": "qwen3.8:27b"}` — license, modelfile, parameters, template, details, `model_info` (architecture, tokenizer settings without the vocabulary), projector info, tensors, capabilities |
| `show-verbose.json` | the same with `"verbose": true` — `model_info` additionally carries the vocabulary: `tokenizer.ggml.tokens` (248 320), `tokenizer.ggml.merges` (247 587), `tokenizer.ggml.token_type` |

Taken on 2026-11-17 from the Ollama server (version 0.33.2) on the pilot node. The only
edit: the two `FROM /home/<user>/.ollama/models/blobs/sha256-…` lines of the modelfile
had the account name of the node replaced by `<user>`. Original digests (sha256, before
the edit): `show.json` 06eee7526047ba517b2b354f990db0a786b5cca8eb7b4af75e420d966b520c70,
`show-verbose.json` b085967b46bfeaa838b7d882a3d7d53189f2c67f524757522b4bae751c1d20f1.

What the record says (the fields the plan relies on):

- model `qwen3.8:27b`, parent `qwen3.8:27b-q4_K_M`, GGUF, family `qwen35`, 27.3B
  parameters, quantization Q4_K_M, `general.version` 0814; `requires` Ollama 0.32.12;
  `modified_at` 2026-10-29.
- capabilities: `completion`, `vision`, `tools`, `thinking`. No thinking levels are
  listed (the plan's G2 fallback "a lower thinking level" is therefore not available
  from this record; `think` is on / off).
- model parameters (the Modelfile): temperature 1, top_k 20, top_p 0.95, min_p 0,
  presence_penalty 0, repeat_penalty 1, draft_num_predict 4 — the plan's sampling
  settings are the model's own defaults; the adapter sends them explicitly anyway.
- template `{{ .Prompt }}` with `RENDERER qwen3.8` and `PARSER qwen3.5`: the chat
  template is Ollama's built-in Go renderer, not a text template in the Modelfile, so
  it is not reproducible from this record alone. The relation between the testbed's
  count of the message contents and the server's `prompt_eval_count` is measured
  (plan §3.7, `prompt_count_rule`), not derived.
- context length of the model 262 144; the pilot runs with `num_ctx` 8192.
- tokenizer: byte-level BPE (`tokenizer.ggml.model` gpt2, `tokenizer.ggml.pre`
  qwen35), no BOS added, `<|endoftext|>` 248044 = BOS / pad, `<|im_end|>` 248046 =
  EOS; 27 control and 6 user-defined tokens (`<think>` 248068, `</think>` 248069
  among them). `src/scenarios/pilotSettlement/tokenizer.ts` rebuilds it from
  `show-verbose.json`; `tests/scenarios/pilotTokenizer.test.ts` checks it against
  the server's own counts.
