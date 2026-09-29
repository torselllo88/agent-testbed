import { apiDetailed, escapeHtml } from "./shared.js";

/**
 * "Run <scenario>" dialog: per-run overrides (currently the conversation
 * language) that apply to this run only — the saved scenario is not edited
 * or versioned. Resolves once the run has started (navigating to the control
 * view or the viewer), or when cancelled.
 */
export function openRunDialog(scenario, meta) {
  const suggested = [...new Set([scenario.language, ...scenario.presentationLanguages, ...meta.languages.suggested])];
  const label = (code) => {
    const authored = scenario.presentationLanguages.map((l) => l.toLowerCase()).includes(code.toLowerCase());
    return `${code}${code === scenario.language ? " — scenario default" : ""}${scenario.narrated ? (authored ? "" : " — narration falls back") : ""}`;
  };

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="run-dialog-title">
      <h2 id="run-dialog-title">Run ${escapeHtml(scenario.name)}</h2>
      <label class="field"><span class="field-label">Conversation language</span>
        <select id="rd-language">
          ${suggested.map((c) => `<option value="${escapeHtml(c)}" ${c === scenario.language ? "selected" : ""}>${escapeHtml(label(c))}</option>`).join("")}
          <option value="__other">Other…</option>
        </select>
      </label>
      <label class="field" id="rd-other-wrap" hidden><span class="field-label">Language code</span>
        <input type="text" id="rd-other" placeholder="e.g. de, pt-BR, sr-Cyrl" /></label>
      <p class="muted small">Applies to this run only. Agents write in this language; ids, JSON fields and enum values stay unchanged.${
        scenario.narrated ? ` Narration is authored in: ${escapeHtml(scenario.presentationLanguages.join(", ") || "—")}.` : ""
      }</p>
      <div id="rd-error"></div>
      <div class="actions">
        <button type="button" class="primary" data-go="control">Start</button>
        <button type="button" data-go="watch">Start &amp; watch</button>
        <button type="button" data-go="cancel">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const select = overlay.querySelector("#rd-language");
  const otherWrap = overlay.querySelector("#rd-other-wrap");
  select.addEventListener("change", () => (otherWrap.hidden = select.value !== "__other"));

  return new Promise((resolve) => {
    const close = () => {
      overlay.remove();
      resolve();
    };
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close();
    });
    overlay.querySelectorAll("[data-go]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        const go = btn.dataset.go;
        if (go === "cancel") return close();
        const language = select.value === "__other" ? overlay.querySelector("#rd-other").value.trim() : select.value;
        const overrides = language && language !== scenario.language ? { language } : {};
        try {
          const { id } = await apiDetailed(`/api/scenarios/${encodeURIComponent(scenario.id)}/run`, {
            method: "POST",
            body: JSON.stringify({ overrides }),
          });
          overlay.remove();
          location.hash = go === "watch" ? `#/watch/${encodeURIComponent(id)}` : `#/experiments/${encodeURIComponent(id)}`;
          resolve();
        } catch (err) {
          overlay.querySelector("#rd-error").innerHTML = `<div class="error-banner">${escapeHtml(err.message)}${
            err.problems?.length ? `<ul class="plain">${err.problems.map((p) => `<li>${escapeHtml(p)}</li>`).join("")}</ul>` : ""
          }</div>`;
        }
      })
    );
  });
}
