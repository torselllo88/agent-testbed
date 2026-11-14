import { bindChoiceFields, choiceFieldsHtml, defaultProvider, endpointNames, fillEndpointLists, loadOpenRouterCatalog, openRouterOptions, providerOptions, readChoice } from "./modelChoice.js";
import { api, badge, escapeHtml, formatDate } from "./shared.js";

/**
 * Exposure detection in the web UI (docs/exposure.md): a labeling job with a
 * model choice, what reached the proposer per condition (batch page) and per
 * proposition (run page), and manual labeling samples with agreement.
 */

const CLASS_STYLE = { correct: "ok", distorted: "bad", conflicting: "warn", absent: "neutral", own: "info" };
export const exposureBadge = (cls) => badge(cls ?? "—", CLASS_STYLE[cls] ?? "neutral");
const pct = (x) => (x === null || x === undefined ? "—" : `${Math.round(x * 100)}%`);
const POLL_MS = 1500;

let metaPromise = null;
const loadMeta = () => (metaPromise ??= api("/api/meta"));

const PREF = "testbed.detectorModel";
function lastModel() {
  try {
    return JSON.parse(localStorage.getItem(PREF) ?? "null");
  } catch {
    return null;
  }
}
function rememberModel(choice) {
  try {
    localStorage.setItem(PREF, JSON.stringify(choice));
  } catch {
    // private window: no memory, no harm
  }
}

/** The detector's model: provider/model and (self-hosted) thinking and window — temperature 0, seed 1, 1500 output tokens. */
function detectorPicker(root, prefix, meta) {
  const last = lastModel();
  const provider = last?.provider === "openai-compatible" ? `openai-compatible:${last.endpoint}` : (last?.provider ?? defaultProvider(meta));
  const initial = { provider, model: last?.model ?? (provider === "stub" ? "detector/keywords" : ""), think: last?.think, contextLength: last?.contextLength };
  const lists = { stubList: `${prefix}-stub`, openRouterList: `${prefix}-or`, endpointPrefix: `${prefix}-ep-` };
  root.innerHTML = `
    <div class="grid-2">${choiceFieldsHtml(prefix, initial, lists, providerOptions(meta))}</div>
    <datalist id="${prefix}-stub">${meta.stubModels.map((m) => `<option value="${escapeHtml(m)}">`).join("")}</datalist>
    <datalist id="${prefix}-or"></datalist>
    ${endpointNames(meta).map((n) => `<datalist id="${prefix}-ep-${escapeHtml(n)}"></datalist>`).join("")}
    <p class="muted small">Temperature 0, seed 1, up to 1500 output tokens per message, native structured output. Ideally not the model under study. <code>stub · detector/keywords</code> only tries the pipeline (ids and numbers matched as text) — it measures nothing.</p>`;
  bindChoiceFields(root, prefix, lists);
  fillEndpointLists(root, meta, lists.endpointPrefix);
  let catalog = null;
  loadOpenRouterCatalog().then((c) => {
    catalog = c;
    const list = root.querySelector(`#${prefix}-or`);
    if (list) list.innerHTML = openRouterOptions(c.models);
  });
  return () => {
    const choice = readChoice(root, prefix, catalog);
    if (!choice) return null;
    rememberModel(choice);
    return { ...choice, structuredOutput: choice.structuredOutput ?? "native", temperature: 0, seed: 1, maxOutputTokens: 1500 };
  };
}

function jobLine(job, forScope) {
  if (!job) return "";
  const mine = forScope(job.scope);
  const done = job.runsDone / Math.max(1, job.runsTotal);
  const model = `${job.model.endpoint ?? job.model.provider}/${job.model.model}`;
  if (job.status === "running") {
    return `<div class="${mine ? "success-banner" : "warning-banner"}">${mine ? "Labeling" : "Another labeling job is running"} — ${job.runsDone} of ${job.runsTotal} run(s)${
      job.current?.messages ? ` · message ${job.current.message} of ${job.current.messages}` : ""
    } · ${escapeHtml(model)}
      <div class="progress"><div class="progress-bar" style="width:${Math.round(done * 100)}%"></div></div></div>`;
  }
  if (!mine) return "";
  const failed = job.failed.length ? ` · ${job.failed.length} could not be labeled: ${escapeHtml(job.failed.slice(0, 3).map((f) => f.error).join("; "))}` : "";
  return `<div class="${job.status === "completed" && !job.failed.length ? "success-banner" : "warning-banner"}">Last labeling ${escapeHtml(job.status)}: ${job.labeled} labeled, ${job.skipped} already labeled${failed}${job.error ? ` — ${escapeHtml(job.error)}` : ""} · ${escapeHtml(model)}</div>`;
}

/** Starts a job (asking first when experiments are running), then calls onChange while it runs and once it ends. */
async function startJob(scope, model, force, onChange) {
  const { busy } = await api("/api/exposure");
  if (busy.runningExperiments && !confirm(`${busy.runningExperiments} experiment(s) are running on this server. Labeling queues at the same model server and slows them down. Start anyway?`)) return;
  await api("/api/exposure/label", { method: "POST", body: JSON.stringify({ ...scope, model, force }) });
  onChange();
}

// ------------------------------------------------------------------ batch page

export function mountBatchExposure(el, batchId) {
  const route = location.hash;
  const forScope = (scope) => scope.batchId === batchId;
  let pickerRead = null;
  let shownAgreement = null;

  el.innerHTML = `
    <div class="card overflow-x" id="exposure-card">
      <h2>Exposure — what reached the proposer</h2>
      <p class="muted small">An analysis pass over finished runs: a model labels every agent message against the scenario's propositions (correct / incorrect / absent); with who received each message, that gives what reached the proposer before it decided. Agents never see it. Details: <code>docs/exposure.md</code>.</p>
      <div id="exp-job"></div>
      <details class="advanced" id="exp-label"><summary>Label this batch's messages</summary>
        <div id="exp-picker"></div>
        <label class="check small"><input type="checkbox" id="exp-force" /> relabel runs already labeled with this model</label>
        <div class="actions"><button type="button" class="primary" id="exp-start">Start labeling</button><button type="button" id="exp-cancel" hidden>Cancel labeling</button></div>
      </details>
      <div id="exp-summary"><div class="loading">Loading…</div></div>
      <h3>Manual labeling <span class="muted small">— validates the detector</span></h3>
      <p class="muted small">A fixed, seeded sample of messages; each person labels it in the browser without seeing the detector's labels. Agreement: person with person, and the detector with each person.</p>
      <div id="exp-samples"></div>
      <div class="grid-4">
        <label class="field"><span class="field-label">Messages</span><input type="number" id="exp-n" min="1" value="40" /></label>
        <label class="field"><span class="field-label">Seed</span><input type="number" id="exp-seed" min="0" value="1" /></label>
        <label class="field"><span class="field-label">Name</span><input type="text" id="exp-name" placeholder="optional" /></label>
        <div class="field"><span class="field-label">&nbsp;</span><button type="button" id="exp-sample">Create sample</button></div>
      </div>
      <div id="exp-agreement"></div>
      <div id="exp-error"></div>
    </div>`;
  const $ = (id) => el.querySelector(`#${id}`);
  const fail = (err) => ($("exp-error").innerHTML = `<div class="error-banner">${escapeHtml(err.message ?? String(err))}</div>`);

  loadMeta().then((meta) => (pickerRead = detectorPicker($("exp-picker"), "exp-model", meta)));

  function renderSummary(view) {
    const conditions = [...view.conditions, ...(view.conditions.length > 1 ? [view.overall] : [])];
    const sources = [...new Set(conditions.flatMap((c) => Object.keys(c.bySource)))];
    const row = (c) => `<tr>
        <td><code>${escapeHtml(c.key)}</code></td>
        <td>${c.labeled} / ${c.runs}</td>
        <td><strong>${pct(c.factsCorrect)}</strong></td>
        <td>${c.runsWithDistorted}</td><td>${c.runsWithConflicting}</td>
        <td>${pct(c.derivedCorrect)}</td><td>${pct(c.solutionRelay)}</td>
        <td>${c.incomplete ? `<span class="badge bad">${c.incomplete} run(s) incomplete</span> ` : ""}${c.unlabeledMessages || "0"}</td>
        ${sources.map((s) => `<td>${c.bySource[s] ? `${c.bySource[s].correct}/${c.bySource[s].total}` : "—"}</td>`).join("")}
      </tr>`;
    $("exp-summary").innerHTML = view.labeled
      ? `<p class="muted small">${view.labeled} of ${view.runs} finished run(s) labeled${view.models.length ? ` · ${escapeHtml(view.models.join(", "))}` : ""}. Private facts: the other agents' own facts that reached the proposer correctly (mean per run). Distorted / conflicting: runs where some fact reached it only wrongly / both ways. By source: facts that reached it correctly, of all, per agent who held them. A run with a message the detector could not label is <em>incomplete</em> and left out of these means — relabel it with a larger output cap.</p>
         <table>
           <thead><tr><th>Condition</th><th>Labeled</th><th>Private facts reached</th><th>Distorted</th><th>Conflicting</th><th>Derived reached</th><th>Solution relay</th><th>Unlabeled msgs</th>${sources.map((s) => `<th>from ${escapeHtml(s)}</th>`).join("")}</tr></thead>
           <tbody>${conditions.map(row).join("")}</tbody>
         </table>
         <div class="actions">
           <a class="button-like" href="/api/batches/${encodeURIComponent(batchId)}/exposure/export?kind=runs">Exposure CSV (runs)</a>
           <a class="button-like" href="/api/batches/${encodeURIComponent(batchId)}/exposure/export?kind=facts">Exposure CSV (facts)</a>
         </div>`
      : `<p class="muted">No run of this batch is labeled yet.</p>`;

    $("exp-samples").innerHTML = view.samples.length
      ? `<table><thead><tr><th>Sample</th><th>Messages</th><th>Labeled by</th><th></th></tr></thead><tbody>${view.samples
          .map(
            (s) => `<tr>
              <td>${escapeHtml(s.name)} <span class="muted small">seed ${s.seed} · ${escapeHtml(formatDate(s.createdAt))}</span></td>
              <td>${s.items}</td>
              <td>${s.annotators.length ? s.annotators.map((a) => `${escapeHtml(a.name)} ${a.messages}/${s.items}`).join(" · ") : "—"}</td>
              <td class="actions">
                <a class="button-like" href="#/annotate/${encodeURIComponent(s.id)}">Label</a>
                <button type="button" data-agreement="${escapeHtml(s.id)}">Agreement</button>
                <a class="button-like" href="/api/exposure/samples/${encodeURIComponent(s.id)}/annotations.csv">CSV</a>
              </td></tr>`
          )
          .join("")}</tbody></table>`
      : `<p class="muted small">No sample yet.</p>`;
    el.querySelectorAll("[data-agreement]").forEach((b) => b.addEventListener("click", () => showAgreement(b.dataset.agreement)));
  }

  async function showAgreement(sampleId) {
    shownAgreement = sampleId;
    try {
      $("exp-agreement").innerHTML = agreementHtml(await api(`/api/exposure/samples/${encodeURIComponent(sampleId)}/agreement`));
    } catch (err) {
      fail(err);
    }
  }

  let timer = null;
  async function refresh() {
    if (location.hash !== route || !el.isConnected) return;
    try {
      const [{ job }, view] = await Promise.all([api("/api/exposure"), api(`/api/batches/${encodeURIComponent(batchId)}/exposure`)]);
      $("exp-job").innerHTML = jobLine(job, forScope);
      const running = job?.status === "running";
      $("exp-start").disabled = running;
      $("exp-cancel").hidden = !(running && forScope(job.scope));
      renderSummary(view);
      if (shownAgreement && !running) showAgreement(shownAgreement);
      clearTimeout(timer);
      if (running) timer = setTimeout(refresh, POLL_MS);
    } catch (err) {
      fail(err);
    }
  }

  $("exp-start").addEventListener("click", async () => {
    $("exp-error").innerHTML = "";
    const model = pickerRead?.();
    if (!model) return fail(new Error("Choose the detector's provider and model first"));
    try {
      await startJob({ batchId }, model, $("exp-force").checked, refresh);
    } catch (err) {
      fail(err);
    }
  });
  $("exp-cancel").addEventListener("click", async () => {
    await api("/api/exposure/cancel", { method: "POST", body: "{}" }).catch(fail);
    refresh();
  });
  $("exp-sample").addEventListener("click", async () => {
    $("exp-error").innerHTML = "";
    try {
      await api(`/api/batches/${encodeURIComponent(batchId)}/exposure/samples`, {
        method: "POST",
        body: JSON.stringify({ n: Number($("exp-n").value), seed: Number($("exp-seed").value), ...($("exp-name").value.trim() ? { name: $("exp-name").value.trim() } : {}) }),
      });
      refresh();
    } catch (err) {
      fail(err);
    }
  });
  refresh();
}

export function agreementHtml(report) {
  const k = (x) => (x === null || x === undefined ? "—" : x.toFixed(3));
  const perLabel = (p) =>
    Object.entries(p)
      .map(([label, s]) => `${escapeHtml(label)}: precision ${pct(s.precision)}, recall ${pct(s.recall)} (${s.support})`)
      .join(" · ");
  if (!report.annotators.length) return `<p class="muted small">Nobody has labeled this sample yet.</p>`;
  return `
    <h3>Agreement</h3>
    <table>
      <thead><tr><th>Between</th><th>Labels compared</th><th>Agreement</th><th>Cohen's κ</th><th>Detector vs person, per label</th></tr></thead>
      <tbody>
        ${report.pairs.map((p) => `<tr><td>${escapeHtml(p.a)} ↔ ${escapeHtml(p.b)}</td><td>${p.n}</td><td>${pct(p.observed)}</td><td>${k(p.kappa)}</td><td></td></tr>`).join("")}
        ${report.detector
          .map(
            (d) => `<tr><td>detector ↔ ${escapeHtml(d.annotator)}</td><td>${d.n}${d.unmatched ? ` <span class="muted small">(${d.unmatched} without a detector label)</span>` : ""}</td><td>${pct(d.observed)}</td><td>${k(d.kappa)}</td><td class="small">${d.n ? perLabel(d.perLabel) : "—"}</td></tr>`
          )
          .join("")}
      </tbody>
    </table>
    <p class="muted small">Mostly "absent" labels inflate plain agreement — look at κ and at precision/recall of "correct" and "incorrect".</p>`;
}

// ------------------------------------------------------------------ run page

export function mountRunExposure(el, experimentId, agentName) {
  const route = location.hash;
  const forScope = (scope) => scope.experimentId === experimentId;
  let pickerRead = null;
  let timer = null;

  async function refresh() {
    if (location.hash !== route || !el.isConnected) return;
    try {
      const [{ job }, data] = await Promise.all([api("/api/exposure"), api(`/api/experiments/${encodeURIComponent(experimentId)}/exposure`)]);
      render(job, data);
      clearTimeout(timer);
      if (job?.status === "running") timer = setTimeout(refresh, POLL_MS);
    } catch (err) {
      el.innerHTML = `<div class="card"><h2>Exposure</h2><div class="error-banner">${escapeHtml(err.message)}</div></div>`;
    }
  }

  function render(job, { latest, passes }) {
    const result = latest?.result;
    const open = el.querySelector("#rexp-label")?.open ?? !result;
    const proposer = result?.summary.proposerId;
    const factRows = result
      ? result.facts
          .map((f) => {
            const e = result.summary.proposer[f.id];
            return `<tr><td>${escapeHtml(f.statement)}</td><td class="muted small">${escapeHtml(f.kind)}${f.source ? ` · ${escapeHtml(agentName(f.source))}` : ""}</td><td>${exposureBadge(e?.class)}</td><td class="small">${
              e?.firstCorrectTurn !== null && e?.firstCorrectTurn !== undefined ? `turn ${e.firstCorrectTurn}, from ${escapeHtml(agentName(e.firstCorrectFrom))}` : "—"
            }</td></tr>`;
          })
          .join("")
      : "";
    const messageRows = result
      ? result.messages
          .map((m) => {
            const said = m.labels
              ? Object.entries(m.labels)
                  .filter(([, l]) => l.label !== "absent")
                  .map(([id, l]) => `${exposureBadge(l.label)} <span class="small">${escapeHtml(id)}</span>${l.evidence ? ` <span class="muted small">“${escapeHtml(l.evidence)}”</span>` : ""}`)
                  .join("<br>")
              : `<span class="badge bad">not labeled</span> <span class="muted small">${escapeHtml(m.call.error ?? "")}</span>`;
            return `<tr><td class="small">#${m.index} ${escapeHtml(agentName(m.senderId))}${m.audience ? ` <span class="muted">→ ${escapeHtml(m.audience.filter((a) => a !== m.senderId).map(agentName).join(", "))}</span>` : ""}${m.beforeProposal ? "" : ` <span class="muted">(after the proposal request)</span>`}</td><td class="small">${escapeHtml(m.text)}</td><td>${said || `<span class="muted small">nothing</span>`}</td></tr>`;
          })
          .join("")
      : "";
    const s = result?.summary;
    el.innerHTML = `
      <div class="card overflow-x">
        <h2>Exposure${proposer ? ` — what reached ${escapeHtml(agentName(proposer))}` : ""}</h2>
        ${jobLine(job, forScope)}
        ${
          result
            ? `<p class="muted small">${escapeHtml(formatDate(latest.createdAt))} · detector v${escapeHtml(latest.detectorVersion)} · ${escapeHtml(`${latest.model.endpoint ?? latest.model.provider}/${latest.model.model}`)}${passes.length > 1 ? ` · ${passes.length} passes, the latest shown` : ""}${
                s.unlabeledMessages ? ` · <span class="badge bad">${s.unlabeledMessages} message(s) not labeled${s.complete === false ? " — exposure is a lower bound" : ""}</span>` : ""
              }</p>
               <p>Private facts of the others: <strong>${s.proposerFacts.correct} of ${s.proposerFacts.total}</strong> reached it correctly${s.proposerFacts.distorted ? `, ${s.proposerFacts.distorted} distorted` : ""}${s.proposerFacts.conflicting ? `, ${s.proposerFacts.conflicting} conflicting` : ""} · derived: ${s.proposerDerived.correct} of ${s.proposerDerived.total} · solution relay: ${exposureBadge(s.solutionRelay)}</p>
               <table><thead><tr><th>Proposition</th><th>Kind · held by</th><th>Reached the proposer</th><th>First correct mention</th></tr></thead><tbody>${factRows}</tbody></table>
               <details><summary class="muted small">Every message and its labels</summary><table><thead><tr><th>Message</th><th>Text</th><th>Asserted (not absent)</th></tr></thead><tbody>${messageRows}</tbody></table></details>`
            : `<p class="muted">Not labeled yet.</p>`
        }
        <details class="advanced" id="rexp-label" ${open ? "open" : ""}><summary>${result ? "Label again" : "Label this run's messages"}</summary>
          <div id="rexp-picker"></div>
          <div class="actions"><button type="button" class="primary" id="rexp-start" ${job?.status === "running" ? "disabled" : ""}>Start labeling</button></div>
        </details>
        <div id="rexp-error"></div>
      </div>`;
    loadMeta().then((meta) => {
      const holder = el.querySelector("#rexp-picker");
      if (holder) pickerRead = detectorPicker(holder, "rexp-model", meta);
    });
    el.querySelector("#rexp-start").addEventListener("click", async () => {
      const model = pickerRead?.();
      const errorEl = el.querySelector("#rexp-error");
      if (!model) return (errorEl.innerHTML = `<div class="error-banner">Choose the detector's provider and model first</div>`);
      try {
        await startJob({ experimentId }, model, Boolean(result), refresh);
      } catch (err) {
        errorEl.innerHTML = `<div class="error-banner">${escapeHtml(err.message)}</div>`;
      }
    });
  }

  refresh();
}
