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
  /**
   * Artificial latency per stub-provider call in the web server, so a stub
   * run can be watched live. The CLI and batch runs always use 0.
   */
  stubLatencyMs: (() => {
    const parsed = Number.parseInt(process.env.STUB_LATENCY_MS ?? "", 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 300;
  })(),
  /**
   * SQLite durability. NORMAL (default) in WAL mode survives process crashes
   * and restarts; only an OS crash / power loss can drop the latest commits.
   * FULL fsyncs every write (~25x slower per trace event on a typical disk).
   */
  sqliteSynchronous: (() => {
    const value = (process.env.SQLITE_SYNCHRONOUS || "NORMAL").toUpperCase();
    if (!["OFF", "NORMAL", "FULL", "EXTRA"].includes(value)) {
      throw new Error(`SQLITE_SYNCHRONOUS must be OFF, NORMAL, FULL or EXTRA (got "${process.env.SQLITE_SYNCHRONOUS}")`);
    }
    return value as "OFF" | "NORMAL" | "FULL" | "EXTRA";
  })(),
  /**
   * Maximum simultaneous in-flight requests per real LLM provider, across
   * every experiment and batch in this process. Independent of batch
   * concurrency: one experiment's voting step alone issues one request per agent.
   */
  llmMaxConcurrentRequests: parseIntEnv(process.env.LLM_MAX_CONCURRENT_REQUESTS, 8),
  /** PORT is what most PaaS platforms inject; GUI_PORT is the local-dev override. */
  port: parseIntEnv(process.env.PORT ?? process.env.GUI_PORT, 3939),
  /** Loopback by default — a plain `npm start` should never be reachable from the network. */
  host: process.env.GUI_HOST || "127.0.0.1",
  /**
   * Host names the operator UI answers to besides loopback (DNS-rebinding guard).
   * Needed only when it is reached under another name, e.g. bound to 0.0.0.0.
   */
  allowedHosts: (process.env.GUI_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  /**
   * External Room API (docs/external-room-api.md): a separate listener that
   * serves only /api/external/*, so the operator UI can stay on loopback.
   * Disabled unless a token is set. The token is plain bearer auth: put TLS
   * (a reverse proxy) or a private network in front of it for remote consumers.
   */
  externalApi: {
    token: process.env.EXTERNAL_API_TOKEN || undefined,
    port: parseIntEnv(process.env.EXTERNAL_API_PORT, 3940),
    host: process.env.EXTERNAL_API_HOST || "127.0.0.1",
    /** Default-deny: only these scenarios (built-in ids or library scenario ids) can be started externally. */
    scenarios: (process.env.EXTERNAL_SCENARIOS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  },
};
