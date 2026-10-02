// Station Kestrel: Cascade in the library and the Russian viewer: proposal card, grounded reveal.
import { APP, EXT, EXT_TOKEN, openPage, sleep } from "../lib/browser.mjs";

const { send, js, waitFor, shot, click, clickText, type, selectValue, text, step, finish } = await openPage({ name: "cascade" });

await send("Runtime.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1300, height: 1000, deviceScaleFactor: 1, mobile: false });

await step("library lists Cascade as a third built-in", async () => {
  await send("Page.navigate", { url: `${APP}/#/scenarios` });
  await waitFor(`document.querySelectorAll(".scenario-card[data-id]").length >= 3`, "cards");
  const names = await js(`[...document.querySelectorAll(".scenario-card[data-id] h3")].map((h) => h.textContent)`);
  if (!names.includes("Station Kestrel: Cascade")) throw new Error(`names ${names}`);
  await shot("cascade-library");
});

await step("viewer (ru): readable proposal card with the action sequence, and the grounded reveal", async () => {
  const scenarios = (await (await fetch(`${APP}/api/scenarios`)).json()).scenarios;
  const cascade = scenarios.find((s) => s.name === "Station Kestrel: Cascade");
  const { id } = await (await fetch(`${APP}/api/scenarios/${cascade.id}/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ overrides: { language: "ru" } }) })).json();
  await send("Page.navigate", { url: `${APP}/#/watch/${id}` });
  await waitFor(`!!document.querySelector(".w-proposal")`, "proposal card", 240000);
  const card = await text(".w-proposal");
  if (!card.includes("маяк на батарею, лаборатории выкл., связь выкл.")) throw new Error(`card: ${card}`);
  await waitFor(`[...document.querySelectorAll(".w-narration")].some((n) => n.textContent.includes("СТАНЦИЯ «КЕСТРЕЛ» В БЕЗОПАСНОСТИ"))`, "ending", 60000);
  await sleep(1500);
  await shot("cascade-viewer-ru");
});

await finish();
