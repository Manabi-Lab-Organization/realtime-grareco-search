import { requiresDataRetention, supportsEffort } from '../llm/modelSupport.js';

export const DEFAULT_ORCHESTRATOR_MODEL = 'claude-sonnet-5-5';
export const DEFAULT_FACTCHECK_MODEL = 'claude-sonnet-5-5';
export const DEFAULT_HAIKU_MODEL = 'claude-haiku-5-5';
export const DEFAULT_ORCHESTRATOR_EFFORT = 'medium';

export const ORCHESTRATOR_EFFORT_LEVELS = ['low', 'medium', 'high', 'max'] as const;
export type OrchestratorEffort = (typeof ORCHESTRATOR_EFFORT_LEVELS)[number];

export interface ResearchModelConfig {
  orchestratorModel: string;
  factCheckModel: string;
  haikuModel: string;
  orchestratorEffort: OrchestratorEffort | undefined;
  orchestratorWeb: boolean;
  warnings: string[];
}

function pickModel(envName: string, raw: string | undefined, fallback: string, warnings: string[]): string {
  const value = raw?.trim();
  if (!value) return fallback;
  if (requiresDataRetention(value)) {
    warnings.push(`${envName}=${value} は 30 日のデータ保持が必要なモデルのため使わず、${fallback} にします`);
    return fallback;
  }
  return value;
}

function pickEffort(raw: string | undefined, model: string): OrchestratorEffort | undefined {
  const value = (raw?.trim() || DEFAULT_ORCHESTRATOR_EFFORT).toLowerCase();
  if (!(ORCHESTRATOR_EFFORT_LEVELS as readonly string[]).includes(value)) return undefined;
  if (!supportsEffort(model)) return undefined;
  return value as OrchestratorEffort;
}

export function loadResearchModelConfig(env: NodeJS.ProcessEnv = process.env): ResearchModelConfig {
  const warnings: string[] = [];
  const orchestratorModel = pickModel('RESEARCH_ORCHESTRATOR_MODEL', env.RESEARCH_ORCHESTRATOR_MODEL, DEFAULT_ORCHESTRATOR_MODEL, warnings);
  const factCheckModel = pickModel('RESEARCH_FACTCHECK_MODEL', env.RESEARCH_FACTCHECK_MODEL, DEFAULT_FACTCHECK_MODEL, warnings);
  const haikuModel = pickModel('RESEARCH_HAIKU_MODEL', env.RESEARCH_HAIKU_MODEL, DEFAULT_HAIKU_MODEL, warnings);
  return {
    orchestratorModel,
    factCheckModel,
    haikuModel,
    orchestratorEffort: pickEffort(env.RESEARCH_ORCHESTRATOR_EFFORT, orchestratorModel),
    orchestratorWeb: env.RESEARCH_ORCHESTRATOR_WEB?.trim().toLowerCase() === 'true',
    warnings,
  };
}

export function describeResearchModelConfig(c: ResearchModelConfig): string {
  return `[research] models orchestrator=${c.orchestratorModel} effort=${c.orchestratorEffort ?? 'none'} orchestratorWeb=${c.orchestratorWeb} factcheck=${c.factCheckModel} others=${c.haikuModel}`;
}
