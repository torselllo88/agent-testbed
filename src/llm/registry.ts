import { env } from "../config/env.js";
import { AzureOpenAiProvider } from "./azureOpenAiProvider.js";
import { ConcurrencyGate } from "./concurrencyGate.js";
import { OllamaProvider } from "./ollamaProvider.js";
import { OpenAiCompatibleProvider } from "./openAiCompatibleProvider.js";
import { OpenRouterProvider } from "./openRouterProvider.js";
import { ProviderError, type LlmProvider, type ProviderId } from "./provider.js";
import { StubProvider } from "./stubProvider.js";

export interface ProviderStatus {
  id: ProviderId;
  configured: boolean;
  /** Human-readable hint for the UI when a provider is not configured. */
  hint?: string;
  /** Live request-gate state (real providers only). */
  gate?: ReturnType<ConcurrencyGate["stats"]>;
  /** For a self-hosted endpoint: its name, server URL (never its key) and the API it speaks. */
  endpoint?: { name: string; baseUrl?: string; api?: "openai" | "ollama" };
}

/** A self-hosted model server (an "openai-compatible:<name>" endpoint), whichever API it speaks. */
export type SelfHostedProvider = OpenAiCompatibleProvider | OllamaProvider;

export function isSelfHostedProvider(provider: LlmProvider | null | undefined): provider is SelfHostedProvider {
  return provider instanceof OpenAiCompatibleProvider || provider instanceof OllamaProvider;
}

export interface ProviderRegistryOptions {
  secrets?: string[];
  /** Per real provider, across the whole process. Default: no limit (tests); the app passes LLM_MAX_CONCURRENT_REQUESTS. */
  maxConcurrentRequests?: number;
  /**
   * Separate request pools for work that must never queue ahead of (or behind)
   * experiments — e.g. the post-run debrief, whose calls would otherwise count
   * as a running experiment's queue time. Pool name -> slots per real provider
   * (default 2). Only used when maxConcurrentRequests is set.
   */
  poolLimits?: Record<string, number>;
  /** Per-provider request limits that replace maxConcurrentRequests (e.g. a self-hosted endpoint sized to its GPUs). */
  maxConcurrentByProvider?: Record<string, number>;
  /** Providers declared in the environment but not usable (e.g. an endpoint without a URL) — listed as not configured. */
  unavailable?: ProviderStatus[];
}

/**
 * Every provider an experiment's agents can be pointed at, keyed by id — so
 * different agents in the same experiment can use different providers and
 * models. The stub provider is always available and never gated.
 */
export class ProviderRegistry {
  private readonly providers = new Map<ProviderId, LlmProvider>();
  private readonly secrets: string[];
  private readonly gates: Map<ProviderId, ConcurrencyGate>;
  private readonly poolGates: Map<string, ConcurrencyGate>;
  private readonly poolLimits: Record<string, number>;
  private readonly maxConcurrentByProvider: Record<string, number>;
  private readonly unavailable: ProviderStatus[];
  readonly maxConcurrentRequests: number | null;

  constructor(
    providers: LlmProvider[],
    readonly stub: StubProvider,
    options: ProviderRegistryOptions = {},
    /** Internal: lets withStub() share the same gates, so the limit stays process-wide. */
    sharedGates?: Map<ProviderId, ConcurrencyGate>,
    sharedPoolGates?: Map<string, ConcurrencyGate>
  ) {
    this.poolGates = sharedPoolGates ?? new Map();
    this.poolLimits = options.poolLimits ?? {};
    for (const provider of providers) this.providers.set(provider.id, provider);
    this.providers.set("stub", stub);
    this.secrets = (options.secrets ?? []).filter((s) => s.length >= 8);
    this.maxConcurrentRequests = options.maxConcurrentRequests ?? null;
    this.maxConcurrentByProvider = options.maxConcurrentByProvider ?? {};
    this.unavailable = options.unavailable ?? [];
    const limitOf = (id: ProviderId) => this.maxConcurrentByProvider[id] ?? this.maxConcurrentRequests;
    this.gates =
      sharedGates ??
      new Map(
        providers
          .filter((p) => p.id !== "stub" && limitOf(p.id) !== null)
          .map((p) => [p.id, new ConcurrencyGate(limitOf(p.id)!)] as const)
      );
  }

  /** Same real providers, secrets and request gates, with a different stub instance (see StubProvider.withLatency). */
  withStub(stub: StubProvider): ProviderRegistry {
    const real = [...this.providers.values()].filter((p) => p.id !== "stub");
    return new ProviderRegistry(
      real,
      stub,
      {
        secrets: this.secrets,
        maxConcurrentRequests: this.maxConcurrentRequests ?? undefined,
        poolLimits: this.poolLimits,
        maxConcurrentByProvider: this.maxConcurrentByProvider,
        unavailable: this.unavailable,
      },
      this.gates,
      this.poolGates
    );
  }

  get(id: ProviderId): LlmProvider {
    const provider = this.providers.get(id);
    if (!provider) {
      throw new ProviderError(`LLM provider "${id}" is not configured — see .env.example`, false);
    }
    return provider;
  }

  has(id: ProviderId): boolean {
    return this.providers.has(id);
  }

  /**
   * The process-wide request gate for a provider, or null when it is not gated
   * (stub, or no limit configured). With a pool, the separate gate of that pool.
   */
  gate(id: ProviderId, pool?: string): ConcurrencyGate | null {
    if (!pool) return this.gates.get(id) ?? null;
    if (!this.gates.has(id)) return null;
    const key = `${pool}:${id}`;
    let gate = this.poolGates.get(key);
    if (!gate) {
      gate = new ConcurrencyGate(this.poolLimits[pool] ?? 2);
      this.poolGates.set(key, gate);
    }
    return gate;
  }

  status(): ProviderStatus[] {
    const gateOf = (id: ProviderId) => (this.gates.get(id) ? { gate: this.gates.get(id)!.stats() } : {});
    return [
      {
        id: "openrouter",
        configured: this.has("openrouter"),
        hint: this.has("openrouter") ? undefined : "Set OPENROUTER_API_KEY in .env",
        ...gateOf("openrouter"),
      },
      {
        id: "azure",
        configured: this.has("azure"),
        hint: this.has("azure") ? undefined : "Set AZURE_OPENAI_API_KEY, AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_VERSION in .env",
        ...gateOf("azure"),
      },
      ...[...this.providers.values()]
        .filter(isSelfHostedProvider)
        .map((p) => ({ id: p.id, configured: true, endpoint: { name: p.endpoint, baseUrl: p.baseUrl, api: p.api }, ...gateOf(p.id) })),
      ...this.unavailable,
      { id: "stub", configured: true },
    ];
  }

  /** Credential values that must never be persisted — the event log redacts any occurrence of them. */
  secretValues(): readonly string[] {
    return this.secrets;
  }
}

export function createProviderRegistryFromEnv(stub: StubProvider = new StubProvider()): ProviderRegistry {
  const providers: LlmProvider[] = [];
  const secrets: string[] = [];

  const { openRouter, azureOpenAi } = env;
  if (openRouter.apiKey) {
    providers.push(new OpenRouterProvider({ ...openRouter, apiKey: openRouter.apiKey }));
    secrets.push(openRouter.apiKey);
  }
  if (azureOpenAi.apiKey && azureOpenAi.endpoint && azureOpenAi.apiVersion) {
    providers.push(
      new AzureOpenAiProvider({
        apiKey: azureOpenAi.apiKey,
        endpoint: azureOpenAi.endpoint,
        apiVersion: azureOpenAi.apiVersion,
      })
    );
    secrets.push(azureOpenAi.apiKey);
  }

  // Access tokens never belong in a trace either: scrub them like provider keys.
  for (const token of [env.operatorToken, env.externalApi.token]) if (token) secrets.push(token);

  const maxConcurrentByProvider: Record<string, number> = {};
  const unavailable: ProviderStatus[] = [];
  for (const endpoint of env.openAiCompatible) {
    const id: ProviderId = `openai-compatible:${endpoint.name}`;
    if (!endpoint.baseUrl) {
      const key = `OPENAI_COMPATIBLE_${endpoint.name.toUpperCase().replace(/-/g, "_")}_BASE_URL`;
      unavailable.push({ id, configured: false, hint: `Set ${key}`, endpoint: { name: endpoint.name } });
      continue;
    }
    if (endpoint.invalidApi) {
      const key = `OPENAI_COMPATIBLE_${endpoint.name.toUpperCase().replace(/-/g, "_")}_API`;
      unavailable.push({ id, configured: false, hint: `${key}=${endpoint.invalidApi} is not supported (use openai or ollama)`, endpoint: { name: endpoint.name, baseUrl: endpoint.baseUrl } });
      continue;
    }
    providers.push(
      endpoint.api === "ollama"
        ? new OllamaProvider({ name: endpoint.name, baseUrl: endpoint.baseUrl })
        : new OpenAiCompatibleProvider({ name: endpoint.name, baseUrl: endpoint.baseUrl, apiKey: endpoint.apiKey })
    );
    if (endpoint.apiKey) secrets.push(endpoint.apiKey);
    if (endpoint.maxConcurrent) maxConcurrentByProvider[id] = endpoint.maxConcurrent;
  }

  return new ProviderRegistry(providers, stub, {
    maxConcurrentByProvider,
    unavailable,
    secrets,
    maxConcurrentRequests: env.llmMaxConcurrentRequests,
    poolLimits: { debrief: env.llmMaxConcurrentDebriefRequests },
  });
}
