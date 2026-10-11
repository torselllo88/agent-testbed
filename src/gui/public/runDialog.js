import {
  bindChoiceFields,
  choiceFieldsHtml,
  defaultProvider,
  loadOpenRouterCatalog,
  modelRefsOf,
  openRouterOptions,
  readChoice,
  summarizeRefs,
} from "./modelChoice.js";
import { api, apiDetailed, escapeHtml } from "./shared.js";

/**
 * "Run <scenario>" dialog: per-run overrides (the conversation language, and
 * models) that apply to this run only — the saved scenario is not edited or
 * versioned; the run's snapshot holds what it actually used. Resolves once the run has started (navigating to the control
 * view or the viewer), or when cancelled.
 */
export function openRunDialog(scenario, meta) {
  const suggested = [...new Set([scenario.language, ...scenario.presentationLanguages, ...meta.languages.suggested])];
  const label = (code) => {
    const authored = scenario.presentationLanguages.map((l) => l.toLowerCase()).includes(code.toLowerCase());
    return `${code}${code === scenario.language ? " — scenario default" : ""}${scenario.narrated ? (authored ? "" : " — narration falls back") : ""}`;
  };

  const LISTS = { stubList: "rd-stub-models", openRouterList: "rd-openrouter-models" };
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
      <div class="field"><span class="field-label">Models</span>
        <select id="rd-models">
          <option value="scenario">As in the scenario</option>
          <option value="choose">Choose for this run…</option>
        </select>
        <p class="muted small" id="rd-models-now">Loading the scenario's models…</p>
      </div>
      <div id="rd-models-choose" hidden>
        <div class="grid-2">${choiceFieldsHtml("rd-agents", { provider: defaultProvider(meta), model: "" }, LISTS)}</div>
        <div id="rd-orchestration" hidden>
          <p class="muted small" id="rd-orchestration-label"></p>
          <div class="grid-2">${choiceFieldsHtml("rd-orchestration", { provider: defaultProvider(meta), model: "" }, LISTS)}</div>
        </div>
        <p class="muted small">Provider and model for this run only; leave a model empty to keep the scenario's. Structured output follows what OpenRouter lists for the model.</p>
      </div>
      <datalist id="rd-stub-models">${meta.stubModels.map((m) => `<option value="${escapeHtml(m)}">`).join("")}</datalist>
      <datalist id="rd-openrouter-models"></datalist>
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

  // Models: what the scenario uses now, and optionally others for this run.
  const modelsSelect = overlay.querySelector("#rd-models");
  modelsSelect.addEventListener("change", () => (overlay.querySelector("#rd-models-choose").hidden = modelsSelect.value !== "choose"));
  bindChoiceFields(overlay, "rd-agents", LISTS);
  bindChoiceFields(overlay, "rd-orchestration", LISTS);
  let catalog = null;
  loadOpenRouterCatalog().then((c) => {
    catalog = c;
    overlay.querySelector("#rd-openrouter-models").innerHTML = openRouterOptions(c.models);
  });
  api(`/api/scenarios/${encodeURIComponent(scenario.id)}`)
    .then(({ scenario: full }) => {
      const refs = modelRefsOf(full.config);
      overlay.querySelector("#rd-models-now").textContent =
        `Now — agents: ${summarizeRefs(refs.agents)}${refs.orchestration.map((o) => `; ${o.label}: ${o.ref.provider} · ${o.ref.model}`).join("")}`;
      if (refs.orchestration.length) {
        overlay.querySelector("#rd-orchestration").hidden = false;
        overlay.querySelector("#rd-orchestration-label").textContent = `For the ${refs.orchestration.map((o) => o.label).join(" and ")} (a cheap, fast model is enough):`;
      }
    })
    .catch(() => (overlay.querySelector("#rd-models-now").textContent = ""));

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
        if (modelsSelect.value === "choose") {
          const agents = readChoice(overlay, "rd-agents", catalog);
          const orchestration = overlay.querySelector("#rd-orchestration").hidden ? null : readChoice(overlay, "rd-orchestration", catalog);
          if (agents || orchestration) overrides.models = { ...(agents ? { agents } : {}), ...(orchestration ? { orchestration } : {}) };
        }
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
