// Editor tab groups, OBSERVE profile, viewer beats and the paced, part-by-part ending.
import { APP, EXT, EXT_TOKEN, openPage, sleep } from "../lib/browser.mjs";

const { send, js, waitFor, shot, click, clickText, type, selectValue, text, step, finish } = await openPage({ name: "presentation" });

await send("Runtime.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1300, height: 1000, deviceScaleFactor: 1, mobile: false });
const scenarios = (await (await fetch(`${APP}/api/scenarios`)).json()).scenarios;
const kestrel = scenarios.find((s) => s.name === "Station Kestrel");

await step("editor: two tab groups; conversation language under the experiment; people tab shows DEBRIEF", async () => {
  await send("Page.navigate", { url: `${APP}/#/scenarios/${kestrel.id}?tab=protocol` });
  await waitFor(`!!document.querySelector(".tabs.grouped")`, "grouped tabs");
  const groups = await js(`[...document.querySelectorAll(".tab-group-label")].map((l) => l.textContent)`);
  if (groups.join("|") !== "Experiment|Presentation & demo") throw new Error(`groups ${groups}`);
  if (!(await js(`!!document.querySelector('#editor-body [data-path="conversation.language"]')`))) throw new Error("language not in protocol");
  await clickText("button.tab", "Presentation");
  await waitFor(`document.querySelector("#editor-body")?.classList.contains("demo")`, "demo styling");
  if (await js(`!!document.querySelector('#editor-body [data-path="conversation.language"]')`)) throw new Error("language still in presentation");
  if (!(await js(`document.querySelector('[data-path="presentation.beats"]').value.includes("discussionProgress")`))) throw new Error("beats json");
  await shot("drama-editor-presentation");
  await clickText("button.tab", "People in the room");
  await waitFor(`!!document.querySelector('[data-path="humanInteraction.__profile"]')`, "profile select");
  if ((await js(`document.querySelector('[data-path="humanInteraction.__profile"]').value`)) !== "DEBRIEF") throw new Error("profile");
  if (!(await js(`[...document.querySelectorAll('[data-path="humanInteraction.__profile"] option')].find((o) => o.value === "TAKE_ROLE").disabled`))) throw new Error("TAKE_ROLE selectable");
  await clickText("button.tab", "Agents");
  await waitFor(`document.querySelectorAll(".agent-card .subhead").length >= 8`, "agent subheads");
  if (!(await js(`document.querySelector('[data-path="agents.0.systemPrompt"]').value.includes("live emergency channel")`))) throw new Error("speech style");
  await shot("drama-editor-agents");
});

await step("a duplicate switched to OBSERVE drops the section and still validates", async () => {
  const dup = await (await fetch(`${APP}/api/scenarios/${kestrel.id}/duplicate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json();
  await send("Page.navigate", { url: `${APP}/#/scenarios/${dup.scenario.id}?tab=people` });
  await waitFor(`!!document.querySelector('[data-path="humanInteraction.__profile"]')`, "profile select");
  await selectValue('[data-path="humanInteraction.__profile"]', "");
  await waitFor(`!document.querySelector('[data-path="humanInteraction.debrief.maxOutputTokens"]')`, "debrief fields hidden");
  await click("#btn-validate");
  await waitFor(`(document.querySelector("#editor-messages")?.textContent ?? "").length > 0`, "validation message");
  const msg = await text("#editor-messages");
  if (!msg.includes("valid and runnable")) throw new Error(`validate: ${msg}`);
  await clickText("button.tab", "Raw JSON");
  if (await js(`document.querySelector("#raw-json").value.includes("humanInteraction")`)) throw new Error("section still present");
});

await step("viewer: beats and the ending revealed part by part, paced", async () => {
  const { id } = await (await fetch(`${APP}/api/scenarios/${kestrel.id}/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json();
  await send("Page.navigate", { url: `${APP}/#/watch/${id}` });
  await waitFor(`[...document.querySelectorAll(".w-narration")].some((n) => n.textContent.includes("Decision locked"))`, "decision locked", 240000);
  const t0 = Date.now();
  await waitFor(`[...document.querySelectorAll(".w-narration")].some((n) => n.textContent.includes("STATION KESTREL IS SECURE"))`, "final part", 30000);
  const dt = Date.now() - t0;
  if (dt < 3000) throw new Error(`reveal too fast: ${dt} ms`);
  const narr = await js(`[...document.querySelectorAll(".w-narration .w-text")].map((n) => n.textContent.slice(0, 60))`);
  console.log("narration:", JSON.stringify(narr, null, 1));
  await sleep(2500);
  await shot("drama-viewer-ending");
});

await finish();
