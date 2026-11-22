import { api, app, escapeHtml, formatCost, formatDate, showError } from "../shared.js";

/**
 * Live runs (#/research/runs): every live session of the research demo — an instance run as
 * Complete, then Ring, then the detector, on the demo's OpenRouter model — with its outcomes, the
 * detector's categories, the cost and the links to the two experiments and to the session's view.
 */
function stageBadge(s) {
  const map = { done: ["ok", "done"], failed: ["bad", "failed"], cancelled: ["neutral", "cancelled"], cancelling: ["warn", "cancelling"], complete: ["info", "running · Complete"], ring: ["info", "running · Ring"], detector: ["info", "running · detector"] };
  const [cls, label] = map[s.stage] ?? ["neutral", s.stage];
  return `<span class="badge ${cls}">${label}</span>`;
}
function runCell(r) {
  if (!r.experimentId) return `<span class="muted">—</span>`;
  const link = `<a href="#/experiments/${encodeURIComponent(r.experimentId)}">${r.status === "running" ? `turn ${r.turn} of 18` : r.outcome ?? r.status}</a>`;
  const exact = r.correct === null ? "" : r.correct ? ` <span class="badge ok">exact</span>` : ` <span class="badge bad">wrong</span>`;
  const watch = r.status === "running" ? ` <a href="#/watch/${encodeURIComponent(r.experimentId)}">watch</a>` : "";
  return `${link}${exact}${watch}${r.category ? `<div class="muted small">${escapeHtml(r.category)}</div>` : ""}`;
}

export async function renderResearchRuns() {
  app.innerHTML = `<div class="loading">Loading…</div>`;
  let data;
  try {
    data = await api("/api/pilot-demo/live");
  } catch (err) {
    app.innerHTML = "";
    showError(err.message);
    return;
  }
  const rows = data.sessions
    .map(
      (s) => `<tr>
        <td class="muted">${escapeHtml(formatDate(s.startedAt))}</td>
        <td><a href="#/research/${encodeURIComponent(s.instance)}${s.stage === "done" ? `/live/${encodeURIComponent(s.id)}` : ""}">${escapeHtml(s.instance)}</a><div class="muted small">${escapeHtml(s.models.agents)}</div></td>
        <td>${stageBadge(s)}${s.error ? `<div class="small">${escapeHtml(s.error)}</div>` : ""}</td>
        <td>${runCell(s.runs.complete)}</td>
        <td>${runCell(s.runs.ring)}</td>
        <td>${s.detector ? `${s.detector.done} of ${s.detector.messages}${s.detector.failures ? ` <span class="badge warn">${s.detector.failures} failed</span>` : ""}` : `<span class="muted">—</span>`}</td>
        <td>${s.cost ? `${formatCost(s.cost.totalUsd)}${s.cost.unknownCalls ? ` <span class="muted small">(+${s.cost.unknownCalls} unpriced)</span>` : ""}<div class="muted small">agents ${formatCost(s.cost.agentsUsd)} · detector ${formatCost(s.cost.detectorUsd)}</div>` : `<span class="muted">—</span>`}</td>
        <td>${s.finishedAt ? `${Math.round((new Date(s.finishedAt) - new Date(s.startedAt)) / 60000)} min` : `<span class="muted">…</span>`}</td>
      </tr>`
    )
    .join("");
  app.innerHTML = `
    <div class="page-header"><div><h1>Live runs</h1><p class="muted">Each session runs one dev instance as Complete, then Ring, then the detector, on ${data.available ? `${escapeHtml(data.agents)} via OpenRouter` : "the demo's model"}. Exploratory, n = 1 each; the <a href="#/research">replay</a> is the validated instrument.${data.estimateUsd !== null && data.estimateUsd !== undefined ? ` A session costs about ${formatCost(data.estimateUsd)}.` : ""}</p></div></div>
    <div class="card overflow-x">
      ${
        data.sessions.length
          ? `<table><thead><tr><th>Started</th><th>Instance · model</th><th>Stage</th><th>Complete</th><th>Ring</th><th>Detector</th><th>Cost</th><th>Duration</th></tr></thead><tbody>${rows}</tbody></table>`
          : `<div class="empty-state"><p>No live runs yet.</p><p>${data.available ? `Open an instance in the <a href="#/research">research demo</a> and press <em>Run this instance live</em>.` : "Live runs need an OpenRouter key on this server."}</p></div>`
      }
    </div>
    <p class="muted small">Each run is also an ordinary <a href="#/experiments">experiment</a>: the full trace, the operator view and the viewer are there; its proposal is judged against the instance's canonical outcome.</p>`;
}
