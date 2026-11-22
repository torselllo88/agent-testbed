import { api, app, escapeHtml, showError } from "../shared.js";

/**
 * Research demo (#/research): the pilot's dev runs as a replay. Three actions — pick an instance,
 * compare its Complete and Ring runs side by side, open the information flow — and two more tabs:
 * the batch of all pairs and the methods. Everything comes from GET /api/pilot-demo (overview,
 * batch, methods) and GET /api/pilot-demo/instances/<id> (the pair, what every agent received,
 * the detector's view of every fact).
 */

const AGENTS = ["Operations", "Contract", "Compliance", "Settlement", "Verification", "Treasury"];
const SHORT = { Operations: "Ops", Contract: "Con", Compliance: "Cmp", Settlement: "Set", Verification: "Ver", Treasury: "Tre" };
const agentClass = (role) => `agent-bg-${AGENTS.indexOf(role)}`;

const fmtProposal = (p) => (p ? `${p.action}${p.destination ? ` ${p.destination}` : ""}${p.rail ? ` / Rail ${p.rail}` : ""}${p.reason ? ` (${p.reason})` : ""}` : "—");
const fmtValue = (v) => (typeof v === "boolean" ? (v ? "true" : "false") : String(v));
const n = (v) => (v === null || v === undefined ? "—" : typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(1)) : String(v));

/** Page state kept across re-renders of the tabs. */
const state = { overview: null, instance: null, view: null, tab: "compare", focus: null, fact: null, replayView: null, live: null, poll: null };

export async function renderResearch(instanceId) {
  app.innerHTML = `<div class="loading">Loading…</div>`;
  try {
    state.overview = await api("/api/pilot-demo");
  } catch (err) {
    app.innerHTML = "";
    showError(err.message);
    return;
  }
  if (!state.overview.available) {
    app.innerHTML = `<div class="demo"><header class="demo-hero"><h1>Research demo</h1><p class="demo-lead">No replay dataset is installed: experiments/pilot-settlement/demo/dev-runs/ holds no paired run logs.</p></header></div>`;
    return;
  }
  const wanted = instanceId ?? state.instance ?? state.overview.instances[0]?.id ?? null;
  await selectInstance(wanted, true);
}

async function selectInstance(id, first = false) {
  if (!id) return;
  if (state.instance !== id || !state.view) {
    state.view = await api(`/api/pilot-demo/instances/${encodeURIComponent(id)}`);
    state.replayView = state.view;
    state.instance = id;
    state.focus = null;
    state.fact = null;
    if (!first) history.replaceState(null, "", `#/research/${encodeURIComponent(id)}`);
  }
  renderPage();
}

/** Whether the page currently shows a live run's view instead of the replay. */
const showingLive = () => state.live?.stage === "done" && state.view === state.live.view;

async function startLive() {
  try {
    const session = await api("/api/pilot-demo/live", { method: "POST", body: JSON.stringify({ instance: state.instance }) });
    state.live = session;
    renderPage();
    pollLive();
  } catch (err) {
    state.live = { stage: "failed", error: err.message, instance: state.instance, runs: {} };
    renderPage();
  }
}

function pollLive() {
  clearTimeout(state.poll);
  state.poll = setTimeout(async () => {
    if (!state.live?.id) return;
    try {
      const s = await api(`/api/pilot-demo/live/${encodeURIComponent(state.live.id)}`);
      state.live = s;
      if (s.stage === "done" && s.view) {
        state.view = s.view;
        state.focus = null;
        state.fact = null;
        state.tab = "compare";
        renderPage();
        return;
      }
      renderLiveLine();
      if (s.stage !== "failed") pollLive();
      else renderPage();
    } catch (err) {
      state.live.error = err.message;
      renderPage();
    }
  }, 3000);
}

function liveLineHtml() {
  const o = state.overview;
  const l = state.live;
  if (!o.live?.available) return `<span class="muted small">Live run: not offered here (no OpenRouter key).</span>`;
  if (!l || l.instance !== state.instance) {
    return `<button type="button" class="button-like" id="research-live">Run this instance live</button> <span class="muted small">${escapeHtml(o.live.agents)} via OpenRouter · Complete, then Ring, then the detector · about 10–15 minutes · exploratory, n = 1</span>`;
  }
  const run = (r) => `${r.topology}: ${r.status === "pending" ? "waiting" : r.status === "running" ? `turn ${r.turn} of 18` : r.outcome ?? r.status}`;
  if (l.stage === "failed") return `<span class="badge bad">live run failed</span> <span class="small">${escapeHtml(l.error ?? "")}</span> <button type="button" class="button-like" id="research-live">Try again</button>`;
  if (l.stage === "done") {
    return showingLive()
      ? `<span class="badge warn">showing the live run</span> <span class="small">exploratory, n = 1, ${escapeHtml(l.models.agents)}; not the pilot instrument</span> <button type="button" class="button-like" id="research-replay">Back to the replay</button>`
      : `<span class="badge ok">live run finished</span> <button type="button" class="button-like" id="research-show-live">Show the live run</button> <button type="button" class="button-like" id="research-live">Run again</button>`;
  }
  const det = l.detector ? ` · detector ${l.detector.done} of ${l.detector.messages} messages${l.detector.failures ? `, ${l.detector.failures} failed` : ""}` : "";
  return `<span class="badge info">live run in progress</span> <span class="small">${run(l.runs.complete)} · ${run(l.runs.ring)}${det}</span>`;
}

function renderLiveLine() {
  const box = document.getElementById("research-live-line");
  if (!box) return;
  box.innerHTML = liveLineHtml();
  document.getElementById("research-live")?.addEventListener("click", () => void startLive());
  document.getElementById("research-show-live")?.addEventListener("click", () => {
    state.view = state.live.view;
    state.focus = null;
    state.fact = null;
    renderPage();
  });
  document.getElementById("research-replay")?.addEventListener("click", () => {
    state.view = state.replayView;
    state.focus = null;
    state.fact = null;
    renderPage();
  });
}

function renderPage() {
  const o = state.overview;
  const v = state.view;
  const inst = o.instances.find((i) => i.id === state.instance);
  const options = o.instances.map((i) => `<option value="${i.id}" ${i.id === state.instance ? "selected" : ""}>${i.id} · class ${i.class}${i.subtype ? ` / ${i.subtype}` : ""} · canonical ${fmtProposal(i.canonical)}</option>`).join("");
  const tabs = [
    ["compare", "1 · Compare Complete vs Ring"],
    ["flow", "2 · Information flow"],
    ["batch", "Batch: all pairs"],
    ["methods", "Methods"],
  ];
  app.innerHTML = `
    <div class="research">
      <header class="page-header">
        <div>
          <h1>Research demo · Distributed Settlement</h1>
          <p class="muted">One instance, two communication graphs, the same seeds. Pick an instance, compare the two runs, then follow every private fact through the graph to the proposer.</p>
        </div>
      </header>
      <div class="research-bar">
        <label class="research-pick">Instance
          <select id="research-instance">${options}</select>
        </label>
        <span class="muted">${inst ? `requested ${escapeHtml(inst.requested)} · canonical <strong>${escapeHtml(fmtProposal(inst.canonical))}</strong>` : ""}</span>
      </div>
      <div class="research-bar" id="research-live-line"></div>
      ${showingLive() ? `<div class="warning-banner small">Live run on ${escapeHtml(state.live.models.agents)} via OpenRouter, started ${escapeHtml(state.live.startedAt.slice(0, 16).replace("T", " "))} UTC: exploratory — the plan's endpoint settings are not enforced, token counts are the pilot tokenizer's approximation, there is no environment record, and one run proves nothing. The replay above the tabs is the validated instrument.</div>` : ""}
      <div class="tabs">${tabs.map(([k, label]) => `<button type="button" class="tab ${state.tab === k ? "active" : ""}" data-tab="${k}">${label}</button>`).join("")}</div>
      <div id="research-body"></div>
    </div>`;
  document.getElementById("research-instance").addEventListener("change", (e) => void selectInstance(e.target.value));
  renderLiveLine();
  for (const b of app.querySelectorAll(".tab")) b.addEventListener("click", () => { state.tab = b.dataset.tab; renderPage(); });
  const body = document.getElementById("research-body");
  if (state.tab === "compare") renderCompare(body, v);
  else if (state.tab === "flow") renderFlow(body, v);
  else if (state.tab === "batch") renderBatch(body, o.batch);
  else renderMethods(body, o.methods);
}

// ---------------------------------------------------------------- 1 · compare

function runHeader(run, v) {
  const f = run.final;
  const ok = f.correct ? `<span class="badge ok">exact</span>` : `<span class="badge bad">${f.schema_valid ? "wrong" : f.model_failure ? "model failure" : "schema failure"}</span>`;
  const graph = run.topology === "ring" ? `ring: ${run.ring_positions.map((r) => SHORT[r]).join(" → ")} → ${SHORT[run.ring_positions[0]]}` : "complete graph: everyone hears everyone";
  return `
    <div class="research-run-head">
      <h2>${run.topology === "complete" ? "Complete" : "Ring"}</h2>
      <div class="muted small">${escapeHtml(graph)}</div>
      <div class="research-final">Proposal: <strong>${escapeHtml(fmtProposal(f.proposal))}</strong> ${ok}<span class="muted small"> · canonical ${escapeHtml(fmtProposal(f.canonical))}</span></div>
      <div class="muted small">validity ${escapeHtml(run.validity.status)} · ${run.stats.messages} messages${run.stats.silent_turns ? `, ${run.stats.silent_turns} silent` : ""}${run.stats.regenerations ? `, ${run.stats.regenerations} regenerated` : ""} · message tokens median ${n(run.stats.message_tokens_median)}, max ${n(run.stats.message_tokens_max)} · thinking median ${n(run.stats.thinking_tokens_median)}, max ${n(run.stats.thinking_tokens_max)} · ${n(run.stats.duration_s)} s</div>
    </div>`;
}

function renderCompare(body, v) {
  const col = (run) => `
    <section class="card research-col" data-run="${run.topology}">
      ${runHeader(run, v)}
      <ol class="research-turns">
        ${run.calls.map((c) => `
          <li class="research-turn ${c.text === null ? "silent" : ""}" data-turn="${c.turn}" data-run="${run.topology}">
            <div class="research-turn-head">
              <span class="research-turn-no">${c.turn}</span>
              <button type="button" class="research-agent ${agentClass(c.speaker)}" data-agent="${c.speaker}" data-turn="${c.turn}" data-run="${run.topology}" title="What ${c.speaker} had received before this turn">${c.speaker}</button>
              <span class="muted small">→ ${c.recipients.map((r) => SHORT[r]).join(", ")}${c.flags.length ? ` · ${c.flags.join(", ")}` : ""}</span>
            </div>
            <div class="research-turn-text">${c.text === null ? `<em class="muted">silent turn (model failure)</em>` : escapeHtml(c.text)}</div>
          </li>`).join("")}
      </ol>
    </section>`;
  body.innerHTML = `
    <p class="muted small">Click an agent's name on a turn to see exactly what it had received before speaking. Rounds: turns 1–6, 7–12, 13–18; the speaking order is the instance's (${v.runs.complete.speaking_order.map((r) => SHORT[r]).join(", ")}) in both runs.</p>
    <div class="research-grid">${col(v.runs.complete)}${col(v.runs.ring)}</div>
    <aside id="research-focus" class="card research-focus ${state.focus ? "" : "hidden"}"></aside>`;
  for (const b of body.querySelectorAll(".research-agent")) {
    b.addEventListener("click", () => {
      state.focus = { agent: b.dataset.agent, turn: Number(b.dataset.turn), run: b.dataset.run };
      renderFocus(v);
    });
  }
  renderFocus(v);
}

/** What the agent had received (or sent) before turn t — immediate delivery, own messages included. */
function receivedBefore(run, agent, t) {
  return run.calls.filter((c) => c.turn < t && c.text !== null && (c.speaker === agent || c.recipients.includes(agent)));
}

function renderFocus(v) {
  const box = document.getElementById("research-focus");
  if (!box) return;
  if (!state.focus) {
    box.classList.add("hidden");
    return;
  }
  const { agent, turn, run: topo } = state.focus;
  const run = v.runs[topo];
  const seen = receivedBefore(run, agent, turn);
  const other = v.runs[topo === "complete" ? "ring" : "complete"];
  const seenOther = receivedBefore(other, agent, turn);
  const card = v.role_cards[agent];
  box.classList.remove("hidden");
  box.innerHTML = `
    <div class="research-focus-head">
      <h3><span class="research-agent ${agentClass(agent)}">${agent}</span> before turn ${turn} · ${topo === "complete" ? "Complete" : "Ring"}</h3>
      <button type="button" class="research-close" id="research-focus-close">×</button>
    </div>
    <p class="small"><strong>Own private information:</strong> ${escapeHtml(card)}</p>
    <p class="small"><strong>Received before this turn:</strong> ${seen.length} message${seen.length === 1 ? "" : "s"} (${seenOther.length} in the ${topo === "complete" ? "Ring" : "Complete"} run at the same point)${run.topology === "ring" ? ` · neighbours: ${run.neighbours[agent].join(", ")}` : ""}</p>
    ${seen.length ? `<ol class="research-seen">${seen.map((c) => `<li><span class="research-turn-no">${c.turn}</span> <span class="research-agent ${agentClass(c.speaker)}">${c.speaker === agent ? "You" : c.speaker}</span> ${escapeHtml(c.text)}</li>`).join("")}</ol>` : `<p class="muted small">Nothing yet: the history says "(no messages yet)".</p>`}`;
  document.getElementById("research-focus-close").addEventListener("click", () => {
    state.focus = null;
    renderFocus(v);
  });
  box.scrollIntoView({ block: "nearest" });
}

// ---------------------------------------------------------------- 2 · information flow

function exposureBadge(f) {
  if (f.exposure === "correct") return `<span class="badge ok">exposed at turn ${f.exposed_at}</span>`;
  if (f.exposure === "incorrect") return `<span class="badge bad">incorrect value reached Operations</span>`;
  if (f.exposure === "conflicting") return `<span class="badge warn">conflicting values</span>`;
  return `<span class="badge neutral">not exposed</span>`;
}

function renderFlow(body, v) {
  if (!v.detector) {
    body.innerHTML = `<div class="card"><p>The detector has not been run on these logs yet (experiments/pilot-settlement/demo/detector/ is empty). The information-flow view needs its output: one record per run with every claim, its attribution, source and support, and Operations' exposure per fact.</p></div>`;
    return;
  }
  const d = v.detector;
  const facts = v.facts.map((f) => f.fact);
  const row = (fact) => {
    const c = d.complete.facts.find((x) => x.fact === fact);
    const r = d.ring.facts.find((x) => x.fact === fact);
    const sel = state.fact === fact ? "selected" : "";
    return `<tr class="research-fact ${sel}" data-fact="${fact}">
      <td><span class="research-agent ${agentClass(c.holder)}">${c.holder}</span></td>
      <td>${escapeHtml(c.sentence)}</td>
      <td>${exposureBadge(c)}</td>
      <td>${exposureBadge(r)}</td>
    </tr>`;
  };
  const side = (dv, topo) => `
    <div class="research-flow-side">
      <h3>${topo}</h3>
      <div class="small">Decision support: <strong>${escapeHtml(dv.category)}</strong> · minimal fact set exposed: ${dv.minimal_fact_set_exposed ? "yes" : "no"} · claims: ${Object.entries(dv.claim_counts).map(([k, x]) => `${k} ${x}`).join(", ")} · sources: ${Object.entries(dv.source_counts).map(([k, x]) => `${k} ${x}`).join(", ")}${dv.extraction_failures.length ? ` · extraction failed on turns ${dv.extraction_failures.join(", ")}` : ""}</div>
      <div id="research-chain-${topo}"></div>
    </div>`;
  body.innerHTML = `
    <p class="muted small">Ten private facts; for each, whether a supported claim of its true value reached Operations before the final call, and at which turn. Click a fact to follow its path through both graphs: who stated it, who relayed it, where it stopped. Hedged statements ("I think", "probably") never count as exposure; unsupported claims are shown but excluded.</p>
    <p class="warning-banner small">Detector ${escapeHtml(d.complete.detector_version)}, extraction by ${escapeHtml(d.complete.extraction_model)}: a first pass, before the detector's own validation gate (G7: a held-out set of annotated messages). A "conflicting" or "incorrect" state on a run whose proposal was exact usually marks an extraction error — a mis-read rail in a route list, a double negation, a "must permit" taken as a statement; these are what the validation set is for.</p>
    <div class="card overflow-x">
      <table class="research-facts">
        <thead><tr><th>Holder</th><th>Fact (true value)</th><th>Complete</th><th>Ring</th></tr></thead>
        <tbody>${facts.map(row).join("")}</tbody>
      </table>
    </div>
    <div class="research-grid research-flow">${side(d.complete, "complete")}${side(d.ring, "ring")}</div>`;
  for (const tr of body.querySelectorAll(".research-fact")) {
    tr.addEventListener("click", () => {
      state.fact = tr.dataset.fact;
      for (const x of body.querySelectorAll(".research-fact")) x.classList.toggle("selected", x.dataset.fact === state.fact);
      renderChains(v);
    });
  }
  renderChains(v);
}

function renderChains(v) {
  for (const topo of ["complete", "ring"]) {
    const box = document.getElementById(`research-chain-${topo}`);
    if (!box) continue;
    const dv = v.detector[topo];
    if (!state.fact) {
      box.innerHTML = `<p class="muted small">Select a fact above.</p>`;
      continue;
    }
    const f = dv.facts.find((x) => x.fact === state.fact);
    const run = v.runs[topo];
    const steps = f.chain.map((s) => {
      const cls = s.hedged ? "hedged" : s.support === "supported" ? (s.truth ? "supported" : "false") : "unsupported";
      const label = s.hedged ? "hedged" : `${s.source ?? "?"} · ${s.support ?? "?"}${s.truth ? "" : " · false value"}`;
      return `<li class="research-step ${cls}">
        <span class="research-turn-no">${s.turn}</span>
        <span class="research-agent ${agentClass(s.sender)}">${s.sender}</span>
        <span class="muted small">→ ${s.recipients.map((r) => SHORT[r]).join(", ")}${s.recipients.includes("Operations") ? " (reaches Operations)" : ""}</span>
        <span class="badge ${cls === "supported" ? "ok" : cls === "hedged" ? "neutral" : cls === "false" ? "bad" : "warn"}">${escapeHtml(label)}</span>
        <div class="research-span">“${escapeHtml(s.span)}”</div>
      </li>`;
    });
    const ringNote = run.topology === "ring" ? `<div class="muted small">Ring: ${run.ring_positions.map((r) => SHORT[r]).join(" → ")} → ${SHORT[run.ring_positions[0]]}; ${f.holder} sends to ${run.neighbours[f.holder].join(" and ")}.</div>` : "";
    box.innerHTML = `
      <div class="research-chain-head">${exposureBadge(f)} ${f.stated_at ? `<span class="small">first stated by ${f.holder} at turn ${f.stated_at}</span>` : `<span class="small">never stated by ${f.holder}</span>`}</div>
      ${ringNote}
      ${steps.length ? `<ol class="research-chain">${steps.join("")}</ol>` : `<p class="muted small">No claim about this fact in this run.</p>`}
      ${f.stop ? `<div class="warning-banner small">Stopped: ${escapeHtml(f.stop)}</div>` : ""}`;
  }
}

// ---------------------------------------------------------------- batch

function renderBatch(body, b) {
  const t = b.transitions;
  const cls = Object.entries(b.by_class).sort();
  const pt = b.per_topology;
  const row = (label, f) => `<tr><td>${label}</td><td>${f(pt.complete)}</td><td>${f(pt.ring)}</td></tr>`;
  const cats = (x) => Object.entries(x.categories).sort((a, c) => c[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ") || "—";
  body.innerHTML = `
    <p class="muted small">${b.pairs} dev instances, each run once under each graph (${b.pairs * 2} runs, config_version ${b.config_versions.join(", ")}). Descriptive only: the pilot's 40 instances have not been run yet. Every run here passed the reference validator and the schema.</p>
    <div class="research-grid">
      <section class="card">
        <h2>Pair outcomes (exact correctness)</h2>
        <table><tbody>
          <tr><td>both correct</td><td>${t.both_correct}</td></tr>
          <tr><td>Complete only</td><td>${t.complete_only}</td></tr>
          <tr><td>Ring only</td><td>${t.ring_only}</td></tr>
          <tr><td>both incorrect</td><td>${t.both_incorrect}</td></tr>
        </tbody></table>
        <h3>By class</h3>
        <table><thead><tr><th>Class</th><th>n</th><th>Complete</th><th>Ring</th></tr></thead><tbody>
          ${cls.map(([k, v]) => `<tr><td>${k}</td><td>${v.n}</td><td>${v.complete_correct}/${v.n}</td><td>${v.ring_correct}/${v.n}</td></tr>`).join("")}
        </tbody></table>
      </section>
      <section class="card">
        <h2>Technical context, per graph</h2>
        <table><thead><tr><th></th><th>Complete</th><th>Ring</th></tr></thead><tbody>
          ${row("runs valid / correct", (x) => `${x.valid} / ${x.correct} of ${x.runs}`)}
          ${row("calls", (x) => x.calls)}
          ${row("silent turns · regenerations · truncated", (x) => `${x.silent_turns} · ${x.regenerations} · ${x.truncated}`)}
          ${row("schema failures", (x) => x.schema_failures)}
          ${row("message tokens median / max", (x) => `${n(x.message_tokens_median)} / ${n(x.message_tokens_max)}`)}
          ${row("thinking tokens median / max", (x) => `${n(x.thinking_tokens_median)} / ${n(x.thinking_tokens_max)}`)}
          ${row("largest prompt (tokens)", (x) => n(x.prompt_tokens_max))}
          ${row("run duration median (s)", (x) => n(x.duration_s_median))}
          ${b.detector ? row("decision-support categories", cats) : ""}
          ${b.detector ? row("facts exposed to Operations, median per run", (x) => `${n(x.exposure_correct_per_run_median)} of 10`) : ""}
        </tbody></table>
        <p class="muted small">Environment: ${b.environment.snapshots} snapshots, ${b.environment.snapshots_normal} normal, ${b.environment.deviations} deviations.</p>
      </section>
    </div>
    <section class="card">
      <h2>Instances</h2>
      <div class="overflow-x"><table><thead><tr><th>Instance</th><th>Class</th><th>Canonical</th><th>Complete</th><th>Ring</th>${b.detector ? "<th>Support (Complete / Ring)</th>" : ""}</tr></thead><tbody>
        ${state.overview.instances.map((i) => `<tr><td><a href="#/research/${encodeURIComponent(i.id)}" data-pick="${i.id}">${i.id}</a></td><td>${i.class}${i.subtype ? ` / ${i.subtype}` : ""}</td><td>${escapeHtml(fmtProposal(i.canonical))}</td>
          <td>${escapeHtml(fmtProposal(i.complete.proposal))} ${i.complete.correct ? `<span class="badge ok">exact</span>` : `<span class="badge bad">wrong</span>`}</td>
          <td>${escapeHtml(fmtProposal(i.ring.proposal))} ${i.ring.correct ? `<span class="badge ok">exact</span>` : `<span class="badge bad">wrong</span>`}</td>
          ${b.detector ? `<td class="small">${escapeHtml(i.complete.category ?? "—")} / ${escapeHtml(i.ring.category ?? "—")}</td>` : ""}</tr>`).join("")}
      </tbody></table></div>
    </section>`;
  for (const a of body.querySelectorAll("a[data-pick]")) {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      state.tab = "compare";
      void selectInstance(a.dataset.pick);
    });
  }
}

// ---------------------------------------------------------------- methods

function renderMethods(body, m) {
  const rows = [
    ["Task", m.task],
    ["Conditions", m.conditions],
    ["Protocol", m.protocol],
    ["Runtime", m.runtime],
    ["Seeds", m.seeds],
    ["Token accounting", m.tokenCount],
    ["Environment", m.environment],
    ["Exposure detector", m.detector],
  ];
  body.innerHTML = `
    <section class="card">
      <h2>How the runs are made</h2>
      <dl class="kv research-kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(v)}</dd>`).join("")}</dl>
    </section>
    <section class="card">
      <h2>Development gates (10 dev instances)</h2>
      <table><thead><tr><th>Gate</th><th>Result</th></tr></thead><tbody>${m.gates.map((g) => `<tr><td>${escapeHtml(g.gate)}</td><td>${escapeHtml(g.result)}</td></tr>`).join("")}</tbody></table>
      <p class="muted small">The detector gate (G7) is in progress; the pilot's 40 paired instances run after it.</p>
    </section>`;
}
