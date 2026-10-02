// OpenRouter routing fields in the editor: parsing, warnings, save/reload, provider switch.
import { APP, EXT, EXT_TOKEN, openPage, sleep } from "../lib/browser.mjs";

const { send, js, waitFor, shot, click, clickText, type, selectValue, text, step, finish } = await openPage({ name: "openrouter-routing" });

await send("Runtime.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
const draftRouting = async () => {
  await clickText("button.tab", "Raw JSON");
  const cfg = JSON.parse(await js(`document.querySelector("#raw-json").value`));
  await clickText("button.tab", "Agents");
  await waitFor(`!!document.querySelector('[data-path="agents.0.model.provider"]')`, "agents tab");
  return cfg.agents[0].model.routing;
};
const { scenario: own } = await (await fetch(`${APP}/api/scenarios`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ builtin: "space-station" }) })).json();
const sid = own.id;

await step("routing block appears only for openrouter", async () => {
  await send("Page.navigate", { url: `${APP}/#/scenarios/${sid}?tab=agents` });
  await waitFor(`!!document.querySelector('[data-path="agents.0.model.provider"]')`, "agents tab");
  if (await js(`!!document.querySelector('[data-path="agents.0.model.routing.only"]')`)) throw new Error("routing shown for stub");
  await selectValue('[data-path="agents.0.model.provider"]', "openrouter");
  await waitFor(`!!document.querySelector('[data-path="agents.0.model.routing.only"]')`, "routing fields");
  const summary = await text("details.advanced summary");
  if (!summary.includes("automatic")) throw new Error(`summary: ${summary}`);
});

await step("slug lists are parsed into arrays", async () => {
  await type('[data-path="agents.0.model.routing.only"]', "together,  deepinfra ");
  const routing = await draftRouting();
  if (JSON.stringify(routing) !== JSON.stringify({ only: ["together", "deepinfra"] })) throw new Error(JSON.stringify(routing));
});

await step("explicit requireParameters=false with native output shows a warning", async () => {
  await js(`document.querySelector("details.advanced").open = true`);
  await selectValue('[data-path="agents.0.model.routing.requireParameters"]', "false");
  await waitFor(`document.querySelector("details.advanced .warning-banner")?.textContent.includes("requireParameters=false")`, "warning");
  await selectValue('[data-path="agents.0.model.routing.requireParameters"]', "");
  await waitFor(`!document.querySelector("details.advanced .warning-banner")`, "warning gone");
});

await step("save + reload keeps the routing; clearing every field removes the routing object", async () => {
  await click("#btn-save");
  await waitFor(`document.querySelector(".success-banner")?.textContent.includes("Saved")`, "saved");
  await send("Page.navigate", { url: `${APP}/#/scenarios/${sid}?tab=agents` });
  await waitFor(`document.querySelector('[data-path="agents.0.model.routing.only"]')?.value === "together, deepinfra"`, "reloaded routing");
  await type('[data-path="agents.0.model.routing.only"]', "");
  const routing = await draftRouting();
  if (routing !== undefined) throw new Error(`routing should be removed, got ${JSON.stringify(routing)}`);
});

await step("switching the provider away from openrouter drops routing", async () => {
  await type('[data-path="agents.0.model.routing.order"]', "together");
  await selectValue('[data-path="agents.0.model.provider"]', "stub");
  await waitFor(`!document.querySelector('[data-path="agents.0.model.routing.order"]')`, "routing hidden");
  const routing = await draftRouting();
  if (routing !== undefined) throw new Error(`routing kept for stub: ${JSON.stringify(routing)}`);
});

await finish();
