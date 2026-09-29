import { openRunDialog } from "../runDialog.js";
import { api, apiDetailed, app, badge, escapeHtml, formatDate, showError } from "../shared.js";

function card(s) {
  const tags = [
    s.readOnly ? badge("built-in", "info") : badge(`v${s.version}`, "neutral"),
    badge(`${s.agents} agents`, "neutral"),
    badge(s.language, "neutral"),
    s.narrated ? badge("narrated", "neutral") : "",
    s.paced ? badge("paced", "neutral") : "",
  ].join(" ");
  return `
    <div class="card scenario-card" data-id="${escapeHtml(s.id)}">
      <div class="scenario-card-head">
        <h3>${escapeHtml(s.name)}</h3>
        <div class="tags">${tags}</div>
      </div>
      <p class="muted">${escapeHtml(s.summary)}</p>
      ${s.agentNames.length ? `<p class="small">${escapeHtml(s.agentNames.join(" · "))}</p>` : ""}
      <div class="actions">
        <button type="button" class="primary" data-act="run">Run</button>
        <button type="button" data-act="edit">${s.readOnly ? "View" : "Edit"}</button>
        <button type="button" data-act="duplicate">Duplicate</button>
      </div>
      ${s.readOnly ? "" : `<p class="muted small">Updated ${escapeHtml(formatDate(s.updatedAt))}</p>`}
    </div>`;
}

export async function renderScenarios() {
  app.innerHTML = `<div class="loading">Loading…</div>`;
  let scenarios, meta;
  try {
    [{ scenarios }, meta] = await Promise.all([api("/api/scenarios"), api("/api/meta")]);
  } catch (err) {
    app.innerHTML = "";
    showError(err.message);
    return;
  }

  const builtins = scenarios.filter((s) => s.readOnly);
  const mine = scenarios.filter((s) => !s.readOnly);
  const templateOptions = builtins.map((b) => `<option value="${escapeHtml(b.id)}">${escapeHtml(b.name)}</option>`).join("");

  app.innerHTML = `
    <div class="page-header">
      <h1>Scenarios</h1>
      <div class="actions">
        <label class="button-like">Import JSON<input type="file" id="import-file" accept="application/json,.json" hidden /></label>
      </div>
    </div>
    <h2 class="section-title">Built-in</h2>
    <div class="card-grid">${builtins.map(card).join("") || `<p class="muted">No built-in scenarios.</p>`}</div>
    <h2 class="section-title">Your scenarios</h2>
    <div class="card-grid">
      ${mine.map(card).join("")}
      <div class="card scenario-card create-card">
        <h3>+ Create scenario</h3>
        <p class="muted">Start from a built-in and make it yours.</p>
        <div class="actions">
          <select id="create-from">${templateOptions}</select>
          <button type="button" id="create-btn">Create</button>
        </div>
      </div>
    </div>`;

  app.querySelectorAll(".scenario-card[data-id]").forEach((el) => {
    const scenario = scenarios.find((s) => s.id === el.dataset.id);
    el.querySelectorAll("[data-act]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        const act = btn.dataset.act;
        if (act === "run") return openRunDialog(scenario, meta);
        if (act === "edit") return void (location.hash = `#/scenarios/${encodeURIComponent(scenario.id)}`);
        try {
          const { scenario: copy } = await api(`/api/scenarios/${encodeURIComponent(scenario.id)}/duplicate`, { method: "POST", body: "{}" });
          location.hash = `#/scenarios/${encodeURIComponent(copy.id)}`;
        } catch (err) {
          showError(err.message);
        }
      })
    );
  });

  document.getElementById("create-btn")?.addEventListener("click", async () => {
    const id = document.getElementById("create-from").value;
    try {
      const { scenario } = await api(`/api/scenarios/${encodeURIComponent(id)}/duplicate`, { method: "POST", body: "{}" });
      location.hash = `#/scenarios/${encodeURIComponent(scenario.id)}`;
    } catch (err) {
      showError(err.message);
    }
  });

  document.getElementById("import-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      // Accept a bare config, a scenario export ({scenario: {config}}), or an experiment export ({experiment: {config}}).
      const config = parsed.scenario?.config ?? parsed.experiment?.config ?? parsed.config ?? parsed;
      const { scenario } = await apiDetailed("/api/scenarios", { method: "POST", body: JSON.stringify({ config }) });
      location.hash = `#/scenarios/${encodeURIComponent(scenario.id)}`;
    } catch (err) {
      showError(err instanceof SyntaxError ? `Not valid JSON: ${err.message}` : err.message, err.problems);
    }
  });
}
