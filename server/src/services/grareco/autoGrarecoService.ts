
import { eq, desc, and, gte } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { transcripts, structuredSummaries, researchInsights, meetings } from '../../db/schema.js';
import { parseNgKeywords, filterNgTranscripts } from '../ngKeywordFilterService.js';
import { analyzeWithClaude } from '../anthropicService.js';
import {
  REFLECT_TRIGGERS,
  type GrarecoDraft,
  type GrarecoTriggerType,
  type ResearchInsightRef,
} from './types.js';

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const RECENT_WINDOW_MS = 10 * 60 * 1000;
const MAX_TRANSCRIPT_CHARS = 6000;

interface TranscriptRow {
  speaker: string | null;
  content: string;
  startTime: number;
}

async function getLatestSummary(meetingId: number): Promise<string | null> {
  const [row] = await db
    .select({ content: structuredSummaries.content })
    .from(structuredSummaries)
    .where(eq(structuredSummaries.meetingId, meetingId))
    .orderBy(desc(structuredSummaries.updatedAt))
    .limit(1);
  return row?.content ?? null;
}

async function getRecentTranscripts(
  meetingId: number,
  windowMs: number,
  sinceTranscriptStartMs?: number,
): Promise<TranscriptRow[]> {
  const rawRows = await db
    .select({
      speaker: transcripts.speaker,
      content: transcripts.content,
      startTime: transcripts.startTime,
    })
    .from(transcripts)
    .where(and(eq(transcripts.meetingId, meetingId), eq(transcripts.isFinal, true)))
    .orderBy(transcripts.startTime);

  const [mtg] = await db
    .select({ ngKeywords: meetings.ngKeywords })
    .from(meetings)
    .where(eq(meetings.id, meetingId))
    .limit(1);
  const all = filterNgTranscripts(rawRows, parseNgKeywords(mtg?.ngKeywords));

  if (all.length === 0) return [];

  if (typeof sinceTranscriptStartMs === 'number' && sinceTranscriptStartMs > 0) {
    return all.filter((r) => r.startTime > sinceTranscriptStartMs);
  }
  const lastStart = all[all.length - 1].startTime;
  const cutoff = Math.max(0, lastStart - windowMs);
  return all.filter((r) => r.startTime >= cutoff);
}

async function getResearchInsightRefs(
  meetingId: number,
  fallbackSince: Date,
  sinceTranscriptStartMs?: number,
): Promise<ResearchInsightRef[]> {
  const lookbackMs = 10 * 60 * 1000;
  const wideStart = new Date(fallbackSince.getTime() - lookbackMs);
  const rows = await db
    .select({
      id: researchInsights.id,
      keyword: researchInsights.keyword,
      content: researchInsights.content,
      createdAt: researchInsights.createdAt,
      metadata: researchInsights.metadata,
    })
    .from(researchInsights)
    .where(
      and(eq(researchInsights.meetingId, meetingId), gte(researchInsights.createdAt, wideStart)),
    )
    .orderBy(researchInsights.createdAt);

  const filtered = rows.filter((r) => {
    const meta = r.metadata as Record<string, unknown> | null;
    const txStart = typeof meta?.transcriptStartMs === 'number' ? meta.transcriptStartMs : null;
    if (sinceTranscriptStartMs !== undefined && sinceTranscriptStartMs > 0 && txStart !== null) {
      return txStart >= sinceTranscriptStartMs;
    }
    return r.createdAt >= fallbackSince;
  });

  return filtered.map((r) => ({
    insightId: r.id,
    headline: r.keyword || r.content.slice(0, 40),
    createdAt: r.createdAt.toISOString(),
  }));
}

function formatTranscripts(rows: TranscriptRow[]): string {
  if (rows.length === 0) return '(発言なし)';
  let text = rows.map((r) => `${r.speaker ?? '?'}: ${r.content}`).join('\n');
  if (text.length > MAX_TRANSCRIPT_CHARS) {
    text = '…' + text.slice(-MAX_TRANSCRIPT_CHARS);
  }
  return text;
}

function formatResearchRefs(refs: ResearchInsightRef[]): string {
  if (refs.length === 0) return '(調査カードなし)';
  return refs.map((r) => `[insightId=${r.insightId}] ${r.headline}`).join('\n');
}

const COMMON_OUTPUT_RULES = `
出力は **必ず JSON 一つだけ**。前後に説明文や Markdown コードフェンスを付けない。

JSON スキーマ:
{
  "title": string,                                              // 12-30字。その時点の議論を端的に
  "subtitle"?: string,                                          // 任意、1行
  "sections": [{ "icon": string, "heading": string, "bullets": string[] }],  // icon は絵文字1字
  "highlights": [{ "text": string, "kind": "decision"|"question"|"risk"|"insight" }],
  "researchRefs": [{ "insightId": number, "headline": string, "createdAt": string }],
  "visualStyle": "reflect_map"|"tree"|"fishbone"|"2x2"|"blank_quadrant",
  "mermaid"?: string                                            // 任意、必要時のみ簡易フロー図
}

必須ルール:
- 調査カードの参照は提供された (insightId, headline, createdAt) を **そのままコピー**。中身を要約・改変・追加しない
- 提供情報に書かれていない事実を創作しない
- セクションは 2-4 個、各 bullets は 1-4 個
- highlights は 0-3 個
- 出力は発話（【直近10分の発言】）と同じ言語で書く（日本語の会議なら日本語）。翻訳や言語の変更はしない
`;

const REFLECT_SYSTEM_PROMPT = `あなたは会議のグラレコ職人。直近の議論を **俯瞰して整理する**「リフレクト型」ドラフトを作ります。

役割:
- これまでの議論の流れを構造化して俯瞰させる
- 主な論点・決まったこと・残された疑問を区別する
- 読み手が30秒で「ここまでの流れ」を把握できる構成

visualStyle は "reflect_map" 固定。
${COMMON_OUTPUT_RULES}`;

const DISCOVER_SYSTEM_PROMPT = `あなたは会議のグラレコ職人。**次の建設的な論点を発見する**助けとなる「ディスカバー型」ドラフトを作ります。

役割:
- 議論が触れていない盲点・別の切り口を提示する
- 具体的な提案より「問い」「分岐」「対立軸」を可視化する
- 議論が詰まっている場合に新しい視座を与える

visualStyle は議論の状況に応じて以下から **1つだけ** 選ぶ:
- "tree": 主題が分岐している → 議論ツリー
- "fishbone": 原因/論点が散在 → フィッシュボーン
- "2x2": 対立軸が明確 → 2x2マトリクス
- "blank_quadrant": 触れていない領域を示したい → 空白象限図

セクション構成は visualStyle に応じて調整:
- tree: ルート問い → 分岐 → 各分岐の論点
- fishbone: 大骨（カテゴリ）→ 小骨（具体論点）
- 2x2: 軸名 + 各象限の例
- blank_quadrant: 議論済み領域 + 触れていない領域
${COMMON_OUTPUT_RULES}`;

function stripJsonFence(raw: string): string {
  return raw
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\n?```\s*$/i, '')
    .trim();
}

function safeParseDraft(rawText: string): GrarecoDraft | null {
  const stripped = stripJsonFence(rawText);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  if (
    typeof o.title !== 'string' ||
    !Array.isArray(o.sections) ||
    !Array.isArray(o.highlights) ||
    !Array.isArray(o.researchRefs) ||
    typeof o.visualStyle !== 'string'
  ) {
    return null;
  }
  return o as unknown as GrarecoDraft;
}

function buildUserMessage(opts: {
  summary: string | null;
  transcriptText: string;
  researchRefsText: string;
}): string {
  const parts: string[] = [];
  if (opts.summary) {
    parts.push(`【既存サマリー（古いかもしれない）】\n${opts.summary}\n`);
  }
  parts.push(`【直近10分の発言】\n${opts.transcriptText}\n`);
  parts.push(`【この区間に出ていた調査カード（参照のみ）】\n${opts.researchRefsText}\n`);
  return parts.join('\n');
}

async function generateDraftCommon(
  meetingId: number,
  systemPrompt: string,
  triggerType: GrarecoTriggerType,
  sinceTranscriptStartMs?: number,
): Promise<{ draft: GrarecoDraft; sourceText: string; researchRefs: ResearchInsightRef[]; lastTranscriptStartMs: number }> {
  const [summary, recentTr] = await Promise.all([
    getLatestSummary(meetingId),
    getRecentTranscripts(meetingId, RECENT_WINDOW_MS, sinceTranscriptStartMs),
  ]);
  const since = new Date(Date.now() - RECENT_WINDOW_MS);
  const researchRefs = await getResearchInsightRefs(meetingId, since, sinceTranscriptStartMs);
  const lastTranscriptStartMs = recentTr.length > 0 ? recentTr[recentTr.length - 1].startTime : (sinceTranscriptStartMs ?? 0);

  const transcriptText = formatTranscripts(recentTr);
  const userMessage = buildUserMessage({
    summary,
    transcriptText,
    researchRefsText: formatResearchRefs(researchRefs),
  });

  const t0 = Date.now();
  const rawText = await analyzeWithClaude(systemPrompt, userMessage, {
    model: HAIKU_MODEL,
    maxTokens: 2048,
    temperature: 0.4,
    feature: 'anthropic:grareco.autoDraft',
  });
  const elapsedMs = Date.now() - t0;

  const draft = safeParseDraft(rawText);
  if (!draft) {
    console.error(
      `[autoGrareco] Stage 1 JSON parse failed. trigger=${triggerType} raw=${rawText.slice(0, 300)}`,
    );
    throw new Error('Stage 1 draft generation failed: invalid JSON');
  }

  draft.researchRefs = researchRefs;

  if (REFLECT_TRIGGERS.has(triggerType)) {
    draft.visualStyle = 'reflect_map';
  } else if (draft.visualStyle === 'reflect_map') {
    draft.visualStyle = 'tree';
  }

  const sourceText = [
    summary ? `【サマリー】\n${summary}` : null,
    `【直近の議論】\n${transcriptText}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  const hasSupplementaryMarker =
    !!summary && (summary.includes('[補足資料') || summary.includes('【補足資料'));
  console.log(
    `[autoGrareco] Stage 1 ok. trigger=${triggerType} ms=${elapsedMs} sections=${draft.sections.length} highlights=${draft.highlights.length} researchRefs=${draft.researchRefs.length} visualStyle=${draft.visualStyle} since=${sinceTranscriptStartMs ?? 'recent'} transcripts=${recentTr.length} summaryChars=${summary?.length ?? 0} supplementaryInSummary=${hasSupplementaryMarker}`,
  );

  return { draft, sourceText, researchRefs, lastTranscriptStartMs };
}

export async function generateReflectDraft(
  meetingId: number,
  triggerType: GrarecoTriggerType = 'user_reflect',
  sinceTranscriptStartMs?: number,
) {
  return generateDraftCommon(meetingId, REFLECT_SYSTEM_PROMPT, triggerType, sinceTranscriptStartMs);
}

export async function generateDiscoverDraft(
  meetingId: number,
  triggerType: GrarecoTriggerType = 'user_discover',
  sinceTranscriptStartMs?: number,
) {
  return generateDraftCommon(meetingId, DISCOVER_SYSTEM_PROMPT, triggerType, sinceTranscriptStartMs);
}

export const __test__ = {
  safeParseDraft,
  stripJsonFence,
  formatTranscripts,
  formatResearchRefs,
};
