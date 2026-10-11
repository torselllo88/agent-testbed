import { api, escapeHtml } from "./shared.js";

/**
 * Choosing models for many agents at once — in the editor (saved into the
 * scenario) and in the run dialog (this run only, as overrides.models).
 */

export const PROVIDERS = ["openrouter", "azure", "stub"];

/**
 * OpenRouter's model catalog, loaded once per page session (the server caches
 * it too). Model ids are stable, so model fields offer them as a searchable
 * list; free text still works for anything not listed.
 */
let openRouterCatalog = null; // Promise<{ models } | { error }>
export function loadOpenRouterCatalog() {
  openRouterCatalog ??= api("/api/providers/openrouter/models").catch((err) => {
    openRouterCatalog = null; // retry on the next visit
    return { error: err.message, models: [] };
  });
  return openRouterCatalog;
}

export function formatPrice(perM) {
  if (perM === null || perM === undefined) return "?";
  return perM === 0 ? "free" : `$${perM < 0.1 ? perM.toFixed(3) : perM.toFixed(2)}`;
}

export function openRouterOptions(models) {
  return models
    .map((m) => `<option value="${escapeHtml(m.id)}" label="${escapeHtml(`${m.name} · ${formatPrice(m.promptPerM)} / ${formatPrice(m.completionPerM)} per M`)}"></option>`)
    .join("");
}

/** The first configured real provider (or stub when none is): what a new choice starts with. */
export function defaultProvider(meta) {
  return meta.providers?.find((p) => p.configured && p.id !== "stub")?.id ?? "stub";
}

/** The output mode the catalog says a model supports; undefined = keep each reference's own mode. */
export function structuredOutputFor(choice, catalog) {
  if (choice.provider !== "openrouter" || !catalog?.models?.length) return undefined;
  const m = catalog.models.find((x) => x.id === choice.model);
  return m ? (m.structuredOutputs ? "native" : "prompt") : undefined;
}

/**
 * Mirrors withModelChoice in src/experiment/config.ts (run overrides): another
 * provider and model, and the output mode when known. Temperature, seed and
 * the output cap belong to the scenario and stay; OpenRouter routing (backend
 * constraints for one specific model) is dropped.
 */
export function withModelChoice(ref, choice) {
  const { routing: _routing, ...rest } = ref ?? {};
  return { ...rest, provider: choice.provider, model: choice.model, structuredOutput: choice.structuredOutput ?? rest.structuredOutput ?? "native" };
}

/** The model references of a config: every agent's, and the orchestration ones it has (router classifier, debrief router). */
export function modelRefsOf(config) {
  const orchestration = [];
  if (config.scheduler?.type === "hybrid" && config.scheduler.classifier) orchestration.push({ label: "router classifier", ref: config.scheduler.classifier });
  if (config.humanInteraction?.debrief?.router) orchestration.push({ label: "debrief router", ref: config.humanInteraction.debrief.router });
  return { agents: (config.agents ?? []).map((a) => a.model), orchestration };
}

/** Applies choices to a config in place (the editor's draft). Returns how many references changed. */
export function applyModelChoices(config, { agents, orchestration }) {
  let changed = 0;
  if (agents) {
    for (const agent of config.agents) {
      agent.model = withModelChoice(agent.model, agents);
      changed += 1;
    }
  }
  if (orchestration) {
    if (config.scheduler?.type === "hybrid" && config.scheduler.classifier) {
      config.scheduler.classifier = withModelChoice(config.scheduler.classifier, orchestration);
      changed += 1;
    }
    if (config.humanInteraction?.debrief?.router) {
      config.humanInteraction.debrief.router = withModelChoice(config.humanInteraction.debrief.router, orchestration);
      changed += 1;
    }
  }
  return changed;
}

/** "openrouter · anthropic/claude-haiku-4.5 (all 4)" or "mixed: openrouter · a ×2, stub · b ×2". */
export function summarizeRefs(refs) {
  if (!refs.length) return "none";
  const counts = new Map();
  for (const r of refs) {
    const key = `${r.provider} · ${r.model}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (counts.size === 1) return `${[...counts.keys()][0]}${refs.length > 1 ? ` (all ${refs.length})` : ""}`;
  return `mixed: ${[...counts].map(([k, n]) => `${k} ×${n}`).join(", ")}`;
}

/** A provider select and a model field, keyed by an id prefix (not bound to the config). */
export function choiceFieldsHtml(prefix, choice, { stubList, openRouterList }) {
  const list = choice.provider === "stub" ? stubList : choice.provider === "openrouter" ? openRouterList : "";
  return `
    <label class="field"><span class="field-label">Provider</span>
      <select id="${prefix}-provider">${PROVIDERS.map((p) => `<option value="${p}" ${p === choice.provider ? "selected" : ""}>${p}</option>`).join("")}</select></label>
    <label class="field"><span class="field-label">Model</span>
      <input type="text" id="${prefix}-model" value="${escapeHtml(choice.model ?? "")}" ${list ? `list="${list}"` : ""} placeholder="${choice.provider === "openrouter" ? "e.g. anthropic/claude-haiku-4.5" : choice.provider === "azure" ? "deployment name" : "stub script"}" /></label>`;
}

/** Keeps a choice's model list in step with its provider select. */
export function bindChoiceFields(root, prefix, { stubList, openRouterList }, onChange) {
  const provider = root.querySelector(`#${prefix}-provider`);
  const model = root.querySelector(`#${prefix}-model`);
  if (!provider || !model) return;
  const sync = () => {
    const list = provider.value === "stub" ? stubList : provider.value === "openrouter" ? openRouterList : "";
    if (list) model.setAttribute("list", list);
    else model.removeAttribute("list");
    onChange?.({ provider: provider.value, model: model.value.trim() });
  };
  provider.addEventListener("change", sync);
  model.addEventListener("input", sync);
}

/** The current value of a choice's fields; null when no model is entered. */
export function readChoice(root, prefix, catalog) {
  const provider = root.querySelector(`#${prefix}-provider`)?.value;
  const model = root.querySelector(`#${prefix}-model`)?.value.trim();
  if (!provider || !model) return null;
  const choice = { provider, model };
  const mode = structuredOutputFor(choice, catalog);
  return mode ? { ...choice, structuredOutput: mode } : choice;
}
