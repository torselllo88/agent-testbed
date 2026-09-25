import { api, apiDetailed, app, badge, downloadJson, escapeHtml, getPath, jsonBlock, setPath, showError } from "../shared.js";

// Form <-> config binding: every input carries data-path (dotted path into
// the draft config) and data-kind (how to coerce its value). Text edits
// update the draft in place without re-rendering (keeps focus); structural
// edits (scheduler type, adding an agent, ...) re-render the editor.

const TABS = [
  ["general", "Task"],
  ["agents", "Agents"],
  ["protocol", "Protocol"],
  ["limits", "Limits"],
  ["evaluator", "Evaluator"],
  ["raw", "Raw JSON"],
];

const PROVIDERS = ["openrouter", "azure", "stub"];

function field(label, inner, hint) {
  return `<label class="field"><span class="field-label">${escapeHtml(label)}</span>${inner}${hint ? `<span class="field-hint">${escapeHtml(hint)}</span>` : ""}</label>`;
}

function valueAttr(v) {
  return v === undefined || v === null ? "" : escapeHtml(String(v));
}

export async function renderScenarioEditor(scenarioId, initialTab) {
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
    notice: null,
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

  const modelFields = (base) => `
    <div class="grid-4">
      ${field("Provider", select(`${base}.provider`, PROVIDERS.map((p) => [p, p])))}
      ${field("Model", input(`${base}.model`, "string", `list="stub-models"`), "OpenRouter model id, Azure deployment, or stub script")}
      ${field("Temperature", input(`${base}.temperature`, "optional-number", `step="0.1" min="0" max="2"`), "blank = provider default")}
      ${field("Max output tokens", input(`${base}.maxOutputTokens`, "optional-number", `min="1"`), "blank = no cap")}
    </div>
    <div class="grid-4">
      ${field("Structured output", select(`${base}.structuredOutput`, [["native", "native (provider-enforced schema)"], ["prompt", "prompt only"]]))}
      ${field("Seed", input(`${base}.seed`, "optional-number"), "best-effort, recorded only")}
    </div>`;

  const tabBody = {
    general: () => `
      ${field("Name", input("name"))}
      ${field("Description", textarea("description", 2))}
      ${field("Task description", textarea("task.description", 3), "Given to every agent")}
      ${field("Shared context", textarea("task.sharedContext", 12), "Known to every agent")}`,

    agents: () =>
      state.draft.agents
        .map(
          (agent, i) => `
        <div class="card agent-card">
          <div class="row"><h3>${escapeHtml(agent.name || agent.id)}</h3>
            <button type="button" class="danger" data-action="remove-agent" data-index="${i}" ${state.draft.agents.length <= 2 ? "disabled" : ""}>Remove</button></div>
          <div class="grid-3">
            ${field("Id", input(`agents.${i}.id`))}
            ${field("Display name", input(`agents.${i}.name`))}
            ${field("Role", input(`agents.${i}.role`))}
          </div>
          ${modelFields(`agents.${i}.model`)}
          ${field("System prompt", textarea(`agents.${i}.systemPrompt`, 3))}
          ${field("Private context", textarea(`agents.${i}.privateContext`, 8), "Visible only to this agent")}
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
      <h3>Agent visibility</h3>
      ${checkbox("agentVisibility.discussionBudget", "Show agents the discussion turn budget and proposal attempt (changes agent behavior — off for baseline runs)")}
      <h3>Transport</h3>
      ${field("Transport", select("transport.type", [["local", "local"], ["chums", "chums (not implemented yet)"]], { structural: true }))}`;
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

    raw: () => `
      <p class="muted">The complete config. Edits here replace the form state; invalid JSON is not applied.</p>
      <div id="raw-error">${state.rawError ? `<div class="error-banner">${escapeHtml(state.rawError)}</div>` : ""}</div>
      <textarea id="raw-json" class="code" spellcheck="false">${escapeHtml(state.rawText ?? JSON.stringify(state.draft, null, 2))}</textarea>`,
  };

  function render() {
    const s = state.scenario;
    app.innerHTML = `
      <div class="breadcrumb"><a href="#/scenarios">Scenarios</a> / ${escapeHtml(s.name)}</div>
      <div class="page-header">
        <h1>${escapeHtml(state.draft.name || s.name)} ${badge(`v${s.version}`, "neutral")} ${state.dirty ? badge("unsaved changes", "warn") : ""}</h1>
        <div class="actions">
          <button id="btn-save" class="primary" ${state.dirty ? "" : "disabled"}>Save</button>
          <button id="btn-validate">Validate</button>
          <button id="btn-run" class="primary">Run</button>
          <button id="btn-duplicate">Duplicate</button>
          <button id="btn-export">Export</button>
          <button id="btn-delete" class="danger">Delete</button>
        </div>
      </div>
      <div id="editor-messages">${state.notice ?? ""}</div>
      <div class="tabs">${TABS.map(([key, label]) => `<button type="button" class="tab ${state.tab === key ? "active" : ""}" data-tab="${key}">${label}</button>`).join("")}</div>
      <div class="card editor-body" id="editor-body">${tabBody[state.tab]()}</div>
      <datalist id="stub-models">${meta.stubModels.map((m) => `<option value="${escapeHtml(m)}">`).join("")}</datalist>
    `;
    // Synthetic checkbox: the classifier toggle maps to classifier null vs. a model ref.
    const toggle = app.querySelector('[data-path="scheduler.__classifierEnabled"]');
    if (toggle) toggle.checked = Boolean(state.draft.scheduler.classifier);
    bind();
  }

  function markDirty() {
    if (!state.dirty) {
      state.dirty = true;
      const save = document.getElementById("btn-save");
      if (save) save.disabled = false;
      const h1 = app.querySelector(".page-header h1");
      if (h1 && !h1.innerHTML.includes("unsaved")) h1.insertAdjacentHTML("beforeend", ` ${badge("unsaved changes", "warn")}`);
    }
  }

  function applyStructural(path, value) {
    if (path === "scheduler.type") {
      const startAgentId = state.draft.scheduler.startAgentId;
      state.draft.scheduler =
        value === "hybrid" ? { type: "hybrid", startAgentId, classifier: null, classifierWindow: 12 } : { type: "round_robin", startAgentId };
    } else if (path === "scheduler.__classifierEnabled") {
      state.draft.scheduler.classifier = value ? { provider: "stub", model: meta.stubModels.find((m) => m.startsWith("router/")) ?? "", structuredOutput: "native" } : null;
    } else if (path === "transport.type") {
      state.draft.transport = { type: value };
    } else {
      setPath(state.draft, path, value);
    }
  }

  function coerce(el) {
    const kind = el.dataset.kind;
    if (kind === "bool") return { ok: true, value: el.checked };
    const raw = el.value;
    if (kind === "number") return raw === "" ? { ok: false } : { ok: true, value: Number(raw) };
    if (kind === "nullable-number") return { ok: true, value: raw === "" ? null : Number(raw) };
    if (kind === "optional-number") return { ok: true, value: raw === "" ? undefined : Number(raw) };
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
      if (!result.ok) return;
      if (result.value === undefined) {
        const parts = el.dataset.path.split(".");
        const parent = getPath(state.draft, parts.slice(0, -1).join("."));
        if (parent) delete parent[parts.at(-1)];
      } else {
        setPath(state.draft, el.dataset.path, result.value);
      }
      markDirty();
    });

    body.addEventListener("change", (e) => {
      const el = e.target;
      if (!el.dataset.path) return;
      const structural = el.dataset.structural !== undefined || el.dataset.path.includes("__");
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
      }
    });

    app.querySelectorAll(".tab").forEach((btn) =>
      btn.addEventListener("click", () => {
        if (state.tab === "raw" && state.rawError) return; // don't leave the raw view with unparsed edits
        state.tab = btn.dataset.tab;
        // Deep-linkable tab, without triggering the hash router.
        history.replaceState(null, "", `#/scenarios/${encodeURIComponent(state.scenario.id)}?tab=${state.tab}`);
        state.rawText = null;
        state.notice = null;
        render();
      })
    );

    document.getElementById("btn-save").addEventListener("click", save);
    document.getElementById("btn-validate").addEventListener("click", validate);
    document.getElementById("btn-run").addEventListener("click", run);
    document.getElementById("btn-duplicate").addEventListener("click", duplicate);
    document.getElementById("btn-export").addEventListener("click", () =>
      downloadJson(`${(state.draft.name || "scenario").replace(/[^\w-]+/g, "_")}.json`, state.draft)
    );
    document.getElementById("btn-delete").addEventListener("click", remove);
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
    try {
      const result = await api("/api/scenarios/validate", { method: "POST", body: JSON.stringify({ config: state.draft }) });
      setNotice(result.ok ? `<div class="success-banner">Config is valid and runnable.</div>` : problemsHtml("Config has problems:", result.problems));
    } catch (err) {
      setNotice(problemsHtml(err.message));
    }
  }

  async function run() {
    if (state.dirty && !(await save())) return;
    try {
      const { id } = await apiDetailed(`/api/scenarios/${encodeURIComponent(state.scenario.id)}/run`, { method: "POST", body: "{}" });
      location.hash = `#/experiments/${encodeURIComponent(id)}`;
    } catch (err) {
      setNotice(problemsHtml(err.message, err.problems));
    }
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
}
