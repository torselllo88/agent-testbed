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

export function showError(message) {
  app.insertAdjacentHTML("afterbegin", `<div class="error-banner">${escapeHtml(message)}</div>`);
}
