// Small helpers shared by every page module — deliberately plain functions,
// no framework: this whole frontend is served as-is with no build step.

export function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}

export function badge(text, cls) {
  return `<span class="badge ${cls}">${escapeHtml(text)}</span>`;
}

export async function api(path, options) {
  const res = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json" },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

export function formatDate(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString();
}

/** The single <main id="app"> mount point every page renders into. */
export const app = document.getElementById("app");

export function showError(message, problems) {
  const list = problems && problems.length ? `<ul class="plain">${problems.map((p) => `<li>${escapeHtml(p)}</li>`).join("")}</ul>` : "";
  app.insertAdjacentHTML("afterbegin", `<div class="error-banner">${escapeHtml(message)}${list}</div>`);
}

/** api() variant that keeps the server's `problems` list (config validation) on the thrown error. */
export async function apiDetailed(path, options) {
  const res = await fetch(path, { ...options, headers: { "Content-Type": "application/json" } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `Request failed (${res.status})`);
    err.problems = body.problems || [];
    throw err;
  }
  return body;
}

export function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function formatNumber(n) {
  return n === null || n === undefined ? "—" : Number(n).toLocaleString();
}

export function formatCost(usd) {
  if (usd === null || usd === undefined) return "—";
  return usd === 0 ? "$0" : `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}`;
}

export function formatDuration(ms) {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

/** Badge color per outcome category — task success vs. the different kinds of failure stay visually distinct. */
export function outcomeBadge(outcome, running) {
  if (running) return badge("RUNNING", "info");
  if (!outcome) return badge("—", "neutral");
  const cls =
    outcome === "SUCCESS"
      ? "ok"
      : ["MISSION_FAILURE", "CONSENSUS_FAILURE", "NO_PROPOSAL"].includes(outcome)
        ? "bad"
        : ["PROVIDER_ERROR", "ERROR", "INTERRUPTED", "STOPPED_BY_OPERATOR"].includes(outcome)
          ? "neutral"
          : "warn";
  return badge(outcome, cls);
}

export function phaseBadge(phase) {
  return badge(phase, phase === "FINISHED" ? "neutral" : "info");
}

/** Read/write a nested value by a dotted path like "agents.0.model.provider". */
export function getPath(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function setPath(obj, path, value) {
  const keys = path.split(".");
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (o[k] == null || typeof o[k] !== "object") o[k] = /^\d+$/.test(keys[i + 1]) ? [] : {};
    o = o[k];
  }
  o[keys[keys.length - 1]] = value;
}

export function jsonBlock(value) {
  return `<pre class="code">${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
}
