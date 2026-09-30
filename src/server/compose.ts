import { BatchService } from "../batch/service.js";
import type { EvaluatorRegistry } from "../evaluation/registry.js";
import type { RunExtensionFactory } from "../experiment/extensions.js";
import { ExperimentService } from "../experiment/service.js";
import { HumanInteractionService } from "../interaction/service.js";
import type { ProviderRegistry } from "../llm/registry.js";
import type { Db } from "../persistence/db.js";
import { presentationExtensions } from "../presentation/index.js";
import { ExternalRoomService } from "../rooms/service.js";

/**
 * The composition root shared by the server and its tests. The experiment
 * core knows none of the add-ons; they attach here:
 *   - presentation (narration, pacing) and the external-room projection as run extensions;
 *   - the human-interaction layer around finished runs;
 *   - external room bindings, which also serve as the interaction layer's room outlet.
 * The services refer to each other, so the two late references are resolved
 * after construction (nothing calls them before a run starts).
 */
export function composeTestbed(deps: { db: Db; providers: ProviderRegistry; evaluators: EvaluatorRegistry; externalScenarios?: string[] }) {
  let rooms: ExternalRoomService | null = null;
  const extensions: RunExtensionFactory = (config) => [...presentationExtensions(config), ...(rooms?.extensions(config) ?? [])];
  const service = new ExperimentService({ db: deps.db, providers: deps.providers, evaluators: deps.evaluators, extensions });
  const batches = new BatchService({ db: deps.db, providers: deps.providers, evaluators: deps.evaluators, service });
  const interaction = new HumanInteractionService({
    db: deps.db,
    providers: deps.providers,
    experiments: service,
    outlet: { post: (experimentId, message) => rooms!.post(experimentId, message) },
  });
  rooms = new ExternalRoomService({
    db: deps.db,
    providers: deps.providers,
    evaluators: deps.evaluators,
    experiments: service,
    interaction,
    allowedScenarios: deps.externalScenarios ?? [],
  });
  return { service, batches, interaction, rooms };
}
