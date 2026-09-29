import {
  api,
  apiDetailed,
  app,
  badge,
  downloadJson,
  escapeHtml,
  formatCost,
  formatDuration,
  formatNumber,
  jsonBlock,
  outcomeBadge,
  phaseBadge,
  showError,
} from "../shared.js";

const POLL_MS = 1000;

/** Event types shown inline in the room only in debug mode — internal control metadata, not participant-facing. */
const DEBUG_TYPES = new Set([
  "agent_meta",
  "routing_decision",
  "readiness_changed",
  "readiness_invalidated",
  "proposal_frozen",
  "proposal_rejected_format",
  "proposal_declined",
  "vote_cast",
  "consensus_result",
  "evaluation_result",
  "protocol_incident",
  "operator_intervention",
  "error",
]);

function readDebugPref() {
  try {
    return localStorage.getItem("experiment.debug") === "1";
  } catch {
    return false;
  }
}

function writeDebugPref(on) {
  try {
    localStorage.setItem("experiment.debug", on ? "1" : "0");
  } catch {
    // storage unavailable — the toggle still works for this page view
  }
}

export async function renderExperiment(experimentId) {
  const route = location.hash;
  app.innerHTML = `<div class="loading">Loading…</div>`;

  const state = {
    experiment: null,
    live: null,
    running: false,
    events: [],
    lastSeq: 0,
    debug: readDebugPref(),
    traceFilter: "",
    timer: null,
  };

  try {
    await refresh();
  } catch (err) {
    app.innerHTML = "";
    showError(err.message);
    return;
  }

  const agentIndex = new Map(state.experiment.config.agents.map((a, i) => [a.id, i]));
  const agentName = (id) => state.experiment.config.agents.find((a) => a.id === id)?.name ?? id ?? "";

  async function refresh() {
    const [{ experiment, running, live }, { events }] = await Promise.all([
      api(`/api/experiments/${encodeURIComponent(experimentId)}`),
      api(`/api/experiments/${encodeURIComponent(experimentId)}/events?after=${state.lastSeq}`),
    ]);
    state.experiment = experiment;
    state.running = running;
    state.live = live;
    state.events.push(...events);
    if (events.length) state.lastSeq = events.at(-1).seq;
    return events;
  }

  // ------------------------------------------------------------------ room

  function roomItem(e) {
    const p = e.payload;
    const color = (id) => `agent-${(agentIndex.get(id) ?? 0) % 6}`;
    switch (e.type) {
      case "message_posted":
        if (p.sender.kind === "system") return `<div class="msg system"><span class="msg-author">Moderator</span><div class="msg-text">${escapeHtml(p.text)}</div></div>`;
        if (p.sender.kind === "narrator") return `<div class="msg narrator"><span class="msg-author">${escapeHtml(p.sender.name)}</span><span class="msg-index">narration · not shown to agents</span><div class="msg-text">${escapeHtml(p.text)}</div></div>`;
        return `<div class="msg ${color(p.sender.agentId)}"><span class="msg-author">${escapeHtml(agentName(p.sender.agentId))}</span><span class="msg-index">#${p.index}</span><div class="msg-text">${escapeHtml(p.text)}</div></div>`;
      case "phase_changed":
        return `<div class="phase-divider">${escapeHtml(p.to)}${p.discussionEnd ? ` · ${escapeHtml(p.discussionEnd)}` : ""}</div>`;
      default:
        if (!state.debug || !DEBUG_TYPES.has(e.type)) return "";
        return `<div class="msg debug"><span class="debug-type">${escapeHtml(e.type)}</span>${e.agentId ? ` <strong>${escapeHtml(agentName(e.agentId))}</strong>` : ""} ${escapeHtml(debugSummary(e))}</div>`;
    }
  }

  function debugSummary(e) {
    const p = e.payload;
    switch (e.type) {
      case "agent_meta":
        return `${p.pass ? "PASS" : "message"} · target=${p.target ?? "—"} · intent=${p.intent ?? "—"} · ready=${p.readyToCommit}`;
      case "routing_decision":
        return `→ ${agentName(p.agentId)} [${p.source}] ${p.reason ?? ""}`;
      case "readiness_changed":
      case "readiness_invalidated":
        return `${p.from} → ${p.to} (at #${p.atIndex})`;
      case "vote_cast":
        return `${p.vote}${p.reason ? ` — ${p.reason}` : ""}`;
      case "consensus_result":
        return `${p.reached ? "reached" : "not reached"} (${p.approvals}/${p.eligible}, ${p.rule} needs ${p.required})`;
      case "proposal_frozen":
        return `${p.id} hash=${String(p.hash).slice(0, 12)}…`;
      case "proposal_rejected_format":
        return `${p.kind}: ${p.error}`;
      case "evaluation_result":
        return `${p.outcome}${p.violated?.length ? ` — violated: ${p.violated.join(", ")}` : ""}`;
      case "protocol_incident":
        return `${p.kind}: ${p.error ?? ""}`;
      case "operator_intervention":
        return JSON.stringify(p.command);
      default:
        return p.message ?? "";
    }
  }

  function renderRoom() {
    const room = document.getElementById("room");
    if (!room) return;
    const html = state.events.map(roomItem).join("");
    const atBottom = room.scrollHeight - room.scrollTop - room.clientHeight < 40;
    room.innerHTML = html || `<div class="muted">No messages yet.</div>`;
    if (atBottom || state.running) room.scrollTop = room.scrollHeight;
  }

  // ------------------------------------------------------------------ state panel

  function renderStatePanel() {
    const el = document.getElementById("state-panel");
    if (!el) return;
    const live = state.live;
    const summary = state.experiment.summary;
    const config = state.experiment.config;

    if (live) {
      const readiness = Object.entries(live.readiness)
        .map(([id, r]) => `<div>${escapeHtml(agentName(id))} ${badge(r.state, r.state === "ready" ? "ok" : r.state === "stale" ? "warn" : "neutral")}</div>`)
        .join("");
      const routing = live.lastRouting
        ? `${escapeHtml(agentName(live.lastRouting.agentId))} ${badge(live.lastRouting.source, "info")}<div class="muted small">${escapeHtml(live.lastRouting.reason)}</div>`
        : "—";
      el.innerHTML = `
        <dl class="kv">
          <dt>Phase</dt><dd>${phaseBadge(live.phase)} ${live.paused ? badge("PAUSED", "warn") : ""}</dd>
          <dt>Current agent</dt><dd>${escapeHtml(agentName(live.currentAgentId) || "—")}</dd>
          <dt>Next (operator)</dt><dd>${escapeHtml(agentName(live.pendingNextAgentId) || "—")}</dd>
          <dt>Turns</dt><dd>${live.turn} / ${live.globalTurnLimit}</dd>
          <dt>Discussion</dt><dd>${live.discussion.turnsUsed} / ${live.discussion.turnLimit} (round ${live.discussion.segment})</dd>
          <dt>Proposal attempt</dt><dd>${live.proposalAttempt} / ${live.maxProposalAttempts}</dd>
          <dt>Tokens</dt><dd>${formatNumber(live.usage.agentTokens)} agent · ${formatNumber(live.usage.orchestrationTokens)} orch · <strong>${formatNumber(live.usage.totalTokens)}</strong></dd>
          <dt>Cost</dt><dd>${formatCost(live.usage.costUsd)}${live.usage.callsWithUnknownCost ? ` <span class="muted">(+${live.usage.callsWithUnknownCost} unknown)</span>` : ""}</dd>
          <dt>Elapsed</dt><dd>${formatDuration(live.activeElapsedMs)}${config.limits.timeLimitSeconds ? ` / ${config.limits.timeLimitSeconds}s` : ""}</dd>
          <dt>Last routing</dt><dd>${routing}</dd>
          <dt>Readiness</dt><dd>${readiness}</dd>
        </dl>`;
    } else if (summary) {
      el.innerHTML = `
        <dl class="kv">
          <dt>Phase</dt><dd>${phaseBadge(state.experiment.phase)}</dd>
          <dt>Turns</dt><dd>${summary.turns.total} / ${config.limits.globalTurnLimit}</dd>
          <dt>Tokens</dt><dd>${formatNumber(summary.tokens.agent)} agent · ${formatNumber(summary.tokens.orchestration)} orch · <strong>${formatNumber(summary.tokens.total)}</strong></dd>
          <dt>Cost</dt><dd>${formatCost(summary.costUsd.total)}</dd>
          <dt>Duration</dt><dd>${formatDuration(summary.durationMs.active)} active</dd>
        </dl>`;
    } else {
      el.innerHTML = `<div class="muted">Starting…</div>`;
    }
  }

  // ------------------------------------------------------------------ controls

  function renderControls() {
    const el = document.getElementById("controls");
    if (!el) return;
    const live = state.live;
    if (!state.running || !live) {
      el.innerHTML = "";
      return;
    }
    const inDiscussion = live.phase === "DISCUSSION";
    const previousChoice = document.getElementById("next-agent")?.value; // survives the per-poll re-render
    const options = state.experiment.config.agents
      .map((a) => `<option value="${escapeHtml(a.id)}" ${a.id === previousChoice ? "selected" : ""}>${escapeHtml(a.name)}</option>`)
      .join("");
    el.innerHTML = `
      <div class="card controls">
        <button data-cmd="${live.paused ? "resume" : "pause"}">${live.paused ? "Resume" : "Pause"}</button>
        <button data-cmd="step" ${live.paused ? "" : "disabled"} title="While paused: run exactly one more activation">Force next turn</button>
        <span class="control-group">
          <select id="next-agent" ${inDiscussion ? "" : "disabled"}>${options}</select>
          <button data-cmd="select_next" ${inDiscussion ? "" : "disabled"}>Select next agent</button>
        </span>
        <button data-cmd="force_decision" ${inDiscussion ? "" : "disabled"}>Force decision</button>
        <button data-cmd="stop" class="danger">Stop</button>
        <span class="muted small">Selecting, forcing and stopping are recorded as manual interventions.</span>
      </div>`;
    el.querySelectorAll("[data-cmd]").forEach((btn) =>
      btn.addEventListener("click", async () => {
        const type = btn.dataset.cmd;
        if (type === "stop" && !confirm("Stop this experiment? It ends as STOPPED_BY_OPERATOR.")) return;
        const command = type === "select_next" ? { type, agentId: document.getElementById("next-agent").value } : { type };
        try {
          const { live } = await api(`/api/experiments/${encodeURIComponent(experimentId)}/control`, { method: "POST", body: JSON.stringify(command) });
          state.live = live;
          renderControls();
          renderStatePanel();
        } catch (err) {
          showError(err.message);
        }
      })
    );
  }

  // ------------------------------------------------------------------ results

  function renderResults() {
    const el = document.getElementById("results");
    if (!el) return;
    const s = state.experiment.summary;
    if (!s || state.running) {
      el.innerHTML = "";
      return;
    }
    const t = s.termination ?? {};
    const agents = state.experiment.config.agents;

    const perAgent = agents
      .map((a) => {
        const tok = s.tokens.byAgent[a.id] ?? { prompt: 0, completion: 0, total: 0 };
        return `<tr><td>${escapeHtml(a.name)}</td><td class="muted">${escapeHtml(a.model.provider)}/${escapeHtml(a.model.model)}</td>
          <td>${s.turns.byAgent[a.id] ?? 0}</td><td>${s.messages.byAgent[a.id] ?? 0}</td><td>${s.passes.byAgent[a.id] ?? 0}</td>
          <td>${formatNumber(tok.prompt)}</td><td>${formatNumber(tok.completion)}</td><td>${formatNumber(tok.total)}</td></tr>`;
      })
      .join("");

    const votes = (s.votes.final ?? [])
      .map((v) => `<tr><td>${escapeHtml(agentName(v.agentId))}</td><td>${badge(v.vote, v.vote === "APPROVE" ? "ok" : "bad")}</td><td>${escapeHtml(v.reason)}</td></tr>`)
      .join("");

    const checks = s.evaluation?.checks
      ? Object.entries(s.evaluation.checks)
          .map(([name, c]) => `<tr><td>${escapeHtml(name)}</td><td>${badge(c.passed ? "pass" : "fail", c.passed ? "ok" : "bad")}</td><td>${escapeHtml(c.detail)}</td></tr>`)
          .join("")
      : "";

    const routing = Object.entries(s.routing.bySource)
      .map(([source, n]) => `${badge(source, "info")} ${n}`)
      .join(" &nbsp; ");

    const incidents = Object.entries(s.protocolIncidents);

    el.innerHTML = `
      <div class="card">
        <h2>Outcome</h2>
        <div class="outcome-line">${outcomeBadge(t.outcome)} ${badge(t.category ?? "", "neutral")} <span>${escapeHtml(t.reason ?? "")}</span></div>
        ${
          s.intervened
            ? `<div class="warning-banner">Manual intervention: this run is not autonomous (${s.interventions.filter((i) => i.flowAltering).map((i) => escapeHtml(i.command.type)).join(", ")}).</div>`
            : ""
        }
        <dl class="kv">
          <dt>Consensus</dt><dd>${s.consensusReached ? badge("reached", "ok") : badge("not reached", "neutral")} ${s.votes.rounds.length} voting round(s)</dd>
          <dt>Proposals</dt><dd>${s.proposals.attempts} attempt(s), ${s.proposals.formatRejections} format rejection(s), ${s.proposals.declined} declined</dd>
          <dt>Turns</dt><dd>${s.turns.total} (${Object.entries(s.turns.byKind).map(([k, n]) => `${k} ${n}`).join(", ")})</dd>
          <dt>Messages</dt><dd>${s.messages.public} public, ${s.messages.system} moderator, ${s.passes.total} passes</dd>
          <dt>Tokens</dt><dd>${formatNumber(s.tokens.agent)} agent + ${formatNumber(s.tokens.orchestration)} orchestration = <strong>${formatNumber(s.tokens.total)}</strong></dd>
          <dt>Cost (est.)</dt><dd>${formatCost(s.costUsd.total)} (agent ${formatCost(s.costUsd.agent)}, orchestration ${formatCost(s.costUsd.orchestration)})${s.costUsd.callsWithUnknownCost ? ` — ${s.costUsd.callsWithUnknownCost} call(s) of unknown cost` : ""}</dd>
          <dt>LLM calls</dt><dd>${s.llmCalls.total} (${s.llmCalls.failed} failed, ${s.llmCalls.parseFailures} unparseable)</dd>
          <dt>Duration</dt><dd>${formatDuration(s.durationMs.active)} active, ${formatDuration(s.durationMs.wall)} wall${s.durationMs.presentation ? `, ${formatDuration(s.durationMs.presentation)} presentation pacing` : ""}${s.durationMs.paused ? `, ${formatDuration(s.durationMs.paused)} paused` : ""}</dd>
          <dt>Language</dt><dd>${escapeHtml(state.experiment.config.conversation?.language ?? "en")}</dd>
          <dt>Task definition</dt><dd class="muted small">${escapeHtml((state.experiment.taskDefinitionHash ?? "—").slice(0, 16))}</dd>
          <dt>Routing</dt><dd>${routing || "—"}${s.routing.invalidExplicitTargets ? ` · ${s.routing.invalidExplicitTargets} invalid target(s)` : ""}${s.routing.classifierFailures ? ` · ${s.routing.classifierFailures} classifier failure(s)` : ""}</dd>
          <dt>Readiness invalidations</dt><dd>${s.readiness.invalidations}</dd>
          ${incidents.length ? `<dt>Protocol incidents</dt><dd>${incidents.map(([k, n]) => `${escapeHtml(k)} ${n}`).join(", ")}</dd>` : ""}
        </dl>
      </div>
      <div class="grid-2">
        <div class="card">
          <h2>Final proposal</h2>
          ${
            s.proposals.final
              ? `<p class="muted small">${escapeHtml(s.proposals.final.id)} · by ${escapeHtml(agentName(s.proposals.final.proposerId))} · hash ${escapeHtml(s.proposals.final.hash.slice(0, 16))}…</p>
                 ${jsonBlock(s.proposals.final.body)}
                 <p>${escapeHtml(s.proposals.final.rationale)}</p>`
              : `<p class="muted">No proposal was voted on.</p>`
          }
        </div>
        <div class="card">
          <h2>Votes</h2>
          ${votes ? `<table><thead><tr><th>Agent</th><th>Vote</th><th>Reason</th></tr></thead><tbody>${votes}</tbody></table>` : `<p class="muted">No votes.</p>`}
        </div>
      </div>
      <div class="card">
        <h2>Evaluator</h2>
        ${
          s.evaluation
            ? `<p>${outcomeBadge(s.evaluation.outcome)} <span class="muted">${escapeHtml(s.evaluation.evaluator)} v${escapeHtml(s.evaluation.evaluatorVersion)}</span></p>
               <table><thead><tr><th>Check</th><th>Result</th><th>Detail</th></tr></thead><tbody>${checks}</tbody></table>`
            : `<p class="muted">Nothing was committed, so nothing was evaluated.</p>`
        }
      </div>
      <div class="card overflow-x">
        <h2>Per-agent usage</h2>
        <table><thead><tr><th>Agent</th><th>Model</th><th>Turns</th><th>Messages</th><th>Passes</th><th>Prompt tok</th><th>Completion tok</th><th>Total tok</th></tr></thead><tbody>${perAgent}</tbody></table>
      </div>`;
  }

  // ------------------------------------------------------------------ trace

  function renderTrace() {
    const el = document.getElementById("trace");
    if (!el) return;
    const start = state.events[0] ? new Date(state.events[0].ts).getTime() : 0;
    const types = [...new Set(state.events.map((e) => e.type))].sort();
    const shown = state.traceFilter ? state.events.filter((e) => e.type === state.traceFilter) : state.events;
    el.innerHTML = `
      <details class="card" ${el.dataset.open === "1" ? "open" : ""}>
        <summary><h2>Event trace (${state.events.length})</h2></summary>
        <div class="row">
          <select id="trace-filter"><option value="">all event types</option>${types.map((t) => `<option ${t === state.traceFilter ? "selected" : ""}>${escapeHtml(t)}</option>`).join("")}</select>
        </div>
        <div class="overflow-x"><table class="trace">
          <thead><tr><th>#</th><th>+time</th><th>Phase</th><th>Type</th><th>Agent</th><th>Summary</th></tr></thead>
          <tbody>${shown
            .map(
              (e) => `<tr class="link-row" data-seq="${e.seq}"><td>${e.seq}</td><td>${formatDuration(new Date(e.ts).getTime() - start)}</td>
                <td>${escapeHtml(e.phase ?? "")}</td><td>${escapeHtml(e.type)}</td><td>${escapeHtml(agentName(e.agentId))}</td>
                <td class="small">${escapeHtml(traceSummary(e))}</td></tr>`
            )
            .join("")}</tbody>
        </table></div>
      </details>`;
    const details = el.querySelector("details");
    details.addEventListener("toggle", () => (el.dataset.open = details.open ? "1" : "0"));
    document.getElementById("trace-filter").addEventListener("change", (ev) => {
      state.traceFilter = ev.target.value;
      renderTrace();
    });
    el.querySelectorAll("tr[data-seq]").forEach((row) =>
      row.addEventListener("click", () => {
        const next = row.nextElementSibling;
        if (next?.classList.contains("payload-row")) return next.remove();
        const event = state.events.find((e) => e.seq === Number(row.dataset.seq));
        row.insertAdjacentHTML("afterend", `<tr class="payload-row"><td colspan="6">${jsonBlock(event.payload)}</td></tr>`);
      })
    );
  }

  function traceSummary(e) {
    const p = e.payload;
    if (e.type === "llm_call") {
      const usage = p.usage ? `${p.usage.promptTokens}+${p.usage.completionTokens} tok` : "no usage";
      return `${p.purpose} · ${p.servedModel ?? p.requestedModel} · ${usage}${p.error ? ` · ERROR ${p.error.message}` : ""}${p.parseOk === false ? ` · parse failed` : ""}`;
    }
    if (e.type === "message_posted") return String(p.text).slice(0, 140);
    if (e.type === "phase_changed") return `${p.from} → ${p.to}`;
    if (e.type === "experiment_finished") return `${p.termination?.outcome}: ${p.termination?.reason}`;
    if (DEBUG_TYPES.has(e.type)) return debugSummary(e);
    return "";
  }

  // ------------------------------------------------------------------ page

  function renderHeader() {
    const el = document.getElementById("exp-header");
    if (!el) return;
    const e = state.experiment;
    el.innerHTML = `
      <h1>${escapeHtml(e.config.name)} ${outcomeBadge(e.outcome, state.running)} ${e.intervened ? badge("manual intervention", "warn") : ""}</h1>
      <div class="actions">
        <a class="button-like" href="#/watch/${encodeURIComponent(experimentId)}">Viewer mode</a>
        <button id="btn-rerun">Rerun same config</button>
        <button id="btn-export">Export JSON</button>
        ${e.scenarioId ? `<a class="button-like" href="#/scenarios/${encodeURIComponent(e.scenarioId)}">Open scenario</a>` : ""}
      </div>`;
    document.getElementById("btn-rerun").addEventListener("click", async () => {
      try {
        const { id } = await apiDetailed(`/api/experiments/${encodeURIComponent(experimentId)}/rerun`, { method: "POST", body: "{}" });
        location.hash = `#/experiments/${encodeURIComponent(id)}`;
      } catch (err) {
        showError(err.message, err.problems);
      }
    });
    document.getElementById("btn-export").addEventListener("click", async () => {
      try {
        downloadJson(`experiment-${experimentId}.json`, await api(`/api/experiments/${encodeURIComponent(experimentId)}/export`));
      } catch (err) {
        showError(err.message);
      }
    });
  }

  app.innerHTML = `
    <div class="breadcrumb"><a href="#/experiments">Experiments</a> / <span class="muted">${escapeHtml(experimentId)}</span></div>
    <div class="page-header" id="exp-header"></div>
    <div id="controls"></div>
    <div class="live-grid">
      <div class="card room-card">
        <div class="row"><h2>Room</h2><label class="check small"><input type="checkbox" id="debug-toggle" ${state.debug ? "checked" : ""}/> debug: show control metadata</label></div>
        <div id="room" class="room"></div>
      </div>
      <div class="card"><h2>Runtime state</h2><div id="state-panel"></div></div>
    </div>
    <div id="results"></div>
    <div id="trace"></div>`;

  document.getElementById("debug-toggle").addEventListener("change", (ev) => {
    state.debug = ev.target.checked;
    writeDebugPref(state.debug);
    renderRoom();
  });

  function renderAll() {
    renderHeader();
    renderControls();
    renderRoom();
    renderStatePanel();
    renderResults();
    renderTrace();
  }
  renderAll();

  async function poll() {
    if (location.hash !== route) return; // navigated away
    const wasRunning = state.running;
    try {
      const fresh = await refresh();
      if (location.hash !== route) return;
      if (!state.running && wasRunning) {
        renderAll();
      } else {
        if (fresh.length) {
          renderRoom();
          renderTrace();
        }
        renderStatePanel();
        renderControls();
      }
    } catch (err) {
      showError(err.message);
    }
    if (state.running) state.timer = setTimeout(poll, POLL_MS);
  }
  if (state.running) state.timer = setTimeout(poll, POLL_MS);
}
