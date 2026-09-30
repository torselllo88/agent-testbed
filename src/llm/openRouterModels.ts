/**
 * OpenRouter's public model catalog (GET /models — no API key needed, none is
 * sent), trimmed to what the scenario editor shows, and cached in memory so
 * the editor does not hit OpenRouter on every page load.
 */

export interface OpenRouterModelInfo {
  /** The stable model id used in configs, e.g. "google/gemini-2.5-flash-lite". */
  id: string;
  name: string;
  contextLength: number | null;
  /** USD per million tokens; null when not published. */
  promptPerM: number | null;
  completionPerM: number | null;
  /** Whether OpenRouter lists JSON-schema structured outputs for this model (structuredOutput "native"). */
  structuredOutputs: boolean;
}

export interface OpenRouterCatalog {
  models: OpenRouterModelInfo[];
  fetchedAt: string;
}

const TTL_MS = 6 * 60 * 60 * 1000;

interface RawModel {
  id?: unknown;
  name?: unknown;
  context_length?: unknown;
  pricing?: { prompt?: unknown; completion?: unknown };
  supported_parameters?: unknown;
}

function perMillion(value: unknown): number | null {
  const n = typeof value === "string" ? Number.parseFloat(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e6 * 1e6) / 1e6 : null;
}

export function parseCatalog(body: unknown): OpenRouterModelInfo[] {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) throw new Error("unexpected OpenRouter /models response");
  return (data as RawModel[])
    .filter((m) => typeof m.id === "string" && m.id)
    .map((m) => ({
      id: m.id as string,
      name: typeof m.name === "string" ? m.name : (m.id as string),
      contextLength: typeof m.context_length === "number" ? m.context_length : null,
      promptPerM: perMillion(m.pricing?.prompt),
      completionPerM: perMillion(m.pricing?.completion),
      structuredOutputs: Array.isArray(m.supported_parameters) && m.supported_parameters.includes("structured_outputs"),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export class OpenRouterModelCatalog {
  private cached: OpenRouterCatalog | null = null;
  private inflight: Promise<OpenRouterCatalog> | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now
  ) {}

  async get(): Promise<OpenRouterCatalog> {
    if (this.cached && this.now() - Date.parse(this.cached.fetchedAt) < TTL_MS) return this.cached;
    this.inflight ??= this.load().finally(() => (this.inflight = null));
    return this.inflight;
  }

  private async load(): Promise<OpenRouterCatalog> {
    const res = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, "")}/models`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`OpenRouter /models returned ${res.status}`);
    this.cached = { models: parseCatalog(await res.json()), fetchedAt: new Date(this.now()).toISOString() };
    return this.cached;
  }
}
