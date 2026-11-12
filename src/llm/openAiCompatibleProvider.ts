import OpenAI from "openai";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import { ProviderError, toProviderError, type CompletionRequest, type CompletionResult, type LlmProvider, type ProviderId } from "./provider.js";

export interface OpenAiCompatibleEndpointConfig {
  /** Logical name used in experiment configs ("endpoint": "lab-vllm"). */
  name: string;
  /** e.g. http://gpu-node-3:8000/v1 */
  baseUrl: string;
  /** Optional: many self-hosted servers need none. */
  apiKey?: string;
  /** Test seam: replaces the HTTP client's fetch. */
  fetch?: typeof fetch;
}

/**
 * A self-hosted model server speaking the OpenAI chat-completions API (vLLM,
 * TGI, LM Studio, llama.cpp server, …). One instance per configured endpoint,
 * registered as "openai-compatible:<name>" with its own request gate. Cost is
 * not reported by such servers, so it is recorded as unknown.
 */
export class OpenAiCompatibleProvider implements LlmProvider {
  readonly id: ProviderId;
  readonly endpoint: string;
  readonly baseUrl: string;
  readonly api = "openai" as const;
  private readonly client: OpenAI;

  constructor(config: OpenAiCompatibleEndpointConfig) {
    this.id = `openai-compatible:${config.name}`;
    this.endpoint = config.name;
    this.baseUrl = config.baseUrl;
    this.client = new OpenAI({
      // The SDK insists on a key; servers without authentication ignore it.
      apiKey: config.apiKey || "not-needed",
      baseURL: config.baseUrl,
      // Retries are the agent runtime's job, so each attempt is traced individually.
      maxRetries: 0,
      ...(config.fetch ? { fetch: config.fetch } : {}),
    });
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    if (request.contextLength !== undefined) {
      // The window of an OpenAI-API server is fixed when the model is served; it cannot be set per request.
      throw new ProviderError(`OpenAI-compatible endpoint "${this.endpoint}": contextLength can only be set per request on an Ollama endpoint`, false);
    }
    const body: ChatCompletionCreateParamsNonStreaming & { chat_template_kwargs?: Record<string, unknown> } = {
      model: request.model,
      messages: request.messages,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.seed !== undefined ? { seed: request.seed } : {}),
      ...(request.maxOutputTokens !== undefined ? { max_tokens: request.maxOutputTokens } : {}),
      // The convention of vLLM and SGLang for models with a thinking mode (Qwen3, …); other servers ignore it.
      ...(request.think !== undefined ? { chat_template_kwargs: { enable_thinking: request.think } } : {}),
      ...(request.responseFormat
        ? {
            response_format: {
              type: "json_schema",
              json_schema: { name: request.responseFormat.name, schema: request.responseFormat.schema, strict: true },
            },
          }
        : {}),
    };
    let completion;
    try {
      completion = await this.client.chat.completions.create(body, { signal: request.signal });
    } catch (err) {
      throw toProviderError(err, `OpenAI-compatible endpoint "${this.endpoint}" (model: ${request.model}) request failed`);
    }
    const choice = completion.choices[0];
    return {
      text: choice?.message.content ?? "",
      requestedModel: request.model,
      servedModel: completion.model || request.model,
      usage: completion.usage ? { promptTokens: completion.usage.prompt_tokens, completionTokens: completion.usage.completion_tokens } : null,
      finishReason: choice?.finish_reason ?? undefined,
      providerMeta: { endpoint: this.endpoint, ...(completion.id ? { generationId: completion.id } : {}) },
    };
  }

  /** The models the server serves (GET /models) — offered in the editor. */
  async listModels(): Promise<string[]> {
    try {
      const ids: string[] = [];
      for await (const model of this.client.models.list()) ids.push(model.id);
      return ids.sort();
    } catch (err) {
      throw toProviderError(err, `OpenAI-compatible endpoint "${this.endpoint}": listing models failed`);
    }
  }
}
