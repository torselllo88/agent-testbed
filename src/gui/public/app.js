import { renderAnnotate } from "./pages/annotate.js";
import { renderBatch } from "./pages/batch.js";
import { renderBatches } from "./pages/batches.js";
import { renderDemo } from "./pages/demo.js";
import { renderExperiment } from "./pages/experiment.js";
import { renderExperiments } from "./pages/experiments.js";
import { renderHome } from "./pages/home.js";
import { renderResearch } from "./pages/research.js";
import { renderResearchRuns } from "./pages/researchRuns.js";
import { renderScenarioEditor } from "./pages/scenarioEditor.js";
import { renderScenarios } from "./pages/scenarios.js";
import { renderWatch } from "./pages/watch.js";
import { initShell, setActiveRoute } from "./shell.js";

const ROUTES = [
  // Viewer mode: full screen, no sidebar (see styles.css body.watch-mode).
  { pattern: /^#\/watch\/([^/]+)$/, routeKey: "watch", render: (m) => renderWatch(decodeURIComponent(m[1])) },
  {
    pattern: /^#\/scenarios\/([^/?]+)(?:\?tab=(\w+)(?:&from=(\w+))?)?$/,
    routeKey: "scenarios",
    render: (m) => renderScenarioEditor(decodeURIComponent(m[1]), m[2], m[3]),
  },
  { pattern: /^#\/scenarios$/, routeKey: "scenarios", render: renderScenarios },
  { pattern: /^#\/experiments\/([^/]+)$/, routeKey: "experiments", render: (m) => renderExperiment(decodeURIComponent(m[1])) },
  { pattern: /^#\/experiments$/, routeKey: "experiments", render: renderExperiments },
  { pattern: /^#\/batches\/([^/]+)$/, routeKey: "batches", render: (m) => renderBatch(decodeURIComponent(m[1])) },
  { pattern: /^#\/batches$/, routeKey: "batches", render: renderBatches },
  { pattern: /^#\/annotate\/([^/]+)$/, routeKey: "batches", render: (m) => renderAnnotate(decodeURIComponent(m[1])) },
  { pattern: /^#\/demo$/, routeKey: "demo", render: renderDemo },
  { pattern: /^#\/research\/runs$/, routeKey: "research-runs", render: renderResearchRuns },
  { pattern: /^#\/research\/([^/]+)\/live\/([^/]+)$/, routeKey: "research", render: (m) => renderResearch(decodeURIComponent(m[1]), decodeURIComponent(m[2])) },
  { pattern: /^#\/research(?:\/([^/]+))?$/, routeKey: "research", render: (m) => renderResearch(m[1] ? decodeURIComponent(m[1]) : undefined) },
];

function router() {
  const hash = location.hash || "#/";
  document.body.classList.toggle("watch-mode", hash.startsWith("#/watch/"));
  for (const route of ROUTES) {
    const match = route.pattern.exec(hash);
    if (match) {
      setActiveRoute(route.routeKey);
      route.render(match);
      return;
    }
  }
  setActiveRoute("home");
  renderHome();
}

initShell();
window.addEventListener("hashchange", router);
router();
