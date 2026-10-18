
export const LLM_PRICE_TABLE: Array<{ match: RegExp; inputPerMtok: number; outputPerMtok: number }> = [
  { match: /haiku/i, inputPerMtok: 1, outputPerMtok: 5 },
  { match: /sonnet-5/i, inputPerMtok: 2, outputPerMtok: 10 },
  { match: /sonnet/i, inputPerMtok: 3, outputPerMtok: 15 },
  { match: /opus/i, inputPerMtok: 5, outputPerMtok: 25 },
  { match: /^web_search$/, inputPerMtok: 10_000, outputPerMtok: 0 },
  { match: /gemini.*pro.*tts/i, inputPerMtok: 1, outputPerMtok: 20 },
  { match: /gemini.*tts/i, inputPerMtok: 0.5, outputPerMtok: 10 },
];

export const CACHE_WRITE_MULTIPLIER = 1.25;
export const CACHE_READ_MULTIPLIER = 0.1;

export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cache: { creationInputTokens?: number; readInputTokens?: number } = {},
): number {
  const price =
    LLM_PRICE_TABLE.find((p) => p.match.test(model)) ??
    { inputPerMtok: 3, outputPerMtok: 15 };
  const cacheWrite = (cache.creationInputTokens ?? 0) * price.inputPerMtok * CACHE_WRITE_MULTIPLIER;
  const cacheRead = (cache.readInputTokens ?? 0) * price.inputPerMtok * CACHE_READ_MULTIPLIER;
  return (
    inputTokens * price.inputPerMtok
    + outputTokens * price.outputPerMtok
    + cacheWrite
    + cacheRead
  ) / 1_000_000;
}
