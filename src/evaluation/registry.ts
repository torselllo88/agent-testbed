import type { ProtocolAdapter } from "../experiment/protocolAdapter.js";
import type { ScenarioEvaluator } from "./types.js";

/** Everything scenario-specific a run resolves by id: evaluators, and protocol adapters (config.protocol.adapter). */
export class EvaluatorRegistry {
  private readonly evaluators = new Map<string, ScenarioEvaluator>();
  private readonly adapters = new Map<string, ProtocolAdapter>();

  register(evaluator: ScenarioEvaluator<any, any>): this {
    if (this.evaluators.has(evaluator.id)) throw new Error(`Evaluator "${evaluator.id}" is already registered`);
    this.evaluators.set(evaluator.id, evaluator as ScenarioEvaluator);
    return this;
  }

  get(id: string): ScenarioEvaluator {
    const evaluator = this.evaluators.get(id);
    if (!evaluator) throw new Error(`Unknown evaluator "${id}" (available: ${[...this.evaluators.keys()].join(", ") || "none"})`);
    return evaluator;
  }

  list(): ScenarioEvaluator[] {
    return [...this.evaluators.values()];
  }

  registerAdapter(adapter: ProtocolAdapter): this {
    if (this.adapters.has(adapter.id)) throw new Error(`Protocol adapter "${adapter.id}" is already registered`);
    this.adapters.set(adapter.id, adapter);
    return this;
  }

  adapter(id: string): ProtocolAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new Error(`Unknown protocol adapter "${id}" (available: ${[...this.adapters.keys()].join(", ") || "none"})`);
    return adapter;
  }

  listAdapters(): ProtocolAdapter[] {
    return [...this.adapters.values()];
  }
}
