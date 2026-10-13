// About & demo: the one-screen introduction, its single button, the viewer, and the way to the results.
import { APP, openPage } from "../lib/browser.mjs";

const { send, js, waitFor, click, step, shot, finish } = await openPage({ name: "demo" });

await send("Runtime.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1300, height: 1000, deviceScaleFactor: 1, mobile: false });

await step("the page introduces the testbed and offers one button (scripted here: no OpenRouter key)", async () => {
  await send("Page.navigate", { url: `${APP}/#/demo` });
  await waitFor(`!!document.querySelector("#demo-run")`, "demo page");
  if ((await js(`document.querySelectorAll("#demo-run, .demo button").length`)) !== 1) throw new Error("more than one button");
  const body = await js(`document.querySelector(".demo").textContent`);
  for (const piece of ["Controlled experiments for multi-agent LLM coordination", "What can we study?", "Adaptable by design", "Try it:"]) {
    if (!body.includes(piece)) throw new Error(`missing: ${piece}`);
  }
  if (!(await js(`document.querySelector("#demo-caption").textContent.includes("scripted agents")`))) throw new Error("scripted mode not labelled");
  if (!(await js(`document.querySelector('.sidebar-nav-item[data-route="demo"]')?.classList.contains("active")`))) throw new Error("sidebar entry not active");
  await shot("demo-page");
});

await step("the configuration link opens the scenario's full settings on the Agents tab, with a guide to the tabs", async () => {
  if (!(await js(`document.querySelectorAll(".demo-facts li").length >= 5`))) throw new Error("no facts line");
  await click("#demo-config");
  await waitFor(`location.hash.includes("tab=agents") && !!document.querySelector(".demo-guide") && !!document.querySelector('[data-path="agents.0.privateContext"]')`, "editor with the guide");
  await shot("demo-config");
  await click(".demo-guide a[href=\"#/demo\"]");
  await waitFor(`!!document.querySelector("#demo-run")`, "back on the demo page");
});

await step("the button starts the run in the viewer; when it ends, one click leads to how it was judged", async () => {
  await click("#demo-run");
  await waitFor(`location.hash.startsWith("#/watch/")`, "viewer");
  if (!(await js(`document.getElementById("watch-results").hidden`))) throw new Error("results link shown during the run");
  await waitFor(`!document.getElementById("watch-results").hidden`, "results link after the run", 240000);
  await shot("demo-viewer-ended");
  await click("#watch-results");
  await waitFor(`location.hash.startsWith("#/experiments/") && !!document.querySelector("#results .outcome-line")`, "results page", 20000);
  if (!(await js(`document.querySelector("#results .outcome-line").textContent.includes("SUCCESS")`))) throw new Error("outcome not shown");
});

await step("phone width: the page has no horizontal scroll", async () => {
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send("Page.navigate", { url: `${APP}/#/demo` });
  await waitFor(`!!document.querySelector("#demo-run")`, "demo page");
  if (await js(`document.documentElement.scrollWidth > window.innerWidth + 1`)) throw new Error("horizontal scroll");
});

await finish();
