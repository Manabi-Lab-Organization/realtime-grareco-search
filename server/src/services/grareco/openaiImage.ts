
import { auditLlmCall } from '../audit/audit.js';

const FLARE_MODEL = 'gpt-image-2.5-flare';

const FLARE_SIZE = '2720x2048';
const FLARE_QUALITY = 'high';

const RATE_INPUT_PER_M = 5;
const RATE_OUTPUT_PER_M = 30;

const PROMPT_DROPPED_TOKEN_THRESHOLD = 100;

export class PromptDroppedError extends Error {
  constructor(public readonly inputTokens: number, public readonly promptLength: number) {
    super(
      `OpenAI がプロンプトを捨てました（input_tokens=${inputTokens}, prompt=${promptLength}字）。` +
        '無関係な画像が返るため失敗として扱います。',
    );
    this.name = 'PromptDroppedError';
  }
}

export function isPromptDropped(inputTokens: number | undefined): boolean {
  return inputTokens != null && inputTokens < PROMPT_DROPPED_TOKEN_THRESHOLD;
}

export function flareCostUsd(inputTokens = 0, outputTokens = 0): number {
  return (inputTokens * RATE_INPUT_PER_M + outputTokens * RATE_OUTPUT_PER_M) / 1_000_000;
}

export interface OpenAIImageResult {
  imageUrl: string;
  modelUsed: string;
  costUsd: number;
  imageDimensions: string;
  quality: string;
  elapsedMs: number;
}

export async function generateGrarecoOpenAI(prompt: string): Promise<OpenAIImageResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY が設定されていません');

  const startedAt = Date.now();
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: FLARE_MODEL, prompt, size: FLARE_SIZE, quality: FLARE_QUALITY }),
  });

  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`OpenAI HTTP ${res.status}: ${JSON.stringify(json?.error ?? json).slice(0, 300)}`);
  }

  const b64 = json?.data?.[0]?.b64_json;
  if (!b64) throw new Error('OpenAI から画像が返りませんでした');

  const inputTokens = json?.usage?.input_tokens;
  const outputTokens = json?.usage?.output_tokens;
  if (isPromptDropped(inputTokens)) throw new PromptDroppedError(inputTokens, prompt.length);

  const elapsedMs = Date.now() - startedAt;
  const costUsd = flareCostUsd(inputTokens ?? 0, outputTokens ?? 0);
  console.log(
    `[Grareco-OpenAI] ${FLARE_MODEL} ${FLARE_SIZE} ${FLARE_QUALITY} ` +
      `${(elapsedMs / 1000).toFixed(1)}s in=${inputTokens} out=${outputTokens} $${costUsd.toFixed(4)}`,
  );
  auditLlmCall({ feature: 'grareco:openaiImage', model: FLARE_MODEL, inputTokens, outputTokens, costUsd });

  return {
    imageUrl: `data:image/png;base64,${b64}`,
    modelUsed: FLARE_MODEL,
    costUsd,
    imageDimensions: FLARE_SIZE.replace('x', 'x'),
    quality: FLARE_QUALITY,
    elapsedMs,
  };
}
