import { api, app, badge, escapeHtml, showError } from "../shared.js";

export async function renderHome() {
  app.innerHTML = `<div class="page-header"><h1>Overview</h1></div><div class="loading">Loading…</div>`;
  let meta;
  try {
    meta = await api("/api/meta");
  } catch (err) {
    app.innerHTML = "";
    showError(err.message);
    return;
  }

  const version = meta.testbedVersion;
  const providerRows = meta.providers
    .map(
      (p) => `<tr>
        <td>${escapeHtml(p.id)}</td>
        <td>${p.configured ? badge("configured", "ok") : badge("not configured", "neutral")}</td>
        <td class="muted">${p.gate ? `max ${p.gate.maxConcurrent} concurrent requests · ${p.gate.inFlight} in flight · ${p.gate.queued} queued` : escapeHtml(p.hint ?? "")}</td>
      </tr>`
    )
    .join("");

  app.innerHTML = `
    <div class="page-header"><h1>Overview</h1></div>
    <div class="card">
      <h2>LLM providers</h2>
      <table><thead><tr><th>Provider</th><th>Status</th><th></th></tr></thead><tbody>${providerRows}</tbody></table>
    </div>
    <div class="card">
      <h2>Testbed version</h2>
      <dl class="kv">
        <dt>Package</dt><dd>${escapeHtml(version.packageVersion)}</dd>
        <dt>Git commit</dt><dd>${escapeHtml(version.gitCommit ?? "not a git checkout")}${version.gitDirty ? ` ${badge("uncommitted changes", "warn")}` : ""}</dd>
        <dt>Node</dt><dd>${escapeHtml(version.nodeVersion)}</dd>
      </dl>
    </div>
  `;
}
