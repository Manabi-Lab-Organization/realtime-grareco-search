import { describe, it, expect } from 'vitest';
import {
  DEFAULT_FACTCHECK_MODEL,
  DEFAULT_HAIKU_MODEL,
  DEFAULT_ORCHESTRATOR_MODEL,
  describeResearchModelConfig,
  loadResearchModelConfig,
} from '../modelConfig.js';
import { supportsEffort } from '../../llm/modelSupport.js';

describe('調査のモデルと設定', () => {
  it('何も設定しなければ既定のモデル ID・考える深さ medium・司令塔は検索しない', () => {
    const c = loadResearchModelConfig({});
    expect(c.orchestratorModel).toBe('claude-sonnet-5-5');
    expect(c.factCheckModel).toBe('claude-sonnet-5-5');
    expect(c.haikuModel).toBe('claude-haiku-5-5');
    expect(c.orchestratorEffort).toBe('medium');
    expect(c.orchestratorWeb).toBe(false);
    expect(c.warnings).toEqual([]);
  });

  it('環境変数でモデル・考える深さ・司令塔の検索を変えられる', () => {
    const c = loadResearchModelConfig({
      RESEARCH_ORCHESTRATOR_MODEL: 'claude-opus-5-5',
      RESEARCH_FACTCHECK_MODEL: 'claude-opus-5-5',
      RESEARCH_HAIKU_MODEL: 'claude-sonnet-5-5',
      RESEARCH_ORCHESTRATOR_EFFORT: 'high',
      RESEARCH_ORCHESTRATOR_WEB: 'true',
    });
    expect(c.orchestratorModel).toBe('claude-opus-5-5');
    expect(c.factCheckModel).toBe('claude-opus-5-5');
    expect(c.haikuModel).toBe('claude-sonnet-5-5');
    expect(c.orchestratorEffort).toBe('high');
    expect(c.orchestratorWeb).toBe(true);
  });

  it('一覧にない考える深さなら effort を送らない', () => {
    expect(loadResearchModelConfig({ RESEARCH_ORCHESTRATOR_EFFORT: 'default' }).orchestratorEffort).toBeUndefined();
    expect(loadResearchModelConfig({ RESEARCH_ORCHESTRATOR_EFFORT: 'xhigh' }).orchestratorEffort).toBeUndefined();
  });

  it('effort を受け付けないモデルには effort を送らない', () => {
    expect(loadResearchModelConfig({ RESEARCH_ORCHESTRATOR_MODEL: 'claude-sonnet-4-5-20250929' }).orchestratorEffort).toBeUndefined();
    expect(loadResearchModelConfig({ RESEARCH_ORCHESTRATOR_MODEL: 'claude-haiku-4-5-20251001', RESEARCH_ORCHESTRATOR_EFFORT: 'low' }).orchestratorEffort).toBeUndefined();
    expect(loadResearchModelConfig({ RESEARCH_ORCHESTRATOR_MODEL: 'claude-sonnet-4-6' }).orchestratorEffort).toBe('medium');
  });

  it('30 日のデータ保持が要るモデルは警告して既定に戻す', () => {
    const c = loadResearchModelConfig({
      RESEARCH_ORCHESTRATOR_MODEL: 'claude-fable-5-1',
      RESEARCH_FACTCHECK_MODEL: 'claude-mythos-5-1',
      RESEARCH_HAIKU_MODEL: 'claude-fable-5',
    });
    expect(c.orchestratorModel).toBe(DEFAULT_ORCHESTRATOR_MODEL);
    expect(c.factCheckModel).toBe(DEFAULT_FACTCHECK_MODEL);
    expect(c.haikuModel).toBe(DEFAULT_HAIKU_MODEL);
    expect(c.warnings).toHaveLength(3);
  });

  it('起動時のログに、モデル・考える深さ・検索の可否を 1 行で出す', () => {
    const line = describeResearchModelConfig(loadResearchModelConfig({}));
    expect(line).not.toContain('\n');
    expect(line).toContain('claude-sonnet-5-5');
    expect(line).toContain('effort=medium');
    expect(line).toContain('orchestratorWeb=false');
  });
});

describe('effort を受け付けるモデルの判定', () => {
  it('4.6 以降の世代だけ受け付ける', () => {
    for (const m of ['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-4-6', 'claude-sonnet-5', 'claude-opus-4-8']) {
      expect(supportsEffort(m), m).toBe(true);
    }
    for (const m of ['claude-haiku-4-5-20251001', 'claude-sonnet-4-5', 'claude-sonnet-4-20250514', 'sonnet', 'haiku']) {
      expect(supportsEffort(m), m).toBe(false);
    }
  });
});
