import type { UsageCategory } from "../experiment/budget.js";
import type { DebriefConfig, ExperimentConfig } from "../experiment/config.js";
import { LlmCaller, type CallBudget } from "../experiment/llmCaller.js";
import type { TokenUsage } from "../llm/provider.js";
import type { ProviderRegistry } from "../llm/registry.js";
import type { DebriefSessionRecord, DebriefUsage } from "../persistence/interactionRepository.js";
import type { HumanRoomMessage } from "../transport/humans.js";
import { resolveAddressee, type AddressSource } from "./addressing.js";
import {
  DEBRIEF_ANSWER_JSON_SCHEMA,
  DEBRIEF_ROUTE_JSON_SCHEMA,
  DebriefAnswerSchema,
  DebriefRouteSchema,
  renderDebriefQuestionPrompt,
  renderDebriefRouterPrompt,
  renderDebriefSystemPrompt,
  type DebriefExchange,
  type FinishedRun,
} from "./debriefPrompt.js";
import { agentDisplayName, type NoticeKind } from "./strings.js";

/** What a session needs from the service that owns it: its log, the room, and the finished run. */
export interface DebriefSessionContext {
  experimentId: string;
  config: ExperimentConfig;
  providers: ProviderRegistry;
  log(type: string, payload: Record<string, unknown>, agentId?: string | null): void;
  notice(kind: NoticeKind, vars?: Record<string, unknown>, inResponseTo?: string | null): Promise<void>;
  /** Posts a character's answer; `replyTo` is the question's internal message id. */
  postAnswer(agentId: string, text: string, replyTo: string): Promise<string>;
  finishedRun(): FinishedRun;
  /** Every public debrief exchange of this experiment so far (all sessions), oldest first. */
  history(): DebriefExchange[];
  /** A room message by id (run message or debrief answer) and the character who posted it, if any. */
  messageOf(messageId: string): { agentId: string | null; text: string } | null;
  saveUsage(usage: DebriefUsage): void;
  markClosed(status: "CLOSED" | "INTERRUPTED", reason: string): void;
  now(): number;
}

export type EnqueueResult = { accepted: true; position: number } | { accepted: false; reason: "user_limit" | "queue_full" | "closed" };

export type RouteSource = AddressSource | "router" | "default";

/** Debrief spend, kept apart from any experiment budget. No time limit: a debrief call is bounded by the per-call timeout only. */
class DebriefBudget implements CallBudget {
  constructor(private readonly usage: DebriefUsage) {}
  recordCall(_category: UsageCategory, usage: TokenUsage | null, costUsd: number | undefined): void {
    this.usage.llmCalls += 1;
    if (usage) {
      this.usage.promptTokens += usage.promptTokens;
      this.usage.completionTokens += usage.completionTokens;
      this.usage.totalTokens += usage.promptTokens + usage.completionTokens;
    }
    if (costUsd === undefined) this.usage.callsWithUnknownCost += 1;
    else this.usage.costUsd += costUsd;
  }
  remainingMs(): number | null {
    return null;
  }
  checkTimeLimit(): null {
    return null;
  }
}

const LIMIT_NOTICE_GAP_MS = 15_000;

/**
 * One debrief session: a FIFO queue of human questions, answered strictly one
 * at a time (one LLM call in flight at most), each by exactly one character.
 * Lives only after the experiment has finished and never touches it.
 */
export class DebriefSession {
  private readonly queue: HumanRoomMessage[] = [];
  private current: { question: HumanRoomMessage; agentId: string | null } | null = null;
  private readonly usage: DebriefUsage;
  private readonly budget: DebriefBudget;
  private readonly abort = new AbortController();
  private readonly lastLimitNotice = new Map<string, number>();
  private idleTimer: NodeJS.Timeout | null = null;
  private draining: Promise<void> | null = null;
  private open = true;

  constructor(
    readonly record: DebriefSessionRecord,
    private readonly ctx: DebriefSessionContext,
    private readonly settings: DebriefConfig,
    private readonly onClosed: () => void
  ) {
    this.usage = { ...record.usage };
    this.budget = new DebriefBudget(this.usage);
    this.armIdleTimer();
  }

  get isOpen(): boolean {
    return this.open;
  }

  state(): { processing: { questionId: string; agentId: string | null } | null; queued: number; usage: DebriefUsage } {
    return {
      processing: this.current ? { questionId: this.current.question.messageId, agentId: this.current.agentId } : null,
      queued: this.queue.length,
      usage: { ...this.usage },
    };
  }

  enqueue(question: HumanRoomMessage): EnqueueResult {
    if (!this.open) return { accepted: false, reason: "closed" };
    const pendingForUser =
      this.queue.filter((q) => q.senderId === question.senderId).length + (this.current?.question.senderId === question.senderId ? 1 : 0);
    const pendingTotal = this.queue.length + (this.current ? 1 : 0);
    const rejection =
      pendingForUser >= this.settings.maxPendingPerUser ? "user_limit" : pendingTotal >= this.settings.maxPendingTotal ? "queue_full" : null;
    if (rejection) {
      this.usage.rejected += 1;
      this.ctx.saveUsage(this.usage);
      this.ctx.log("debrief_question_rejected", { questionId: question.messageId, reason: rejection, pendingForUser, pendingTotal });
      this.limitNotice(question, rejection);
      return { accepted: false, reason: rejection };
    }

    const busy = pendingTotal > 0;
    this.queue.push(question);
    const position = this.queue.length;
    this.ctx.log("debrief_question_queued", { questionId: question.messageId, position, busy });
    if (busy) void this.ctx.notice("questionQueued", { name: question.displayName, position }, question.messageId);
    this.armIdleTimer();
    this.drain();
    return { accepted: true, position };
  }

  /** Resolves once the queue is empty (tests, graceful shutdown). */
  async settle(): Promise<void> {
    while (this.draining) await this.draining;
  }

  close(reason: string, status: "CLOSED" | "INTERRUPTED" = "CLOSED", announce = true): void {
    if (!this.open) return;
    this.open = false;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.abort.abort(new Error(`debrief closed (${reason})`));
    const dropped = this.queue.splice(0);
    for (const q of dropped) this.ctx.log("debrief_question_failed", { questionId: q.messageId, reason: "closed" });
    this.usage.failed += dropped.length;
    this.ctx.saveUsage(this.usage);
    this.ctx.markClosed(status, reason);
    this.ctx.log("debrief_closed", { sessionId: this.record.id, reason, status, droppedQuestions: dropped.map((q) => q.messageId), usage: { ...this.usage } });
    if (announce) void this.ctx.notice(reason === "budget" ? "budgetReached" : "debriefClosed");
    this.onClosed();
  }

  // ---------------------------------------------------------------- internals

  private limitNotice(question: HumanRoomMessage, reason: "user_limit" | "queue_full"): void {
    const last = this.lastLimitNotice.get(question.senderId);
    if (last !== undefined && this.ctx.now() - last < LIMIT_NOTICE_GAP_MS) return;
    this.lastLimitNotice.set(question.senderId, this.ctx.now());
    void this.ctx.notice(reason === "user_limit" ? "userLimit" : "queueFull", { name: question.displayName, limit: this.settings.maxPendingPerUser }, question.messageId);
  }

  private armIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.current || this.queue.length) return this.armIdleTimer();
      this.close("idle");
    }, this.settings.idleTimeoutMinutes * 60_000);
    this.idleTimer.unref?.();
  }

  private drain(): void {
    if (this.draining) return;
    this.draining = (async () => {
      while (this.open && this.queue.length) {
        const question = this.queue.shift()!;
        this.current = { question, agentId: null };
        try {
          await this.process(question);
        } finally {
          this.current = null;
          this.ctx.saveUsage(this.usage);
        }
      }
    })()
      // Never let a failed question take the process down (an unhandled rejection would).
      .catch((err: unknown) => console.error(`debrief session ${this.record.id} failed:`, err))
      .finally(() => {
      this.draining = null;
      if (this.open) this.armIdleTimer();
    });
  }

  private async process(question: HumanRoomMessage): Promise<void> {
    const { costCapUsd } = this.settings;
    if (costCapUsd !== null && this.usage.costUsd >= costCapUsd) {
      this.ctx.log("debrief_question_failed", { questionId: question.messageId, reason: "budget" });
      this.usage.failed += 1;
      this.close("budget");
      return;
    }
    this.ctx.log("debrief_question_processing", { questionId: question.messageId });

    const route = await this.route(question);
    if (this.current) this.current.agentId = route.agentId;
    this.ctx.log("debrief_route_decided", { questionId: question.messageId, ...route }, route.agentId);

    const agent = this.ctx.config.agents.find((a) => a.id === route.agentId)!;
    const llm = this.caller(question.messageId);
    // A reply is only meaningful with what it replies to — and the asker, not that message's author, is who gets the answer.
    const replied = question.replyTo ? this.ctx.messageOf(question.replyTo) : null;
    const inReplyTo = replied
      ? {
          authorName: replied.agentId ? (this.ctx.config.agents.find((a) => a.id === replied.agentId)?.name ?? replied.agentId) : null,
          own: replied.agentId === agent.id,
          text: replied.text,
        }
      : null;
    try {
      const result = await llm.call({
        category: "agent",
        purpose: "debrief_answer",
        agentId: agent.id,
        // The character's own model from the run, with the debrief's output cap.
        modelRef: { ...agent.model, maxOutputTokens: this.settings.maxOutputTokens },
        messages: [
          { role: "system", content: renderDebriefSystemPrompt(this.ctx.config, agent) },
          {
            role: "user",
            content: renderDebriefQuestionPrompt(
              this.ctx.config,
              agent,
              this.ctx.finishedRun(),
              this.ctx.history(),
              { askerName: question.displayName, text: question.text, inReplyTo },
              { revealEvaluation: this.settings.revealEvaluation }
            ),
          },
        ],
        response: { name: "debrief_answer", schema: DebriefAnswerSchema, jsonSchema: DEBRIEF_ANSWER_JSON_SCHEMA },
        context: { agentId: agent.id, purpose: "debrief_answer", askerName: question.displayName, question: question.text },
      });
      const text = result.ok ? result.value.message.trim() : "";
      if (!text) throw new Error(result.ok ? "empty answer" : `unparseable answer: ${result.parseError}`);
      if (!this.open) throw new Error("debrief closed");
      const messageId = await this.ctx.postAnswer(agent.id, text, question.messageId);
      this.usage.answered += 1;
      this.ctx.log(
        "debrief_answer_published",
        { questionId: question.messageId, agentId: agent.id, text, messageId, askerName: question.displayName, question: question.text },
        agent.id
      );
    } catch (err) {
      this.usage.failed += 1;
      this.ctx.log("debrief_question_failed", { questionId: question.messageId, reason: "error", error: errorMessage(err) }, agent.id);
      if (this.open) await this.ctx.notice("answerFailed", { agent: agentDisplayName(this.ctx.config, agent.id) }, question.messageId);
    }
  }

  /** Reply > mention > name in the text > router (the scenario's router model, if any) > the default character. */
  private async route(question: HumanRoomMessage): Promise<{ agentId: string; source: RouteSource; detail: string }> {
    const config = this.ctx.config;
    const direct = resolveAddressee(config, question, (id) => this.ctx.messageOf(id)?.agentId ?? null);
    if (direct) return direct;

    const fallback = this.settings.defaultAgentId ?? config.decision.proposerId;
    const routerModel = this.settings.router;
    if (!routerModel) return { agentId: fallback, source: "default", detail: "no addressee; no router model" };
    try {
      const prompt = renderDebriefRouterPrompt(config, this.ctx.history(), { askerName: question.displayName, text: question.text });
      const result = await this.caller(question.messageId).call({
        category: "orchestration",
        purpose: "debrief_router",
        agentId: null,
        modelRef: routerModel,
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
        response: { name: "debrief_route", schema: DebriefRouteSchema, jsonSchema: DEBRIEF_ROUTE_JSON_SCHEMA },
        context: { purpose: "debrief_router", question: question.text, candidates: config.agents.map((a) => a.id) },
      });
      if (result.ok && result.value.confident && config.agents.some((a) => a.id === result.value.agentId)) {
        return { agentId: result.value.agentId!, source: "router", detail: result.value.reason };
      }
      const why = result.ok ? (result.value.confident ? `unknown agent "${result.value.agentId}"` : "router not confident") : "unparseable router answer";
      return { agentId: fallback, source: "default", detail: why };
    } catch (err) {
      return { agentId: fallback, source: "default", detail: `router failed: ${errorMessage(err)}` };
    }
  }

  /** Every attempt is traced in the interaction log (never the experiment's), tagged with its question. */
  private caller(questionId: string): LlmCaller {
    return new LlmCaller(
      this.ctx.providers,
      { append: (_type, payload, agentId) => this.ctx.log("debrief_llm_call", { questionId, ...payload }, agentId) },
      this.budget,
      this.ctx.config.runtime,
      this.abort.signal
    );
  }
}

function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "termination" in err) {
    const t = (err as { termination: { outcome: string; reason: string } }).termination;
    return `${t.outcome}: ${t.reason}`;
  }
  return err instanceof Error ? err.message : String(err);
}
