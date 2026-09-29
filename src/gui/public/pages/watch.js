import { api, app, escapeHtml, showError } from "../shared.js";

/**
 * Viewer mode: a clean, full-screen projection of a run's room for people
 * watching it (rehearsals, screen recordings, live demos). It renders only
 * what the room contains — narration, agent messages, moderator notices —
 * plus a small "who is speaking" hint. No debug metadata, no technical
 * panels, no controls; it reads the same event stream as the control view.
 */

const POLL_MS = 1000;

// The viewer page's own few labels, in the run's conversation language (en fallback).
const LABELS = {
  en: {
    live: "LIVE",
    ended: "ENDED",
    starting: "Starting…",
    thinking: (n) => `${n} is thinking…`,
    drafting: (n) => `${n} is drafting the final proposal…`,
    voting: "The crew is voting…",
    moderator: "Moderator",
  },
  ru: {
    live: "В ЭФИРЕ",
    ended: "ЗАВЕРШЕНО",
    starting: "Начинаем…",
    thinking: (n) => `${n} думает…`,
    drafting: (n) => `${n} готовит итоговое предложение…`,
    voting: "Экипаж голосует…",
    moderator: "Модератор",
  },
};

function labelsFor(language) {
  const lower = (language || "en").toLowerCase();
  return LABELS[lower] ?? LABELS[lower.split("-")[0]] ?? LABELS.en;
}

/** Scenario title in the run's language, via the same fallback chain as narration. */
function titleFor(config) {
  const strings = config.presentation?.strings ?? {};
  const byLang = Object.fromEntries(Object.entries(strings).map(([k, v]) => [k.toLowerCase(), v]));
  const lang = (config.conversation?.language ?? "en").toLowerCase();
  for (const l of [lang, lang.split("-")[0], (config.presentation?.fallbackLanguage ?? "en").toLowerCase()]) {
    if (byLang[l]?.title) return byLang[l].title;
  }
  return config.name;
}

function initials(name) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");
}

export async function renderWatch(experimentId) {
  const route = location.hash;
  app.innerHTML = `<div class="watch"><div class="loading">…</div></div>`;

  let experiment;
  let running = false;
  const events = [];
  let lastSeq = 0;

  async function refresh() {
    const [detail, { events: fresh }] = await Promise.all([
      api(`/api/experiments/${encodeURIComponent(experimentId)}`),
      api(`/api/experiments/${encodeURIComponent(experimentId)}/events?after=${lastSeq}`),
    ]);
    experiment = detail.experiment;
    running = detail.running;
    events.push(...fresh);
    if (fresh.length) lastSeq = fresh.at(-1).seq;
    return fresh.length;
  }

  try {
    await refresh();
  } catch (err) {
    app.innerHTML = "";
    showError(err.message);
    return;
  }

  const config = experiment.config;
  const L = labelsFor(config.conversation?.language);
  const agentIndex = new Map(config.agents.map((a, i) => [a.id, i]));
  const agentOf = (id) => config.agents.find((a) => a.id === id);

  app.innerHTML = `
    <div class="watch">
      <header class="watch-header">
        <a class="watch-exit" href="#/experiments/${encodeURIComponent(experimentId)}" title="Control view">←</a>
        <h1>${escapeHtml(titleFor(config))}</h1>
        <span class="watch-status" id="watch-status"></span>
      </header>
      <main class="watch-room" id="watch-room"></main>
      <footer class="watch-footer" id="watch-typing"></footer>
    </div>`;
  const room = document.getElementById("watch-room");

  function messageHtml(p) {
    if (p.sender.kind === "narrator") {
      return `<div class="w-narration"><div class="w-narrator">${escapeHtml(p.sender.name)}</div><div class="w-text">${escapeHtml(p.text)}</div></div>`;
    }
    if (p.sender.kind === "system") {
      return `<div class="w-moderator"><span class="w-moderator-label">${escapeHtml(L.moderator)}</span><div class="w-text">${escapeHtml(p.text)}</div></div>`;
    }
    const agent = agentOf(p.sender.agentId);
    const i = (agentIndex.get(p.sender.agentId) ?? 0) % 6;
    return `<div class="w-msg">
      <div class="w-avatar agent-bg-${i}">${escapeHtml(initials(agent?.name ?? p.sender.agentId))}</div>
      <div class="w-body">
        <div class="w-name">${escapeHtml(agent?.name ?? p.sender.agentId)} <span class="w-role">${escapeHtml(agent?.role ?? "")}</span></div>
        <div class="w-text">${escapeHtml(p.text)}</div>
      </div>
    </div>`;
  }

  /** Who the room is waiting for: an open turn with no visible message yet. */
  function typingText() {
    if (!running) return "";
    let open = null;
    for (const e of events) {
      if (e.type === "turn_started") open = { kind: e.payload.kind, agentId: e.agentId, turn: e.payload.turn };
      if (e.type === "turn_completed" && open && e.payload.turn === open.turn) open = null;
    }
    if (!open) return "";
    const name = agentOf(open.agentId)?.name ?? open.agentId;
    if (open.kind === "vote") return L.voting;
    if (open.kind === "proposal") return L.drafting(name);
    return L.thinking(name);
  }

  let rendered = 0;
  function render() {
    const posted = events.filter((e) => e.type === "message_posted");
    const atBottom = room.scrollHeight - room.scrollTop - room.clientHeight < 80;
    if (posted.length === 0) {
      room.innerHTML = `<div class="muted w-starting">${escapeHtml(L.starting)}</div>`;
    } else if (rendered === 0) {
      room.innerHTML = "";
    }
    if (posted.length > rendered) {
      room.insertAdjacentHTML("beforeend", posted.slice(rendered).map((e) => messageHtml(e.payload)).join(""));
      rendered = posted.length;
      if (atBottom || rendered <= 2) room.scrollTop = room.scrollHeight;
    }
    document.getElementById("watch-status").innerHTML = running
      ? `<span class="w-live-dot"></span>${escapeHtml(L.live)}`
      : escapeHtml(L.ended);
    document.getElementById("watch-typing").textContent = typingText();
  }
  render();

  async function poll() {
    if (location.hash !== route) return;
    try {
      await refresh();
      if (location.hash !== route) return;
      // Re-render every tick: the "who is speaking" hint changes even without new messages.
      render();
    } catch {
      // transient — try again on the next tick
    }
    if (running) setTimeout(poll, POLL_MS);
  }
  if (running) setTimeout(poll, POLL_MS);
}
