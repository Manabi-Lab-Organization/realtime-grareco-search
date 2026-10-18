
import type { GoogleGenAI } from '@google/genai';
import { createGenAI } from '../llm/genaiClient.js';
import { auditGeminiCall } from '../audit/audit.js';
import {
  consolidateSummaryThemes,
  generateStructuredSummary,
  rebuildStructuredSummary,
} from '../geminiService.js';
import {
  applyThemeGroups,
  parseSummaryIntoThemes,
  renumberThemes,
  separateSupplementary,
  splitTranscriptIntoWindows,
  type SummaryTheme,
  type ThemeGroup,
  type TimedLine,
} from '../summaryThemes.js';

export interface FinalDraftSection {
  icon: string;
  heading: string;
  time?: string;
  bullets: string[];
}

export interface FinalDraftActionItem {
  text: string;
  owner?: string;
  due?: string;
}

export type DraftKind = 'meeting' | 'training';

export interface FinalDraft {
  kind: DraftKind;
  title: string;
  coreTheme?: string;
  sections: FinalDraftSection[];
  decisions: string[];
  keyPoints: string[];
  actionItems: FinalDraftActionItem[];
  highlights: Array<{ text: string; kind: 'insight' | 'risk' | 'question' }>;
}

export function kindFromMeetingType(meetingType?: string | null): DraftKind | undefined {
  if (meetingType === 'training' || meetingType === 'seminar') return 'training';
  if (meetingType === 'executive' || meetingType === 'technical' || meetingType === 'one_on_one') return 'meeting';
  return undefined;
}

export const MAX_DRAWABLE_SECTIONS = 30;

export const PASTED_CHUNK_CHARS = 6_000;

const TEXT_MODEL = 'gemini-3-flash-preview';

let client: GoogleGenAI | null = null;
function genai(): GoogleGenAI {
  if (!client) client = createGenAI();
  return client;
}

export function stripJsonFence(raw: string): string {
  return raw
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
}

const STR = { type: 'STRING' } as const;
const STR_LIST = { type: 'ARRAY', items: STR } as const;

const GROUPS_SCHEMA = {
  type: 'OBJECT',
  properties: {
    groups: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { title: STR, themes: { type: 'ARRAY', items: { type: 'INTEGER' } } },
        required: ['title', 'themes'],
        propertyOrdering: ['title', 'themes'],
      },
    },
  },
  required: ['groups'],
};

const KEY_ITEMS_SCHEMA = {
  type: 'OBJECT',
  properties: {
    kind: { type: 'STRING', enum: ['meeting', 'training'] },
    title: STR,
    coreTheme: STR,
    decisions: STR_LIST,
    keyPoints: STR_LIST,
    actionItems: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { text: STR, owner: STR, due: STR },
        required: ['text'],
        propertyOrdering: ['text', 'owner', 'due'],
      },
    },
    highlights: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { text: STR, kind: { type: 'STRING', enum: ['insight', 'risk', 'question'] } },
        required: ['text', 'kind'],
        propertyOrdering: ['text', 'kind'],
      },
    },
  },
  required: ['kind', 'title', 'coreTheme', 'decisions', 'keyPoints', 'actionItems', 'highlights'],
  propertyOrdering: ['kind', 'title', 'coreTheme', 'decisions', 'keyPoints', 'actionItems', 'highlights'],
};

const SECTIONS_SCHEMA = {
  type: 'OBJECT',
  properties: {
    sections: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { no: { type: 'INTEGER' }, icon: STR, bullets: STR_LIST },
        required: ['no', 'icon', 'bullets'],
        propertyOrdering: ['no', 'icon', 'bullets'],
      },
    },
  },
  required: ['sections'],
};

async function callJson(prompt: string, label: string, responseSchema: object): Promise<any> {
  const res = await genai().models.generateContent({
    model: TEXT_MODEL,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    config: { responseMimeType: 'application/json', responseSchema, maxOutputTokens: 32000 },
  });
  auditGeminiCall(`gemini:grarecoFinalDraft:${label}`, TEXT_MODEL, res);
  const raw = stripJsonFence((res as any).text || '');
  try {
    return JSON.parse(raw);
  } catch {
    const finish = (res as any).candidates?.[0]?.finishReason;
    throw new Error(`${label} の JSON を解釈できませんでした（finish=${finish} ${raw.length}字）`);
  }
}

export function extractTimedTranscript(text: string): TimedLine[] {
  const out: TimedLine[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*\[(\d{1,3}):(\d{2})(?::(\d{2}))?\]\s*(.*)$/);
    if (!m) continue;
    const sec = m[3] !== undefined ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : Number(m[1]) * 60 + Number(m[2]);
    out.push({ ms: sec * 1000, text: line.trim() });
  }
  return out;
}

export function splitTextIntoChunks(text: string, chunkChars = PASTED_CHUNK_CHARS): string[] {
  const paragraphs = text.split(/\n{2,}/);
  const chunks: string[] = [];
  let cur = '';
  for (const p of paragraphs) {
    if (cur && cur.length + p.length > chunkChars) {
      chunks.push(cur);
      cur = '';
    }
    cur = cur ? `${cur}\n\n${p}` : p;
  }
  if (cur.trim()) chunks.push(cur);
  return chunks;
}

export type Participants = Parameters<typeof generateStructuredSummary>[2];

export async function summarizePastedContent(pasted: string, participants?: Participants): Promise<string> {
  const timed = extractTimedTranscript(pasted);
  let merged: string;
  if (timed.length > 0) {
    const windows = splitTranscriptIntoWindows(timed);
    merged = await rebuildStructuredSummary(windows.map((w) => ({ transcript: w.lines.join('\n') })), participants);
    console.log(`[Grareco-Draft] 貼られた文字起こし ${timed.length}行を ${windows.length}区間で要約`);
  } else {
    const chunks = splitTextIntoChunks(pasted);
    merged = await rebuildStructuredSummary(chunks.map((c) => ({ transcript: c })), participants);
    console.log(`[Grareco-Draft] 貼られた文面 ${pasted.length}字を ${chunks.length}区切りで要約`);
  }
  return consolidateSummaryThemes(merged, participants);
}

export function themesFromSummary(summary: string): SummaryTheme[] {
  return renumberThemes(parseSummaryIntoThemes(separateSupplementary(summary).regular));
}

export function needsFitting(count: number): boolean {
  return count > MAX_DRAWABLE_SECTIONS;
}

export async function fitThemesToSpace(themes: SummaryTheme[]): Promise<SummaryTheme[]> {
  let current = themes;
  for (let attempt = 1; attempt <= 2 && needsFitting(current.length); attempt++) {
    const list = current
      .map((t) => `${t.index}. ${t.title}${t.hasTimeRange ? ` [${t.timeStart}-${t.timeEnd}]` : ''}`)
      .join('\n');
    const parsed = await callJson(
      `次は会議の話題の一覧です（全${current.length}件、時間順）。1枚のグラフィックレコーディングに描ける枠は最大${MAX_DRAWABLE_SECTIONS}個です。
近い議題どうしを束ねて、グループを${MAX_DRAWABLE_SECTIONS}個以下にしてください。

ルール:
- 束ねてよいのは番号が連続する話題だけ。1番から${current.length}番までのすべての番号を、ちょうど1回ずつ、小さい順にどこかのグループへ入れる
- できるだけ議題の近いものから束ねる。明確に異なる議題は、上限を守れる範囲で分けたままにする
- 2件以上を束ねたグループには、束ねた内容を表す見出し（title）を付ける。番号や時間は付けない
- 話題の中身は出力しない（移し替えはシステムが行う）

出力は JSON 一つだけ: {"groups":[{"title": string, "themes": number[]}]}

話題の一覧:
${list}`,
      'スペースに収める束ね方',
      GROUPS_SCHEMA,
    );
    const groups: ThemeGroup[] = Array.isArray(parsed?.groups) ? parsed.groups : [];
    const applied = applyThemeGroups(current, groups);
    if (!applied) throw new Error('スペースに収める束ね方が不正でした（番号の漏れ・重複・順序の乱れ）');
    console.log(`[Grareco-Draft] スペースに収めるため ${current.length}件 → ${applied.length}件に束ねた`);
    current = applied;
  }
  if (needsFitting(current.length)) {
    throw new Error(`話題が ${current.length} 件のままで、1枚に描ける上限（${MAX_DRAWABLE_SECTIONS}）を超えています`);
  }
  return current;
}

export interface KeyItems {
  kind: DraftKind;
  title: string;
  coreTheme?: string;
  decisions: string[];
  keyPoints: string[];
  actionItems: FinalDraftActionItem[];
  highlights: FinalDraft['highlights'];
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((d): d is string => typeof d === 'string' && !!d) : []);

export function normalizeKeyItems(parsed: unknown, fixedKind?: DraftKind): KeyItems {
  const o = (parsed ?? {}) as Record<string, any>;
  const kinds = new Set(['insight', 'risk', 'question']);
  const kind: DraftKind = fixedKind ?? (o.kind === 'training' ? 'training' : 'meeting');
  return {
    kind,
    title: typeof o.title === 'string' && o.title ? o.title : kind === 'training' ? '研修の要点まとめ' : '会議の要点まとめ',
    coreTheme: typeof o.coreTheme === 'string' && o.coreTheme ? o.coreTheme : undefined,
    decisions: strings(o.decisions),
    keyPoints: kind === 'training' ? strings(o.keyPoints) : [],
    actionItems: Array.isArray(o.actionItems)
      ? o.actionItems.flatMap((a: any): FinalDraftActionItem[] => {
          if (typeof a === 'string' && a) return [{ text: a }];
          if (a && typeof a.text === 'string' && a.text) {
            return [{
              text: a.text,
              owner: typeof a.owner === 'string' && a.owner ? a.owner : undefined,
              due: typeof a.due === 'string' && a.due ? a.due : undefined,
            }];
          }
          return [];
        })
      : [],
    highlights: Array.isArray(o.highlights)
      ? o.highlights
          .filter((h: any) => h && typeof h.text === 'string' && h.text)
          .map((h: any) => ({ text: h.text, kind: kinds.has(h.kind) ? h.kind : 'insight' }))
      : [],
  };
}

export async function extractKeyItems(material: string, meetingDate?: string, fixedKind?: DraftKind): Promise<KeyItems> {
  const kindLine = fixedKind
    ? `この場は **${fixedKind === 'training' ? '研修（講義・セミナー・ワークショップ）' : '会議'}** です。kind は "${fixedKind}" とすること。`
    : `まず、この場が **会議**（参加者が議論し、何かを決めたり分担したりする場）か、**研修**（講師が教え、受講者が学ぶ場。講義・セミナー・ワークショップを含む）かを内容から判断し、kind に "meeting" か "training" を入れること。`;
  const parsed = await callJson(
    `次は会議・研修などの素材です（サマリー・文字起こし・補足資料など）。**最後まで読み**、この場の成果を抜き出してください。
結論や次回の予定・宿題は終盤に出ることが多いので、終盤を読み落とさないこと。
${meetingDate ? `\n開催日は ${meetingDate} です。「10日」「再来週の月曜」のような相対表現は、この日を基準に絶対日付へ直してください。\n` : ''}
${kindLine}

出力は JSON 一つだけ:
{
  "kind": "meeting" | "training",
  "title": string,        // 内容を表す題（15〜30字）
  "coreTheme": string,    // この場は結局何だったのかを一文で
  "decisions": string[],
  "keyPoints": string[],
  "actionItems": [{ "text": string, "owner"?: string, "due"?: string }],
  "highlights": [{ "text": string, "kind": "insight" | "risk" | "question" }]
}

各欄の中身:
- decisions：参加者が合意して**決まったこと**（方針・日程・分担・金額・手段など）。日時・金額・担当・手段が伴うならそのまま残す。
  講義で教えた内容や、進行上の案内（休憩・開始時刻・資料の配り方など）は決定ではない。研修では、実際に決まったこと（次回の日程など）が無ければ空配列にする
- keyPoints：研修のときだけ。受講者が**学んだ要点**（考え方・手法・コツ）。会議では空配列にする
- actionItems：会議では**宿題**（誰が何をするか）。研修では**持ち帰って実践すること**（講師が出した宿題・受講者が決めた行動）
- highlights：気付き・リスク・未決の問い。上の欄と重ねない

守ること:
- 素材が「決定事項」「宿題」「アクションアイテム」と明示している項目は、改変せずに採る
- 担当（owner）・期限（due）は素材に書かれているものだけ。推測で埋めない
- 素材に無い欄は空配列でよい。無理に埋めない。あるものは落とさない
- 素材に書かれていない事実を創作しない。日本語で書く

--- 素材 ---
${material}`,
    '重要事項',
    KEY_ITEMS_SCHEMA,
  );
  return normalizeKeyItems(parsed, fixedKind);
}

export function bulletsPerSection(sectionCount: number): number {
  if (sectionCount <= 12) return 4;
  if (sectionCount <= 20) return 3;
  return 2;
}

export async function condenseThemes(themes: SummaryTheme[]): Promise<FinalDraftSection[]> {
  const perSection = bulletsPerSection(themes.length);
  const list = themes
    .map((t) => `【${t.index}】${t.title}\n${t.bullets.filter((b) => !b.startsWith('<!--')).join('\n')}`)
    .join('\n\n');
  const parsed = await callJson(
    `次は会議の要約の話題一覧です（全${themes.length}件）。グラフィックレコーディングの各枠に載せるため、
話題ごとに要点を**最大${perSection}行**にまとめ、内容を表す絵文字を1字選んでください。

守ること:
- 話題の数と順番を変えない。${themes.length}件すべてについて、元の番号（no）で出力する
- 要点は、その話題に書かれている内容だけから作る。創作しない。日本語で書く
- 数値・固有名詞・日時は元の表記のまま残す

出力は JSON 一つだけ: {"sections":[{"no": number, "icon": string, "bullets": string[]}]}

--- 話題一覧 ---
${list}`,
    '要点の整形',
    SECTIONS_SCHEMA,
  );
  const byNo = new Map<number, { icon?: string; bullets?: string[] }>();
  for (const s of Array.isArray(parsed?.sections) ? parsed.sections : []) {
    if (s && typeof s.no === 'number') byNo.set(s.no, s);
  }
  return themes.map((t) => {
    const s = byNo.get(t.index);
    const aiBullets = Array.isArray(s?.bullets) ? s!.bullets.filter((b) => typeof b === 'string' && b.trim()) : [];
    const fallback = t.bullets.filter((b) => !b.startsWith('<!--')).map((b) => b.replace(/^・/, ''));
    return {
      icon: typeof s?.icon === 'string' && s.icon ? s.icon : '•',
      heading: t.title,
      time: t.hasTimeRange ? `${t.timeStart}-${t.timeEnd}` : undefined,
      bullets: (aiBullets.length > 0 ? aiBullets : fallback).slice(0, perSection),
    };
  });
}

export interface GrarecoDraftInput {
  summary?: string;
  pasted?: string;
  material: string;
  meetingDate?: string;
  participants?: Participants;
  meetingType?: string | null;
}

export async function buildGrarecoDraft(input: GrarecoDraftInput): Promise<FinalDraft> {
  const summary = input.summary?.trim() ? input.summary : await summarizePastedContent(input.pasted ?? input.material, input.participants);
  const fromSummary = themesFromSummary(summary);
  if (fromSummary.length === 0) throw new Error('要約から話題を取り出せませんでした');
  const themes = await fitThemesToSpace(fromSummary);

  const [sections, key] = await Promise.all([condenseThemes(themes), extractKeyItems(input.material, input.meetingDate, kindFromMeetingType(input.meetingType))]);
  console.log(
    `[Grareco-Draft] 要約の話題 ${fromSummary.length} → 枠 ${sections.length} ／ 種類 ${key.kind}${kindFromMeetingType(input.meetingType) ? '（指定）' : ''} 決定${key.decisions.length} 要点${key.keyPoints.length} ` +
      `宿題${key.actionItems.length} 気付き${key.highlights.length}（素材 ${input.material.length}字${input.meetingDate ? ` / 開催日 ${input.meetingDate}` : ''}）`,
  );
  return { ...key, sections };
}

export function formatActionItem(a: FinalDraftActionItem): string {
  return `${a.owner ? `${a.owner}：` : ''}${a.text}${a.due ? `（${a.due}）` : ''}`;
}

export const BOTTOM_LABELS = {
  meeting: { decisions: '決定事項', keyPoints: '要点', actionItems: 'アクションアイテム（宿題）', highlights: '重要ポイント', core: 'この会議の核心' },
  training: { decisions: '決まったこと', keyPoints: '要点（学んだこと）', actionItems: 'まとめ（持ち帰って実践すること）', highlights: '気付き', core: 'この研修の核心' },
} as const;

export function buildFinalDraftText(draft: FinalDraft): string {
  const n = draft.sections.length;
  const L = BOTTOM_LABELS[draft.kind];
  const hl = { question: '問い', risk: 'リスク', insight: '気付き' } as const;
  const bottom: Array<{ label: string; lines: string[] }> = [
    { label: L.decisions, lines: draft.decisions.map((d) => `◎ ${d}`) },
    { label: L.keyPoints, lines: draft.keyPoints.map((k) => `◆ ${k}`) },
    { label: L.actionItems, lines: draft.actionItems.map((a) => `□ ${formatActionItem(a)}`) },
    { label: L.highlights, lines: draft.highlights.map((h) => `[${hl[h.kind]}] ${h.text}`) },
  ].filter((b) => b.lines.length > 0);
  const names = bottom.map((b) => `【${b.label}】`).join('');

  const lines: string[] = [
    '【作図ルール（厳守）】',
    `・下の論点は全部で ${n} 個ある。**1個につき1枠、過不足なく ${n} 枠を描く**。配置は論点の数と文章量に合わせて決める。`,
    '・同じ見出しを2回描かない。論点を飛ばさない。',
    `・枠には 1 から ${n} まで連番を振り、番号の重複・欠番を作らない。枠は番号順に読めるよう配置する。`,
  ];
  if (bottom.length > 0) {
    lines.push(
      `・${names}は、論点の枠とは別に下部へまとめて描く。一項目も省略しない。`,
      '・下部に描く欄は、ここに挙げたものだけ。挙げていない欄（見出しだけの空欄を含む）は作らない。',
    );
  } else {
    lines.push('・下部にまとめの欄は作らない。');
  }
  lines.push('', `【タイトル】${draft.title}`);
  if (draft.coreTheme) lines.push(`【${L.core}】${draft.coreTheme}`);

  for (const s of draft.sections) {
    lines.push('', `${s.icon} ${s.heading}${s.time ? ` [${s.time}]` : ''}`);
    for (const b of s.bullets) lines.push(`・${b}`);
  }
  for (const b of bottom) lines.push('', `【${b.label}】`, ...b.lines);
  return lines.join('\n');
}

export function formatMeetingDate(d: Date): string {
  const parts = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}年${get('month')}月${get('day')}日（${get('weekday')}）`;
}
