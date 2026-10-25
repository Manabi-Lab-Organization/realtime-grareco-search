import { acceptsTemperature, supportsEffort, thinksByDefault } from './modelSupport.js';

export const DEFAULT_LIGHT_MODEL = 'claude-haiku-5-5';
export const GRARECO_DETECTION_MODEL = 'claude-haiku-4-5-20251001';
export const THINKING_HEADROOM_TOKENS = 4096;

export interface LightRequestParams {
  max_tokens: number;
  temperature?: number;
  output_config?: { effort: 'low' };
}

export function lightRequestParams(model: string, opts: { maxTokens: number; temperature?: number }): LightRequestParams {
  const params: LightRequestParams = {
    max_tokens: opts.maxTokens + (thinksByDefault(model) ? THINKING_HEADROOM_TOKENS : 0),
  };
  if (opts.temperature !== undefined && acceptsTemperature(model)) params.temperature = opts.temperature;
  if (supportsEffort(model)) params.output_config = { effort: 'low' };
  return params;
}

export function logIfRefused(
  response: { stop_reason?: string | null; stop_details?: { category?: string | null } | null },
  feature: string,
  model: string,
): boolean {
  if (response.stop_reason !== 'refusal') return false;
  console.warn(`[llm:refusal] feature=${feature} model=${model} category=${response.stop_details?.category ?? 'unknown'}`);
  return true;
}
