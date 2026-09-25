import OpenAI from "openai";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import { toProviderError, type CompletionRequest, type CompletionResult, type LlmProvider } from "./provider.js";

export interface OpenRouterProviderConfig {
  apiKey: string;
  baseUrl: string;
  siteUrl?: string;
  siteName?: string;
}

/**
 * The `openai` SDK's APIError.message is just `"${status} ${error.message}"`
 * — for OpenRouter, `error.message` is often a generic wrapper ("Provider
 * returned error") while the upstream provider's real error text lives at
 * `error.metadata.raw`. Without this every upstream rejection looks alike.
 */
function extractOpenRouterErrorDetail(err: unknown): string {
  const base = err instanceof Error ? err.message : String(err);
  const metadata = (err as { error?: { metadata?: { raw?: unknown; provider_name?: unknown } } })?.error?.metadata;
  if (!metadata) return base;

  const raw = typeof metadata.raw === "string" ? metadata.raw : metadata.raw ? JSON.stringify(metadata.raw) : undefined;
  const provider = typeof metadata.provider_name === "string" ? metadata.provider_name : undefined;
  if (!raw) return base;
  return `${base} (upstream provider${provider ? ` "${provider}"` : ""} said: ${raw})`;
}

/** Fields OpenRouter adds on top of the OpenAI chat-completion response shape. */
interface OpenRouterExtras {
  provider?: string;
  usage?: { cost?: number };
}

export class OpenRouterProvider implements LlmProvider {
  readonly id = "openrouter" as const;
  private readonly client: OpenAI;

  constructor(config: OpenRouterProviderConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      // Retries are the agent runtime's job, so each attempt is traced individually.
      maxRetries: 0,
      defaultHeaders: {
        ...(config.siteUrl ? { "HTTP-Referer": config.siteUrl } : {}),
        ...(config.siteName ? { "X-Title": config.siteName } : {}),
      },
    });
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const body: ChatCompletionCreateParamsNonStreaming & { usage?: { include: boolean } } = {
      model: request.model,
      messages: request.messages,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.seed !== undefined ? { seed: request.seed } : {}),
      ...(request.maxOutputTokens !== undefined ? { max_tokens: request.maxOutputTokens } : {}),
      ...(request.responseFormat
        ? {
            response_format: {
              type: "json_schema",
              json_schema: { name: request.responseFormat.name, schema: request.responseFormat.schema, strict: true },
            },
          }
        : {}),
      // OpenRouter usage accounting: makes the response carry the real billed cost.
      usage: { include: true },
    };

    let completion;
    try {
      completion = await this.client.chat.completions.create(body, { signal: request.signal });
    } catch (err) {
      const providerError = toProviderError(err, `OpenRouter (model: ${request.model}) request failed`);
      providerError.message = `OpenRouter (model: ${request.model}) request failed: ${extractOpenRouterErrorDetail(err)}`;
      throw providerError;
    }

    const extras = completion as unknown as OpenRouterExtras;
    const choice = completion.choices[0];
    return {
      text: choice?.message.content ?? "",
      requestedModel: request.model,
      servedModel: completion.model || request.model,
      usage: completion.usage
        ? { promptTokens: completion.usage.prompt_tokens, completionTokens: completion.usage.completion_tokens }
        : null,
      reportedCostUsd: typeof extras.usage?.cost === "number" ? extras.usage.cost : undefined,
      finishReason: choice?.finish_reason ?? undefined,
      providerMeta: { generationId: completion.id, ...(extras.provider ? { upstreamProvider: extras.provider } : {}) },
    };
  }
}
