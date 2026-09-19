import { embedMany, type EmbeddingModel } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { Config } from './config.js';
import { EmbeddingProvider } from './enums.js';

export type Embed = (values: string[], signal?: AbortSignal) => Promise<number[][]>;

export function createEmbed(config: Config): Embed {
  const { provider, model: modelId } = config.EMBEDDING_MODEL;
  const model: EmbeddingModel =
    provider === EmbeddingProvider.OpenAI
      ? createOpenAI({ apiKey: config.EMBEDDING_API_KEY ?? config.OPENAI_API_KEY }).embeddingModel(
          modelId,
        )
      : createOpenAICompatible({
          name: 'compatible',
          baseURL: config.EMBEDDING_BASE_URL,
          apiKey: config.EMBEDDING_API_KEY,
        }).embeddingModel(modelId);

  return async (values, abortSignal) =>
    values.length ? (await embedMany({ model, values, abortSignal })).embeddings : [];
}
