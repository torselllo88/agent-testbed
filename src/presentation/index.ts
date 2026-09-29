import type { RunExtensionFactory } from "../experiment/extensions.js";
import { narratorExtension } from "./narrator.js";
import { pacingExtension } from "./pacing.js";

/**
 * The presentation layer, attached to runs through the experiment core's
 * extension interface (see experiment/extensions.ts). Each extension checks
 * the run's config itself, so scenarios without narration or pacing get no
 * observable behavior from it.
 */
export const presentationExtensions: RunExtensionFactory = () => [pacingExtension(), narratorExtension()];
