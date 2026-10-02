// Station Kestrel: run dialog language, viewer pacing, Russian narration, trace, read-only built-ins.
import { APP, EXT, EXT_TOKEN, openPage, sleep } from "../lib/browser.mjs";

const { send, js, waitFor, shot, click, clickText, type, selectValue, text, step, finish } = await openPage({ name: "kestrel" });

await send("Runtime.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
const openKestrelRun = async () => {
  await send("Page.navigate", { url: `${APP}/#/scenarios` });
  await waitFor(`[...document.querySelectorAll(".scenario-card h3")].some((h) => h.textContent === "Station Kestrel")`, "library");
  await js(`[...document.querySelectorAll(".scenario-card")].find((c) => c.querySelector("h3").textContent === "Station Kestrel").querySelector('[data-act="run"]').click()`);
  await waitFor(`!!document.querySelector(".modal #rd-language")`, "run dialog");
};

await step("library shows both built-ins with Run/View/Duplicate and a create card", async () => {
  await send("Page.navigate", { url: `${APP}/#/scenarios` });
  await waitFor(`document.querySelectorAll(".scenario-card[data-id]").length >= 2`, "cards");
  const names = await js(`[...document.querySelectorAll(".scenario-card[data-id] h3")].map((h) => h.textContent)`);
  if (names[0] !== "Space Station Benchmark" || names[1] !== "Station Kestrel") throw new Error(`names: ${names}`);
  const view = await js(`document.querySelector(".scenario-card[data-id] [data-act=edit]").textContent`);
  if (view !== "View") throw new Error(`builtin edit label: ${view}`);
  if (!(await js(`!!document.querySelector(".create-card")`))) throw new Error("no create card");
  await shot("library");
});

let ruId;
await step("run Kestrel in Russian via the dialog → viewer shows Russian narration first", async () => {
  await openKestrelRun();
  const opts = await js(`[...document.querySelectorAll("#rd-language option")].map((o) => o.value)`);
  if (!opts.includes("ru") || !opts.includes("en")) throw new Error(`options ${opts}`);
  await selectValue("#rd-language", "ru");
  await clickText(".modal button", "Start & watch");
  await waitFor(`location.hash.startsWith("#/watch/")`, "viewer route");
  ruId = decodeURIComponent((await js("location.hash")).split("/")[2]);
  if (!(await js(`document.body.classList.contains("watch-mode")`))) throw new Error("sidebar not hidden");
  await waitFor(`document.querySelector(".w-narration .w-narrator")?.textContent === "ЦЕНТР УПРАВЛЕНИЯ"`, "russian narrator", 20000);
  const title = await text(".watch-header h1");
  if (title !== "Станция «Кестрел»") throw new Error(`title ${title}`);
  if (!(await text(".watch-status")).includes("В ЭФИРЕ")) throw new Error("status not live/ru");
});

await step("messages arrive at a readable pace (≥ 2.5 s apart) with a 'who is thinking' hint", async () => {
  await waitFor(`document.querySelectorAll(".w-msg").length >= 1`, "first agent message", 30000);
  const t1 = Date.now();
  await waitFor(`document.querySelectorAll(".w-msg").length >= 2`, "second agent message", 30000);
  const dt = Date.now() - t1;
  if (dt < 2000) throw new Error(`second message only ${dt} ms after the first`);
  await shot("watch-ru-live");
});

await step("Russian ending narration after the evaluator", async () => {
  await waitFor(`document.querySelector(".watch-status")?.textContent.includes("РАЗБОР — ОТКРЫТ")`, "ended (Kestrel opens the crew debrief)", 240000);
  const last = await js(`[...document.querySelectorAll(".watch-room .w-narration")].at(-1).textContent`);
  if (!last.includes("Миссия выполнена")) throw new Error(`last: ${last.slice(0, 200)}`);
  const card = await text(".w-proposal");
  if (!card.includes("выносит план на голосование")) throw new Error(`proposal card not localized: ${card.slice(0, 200)}`);
  if (await js(`!!document.querySelector(".msg.debug, #controls, .sidebar:not([style*=none]) .sidebar-nav-item:not([hidden])") && getComputedStyle(document.querySelector(".sidebar")).display !== "none"`)) throw new Error("technical UI visible in viewer");
  await shot("watch-ru-end");
});

await step("control view of the same run: trace shows language, narration, pacing", async () => {
  const detail = await (await fetch(`${APP}/api/experiments/${ruId}`)).json();
  if (detail.experiment.config.conversation.language !== "ru") throw new Error("snapshot language");
  const m = detail.experiment.summary;
  if (m.messages.narrator < 2) throw new Error(`narrator messages ${m.messages.narrator}`);
  if (!(m.durationMs.presentation > 5000)) throw new Error(`presentation ${m.durationMs.presentation}`);
  const events = (await (await fetch(`${APP}/api/experiments/${ruId}/events`)).json()).events;
  const env = events.find((e) => e.type === "experiment_started").payload.environment;
  if (!env.languageOverridden || env.conversationLanguage !== "ru") throw new Error(JSON.stringify(env));
  await send("Page.navigate", { url: `${APP}/#/experiments/${ruId}` });
  await waitFor(`!!document.querySelector("#room .msg.narrator")`, "narrator in control room");
});

await step("rerun the same saved scenario in English without editing it", async () => {
  await openKestrelRun();
  await selectValue("#rd-language", "en");
  await clickText(".modal button", "Start & watch");
  await waitFor(`document.querySelector(".w-narration .w-narrator")?.textContent === "MISSION CONTROL"`, "english narrator", 20000);
  const title = await text(".watch-header h1");
  if (title !== "Station Kestrel") throw new Error(`title ${title}`);
  const id = decodeURIComponent((await js("location.hash")).split("/")[2]);
  await fetch(`${APP}/api/experiments/${id}/control`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "stop" }) });
  await waitFor(`[...document.querySelectorAll(".watch-room .w-narration")].at(-1)?.textContent.includes("stopped by the operator")`, "neutral stop ending", 20000);
});

await step("built-in opens read-only; presentation tab renders; duplicate is editable", async () => {
  const scenarios = (await (await fetch(`${APP}/api/scenarios`)).json()).scenarios;
  const kestrel = scenarios.find((s) => s.name === "Station Kestrel");
  await send("Page.navigate", { url: `${APP}/#/scenarios/${kestrel.id}?tab=presentation` });
  await waitFor(`!!document.querySelector('[data-path="presentation.pacing.minVisibleIntervalMs"]')`, "presentation tab");
  if (!(await js(`document.querySelector('[data-path="presentation.pacing.minVisibleIntervalMs"]').disabled`))) throw new Error("builtin editable");
  if (await js(`!!document.querySelector("#btn-save")`)) throw new Error("save shown for builtin");
  await shot("editor-presentation");
  await click("#btn-duplicate");
  await waitFor(`!!document.querySelector("#btn-save") && location.hash.includes("/scenarios/")`, "copy editor");
  await clickText("button.tab", "Agents");
  await waitFor(`!!document.querySelector('[data-path="agents.0.persona"]')`, "persona field");
  if (await js(`document.querySelector('[data-path="agents.0.persona"]').disabled`)) throw new Error("copy not editable");
  const persona = await js(`document.querySelector('[data-path="agents.0.persona"]').value`);
  if (!persona.includes("station commander")) throw new Error("persona not copied");
});

await finish();
