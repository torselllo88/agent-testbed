import type { ScenarioEvaluator } from "./types.js";

export class EvaluatorRegistry {
  private readonly evaluators = new Map<string, ScenarioEvaluator>();

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
}
