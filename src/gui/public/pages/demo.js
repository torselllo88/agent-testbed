import { api, apiDetailed, app, escapeHtml, showError } from "../shared.js";

/**
 * About & demo (#/demo): a one-screen introduction for someone seeing the
 * testbed for the first time, one button that starts the demo run and opens
 * the viewer, and a link to the demo scenario's full configuration. The text,
 * the scenario, its facts and the models come from the server (GET /api/demo);
 * the server also decides live vs. scripted.
 */
export async function renderDemo() {
  app.innerHTML = `<div class="loading">Loading…</div>`;
  let demo;
  try {
    demo = await api("/api/demo");
  } catch (err) {
    app.innerHTML = "";
    showError(err.message);
    return;
  }
  const c = demo.content;
  const mode = demo.live ? "live" : "scripted";
  const steps = c.pipeline.split("→").map((s) => s.trim()).filter(Boolean);
  const configHref = demo.scenarioId ? `#/scenarios/${encodeURIComponent(demo.scenarioId)}?tab=agents&from=demo` : null;

  const section = (s, extra = "") => `
    <section class="card demo-section">
      <h2>${escapeHtml(s.heading)}</h2>
      ${extra}
      ${(s.paragraphs ?? []).map((p) => `<p>${escapeHtml(p)}</p>`).join("")}
      ${s.intro ? `<p>${escapeHtml(s.intro)}</p>` : ""}
      ${s.bullets?.length ? `<ul>${s.bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join("")}</ul>` : ""}
      ${s.emphasis?.length ? `<p class="demo-emphasis">${s.emphasis.map(escapeHtml).join("<br>")}</p>` : ""}
      ${(s.after ?? []).map((p) => `<p>${escapeHtml(p)}</p>`).join("")}
    </section>`;
  const facts = demo.facts?.length ? `<ul class="demo-facts">${demo.facts.map((f) => `<li>${escapeHtml(f)}</li>`).join("")}</ul>` : "";

  app.innerHTML = `
    <div class="demo">
      <header class="demo-hero">
        <h1>${escapeHtml(c.title)}</h1>
        <p class="demo-subtitle">${escapeHtml(c.subtitle)}</p>
        <p class="demo-lead">${c.intro.map(escapeHtml).join(" ")}</p>
        <ol class="demo-steps">${steps.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ol>
        <div class="demo-cta">
          <p class="demo-hook">${escapeHtml(c.hook)}</p>
          <div class="demo-actions">
            <button type="button" class="primary demo-run" id="demo-run" ${demo.scenarioId ? "" : "disabled"}>${escapeHtml(c.button[mode])}</button>
            ${configHref ? `<a class="demo-config" id="demo-config" href="${configHref}">See how the scenario is configured</a>` : ""}
          </div>
          <p class="demo-caption" id="demo-caption">${escapeHtml(c.caption[mode])}</p>
          <div id="demo-error"></div>
        </div>
      </header>
      <div class="demo-grid">${c.sections.slice(0, 2).map((s) => section(s)).join("")}</div>
      ${c.sections.slice(2).map((s) => section(s, facts)).join("")}
      <p class="demo-footnote">${escapeHtml(c.footnote)}</p>
    </div>`;

  const button = document.getElementById("demo-run");
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const { id } = await apiDetailed("/api/demo/run", { method: "POST", body: "{}" });
      location.hash = `#/watch/${encodeURIComponent(id)}`;
    } catch (err) {
      button.disabled = false;
      document.getElementById("demo-error").innerHTML = `<div class="error-banner">${escapeHtml(err.message)}</div>`;
    }
  });
}
