// Choosing models for many agents at once: the editor's Models panel (saved) and the run dialog (this run only).
import { APP, openPage, sleep } from "../lib/browser.mjs";

const { send, js, waitFor, click, selectValue, type, text, step, shot, finish } = await openPage({ name: "models" });

await send("Runtime.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1300, height: 1000, deviceScaleFactor: 1, mobile: false });

const { scenario } = await (await fetch(`${APP}/api/scenarios`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ builtin: "space-station" }) })).json();
const agentModels = () => js(`[...document.querySelectorAll('[data-path^="agents."][data-path$=".model.model"]')].map((el) => el.value)`);

await step("editor: the Models panel sets every agent's model in one step, and the router's in another", async () => {
  await send("Page.navigate", { url: `${APP}/#/scenarios/${scenario.id}?tab=agents` });
  await waitFor(`!!document.querySelector("#mp-agents-model")`, "models panel");
  if (!(await text(".model-panel")).includes("(all 4)")) throw new Error("panel does not summarize the current models");
  await selectValue("#mp-agents-provider", "stub");
  await type("#mp-agents-model", "space-station/insufficient-power");
  await click('[data-action="apply-models"][data-target="agents"]');
  await waitFor(`(document.querySelector("#editor-messages")?.textContent ?? "").includes("set for 4 agents")`, "applied notice");
  const models = await agentModels();
  if (models.length !== 4 || models.some((m) => m !== "space-station/insufficient-power")) throw new Error(`agent models ${models}`);
  if (!(await text(".model-panel")).includes("space-station/insufficient-power (all 4)")) throw new Error("summary not updated");

  await selectValue("#mp-orchestration-provider", "stub");
  await type("#mp-orchestration-model", "router/next-in-order");
  await click('[data-action="apply-models"][data-target="orchestration"]');
  await waitFor(`(document.querySelector("#editor-messages")?.textContent ?? "").includes("set for 1 router")`, "router applied");
  await shot("models-panel");

  await click("#btn-save");
  await waitFor(`document.querySelector(".success-banner")?.textContent.includes("Saved as version")`, "saved");
  const saved = (await (await fetch(`${APP}/api/scenarios/${scenario.id}`)).json()).scenario.config;
  if (!saved.agents.every((a) => a.model.model === "space-station/insufficient-power")) throw new Error("not saved");
});

await step("run dialog: models chosen for this run only — the run uses them, the scenario keeps its own", async () => {
  await click("#btn-run");
  await waitFor(`!!document.querySelector("#rd-models")`, "run dialog");
  await waitFor(`(document.querySelector("#rd-models-now")?.textContent ?? "").includes("insufficient-power (all 4)")`, "current models shown");
  await selectValue("#rd-models", "choose");
  await selectValue("#rd-agents-provider", "stub");
  await type("#rd-agents-model", "space-station/cooperative");
  await click('[data-go="control"]');
  await waitFor(`location.hash.startsWith("#/experiments/")`, "experiment page");
  const id = decodeURIComponent((await js("location.hash")).split("/")[2]);
  let detail;
  for (let i = 0; i < 120; i++) {
    detail = await (await fetch(`${APP}/api/experiments/${id}`)).json();
    if (detail.experiment.finishedAt) break;
    await sleep(500);
  }
  if (detail.experiment.outcome !== "SUCCESS") throw new Error(`outcome ${detail.experiment.outcome} (the chosen cooperative stub should succeed)`);
  if (!detail.experiment.config.agents.every((a) => a.model.model === "space-station/cooperative")) throw new Error("run snapshot does not hold the chosen models");
  const events = (await (await fetch(`${APP}/api/experiments/${id}/events?after=0`)).json()).events;
  if (events.find((e) => e.type === "experiment_started")?.payload.environment.modelsOverridden !== true) throw new Error("modelsOverridden not recorded");
  const saved = (await (await fetch(`${APP}/api/scenarios/${scenario.id}`)).json()).scenario.config;
  if (!saved.agents.every((a) => a.model.model === "space-station/insufficient-power")) throw new Error("the saved scenario changed");
});

await finish();
