import { api, app, escapeHtml, formatCost, formatDuration, formatNumber, jsonBlock, outcomeBadge, showError } from "../shared.js";
import { batchStatusBadge } from "./batches.js";

const POLL_MS = 1500;

const pct = (x) => (x === null || x === undefined ? "—" : `${Math.round(x * 100)}%`);
const med = (s) => (s && s.median !== null ? formatNumber(Math.round(s.median)) : "—");

function aggregateRow(a, total) {
  const ci = a.successRateCI95 ? `<span class="muted small"> [${pct(a.successRateCI95[0])}–${pct(a.successRateCI95[1])}]</span>` : "";
  const outcomes = Object.entries(a.outcomes)
    .map(([o, n]) => `${outcomeBadge(o)} ${n}`)
    .join(" ");
  return `<tr>
    <td><code>${escapeHtml(a.key)}</code></td>
    <td>${a.finished}${total !== undefined ? ` / ${total}` : ""}</td>
    <td>${a.excluded.total ? Object.entries(a.excluded.byOutcome).map(([o, n]) => `${outcomeBadge(o)} ${n}`).join(" ") : "0"}</td>
    <td><strong>${pct(a.successRate)}</strong>${ci}<div class="muted small">of ${a.evaluable}</div></td>
    <td>${pct(a.consensusRate)}</td>
    <td>${outcomes || "—"}</td>
    <td>${med(a.tokens.total)} <span class="muted small">(${med(a.tokens.agent)} + ${med(a.tokens.orchestration)})</span></td>
    <td>${med(a.turns)}</td>
    <td>${a.durationMs.median !== null ? formatDuration(a.durationMs.median) : "—"}</td>
    <td>${formatCost(a.costUsd.total)}</td>
  </tr>`;
}

export async function renderBatch(batchId) {
  const route = location.hash;
  app.innerHTML = `<div class="loading">Loading…</div>`;

  async function load() {
    const [view, { experiments }] = await Promise.all([
      api(`/api/batches/${encodeURIComponent(batchId)}`),
      api(`/api/experiments?batchId=${encodeURIComponent(batchId)}&limit=2000`),
    ]);
    return { view, experiments };
  }

  function render({ view, experiments }) {
    const { batch, progress, aggregates, overall } = view;
    const spec = batch.resolved.spec;
    const done = progress.finished / Math.max(1, progress.total);
    const running = batch.status === "running";
    const perCondition = spec.repetitions;

    const runRows = experiments
      .slice()
      .sort((a, b) => (a.conditionKey ?? "").localeCompare(b.conditionKey ?? "") || (a.createdAt < b.createdAt ? -1 : 1))
      .map(
        (e) => `<tr class="link-row" data-href="#/experiments/${encodeURIComponent(e.id)}">
          <td><code class="small">${escapeHtml(e.conditionKey ?? "")}</code></td>
          <td>${outcomeBadge(e.outcome, e.running)}</td>
          <td>${formatNumber(e.turns)}</td><td>${formatNumber(e.tokens)}</td><td>${formatDuration(e.durationMs)}</td><td>${formatCost(e.costUsd)}</td>
        </tr>`
      )
      .join("");

    app.innerHTML = `
      <div class="breadcrumb"><a href="#/batches">Batches</a> / ${escapeHtml(batch.name)}</div>
      <div class="page-header">
        <h1>${escapeHtml(batch.name)} ${batchStatusBadge(batch.status)}</h1>
        <div class="actions">
          ${running ? `<button id="btn-cancel" class="danger">Cancel batch</button>` : ""}
          <a class="button-like" href="/api/batches/${encodeURIComponent(batchId)}/export?format=csv">Export CSV</a>
          <a class="button-like" href="/api/batches/${encodeURIComponent(batchId)}/export">Export JSON</a>
        </div>
      </div>
      <div class="card">
        <div class="progress"><div class="progress-bar" style="width:${Math.round(done * 100)}%"></div></div>
        <p class="muted small">${progress.finished} of ${progress.total} runs finished · ${progress.running} running · ${progress.pending} pending ·
          ${aggregates.length} condition(s) × ${spec.repetitions} · concurrency ${spec.concurrency} · stub latency ${spec.stubLatencyMs} ms · ${escapeHtml(spec.order)} order
          ${batch.resolved.scenarioId ? ` · base scenario v${batch.resolved.scenarioVersion}` : ""}</p>
      </div>
      <div class="card overflow-x">
        <h2>Results by condition</h2>
        ${
          overall.providerErrors
            ? `<div class="warning-banner">${overall.providerErrors} run(s) ended in PROVIDER_ERROR and are excluded from the success and consensus rates — this reflects provider instability, not coordination. Check it before comparing conditions.</div>`
            : ""
        }
        <p class="muted small">Success and consensus rates are computed over evaluable runs only; excluded runs (provider errors, internal errors, interruptions, operator stops) are listed in their own column. Brackets: 95% Wilson interval. Tokens: median total (agent + orchestration).</p>
        <table>
          <thead><tr><th>Condition</th><th>Runs</th><th>Excluded</th><th>Success</th><th>Consensus</th><th>Outcomes</th><th>Tokens (median)</th><th>Turns (median)</th><th>Duration (median)</th><th>Cost</th></tr></thead>
          <tbody>${aggregates.map((a) => aggregateRow(a, perCondition)).join("")}</tbody>
          <tfoot>${aggregateRow(overall, progress.total)}</tfoot>
        </table>
      </div>
      <details class="card"><summary><h2>Runs (${experiments.length})</h2></summary>
        <div class="overflow-x"><table><thead><tr><th>Condition</th><th>Outcome</th><th>Turns</th><th>Tokens</th><th>Duration</th><th>Cost</th></tr></thead><tbody>${runRows}</tbody></table></div>
      </details>
      <details class="card"><summary><h2>Spec</h2></summary>${jsonBlock(spec)}</details>`;

    app.querySelectorAll("tr.link-row").forEach((row) => row.addEventListener("click", () => (location.hash = row.dataset.href)));
    document.getElementById("btn-cancel")?.addEventListener("click", async () => {
      if (!confirm("Cancel this batch? Running experiments are stopped; pending ones never start.")) return;
      try {
        await api(`/api/batches/${encodeURIComponent(batchId)}/cancel`, { method: "POST", body: "{}" });
      } catch (err) {
        showError(err.message);
      }
    });
    return running;
  }

  async function tick() {
    if (location.hash !== route) return;
    try {
      const data = await load();
      if (location.hash !== route) return;
      const openDetails = [...app.querySelectorAll("details")].map((d) => d.open);
      const running = render(data);
      app.querySelectorAll("details").forEach((d, i) => (d.open = openDetails[i] ?? false));
      if (running) setTimeout(tick, POLL_MS);
    } catch (err) {
      app.innerHTML = "";
      showError(err.message);
    }
  }
  await tick();
}
