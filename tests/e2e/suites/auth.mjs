// OPERATOR_TOKEN in a real browser: the Basic-auth challenge is answered once (as a person typing it into the
// dialog); the SPA's own requests must then work. Runs against the runner's second, token-protected server.
import { openPage } from "../lib/browser.mjs";

const SECURE_APP = process.env.E2E_SECURE_APP;
const TOKEN = process.env.E2E_OPERATOR_TOKEN;
if (!SECURE_APP || !TOKEN) {
  console.log("SKIP auth: no token-protected server (E2E_SECURE_APP / E2E_OPERATOR_TOKEN)");
  process.exit(0);
}

const { send, js, waitFor, step, finish, onEvent } = await openPage({ name: "auth", app: SECURE_APP });

let challenges = 0;
onEvent((msg) => {
  if (msg.method === "Fetch.authRequired") {
    challenges += 1;
    send("Fetch.continueWithAuth", { requestId: msg.params.requestId, authChallengeResponse: { response: "ProvideCredentials", username: "operator", password: TOKEN } });
  } else if (msg.method === "Fetch.requestPaused") {
    send("Fetch.continueRequest", { requestId: msg.params.requestId });
  }
});

await send("Runtime.enable");
await send("Page.enable");

await step("without the token, the UI and the API answer 401; /healthz answers anyone", async () => {
  if ((await fetch(`${SECURE_APP}/`)).status !== 401) throw new Error("UI not protected");
  if ((await fetch(`${SECURE_APP}/api/meta`)).status !== 401) throw new Error("API not protected");
  if ((await fetch(`${SECURE_APP}/healthz`)).status !== 200) throw new Error("healthz");
});

await step("the browser asks once; the scenario library and later SPA requests work", async () => {
  await send("Fetch.enable", { handleAuthRequests: true });
  await send("Page.navigate", { url: `${SECURE_APP}/#/scenarios` });
  await waitFor(`document.body.innerText.includes("Station Kestrel: Cascade")`, "scenario library", 20000);
  const status = await js(`fetch("/api/meta").then((r) => r.status)`);
  if (status !== 200) throw new Error(`SPA fetch got ${status}`);
  if (challenges !== 1) throw new Error(`${challenges} auth challenges`);
  await send("Fetch.disable");
});

await finish();
