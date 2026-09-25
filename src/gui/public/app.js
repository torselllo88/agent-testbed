import { renderHome } from "./pages/home.js";
import { initShell, setActiveRoute } from "./shell.js";

const ROUTES = [];

function router() {
  const hash = location.hash || "#/";
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
