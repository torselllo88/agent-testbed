// Browser checks over the Chrome DevTools Protocol — real clicks and typing in a real browser, no extra packages.
// A suite runs against a testbed server (E2E_APP) and a headless Chrome (E2E_CDP) that tests/e2e/run.mjs starts.
import fs from "node:fs";

export const APP = process.env.E2E_APP ?? "http://127.0.0.1:3978";
export const CDP = process.env.E2E_CDP ?? "http://127.0.0.1:9333";
/** The External Room API base URL (…/api/external) and its token. */
export const EXT = process.env.E2E_EXT ?? "http://127.0.0.1:3981/api/external";
export const EXT_TOKEN = process.env.E2E_EXT_TOKEN ?? "mock-token-0123456789abcdef-xyz";
/** Where screenshots go (failures, and a few named shots). */
export const OUT = process.env.E2E_OUT ?? ".e2e-out";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Opens a fresh tab and returns the page helpers. finish() prints the result and exits (1 on any failure or browser error). */
export async function openPage({ name = "e2e", app = APP } = {}) {
  fs.mkdirSync(OUT, { recursive: true });
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(`${app}/healthz`);
      await fetch(`${CDP}/json/version`);
      break;
    } catch {
      await sleep(500);
    }
  }

  const target = await (await fetch(`${CDP}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));

  let nextId = 1;
  const pending = new Map();
  const problems = [];
  const handlers = [];
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method === "Runtime.exceptionThrown") {
      problems.push(`exception: ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`);
    } else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      problems.push(`console.error: ${msg.params.args.map((a) => a.value ?? a.description).join(" ")}`);
    } else if (msg.method === "Page.javascriptDialogOpening") {
      send("Page.handleJavaScriptDialog", { accept: true });
    }
    for (const handler of handlers) handler(msg);
  });
  function send(method, params = {}) {
    const id = nextId++;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((r) => pending.set(id, r));
  }
  async function js(expression) {
    const res = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (res.result?.exceptionDetails) throw new Error(`eval failed: ${expression}\n${res.result.exceptionDetails.exception?.description}`);
    return res.result?.result?.value;
  }
  async function waitFor(expression, label, timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await js(expression)) return;
      await sleep(150);
    }
    throw new Error(`timeout waiting for: ${label}`);
  }
  async function shot(file) {
    const res = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    fs.writeFileSync(`${OUT}/${file}.png`, Buffer.from(res.result.data, "base64"));
  }
  const click = (selector) => js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) throw new Error(${JSON.stringify(`no element ${selector}`)}); el.click(); return true; })()`);
  const clickText = (tag, label) =>
    js(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(tag)})].find((e) => e.textContent.trim() === ${JSON.stringify(label)}); if (!el) throw new Error(${JSON.stringify(`no ${tag} '${label}'`)}); el.click(); return true; })()`);
  const type = (selector, value) =>
    js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.focus(); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`);
  const selectValue = (selector, value) =>
    js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`);
  const text = (selector) => js(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? ""`);

  const steps = [];
  async function step(label, fn) {
    try {
      await fn();
      steps.push(`PASS ${label}`);
    } catch (err) {
      steps.push(`FAIL ${label}: ${err.message}`);
      await shot(`${name}-fail-${steps.length}`).catch(() => {});
    }
  }

  async function finish() {
    console.log(steps.join("\n"));
    console.log(problems.length ? `BROWSER PROBLEMS:\n${problems.join("\n")}` : "no browser console errors or exceptions");
    await fetch(`${CDP}/json/close/${target.id}`).catch(() => {});
    ws.close();
    process.exit(steps.some((s) => s.startsWith("FAIL")) || problems.length ? 1 : 0);
  }

  /** Raw CDP events, for suites that react to them (e.g. auth challenges). */
  const onEvent = (handler) => handlers.push(handler);

  return { send, js, waitFor, shot, click, clickText, type, selectValue, text, step, finish, onEvent, problems, sleep };
}
