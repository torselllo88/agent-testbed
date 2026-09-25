// Renders the persistent left-sidebar chrome once, and owns the theme
// toggle. Route highlighting is handled separately by setActiveRoute() so
// the sidebar itself never needs to re-render on navigation.
import { iconBatch, iconDashboard, iconExperiment, iconMoon, iconScenario, iconSun } from "./icons.js";

const NAV_ITEMS = [
  { route: "home", href: "#/", icon: iconDashboard, label: "Overview" },
  { route: "scenarios", href: "#/scenarios", icon: iconScenario, label: "Scenarios" },
  { route: "experiments", href: "#/experiments", icon: iconExperiment, label: "Experiments" },
  { route: "batches", href: "#/batches", icon: iconBatch, label: "Batches" },
];

function navLinkHtml(item) {
  return `<a href="${item.href}" class="sidebar-nav-item" data-route="${item.route}"><span class="sidebar-icon">${item.icon()}</span>${item.label}</a>`;
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  const toggle = document.getElementById("theme-toggle");
  if (toggle) toggle.innerHTML = theme === "dark" ? iconSun() : iconMoon();
}

function readStoredTheme() {
  try {
    return localStorage.getItem("theme");
  } catch {
    return null;
  }
}

export function initShell() {
  const sidebar = document.getElementById("sidebar");
  sidebar.innerHTML = `
    <a href="#/" class="brand">◆ Agent Testbed</a>
    <div class="sidebar-nav">
      ${NAV_ITEMS.map(navLinkHtml).join("")}
    </div>
    <button type="button" class="theme-toggle" id="theme-toggle" title="Toggle light/dark theme"></button>
  `;

  const theme = readStoredTheme() || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  applyTheme(theme);

  document.getElementById("theme-toggle").addEventListener("click", () => {
    const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    try {
      localStorage.setItem("theme", next);
    } catch {
      // Storage unavailable (private window, blocked site data) — the toggle still works for this page view.
    }
    applyTheme(next);
  });
}

/** Called by the router after every navigation — highlights the current section without re-rendering the sidebar. */
export function setActiveRoute(routeKey) {
  document.querySelectorAll(".sidebar-nav-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.route === routeKey);
  });
}
