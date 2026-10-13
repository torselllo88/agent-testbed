// The viewer can stop a running run (the same operator action as the control view's Stop).
import { APP, openPage, sleep } from "../lib/browser.mjs";

const { send, js, waitFor, click, step, shot, finish } = await openPage({ name: "viewer-stop" });

await send("Runtime.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1300, height: 900, deviceScaleFactor: 1, mobile: false });

await step("Stop is offered while the run is live, ends it as stopped by the operator, and no debrief follows", async () => {
  const scenarios = (await (await fetch(`${APP}/api/scenarios`)).json()).scenarios;
  const paced = scenarios.find((s) => s.builtin?.id === "station-kestrel");
  const { id } = await (await fetch(`${APP}/api/scenarios/${paced.id}/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json();
  await send("Page.navigate", { url: `${APP}/#/watch/${id}` });
  await waitFor(`document.getElementById("watch-stop")?.hidden === false`, "Stop while live");
  if (!(await js(`document.getElementById("watch-results").hidden`))) throw new Error("results link shown while live");
  await shot("viewer-stop-live");
  await click("#watch-stop"); // the confirmation dialog is accepted by the harness
  await waitFor(`document.getElementById("watch-stop").hidden && !document.getElementById("watch-results").hidden`, "stopped: results link instead of Stop", 30000);
  let detail;
  for (let i = 0; i < 40; i++) {
    detail = await (await fetch(`${APP}/api/experiments/${id}`)).json();
    if (detail.experiment.finishedAt) break;
    await sleep(250);
  }
  if (detail.experiment.outcome !== "STOPPED_BY_OPERATOR") throw new Error(`outcome ${detail.experiment.outcome}`);
  await sleep(1500);
  const room = await (await fetch(`${APP}/api/experiments/${id}/interaction?after=0`)).json();
  if (room.mode === "debrief") throw new Error("a debrief opened after an operator stop");
});

await finish();
