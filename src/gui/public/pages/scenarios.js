import { api, apiDetailed, app, badge, escapeHtml, formatDate, showError } from "../shared.js";

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

  const rows = scenarios
    .map(
      (s) => `<tr class="link-row" data-href="#/scenarios/${encodeURIComponent(s.id)}">
        <td><strong>${escapeHtml(s.name)}</strong></td>
        <td>v${s.version}</td>
        <td>${s.agents}</td>
        <td>${badge(s.scheduler, "neutral")} ${badge(s.consensus, "neutral")}</td>
        <td class="muted">${escapeHtml(formatDate(s.updatedAt))}</td>
      </tr>`
    )
    .join("");

  const builtinOptions = meta.builtinScenarios.map((b) => `<option value="${escapeHtml(b.id)}">${escapeHtml(b.name)}</option>`).join("");

  app.innerHTML = `
    <div class="page-header">
      <h1>Scenarios</h1>
      <div class="actions">
        <select id="builtin-select">${builtinOptions}</select>
        <button id="new-builtin" class="primary">New from template</button>
        <label class="button-like">Import JSON<input type="file" id="import-file" accept="application/json,.json" hidden /></label>
      </div>
    </div>
    <div class="card overflow-x">
      ${
        scenarios.length
          ? `<table><thead><tr><th>Name</th><th>Version</th><th>Agents</th><th>Protocol</th><th>Updated</th></tr></thead><tbody>${rows}</tbody></table>`
          : `<div class="empty-state"><p>No saved scenarios yet.</p><p>Create one from a template or import a config.</p></div>`
      }
    </div>
  `;

  app.querySelectorAll("tr.link-row").forEach((row) => row.addEventListener("click", () => (location.hash = row.dataset.href)));

  document.getElementById("new-builtin").addEventListener("click", async () => {
    try {
      const { scenario } = await api("/api/scenarios", {
        method: "POST",
        body: JSON.stringify({ builtin: document.getElementById("builtin-select").value }),
      });
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
