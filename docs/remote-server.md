# Running on a remote server

How to run the testbed on a shared research machine — a GPU node reached over
SSH, without root, next to a model server someone already runs there — and
operate it from your own browser. The example uses an Ollama instance; any
[self-hosted endpoint](configuration.md#self-hosted-models-openai-compatible-endpoints)
works the same way.

## What the machine needs

| | |
|---|---|
| Node ≥ 22.13 | installed in your home directory, no root needed (below) |
| git | to get the code |
| the model server | reachable from the node, e.g. Ollama on `localhost:11434`. Use the instance that already runs; do not start your own on a shared GPU |
| a local disk for the database | **not** a network or parallel file system (NFS, Lustre, …): SQLite's WAL mode needs shared memory and file locks those do not reliably provide. `/tmp` or a node-local scratch directory |

Python, Docker and tmux are not needed.

## Install

Node, from the official binaries (needs glibc ≥ 2.28 — check with
`ldd --version`; on an older system use a `glibc-217` build from
unofficial-builds.nodejs.org):

```bash
mkdir -p ~/opt && cd ~/opt
NODE_TAR=$(curl -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt | awk '/linux-x64.tar.xz/ {print $2}')
curl -fsSLO "https://nodejs.org/dist/latest-v24.x/$NODE_TAR"
tar -xJf "$NODE_TAR" && ln -sfn "$HOME/opt/${NODE_TAR%.tar.xz}" "$HOME/opt/node"
echo 'export PATH="$HOME/opt/node/bin:$PATH"' >> ~/.bashrc
export PATH="$HOME/opt/node/bin:$PATH"
node --version
```

The testbed (the code may live on the shared file system; only the database
must not):

```bash
cd ~/socio            # or wherever your group keeps shared work
git clone <repository-url> agent-testbed && cd agent-testbed
npm ci
cp .env.example .env
```

`.env`:

```bash
OPENAI_COMPATIBLE_ENDPOINTS=lab-ollama
OPENAI_COMPATIBLE_LAB_OLLAMA_BASE_URL=http://localhost:11434
OPENAI_COMPATIBLE_LAB_OLLAMA_API=ollama
# The server answers one request at a time (OLLAMA_NUM_PARALLEL=1): queue here, not there.
OPENAI_COMPATIBLE_LAB_OLLAMA_MAX_CONCURRENT=1

DATA_DIR=/tmp/<user>/testbed-data
GUI_PORT=39391          # a free, unusual port: others use this machine too
OPERATOR_TOKEN=<a long random value>
```

`OPERATOR_TOKEN` matters even though the server listens on `127.0.0.1` only:
everyone logged in to the same machine can reach its loopback ports.
`/tmp` may be cleaned: copy results somewhere durable after each batch (below).

## Before a run

The GPU is shared and nothing reserves it, so check it first:

```bash
nvidia-smi                                        # free memory: the model plus its context window must fit
curl -s localhost:11434/api/tags | grep -o '"name":"[^"]*"'   # the model is pulled
curl -s localhost:11434/api/ps                    # what is loaded right now
```

One request with the exact settings the runs will use — thinking off, the
context window, the schema:

```bash
curl -s localhost:11434/api/chat -d '{
  "model": "qwen3.8:27b", "stream": false, "think": false,
  "options": { "num_ctx": 8192, "temperature": 0, "seed": 1 },
  "format": { "type": "object", "properties": { "ok": { "type": "boolean" } }, "required": ["ok"] },
  "messages": [{ "role": "user", "content": "Answer with ok = true." }]
}'
```

Expect `"content":"{\"ok\":true}"` (or similar) and no `"thinking"` field.
Then `curl -s localhost:11434/api/ps`: `size_vram` must equal `size`. If it
is smaller, part of the model is in CPU memory — every call is far slower,
and the answers are not numerically the same as on the GPU alone. Either the
window is too large for the model (a smaller window or a smaller model), or
someone else's job holds GPU memory (`nvidia-smi` lists the processes):
wait until it finishes. Ollama does not move a loaded model back to the GPU
when memory frees up; it stays split until it is unloaded (after the
keep-alive, or `curl -s localhost:11434/api/generate -d '{"model":"<model>","keep_alive":0}'`
— which unloads it for everyone using that server, so agree on it first).
The testbed records this for every call anyway (below).

## Run headless (CLI)

A batch runs to the end without anyone watching; `nohup` keeps it alive after
you log out:

```bash
mkdir -p ~/socio/testbed/results ~/socio/testbed/logs
nohup npm run batch -- examples/service-settlement-smoke.batch.json \
  --csv ~/socio/testbed/results/smoke.csv --out ~/socio/testbed/results/smoke.json \
  > ~/socio/testbed/logs/smoke.log 2>&1 &
tail -f ~/socio/testbed/logs/smoke.log
```

The spec names the endpoint and the model with every serving option
(`think`, `contextLength`, `temperature`, `seed`, `maxOutputTokens`); edit the
model name there. A process that dies mid-run is closed as `INTERRUPTED` the
next time the testbed starts — nothing stays half-open.

## Operate it from your browser (web UI over SSH)

On the server, start the UI in the background — `npm run gui`, not
`npm start` (that reinstalls the dependencies on every start):

```bash
nohup npm run gui > ~/socio/testbed/logs/server.log 2>&1 &
```

On your own machine (Linux, macOS, or Windows PowerShell with the built-in
OpenSSH), forward a local port to it:

```bash
ssh -N -L 3939:localhost:39391 <user>@<server>        # add -J <user>@<jump-host> if you go through one
```

Open `http://localhost:3939` — any user name, `OPERATOR_TOKEN` as the
password. The tunnel only carries your browser's traffic; close it any time,
the server keeps running. CLI batches and the UI may use the same database
at once (the same `DATA_DIR`).

To run a scenario on the server's model from the UI: **Run** → **Models** →
provider `lab-ollama`, the model, **Thinking: off**, **Context window**:
`8192`. Temperature, seed and the output cap come from the scenario.

Stop your server (only yours — others run processes too):

```bash
pkill -u "$USER" -f src/server/main.ts
```

## Checking a smoke run

On the run's page, or in the CSV:

| What | Where | Expect |
|---|---|---|
| it ran end to end | Outcome | a decision outcome (`SUCCESS` / `MISSION_FAILURE` / `CONSENSUS_FAILURE`), not `PROVIDER_ERROR` or `ERROR` |
| prompts fit the window | LLM calls; CSV `context_overflow_suspected` | no "may exceed the context window" warning; `0` |
| thinking is off | LLM calls; CSV `calls_with_thinking` | no "with thinking"; `0` |
| the model was fully on the GPU | LLM calls; CSV `calls_partial_gpu_offload`, `min_gpu_fraction`; batch page warning | no "partly on CPU"; `0` and `1`. Runs with offloaded calls are not comparable to the others — leave them out or repeat them |
| placement was known | LLM calls; CSV `calls_serving_unknown` | `0`; otherwise see `providerMeta.servingUnknown` in the trace |
| answers parse | LLM calls; Protocol incidents | no or very few unparseable responses |
| settings reached the server | **Event trace** (bottom of the page), filter `llm_call`, click a row | `think: false`, `contextLength`, `seed`, `temperature` as configured; `servedModel` as requested |
| time per call | Event trace → `llm_call` → `providerMeta.durationsMs` | `load` large only on the first call (a cold model); `total` × calls per run ≈ run time — the basis for planning a batch |

## Keeping results

Batch CSV and JSON go wherever `--csv` / `--out` point. The database itself:
stop the server and running batches, then copy the whole `DATA_DIR`
(`db/testbed.sqlite3` with its `-wal` and `-shm` files) to durable storage; a single run's full
trace can also be downloaded from its page (**Export JSON**) or
`GET /api/experiments/:id/export`.
