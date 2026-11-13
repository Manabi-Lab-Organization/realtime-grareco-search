import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('../../db/index.js', () => ({ db: {}, pool: {} }));
vi.mock('../geminiService.js', () => ({
  analyzeRoomObservation: vi.fn(),
  analyzeRoomObservationMultiView: vi.fn(),
  consolidateMaterials: vi.fn(),
}));
vi.mock('../meetingImageService.js', () => ({ insertSupplementaryText: vi.fn() }));

const { formatCapturedAtJst } = await import('../observationService.js');

describe('環境観察の「いつ」', () => {
  it('取得時刻を日本時間で書く（世界標準時の日付をまたぐときも）', () => {
    expect(formatCapturedAtJst(new Date('2030-01-31T15:04:05Z'))).toBe('2030-02-01 00:04:05（日本時間）');
    expect(formatCapturedAtJst(new Date('2030-06-10T03:00:00Z'))).toBe('2030-06-10 12:00:00（日本時間）');
  });

  it('AI には時刻を渡さず、結果の when はプログラムで入れる', () => {
    const src = readFileSync(new URL('../observationService.ts', import.meta.url), 'utf-8');
    expect(src).toContain('result.fiveW1H.when = capturedAtText;');
    expect(src).not.toMatch(/analyzeRoomObservation(MultiView)?\([^)]*capturedAtText/s);
  });
});

describe('カメラの環境観察の指示', () => {
  const src = readFileSync(new URL('../geminiService.ts', import.meta.url), 'utf-8');
  const tasks = src.slice(src.indexOf('const CAMERA_TASKS_AND_FORMAT'), src.indexOf('function buildCameraSinglePrompt'));

  it('読めない資料の文字を推測で補わせない', () => {
    expect(tasks).toContain('**読めない文字を作らない（最重要）**');
    expect(tasks).toContain('「（判読できない）」と書く');
    expect(tasks).toContain('中身の文字が読めない場合は **materials を null** にする');
  });

  it('when は AI に書かせない', () => {
    expect(tasks).toContain('**when は null にする**');
    expect(tasks).toContain('"when": null');
    expect(tasks).not.toContain('when（時刻）');
    expect(src).not.toContain('who/when/where に反映してください');
  });
});
