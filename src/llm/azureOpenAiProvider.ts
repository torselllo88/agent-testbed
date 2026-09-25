import { AzureOpenAI } from "openai";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import { toProviderError, type CompletionRequest, type CompletionResult, type LlmProvider } from "./provider.js";

export interface AzureProviderConfig {
  apiKey: string;
  endpoint: string;
  apiVersion: string;
}

/**
 * Azure OpenAI: an experiment's `model` is the deployment name. No
 * `deployment` is bound on the client on purpose — passing it per request
 * lets each agent target its own deployment through one client.
 */
export class AzureOpenAiProvider implements LlmProvider {
  readonly id = "azure" as const;
  private readonly client: AzureOpenAI;

  constructor(config: AzureProviderConfig) {
    this.client = new AzureOpenAI({
      apiKey: config.apiKey,
      endpoint: config.endpoint,
      apiVersion: config.apiVersion,
      maxRetries: 0,
    });
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const body: ChatCompletionCreateParamsNonStreaming = {
      model: request.model,
      messages: request.messages,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.seed !== undefined ? { seed: request.seed } : {}),
      ...(request.maxOutputTokens !== undefined ? { max_completion_tokens: request.maxOutputTokens } : {}),
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
      throw toProviderError(err, `Azure OpenAI (deployment: ${request.model}) request failed`);
    }

    const choice = completion.choices[0];
    return {
      text: choice?.message.content ?? "",
      requestedModel: request.model,
      servedModel: completion.model || request.model,
      usage: completion.usage
        ? { promptTokens: completion.usage.prompt_tokens, completionTokens: completion.usage.completion_tokens }
        : null,
      finishReason: choice?.finish_reason ?? undefined,
      providerMeta: { completionId: completion.id },
    };
  }
}
