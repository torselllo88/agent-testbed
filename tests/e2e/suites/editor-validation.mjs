// Editor: invalid JSON fields block Save/Validate/tab switch; people tab keeps settings and aliases.
import { APP, EXT, EXT_TOKEN, openPage, sleep } from "../lib/browser.mjs";

const { send, js, waitFor, shot, click, clickText, type, selectValue, text, step, finish } = await openPage({ name: "editor-validation" });

await send("Runtime.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1300, height: 1000, deviceScaleFactor: 1, mobile: false });
const scenarios = (await (await fetch(`${APP}/api/scenarios`)).json()).scenarios;
const kestrel = scenarios.find((s) => s.name === "Station Kestrel");
const cascade = scenarios.find((s) => s.name === "Station Kestrel: Cascade");


await step("editor: an invalid JSON field blocks Save and Validate, and survives a re-render and a tab switch attempt", async () => {
  const dup = await (await fetch(`${APP}/api/scenarios/${cascade.id}/duplicate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json();
  await send("Page.navigate", { url: `${APP}/#/scenarios/${dup.scenario.id}?tab=presentation` });
  await waitFor(`!!document.querySelector('[data-path="presentation.strings"]')`, "strings textarea");
  const broken = (await js(`document.querySelector('[data-path="presentation.strings"]').value`)).replace(/\}\s*$/, ",}");
  await type('[data-path="presentation.strings"]', broken);
  if (!(await js(`document.querySelector('[data-path="presentation.strings"]').classList.contains("invalid")`))) throw new Error("not marked invalid");
  if (!(await js(`document.getElementById("btn-save").disabled`))) throw new Error("save enabled");
  await click("#btn-validate");
  await waitFor(`(document.querySelector("#editor-messages")?.textContent ?? "").includes("Fix 1 invalid field first")`, "validate refuses");
  await clickText("button.tab", "Agents");
  await waitFor(`(document.querySelector("#editor-messages")?.textContent ?? "").includes("Fix 1 invalid field")`, "tab switch refused");
  if (!(await js(`!!document.querySelector('[data-path="presentation.strings"]')`))) throw new Error("left the tab");
  // A structural change re-renders the page: the typed text stays, still marked.
  await js(`(() => { const el = document.querySelector('[data-path="presentation.__narratorEnabled"]'); el.click(); el.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`);
  await waitFor(`document.querySelector('[data-path="presentation.strings"]')?.value === ${JSON.stringify(broken)}`, "text kept after re-render");
  await shot("r3-editor-invalid");
  // Fixing it unblocks Save.
  await type('[data-path="presentation.strings"]', broken.replace(/,\}$/, "}"));
  if (await js(`document.getElementById("btn-save").disabled`)) throw new Error("save still disabled");
});

await step("editor: people tab shows aliases and keeps settings across OBSERVE and back", async () => {
  const dup = await (await fetch(`${APP}/api/scenarios/${cascade.id}/duplicate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json();
  await send("Page.navigate", { url: `${APP}/#/scenarios/${dup.scenario.id}?tab=people` });
  await waitFor(`!!document.querySelector('[data-path="humanInteraction.aliases"]')`, "aliases field");
  if (!(await js(`document.querySelector('[data-path="humanInteraction.aliases"]').value.includes("Виктору")`))) throw new Error("aliases");
  await selectValue('[data-path="humanInteraction.__profile"]', "");
  await waitFor(`!document.querySelector('[data-path="humanInteraction.aliases"]')`, "hidden");
  await selectValue('[data-path="humanInteraction.__profile"]', "DEBRIEF");
  await waitFor(`!!document.querySelector('[data-path="humanInteraction.aliases"]')`, "shown again");
  if (!(await js(`document.querySelector('[data-path="humanInteraction.aliases"]').value.includes("Виктору")`))) throw new Error("aliases lost");
  if ((await js(`document.querySelector('[data-path="humanInteraction.debrief.defaultAgentId"]').value`)) !== "operations") throw new Error("defaultAgentId lost");
  if (!(await js(`document.querySelector('[data-path="humanInteraction.__debriefRouterEnabled"]').checked`))) throw new Error("router lost");
  await click("#btn-validate");
  await waitFor(`(document.querySelector("#editor-messages")?.textContent ?? "").includes("valid and runnable")`, "valid");
});

await finish();
