import { api, app, escapeHtml, showError } from "../shared.js";

/**
 * Viewer mode: a clean, full-screen projection of a run's room for people
 * watching it (rehearsals, screen recordings, live demos). It renders only
 * what the room contains — narration, agent messages, moderator notices,
 * and the people in the room — plus a small "who is speaking" hint. No debug
 * metadata, no operator controls.
 *
 * Two streams make up the room: the experiment's own events, and the
 * human-interaction log (spectator chat, notices, the post-run debrief).
 * People can write here too; what that means — spectator chat during the
 * mission, a question in the debrief — is decided by the server.
 */

const POLL_ACTIVE_MS = 1000;
const POLL_IDLE_MS = 3000;

// The viewer page's own few labels, in the run's conversation language (en fallback).
const LABELS = {
  en: {
    live: "LIVE",
    ended: "ENDED",
    debriefOpen: "DEBRIEF — OPEN",
    starting: "Starting…",
    thinking: (n) => `${n} is thinking…`,
    drafting: (n) => `${n} is drafting the final proposal…`,
    voting: "Voting…",
    responding: (n) => `${n} is responding…`,
    moderator: "Moderator",
    yourName: "Your name",
    chat: "Message other viewers…",
    ask: "Ask a question — address someone by name…",
    send: "Send",
    replyTo: (n) => `Reply to ${n}`,
    needName: "Enter your name first.",
  },
  ru: {
    live: "В ЭФИРЕ",
    ended: "ЗАВЕРШЕНО",
    debriefOpen: "РАЗБОР — ОТКРЫТ",
    starting: "Начинаем…",
    thinking: (n) => `${n} думает…`,
    drafting: (n) => `${n} готовит итоговое предложение…`,
    voting: "Идёт голосование…",
    responding: (n) => `${n} отвечает…`,
    moderator: "Модератор",
    yourName: "Ваше имя",
    chat: "Сообщение другим зрителям…",
    ask: "Задайте вопрос — можно обратиться по имени…",
    send: "Отправить",
    replyTo: (n) => `Ответ для: ${n}`,
    needName: "Сначала введите имя.",
  },
};

function labelsFor(language) {
  const lower = (language || "en").toLowerCase();
  return LABELS[lower] ?? LABELS[lower.split("-")[0]] ?? LABELS.en;
}

/**
 * The first authored presentation value for the run's language, via the same
 * fallback chain as narration (requested → base language → fallback).
 */
function presentationValue(config, pick) {
  const strings = config.presentation?.strings ?? {};
  const byLang = Object.fromEntries(Object.entries(strings).map(([k, v]) => [k.toLowerCase(), v]));
  const lang = (config.conversation?.language ?? "en").toLowerCase();
  for (const l of [lang, lang.split("-")[0], (config.presentation?.fallbackLanguage ?? "en").toLowerCase()]) {
    const value = byLang[l] ? pick(byLang[l]) : undefined;
    if (value) return value;
  }
  return undefined;
}

function titleFor(config) {
  return presentationValue(config, (s) => s.title) ?? config.name;
}

/** Viewer-only rendering of a proposal from the scenario's template; null when the scenario defines none. */
function renderProposal(config, proposal, proposerName) {
  const spec = presentationValue(config, (s) => s.proposal);
  if (!spec) return null;
  const label = (field, value) => spec.values?.[`${field}.${value}`] ?? spec.values?.[String(value)] ?? String(value);
  const ctx = { rationale: proposal.rationale, proposer: proposerName, attempt: proposal.attempt };
  return spec.template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, path) => {
    if (path.startsWith("proposal.")) {
      const field = path.slice("proposal.".length);
      const value = proposal.body?.[field];
      if (value === undefined) return "";
      if (Array.isArray(value)) return value.length ? value.map((v) => label(field, v)).join(", ") : label(field, "none");
      return label(field, value);
    }
    return ctx[path] ?? "";
  });
}

function initials(name) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");
}

function storageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage unavailable — the value lasts for this page view only
  }
}

/** A stable anonymous id for this browser, so the server can tell people apart. Never shown to agents. */
function viewerId() {
  let id = storageGet("watch.viewerId");
  if (!id) {
    id = `viewer-${crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)}`;
    storageSet("watch.viewerId", id);
  }
  return id;
}

/** Room items from the human-interaction log. */
const ROOM_INTERACTION_TYPES = new Set(["human_message", "notice_posted", "debrief_answer_published"]);

export async function renderWatch(experimentId) {
  const route = location.hash;
  app.innerHTML = `<div class="watch"><div class="loading">…</div></div>`;
  const base = `/api/experiments/${encodeURIComponent(experimentId)}`;

  let experiment;
  let running = false;
  let interaction = { mode: "observe", session: null };
  const events = [];
  const ievents = [];
  let lastSeq = 0;
  let lastISeq = 0;

  async function refresh() {
    const [detail, { events: fresh }, room] = await Promise.all([
      api(base),
      api(`${base}/events?after=${lastSeq}`),
      api(`${base}/interaction?after=${lastISeq}`),
    ]);
    experiment = detail.experiment;
    running = detail.running;
    events.push(...fresh);
    if (fresh.length) lastSeq = fresh.at(-1).seq;
    ievents.push(...room.events);
    if (room.events.length) lastISeq = room.events.at(-1).seq;
    interaction = room;
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
  const me = viewerId();
  const agentIndex = new Map(config.agents.map((a, i) => [a.id, i]));
  const agentOf = (id) => config.agents.find((a) => a.id === id);
  // Display labels for viewers (presentation.strings.<lang>.agents); agents themselves keep the config names.
  const labelOf = (id) => {
    const agent = agentOf(id);
    return {
      name: presentationValue(config, (s) => s.agents?.[id]?.name) ?? agent?.name ?? id,
      role: presentationValue(config, (s) => s.agents?.[id]?.role) ?? agent?.role ?? "",
    };
  };
  let replyTo = null; // { messageId, agentId }

  app.innerHTML = `
    <div class="watch">
      <header class="watch-header">
        <a class="watch-exit" href="#/experiments/${encodeURIComponent(experimentId)}" title="Control view">←</a>
        <h1>${escapeHtml(titleFor(config))}</h1>
        <span class="watch-status" id="watch-status"></span>
      </header>
      <main class="watch-room" id="watch-room"></main>
      <footer class="watch-footer" id="watch-typing"></footer>
      <form class="w-composer" id="w-composer" autocomplete="off">
        <div class="w-reply" id="w-reply" hidden></div>
        <div class="w-composer-row">
          <input id="w-name" class="w-name-input" maxlength="60" placeholder="${escapeHtml(L.yourName)}" aria-label="${escapeHtml(L.yourName)}" value="${escapeHtml(storageGet("watch.displayName") ?? "")}" />
          <input id="w-text" class="w-text-input" maxlength="2000" aria-label="${escapeHtml(L.chat)}" />
          <button type="submit" class="primary">${escapeHtml(L.send)}</button>
        </div>
      </form>
    </div>`;
  const room = document.getElementById("watch-room");
  const nameInput = document.getElementById("w-name");
  const textInput = document.getElementById("w-text");

  function agentMessageHtml(agentId, text, messageId) {
    const who = labelOf(agentId);
    const i = (agentIndex.get(agentId) ?? 0) % 6;
    return `<div class="w-msg" data-mid="${escapeHtml(messageId ?? "")}" data-agent="${escapeHtml(agentId)}">
      <div class="w-avatar agent-bg-${i}">${escapeHtml(initials(who.name))}</div>
      <div class="w-body">
        <div class="w-name">${escapeHtml(who.name)} <span class="w-role">${escapeHtml(who.role)}</span></div>
        <div class="w-text">${escapeHtml(text)}</div>
      </div>
    </div>`;
  }

  function experimentItemHtml(p) {
    if (p.sender.kind === "narrator") {
      return `<div class="w-narration"><div class="w-narrator">${escapeHtml(p.sender.name)}</div><div class="w-text">${escapeHtml(p.text)}</div></div>`;
    }
    if (p.sender.kind === "system" && p.notice?.kind === "proposal_submitted") {
      const frozen = events.find((e) => e.type === "proposal_frozen" && e.payload.id === p.notice.proposalId);
      const text = frozen ? renderProposal(config, frozen.payload, labelOf(frozen.payload.proposerId).name) : null;
      if (text) return `<div class="w-proposal"><div class="w-text">${escapeHtml(text)}</div></div>`;
    }
    if (p.sender.kind === "system") {
      return `<div class="w-moderator"><span class="w-moderator-label">${escapeHtml(L.moderator)}</span><div class="w-text">${escapeHtml(p.text)}</div></div>`;
    }
    return agentMessageHtml(p.sender.agentId, p.text, p.messageId);
  }

  function interactionItemHtml(e) {
    const p = e.payload;
    if (e.type === "notice_posted") {
      return `<div class="w-notice"><span class="w-notice-label">${escapeHtml(p.sender?.name ?? "")}</span><div class="w-text">${escapeHtml(p.text)}</div></div>`;
    }
    if (e.type === "debrief_answer_published") return agentMessageHtml(p.agentId, p.text, p.messageId);
    const mine = p.senderId === me;
    return `<div class="w-human${mine ? " mine" : ""}"><div class="w-name">${escapeHtml(p.displayName)}</div><div class="w-text">${escapeHtml(p.text)}</div></div>`;
  }

  /** Both streams, in the order things appeared in the room. */
  function roomItems() {
    const items = [
      ...events.filter((e) => e.type === "message_posted").map((e) => ({ ts: e.ts, order: 0, seq: e.seq, html: () => experimentItemHtml(e.payload) })),
      ...ievents.filter((e) => ROOM_INTERACTION_TYPES.has(e.type)).map((e) => ({ ts: e.ts, order: 1, seq: e.seq, html: () => interactionItemHtml(e) })),
    ];
    return items.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.order - b.order || a.seq - b.seq));
  }

  /** Who the room is waiting for: an open turn with no visible message yet, or a debrief answer being written. */
  function typingText() {
    if (!running) {
      const agentId = interaction.session?.processing?.agentId;
      return agentId ? L.responding(labelOf(agentId).name) : "";
    }
    let open = null;
    for (const e of events) {
      if (e.type === "turn_started") open = { kind: e.payload.kind, agentId: e.agentId, turn: e.payload.turn };
      if (e.type === "turn_completed" && open && e.payload.turn === open.turn) open = null;
    }
    if (!open) return "";
    const name = labelOf(open.agentId).name;
    if (open.kind === "vote") return L.voting;
    if (open.kind === "proposal") return L.drafting(name);
    return L.thinking(name);
  }

  function renderReply() {
    const el = document.getElementById("w-reply");
    if (!replyTo || interaction.mode !== "debrief") {
      el.hidden = true;
      el.innerHTML = "";
      return;
    }
    el.hidden = false;
    el.innerHTML = `${escapeHtml(L.replyTo(labelOf(replyTo.agentId).name))} <button type="button" class="w-reply-cancel" aria-label="×">×</button>`;
    el.querySelector("button").addEventListener("click", () => {
      replyTo = null;
      renderReply();
    });
  }

  let rendered = -1;
  function render() {
    const items = roomItems();
    if (items.length !== rendered) {
      const atBottom = room.scrollHeight - room.scrollTop - room.clientHeight < 80;
      room.innerHTML = items.length ? items.map((i) => i.html()).join("") : `<div class="muted w-starting">${escapeHtml(L.starting)}</div>`;
      if (atBottom || rendered <= 2) room.scrollTop = room.scrollHeight;
      rendered = items.length;
    }
    const status = document.getElementById("watch-status");
    status.innerHTML = running
      ? `<span class="w-live-dot"></span>${escapeHtml(L.live)}`
      : interaction.mode === "debrief"
        ? `<span class="w-debrief-dot"></span>${escapeHtml(L.debriefOpen)}`
        : escapeHtml(L.ended);
    document.getElementById("watch-typing").textContent = typingText();
    textInput.placeholder = interaction.mode === "debrief" ? L.ask : L.chat;
    room.classList.toggle("debrief", interaction.mode === "debrief");
    renderReply();
  }
  render();

  // Replying to a character's message addresses the question to them.
  room.addEventListener("click", (ev) => {
    const msg = ev.target.closest(".w-msg[data-mid]");
    if (!msg || interaction.mode !== "debrief" || !msg.dataset.mid) return;
    replyTo = { messageId: msg.dataset.mid, agentId: msg.dataset.agent };
    renderReply();
    textInput.focus();
  });

  document.getElementById("w-composer").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const displayName = nameInput.value.trim();
    const text = textInput.value.trim();
    if (!text) return;
    if (!displayName) {
      nameInput.focus();
      nameInput.placeholder = L.needName;
      return;
    }
    storageSet("watch.displayName", displayName);
    textInput.value = "";
    try {
      await api(`${base}/room/messages`, {
        method: "POST",
        body: JSON.stringify({ senderId: me, displayName, text, replyTo: replyTo?.messageId ?? null }),
      });
      replyTo = null;
      await refresh();
      render();
    } catch (err) {
      textInput.value = text;
      showError(err.message);
    }
  });

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
    setTimeout(poll, running || interaction.mode === "debrief" ? POLL_ACTIVE_MS : POLL_IDLE_MS);
  }
  setTimeout(poll, running ? POLL_ACTIVE_MS : POLL_IDLE_MS);
}
