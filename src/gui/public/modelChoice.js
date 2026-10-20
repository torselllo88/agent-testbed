import { api, escapeHtml } from "./shared.js";

/**
 * Choosing models for many agents at once — in the editor (saved into the
 * scenario) and in the run dialog (this run only, as overrides.models).
 */

/**
 * A provider as one select value: "openrouter", "azure", "stub", or
 * "openai-compatible:<endpoint>" for a self-hosted endpoint. Model references
 * store it as provider + endpoint.
 */
export const COMPAT = "openai-compatible";
export const providerValue = (ref) => (ref?.provider === COMPAT ? `${COMPAT}:${ref.endpoint ?? ""}` : (ref?.provider ?? ""));
export function splitProviderValue(value) {
  return value?.startsWith(`${COMPAT}:`) ? { provider: COMPAT, endpoint: value.slice(COMPAT.length + 1) } : { provider: value };
}

/** Provider choices from /api/meta: the built-ins and every self-hosted endpoint the environment declares. */
export function providerOptions(meta) {
  const statuses = meta.providers ?? [{ id: "openrouter" }, { id: "azure" }, { id: "stub" }];
  return statuses.map((p) => {
    const note = p.configured === false ? " — not configured" : "";
    return [p.id, p.endpoint ? `${p.endpoint.name} (self-hosted)${note}` : `${p.id}${note}`];
  });
}

/** The configured self-hosted endpoints' names. */
export const endpointNames = (meta) => (meta.providers ?? []).filter((p) => p.endpoint && p.configured).map((p) => p.endpoint.name);

/** The datalist a model field uses for a provider value (lists: { stubList, openRouterList, endpointPrefix }). */
export function modelListId(value, lists) {
  if (value === "stub") return lists.stubList;
  if (value === "openrouter") return lists.openRouterList;
  const { provider, endpoint } = splitProviderValue(value);
  return provider === COMPAT && endpoint ? `${lists.endpointPrefix}${endpoint}` : "";
}

/** The models a self-hosted endpoint serves (its GET /models), loaded once per page session. */
const endpointModels = new Map(); // name -> Promise<{ models } | { error, models: [] }>
export function loadEndpointModels(name) {
  if (!endpointModels.has(name)) {
    endpointModels.set(
      name,
      api(`/api/providers/openai-compatible/${encodeURIComponent(name)}/models`).catch((err) => {
        endpointModels.delete(name);
        return { error: err.message, models: [] };
      })
    );
  }
  return endpointModels.get(name);
}
export const endpointModelOptions = (models) => models.map((m) => `<option value="${escapeHtml(m)}"></option>`).join("");

/** Fills every endpoint datalist (id = prefix + name) once the server's model list arrives. */
export function fillEndpointLists(root, meta, prefix, onLoaded) {
  for (const name of endpointNames(meta)) {
    loadEndpointModels(name).then((result) => {
      const list = root.querySelector(`#${CSS.escape(prefix + name)}`);
      if (list) list.innerHTML = endpointModelOptions(result.models);
      onLoaded?.(name, result);
    });
  }
}

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
  const { routing: _routing, endpoint: _endpoint, ...rest } = ref ?? {};
  return {
    ...rest,
    provider: choice.provider,
    ...(choice.provider === COMPAT ? { endpoint: choice.endpoint } : {}),
    model: choice.model,
    structuredOutput: choice.structuredOutput ?? rest.structuredOutput ?? "native",
  };
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
    const key = `${providerValue(r)} · ${r.model}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (counts.size === 1) return `${[...counts.keys()][0]}${refs.length > 1 ? ` (all ${refs.length})` : ""}`;
  return `mixed: ${[...counts].map(([k, n]) => `${k} ×${n}`).join(", ")}`;
}

const placeholderFor = (value) =>
  value === "openrouter" ? "e.g. anthropic/claude-haiku-4.5" : value === "azure" ? "deployment name" : value === "stub" ? "stub script" : "a model the endpoint serves";

/** A provider select and a model field, keyed by an id prefix (not bound to the config). choice.provider is a provider value. */
export function choiceFieldsHtml(prefix, choice, lists, options) {
  const list = modelListId(choice.provider, lists);
  return `
    <label class="field"><span class="field-label">Provider</span>
      <select id="${prefix}-provider">${options.map(([value, label]) => `<option value="${escapeHtml(value)}" ${value === choice.provider ? "selected" : ""}>${escapeHtml(label)}</option>`).join("")}</select></label>
    <label class="field"><span class="field-label">Model</span>
      <input type="text" id="${prefix}-model" value="${escapeHtml(choice.model ?? "")}" ${list ? `list="${list}"` : ""} placeholder="${placeholderFor(choice.provider)}" /></label>`;
}

/** Keeps a choice's model list in step with its provider select. */
export function bindChoiceFields(root, prefix, lists, onChange) {
  const provider = root.querySelector(`#${prefix}-provider`);
  const model = root.querySelector(`#${prefix}-model`);
  if (!provider || !model) return;
  const sync = () => {
    const list = modelListId(provider.value, lists);
    if (list) model.setAttribute("list", list);
    else model.removeAttribute("list");
    model.placeholder = placeholderFor(provider.value);
    onChange?.({ provider: provider.value, model: model.value.trim() });
  };
  provider.addEventListener("change", sync);
  model.addEventListener("input", sync);
}

/** The current value of a choice's fields, as a model choice ({ provider, endpoint?, model, structuredOutput? }); null without a model. */
export function readChoice(root, prefix, catalog) {
  const value = root.querySelector(`#${prefix}-provider`)?.value;
  const model = root.querySelector(`#${prefix}-model`)?.value.trim();
  if (!value || !model) return null;
  const choice = { ...splitProviderValue(value), model };
  const mode = structuredOutputFor(choice, catalog);
  return mode ? { ...choice, structuredOutput: mode } : choice;
}
