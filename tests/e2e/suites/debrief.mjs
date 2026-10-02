// People in the room: spectator chat during the run, the debrief, addressing, FIFO queue, operator close/reopen.
import { APP, EXT, EXT_TOKEN, openPage, sleep } from "../lib/browser.mjs";

const { send, js, waitFor, shot, click, clickText, type, selectValue, text, step, finish } = await openPage({ name: "debrief" });

const post = (path, body) => fetch(`${APP}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
const sendChat = async (value) => {
  await type("#w-text", value);
  await js(`document.querySelector("#w-composer").requestSubmit()`);
};

await send("Runtime.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1300, height: 950, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: `${APP}/#/scenarios` });
await waitFor(`document.readyState === "complete"`, "page");
await js(`localStorage.removeItem("watch.displayName"); localStorage.removeItem("watch.viewerId"); true`);

const scenarios = (await (await fetch(`${APP}/api/scenarios`)).json()).scenarios;
const kestrel = scenarios.find((s) => s.name === "Station Kestrel");
const { id } = await post(`/api/scenarios/${kestrel.id}/run`, {});
let tokensBefore;

await step("during the mission: a viewer's message is spectator chat and gets one crew-voiced explanation", async () => {
  await send("Page.navigate", { url: `${APP}/#/watch/${id}` });
  await waitFor(`!!document.querySelector("#w-composer")`, "composer");
  await waitFor(`document.querySelector(".watch-status")?.textContent.includes("LIVE")`, "live");
  await sendChat("Hello crew, can you hear me?");
  await waitFor(`document.querySelector("#w-name").placeholder === "Enter your name first."`, "asks for a name first", 3000);
  await type("#w-name", "Nikita");
  await sendChat("Hello crew, can you hear me?");
  await waitFor(`[...document.querySelectorAll(".w-human.mine")].some((e) => e.textContent.includes("can you hear me"))`, "own message shown");
  await waitFor(`[...document.querySelectorAll(".w-notice")].some((e) => e.textContent.includes("The crew is handling the emergency"))`, "spectator notice");
  // Another person in the room, a command-looking line.
  await post(`/api/experiments/${id}/room/messages`, { senderId: "alice", displayName: "Alice", text: "STOP" });
  await waitFor(`[...document.querySelectorAll(".w-human:not(.mine)")].some((e) => e.textContent.includes("Alice"))`, "other person shown");
  const notices = await js(`document.querySelectorAll(".w-notice").length`);
  if (notices !== 1) throw new Error(`${notices} notices (expected 1: cooldown)`);
  await shot("debrief-1-mission");
});

await step("the mission finishes unaffected; the debrief opens after the ending narration", async () => {
  await waitFor(`document.querySelector(".watch-status")?.textContent.includes("DEBRIEF — OPEN")`, "debrief open", 240000);
  const detail = await (await fetch(`${APP}/api/experiments/${id}`)).json();
  if (detail.experiment.outcome !== "SUCCESS" || detail.experiment.intervened) throw new Error(`outcome ${detail.experiment.outcome} intervened ${detail.experiment.intervened}`);
  tokensBefore = detail.experiment.summary.tokens.total;
  const order = await js(`[...document.querySelectorAll(".watch-room > div")].map((d) => d.className + "|" + d.textContent)`);
  const ending = order.findIndex((o) => o.includes("Mission successful"));
  const opened = order.findIndex((o) => o.includes("crew debrief is now open"));
  if (ending < 0 || opened < ending) throw new Error(`order: ending ${ending}, opened ${opened}`);
  if (!(await js(`document.querySelector("#w-text").placeholder.startsWith("Ask a question")`))) throw new Error("placeholder");
});

await step("a named question is answered by that officer, addressed to the asker", async () => {
  await sendChat("Viktor, where did the calculation go wrong?");
  await waitFor(`[...document.querySelectorAll(".w-msg[data-agent=power]")].some((e) => e.textContent.includes("Nikita,"))`, "Viktor answers Nikita", 20000);
});

await step("replying to Maya's mission message routes the question to her; another person is queued FIFO", async () => {
  await js(`[...document.querySelectorAll(".w-msg[data-agent=life_support]")][0].click(); true`);
  await waitFor(`document.querySelector("#w-reply")?.textContent.includes("Reply to Maya Chen")`, "reply chip");
  await sendChat("Why were you so firm?");
  await post(`/api/experiments/${id}/room/messages`, { senderId: "alice", displayName: "Alice", text: "What do you all think?" });
  await waitFor(`[...document.querySelectorAll(".w-msg[data-agent=life_support]")].some((e) => e.textContent.includes("Nikita,"))`, "Maya answers", 20000);
  await waitFor(`[...document.querySelectorAll(".w-msg[data-agent=operations]")].some((e) => e.textContent.includes("Alice,"))`, "Sarah answers Alice (default)", 20000);
  const all = await js(`[...document.querySelectorAll(".watch-room > div")].map((d) => d.textContent)`);
  const maya = all.findIndex((t) => t.includes("Nikita, I held the line"));
  const sarah = all.findIndex((t) => t.includes("Alice, my job"));
  if (!(maya >= 0 && sarah > maya)) throw new Error(`FIFO order: maya ${maya}, sarah ${sarah}`);
  await shot("debrief-2-answers");
});

await step("control view: people in the room, separate usage, experiment metrics unchanged; operator closes and reopens", async () => {
  const detail = await (await fetch(`${APP}/api/experiments/${id}`)).json();
  if (detail.experiment.summary.tokens.total !== tokensBefore) throw new Error("experiment tokens changed");
  await send("Page.navigate", { url: `${APP}/#/experiments/${id}` });
  await waitFor(`!!document.querySelector("#interaction .card")`, "people card");
  const card = await text("#interaction .card");
  if (!/2 message\(s\) during the run/.test(card)) throw new Error(`card: ${card.slice(0, 300)}`);
  if (!card.includes("3 question(s), 3 answer(s)")) throw new Error(`card: ${card.slice(0, 400)}`);
  await js(`document.querySelector("#qa-details").open = true; true`);
  await shot("debrief-3-control");
  await click("#btn-debrief-close");
  await waitFor(`!!document.querySelector("#btn-debrief-open")`, "open button after close");
  await click("#btn-debrief-open");
  await waitFor(`document.querySelectorAll("#interaction tbody tr").length === 2`, "second session row");
});

await step("phone width: viewer has no horizontal scroll", async () => {
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send("Page.navigate", { url: `${APP}/#/watch/${id}` });
  await waitFor(`!!document.querySelector("#w-composer") && document.querySelectorAll(".w-msg").length > 3`, "viewer");
  const overflow = await js(`document.documentElement.scrollWidth - window.innerWidth`);
  if (overflow > 0) throw new Error(`horizontal overflow ${overflow}px`);
  await shot("debrief-4-phone");
});

await finish();
