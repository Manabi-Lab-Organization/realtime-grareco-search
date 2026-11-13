import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('../../db/index.js', () => ({ db: {}, pool: {} }));
vi.mock('../emailService.js', () => ({ sendPasswordResetEmail: vi.fn() }));

const { newUserResearchSettings, NEW_USER_RESEARCH_SETTINGS } = await import('../authService.js');

describe('新しい利用者のリアルタイム調査の既定', () => {
  it('設定が無ければ今までどおり ON', () => {
    expect(newUserResearchSettings({} as NodeJS.ProcessEnv)).toEqual(NEW_USER_RESEARCH_SETTINGS);
    expect(newUserResearchSettings({} as NodeJS.ProcessEnv).main).toBe(true);
  });

  it('NEW_USER_RESEARCH_ENABLED=false なら調査だけ OFF で始め、ほかの項目は変えない', () => {
    const s = newUserResearchSettings({ NEW_USER_RESEARCH_ENABLED: 'false' } as NodeJS.ProcessEnv);
    expect(s).toEqual({ ...NEW_USER_RESEARCH_SETTINGS, main: false });
  });

  it('利用者を作る2か所とも、この既定を使う', () => {
    const src = readFileSync(new URL('../authService.ts', import.meta.url), 'utf-8');
    expect(src.match(/researchSettings: newUserResearchSettings\(\),/g)).toHaveLength(2);
    expect(src).not.toMatch(/researchSettings: NEW_USER_RESEARCH_SETTINGS/);
  });
});

describe('会議終了時のグラレコの切り替え', () => {
  for (const rel of ['../../routes/meetings.ts', '../../websocket/socketIO.ts', '../../websocket/nativeWs.ts']) {
    it(`${rel} は管理者の設定に従う`, () => {
      const src = readFileSync(new URL(rel, import.meta.url), 'utf-8');
      expect(src).toContain('!serverFeatures().meetingEndGrareco ? Promise.resolve(undefined) : generateManualGrareco(');
      expect(src).not.toContain('!serverFeatures().grareco ? Promise.resolve(undefined) : generateManualGrareco(');
    });
  }
});
