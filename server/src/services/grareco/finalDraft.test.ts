import { describe, it, expect, vi, beforeEach } from 'vitest';

const generateContent = vi.fn();
process.env.GEMINI_API_KEY ||= 'test-key';

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent };
  },
}));

const rebuildStructuredSummary = vi.fn();
const consolidateSummaryThemes = vi.fn(async (s: string) => s);
vi.mock('../geminiService.js', () => ({
  rebuildStructuredSummary: (...a: unknown[]) => rebuildStructuredSummary(...a),
  consolidateSummaryThemes: (...a: [string]) => consolidateSummaryThemes(...a),
  generateStructuredSummary: vi.fn(),
}));

import {
  buildFinalDraftText,
  buildGrarecoDraft,
  bulletsPerSection,
  condenseThemes,
  extractTimedTranscript,
  fitThemesToSpace,
  formatMeetingDate,
  kindFromMeetingType,
  MAX_DRAWABLE_SECTIONS,
  needsFitting,
  normalizeKeyItems,
  splitTextIntoChunks,
  stripJsonFence,
  summarizePastedContent,
  themesFromSummary,
  type FinalDraft,
} from './finalDraft.js';
import type { SummaryTheme } from '../summaryThemes.js';

function summaryWith(n: number): string {
  return Array.from({ length: n }, (_, i) => {
    const m = String(i * 5).padStart(2, '0');
    return `## ${i + 1}. 議題${i + 1} [${m}:00-${m}:59]\n・項目${i + 1}-a\n・項目${i + 1}-b`;
  }).join('\n\n');
}

function themes(n: number): SummaryTheme[] {
  return themesFromSummary(summaryWith(n));
}

function replyJson(...objs: unknown[]) {
  for (const o of objs) generateContent.mockResolvedValueOnce({ text: JSON.stringify(o) });
}

function condenseReplyFor(n: number) {
  return { sections: Array.from({ length: n }, (_, i) => ({ no: i + 1, icon: '📌', bullets: [`短くした項目${i + 1}`] })) };
}

const keyReply = {
  title: '新商品の企画会議',
  coreTheme: '発売までに何を決めるか',
  decisions: ['次回は来週の木曜日にオンラインで行う'],
  actionItems: [{ text: '見積書を送る', owner: '山田', due: '来週の月曜日' }],
  highlights: [{ text: '価格はまだ決まっていない', kind: 'question' }],
};

beforeEach(() => {
  generateContent.mockReset();
  rebuildStructuredSummary.mockReset();
  consolidateSummaryThemes.mockClear();
});

describe('要約の話題から枠を作る', () => {
  it('補足資料の節は枠にしない', () => {
    const s = `${summaryWith(2)}\n\n## 3. 共有画面の資料 [補足資料]\n会場の見取り図\n<!-- supplementary:image:1 -->`;
    const t = themesFromSummary(s);
    expect(t.map((x) => x.title)).toEqual(['議題1', '議題2']);
  });

  it('枠の数を要約の話題の数に合わせる', async () => {
    for (const n of [1, 5, 22]) {
      generateContent.mockReset();
      generateContent.mockImplementation(async ({ contents }: any) => {
        const prompt: string = contents[0].parts[0].text;
        return { text: JSON.stringify(prompt.includes('話題ごとに要点') ? condenseReplyFor(n) : keyReply) };
      });
      const d = await buildGrarecoDraft({ summary: summaryWith(n), material: '発言の全文' });
      expect(d.sections).toHaveLength(n);
      expect(buildFinalDraftText(d)).toContain(`過不足なく ${n} 枠を描く`);
    }
  });

  it('要約が渡されたときは要約を作り直さない', async () => {
    generateContent.mockImplementation(async ({ contents }: any) => {
      const prompt: string = contents[0].parts[0].text;
      return { text: JSON.stringify(prompt.includes('話題ごとに要点') ? condenseReplyFor(3) : keyReply) };
    });
    await buildGrarecoDraft({ summary: summaryWith(3), pasted: '[00:00:01] 山田: それでは始めます', material: '発言の全文' });
    expect(rebuildStructuredSummary).not.toHaveBeenCalled();
  });
});

describe('fitThemesToSpace', () => {
  it('上限は 30 枠で、30 以下ならまとめない', async () => {
    expect(MAX_DRAWABLE_SECTIONS).toBe(30);
    for (const n of [1, 12, 30]) expect(needsFitting(n)).toBe(false);
    expect(needsFitting(31)).toBe(true);
    const t = themes(30);
    expect(await fitThemesToSpace(t)).toBe(t);
    expect(generateContent).not.toHaveBeenCalled();
  });

  it('30 を超えたら対応表に従ってまとめ、項目は 1 行も減らさない', async () => {
    const t = themes(40);
    const groups = [
      ...Array.from({ length: 10 }, (_, i) => ({ title: `まとめ${i + 1}`, themes: [i * 2 + 1, i * 2 + 2] })),
      ...Array.from({ length: 20 }, (_, i) => ({ title: '', themes: [21 + i] })),
    ];
    replyJson({ groups });
    const out = await fitThemesToSpace(t);
    expect(out).toHaveLength(30);
    const before = t.flatMap((x) => x.bullets).sort();
    const after = out.flatMap((x) => x.bullets).sort();
    expect(after).toEqual(before);
  });

  it('対応表に番号の抜けがあれば例外を投げる', async () => {
    replyJson({ groups: [{ title: 'x', themes: [1, 2] }] });
    await expect(fitThemesToSpace(themes(31))).rejects.toThrow();
  });
});

describe('出力の形式', () => {
  it('すべての呼び出しで JSON の形式とスキーマを指定する', async () => {
    generateContent.mockImplementation(async ({ contents }: any) => {
      const prompt: string = contents[0].parts[0].text;
      if (prompt.includes('束ねて')) {
        return { text: JSON.stringify({ groups: Array.from({ length: 30 }, (_, i) => ({ title: i === 0 ? 'まとめ' : '', themes: i === 0 ? [1, 2] : [i + 2] })) }) };
      }
      return { text: JSON.stringify(prompt.includes('話題ごとに要点') ? condenseReplyFor(30) : keyReply) };
    });
    await buildGrarecoDraft({ summary: summaryWith(31), material: '発言の全文' });
    expect(generateContent).toHaveBeenCalledTimes(3);
    for (const [req] of generateContent.mock.calls as any[]) {
      expect(req.config.responseMimeType).toBe('application/json');
      expect(req.config.responseSchema?.type).toBe('OBJECT');
    }
  });

  it('JSON として読めないときは、止まった理由と長さをエラーに含め、出力の中身は含めない', async () => {
    generateContent.mockResolvedValueOnce({ text: '{"sections":[]}\n}', candidates: [{ finishReason: 'STOP' }] });
    const err = await condenseThemes(themes(1)).catch((e: Error) => e);
    expect(String((err as Error).message)).toMatch(/finish=STOP \d+字/);
    expect(String((err as Error).message)).not.toContain('sections');
  });
});

describe('condenseThemes と bulletsPerSection', () => {
  it('枠が多いほど 1 枠あたりの行数を減らす', () => {
    expect(bulletsPerSection(5)).toBe(4);
    expect(bulletsPerSection(16)).toBe(3);
    expect(bulletsPerSection(30)).toBe(2);
  });

  it('返事で抜けた話題は要約の項目で補い、数と順番を保つ', async () => {
    replyJson({ sections: [{ no: 2, icon: '🎯', bullets: ['短くした項目2', '短くした項目2b', '短くした項目2c', '短くした項目2d', '短くした項目2e'] }] });
    const out = await condenseThemes(themes(3));
    expect(out.map((s) => s.heading)).toEqual(['議題1', '議題2', '議題3']);
    expect(out[0].bullets).toEqual(['項目1-a', '項目1-b']);
    expect(out[1].bullets).toHaveLength(4);
    expect(out[1].time).toBe('05:00-05:59');
  });
});

describe('貼り付けた文からの要約', () => {
  it('時・分・秒と分・秒の両方の時刻表記を読み取る', () => {
    const lines = extractTimedTranscript('【サマリー】\n## 1. x [00:00-01:00]\n・y\n[01:02:03] 山田: はい\n[75:10] 鈴木: いいえ');
    expect(lines).toEqual([
      { ms: 3723_000, text: '[01:02:03] 山田: はい' },
      { ms: 4510_000, text: '[75:10] 鈴木: いいえ' },
    ]);
  });

  it('時刻付きの発言があれば一定の時間ごとに要約し、貼り付けた要約は使わない', async () => {
    rebuildStructuredSummary.mockResolvedValue(summaryWith(2));
    const body = Array.from({ length: 45 }, (_, i) => `[00:${String(i).padStart(2, '0')}:00] 山田: ${'あ'.repeat(100)}`).join('\n');
    await summarizePastedContent(`【サマリー】\n貼り付けた要約の文\n\n【文字起こし（全体）】\n${body}`);
    const windows = rebuildStructuredSummary.mock.calls[0][0] as Array<{ transcript: string }>;
    expect(windows.length).toBe(3);
    expect(windows.map((w) => w.transcript).join('\n')).not.toContain('貼り付けた要約の文');
    expect(consolidateSummaryThemes).toHaveBeenCalledOnce();
  });

  it('時刻が無ければ文を区切って要約する', async () => {
    rebuildStructuredSummary.mockResolvedValue(summaryWith(1));
    const text = Array.from({ length: 5 }, () => 'い'.repeat(2500)).join('\n\n');
    await summarizePastedContent(text);
    const windows = rebuildStructuredSummary.mock.calls[0][0] as Array<{ transcript: string }>;
    expect(windows.length).toBe(3);
    expect(windows.map((w) => w.transcript).join('\n\n')).toBe(text);
  });

  it('段落の切れ目で区切り、文を減らさない', () => {
    const text = 'a\n\nb\n\nc';
    expect(splitTextIntoChunks(text, 1)).toEqual(['a', 'b', 'c']);
    expect(splitTextIntoChunks(text, 100)).toEqual([text]);
  });
});

describe('決まったことと宿題', () => {
  it('開催日と全文を専用の呼び出しに渡す', async () => {
    generateContent.mockImplementation(async ({ contents }: any) => {
      const prompt: string = contents[0].parts[0].text;
      return { text: JSON.stringify(prompt.includes('話題ごとに要点') ? condenseReplyFor(2) : keyReply) };
    });
    const d = await buildGrarecoDraft({ summary: summaryWith(2), material: '発言の最後に決まったこと', meetingDate: '2001年3月3日（土）' });
    const keyPrompt = generateContent.mock.calls
      .map((c: any) => c[0].contents[0].parts[0].text as string)
      .find((p) => p.includes('この場の成果'))!;
    expect(keyPrompt).toContain('2001年3月3日（土）');
    expect(keyPrompt).toContain('発言の最後に決まったこと');
    expect(d.decisions).toEqual(keyReply.decisions);
    expect(buildFinalDraftText(d)).toContain('□ 山田：見積書を送る（来週の月曜日）');
  });

  it('足りない項目は既定値で補い、宿題は文字列でもオブジェクトでも受け付ける', () => {
    const k = normalizeKeyItems({ actionItems: ['A', { text: 'B', owner: '佐藤' }, {}], highlights: [{ text: 'h', kind: 'zzz' }] });
    expect(k.title).toBe('会議の要点まとめ');
    expect(k.decisions).toEqual([]);
    expect(k.actionItems).toEqual([{ text: 'A' }, { text: 'B', owner: '佐藤', due: undefined }]);
    expect(k.highlights).toEqual([{ text: 'h', kind: 'insight' }]);
  });

  it('囲み付きの JSON から中身を取り出す', () => {
    expect(stripJsonFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });
});

describe('buildFinalDraftText', () => {
  const draft: FinalDraft = {
    kind: 'meeting',
    keyPoints: [],
    title: '新商品の企画会議の要点',
    coreTheme: '発売の時期をいつにするか',
    sections: [
      { icon: '🎯', heading: '発売時期の確認', time: '00:00-05:00', bullets: ['候補の月を二つに絞った'] },
      { icon: '📊', heading: '予算の確認', bullets: ['予算は前回と同じ'] },
      { icon: '🔍', heading: '課題の整理', bullets: ['試作品の数が足りない'] },
    ],
    decisions: ['来月に試作品を見直す'],
    actionItems: [{ text: '議事メモを配る', owner: '山田', due: '今週中' }],
    highlights: [{ text: '試作品の数を増やすと進みそう', kind: 'insight' }],
  };
  const text = buildFinalDraftText(draft);

  it('枠の数を話題の数に合わせて書く', () => {
    expect(text).toContain('下の論点は全部で 3 個ある');
    expect(text).toContain('1 から 3 まで連番');
  });

  it('「整理の軸」を含めない', () => {
    expect(text).not.toContain('整理の軸');
  });

  it('重複と抜けを禁じ、決まったことと宿題を省かないよう書く', () => {
    expect(text).toContain('同じ見出しを2回描かない');
    expect(text).toContain('一項目も省略しない');
    expect(text).toContain('◎ 来月に試作品を見直す');
    expect(text).toContain('発売時期の確認 [00:00-05:00]');
  });
});

describe('会議と学びの場の書き分け', () => {
  const sections = [{ icon: '📘', heading: '報告の基本', bullets: ['x'] }];

  it('training の種類では下の欄を要点・まとめ・気付きにし、決定事項の欄を作らない', () => {
    const t = buildFinalDraftText({
      kind: 'training',
      title: '新人向けの勉強会',
      coreTheme: '伝わる報告の仕方',
      sections,
      decisions: [],
      keyPoints: ['報告は結論から先に伝える'],
      actionItems: [{ text: '明日の朝会で結論から報告してみる' }],
      highlights: [{ text: '短く伝えると質問が増える', kind: 'insight' }],
    });
    expect(t).toContain('【この研修の核心】伝わる報告の仕方');
    expect(t).toContain('【要点（学んだこと）】\n◆ 報告は結論から先に伝える');
    expect(t).toContain('【まとめ（持ち帰って実践すること）】\n□ 明日の朝会で結論から報告してみる');
    expect(t).toContain('【気付き】');
    expect(t).not.toContain('決定事項');
    expect(t).not.toContain('アクションアイテム');
    expect(t).toContain('挙げていない欄（見出しだけの空欄を含む）は作らない');
  });

  it('training の種類でも決まったことがあれば「決まったこと」の欄に書く', () => {
    const t = buildFinalDraftText({ kind: 'training', title: 't', sections, decisions: ['次回は来月の第1月曜日'], keyPoints: [], actionItems: [], highlights: [] });
    expect(t).toContain('【決まったこと】\n◎ 次回は来月の第1月曜日');
  });

  it('会議では決定事項・宿題・重要ポイントの欄を書く', () => {
    const t = buildFinalDraftText({ kind: 'meeting', title: 't', coreTheme: 'c', sections, decisions: ['d'], keyPoints: [], actionItems: [{ text: 'a' }], highlights: [{ text: 'h', kind: 'risk' }] });
    expect(t).toContain('【決定事項】【アクションアイテム（宿題）】【重要ポイント】は、論点の枠とは別に下部へ');
    expect(t).toContain('【この会議の核心】');
  });

  it('下の欄に書く内容が無ければまとめの欄を作らない', () => {
    const t = buildFinalDraftText({ kind: 'meeting', title: 't', sections, decisions: [], keyPoints: [], actionItems: [], highlights: [] });
    expect(t).toContain('下部にまとめの欄は作らない');
  });

  it('会議の種類から meeting か training かを決め、決められない種類には undefined を返す', () => {
    expect(kindFromMeetingType('training')).toBe('training');
    expect(kindFromMeetingType('seminar')).toBe('training');
    expect(kindFromMeetingType('executive')).toBe('meeting');
    expect(kindFromMeetingType('general')).toBeUndefined();
    expect(kindFromMeetingType(null)).toBeUndefined();
  });

  it('指定した種類を返事より優先し、会議では学んだ要点を空にする', () => {
    expect(normalizeKeyItems({ kind: 'meeting', keyPoints: ['k'] }, 'training')).toMatchObject({ kind: 'training', keyPoints: ['k'] });
    expect(normalizeKeyItems({ kind: 'training', keyPoints: ['k'] }, 'meeting')).toMatchObject({ kind: 'meeting', keyPoints: [] });
    expect(normalizeKeyItems({ kind: 'training', keyPoints: ['k'] })).toMatchObject({ kind: 'training', keyPoints: ['k'], title: '研修の要点まとめ' });
  });

  it('種類の指定があれば指示文で固定し、無ければ内容から決めるよう書く', async () => {
    generateContent.mockImplementation(async ({ contents }: any) => {
      const prompt: string = contents[0].parts[0].text;
      return { text: JSON.stringify(prompt.includes('話題ごとに要点') ? condenseReplyFor(1) : { ...keyReply, kind: 'training' }) };
    });
    const fixed = await buildGrarecoDraft({ summary: summaryWith(1), material: '発言の全文', meetingType: 'executive' });
    expect(fixed.kind).toBe('meeting');
    const prompts = () => generateContent.mock.calls.map((c: any) => c[0].contents[0].parts[0].text as string).filter((p) => p.includes('この場の成果'));
    expect(prompts()[0]).toContain('kind は "meeting" とすること');
    generateContent.mockClear();
    const judged = await buildGrarecoDraft({ summary: summaryWith(1), material: '発言の全文', meetingType: 'general' });
    expect(judged.kind).toBe('training');
    expect(prompts()[0]).toContain('内容から判断し');
  });
});

describe('formatMeetingDate', () => {
  it('日本時間の日付と曜日で書く', () => {
    expect(formatMeetingDate(new Date('2001-03-02T23:30:00Z'))).toBe('2001年3月3日（土）');
  });
});
