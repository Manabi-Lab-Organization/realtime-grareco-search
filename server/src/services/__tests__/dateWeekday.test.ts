// 日付と曜日の食い違いを「要確認」と書き残す（2026-11-13）。
// 実例：2026-11-13（金）の会議で「次週の土曜日 14時」と決めた（正しくは 11/21（土））のに、
// サマリー・議事録・グラレコに「11/23（土）」「土曜日（11/16想定）」と出た（2024 年の暦で数えたとみられる）。
// 日付と曜日のどちらが誤りかはプログラムでは決められないので、書き換えずに印を付ける。
import { describe, it, expect } from 'vitest';
import {
  markWeekdayMismatches,
  markWeekdayMismatchesDeep,
  inferYear,
  weekdayOf,
  dateContextBlock,
  formatJstDateWithWeekday,
  type WeekdayMismatch,
} from '../dateWeekday.js';

// 2026-11-13（金）14:00 JST の会議
const base = new Date('2026-11-13T05:00:00Z');
const NOTE_MON = '【※日付と曜日が合いません（この日付は月曜日）。日付をご確認ください】';

describe('markWeekdayMismatches：食い違いに印を付け、書き換えない', () => {
  it('今回の会議で出た誤り：日付も曜日も変えず、印を付ける（正しい 11/21 から遠ざけない）', () => {
    const r = markWeekdayMismatches('次回の定例会議は11/23（土）14:00に変更されました。', base);
    expect(r.text).toBe(`次回の定例会議は11/23（土）${NOTE_MON}14:00に変更されました。`);
    expect(r.mismatches).toEqual([{ text: '11/23（土）', correctWeekday: '月' }]);
    expect(markWeekdayMismatches('次回の定例会議を2026年11月23日 (土) 14:00に変更する', base).text).toBe(
      `次回の定例会議を2026年11月23日 (土)${NOTE_MON} 14:00に変更する`,
    );
  });

  it('グラレコ用は短い印', () => {
    expect(markWeekdayMismatches('11/16 (土) までに対応', base, 'short').text).toBe('11/16 (土)【日付要確認】 までに対応');
  });

  it('いろいろな書き方を拾う', () => {
    for (const t of ['11月23日（土曜日）', '11月23日(土曜)', '2026/11/23（土）', '11／23（土）', '11月23日 土曜日', '日程:11/23(土)', '-11/23(土)']) {
      const r = markWeekdayMismatches(t, base);
      expect(r.mismatches).toHaveLength(1);
      expect(r.text.startsWith(t)).toBe(true);
    }
  });

  it('正しい曜日・曜日の無い日付・実在しない日付・日付でない並びには印を付けない', () => {
    for (const t of [
      '11月21日（土）14:00', '11/21(土)', '11月23日 14:00', '2月30日（土）', '会議は 3 日（土）', '11月23日の日曜',
      'https://x/11/16(土)', 'v1.11/16(土)', '1/2/3(土)', 'No.11/23(土)', 'A11/23(土)',
    ]) {
      const r = markWeekdayMismatches(t, base);
      expect(r.text).toBe(t);
      expect(r.mismatches).toEqual([]);
    }
  });

  it('すでに印が付いた箇所には重ねて付けない（サマリーは更新のたびに通す）', () => {
    const once = markWeekdayMismatches('11/23（土）に再会議', base).text;
    expect(markWeekdayMismatches(once, base).text).toBe(once);
    const short = markWeekdayMismatches('11/23（土）に再会議', base, 'short').text;
    expect(markWeekdayMismatches(short, base, 'short').text).toBe(short);
  });

  it('AI が後の工程で印の文言を少し言い換えても、重ねて付けない', () => {
    for (const reworded of [
      '11/23（土）【※日付と曜日が一致しません（月曜）】に再会議',
      '11/23（土）※日付と曜日が一致していません。要確認',
      '11/23（土） 【日付要確認】に再会議',
    ]) {
      expect(markWeekdayMismatches(reworded, base).text).toBe(reworded);
    }
  });

  it('複数あればそれぞれに付ける', () => {
    const r = markWeekdayMismatches('11/16(土)までに対応し、11/21(土)に再会議。12/1(火)は休み', base, 'short');
    expect(r.text).toBe('11/16(土)【日付要確認】までに対応し、11/21(土)に再会議。12/1(火)は休み');
    expect(r.mismatches).toHaveLength(1);
  });

  it('開催日から遠い年なしの日付は、前後の年のどれかで曜日が合えば印を付けない', () => {
    expect(markWeekdayMismatches('3月5日（木）', base).mismatches).toEqual([]);
    expect(markWeekdayMismatches('5月3日（日）', base).mismatches).toEqual([]);
    // どの年とも合わない曜日には付ける（3月5日は 2025=水・2026=木・2027=金）
    expect(markWeekdayMismatches('3月5日（月）', base).mismatches).toEqual([{ text: '3月5日（月）', correctWeekday: '金' }]);
  });

  it('年またぎ：12月の会議の「1月8日」は翌年で検算する', () => {
    const dec = new Date('2026-12-20T05:00:00Z');
    expect(inferYear(1, 8, dec)).toBe(2027);
    expect(markWeekdayMismatches('1月8日（金）', dec).mismatches).toEqual([]); // 2027-01-08 は金曜
    expect(markWeekdayMismatches('1月8日（木）', dec).mismatches).toHaveLength(1);
  });

  it('年が書いてあればその年で検算する', () => {
    expect(markWeekdayMismatches('2027年11月23日（火）', base).mismatches).toEqual([]);
    expect(markWeekdayMismatches('2027年11月23日（月）', base).mismatches).toHaveLength(1);
  });
});

describe('markWeekdayMismatchesDeep', () => {
  it('グラレコの下書きのような入れ子の文字列すべてに付ける（文字列以外は触らない）', () => {
    const found: WeekdayMismatch[] = [];
    const out = markWeekdayMismatchesDeep(
      { title: 'x', sections: [{ bullets: ['11/16 (土) までに', 'なし'] }], n: 3, ok: true },
      base,
      'short',
      found,
    );
    expect(out).toEqual({ title: 'x', sections: [{ bullets: ['11/16 (土)【日付要確認】 までに', 'なし'] }], n: 3, ok: true });
    expect(found).toHaveLength(1);
  });
});

describe('暦と開催日', () => {
  it('weekdayOf / 開催日の表記（日本時間）', () => {
    expect(weekdayOf(2026, 11, 21)).toBe('土');
    expect(weekdayOf(2026, 11, 23)).toBe('月');
    expect(weekdayOf(2026, 2, 29)).toBeNull();
    expect(formatJstDateWithWeekday(new Date('2026-11-12T16:00:00Z'))).toBe('2026年11月13日（金）'); // UTC では12日
  });

  it('暦に開催日・今年の年・その後の土曜日が正しく入る（「次週の土曜日」を 11/21 と数えられる）', () => {
    const block = dateContextBlock(base);
    expect(block).toContain('【開催日】2026年11月13日（金）');
    expect(block).toContain('今年は 2026 年');
    expect(block).toContain('11/14(土)');
    expect(block).toContain('11/21(土)');
    expect(block).toContain('11/23(月)');
    expect(block).toContain('2027/1/1(金)');
  });
});

describe('サマリー・議事録を作る AI に開催日と暦を渡している（今回の根本原因）', () => {
  it('サマリー（初回・差分・作り直しの共通の入口）と議事録の指示文に暦が入る', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');
    const here = path.dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(path.resolve(here, '../geminiService.ts'), 'utf-8');
    expect(src).toContain('const participantInfo = `\\n${dateContextBlock(baseDate)}\\n${buildParticipantInfo(participants)}`;');
    expect(src).toContain('generateStructuredSummaryRaw(newTranscripts, previousSummary, participants, supplementaryContext, base)');
    expect(src).toContain('${dateContextBlock(baseDate)}\n${participantInfo}');
    expect(src).not.toMatch(/fixWeekdays/);
    // 「AI分析 → 議事録」・アシスタントの「議事録を生成して」は analyzeTranscript を通る（会議終了時の議事録とは別経路）
    const analyze = src.slice(src.indexOf('export async function analyzeTranscript'), src.indexOf('// ─── Summary', src.indexOf('export async function analyzeTranscript')) > 0 ? src.indexOf('// ─── Summary', src.indexOf('export async function analyzeTranscript')) : undefined);
    expect(analyze).toContain('let fullText = `${dateContextBlock(baseDate)}\\n\\n`;');
    expect(analyze).toContain("markWeekdayMismatches(response.text || '分析結果を取得できませんでした。', baseDate)");
  });
});
