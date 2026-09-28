import { env } from "../config/env.js";
import { AzureOpenAiProvider } from "./azureOpenAiProvider.js";
import { ConcurrencyGate } from "./concurrencyGate.js";
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
}

export interface ProviderRegistryOptions {
  secrets?: string[];
  /** Per real provider, across the whole process. Default: no limit (tests); the app passes LLM_MAX_CONCURRENT_REQUESTS. */
  maxConcurrentRequests?: number;
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
  readonly maxConcurrentRequests: number | null;

  constructor(
    providers: LlmProvider[],
    readonly stub: StubProvider,
    options: ProviderRegistryOptions = {},
    /** Internal: lets withStub() share the same gates, so the limit stays process-wide. */
    sharedGates?: Map<ProviderId, ConcurrencyGate>
  ) {
    for (const provider of providers) this.providers.set(provider.id, provider);
    this.providers.set("stub", stub);
    this.secrets = (options.secrets ?? []).filter((s) => s.length >= 8);
    this.maxConcurrentRequests = options.maxConcurrentRequests ?? null;
    this.gates =
      sharedGates ??
      new Map(
        this.maxConcurrentRequests === null
          ? []
          : providers.filter((p) => p.id !== "stub").map((p) => [p.id, new ConcurrencyGate(this.maxConcurrentRequests!)] as const)
      );
  }

  /** Same real providers, secrets and request gates, with a different stub instance (see StubProvider.withLatency). */
  withStub(stub: StubProvider): ProviderRegistry {
    const real = [...this.providers.values()].filter((p) => p.id !== "stub");
    return new ProviderRegistry(real, stub, { secrets: this.secrets, maxConcurrentRequests: this.maxConcurrentRequests ?? undefined }, this.gates);
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

  /** The process-wide request gate for a provider, or null when it is not gated (stub, or no limit configured). */
  gate(id: ProviderId): ConcurrencyGate | null {
    return this.gates.get(id) ?? null;
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

  return new ProviderRegistry(providers, stub, { secrets, maxConcurrentRequests: env.llmMaxConcurrentRequests });
}
