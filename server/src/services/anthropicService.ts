
import Anthropic from '@anthropic-ai/sdk';
import { auditLlmCall } from './audit/audit.js';
import { callerName } from './audit/callerName.js';
import { estimateCostUsd } from './llmCost.js';
import { logIfRefused } from './llm/lightModel.js';
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
    feature?: string;
  }
): Promise<string> {
  const feature = options?.feature ?? `anthropic:${callerName(2)}`;
  const anthropic = getClient();
  try {
    const model = options?.model ?? 'claude-sonnet-4-6';
    const response = await anthropic.messages.create({
      model,
      max_tokens: options?.maxTokens ?? 2048,
      ...(acceptsTemperature(model) ? { temperature: options?.temperature ?? 0.3 } : {}),
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
