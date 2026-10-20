# Browser end-to-end checks

Real clicks and typing in a real, headless Chrome, driven over the Chrome
DevTools Protocol — no browser-automation package.

```bash
npm run test:e2e                  # every suite, then the reference room adapter
npm run test:e2e -- debrief auth  # only these
```

`run.mjs` starts, on free ports and with throw-away databases:

- a keyless testbed server (stub agents; the External Room API on its own listener);
- a second server behind `OPERATOR_TOKEN` (for the `auth` suite);
- a headless Chrome (found automatically, or `CHROME_PATH`).

It runs each suite in `suites/` as its own process, then
`src/cli/roomMock.ts` against the External Room API, and stops everything.
Credentials are blanked for the servers, so your `.env` keys are never used
and no real provider is called. Screenshots (named shots and failures) go to
`.e2e-out/` (`E2E_OUT` to change it); CI uploads them when a check fails.

| Suite | Covers |
|---|---|
| `core-ui` | scenario editor, live control view, operator controls, trace, rerun, theme |
| `editor-validation` | invalid fields block Save / Validate / tab switch; people-tab settings and aliases |
| `models` | the editor's Models panel (all agents / routers at once, saved) and models chosen in the run dialog (this run only) |
| `openrouter-routing` | OpenRouter routing fields: parsing, warnings, save/reload, provider switch |
| `batches` | batch form, preview and validation, run, aggregates, CSV, list filters |
| `presentation` | editor tab groups, OBSERVE profile, viewer beats, paced part-by-part ending |
| `kestrel` | run dialog language, viewer pacing, Russian narration, trace, read-only built-ins |
| `cascade` | Cascade in the library and the Russian viewer: proposal card, grounded reveal |
| `viewer-labels` | localized agent names and roles, readable proposal card |
| `debrief` | spectator chat, the debrief, addressing, FIFO queue, operator close/reopen, phone width |
| `viewer-stop` | Stop in the viewer: offered only while live, ends the run as stopped by the operator, no debrief follows |
| `self-hosted` | a self-hosted OpenAI-compatible endpoint (a fake one the runner starts): Overview, provider choice with the served models, a run on it |
| `watch-external` | the viewer of an externally bound experiment is read-only until the binding closes |
| `auth` | `OPERATOR_TOKEN`: 401 without it, `/healthz` open, one browser challenge, then the SPA works |

## Writing a suite

A suite is a plain ES module in `suites/`:

```js
import { APP, openPage } from "../lib/browser.mjs";

const { send, js, waitFor, click, step, finish } = await openPage({ name: "my-suite" });
await send("Runtime.enable");
await send("Page.enable");

await step("what the user can do", async () => {
  await send("Page.navigate", { url: `${APP}/#/scenarios` });
  await waitFor(`!!document.querySelector("#create-btn")`, "scenario library");
});

await finish(); // prints PASS/FAIL per step; exits 1 on any failure or browser console error
```

Wait for the condition you actually need (`waitFor`), not for something that
merely tends to come first: the previous page's DOM can linger for a moment
after a route change.
