import { describe, expect, it } from 'vitest';
import {
  applyThemeGroups,
  assembleSummaryMarkdown,
  findLostLines,
  lastRegularThemeIndex,
  separateSupplementary,
  mergeSummaryParts,
  parseSummaryIntoThemes,
  splitTranscriptIntoWindows,
  windowIndexForElapsed,
} from '../summaryThemes.js';

const SUMMARY = [
  '## 1. 新商品の説明 [00:10-03:00]',
  '・山田さんが試作品を紹介',
  '',
  '## 2. 新商品の価格 [03:05-08:00]',
  '・目標は3000円',
  '・送料は別',
  '',
  '## 3. 共有画面の資料 [08:10] [補足資料]',
  '・資料の要点',
  '<!-- supplementary:img-1 -->',
  '',
  '## 4. 展示会の準備 [08:30-12:00]',
  '・ブースは2小間',
  '',
  '## 5. 展示会当日の流れ [12:10-130:05]',
  '・受付は2名',
  '<!-- consolidated -->',
].join('\n');

const themes = () => parseSummaryIntoThemes(SUMMARY);

describe('applyThemeGroups', () => {
  it('続いた話題をまとめ、箇条書きを順に移し、時間の範囲を広げる', () => {
    const result = applyThemeGroups(themes(), [
      { title: '## 1. 新商品の説明と価格 [00:10-08:00]', themes: [1, 2] },
      { title: '使われない見出し', themes: [3] },
      { title: '展示会の準備と当日の流れ', themes: [4, 5] },
    ]);
    expect(assembleSummaryMarkdown(result!)).toBe(
      [
        '## 1. 新商品の説明と価格 [00:10-08:00]',
        '・山田さんが試作品を紹介',
        '・目標は3000円',
        '・送料は別',
        '',
        '## 2. 共有画面の資料 [08:10] [補足資料]',
        '・資料の要点',
        '<!-- supplementary:img-1 -->',
        '',
        '## 3. 展示会の準備と当日の流れ [08:30-130:05]',
        '・ブースは2小間',
        '・受付は2名',
        '<!-- consolidated -->',
      ].join('\n'),
    );
  });

  it('時間の範囲は分を数として比べる', () => {
    const t = parseSummaryIntoThemes('## 1. a [99:00-100:00]\n・x\n## 2. b [100:30-205:00]\n・y');
    expect(applyThemeGroups(t, [{ title: 'ab', themes: [1, 2] }])![0]).toMatchObject({ timeStart: '99:00', timeEnd: '205:00' });
  });

  it.each([
    ['番号が足りない', [{ title: 'a', themes: [1, 2] }, { title: 'b', themes: [3] }, { title: 'c', themes: [5] }]],
    ['離れた話題をまとめる', [{ title: 'a', themes: [1, 4] }, { title: 'b', themes: [2, 3, 5] }]],
    ['番号が重なる', [{ title: 'a', themes: [1, 2, 2] }, { title: 'b', themes: [3, 4, 5] }]],
    ['補足資料をまとめる', [{ title: 'a', themes: [1, 2, 3] }, { title: 'b', themes: [4, 5] }]],
    ['まとめた見出しが空', [{ title: ' [00:10-08:00]', themes: [1, 2] }, { title: 'b', themes: [3] }, { title: 'c', themes: [4, 5] }]],
    ['空のまとまりがある', [{ title: 'x', themes: [] }, { title: 'a', themes: [1, 2, 3, 4, 5] }]],
  ])('まとめ方が正しくなければ null を返す（%s）', (_label, groups) => {
    expect(applyThemeGroups(themes(), groups)).toBeNull();
  });
});

describe('findLostLines', () => {
  it('並べ替えと見出しの変更だけなら空の配列を返す', () => {
    const merged = assembleSummaryMarkdown(applyThemeGroups(themes(), [
      { title: 'a', themes: [1, 2] }, { title: 'b', themes: [3] }, { title: 'c', themes: [4, 5] },
    ])!);
    expect(findLostLines(SUMMARY, merged)).toEqual([]);
  });

  it('なくなった行を挙げる', () => {
    const truncated = '## 1. 新商品 [00:10-08:00]\n・山田さんが試作品を紹介\n## 2. 共有画面の資料 [08:10] [補足資料]\n・資料の要点\n<!-- supplementary:img-1 -->';
    expect(findLostLines(SUMMARY, truncated)).toEqual(['・目標は3000円', '・送料は別', '・ブースは2小間', '・受付は2名', '<!-- consolidated -->']);
  });

  it('同じ文の行は数で比べる', () => {
    expect(findLostLines('## 1. a [00:00-01:00]\n・賛成\n・賛成', '## 1. a [00:00-01:00]\n・賛成')).toEqual(['・賛成']);
  });
});

describe('splitTranscriptIntoWindows', () => {
  const line = (min: number, chars = 100) => ({ ms: min * 60_000, text: `[${min}:00] ${'あ'.repeat(chars)}` });

  it('一定の時間ごとに区切り、発言の無い区間は作らない', () => {
    const lines = [line(0), line(14), line(15), line(40), line(44)];
    const w = splitTranscriptIntoWindows(lines, 15 * 60_000, 1);
    expect(w.map((x) => x.lines.length)).toEqual([2, 1, 2]);
    expect(w.map((x) => x.startMs)).toEqual([-Infinity, 15 * 60_000, 30 * 60_000]);
  });

  it('短い区間は次の区間に、最後の短い区間は前の区間にまとめる', () => {
    const lines = [line(0, 10), line(16, 300), line(31, 10)];
    const w = splitTranscriptIntoWindows(lines, 15 * 60_000, 200);
    expect(w).toHaveLength(1);
    expect(w[0].lines).toHaveLength(3);
  });

  it('短い会議は 1 つの区間にする', () => {
    expect(splitTranscriptIntoWindows([line(0), line(3)])).toHaveLength(1);
  });

  it('windowIndexForElapsed は経過時間の入る区間を返し、時間が無ければ最初の区間を返す', () => {
    const w = splitTranscriptIntoWindows([line(0), line(20), line(50)], 15 * 60_000, 1);
    expect(windowIndexForElapsed(w, null)).toBe(0);
    expect(windowIndexForElapsed(w, 5 * 60_000)).toBe(0);
    expect(windowIndexForElapsed(w, 16 * 60_000)).toBe(1);
    expect(windowIndexForElapsed(w, 35 * 60_000)).toBe(1);
    expect(windowIndexForElapsed(w, 99 * 60_000)).toBe(2);
  });
});

describe('mergeSummaryParts', () => {
  it('区間ごとの要約をつなぎ、番号を振り直す', () => {
    const merged = mergeSummaryParts([
      '## 1. 開会 [00:00-10:00]\n・あいさつ',
      'まとめは次のとおりです\n\n## 1. 予算 [15:00-20:00]\n・予算を確認\n\n## 2. 日程 [20:00-29:00]\n・日程を確認',
    ]);
    expect(merged).toBe('## 1. 開会 [00:00-10:00]\n・あいさつ\n\n## 2. 予算 [15:00-20:00]\n・予算を確認\n\n## 3. 日程 [20:00-29:00]\n・日程を確認');
  });
});

describe('補足資料の本文の扱い', () => {
  const supplementary = [
    '## 3. 共有画面の資料 [1:20:00] [補足資料]',
    '### 基本情報',
    '- **タイトル**: 第2回',
    '',
    '| 項目 | 内容 |',
    '|---|---|',
    '| 対象 | 小売店 |',
    '- **属性**:',
    '  - 店舗数：3店',
    '<!-- supplementary:image:42 -->',
  ].join('\n');
  const md = ['## 1. 開会 [00:00-10:00]', 'あいさつ', '', supplementary].join('\n');

  it('補足資料の見出し・表・字下げ・空行には「・」を付けない', () => {
    const [normal, supp] = parseSummaryIntoThemes(md);
    expect(normal.bullets).toEqual(['・あいさつ']);
    expect(supp.bullets).toEqual([
      '### 基本情報',
      '- **タイトル**: 第2回',
      '',
      '| 項目 | 内容 |',
      '|---|---|',
      '| 対象 | 小売店 |',
      '- **属性**:',
      '  - 店舗数：3店',
      '<!-- supplementary:image:42 -->',
    ]);
  });

  it('読み取りと組み立てを繰り返しても結果が変わらない', () => {
    const once = assembleSummaryMarkdown(parseSummaryIntoThemes(md));
    const twice = assembleSummaryMarkdown(parseSummaryIntoThemes(once));
    expect(twice).toBe(once);
    expect(once).toContain(supplementary);
  });

  it('補足資料の前後の空行を取り除く', () => {
    const [supp] = parseSummaryIntoThemes('## 1. メモ [05:00] [補足資料]\n\n来週までに見積もりを出す\n\n');
    expect(supp.bullets).toEqual(['来週までに見積もりを出す']);
  });

  it('通常の話題の行には「・」をそろえて付ける', () => {
    const [t] = parseSummaryIntoThemes('## 1. 予算 [00:00-05:00]\n  予算を確認\n・日程を確認');
    expect(t.bullets).toEqual(['・予算を確認', '・日程を確認']);
  });
});

describe('separateSupplementary と lastRegularThemeIndex', () => {
  const md = [
    '## 1. 予算 [00:00-10:00]',
    '・予算を確認',
    '',
    '## 2. 共有画面の資料 [05:00] [補足資料]',
    '### 基本情報',
    '- **見積書**の書き方',
    '<!-- supplementary:image:864 -->',
    '',
    '## 3. 日程 [10:00-20:00]',
    '・日程を確認',
    '',
    '## 4. メモ [21:00] [補足資料]',
    '次回は来週の水曜日',
    '<!-- supplementary:memo:7 -->',
  ].join('\n');

  it('通常の話題と補足資料を分け、補足資料は元の行のまま返す', () => {
    const { regular, supplementary } = separateSupplementary(md);
    expect(regular).toBe('## 1. 予算 [00:00-10:00]\n・予算を確認\n\n## 3. 日程 [10:00-20:00]\n・日程を確認');
    expect(supplementary).toEqual([
      ['## 2. 共有画面の資料 [05:00] [補足資料]', '### 基本情報', '- **見積書**の書き方', '<!-- supplementary:image:864 -->'],
      ['## 4. メモ [21:00] [補足資料]', '次回は来週の水曜日', '<!-- supplementary:memo:7 -->'],
    ]);
  });

  it('最後が補足資料でも、最後の通常の話題の位置を返す', () => {
    const themes = parseSummaryIntoThemes(md);
    expect(themes[themes.length - 1].title).toContain('[補足資料]');
    expect(lastRegularThemeIndex(themes)).toBe(2);
    expect(themes[2].title).toBe('日程');
  });

  it('通常の話題が無ければ -1 を返す', () => {
    expect(lastRegularThemeIndex(parseSummaryIntoThemes('## 1. メモ [01:00] [補足資料]\n来週までに見積もりを出す'))).toBe(-1);
  });
});
