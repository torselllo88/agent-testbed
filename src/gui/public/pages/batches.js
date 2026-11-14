import {
  bindChoiceFields,
  choiceFieldsHtml,
  defaultProvider,
  endpointNames,
  fillEndpointLists,
  loadOpenRouterCatalog,
  openRouterOptions,
  providerOptions,
  readChoice,
} from "../modelChoice.js";
import { api, apiDetailed, app, badge, downloadJson, escapeHtml, formatDate, jsonBlock, showError } from "../shared.js";

const PATH_PRESETS = [
  ["scheduler.type", '["round_robin", "hybrid"]'],
  ["consensus.rule", '["unanimity", "majority"]'],
  ["agents.*.model.model", '["anthropic/claude-sonnet-5", "openai/gpt-5.5"]'],
  ["agents.*.model.provider", '["openrouter", "stub"]'],
  ["agents.*.model.temperature", "[0, 0.7]"],
  ["limits.discussionTurnLimit", "[12, 24]"],
  ["limits.agentTokenLimit", "[20000, null]"],
  ["agentVisibility.discussionBudget", "[false, true]"],
  ["decision.maxProposalAttempts", "[1, 2]"],
  ["discussion.fixedRounds", "[2, 3]"],
  ["communication", '[{"topology": {"type": "complete"}}, {"topology": {"type": "ring"}}]'],
  ["randomization", '[{"seed": 1}, {"seed": 2}, {"seed": 3}]'],
  ["consensus", '[{"rule": "none"}]'],
  ["scheduler", '[{"type": "round_robin"}]'],
  ["$instance", '["dev-01"]'], // task instances of the base scenario's family (or inline { "id", "params", "seed" })
  ["$models", ""], // one model for every agent — the "Models" panel below fills it in
  ["$solo", '["full", "public"]'], // calibration: the proposer alone, with every agent's information or only its own
  ["$agents", '[["agent_a", "agent_b", "agent_c"], ["agent_a", "agent_b"]]'], // replace with the base scenario's agent ids
];

const LISTS = { stubList: "b-stub-models", openRouterList: "b-openrouter-models", endpointPrefix: "b-compat-models-" };

export function batchStatusBadge(status) {
  return badge(status, status === "completed" ? "ok" : status === "running" ? "info" : status === "cancelled" ? "warn" : "neutral");
}

export async function renderBatches() {
  app.innerHTML = `<div class="loading">Loading…</div>`;
  let batches, scenarios, meta, specs;
  try {
    [{ batches }, { scenarios }, meta, { specs }] = await Promise.all([
      api("/api/batches"),
      api("/api/scenarios"),
      api("/api/meta"),
      api("/api/batch-specs").catch(() => ({ specs: [] })),
    ]);
  } catch (err) {
    app.innerHTML = "";
    showError(err.message);
    return;
  }

  const baseOptions = [
    ...scenarios.map((s) => `<option value="scenario:${escapeHtml(s.id)}">${escapeHtml(s.name)} (saved, v${s.version})</option>`),
    ...meta.builtinScenarios.map((b) => `<option value="builtin:${escapeHtml(b.id)}">${escapeHtml(b.name)} (template)</option>`),
  ].join("");

  const specOptions = specs
    .map((s) => `<option value="${escapeHtml(s.id)}" ${s.error ? "disabled" : ""}>${escapeHtml(s.id)}${s.name ? ` — ${escapeHtml(s.name)}` : ""}${s.error ? " (invalid JSON)" : ""}</option>`)
    .join("");

  const rows = batches
    .map(
      (b) => `<tr class="link-row" data-href="#/batches/${encodeURIComponent(b.id)}">
        <td class="muted">${escapeHtml(formatDate(b.createdAt))}</td>
        <td>${escapeHtml(b.name)}</td>
        <td>${batchStatusBadge(b.status)}</td>
        <td>${b.progress.finished} / ${b.progress.total}</td>
        <td>${b.conditions} × ${b.repetitions}</td>
      </tr>`
    )
    .join("");

  app.innerHTML = `
    <div class="page-header"><h1>Batches</h1></div>
    <div class="card overflow-x">
      ${
        batches.length
          ? `<table><thead><tr><th>Created</th><th>Name</th><th>Status</th><th>Runs</th><th>Conditions × reps</th></tr></thead><tbody>${rows}</tbody></table>`
          : `<div class="empty-state"><p>No batches yet.</p></div>`
      }
    </div>

    <div class="card" id="new-batch">
      <h2>New batch</h2>
      <div class="grid-2">
        <label class="field"><span class="field-label">Start from a spec file</span>
          <select id="b-spec"><option value="">— an empty form —</option>${specOptions}</select>
          <span class="field-hint" id="b-spec-hint">${specs.length ? "*.batch.json in specs/ and examples/ on the server" : "no *.batch.json in specs/ or examples/"}</span></label>
        <div class="field"><span class="field-label">&nbsp;</span>
          <div class="actions"><button type="button" id="b-spec-load">Load into the form</button></div></div>
      </div>
      <details class="advanced"><summary>Import a spec as JSON</summary>
        <textarea id="b-import" rows="8" placeholder='{ "name": "…", "base": { "builtin": "service-settlement" }, "variables": [ … ], "repetitions": 1 }'></textarea>
        <div class="actions"><button type="button" id="b-import-apply">Load into the form</button></div>
      </details>
      <hr />
      <div class="grid-3">
        <label class="field"><span class="field-label">Name</span><input type="text" id="b-name" value="Batch ${new Date().toLocaleString()}" /></label>
        <label class="field"><span class="field-label">Base configuration</span><select id="b-base">${baseOptions}</select></label>
        <label class="field"><span class="field-label">Order</span>
          <select id="b-order"><option value="interleaved">interleaved (rep 1 of all conditions, then rep 2, …)</option><option value="sequential">sequential (condition by condition)</option></select></label>
      </div>
      <label class="field"><span class="field-label">Description</span><input type="text" id="b-description" placeholder="optional — what this batch is for" /></label>
      <div class="grid-3">
        <label class="field"><span class="field-label">Repetitions per condition</span><input type="number" id="b-reps" min="1" value="5" /></label>
        <label class="field"><span class="field-label">Concurrency</span><input type="number" id="b-conc" min="1" max="16" value="1" />
          <span class="field-hint">parallel runs — mind provider rate limits</span></label>
        <label class="field"><span class="field-label">Stub latency (ms)</span><input type="number" id="b-latency" min="0" value="0" />
          <span class="field-hint">0 = as fast as possible; set only if latency is itself a variable</span></label>
      </div>
      <h3>Variables <span class="muted small">(conditions = every combination of values)</span></h3>
      <div id="b-vars"></div>
      <datalist id="path-presets">${PATH_PRESETS.map(([p]) => `<option value="${escapeHtml(p)}">`).join("")}</datalist>
      <details class="advanced" id="b-models"><summary>Models for all agents — adds a value to <code>$models</code></summary>
        <div class="grid-2">${choiceFieldsHtml("b-model", { provider: defaultProvider(meta), model: "" }, LISTS, providerOptions(meta))}</div>
        <p class="muted small">Like the run dialog's Models: provider, model and (self-hosted) thinking and context window. Temperature, seed and the output cap stay the scenario's. Add several to compare models.</p>
        <div class="actions"><button type="button" id="b-model-add">Add to $models</button></div>
      </details>
      <datalist id="b-stub-models">${meta.stubModels.map((m) => `<option value="${escapeHtml(m)}">`).join("")}</datalist>
      <datalist id="b-openrouter-models"></datalist>
      ${endpointNames(meta).map((name) => `<datalist id="b-compat-models-${escapeHtml(name)}"></datalist>`).join("")}
      <div class="actions">
        <button type="button" id="b-add-var">+ Add variable</button>
        <button type="button" id="b-preview">Preview</button>
        <button type="button" id="b-download">Download spec JSON</button>
        <button type="button" id="b-start" class="primary">Start batch</button>
      </div>
      <div id="b-preview-out"></div>
    </div>`;

  app.querySelectorAll("tr.link-row").forEach((row) => row.addEventListener("click", () => (location.hash = row.dataset.href)));

  const card = document.getElementById("new-batch");
  const varsEl = document.getElementById("b-vars");
  const out = document.getElementById("b-preview-out");
  const problemsHtml = (problems) =>
    `<div class="error-banner">Batch cannot run:<ul class="plain">${problems.map((p) => `<li>${escapeHtml(p)}</li>`).join("")}</ul></div>`;

  function addVariable(path = "", values = "", label = "") {
    varsEl.insertAdjacentHTML(
      "beforeend",
      `<div class="grid-var var-row">
        <label class="field"><span class="field-label">Config path</span><input type="text" class="v-path" list="path-presets" value="${escapeHtml(path)}" placeholder="e.g. scheduler.type" /></label>
        <label class="field"><span class="field-label">Label</span><input type="text" class="v-label" value="${escapeHtml(label)}" placeholder="optional" /></label>
        <label class="field"><span class="field-label">Values (JSON array)</span><input type="text" class="v-values" value="${escapeHtml(values)}" /></label>
        <button type="button" class="danger v-remove">Remove</button>
      </div>`
    );
    return varsEl.lastElementChild;
  }
  varsEl.addEventListener("click", (e) => {
    if (e.target.classList.contains("v-remove")) e.target.closest(".var-row").remove();
  });
  varsEl.addEventListener("change", (e) => {
    // Picking a preset path pre-fills example values.
    if (!e.target.classList.contains("v-path")) return;
    const row = e.target.closest(".var-row");
    const preset = PATH_PRESETS.find(([p]) => p === e.target.value);
    const values = row.querySelector(".v-values");
    if (preset && !values.value) values.value = preset[1];
    if (e.target.value === "$models") document.getElementById("b-models").open = true;
  });
  addVariable("scheduler.type", PATH_PRESETS[0][1], "scheduler");
  document.getElementById("b-add-var").addEventListener("click", () => addVariable());

  // A base given inline in a spec ({ "config": … }) has no entry in the list: it gets one while the form holds it.
  let inlineBase = null;
  const baseSelect = document.getElementById("b-base");
  function setBase(base) {
    baseSelect.querySelector('option[value="inline:"]')?.remove();
    inlineBase = null;
    let value = null;
    if (base?.scenarioId) value = `scenario:${base.scenarioId}`;
    else if (base?.builtin) value = `builtin:${base.builtin}`;
    else if (base && "config" in base) {
      inlineBase = base.config;
      baseSelect.insertAdjacentHTML("afterbegin", `<option value="inline:">${escapeHtml(base.config?.name ?? "config")} (inline, from the spec)</option>`);
      value = "inline:";
    }
    if (value && !baseSelect.querySelector(`option[value="${CSS.escape(value)}"]`)) {
      throw new Error(`The spec's base (${value}) is not available here — pick one from the list`);
    }
    if (value) baseSelect.value = value;
  }

  /** Puts a spec into the form — every field the form has; the spec's other fields (e.g. headless) keep their defaults. */
  function fillForm(spec) {
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new Error("A spec is a JSON object");
    const set = (id, value) => {
      if (value !== undefined && value !== null) document.getElementById(id).value = value;
    };
    set("b-name", spec.name);
    set("b-description", spec.description ?? "");
    set("b-reps", spec.repetitions);
    set("b-conc", spec.concurrency ?? 1);
    set("b-latency", spec.stubLatencyMs ?? 0);
    set("b-order", spec.order ?? "interleaved");
    setBase(spec.base);
    varsEl.innerHTML = "";
    for (const v of spec.variables ?? []) addVariable(v.path ?? "", JSON.stringify(v.values ?? []), v.label ?? "");
    out.innerHTML = `<div class="success-banner">Loaded — check it, then Preview or Start.</div>`;
  }

  function buildSpec() {
    const [kind, id] = baseSelect.value.split(/:(.*)/s);
    const variables = [...varsEl.querySelectorAll(".var-row")]
      .map((row) => {
        const path = row.querySelector(".v-path").value.trim();
        const label = row.querySelector(".v-label").value.trim();
        const raw = row.querySelector(".v-values").value.trim();
        if (!path) return null;
        let values;
        try {
          values = JSON.parse(raw);
        } catch {
          throw new Error(`Values for "${path}" are not valid JSON (expected an array, e.g. ["a", "b"])`);
        }
        if (!Array.isArray(values)) throw new Error(`Values for "${path}" must be a JSON array`);
        return { path, values, ...(label ? { label } : {}) };
      })
      .filter(Boolean);
    const description = document.getElementById("b-description").value.trim();
    return {
      name: document.getElementById("b-name").value.trim() || "Batch",
      ...(description ? { description } : {}),
      base: kind === "scenario" ? { scenarioId: id } : kind === "inline" ? { config: inlineBase } : { builtin: id },
      variables,
      repetitions: Number(document.getElementById("b-reps").value),
      concurrency: Number(document.getElementById("b-conc").value),
      stubLatencyMs: Number(document.getElementById("b-latency").value),
      order: document.getElementById("b-order").value,
    };
  }

  // Spec files on the server, and pasted JSON.
  const specSelect = document.getElementById("b-spec");
  const specHint = document.getElementById("b-spec-hint");
  specSelect.addEventListener("change", () => {
    const entry = specs.find((s) => s.id === specSelect.value);
    specHint.textContent = entry ? (entry.description ?? entry.name ?? entry.id) : "*.batch.json in specs/ and examples/ on the server";
  });
  document.getElementById("b-spec-load").addEventListener("click", async () => {
    if (!specSelect.value) return;
    try {
      const { spec } = await api(`/api/batch-specs?id=${encodeURIComponent(specSelect.value)}`);
      fillForm(spec);
    } catch (err) {
      out.innerHTML = problemsHtml([err.message]);
    }
  });
  document.getElementById("b-import-apply").addEventListener("click", () => {
    try {
      fillForm(JSON.parse(document.getElementById("b-import").value));
    } catch (err) {
      out.innerHTML = problemsHtml([`Import: ${err.message}`]);
    }
  });
  document.getElementById("b-download").addEventListener("click", () => {
    try {
      const spec = buildSpec();
      const file = `${spec.name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "batch"}.batch.json`;
      downloadJson(file, spec);
    } catch (err) {
      out.innerHTML = problemsHtml([err.message]);
    }
  });

  // Models for all agents: each choice becomes one value of the $models variable.
  bindChoiceFields(card, "b-model", LISTS);
  fillEndpointLists(card, meta, LISTS.endpointPrefix);
  let catalog = null;
  loadOpenRouterCatalog().then((c) => {
    catalog = c;
    document.getElementById("b-openrouter-models").innerHTML = openRouterOptions(c.models);
  });
  document.getElementById("b-model-add").addEventListener("click", () => {
    const choice = readChoice(card, "b-model", catalog);
    if (!choice) {
      out.innerHTML = problemsHtml(["Choose a provider and enter a model first"]);
      return;
    }
    let row = [...varsEl.querySelectorAll(".var-row")].find((r) => r.querySelector(".v-path").value.trim() === "$models");
    if (!row) row = addVariable("$models", "[]", "model");
    const input = row.querySelector(".v-values");
    let values = [];
    try {
      values = JSON.parse(input.value || "[]");
    } catch {
      values = [];
    }
    if (!Array.isArray(values)) values = [];
    if (!values.some((v) => JSON.stringify(v) === JSON.stringify(choice))) values.push(choice);
    input.value = JSON.stringify(values);
    out.innerHTML = `<div class="success-banner">$models now has ${values.length} value(s).</div>`;
  });

  document.getElementById("b-preview").addEventListener("click", async () => {
    try {
      const spec = buildSpec();
      const result = await api("/api/batches/preview", { method: "POST", body: JSON.stringify({ spec }) });
      out.innerHTML = result.ok
        ? `<div class="success-banner">${result.conditions.length} condition(s) × ${spec.repetitions} = <strong>${result.totalRuns} runs</strong></div>
           <ul class="plain">${result.conditions.map((c) => `<li><code>${escapeHtml(c.key)}</code></li>`).join("")}</ul>
           <details><summary class="muted small">Spec JSON (usable with npm run batch)</summary>${jsonBlock(spec)}</details>`
        : problemsHtml(result.problems);
    } catch (err) {
      out.innerHTML = problemsHtml([err.message]);
    }
  });

  document.getElementById("b-start").addEventListener("click", async () => {
    try {
      const { batch } = await apiDetailed("/api/batches", { method: "POST", body: JSON.stringify({ spec: buildSpec() }) });
      location.hash = `#/batches/${encodeURIComponent(batch.id)}`;
    } catch (err) {
      out.innerHTML = problemsHtml(err.problems?.length ? err.problems : [err.message]);
    }
  });
}
