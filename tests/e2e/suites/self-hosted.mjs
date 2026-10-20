// A self-hosted OpenAI-compatible endpoint (the runner starts a fake one, "lab-fake"): listed on Overview, offered in
// the editor with the models it serves, and a scenario runs on it end to end.
import { APP, openPage, sleep } from "../lib/browser.mjs";

const { send, js, waitFor, click, selectValue, type, text, step, shot, finish } = await openPage({ name: "self-hosted" });

await send("Runtime.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1300, height: 1000, deviceScaleFactor: 1, mobile: false });

await step("Overview lists the endpoint with its server URL", async () => {
  await send("Page.navigate", { url: `${APP}/#/` });
  await waitFor(`(document.querySelector("table")?.textContent ?? "").includes("lab-fake (self-hosted)")`, "endpoint row");
  if (!(await text("table")).includes("/v1")) throw new Error("server URL not shown");
});

await step("editor: the endpoint is a provider choice, its served models are offered, and the scenario runs on it", async () => {
  const { scenario } = await (await fetch(`${APP}/api/scenarios`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ builtin: "space-station" }) })).json();
  await send("Page.navigate", { url: `${APP}/#/scenarios/${scenario.id}?tab=agents` });
  await waitFor(`!!document.querySelector("#mp-agents-provider")`, "models panel");
  if (!(await js(`[...document.querySelector("#mp-agents-provider").options].some((o) => o.value === "openai-compatible:lab-fake")`))) throw new Error("endpoint not offered");
  await waitFor(`document.querySelectorAll("#compat-models-lab-fake option").length === 2`, "served models in the list");
  await selectValue("#mp-agents-provider", "openai-compatible:lab-fake");
  if ((await js(`document.querySelector("#mp-agents-model").getAttribute("list")`)) !== "compat-models-lab-fake") throw new Error("model field not bound to the endpoint's list");
  await type("#mp-agents-model", "lab/fake-model-7b");
  await click('[data-action="apply-models"][data-target="agents"]');
  await waitFor(`(document.querySelector("#editor-messages")?.textContent ?? "").includes("set for 4 agents")`, "applied");
  // Per agent: the select shows the endpoint, and the model is recognised as served.
  if ((await js(`document.querySelector('[data-path="agents.0.model.provider"]').value`)) !== "openai-compatible:lab-fake") throw new Error("agent select");
  await waitFor(`(document.querySelector("#editor-body")?.textContent ?? "").includes('Served by the self-hosted endpoint "lab-fake"')`, "served-model note");
  await shot("self-hosted-editor");
  await click("#btn-save");
  await waitFor(`document.querySelector(".success-banner")?.textContent.includes("Saved as version")`, "saved");
  const saved = (await (await fetch(`${APP}/api/scenarios/${scenario.id}`)).json()).scenario.config;
  if (!saved.agents.every((a) => a.model.provider === "openai-compatible" && a.model.endpoint === "lab-fake" && a.model.model === "lab/fake-model-7b")) throw new Error("not saved as provider + endpoint");

  const { id } = await (await fetch(`${APP}/api/scenarios/${scenario.id}/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json();
  let detail;
  for (let i = 0; i < 120; i++) {
    detail = await (await fetch(`${APP}/api/experiments/${id}`)).json();
    if (detail.experiment.finishedAt) break;
    await sleep(500);
  }
  if (detail.experiment.outcome !== "SUCCESS") throw new Error(`outcome ${detail.experiment.outcome}`);
  const events = (await (await fetch(`${APP}/api/experiments/${id}/events?after=0`)).json()).events;
  if (!events.some((e) => e.type === "llm_call" && e.payload.provider === "openai-compatible:lab-fake")) throw new Error("no call went to the endpoint");
});

await finish();
