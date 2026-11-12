import {
  applyModelChoices,
  bindChoiceFields,
  choiceFieldsHtml,
  defaultProvider,
  formatPrice,
  loadOpenRouterCatalog,
  modelRefsOf,
  openRouterOptions,
  endpointModelOptions,
  endpointNames,
  loadEndpointModels,
  modelListId,
  providerOptions,
  providerValue,
  readChoice,
  splitProviderValue,
  summarizeRefs,
} from "../modelChoice.js";
import { openRunDialog } from "../runDialog.js";
import { api, apiDetailed, app, badge, downloadJson, escapeHtml, getPath, jsonBlock, setPath, showError } from "../shared.js";

// Form <-> config binding: every input carries data-path (dotted path into
// the draft config) and data-kind (how to coerce its value). Text edits
// update the draft in place without re-rendering (keeps focus); structural
// edits (scheduler type, adding an agent, ...) re-render the editor.

/**
 * Two groups, mirroring the architecture: what defines the experiment (what
 * agents see and do, and how the result is judged) vs. what only viewers and
 * people in the room experience (presentation, spectators, debrief).
 */
const TAB_GROUPS = [
  {
    label: "Experiment",
    hint: "Defines the run: what agents know and do, the protocol and how the result is judged.",
    tabs: [
      ["general", "Task"],
      ["agents", "Agents"],
      ["protocol", "Protocol"],
      ["limits", "Limits"],
      ["evaluator", "Evaluator"],
    ],
  },
  {
    label: "Presentation & demo",
    hint: "For viewers and people in the room only — never seen by agents, never changes the protocol or the result.",
    tabs: [
      ["presentation", "Presentation"],
      ["people", "People in the room"],
    ],
  },
  { label: null, tabs: [["raw", "Raw JSON"]] },
];
const TABS = TAB_GROUPS.flatMap((g) => g.tabs);
const groupOf = (tab) => TAB_GROUPS.find((g) => g.tabs.some(([key]) => key === tab));


function field(label, inner, hint) {
  return `<label class="field"><span class="field-label">${escapeHtml(label)}</span>${inner}${hint ? `<span class="field-hint">${escapeHtml(hint)}</span>` : ""}</label>`;
}

/** Shown above the editor when it was opened from the About & demo page: what each tab holds. */
const DEMO_GUIDE = `
  <div class="info-banner demo-guide">
    <p><strong>This is the complete configuration of the demo scenario — data, not code.</strong> Every field below can be changed in a copy (Duplicate), or varied across a batch.</p>
    <ul>
      <li><strong>Task</strong> — the shared facts every agent receives.</li>
      <li><strong>Agents</strong> — each agent's role, objective, private facts, persona and model.</li>
      <li><strong>Protocol</strong> — who speaks next, the consensus rule, the proposer, the conversation language.</li>
      <li><strong>Limits</strong> — turns, tokens, cost and time.</li>
      <li><strong>Evaluator</strong> — how success is checked, and the structure of the plan agents must submit.</li>
      <li><strong>Presentation</strong> and <strong>People in the room</strong> — narration, pacing and the debrief: for viewers only, never seen by agents.</li>
    </ul>
    <p><a href="#/demo">← Back to the demo</a></p>
  </div>`;

function valueAttr(v) {
  return v === undefined || v === null ? "" : escapeHtml(String(v));
}

export async function renderScenarioEditor(scenarioId, initialTab, from) {
  app.innerHTML = `<div class="loading">Loading…</div>`;
  let scenario, meta;
  try {
    [{ scenario }, meta] = await Promise.all([api(`/api/scenarios/${encodeURIComponent(scenarioId)}`), api("/api/meta")]);
  } catch (err) {
    app.innerHTML = "";
    showError(err.message);
    return;
  }

  const state = {
    scenario,
    draft: structuredClone(scenario.config),
    tab: TABS.some(([key]) => key === initialTab) ? initialTab : "general",
    dirty: false,
    rawText: null,
    rawError: null,
    /** Form fields whose text does not parse (path -> the text as typed): kept on screen, and Save / Validate are blocked. */
    invalid: new Map(),
    /** Human-interaction settings put aside when the profile is switched to the default, restored when switched back. */
    stashedInteraction: null,
    /** The "Models" panel's fields (not part of the config until applied). */
    modelPanel: null,
    /** Self-hosted endpoints' model lists, by endpoint name, once loaded. */
    endpointModels: {},
    notice: null,
    openRouter: null, // { models, error? } once loaded
  };

  const input = (path, kind = "string", attrs = "") => {
    const v = getPath(state.draft, path);
    return `<input type="${kind === "string" ? "text" : "number"}" data-path="${path}" data-kind="${kind}" value="${valueAttr(v)}" ${attrs} />`;
  };
  const textarea = (path, rows = 4) =>
    `<textarea data-path="${path}" data-kind="string" rows="${rows}">${escapeHtml(getPath(state.draft, path) ?? "")}</textarea>`;
  const checkbox = (path, label) =>
    `<label class="check"><input type="checkbox" data-path="${path}" data-kind="bool" ${getPath(state.draft, path) ? "checked" : ""}/> ${escapeHtml(label)}</label>`;
  const select = (path, options, { structural = false } = {}) => {
    const current = getPath(state.draft, path);
    return `<select data-path="${path}" data-kind="string" ${structural ? "data-structural" : ""}>${options
      .map(([value, label]) => `<option value="${escapeHtml(value)}" ${value === current ? "selected" : ""}>${escapeHtml(label)}</option>`)
      .join("")}</select>`;
  };
  const agentOptions = () => state.draft.agents.map((a) => [a.id, `${a.name} (${a.id})`]);

  const csvInput = (path, placeholder) => {
    const v = getPath(state.draft, path);
    return `<input type="text" data-path="${path}" data-kind="csv-optional" value="${valueAttr(Array.isArray(v) ? v.join(", ") : v)}" placeholder="${escapeHtml(placeholder)}" />`;
  };
  const triState = (path, labels) => {
    const v = getPath(state.draft, path);
    const current = v === undefined ? "" : String(v);
    return `<select data-path="${path}" data-kind="optional-bool">${[["", labels[0]], ["true", "true"], ["false", "false"]]
      .map(([value, label]) => `<option value="${value}" ${value === current ? "selected" : ""}>${escapeHtml(label)}</option>`)
      .join("")}</select>`;
  };
  const optionalSelect = (path, options, defaultLabel) => {
    const current = getPath(state.draft, path) ?? "";
    return `<select data-path="${path}" data-kind="optional-string">${[["", defaultLabel], ...options.map((o) => [o, o])]
      .map(([value, label]) => `<option value="${escapeHtml(value)}" ${value === current ? "selected" : ""}>${escapeHtml(label)}</option>`)
      .join("")}</select>`;
  };

  // OpenRouter-specific upstream-provider routing. Hidden for other providers (the config rejects it there).
  const routingFields = (base) => {
    const ref = getPath(state.draft, base);
    if (ref?.provider !== "openrouter") return "";
    const r = `${base}.routing`;
    const warn =
      ref.structuredOutput === "native" && ref.routing?.requireParameters === false
        ? `<div class="warning-banner">Native structured output with requireParameters=false: OpenRouter may route to a backend that ignores the response schema.</div>`
        : "";
    const configured = ref.routing && Object.keys(ref.routing).length;
    return `<details class="advanced" ${configured ? "open" : ""}><summary>OpenRouter routing (advanced)${configured ? " — configured" : " — automatic"}</summary>
      <p class="muted small">Leave empty to let OpenRouter choose the upstream provider. Values are provider slugs, comma-separated (e.g. <code>deepinfra, together</code>). The backend that actually served each call is recorded in the trace.</p>
      ${warn}
      <div class="grid-3">
        ${field("Only", csvInput(`${r}.only`, "e.g. together"), "use only these providers")}
        ${field("Order", csvInput(`${r}.order`, "e.g. together, deepinfra"), "try these first, in order")}
        ${field("Ignore", csvInput(`${r}.ignore`, "e.g. deepinfra"), "never use these")}
      </div>
      <div class="grid-4">
        ${field("Allow fallbacks", triState(`${r}.allowFallbacks`, ["default (true)"]))}
        ${field("Require parameters", triState(`${r}.requireParameters`, [ref.structuredOutput === "native" ? "default (true for native)" : "default (false)"]))}
        ${field("Sort", optionalSelect(`${r}.sort`, ["price", "throughput", "latency"], "default"))}
        ${field("Data collection", optionalSelect(`${r}.dataCollection`, ["allow", "deny"], "default (allow)"))}
      </div>
      ${field("Quantizations", csvInput(`${r}.quantizations`, "e.g. fp16, bf16"))}
    </details>`;
  };

  /** What the catalog says about an OpenRouter model reference (price, context, structured-output support). */
  const openRouterModelInfo = (ref) => {
    if (ref?.provider !== "openrouter") return "";
    const catalog = state.openRouter;
    if (!catalog) return `<p class="muted small">Loading the OpenRouter model list…</p>`;
    if (catalog.error) return `<p class="muted small">OpenRouter model list unavailable (${escapeHtml(catalog.error)}) — enter the model id manually.</p>`;
    if (!ref.model) return `<p class="muted small">${catalog.models.length} OpenRouter models — start typing to search.</p>`;
    const m = catalog.models.find((x) => x.id === ref.model);
    if (!m) return `<div class="warning-banner">"${escapeHtml(ref.model)}" is not in OpenRouter's current model list.</div>`;
    const facts = [m.name, m.contextLength ? `${m.contextLength.toLocaleString("en-US")} context` : null, `${formatPrice(m.promptPerM)} in / ${formatPrice(m.completionPerM)} out per M tokens`]
      .filter(Boolean)
      .join(" · ");
    const warn =
      ref.structuredOutput === "native" && !m.structuredOutputs
        ? `<div class="warning-banner">OpenRouter does not list structured outputs for this model — set Structured output to "prompt only".</div>`
        : "";
    return `<p class="muted small">${escapeHtml(facts)}</p>${warn}`;
  };

  const modelList = (ref) => {
    const id = modelListId(providerValue(ref), MODEL_LISTS);
    return id ? `list="${id}"` : "";
  };

  /** What a self-hosted endpoint says about a model reference (is the model among those it serves). */
  const endpointModelInfo = (ref) => {
    if (ref?.provider !== "openai-compatible") return "";
    const listed = state.endpointModels[ref.endpoint];
    if (!listed) return `<p class="muted small">Self-hosted endpoint "${escapeHtml(ref.endpoint ?? "")}" — loading the models it serves…</p>`;
    if (listed.error) return `<p class="muted small">Could not list the endpoint's models (${escapeHtml(listed.error)}) — enter the model name manually.</p>`;
    if (!ref.model) return `<p class="muted small">${listed.models.length} model(s) served by "${escapeHtml(ref.endpoint)}" — start typing.</p>`;
    return listed.models.includes(ref.model)
      ? `<p class="muted small">Served by the self-hosted endpoint "${escapeHtml(ref.endpoint)}" · cost not reported (recorded as unknown)</p>`
      : `<div class="warning-banner">"${escapeHtml(ref.model)}" is not among the models "${escapeHtml(ref.endpoint)}" serves (${escapeHtml(listed.models.join(", ") || "none")}).</div>`;
  };
  const providerSelect = (base) => {
    const current = providerValue(getPath(state.draft, base));
    const options = providerOptions(meta);
    if (current && !options.some(([v]) => v === current)) options.push([current, `${current} — not configured here`]);
    return `<select data-path="${base}.provider" data-kind="string" data-structural>${options
      .map(([value, label]) => `<option value="${escapeHtml(value)}" ${value === current ? "selected" : ""}>${escapeHtml(label)}</option>`)
      .join("")}</select>`;
  };

  const modelFields = (base) => `
    <div class="grid-4">
      ${field("Provider", providerSelect(base))}
      ${field("Model", input(`${base}.model`, "string", `${modelList(getPath(state.draft, base))} data-model-input`), "OpenRouter model id, Azure deployment, the endpoint's model name, or stub script")}
      ${field("Temperature", input(`${base}.temperature`, "optional-number", `step="0.1" min="0" max="2"`), "blank = provider default")}
      ${field("Max output tokens", input(`${base}.maxOutputTokens`, "optional-number", `min="1"`), "blank = no cap")}
    </div>
    <div class="grid-4">
      ${field("Structured output", select(`${base}.structuredOutput`, [["native", "native (provider-enforced schema)"], ["prompt", "prompt only"]], { structural: true }))}
      ${field("Seed", input(`${base}.seed`, "optional-number"), "best-effort, recorded only")}
      ${
        getPath(state.draft, base)?.provider === "openai-compatible"
          ? `${field("Thinking", triState(`${base}.think`, ["server default"]), "false switches a model's thinking mode off")}
             ${field("Context window", input(`${base}.contextLength`, "optional-number", `min="1"`), "tokens; Ollama endpoints only — blank = server default")}`
          : ""
      }
    </div>
    ${openRouterModelInfo(getPath(state.draft, base))}
    ${endpointModelInfo(getPath(state.draft, base))}
    ${routingFields(base)}`;

  /** Choose one model for every agent (and one for the routers) instead of editing each reference. */
  const MODEL_LISTS = { stubList: "stub-models", openRouterList: "openrouter-models", endpointPrefix: "compat-models-" };
  const modelPanel = () => {
    if (readOnly) return "";
    const refs = modelRefsOf(state.draft);
    state.modelPanel ??= {
      agents: { provider: defaultProvider(meta), model: "" },
      orchestration: { provider: defaultProvider(meta), model: "" },
    };
    return `
      <div class="card model-panel">
        <h3>Models</h3>
        <p class="muted small">Now — agents: <strong>${escapeHtml(summarizeRefs(refs.agents))}</strong>${
          refs.orchestration.length ? `; ${refs.orchestration.map((o) => `${escapeHtml(o.label)}: <strong>${escapeHtml(`${providerValue(o.ref)} · ${o.ref.model}`)}</strong>`).join("; ")}` : ""
        }.</p>
        <div class="grid-4 model-choice">
          ${choiceFieldsHtml("mp-agents", state.modelPanel.agents, MODEL_LISTS, providerOptions(meta))}
          <div class="field"><span class="field-label">&nbsp;</span><button type="button" data-action="apply-models" data-target="agents">Apply to all agents</button></div>
        </div>
        ${
          refs.orchestration.length
            ? `<div class="grid-4 model-choice">
                ${choiceFieldsHtml("mp-orchestration", state.modelPanel.orchestration, MODEL_LISTS, providerOptions(meta))}
                <div class="field"><span class="field-label">&nbsp;</span><button type="button" data-action="apply-models" data-target="orchestration">Apply to ${escapeHtml(refs.orchestration.map((o) => o.label).join(" and "))}</button></div>
              </div>
              <p class="muted small">Routers only pick who answers next — a cheap, fast model is enough.</p>`
            : ""
        }
        <p class="muted small">Changes provider and model only; structured output follows what OpenRouter lists for the model. Temperature, seed and output caps stay; OpenRouter routing is cleared. Adjust single agents below afterwards.</p>
      </div>`;
  };

  const tabBody = {
    general: () => `
      ${field("Name", input("name"))}
      ${field("Description", textarea("description", 2))}
      ${field("Task description", textarea("task.description", 3), "Given to every agent")}
      ${field("Shared context", textarea("task.sharedContext", 12), "Known to every agent")}`,

    agents: () =>
      modelPanel() +
      state.draft.agents
        .map(
          (agent, i) => `
        <div class="card agent-card">
          <div class="row"><h3>${escapeHtml(agent.name || agent.id)}</h3>
            <button type="button" class="danger" data-action="remove-agent" data-index="${i}" ${state.draft.agents.length <= 2 ? "disabled" : ""}>Remove</button></div>
          <h4 class="subhead">Task definition <span class="muted small">— part of the task definition hash</span></h4>
          <div class="grid-3">
            ${field("Id", input(`agents.${i}.id`))}
            ${field("Role", input(`agents.${i}.role`))}
          </div>
          ${field("Objective", textarea(`agents.${i}.objective`, 2), "What this agent is responsible for")}
          ${field("Private context", textarea(`agents.${i}.privateContext`, 8), "Visible only to this agent")}
          <h4 class="subhead">Behavior &amp; model <span class="muted small">— changes how the agent acts, so runs differing here are different conditions</span></h4>
          ${field("Name", input(`agents.${i}.name`), "The name other participants see")}
          ${modelFields(`agents.${i}.model`)}
          ${field("Persona", textarea(`agents.${i}.persona`, 4), "Personality and interpersonal tendencies — shapes how it talks, never what it knows")}
          ${field("Extra system prompt", textarea(`agents.${i}.systemPrompt`, 3), "Optional free-form instructions (e.g. speech style)")}
        </div>`
        )
        .join("") + `<button type="button" data-action="add-agent">+ Add agent</button>`,

    protocol: () => {
      const s = state.draft.scheduler;
      const hybrid = s.type === "hybrid";
      return `
      <h3>Scheduler</h3>
      <div class="grid-3">
        ${field("Type", select("scheduler.type", meta.schedulers.map((t) => [t, t]), { structural: true }))}
        ${field("Start agent", select("scheduler.startAgentId", agentOptions()))}
        ${hybrid ? field("Classifier window", input("scheduler.classifierWindow", "number", `min="1"`), "recent messages the router sees") : ""}
      </div>
      ${
        hybrid
          ? `${checkbox("scheduler.__classifierEnabled", "Use an LLM classifier when there is no valid explicit target")}
             <p class="muted small">Tip: the <strong>Models</strong> panel on the Agents tab sets the classifier and the debrief router in one step.</p>
             ${s.classifier ? modelFields("scheduler.classifier") : `<p class="muted">Without a classifier: explicit target, else deterministic fallback.</p>`}`
          : ""
      }
      <h3>Decision</h3>
      <div class="grid-4">
        ${field("Consensus rule", select("consensus.rule", meta.consensusRules.map((r) => [r, r])))}
        ${field("Proposer", select("decision.proposerId", agentOptions()))}
        ${field("Max proposal attempts", input("decision.maxProposalAttempts", "number", `min="1"`))}
        ${field("Format retries", input("decision.maxProposalFormatRetries", "number", `min="0"`), "re-asks after a schema-invalid proposal")}
      </div>
      <h3>Conversation</h3>
      ${field("Conversation language", input("conversation.language", "string", `list="language-suggestions"`), "What agents write in (changes behavior); a run can override it")}
      <h3>Agent visibility</h3>
      ${checkbox("agentVisibility.discussionBudget", "Show agents the discussion turn budget and proposal attempt (changes agent behavior — off for baseline runs)")}
`;
    },

    limits: () => `
      <h3>Discussion (soft — end discussion, not the run)</h3>
      <div class="grid-3">
        ${field("Discussion turn limit", input("limits.discussionTurnLimit", "number", `min="1"`))}
        ${field("Re-discussion turn limit", input("limits.rediscussionTurnLimit", "number", `min="1"`), "per return after a failed proposal")}
      </div>
      <h3>Hard limits (terminal)</h3>
      <div class="grid-3">
        ${field("Global turn limit", input("limits.globalTurnLimit", "number", `min="1"`), "safety fuse over all activations")}
        ${field("Agent token limit", input("limits.agentTokenLimit", "nullable-number", `min="1"`), "blank = unlimited")}
        ${field("Time limit (s)", input("limits.timeLimitSeconds", "nullable-number", `min="1"`), "active time, pauses excluded")}
        ${field("Total token cap", input("limits.totalTokenCap", "nullable-number", `min="1"`), "agents + orchestration")}
        ${field("Total cost cap (USD)", input("limits.totalCostCapUsd", "nullable-number", `step="0.01" min="0"`), "emergency brake")}
      </div>
      ${checkbox("limits.countOrchestrationTokens", "Count router/orchestration tokens against the agent token limit")}
      <h3>Runtime</h3>
      <div class="grid-4">
        ${field("Parse retries", input("runtime.maxParseRetries", "number", `min="0"`))}
        ${field("Provider retries", input("runtime.maxProviderRetries", "number", `min="0"`))}
        ${field("Retry delay (ms)", input("runtime.providerRetryDelayMs", "number", `min="0"`))}
        ${field("Call timeout (s)", input("runtime.callTimeoutSeconds", "number", `min="1"`))}
      </div>`,

    evaluator: () => {
      const evaluator = meta.evaluators.find((e) => e.id === state.draft.evaluator.id);
      return `
      ${field("Evaluator", select("evaluator.id", meta.evaluators.map((e) => [e.id, `${e.id} (v${e.version})`])))}
      ${evaluator ? `<p class="muted">${escapeHtml(evaluator.description)}</p>` : ""}
      ${field(
        "Scenario parameters (JSON)",
        `<textarea class="code" data-path="evaluator.params" data-kind="json" rows="14">${escapeHtml(JSON.stringify(state.draft.evaluator.params, null, 2))}</textarea>`,
        "Keep these consistent with the agents' private information"
      )}
      ${evaluator ? `<details class="card"><summary><h2>Proposal schema (structure only)</h2></summary>${jsonBlock(evaluator.proposalSchema)}</details>` : ""}`;
    },

    presentation: () => {
      const p = state.draft.presentation ?? {};
      const narrated = Boolean(p.narrator);
      return `
      <p class="muted">How a run is presented to viewers. Agents never see narration; endings and beats are rendered from runtime and evaluator state. Texts follow the run's conversation language (Protocol tab).</p>
      <h3>Narration</h3>
      ${field("Fallback language for narration", input("presentation.fallbackLanguage", "string", `list="language-suggestions"`), "Used for any text missing in the conversation language")}
      ${checkbox("presentation.__narratorEnabled", "Post an opening and an ending narration in the room")}
      ${narrated ? field("Narrator display name", input("presentation.narrator.displayName"), "Default; a language's strings may override it (narratorName)") : ""}
      ${field(
        "Presentation strings (JSON, keyed by language)",
        `<textarea class="code" data-path="presentation.strings" data-kind="json" rows="16">${escapeHtml(JSON.stringify(p.strings ?? {}, null, 2))}</textarea>`,
        "Per language: title, narratorName, opening, outcomes.{OUTCOME|default}, missionFailure.{check}, beats.{id}, agents, proposal, interaction. An ending may be a list of parts, revealed one by one. Placeholders: {{derived.x}}, {{params.x}}, {{checks.x.detail}}, {{votes.approvals}}, {{votes.eligible}}, {{reason}}"
      )}
      ${field(
        "Beats (JSON)",
        `<textarea class="code" data-path="presentation.beats" data-kind="json-optional" rows="6">${escapeHtml(p.beats ? JSON.stringify(p.beats, null, 2) : "")}</textarea>`,
        'Observer-only lines during the run, e.g. [{"id": "urgent", "when": {"discussionProgress": 0.75}}, {"id": "rejected", "when": {"planRejected": true}}]; texts in strings.<lang>.beats. Empty = none.'
      )}
      ${field("Mission-failure priority", csvInput("presentation.missionFailurePriority", "evaluator check names, most important first"), "Evaluator checks in narrative priority; the first violated one picks the ending")}
      <h3>Pacing</h3>
      <div class="grid-3">
        ${field("Minimum visible interval (ms)", input("presentation.pacing.minVisibleIntervalMs", "number", `min="0"`), "0 = no pacing (research runs)")}
        ${field("Per character of previous message (ms)", input("presentation.pacing.perCharMs", "number", `min="0" step="1"`))}
        ${field("Maximum gap (ms)", input("presentation.pacing.maxGapMs", "number", `min="0"`))}
        ${field("Ending reveal pause (ms)", input("presentation.pacing.sequencePauseMs", "optional-number", `min="0"`), "minimum pause between the parts of an ending")}
      </div>
      <p class="muted small">Pacing is excluded from provider latency and from the experiment's time limit; it is recorded separately.</p>`;
    },

    people: () => {
      const hi = state.draft.humanInteraction;
      const profile = hi?.profile ?? "";
      const profiles = meta.humanInteraction?.profiles ?? {};
      const options = [["", "OBSERVE (default) — spectators only"], ...Object.entries(profiles).filter(([p]) => p !== "OBSERVE").map(([p, c]) => [p, c.supported ? p : `${p} — not supported yet`])];
      const debrief = profile === "DEBRIEF";
      const d = "humanInteraction.debrief";
      return `
      <p class="muted">What people in the room may do around a run. During a run they are always spectators: their messages never reach the agents. None of this changes the experiment or its metrics.</p>
      ${field("Profile", `<select data-path="humanInteraction.__profile" data-kind="string" data-structural>${options
        .map(([value, label]) => `<option value="${escapeHtml(value)}" ${value === profile ? "selected" : ""} ${value && !profiles[value]?.supported ? "disabled" : ""}>${escapeHtml(label)}</option>`)
        .join("")}</select>`, "DEBRIEF: after the outcome, people can question the characters")}
      ${
        debrief
          ? `<h3>Debrief</h3>
        <div class="grid-3">
          ${field("Default character", optionalSelect(`${d}.defaultAgentId`, state.draft.agents.map((a) => a.id), `default (proposer: ${state.draft.decision.proposerId})`), "answers questions addressed to nobody in particular")}
          ${field("Answer max tokens", input(`${d}.maxOutputTokens`, "number", `min="1"`), "each character answers with its own model from the run")}
          ${field("Cost cap per session (USD)", input(`${d}.costCapUsd`, "nullable-number", `step="0.01" min="0"`), "blank = none")}
          ${field("Pending questions per person", input(`${d}.maxPendingPerUser`, "number", `min="1"`))}
          ${field("Pending questions in total", input(`${d}.maxPendingTotal`, "number", `min="1"`))}
          ${field("Idle timeout (min)", input(`${d}.idleTimeoutMinutes`, "number", `min="1"`))}
          ${field("Spectator notice cooldown (s)", input(`${d}.spectatorNoticeCooldownSeconds`, "number", `min="0"`))}
        </div>
        ${checkbox(`${d}.revealEvaluation`, "Give characters the evaluator's check results (can reveal facts only another character knew)")}
        <h3>Routing of unaddressed questions</h3>
        <p class="muted small">Replies, mentions and names are routed without a model. For the rest, a router model can pick the character; with it off, the default character answers. Independent of the experiment's own scheduler.</p>
        ${
          hi.debrief && !("router" in hi.debrief)
            ? `<div class="warning-banner small">Saved before the debrief had its own router: unaddressed questions are routed by the scheduler's classifier (marked "legacy"). Saving leaves it so; turn the router on to pick a model, or on and off again for none.</div>`
            : ""
        }
        ${checkbox("humanInteraction.__debriefRouterEnabled", "Use a router model")}
        ${state.draft.humanInteraction?.debrief?.router ? modelFields(`${d}.router`) : ""}
        <h3>Name aliases</h3>
        ${field(
          "Aliases (JSON)",
          `<textarea class="code" data-path="humanInteraction.aliases" data-kind="json-optional" rows="5">${escapeHtml(hi.aliases ? JSON.stringify(hi.aliases, null, 2) : "")}</textarea>`,
          'Per agent id, more names people may use — matched as whole words, e.g. {"power": ["Виктору", "Виктором"]}. The name and its localized labels count already.'
        )}
        <p class="muted small">Notice texts: presentation strings, key <code>interaction</code>.</p>`
          : ""
      }`;
    },

    raw: () => `
      <p class="muted">The complete config. Edits here replace the form state; invalid JSON is not applied.</p>
      <div id="raw-error">${state.rawError ? `<div class="error-banner">${escapeHtml(state.rawError)}</div>` : ""}</div>
      <textarea id="raw-json" class="code" spellcheck="false">${escapeHtml(state.rawText ?? JSON.stringify(state.draft, null, 2))}</textarea>`,
  };

  const readOnly = Boolean(scenario.builtin);

  function render() {
    const s = state.scenario;
    app.innerHTML = `
      <div class="breadcrumb"><a href="#/scenarios">Scenarios</a> / ${escapeHtml(s.name)}</div>
      <div class="page-header">
        <h1>${escapeHtml(state.draft.name || s.name)} ${readOnly ? badge("built-in", "info") : badge(`v${s.version}`, "neutral")} ${state.dirty ? badge("unsaved changes", "warn") : ""}</h1>
        <div class="actions">
          ${readOnly ? "" : `<button id="btn-save" class="primary" ${state.dirty && !state.invalid.size ? "" : "disabled"}>Save</button>`}
          <button id="btn-validate">Validate</button>
          <button id="btn-run" class="primary">Run</button>
          <button id="btn-duplicate">Duplicate</button>
          <button id="btn-export">Export</button>
          ${readOnly ? "" : `<button id="btn-delete" class="danger">Delete</button>`}
        </div>
      </div>
      ${from === "demo" ? DEMO_GUIDE : ""}
      ${readOnly ? `<div class="warning-banner">Built-in scenario — read-only. Duplicate it to make an editable copy.</div>` : ""}
      <div id="editor-messages">${state.notice ?? ""}</div>
      <div class="tabs grouped">${TAB_GROUPS.map(
        (g) => `<div class="tab-group${g.label === "Presentation & demo" ? " demo" : ""}">${g.label ? `<span class="tab-group-label">${escapeHtml(g.label)}</span>` : ""}<div class="tab-group-tabs">${g.tabs
          .map(([key, label]) => `<button type="button" class="tab ${state.tab === key ? "active" : ""}" data-tab="${key}">${label}</button>`)
          .join("")}</div></div>`
      ).join("")}</div>
      <div class="card editor-body${groupOf(state.tab)?.label === "Presentation & demo" ? " demo" : ""}" id="editor-body">${groupOf(state.tab)?.hint ? `<p class="tab-group-hint">${escapeHtml(groupOf(state.tab).hint)}</p>` : ""}${tabBody[state.tab]()}</div>
      <datalist id="stub-models">${meta.stubModels.map((m) => `<option value="${escapeHtml(m)}">`).join("")}</datalist>
      <datalist id="openrouter-models">${state.openRouter ? openRouterOptions(state.openRouter.models) : ""}</datalist>
      ${endpointNames(meta).map((name) => `<datalist id="compat-models-${escapeHtml(name)}">${endpointModelOptions(state.endpointModels[name]?.models ?? [])}</datalist>`).join("")}
      <datalist id="language-suggestions">${meta.languages.suggested.map((l) => `<option value="${escapeHtml(l)}">`).join("")}</datalist>
    `;
    const narratorToggle = app.querySelector('[data-path="presentation.__narratorEnabled"]');
    if (narratorToggle) narratorToggle.checked = Boolean(state.draft.presentation?.narrator);
    if (readOnly) {
      app.querySelectorAll("#editor-body input, #editor-body select, #editor-body textarea, #editor-body button").forEach((el) => (el.disabled = true));
    }
    // Synthetic checkbox: the classifier toggle maps to classifier null vs. a model ref.
    const toggle = app.querySelector('[data-path="scheduler.__classifierEnabled"]');
    if (toggle) toggle.checked = Boolean(state.draft.scheduler.classifier);
    const routerToggle = app.querySelector('[data-path="humanInteraction.__debriefRouterEnabled"]');
    if (routerToggle) routerToggle.checked = Boolean(state.draft.humanInteraction?.debrief?.router);
    // A re-render keeps what was typed into a field that does not parse, still marked.
    for (const [path, raw] of state.invalid) {
      const el = app.querySelector(`#editor-body [data-path="${CSS.escape(path)}"]`);
      if (!el) {
        state.invalid.delete(path); // the field is gone (e.g. its agent was removed)
        continue;
      }
      el.value = raw;
      el.classList.add("invalid");
    }
    bind();
  }

  function invalidFieldsHtml() {
    const n = state.invalid.size;
    return problemsHtml(`Fix ${n} invalid field${n === 1 ? "" : "s"} first:`, [...state.invalid.keys()].map((p) => `${p}: not a valid value (nothing was applied)`));
  }

  function refreshSave() {
    const save = document.getElementById("btn-save");
    if (save) {
      save.disabled = !state.dirty || state.invalid.size > 0;
      save.title = state.invalid.size ? "Fix the invalid fields first" : "";
    }
  }

  function markDirty() {
    if (!state.dirty) {
      state.dirty = true;
      refreshSave();
      const h1 = app.querySelector(".page-header h1");
      if (h1 && !h1.innerHTML.includes("unsaved")) h1.insertAdjacentHTML("beforeend", ` ${badge("unsaved changes", "warn")}`);
    }
  }

  /** Sets a value; undefined deletes the key, and an emptied routing object is removed entirely. */
  function assign(path, value) {
    if (value === undefined) {
      const parts = path.split(".");
      const parentPath = parts.slice(0, -1).join(".");
      const parent = getPath(state.draft, parentPath);
      if (parent) delete parent[parts.at(-1)];
      if (parentPath.endsWith(".routing") && parent && Object.keys(parent).length === 0) {
        delete getPath(state.draft, parentPath.slice(0, -".routing".length)).routing;
      }
    } else {
      setPath(state.draft, path, value);
    }
  }

  function applyStructural(path, value) {
    if (path === "scheduler.type") {
      const startAgentId = state.draft.scheduler.startAgentId;
      state.draft.scheduler =
        value === "hybrid" ? { type: "hybrid", startAgentId, classifier: null, classifierWindow: 12 } : { type: "round_robin", startAgentId };
    } else if (path === "scheduler.__classifierEnabled") {
      state.draft.scheduler.classifier = value ? { provider: "stub", model: meta.stubModels.find((m) => m.startsWith("router/")) ?? "", structuredOutput: "native" } : null;
    } else if (path === "humanInteraction.__debriefRouterEnabled") {
      state.draft.humanInteraction.debrief.router = value ? { provider: "stub", model: "router/next-in-order", structuredOutput: "native" } : null;
    } else if (path === "humanInteraction.__profile") {
      if (!value) {
        state.stashedInteraction = state.draft.humanInteraction ?? state.stashedInteraction;
        delete state.draft.humanInteraction;
      } else
        state.draft.humanInteraction = {
          ...(state.draft.humanInteraction ?? state.stashedInteraction ?? {}),
          profile: value,
          debrief: state.draft.humanInteraction?.debrief ?? state.stashedInteraction?.debrief ?? {
            router: null,
            maxOutputTokens: 250,
            maxPendingPerUser: 3,
            maxPendingTotal: 20,
            costCapUsd: null,
            idleTimeoutMinutes: 15,
            revealEvaluation: false,
            spectatorNoticeCooldownSeconds: 30,
          },
        };
    } else if (path === "presentation.__narratorEnabled") {
      state.draft.presentation = { ...(state.draft.presentation ?? {}), narrator: value ? { displayName: "NARRATOR" } : null };
    } else if (path === "transport.type") {
      state.draft.transport = { type: value };
    } else if (path.endsWith(".provider") && getPath(state.draft, path.slice(0, -".provider".length))?.model !== undefined) {
      // Any model reference (agent, router classifier, debrief router). A self-hosted endpoint is provider + endpoint.
      const ref = getPath(state.draft, path.slice(0, -".provider".length));
      const { provider, endpoint } = splitProviderValue(value);
      ref.provider = provider;
      if (provider === "openai-compatible") ref.endpoint = endpoint;
      else {
        delete ref.endpoint;
        // Serving options of a self-hosted endpoint; the config rejects them for any other provider.
        delete ref.think;
        delete ref.contextLength;
      }
      // Routing is OpenRouter-specific; the config rejects it for any other provider.
      if (provider !== "openrouter") delete ref.routing;
    } else {
      assign(path, value);
    }
  }

  function coerce(el) {
    const kind = el.dataset.kind;
    if (kind === "bool") return { ok: true, value: el.checked };
    const raw = el.value;
    if (kind === "number") return raw === "" ? { ok: false } : { ok: true, value: Number(raw) };
    if (kind === "nullable-number") return { ok: true, value: raw === "" ? null : Number(raw) };
    if (kind === "optional-number") return { ok: true, value: raw === "" ? undefined : Number(raw) };
    if (kind === "optional-string") return { ok: true, value: raw === "" ? undefined : raw };
    if (kind === "optional-bool") return { ok: true, value: raw === "" ? undefined : raw === "true" };
    if (kind === "csv-optional") {
      const items = raw.split(",").map((x) => x.trim()).filter(Boolean);
      return { ok: true, value: items.length ? items : undefined };
    }
    if (kind === "json-optional") {
      if (raw.trim() === "") return { ok: true, value: undefined };
      try {
        return { ok: true, value: JSON.parse(raw) };
      } catch {
        return { ok: false };
      }
    }
    if (kind === "json") {
      try {
        return { ok: true, value: JSON.parse(raw) };
      } catch {
        return { ok: false };
      }
    }
    return { ok: true, value: raw };
  }

  function bind() {
    const body = document.getElementById("editor-body");
    for (const target of ["agents", "orchestration"]) {
      bindChoiceFields(body, `mp-${target}`, MODEL_LISTS, (choice) => {
        state.modelPanel[target] = choice;
      });
    }

    body.addEventListener("input", (e) => {
      const el = e.target;
      if (el.id === "raw-json") {
        state.rawText = el.value;
        try {
          state.draft = JSON.parse(el.value);
          state.rawError = null;
          el.classList.remove("invalid");
        } catch (err) {
          state.rawError = `Not valid JSON: ${err.message}`;
          el.classList.add("invalid");
        }
        // Update the message in place — re-rendering would reset the textarea's cursor.
        document.getElementById("raw-error").innerHTML = state.rawError ? `<div class="error-banner">${escapeHtml(state.rawError)}</div>` : "";
        markDirty();
        return;
      }
      if (!el.dataset.path || el.dataset.structural !== undefined || el.type === "checkbox") return;
      const result = coerce(el);
      el.classList.toggle("invalid", !result.ok);
      if (!result.ok) {
        state.invalid.set(el.dataset.path, el.value);
        markDirty();
        return refreshSave();
      }
      state.invalid.delete(el.dataset.path);
      assign(el.dataset.path, result.value);
      markDirty();
      refreshSave();
    });

    body.addEventListener("change", (e) => {
      const el = e.target;
      if (!el.dataset.path) return;
      // A committed model id (typed or picked from the list) refreshes the model's catalog info.
      if (el.dataset.modelInput !== undefined) return render();
      // Routing selects re-render too: the requireParameters warning depends on them.
      const structural = el.dataset.structural !== undefined || el.dataset.path.includes("__") || el.dataset.path.includes(".routing.");
      if (el.tagName === "SELECT" || el.type === "checkbox") {
        const { value } = coerce(el);
        applyStructural(el.dataset.path, value);
        markDirty();
        if (structural) render();
      }
    });

    body.addEventListener("click", (e) => {
      const action = e.target.dataset?.action;
      if (action === "add-agent") {
        const n = state.draft.agents.length + 1;
        const model = structuredClone(state.draft.agents[0]?.model ?? { provider: "stub", model: "", structuredOutput: "native" });
        state.draft.agents.push({ id: `agent_${n}`, name: `Agent ${n}`, role: "", model, systemPrompt: "", privateContext: "", tools: [] });
        markDirty();
        render();
      } else if (action === "remove-agent") {
        state.draft.agents.splice(Number(e.target.dataset.index), 1);
        markDirty();
        render();
      } else if (action === "apply-models") {
        const target = e.target.dataset.target;
        const choice = readChoice(body, `mp-${target}`, state.openRouter);
        if (!choice) return setNotice(problemsHtml("Enter a model first."));
        const changed = applyModelChoices(state.draft, { [target]: choice });
        markDirty();
        render();
        setNotice(`<div class="success-banner">${escapeHtml(`${choice.provider} · ${choice.model}`)} set for ${changed} ${target === "agents" ? "agent" : "router"}${changed === 1 ? "" : "s"}${
          choice.structuredOutput ? ` (structured output: ${choice.structuredOutput === "native" ? "native" : "prompt only"})` : ""
        }. Save to keep it.</div>`);
      }
    });

    app.querySelectorAll(".tab").forEach((btn) =>
      btn.addEventListener("click", () => {
        if (state.tab === "raw" && state.rawError) return; // don't leave the raw view with unparsed edits
        if (state.invalid.size) return setNotice(invalidFieldsHtml()); // nor a tab with a field that does not parse
        state.tab = btn.dataset.tab;
        // Deep-linkable tab, without triggering the hash router.
        history.replaceState(null, "", `#/scenarios/${encodeURIComponent(state.scenario.id)}?tab=${state.tab}${from === "demo" ? "&from=demo" : ""}`);
        state.rawText = null;
        state.notice = null;
        render();
      })
    );

    document.getElementById("btn-save")?.addEventListener("click", save);
    document.getElementById("btn-validate").addEventListener("click", validate);
    document.getElementById("btn-run").addEventListener("click", run);
    document.getElementById("btn-duplicate").addEventListener("click", duplicate);
    document.getElementById("btn-export").addEventListener("click", () =>
      downloadJson(`${(state.draft.name || "scenario").replace(/[^\w-]+/g, "_")}.json`, state.draft)
    );
    document.getElementById("btn-delete")?.addEventListener("click", remove);
  }

  function setNotice(html) {
    state.notice = html;
    document.getElementById("editor-messages").innerHTML = html;
  }

  function problemsHtml(message, problems) {
    return `<div class="error-banner">${escapeHtml(message)}${problems?.length ? `<ul class="plain">${problems.map((p) => `<li>${escapeHtml(p)}</li>`).join("")}</ul>` : ""}</div>`;
  }

  async function save() {
    if (state.rawError) return setNotice(problemsHtml(state.rawError));
    if (state.invalid.size) {
      setNotice(invalidFieldsHtml());
      return false;
    }
    try {
      const { scenario } = await apiDetailed(`/api/scenarios/${encodeURIComponent(state.scenario.id)}`, {
        method: "PUT",
        body: JSON.stringify({ config: state.draft }),
      });
      state.scenario = scenario;
      state.draft = structuredClone(scenario.config);
      state.dirty = false;
      state.rawText = null;
      state.notice = `<div class="success-banner">Saved as version ${scenario.version}.</div>`;
      render();
      return true;
    } catch (err) {
      setNotice(problemsHtml(err.message, err.problems));
      return false;
    }
  }

  async function validate() {
    if (state.rawError) return setNotice(problemsHtml(state.rawError));
    if (state.invalid.size) return setNotice(invalidFieldsHtml());
    try {
      const result = await api("/api/scenarios/validate", { method: "POST", body: JSON.stringify({ config: state.draft }) });
      setNotice(result.ok ? `<div class="success-banner">Config is valid and runnable.</div>` : problemsHtml("Config has problems:", result.problems));
    } catch (err) {
      setNotice(problemsHtml(err.message));
    }
  }

  async function run() {
    if (!readOnly && state.dirty && !(await save())) return;
    const c = state.scenario.config;
    await openRunDialog(
      {
        id: state.scenario.id,
        name: state.scenario.name,
        language: c.conversation?.language ?? "en",
        presentationLanguages: Object.keys(c.presentation?.strings ?? {}),
        narrated: Boolean(c.presentation?.narrator),
      },
      meta
    );
  }

  async function duplicate() {
    try {
      const { scenario } = await api(`/api/scenarios/${encodeURIComponent(state.scenario.id)}/duplicate`, { method: "POST", body: "{}" });
      location.hash = `#/scenarios/${encodeURIComponent(scenario.id)}`;
    } catch (err) {
      setNotice(problemsHtml(err.message));
    }
  }

  async function remove() {
    if (!confirm(`Delete scenario "${state.scenario.name}"? Past runs keep their own config snapshot.`)) return;
    try {
      await api(`/api/scenarios/${encodeURIComponent(state.scenario.id)}`, { method: "DELETE" });
      location.hash = "#/scenarios";
    } catch (err) {
      setNotice(problemsHtml(err.message));
    }
  }

  render();
  // Self-hosted endpoints' model lists: fill in place when they arrive; re-render only if nobody is typing.
  for (const name of endpointNames(meta)) {
    loadEndpointModels(name).then((result) => {
      state.endpointModels[name] = result;
      const list = document.getElementById(`compat-models-${name}`);
      if (list) list.innerHTML = endpointModelOptions(result.models);
      if (!document.getElementById("editor-body")?.contains(document.activeElement)) render();
    });
  }
  // Fill the OpenRouter list in place when it arrives; re-render only if nobody is typing.
  loadOpenRouterCatalog().then((catalog) => {
    state.openRouter = catalog;
    const list = document.getElementById("openrouter-models");
    if (!list) return;
    list.innerHTML = openRouterOptions(catalog.models);
    if (!document.getElementById("editor-body")?.contains(document.activeElement)) render();
  });
}
