import { analyzeWithClaude, analyzeWithClaudeJson } from '../anthropicService.js';
import { DEFAULT_LIGHT_MODEL } from '../llm/lightModel.js';

export const DRAFT_ANSWER_MAX_TOKENS = 2048;
const DRAFT_TEMPERATURE = 0.4;
const DRAFT_FEATURE = 'anthropic:grareco.autoDraft';

export const GRARECO_DRAFT_MODEL_DEFAULT = DEFAULT_LIGHT_MODEL;

export function grarecoDraftModel(env: NodeJS.ProcessEnv = process.env): string {
  return env.GRARECO_DRAFT_MODEL?.trim() || GRARECO_DRAFT_MODEL_DEFAULT;
}

export function grarecoDraftUsesJsonSchema(env: NodeJS.ProcessEnv = process.env): boolean {
  return !['off', 'false', '0'].includes((env.GRARECO_DRAFT_JSON_SCHEMA ?? '').trim().toLowerCase());
}

export const GRARECO_DRAFT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'sections', 'highlights', 'researchRefs', 'visualStyle'],
  properties: {
    title: { type: 'string' },
    subtitle: { type: 'string' },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['icon', 'heading', 'bullets'],
        properties: {
          icon: { type: 'string' },
          heading: { type: 'string' },
          bullets: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    highlights: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'kind'],
        properties: {
          text: { type: 'string' },
          kind: { type: 'string', enum: ['decision', 'question', 'risk', 'insight'] },
        },
      },
    },
    researchRefs: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['insightId', 'headline', 'createdAt'],
        properties: {
          insightId: { type: 'integer' },
          headline: { type: 'string' },
          createdAt: { type: 'string' },
        },
      },
    },
    visualStyle: { type: 'string', enum: ['reflect_map', 'tree', 'fishbone', '2x2', 'blank_quadrant'] },
    mermaid: { type: 'string' },
  },
};

export async function requestGrarecoDraftText(
  systemPrompt: string,
  userMessage: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const model = grarecoDraftModel(env);
  if (grarecoDraftUsesJsonSchema(env)) {
    try {
      const { text, stopReason } = await analyzeWithClaudeJson(systemPrompt, userMessage, GRARECO_DRAFT_SCHEMA, {
        model,
        maxTokens: DRAFT_ANSWER_MAX_TOKENS,
        temperature: DRAFT_TEMPERATURE,
        feature: DRAFT_FEATURE,
      });
      if (text && stopReason !== 'max_tokens' && stopReason !== 'refusal') return text;
      console.warn(`[autoGrareco] 形を指定した下書きを使えなかったので、指示文だけでやり直す model=${model} stop_reason=${stopReason}`);
    } catch (err) {
      console.warn(
        `[autoGrareco] 形を指定した下書きに失敗したので、指示文だけでやり直す model=${model}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
  return analyzeWithClaude(systemPrompt, userMessage, {
    model,
    effort: 'low',
    maxTokens: DRAFT_ANSWER_MAX_TOKENS,
    temperature: DRAFT_TEMPERATURE,
    feature: DRAFT_FEATURE,
  });
}
