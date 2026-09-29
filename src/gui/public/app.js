import { renderBatch } from "./pages/batch.js";
import { renderBatches } from "./pages/batches.js";
import { renderExperiment } from "./pages/experiment.js";
import { renderExperiments } from "./pages/experiments.js";
import { renderHome } from "./pages/home.js";
import { renderScenarioEditor } from "./pages/scenarioEditor.js";
import { renderScenarios } from "./pages/scenarios.js";
import { renderWatch } from "./pages/watch.js";
import { initShell, setActiveRoute } from "./shell.js";

const ROUTES = [
  // Viewer mode: full screen, no sidebar (see styles.css body.watch-mode).
  { pattern: /^#\/watch\/([^/]+)$/, routeKey: "watch", render: (m) => renderWatch(decodeURIComponent(m[1])) },
  {
    pattern: /^#\/scenarios\/([^/?]+)(?:\?tab=(\w+))?$/,
    routeKey: "scenarios",
    render: (m) => renderScenarioEditor(decodeURIComponent(m[1]), m[2]),
  },
  { pattern: /^#\/scenarios$/, routeKey: "scenarios", render: renderScenarios },
  { pattern: /^#\/experiments\/([^/]+)$/, routeKey: "experiments", render: (m) => renderExperiment(decodeURIComponent(m[1])) },
  { pattern: /^#\/experiments$/, routeKey: "experiments", render: renderExperiments },
  { pattern: /^#\/batches\/([^/]+)$/, routeKey: "batches", render: (m) => renderBatch(decodeURIComponent(m[1])) },
  { pattern: /^#\/batches$/, routeKey: "batches", render: renderBatches },
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
