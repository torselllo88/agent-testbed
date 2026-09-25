import { api, apiDetailed, app, badge, escapeHtml, formatDate, jsonBlock, showError } from "../shared.js";

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
  ["$agents", '[["operations", "engineering", "power", "life_support"], ["operations", "engineering", "power"]]'],
];

export function batchStatusBadge(status) {
  return badge(status, status === "completed" ? "ok" : status === "running" ? "info" : status === "cancelled" ? "warn" : "neutral");
}

export async function renderBatches() {
  app.innerHTML = `<div class="loading">Loading…</div>`;
  let batches, scenarios, meta;
  try {
    [{ batches }, { scenarios }, meta] = await Promise.all([api("/api/batches"), api("/api/scenarios"), api("/api/meta")]);
  } catch (err) {
    app.innerHTML = "";
    showError(err.message);
    return;
  }

  const baseOptions = [
    ...scenarios.map((s) => `<option value="scenario:${escapeHtml(s.id)}">${escapeHtml(s.name)} (saved, v${s.version})</option>`),
    ...meta.builtinScenarios.map((b) => `<option value="builtin:${escapeHtml(b.id)}">${escapeHtml(b.name)} (template)</option>`),
  ].join("");

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
      <div class="grid-3">
        <label class="field"><span class="field-label">Name</span><input type="text" id="b-name" value="Batch ${new Date().toLocaleString()}" /></label>
        <label class="field"><span class="field-label">Base configuration</span><select id="b-base">${baseOptions}</select></label>
        <label class="field"><span class="field-label">Order</span>
          <select id="b-order"><option value="interleaved">interleaved (rep 1 of all conditions, then rep 2, …)</option><option value="sequential">sequential (condition by condition)</option></select></label>
      </div>
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
      <div class="actions">
        <button type="button" id="b-add-var">+ Add variable</button>
        <button type="button" id="b-preview">Preview</button>
        <button type="button" id="b-start" class="primary">Start batch</button>
      </div>
      <div id="b-preview-out"></div>
    </div>`;

  app.querySelectorAll("tr.link-row").forEach((row) => row.addEventListener("click", () => (location.hash = row.dataset.href)));

  const varsEl = document.getElementById("b-vars");
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
  });
  addVariable("scheduler.type", PATH_PRESETS[0][1], "scheduler");
  document.getElementById("b-add-var").addEventListener("click", () => addVariable());

  function buildSpec() {
    const [kind, id] = document.getElementById("b-base").value.split(/:(.*)/s);
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
    return {
      name: document.getElementById("b-name").value.trim() || "Batch",
      base: kind === "scenario" ? { scenarioId: id } : { builtin: id },
      variables,
      repetitions: Number(document.getElementById("b-reps").value),
      concurrency: Number(document.getElementById("b-conc").value),
      stubLatencyMs: Number(document.getElementById("b-latency").value),
      order: document.getElementById("b-order").value,
    };
  }

  const out = document.getElementById("b-preview-out");
  const problemsHtml = (problems) =>
    `<div class="error-banner">Batch cannot run:<ul class="plain">${problems.map((p) => `<li>${escapeHtml(p)}</li>`).join("")}</ul></div>`;

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
