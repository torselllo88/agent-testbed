// Exposure in the web UI: labeling a batch (keyword stub detector), the summary, a manual-labeling sample, agreement, the run page.
import { APP, openPage, sleep } from "../lib/browser.mjs";

const { send, js, waitFor, shot, click, type, selectValue, text, step, finish } = await openPage({ name: "exposure" });

await send("Runtime.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });

// A small batch to label: complete vs ring, no vote, scripted agents.
const created = await (
  await fetch(`${APP}/api/batches`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      spec: {
        name: "exposure e2e",
        base: { builtin: "service-settlement" },
        repetitions: 1,
        variables: [
          { path: "communication", label: "graph", values: [{ topology: { type: "complete" } }, { topology: { type: "ring" } }] },
          { path: "consensus", values: [{ rule: "none" }] },
        ],
      },
    }),
  })
).json();
const batchId = created.batch.id;
for (let i = 0; i < 100; i++) {
  const view = await (await fetch(`${APP}/api/batches/${batchId}`)).json();
  if (view.batch.status === "completed") break;
  await sleep(200);
}

await send("Page.navigate", { url: `${APP}/#/batches/${batchId}` });
await waitFor(`!!document.querySelector("#exposure-card #exp-start")`, "exposure section");

await step("label the batch with the keyword stub; the summary compares the conditions", async () => {
  await js(`document.querySelector("#exp-label").open = true`);
  await waitFor(`!!document.querySelector("#exp-model-provider")`, "detector picker");
  await selectValue("#exp-model-provider", "stub");
  await type("#exp-model-model", "detector/keywords");
  await click("#exp-start");
  await waitFor(`document.querySelector("#exp-job")?.textContent.includes("Last labeling completed")`, "job completed", 30000);
  await waitFor(`document.querySelectorAll("#exp-summary tbody tr").length === 3`, "two conditions and the overall row");
  const summary = await text("#exp-summary");
  if (!summary.includes("2 of 2 evaluable run(s) labeled")) throw new Error(`summary: ${summary.slice(0, 200)}`);
  if (!summary.includes("from verification")) throw new Error("by-source columns missing");
  await shot("exposure-batch");
});

let annotateHash;
await step("create a sample; it is listed with a Label link", async () => {
  await type("#exp-n", "3");
  await type("#exp-name", "e2e sample");
  await click("#exp-sample");
  await waitFor(`[...document.querySelectorAll("#exp-samples td")].some((td) => td.textContent.includes("e2e sample"))`, "sample row");
  annotateHash = await js(`new URL([...document.querySelectorAll("#exp-samples a")].find((a) => a.textContent === "Label").href).hash`);
});

await step("label the sample in the browser: name, every proposition, three messages", async () => {
  await js(`localStorage.removeItem("testbed.annotator")`);
  await send("Page.navigate", { url: `${APP}/${annotateHash}` });
  await waitFor(`!!document.querySelector("#an-name")`, "name form");
  await type("#an-name", "Ana");
  await click("#an-go");
  await waitFor(`!!document.querySelector("#an-save")`, "first message");
  if ((await js(`document.body.textContent.includes("detector")`)) && (await js(`!!document.querySelector(".an-table .badge")`))) throw new Error("detector labels visible");
  // Saving with empty labels is refused.
  await click("#an-save");
  await waitFor(`document.querySelector("#an-error")?.textContent.includes("without a label")`, "missing labels error");
  for (let i = 0; i < 3; i++) {
    await click("#an-rest-absent");
    if (i === 0) {
      const radio = await js(`!!document.querySelector(".an-choice input[value=correct]")`);
      if (!radio) throw new Error("no label choices");
      await js(`document.querySelector(".an-choice input[value=correct]").click()`);
      await shot("exposure-annotate");
    }
    await click("#an-save");
    await sleep(300);
  }
  await waitFor(`document.querySelector("#an-error")?.textContent.includes("All 3 messages labeled")`, "all labeled");
});

await step("agreement on the batch page: detector vs Ana", async () => {
  await send("Page.navigate", { url: `${APP}/#/batches/${batchId}` });
  await waitFor(`!!document.querySelector("[data-agreement]")`, "agreement button");
  if (!(await text("#exp-samples")).includes("Ana 3/3")) throw new Error(`annotators: ${await text("#exp-samples")}`);
  await click("[data-agreement]");
  await waitFor(`document.querySelector("#exp-agreement")?.textContent.includes("detector ↔ Ana")`, "agreement table");
});

await step("run page: what reached the proposer, per proposition", async () => {
  const runs = (await (await fetch(`${APP}/api/experiments?batchId=${batchId}&limit=10`)).json()).experiments;
  await send("Page.navigate", { url: `${APP}/#/experiments/${runs[0].id}` });
  await waitFor(`document.querySelector("#exposure")?.textContent.includes("Reached the proposer")`, "exposure card", 15000);
  if (!(await text("#exposure")).includes("Private facts of the others")) throw new Error("summary line missing");
  await shot("exposure-run");
});

await finish();
