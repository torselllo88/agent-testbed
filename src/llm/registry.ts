import { env } from "../config/env.js";
import { AzureOpenAiProvider } from "./azureOpenAiProvider.js";
import { OpenRouterProvider } from "./openRouterProvider.js";
import { ProviderError, type LlmProvider, type ProviderId } from "./provider.js";
import { StubProvider } from "./stubProvider.js";

export interface ProviderStatus {
  id: ProviderId;
  configured: boolean;
  /** Human-readable hint for the UI when a provider is not configured. */
  hint?: string;
}

/**
 * Every provider an experiment's agents can be pointed at, keyed by id — so
 * different agents in the same experiment can use different providers and
 * models. The stub provider is always available.
 */
export class ProviderRegistry {
  private readonly providers = new Map<ProviderId, LlmProvider>();
  private readonly secrets: string[];

  constructor(
    providers: LlmProvider[],
    readonly stub: StubProvider,
    secrets: string[] = []
  ) {
    for (const provider of providers) this.providers.set(provider.id, provider);
    this.providers.set("stub", stub);
    this.secrets = secrets.filter((s) => s.length >= 8);
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

  status(): ProviderStatus[] {
    return [
      {
        id: "openrouter",
        configured: this.has("openrouter"),
        hint: this.has("openrouter") ? undefined : "Set OPENROUTER_API_KEY in .env",
      },
      {
        id: "azure",
        configured: this.has("azure"),
        hint: this.has("azure") ? undefined : "Set AZURE_OPENAI_API_KEY, AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_VERSION in .env",
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

  return new ProviderRegistry(providers, stub, secrets);
}
