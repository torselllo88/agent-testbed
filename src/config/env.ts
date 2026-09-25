import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// Vitest sets process.env.VITEST = "true" for every test run — skip loading
// the real .env entirely under test, so the suite stays hermetic (no real
// provider is ever configured, whatever a developer's own .env contains).
if (!process.env.VITEST) {
  loadDotenv({ path: path.join(projectRoot, ".env"), quiet: true });
}

function parseIntEnv(value: string | undefined, fallback: number): number {
  const parsed = value ? Number.parseInt(value, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * The only place process.env is read. Credentials live here and in the
 * provider instances built from it — never in scenario/experiment configs,
 * the database, or the event trace (see llm/registry.ts's secretValues()).
 */
export const env = {
  projectRoot,
  dataDir: process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(projectRoot, "data"),
  openRouter: {
    apiKey: process.env.OPENROUTER_API_KEY || undefined,
    baseUrl: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
    siteUrl: process.env.OPENROUTER_SITE_URL || undefined,
    siteName: process.env.OPENROUTER_SITE_NAME || undefined,
  },
  azureOpenAi: {
    apiKey: process.env.AZURE_OPENAI_API_KEY || undefined,
    endpoint: process.env.AZURE_OPENAI_ENDPOINT || undefined,
    apiVersion: process.env.AZURE_OPENAI_API_VERSION || undefined,
  },
  /** PORT is what most PaaS platforms inject; GUI_PORT is the local-dev override. */
  port: parseIntEnv(process.env.PORT ?? process.env.GUI_PORT, 3939),
  /** Loopback by default — a plain `npm start` should never be reachable from the network. */
  host: process.env.GUI_HOST || "127.0.0.1",
};
