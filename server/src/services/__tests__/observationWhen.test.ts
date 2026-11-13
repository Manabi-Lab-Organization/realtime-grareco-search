import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

const state = vi.hoisted(() => ({ inserted: [] as Record<string, unknown>[] }));

vi.mock('../../db/index.js', () => {
  const make = (): unknown => {
    const chain: unknown = new Proxy(function () {}, {
      get: (_t, prop) => {
        if (prop === 'then') return (resolve: (rows: unknown[]) => void) => resolve([]);
        if (prop === 'values') return (v: Record<string, unknown>) => {
          state.inserted.push(v);
          return { returning: async () => [{ id: 1, ...v }] };
        };
        return () => chain;
      },
      apply: () => chain,
    });
    return chain;
  };
  return { db: make(), pool: {} };
});

const gemini = vi.hoisted(() => ({
  analyzeRoomObservation: vi.fn(),
  analyzeRoomObservationMultiView: vi.fn(),
  consolidateMaterials: vi.fn(),
}));
vi.mock('../geminiService.js', () => gemini);
vi.mock('../meetingImageService.js', () => ({ insertSupplementaryText: vi.fn() }));

const { formatCapturedAtJst, processObservation } = await import('../observationService.js');

beforeEach(() => {
  state.inserted = [];
  gemini.analyzeRoomObservation.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('環境観察の「いつ」', () => {
  it('取得時刻を日本時間で書く（世界標準時の日付をまたぐときも）', () => {
    expect(formatCapturedAtJst(new Date('2030-01-31T15:04:05Z'))).toBe('2030-02-01 00:04:05（日本時間）');
    expect(formatCapturedAtJst(new Date('2030-06-10T03:00:00Z'))).toBe('2030-06-10 12:00:00（日本時間）');
  });

  for (const sourceType of ['camera', 'window'] as const) {
    it(`${sourceType}: AI には時刻を渡さず、AI が書いた when はプログラムの日本時間で置き換える`, async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2030-01-31T15:04:05Z'));
      try {
        gemini.analyzeRoomObservation.mockResolvedValue({
          peopleCount: 2,
          fiveW1H: { when: '2024-01-01 09:00（AI の推測）', where: '会議室', who: null, what: null, why: null, how: null },
          people: [],
          rawSummary: 'x',
          materials: null,
        });
        await processObservation(1, null, { data: 'bm90LWFuLWltYWdl', mimeType: 'image/jpeg', sourceType });
        const ctx = gemini.analyzeRoomObservation.mock.calls[0][2];
        expect(ctx).not.toHaveProperty('capturedAtText');
        const saved = state.inserted[0].fiveW1h as Record<string, unknown>;
        expect(saved.when).toBe('2030-02-01 00:04:05（日本時間）');
        expect(saved.where).toBe('会議室');
      } finally {
        vi.useRealTimers();
      }
    });
  }
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
