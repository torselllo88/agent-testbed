// Research demo (#/research): the pilot's dev runs as a replay — pick an instance, the paired
// Complete/Ring view, what an agent had received before a turn, the information-flow tab (with or
// without detector output), the batch tab and the methods tab.
import { APP, openPage } from "../lib/browser.mjs";

const { send, js, waitFor, shot, click, text, step, finish } = await openPage({ name: "research" });

await send("Runtime.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 1100, deviceScaleFactor: 1, mobile: false });

await step("sidebar entry and the paired view of the first instance", async () => {
  await send("Page.navigate", { url: `${APP}/#/research` });
  await waitFor(`document.querySelectorAll(".research-col").length === 2`, "two columns");
  const nav = await text(".sidebar-nav");
  if (!nav.includes("Research demo")) throw new Error(`sidebar: ${nav}`);
  const turns = await js(`document.querySelectorAll(".research-col[data-run=complete] .research-turn").length`);
  if (turns !== 18) throw new Error(`turns: ${turns}`);
  const head = await text(".research-col[data-run=ring] .research-run-head");
  if (!head.includes("Proposal:") || !head.includes("ring:")) throw new Error(`ring head: ${head}`);
  const options = await js(`document.querySelectorAll("#research-instance option").length`);
  if (options !== 10) throw new Error(`options: ${options}`);
  await shot("research-compare");
});

await step("clicking an agent shows what it had received before that turn, in that graph", async () => {
  // Operations' first turn in the ring run: fewer messages than in the complete run at the same point.
  await click(`.research-col[data-run=ring] .research-agent[data-agent=Operations]`);
  await waitFor(`!document.querySelector("#research-focus").classList.contains("hidden")`, "focus panel");
  const focus = await text("#research-focus");
  if (!focus.includes("Operations") || !focus.includes("before turn") || !focus.includes("Received before this turn")) throw new Error(`focus: ${focus.slice(0, 200)}`);
  if (!focus.includes("You hold no private task information")) throw new Error("role card missing");
  const ringSeen = Number((focus.match(/Received before this turn:<\/strong> (\d+)/) ?? focus.match(/Received before this turn: (\d+)/))?.[1] ?? NaN);
  const completeSeen = Number(focus.match(/\((\d+) in the Complete run/)?.[1] ?? NaN);
  if (!(ringSeen <= completeSeen)) throw new Error(`seen ring ${ringSeen} > complete ${completeSeen}`);
  await shot("research-focus");
  await click("#research-focus-close");
  await waitFor(`document.querySelector("#research-focus").classList.contains("hidden")`, "focus closed");
});

await step("instance switch keeps the layout and updates the canonical outcome", async () => {
  await js(`(() => { const s = document.querySelector("#research-instance"); s.value = "DEV-08"; s.dispatchEvent(new Event("change")); })()`);
  await waitFor(`document.querySelector(".research-bar")?.textContent.includes("reject")`, "DEV-08 canonical reject");
  await waitFor(`location.hash === "#/research/DEV-08"`, "hash follows the instance");
});

await step("information flow tab: the ten facts, or the note that the detector has not run", async () => {
  await click(`.tab[data-tab=flow]`);
  await waitFor(`!!document.querySelector(".research-facts") || document.querySelector("#research-body")?.textContent.includes("detector has not been run")`, "flow tab");
  const hasFacts = await js(`!!document.querySelector(".research-facts")`);
  if (hasFacts) {
    const rows = await js(`document.querySelectorAll(".research-fact").length`);
    if (rows !== 10) throw new Error(`facts: ${rows}`);
    await click(".research-fact");
    await waitFor(`document.querySelectorAll(".research-chain, .research-chain-head").length >= 2`, "chains for both graphs");
  }
  await shot("research-flow");
});

await step("batch tab: pair outcomes, per-graph context, the instance list", async () => {
  await click(`.tab[data-tab=batch]`);
  await waitFor(`document.querySelector("#research-body")?.textContent.includes("Pair outcomes")`, "batch tab");
  const body = await text("#research-body");
  if (!body.includes("both correct") || !body.includes("message tokens median")) throw new Error(`batch: ${body.slice(0, 200)}`);
  const rows = await js(`document.querySelectorAll("#research-body a[data-pick]").length`);
  if (rows !== 10) throw new Error(`instance rows: ${rows}`);
  await shot("research-batch");
  await click(`#research-body a[data-pick="DEV-03"]`);
  await waitFor(`document.querySelectorAll(".research-col").length === 2 && location.hash === "#/research/DEV-03"`, "back to compare on DEV-03");
});

await step("methods tab: configuration and the six gates", async () => {
  await click(`.tab[data-tab=methods]`);
  await waitFor(`document.querySelector("#research-body")?.textContent.includes("G6 determinism")`, "methods tab");
  const body = await text("#research-body");
  if (!body.includes("qwen3.8:27b") || !body.includes("G1 delivery")) throw new Error(`methods: ${body.slice(0, 200)}`);
  await shot("research-methods");
});

await finish();
