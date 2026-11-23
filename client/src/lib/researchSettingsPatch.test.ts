import { describe, it, expect } from 'vitest';
import { DEFAULT_AUTO_GRARECO_SETTINGS } from 'shared';
import { applyResearchSettingsPatch } from './researchSettingsPatch';

const base = {
  main: true,
  web: true,
  fact: true,
  gap: true,
  tech: true,
  autoGrareco: { ...DEFAULT_AUTO_GRARECO_SETTINGS, maxImagesPerHour: 9, discover: false },
};

describe('設定の一部だけを変える', () => {
  it('自動グラレコは、変えた項目だけを重ね、ほかの項目は今の値を残す', () => {
    const next = applyResearchSettingsPatch(base, { autoGrareco: { enabled: false } });
    expect(next.autoGrareco).toEqual({ ...base.autoGrareco, enabled: false });
    expect(next.autoGrareco.maxImagesPerHour).toBe(9);
    expect(next.main).toBe(true);
  });

  it('自動グラレコ以外の項目を変えても、自動グラレコの設定はそのまま', () => {
    const next = applyResearchSettingsPatch(base, { main: false });
    expect(next.main).toBe(false);
    expect(next.autoGrareco).toBe(base.autoGrareco);
  });
});
