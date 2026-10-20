// Scenario editor, live control view, operator controls, trace, rerun, theme.
import { APP, EXT, EXT_TOKEN, openPage, sleep } from "../lib/browser.mjs";

const { send, js, waitFor, shot, click, clickText, type, selectValue, text, step, finish } = await openPage({ name: "core-ui" });

await send("Runtime.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: `${APP}/#/scenarios` });
await waitFor(`!!document.querySelector("#create-btn")`, "scenarios page");

await step("create scenario from template", async () => {
  await click("#create-btn");
  await waitFor(`location.hash.startsWith("#/scenarios/") && !!document.querySelector("#btn-save")`, "editor");
});

await step("edit name -> Save enabled -> save bumps version", async () => {
  if (!(await js(`document.querySelector("#btn-save").disabled`))) throw new Error("Save should start disabled");
  await type('[data-path="name"]', "Smoke Station");
  if (await js(`document.querySelector("#btn-save").disabled`)) throw new Error("Save not enabled after edit");
  await click("#btn-save");
  await waitFor(`document.querySelector(".success-banner")?.textContent.includes("version 2")`, "saved v2");
});

await step("agents tab: edit temperature of first agent", async () => {
  await clickText("button.tab", "Agents");
  await waitFor(`!!document.querySelector('[data-path="agents.0.model.temperature"]')`, "agents tab");
  await type('[data-path="agents.0.model.temperature"]', "0.3");
});

await step("protocol tab: switch to round_robin (structural re-render)", async () => {
  await clickText("button.tab", "Protocol");
  await waitFor(`!!document.querySelector('[data-path="scheduler.type"]')`, "protocol tab");
  if (!(await js(`!!document.querySelector('[data-path="scheduler.classifier.model"]')`))) throw new Error("classifier fields missing for hybrid");
  await selectValue('[data-path="scheduler.type"]', "round_robin");
  await waitFor(`!document.querySelector('[data-path="scheduler.classifier.model"]')`, "classifier fields gone");
});

await step("raw JSON reflects form edits; invalid JSON blocks leaving the tab", async () => {
  await clickText("button.tab", "Raw JSON");
  const raw = await js(`document.querySelector("#raw-json").value`);
  const parsed = JSON.parse(raw);
  if (parsed.scheduler.type !== "round_robin") throw new Error("raw json scheduler not round_robin");
  if (parsed.agents[0].model.temperature !== 0.3) throw new Error("raw json temperature not 0.3");
  await type("#raw-json", raw.slice(0, -5));
  await waitFor(`document.querySelector("#editor-body .error-banner")?.textContent.includes("Not valid JSON")`, "raw error");
  await clickText("button.tab", "Task");
  if (!(await js(`!!document.querySelector("#raw-json")`))) throw new Error("left raw tab despite invalid JSON");
  await type("#raw-json", raw);
});

await step("validate reports a runnable config", async () => {
  await click("#btn-validate");
  await waitFor(`document.querySelector("#editor-messages .success-banner")?.textContent.includes("valid and runnable")`, "validate ok");
});

await step("validate reports problems for a broken proposer", async () => {
  const raw = JSON.parse(await js(`document.querySelector("#raw-json").value`));
  raw.decision.proposerId = "nobody";
  await type("#raw-json", JSON.stringify(raw, null, 2));
  await click("#btn-validate");
  await waitFor(`document.querySelector("#editor-messages .error-banner")?.textContent.includes("proposerId")`, "validate error");
  raw.decision.proposerId = "operations";
  await type("#raw-json", JSON.stringify(raw, null, 2));
});

let experimentHash;
await step("Run saves and opens the live experiment view", async () => {
  await click("#btn-run");
  // The run dialog: conversation language for this run, then Start (control view).
  await waitFor(`!!document.querySelector('[data-go="control"]')`, "run dialog");
  await click('[data-go="control"]');
  await waitFor(`location.hash.startsWith("#/experiments/")`, "experiment page");
  experimentHash = await js("location.hash");
  await waitFor(`document.querySelectorAll("#room .msg").length >= 1`, "first room message");
});

await step("pause holds the run; state shows PAUSED", async () => {
  await clickText("#controls button", "Pause");
  await waitFor(`document.querySelector("#state-panel")?.textContent.includes("PAUSED")`, "paused badge");
  const before = await text("#state-panel");
  await sleep(1500);
  const turnsBefore = /Turns(\d+)\//.exec(before.replace(/\s+/g, ""))?.[1];
  const turnsAfter = /Turns(\d+)\//.exec((await text("#state-panel")).replace(/\s+/g, ""))?.[1];
  if (!turnsBefore || turnsBefore !== turnsAfter) throw new Error(`turns advanced while paused: ${turnsBefore} -> ${turnsAfter}`);
});

await step("debug toggle shows control metadata inline", async () => {
  if (!(await js(`document.querySelector("#debug-toggle").checked`))) await click("#debug-toggle");
  await waitFor(`document.querySelectorAll("#room .msg.debug").length > 0`, "debug items");
  await shot("live-paused-debug");
});

await step("force next turn while paused advances exactly one activation", async () => {
  const turnOf = async () => Number(/Turns(\d+)\//.exec((await text("#state-panel")).replace(/\s+/g, ""))?.[1]);
  const before = await turnOf();
  await clickText("#controls button", "Force next turn");
  await waitFor(`(() => { const m = /Turns(\\d+)\\//.exec(document.querySelector("#state-panel").textContent.replace(/\\s+/g, "")); return m && Number(m[1]) === ${before + 1}; })()`, "one more turn");
  await sleep(1200);
  if ((await turnOf()) !== before + 1) throw new Error("more than one turn ran");
});

await step("resume runs to completion; results render", async () => {
  await clickText("#controls button", "Resume");
  await waitFor(`!!document.querySelector("#results .outcome-line")`, "results", 40000);
  const outcome = await text("#results .outcome-line");
  if (!outcome.includes("SUCCESS")) throw new Error(`unexpected outcome: ${outcome}`);
  if (await js(`document.querySelector("#controls").textContent.trim().length > 0`)) throw new Error("controls still shown after finish");
  if (!(await js(`(document.querySelector("#results")?.textContent ?? "").includes("Who addressed whom")`))) throw new Error("no Communication card");
});

await step("trace: filter by type and expand a payload", async () => {
  await js(`document.querySelector("#trace details").open = true`);
  await selectValue("#trace-filter", "vote_cast");
  await waitFor(`document.querySelectorAll("#trace tr[data-seq]").length === 4`, "4 vote_cast rows");
  await click("#trace tr[data-seq]");
  await waitFor(`document.querySelector("#trace .payload-row")?.textContent.includes("proposalHash")`, "payload expanded");
  await shot("results");
});

await step("experiments list shows the finished run", async () => {
  await send("Page.navigate", { url: `${APP}/#/experiments` });
  // Wait for the list itself: the previous page may still show table rows of its own for a moment.
  await waitFor(`location.hash === "#/experiments" && document.querySelector("h1")?.textContent.includes("Experiments") && (document.querySelector("tbody")?.textContent ?? "").includes("Smoke Station")`, "the run listed under the renamed scenario");
});

await step("rerun from the experiment page starts a new run", async () => {
  await send("Page.navigate", { url: `${APP}/${experimentHash}` });
  await waitFor(`!!document.querySelector("#btn-rerun")`, "experiment page");
  await click("#btn-rerun");
  await waitFor(`location.hash.startsWith("#/experiments/") && location.hash !== ${JSON.stringify(experimentHash)}`, "new experiment");
  await clickText("#controls button", "Stop").catch(() => {}); // confirm dialog auto-accepted
  await waitFor(`document.querySelector("#results .outcome-line")?.textContent.includes("STOPPED_BY_OPERATOR")`, "stopped", 20000);
  if (!(await text(".page-header")).includes("manual intervention")) throw new Error("stopped run not marked as manual intervention");
});

await step("dark theme toggle", async () => {
  const before = await js(`document.documentElement.getAttribute("data-theme")`);
  await click("#theme-toggle");
  const after = await js(`document.documentElement.getAttribute("data-theme")`);
  if (after === before) throw new Error("theme did not change");
  if (after !== "dark") await click("#theme-toggle");
  await shot("dark");
});

await finish();
