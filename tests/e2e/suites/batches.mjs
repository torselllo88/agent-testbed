// Batch form, preview and validation, run, aggregates, CSV export, list filters.
import { APP, EXT, EXT_TOKEN, openPage, sleep } from "../lib/browser.mjs";

const { send, js, waitFor, shot, click, clickText, type, selectValue, text, step, finish } = await openPage({ name: "batches" });

await send("Runtime.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: `${APP}/#/batches` });
await waitFor(`!!document.querySelector("#b-start")`, "batches page");

await step("form: add a second variable from a preset (values pre-filled)", async () => {
  await click("#b-add-var");
  const rows = await js(`document.querySelectorAll(".var-row").length`);
  if (rows !== 2) throw new Error(`expected 2 variable rows, got ${rows}`);
  await type(".var-row:nth-child(2) .v-path", "consensus.rule");
  const values = await js(`document.querySelector(".var-row:nth-child(2) .v-values").value`);
  if (!values.includes("majority")) throw new Error(`preset values not filled: ${values}`);
  await type(".var-row:nth-child(2) .v-label", "consensus");
  await type("#b-reps", "3");
  await type("#b-conc", "2");
});

await step("preview lists 4 conditions and 12 runs", async () => {
  await click("#b-preview");
  await waitFor(`document.querySelector("#b-preview-out .success-banner")?.textContent.includes("12 runs")`, "preview");
  const n = await js(`document.querySelectorAll("#b-preview-out li").length`);
  if (n !== 4) throw new Error(`expected 4 conditions, got ${n}`);
});

await step("preview reports invalid JSON values", async () => {
  await type(".var-row:nth-child(2) .v-values", '["unanimity", ');
  await click("#b-preview");
  await waitFor(`document.querySelector("#b-preview-out .error-banner")?.textContent.includes("not valid JSON")`, "json error");
  await type(".var-row:nth-child(2) .v-values", '["unanimity", "majority"]');
});

let batchHash;
await step("start: batch runs fast (no inherited 300 ms stub latency) and shows aggregates", async () => {
  const t0 = Date.now();
  await click("#b-start");
  await waitFor(`location.hash.startsWith("#/batches/")`, "batch page");
  batchHash = await js("location.hash");
  await waitFor(`document.querySelector(".page-header")?.textContent.includes("completed")`, "batch completed", 30000);
  const elapsed = Date.now() - t0;
  // 12 runs × 16 stub calls × 300 ms would be ~58 s even at concurrency 2.
  if (elapsed > 15000) throw new Error(`batch took ${elapsed} ms — stub latency inherited?`);
  const rows = await js(`document.querySelectorAll("table tbody tr").length`);
  if (rows < 4) throw new Error(`expected 4 aggregate rows, got ${rows}`);
  const overall = await text("tfoot");
  if (!overall.includes("12 / 12")) throw new Error(`overall row: ${overall}`);
  await shot("batch-results");
});

await step("CSV export link serves 12 run rows", async () => {
  const href = await js(`[...document.querySelectorAll("a.button-like")].find((a) => a.textContent.includes("CSV")).href`);
  const csv = await (await fetch(href)).text();
  const lines = csv.trim().split("\n");
  if (lines.length !== 13) throw new Error(`expected 13 csv lines, got ${lines.length}`);
  if (!lines[0].includes("var:consensus")) throw new Error("csv header lacks variable column");
});

await step("runs list links to a batch run's experiment page", async () => {
  await js(`document.querySelectorAll("details")[0].open = true`);
  await click("details tr.link-row");
  await waitFor(`location.hash.startsWith("#/experiments/") && !!document.querySelector("#results .outcome-line")`, "experiment page");
});

await step("experiments list hides batch runs by default; toggle shows them", async () => {
  await send("Page.navigate", { url: `${APP}/#/experiments` });
  await waitFor(`!!document.querySelector("#include-batches")`, "experiments page");
  const hidden = await js(`document.querySelectorAll("tr.link-row").length`);
  await click("#include-batches");
  await waitFor(`document.querySelectorAll("tr.link-row").length === 12`, "12 batch runs listed");
  if (hidden !== 0) throw new Error(`expected 0 interactive runs, got ${hidden}`);
});

await step("batches list shows the completed batch", async () => {
  await send("Page.navigate", { url: `${APP}/#/batches` });
  await waitFor(`document.querySelectorAll("tr.link-row").length === 1`, "batch row");
  if (!(await text("tbody")).includes("12 / 12")) throw new Error("progress not shown");
});

await finish();
