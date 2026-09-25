import { api, app, badge, escapeHtml, formatCost, formatDate, formatDuration, formatNumber, outcomeBadge, showError } from "../shared.js";

export async function renderExperiments() {
  app.innerHTML = `<div class="loading">Loading…</div>`;
  let experiments;
  try {
    ({ experiments } = await api("/api/experiments"));
  } catch (err) {
    app.innerHTML = "";
    showError(err.message);
    return;
  }

  const rows = experiments
    .map(
      (e) => `<tr class="link-row" data-href="#/experiments/${encodeURIComponent(e.id)}">
        <td class="muted">${escapeHtml(formatDate(e.createdAt))}</td>
        <td>${escapeHtml(e.name)}${e.conditionKey ? ` <span class="muted">· ${escapeHtml(e.conditionKey)}</span>` : ""}</td>
        <td>${outcomeBadge(e.outcome, e.running)}${e.intervened ? ` ${badge("manual", "warn")}` : ""}</td>
        <td>${formatNumber(e.turns)}</td>
        <td>${formatNumber(e.tokens)}</td>
        <td>${formatCost(e.costUsd)}</td>
        <td>${formatDuration(e.durationMs)}</td>
      </tr>`
    )
    .join("");

  app.innerHTML = `
    <div class="page-header"><h1>Experiments</h1></div>
    <div class="card overflow-x">
      ${
        experiments.length
          ? `<table><thead><tr><th>Started</th><th>Scenario</th><th>Outcome</th><th>Turns</th><th>Tokens</th><th>Cost</th><th>Duration</th></tr></thead><tbody>${rows}</tbody></table>`
          : `<div class="empty-state"><p>No experiments yet.</p><p>Open a <a href="#/scenarios">scenario</a> and press Run.</p></div>`
      }
    </div>
  `;
  app.querySelectorAll("tr.link-row").forEach((row) => row.addEventListener("click", () => (location.hash = row.dataset.href)));
}
