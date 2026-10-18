
import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { meetings, graphicRecordings, topicShiftEmbeddings, transcripts } from '../../db/schema.js';
import { embedText } from './topicShiftDetector.js';
import { tokenizeIfReady } from '../termGlossaryService.js';

export interface GrarecoSearchResult {
  recordingId: number;
  meetingId: number;
  meetingTitle: string;
  meetingStartedAt: string;
  imageUrl: string;
  score: number;
  snippet: string;
  matchedElapsedLabel: string | null;
  matchedTerms: string[];
}

const ABS_FLOOR = 0.55;
const TOP_MARGIN = 0.07;
const LEXICAL_BOOST_MAX = 0.1;
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;
const WINDOW_BEFORE_MS = 90_000 + 60_000;
const WINDOW_AFTER_MS = 60_000;

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function formatElapsed(ms: number): string | null {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function normalizeForMatch(s: string): string {
  return s.normalize('NFKC').toLowerCase();
}

export function extractQueryTerms(query: string): string[] {
  const terms = new Set<string>();
  const push = (w: string) => {
    const n = normalizeForMatch(w.trim());
    if (n.length >= 2) terms.add(n);
  };

  const tokens = tokenizeIfReady(query);
  if (tokens) {
    const NOISY_NOUN_SUBTYPES = new Set(['接尾', '非自立', '代名詞', '数']);
    let compound = '';
    for (const t of tokens) {
      if (t.pos === '名詞') {
        if (!NOISY_NOUN_SUBTYPES.has(t.pos_detail_1)) push(t.surface_form);
        compound += t.surface_form;
      } else {
        if (compound) push(compound);
        compound = '';
      }
    }
    if (compound) push(compound);
  }

  if (terms.size === 0) {
    for (const m of query.matchAll(/[一-龠々]{2,}|[ァ-ヶー]{2,}|[A-Za-z0-9][A-Za-z0-9.\-]+/g)) {
      push(m[0]);
    }
  }
  return [...terms];
}

export function matchTerms(normalizedText: string, terms: string[]): string[] {
  return terms.filter((t) => normalizedText.includes(t));
}

export function buildTermSnippet(content: string, normalizedTerm: string, maxLen = 100): string {
  const norm = normalizeForMatch(content);
  const idx = norm.indexOf(normalizedTerm);
  if (idx === -1) return content.slice(0, maxLen);
  const start = Math.max(0, idx - 25);
  return content.slice(start, start + maxLen);
}

export interface ScoredCandidate {
  recordingId: number;
  score: number;
}

export function applyFloorAndMargin<T extends ScoredCandidate>(
  candidates: T[],
  limit: number,
  floor: number = ABS_FLOOR,
  margin: number = TOP_MARGIN,
): T[] {
  const aboveFloor = candidates.filter((c) => c.score >= floor);
  if (aboveFloor.length === 0) return [];
  const top = Math.max(...aboveFloor.map((c) => c.score));
  return aboveFloor
    .filter((c) => c.score >= top - margin)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export interface RecordingRef {
  id: number;
  createdAtMs: number;
}

export function assignHitToRecording(
  recordings: RecordingRef[],
  recordedAtMs: number,
): number | null {
  if (recordings.length === 0) return null;
  for (const rec of recordings) {
    if (rec.createdAtMs >= recordedAtMs) return rec.id;
  }
  return recordings[recordings.length - 1].id;
}

export async function searchGrarecoSemantics(
  userId: number,
  meetingId: number,
  query: string,
  limit: number = DEFAULT_LIMIT,
): Promise<GrarecoSearchResult[]> {
  const q = query.trim();
  if (!q) return [];
  const cappedLimit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit) || DEFAULT_LIMIT));

  const recordings = await db
    .select({
      id: graphicRecordings.id,
      meetingId: graphicRecordings.meetingId,
      imageUrl: graphicRecordings.imageUrl,
      createdAt: graphicRecordings.createdAt,
      meetingTitle: meetings.title,
      meetingStartedAt: meetings.startedAt,
    })
    .from(graphicRecordings)
    .innerJoin(meetings, eq(graphicRecordings.meetingId, meetings.id))
    .where(
      and(
        eq(meetings.userId, userId),
        eq(graphicRecordings.meetingId, meetingId),
        isNotNull(graphicRecordings.imageUrl),
      ),
    );
  if (recordings.length === 0) return [];
  const meetingStartMs = recordings[0].meetingStartedAt.getTime();

  const rows = await db
    .select({
      recordedAtMs: topicShiftEmbeddings.recordedAtMs,
      textPreview: topicShiftEmbeddings.textPreview,
      embedding: topicShiftEmbeddings.embedding,
    })
    .from(topicShiftEmbeddings)
    .where(eq(topicShiftEmbeddings.meetingId, meetingId));
  if (rows.length === 0) return [];

  const trRows = await db
    .select({ content: transcripts.content, startTime: transcripts.startTime })
    .from(transcripts)
    .where(and(eq(transcripts.meetingId, meetingId), eq(transcripts.isFinal, true)))
    .orderBy(transcripts.startTime);
  const tr = trRows.map((r) => ({
    startMs: r.startTime,
    content: r.content,
    norm: normalizeForMatch(r.content),
  }));

  const queryEmbedding = await embedText(q);
  const terms = extractQueryTerms(q);

  const recRefs: RecordingRef[] = recordings
    .map((r) => ({ id: r.id, createdAtMs: r.createdAt.getTime() }))
    .sort((a, b) => a.createdAtMs - b.createdAtMs);

  interface Best {
    score: number;
    semantic: number;
    matchedTerms: string[];
    snippet: string;
    recordedAtMs: number;
  }
  const best = new Map<number, Best>();
  let searchStart = 0;
  const rowsSorted = [...rows].sort((a, b) => a.recordedAtMs - b.recordedAtMs);
  for (const row of rowsSorted) {
    const emb = Array.isArray(row.embedding) ? (row.embedding as number[]) : null;
    if (!emb) continue;
    const semantic = cosineSimilarity(queryEmbedding, emb);
    if (semantic < ABS_FLOOR - LEXICAL_BOOST_MAX) continue;

    const relMs = row.recordedAtMs - meetingStartMs;
    const fromMs = relMs - WINDOW_BEFORE_MS;
    const toMs = relMs + WINDOW_AFTER_MS;
    while (searchStart < tr.length && tr[searchStart].startMs < fromMs) searchStart++;
    const windowUtterances: { content: string; norm: string }[] = [];
    for (let i = searchStart; i < tr.length && tr[i].startMs <= toMs; i++) {
      windowUtterances.push(tr[i]);
    }
    const windowNorm =
      windowUtterances.map((u) => u.norm).join('\n') +
      '\n' +
      normalizeForMatch(row.textPreview ?? '');

    const matched = matchTerms(windowNorm, terms);
    const score = Math.min(
      1,
      semantic + (terms.length > 0 ? (matched.length / terms.length) * LEXICAL_BOOST_MAX : 0),
    );

    const recId = assignHitToRecording(recRefs, row.recordedAtMs);
    if (recId === null) continue;
    const current = best.get(recId);
    if (!current || score > current.score) {
      let snippet = row.textPreview ?? '';
      if (matched.length > 0) {
        const hitUtterance = windowUtterances.find((u) => matched.some((t) => u.norm.includes(t)));
        if (hitUtterance) snippet = buildTermSnippet(hitUtterance.content, matched[0]);
      }
      best.set(recId, { score, semantic, matchedTerms: matched, snippet, recordedAtMs: row.recordedAtMs });
    }
  }
  if (best.size === 0) {
    console.log(`[grarecoSearch] meeting=${meetingId} q="${q}" rows=${rows.length} terms=[${terms.join(',')}] candidates=0`);
    return [];
  }

  const candidates = [...best.entries()].map(([recordingId, b]) => ({ recordingId, ...b }));
  const picked = applyFloorAndMargin(candidates, cappedLimit);

  const dist = candidates
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map((c) => `${c.recordingId}:${c.semantic.toFixed(3)}+lex${c.matchedTerms.length}=${c.score.toFixed(3)}`)
    .join(' ');
  console.log(
    `[grarecoSearch] meeting=${meetingId} q="${q}" rows=${rows.length} terms=[${terms.join(',')}] ` +
      `floor=${ABS_FLOOR} margin=${TOP_MARGIN} dist=[${dist}] returned=${picked.length}`,
  );

  const byId = new Map(recordings.map((r) => [r.id, r]));
  const results: GrarecoSearchResult[] = [];
  for (const c of picked) {
    const rec = byId.get(c.recordingId);
    if (!rec?.imageUrl) continue;
    results.push({
      recordingId: c.recordingId,
      meetingId: rec.meetingId,
      meetingTitle: rec.meetingTitle,
      meetingStartedAt: rec.meetingStartedAt.toISOString(),
      imageUrl: `/api/meetings/${rec.meetingId}/grareco/${c.recordingId}/image`,
      score: Math.round(c.score * 1000) / 1000,
      snippet: c.snippet,
      matchedElapsedLabel: formatElapsed(c.recordedAtMs - meetingStartMs),
      matchedTerms: c.matchedTerms,
    });
  }
  return results;
}
