
import Anthropic from '@anthropic-ai/sdk';
import { auditLlmCall } from './audit/audit.js';
import { callerName } from './audit/callerName.js';
import { estimateCostUsd } from './llmCost.js';
import { lightRequestParams, logIfRefused } from './llm/lightModel.js';
import { acceptsTemperature } from './llm/modelSupport.js';

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY is not set');
    }
    client = new Anthropic({ apiKey });
  }
  return client;
}

export async function analyzeWithClaude(
  systemPrompt: string,
  userMessage: string,
  options?: {
    model?: string;
    maxTokens?: number;
    temperature?: number;
    effort?: 'low';
    feature?: string;
  }
): Promise<string> {
  const feature = options?.feature ?? `anthropic:${callerName(2)}`;
  const anthropic = getClient();
  try {
    const model = options?.model ?? 'claude-sonnet-4-6';
    const maxTokens = options?.maxTokens ?? 2048;
    const temperature = options?.temperature ?? 0.3;
    const response = await anthropic.messages.create({
      model,
      ...(options?.effort
        ? lightRequestParams(model, { maxTokens, temperature })
        : { max_tokens: maxTokens, ...(acceptsTemperature(model) ? { temperature } : {}) }),
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });
    logIfRefused(response, feature, model);

    const u = response.usage;
    auditLlmCall({
      feature,
      model,
      inputTokens: u?.input_tokens ?? null,
      outputTokens: u?.output_tokens ?? null,
      costUsd: u ? estimateCostUsd(model, u.input_tokens ?? 0, u.output_tokens ?? 0) : null,
    });

    const textBlock = response.content.find(b => b.type === 'text');
    return textBlock?.text ?? '';
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`[research:Anthropic] API call failed: ${errMsg}`);
    throw error;
  }
}

export async function analyzeWithClaudeJson(
  systemPrompt: string,
  userMessage: string,
  schema: Record<string, unknown>,
  options: { model: string; maxTokens: number; temperature?: number; feature: string },
): Promise<{ text: string; stopReason: string | null }> {
  const anthropic = getClient();
  const { model, feature } = options;
  const light = lightRequestParams(model, { maxTokens: options.maxTokens, temperature: options.temperature });
  const response = await anthropic.messages.create({
    model,
    max_tokens: light.max_tokens,
    ...(light.temperature !== undefined ? { temperature: light.temperature } : {}),
    output_config: { ...(light.output_config ?? {}), format: { type: 'json_schema', schema } },
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });
  logIfRefused(response, feature, model);
  if (response.stop_reason === 'max_tokens') {
    console.warn(`[llm:max_tokens] feature=${feature} model=${model}`);
  }

  const u = response.usage;
  auditLlmCall({
    feature,
    model,
    inputTokens: u?.input_tokens ?? null,
    outputTokens: u?.output_tokens ?? null,
    costUsd: u ? estimateCostUsd(model, u.input_tokens ?? 0, u.output_tokens ?? 0) : null,
  });

  const textBlock = response.content.find(b => b.type === 'text');
  return { text: textBlock?.text ?? '', stopReason: response.stop_reason ?? null };
}
