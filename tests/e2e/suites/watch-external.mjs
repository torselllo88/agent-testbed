// Viewer of an experiment bound to an external room: read-only until the binding is closed.
import { APP, EXT, EXT_TOKEN, openPage, sleep } from "../lib/browser.mjs";

const { send, js, waitFor, shot, click, clickText, type, selectValue, text, step, finish } = await openPage({ name: "watch-external" });

await send("Runtime.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1300, height: 1000, deviceScaleFactor: 1, mobile: false });
const scenarios = (await (await fetch(`${APP}/api/scenarios`)).json()).scenarios;
const kestrel = scenarios.find((s) => s.name === "Station Kestrel");
const auth = { Authorization: `Bearer ${EXT_TOKEN}`, "Content-Type": "application/json" };

await step("watch: an experiment bound to an external room is view-only here; after close the message box returns", async () => {
  const listed = await (await fetch(`${EXT}/scenarios`, { headers: auth })).json();
  const sc = listed.scenarios[0];
  const participants = sc.participants.map((p) => ({ participantId: p.id, externalUserId: `@${p.id}:smoke.local` }));
  const started = (await (await fetch(`${EXT}/bindings`, { method: "POST", headers: auth, body: JSON.stringify({ scenarioId: sc.id, room: { provider: "smoke", roomId: `!watch-${Date.now()}` }, participants }) })).json()).binding ?? {};
  if (!started.experimentId) throw new Error(`start: ${JSON.stringify(started)}`);
  await send("Page.navigate", { url: `${APP}/#/watch/${started.experimentId}` });
  await waitFor(`!!document.getElementById("w-external") && !document.getElementById("w-external").hidden`, "external note shown");
  if (!(await js(`document.getElementById("w-composer").hidden && getComputedStyle(document.getElementById("w-composer")).display === "none"`))) throw new Error("composer visible");
  const res = await fetch(`${APP}/api/experiments/${started.experimentId}/room/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ senderId: "x", displayName: "X", text: "hi" }) });
  const body = await res.json();
  if (res.status !== 409 || body.code !== "EXTERNAL_ROOM_ACTIVE") throw new Error(`api: ${res.status} ${JSON.stringify(body)}`);
  await shot("r4-watch-external");
  await fetch(`${EXT}/bindings/${started.bindingId}/close`, { method: "POST", headers: auth, body: "{}" });
  await waitFor(`!document.getElementById("w-composer").hidden && document.getElementById("w-external").hidden`, "composer back after close", 20000);
});

await finish();
