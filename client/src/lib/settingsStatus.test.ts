import { describe, expect, it } from 'vitest';
import { knownOnOff, settingsStatusText } from './settingsStatus';

describe('設定を読めていないときの表示', () => {
  it('読み込めていれば案内は出さず、ON/OFF をそのまま出す', () => {
    expect(settingsStatusText(true, false)).toBeNull();
    expect(knownOnOff(true, true)).toBe(true);
    expect(knownOnOff(true, false)).toBe(false);
  });
  it('読み込み中は「読み込み中…」、失敗したら「読み込めませんでした」。ON/OFF は出さない', () => {
    expect(settingsStatusText(false, true)).toBe('読み込み中…');
    expect(settingsStatusText(false, false)).toBe('設定を読み込めませんでした');
    expect(knownOnOff(false, true)).toBeNull();
    expect(knownOnOff(false, false)).toBeNull();
  });
});
