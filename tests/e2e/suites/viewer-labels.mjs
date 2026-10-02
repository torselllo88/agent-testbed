// Viewer: localized agent names and roles, readable proposal card.
import { APP, EXT, EXT_TOKEN, openPage, sleep } from "../lib/browser.mjs";

const { send, js, waitFor, shot, click, clickText, type, selectValue, text, step, finish } = await openPage({ name: "viewer-labels" });

await send("Runtime.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
await step("Kestrel ru in viewer: localized names/roles, readable proposal card", async () => {
  const scenarios = (await (await fetch(`${APP}/api/scenarios`)).json()).scenarios;
  const kestrel = scenarios.find((s) => s.name === "Station Kestrel");
  if (kestrel.version < 1) throw new Error("no kestrel");
  const { id } = await (await fetch(`${APP}/api/scenarios/${kestrel.id}/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ overrides: { language: "ru" } }) })).json();
  await send("Page.navigate", { url: `${APP}/#/watch/${id}` });
  await waitFor(`document.querySelectorAll(".w-msg").length >= 1`, "first message", 60000);
  const firstName = await text(".w-msg .w-name");
  if (!firstName.includes("Сара Окафор") || !firstName.includes("Командир станции")) throw new Error(`label: ${firstName}`);
  await waitFor(`!!document.querySelector(".w-proposal")`, "proposal card", 180000);
  const card = await text(".w-proposal");
  if (!card.includes("Сара Окафор выносит план на голосование") || !card.includes("отключить: исследовательские лаборатории, внешняя связь") || !card.includes("(SCRAM): да") || !card.includes("стравливание реакторного отсека: нет")) throw new Error(`card: ${card}`);
  await waitFor(`document.querySelector(".watch-status")?.textContent.includes("РАЗБОР — ОТКРЫТ")`, "ended (Kestrel opens the crew debrief)", 120000);
  await shot("watch-ru-labels");
  // The protocol notice agents read is unchanged (still carries the raw proposal JSON).
  const events = (await (await fetch(`${APP}/api/experiments/${id}/events`)).json()).events;
  const notice = events.find((e) => e.type === "message_posted" && e.payload.notice?.kind === "proposal_submitted");
  if (!notice.payload.text.includes('"shed_loads"') || !notice.payload.text.startsWith("Итоговое предложение №1 от Sarah Okafor")) throw new Error(`notice: ${notice.payload.text.slice(0, 80)}`);
});

await finish();
