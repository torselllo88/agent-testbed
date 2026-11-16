import { api, app, escapeHtml, showError } from "../shared.js";

/**
 * Manual labeling of an exposure sample (#/annotate/<sampleId>): one message
 * at a time, every proposition labeled absent / correct / incorrect — blind:
 * the detector's labels are never shown here. Labels are kept per person
 * (the name below), so several people can label the same sample.
 */

const NAME_PREF = "testbed.annotator";
const readName = () => {
  try {
    return localStorage.getItem(NAME_PREF) ?? "";
  } catch {
    return "";
  }
};
const writeName = (name) => {
  try {
    localStorage.setItem(NAME_PREF, name);
  } catch {
    // private window
  }
};

const LABELS = [
  ["absent", "absent", "asserts nothing about it — also: only asks about it, or names the subject without the fact"],
  ["correct", "correct", "asserts it, or something that implies it — paraphrase, summary, passing on what someone else said"],
  ["incorrect", "incorrect", "asserts something that contradicts it — a different value, status, limit, or the opposite"],
];

export async function renderAnnotate(sampleId) {
  const route = location.hash;
  let annotator = readName();
  let data = null;
  let index = 0;
  let draft = {};

  async function load() {
    data = await api(`/api/exposure/samples/${encodeURIComponent(sampleId)}?annotator=${encodeURIComponent(annotator)}`);
  }
  const done = (item) => item.facts.every((f) => item.labels[f.id]);
  const firstOpen = () => Math.max(0, data.items.findIndex((i) => !done(i)));

  function renderNameForm() {
    app.innerHTML = `
      <div class="breadcrumb"><a href="#/batches">Batches</a> / manual labeling</div>
      <div class="page-header"><h1>Manual labeling</h1></div>
      <div class="card">
        <p>Your labels are kept under your name, so several people can label the same sample independently. You will not see the detector's labels or anyone else's.</p>
        <label class="field"><span class="field-label">Your name</span><input type="text" id="an-name" value="${escapeHtml(annotator)}" placeholder="e.g. Ana" /></label>
        <div class="actions"><button class="primary" id="an-go">Start labeling</button></div>
      </div>`;
    document.getElementById("an-go").addEventListener("click", async () => {
      const name = document.getElementById("an-name").value.trim();
      if (!name) return;
      annotator = name;
      writeName(name);
      await start();
    });
  }

  async function start() {
    try {
      await load();
    } catch (err) {
      app.innerHTML = "";
      return showError(err.message);
    }
    index = firstOpen();
    render();
  }

  function render() {
    if (location.hash !== route) return;
    const item = data.items[index];
    draft = { ...item.labels };
    const labeled = data.items.filter(done).length;
    const chips = data.items
      .map((it, i) => `<button type="button" class="an-chip ${done(it) ? "done" : ""} ${i === index ? "current" : ""}" data-go="${i}" title="message ${i + 1}">${i + 1}</button>`)
      .join("");
    const factRows = item.facts
      .map(
        (f) => `<tr>
          <td>${escapeHtml(f.statement)} <span class="muted small">${escapeHtml(f.kind)}</span></td>
          <td class="an-choice" data-fact="${escapeHtml(f.id)}">${LABELS.map(
            ([value, label]) => `<label class="an-option an-${value}"><input type="radio" name="${escapeHtml(f.id)}" value="${value}" ${draft[f.id] === value ? "checked" : ""}/> ${label}</label>`
          ).join("")}</td>
        </tr>`
      )
      .join("");
    app.innerHTML = `
      <div class="breadcrumb">${data.sample.batchId ? `<a href="#/batches/${encodeURIComponent(data.sample.batchId)}">Batch</a>` : "Batch"} / manual labeling / ${escapeHtml(data.sample.name)}</div>
      <div class="page-header">
        <h1>${escapeHtml(data.sample.name)}</h1>
        <div class="actions"><span class="muted">Labeling as <strong>${escapeHtml(annotator)}</strong></span><button type="button" id="an-switch">Change name</button></div>
      </div>
      <div class="card">
        <p class="muted small">${labeled} of ${data.items.length} message(s) labeled. Click a number to jump; green ones are done.</p>
        <div class="an-chips">${chips}</div>
      </div>
      <div class="card">
        <h2>Message ${index + 1} of ${data.items.length}</h2>
        <p class="muted small">Who wrote it is not shown — the detector does not see it either.</p>
        <blockquote class="an-message">${escapeHtml(item.text)}</blockquote>
        <details class="advanced"><summary>How to label</summary>
          <p class="small">Every proposition below is <strong>true</strong> for this task. Judge only what this message <em>asserts</em>, not what is true.</p>
          <ul class="small">${LABELS.map(([v, l, help]) => `<li><strong>${l}</strong> — ${escapeHtml(help)}</li>`).join("")}</ul>
        </details>
        <table class="an-table"><thead><tr><th>Proposition</th><th>This message…</th></tr></thead><tbody>${factRows}</tbody></table>
        <div class="actions">
          <button type="button" id="an-prev" ${index === 0 ? "disabled" : ""}>← Previous</button>
          <button type="button" id="an-rest-absent">Rest → absent</button>
          <button type="button" class="primary" id="an-save">Save &amp; next →</button>
          <button type="button" id="an-skip" ${index === data.items.length - 1 ? "disabled" : ""}>Skip →</button>
        </div>
        <div id="an-error"></div>
      </div>`;

    app.querySelectorAll(".an-choice input").forEach((input) =>
      input.addEventListener("change", () => (draft[input.closest(".an-choice").dataset.fact] = input.value))
    );
    app.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => go(Number(b.dataset.go))));
    document.getElementById("an-switch").addEventListener("click", renderNameForm);
    document.getElementById("an-prev").addEventListener("click", () => go(index - 1));
    document.getElementById("an-skip").addEventListener("click", () => go(index + 1));
    document.getElementById("an-rest-absent").addEventListener("click", () => {
      for (const f of item.facts) {
        if (draft[f.id]) continue;
        draft[f.id] = "absent";
        const input = app.querySelector(`.an-choice[data-fact="${CSS.escape(f.id)}"] input[value="absent"]`);
        if (input) input.checked = true;
      }
    });
    document.getElementById("an-save").addEventListener("click", save);
  }

  function go(i) {
    if (i < 0 || i >= data.items.length) return;
    index = i;
    render();
    window.scrollTo(0, 0);
  }

  async function save() {
    const item = data.items[index];
    const missing = item.facts.filter((f) => !draft[f.id]);
    const errorEl = document.getElementById("an-error");
    if (missing.length) {
      errorEl.innerHTML = `<div class="error-banner">${missing.length} proposition(s) still without a label — every one needs one ("Rest → absent" fills the empty ones).</div>`;
      return;
    }
    try {
      await api(`/api/exposure/samples/${encodeURIComponent(sampleId)}/annotations`, {
        method: "PUT",
        body: JSON.stringify({ annotator, experimentId: item.experimentId, messageId: item.messageId, labels: draft }),
      });
      item.labels = { ...draft };
      const next = data.items.findIndex((it, i) => i > index && !done(it));
      if (next >= 0) go(next);
      else if (data.items.every(done)) {
        render();
        errorEl.innerHTML = "";
        document.getElementById("an-error").innerHTML = `<div class="success-banner">All ${data.items.length} messages labeled — thank you. Agreement is on the batch page (Exposure → Manual labeling).</div>`;
      } else go(firstOpen());
    } catch (err) {
      errorEl.innerHTML = `<div class="error-banner">${escapeHtml(err.message)}</div>`;
    }
  }

  if (annotator) await start();
  else renderNameForm();
}
