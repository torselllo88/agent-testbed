import type { RunExtensionFactory } from "../experiment/extensions.js";
import { narratorExtension } from "./narrator.js";
import { pacingExtension } from "./pacing.js";

/**
 * The presentation layer, attached to runs through the experiment core's
 * extension interface (see experiment/extensions.ts). Each extension checks
 * the run's config itself, so scenarios without narration or pacing get no
 * observable behavior from it.
 */
// Order matters: the narrator posts due beats first (each paced like any message), then pacing holds the message itself.
export const presentationExtensions: RunExtensionFactory = () => [narratorExtension(), pacingExtension()];
