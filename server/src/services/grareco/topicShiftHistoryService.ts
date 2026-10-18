
import { eq, desc, and, gte } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { topicShiftEmbeddings } from '../../db/schema.js';

export interface EmbeddingRecord {
  id: number;
  meetingId: number;
  recordedAtMs: number;
  textPreview: string | null;
  embedding: number[];
  immediateSimilarity: number | null;
  baselineSimilarity: number | null;
  movingAvgSimilarity: number | null;
  outcome: string | null;
  createdAt: string;
}

export interface SaveEmbeddingInput {
  meetingId: number;
  recordedAtMs: number;
  textPreview: string;
  embedding: number[];
  immediateSimilarity: number | null;
  baselineSimilarity: number | null;
  movingAvgSimilarity: number | null;
  outcome: string;
}

function similarityToText(v: number | null): string | null {
  return v === null ? null : v.toFixed(6);
}

function similarityFromText(v: string | null): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function saveEmbeddingHistory(input: SaveEmbeddingInput): Promise<void> {
  try {
    await db.insert(topicShiftEmbeddings).values({
      meetingId: input.meetingId,
      recordedAtMs: input.recordedAtMs,
      textPreview: input.textPreview,
      embedding: input.embedding,
      immediateSimilarity: similarityToText(input.immediateSimilarity),
      baselineSimilarity: similarityToText(input.baselineSimilarity),
      movingAvgSimilarity: similarityToText(input.movingAvgSimilarity),
      outcome: input.outcome,
    });
  } catch (err) {
    console.error(
      '[topicShiftHistory] save failed:',
      err instanceof Error ? err.message : err,
    );
  }
}

export async function loadRecentEmbeddings(
  meetingId: number,
  limit: number = 50,
): Promise<EmbeddingRecord[]> {
  const rows = await db
    .select()
    .from(topicShiftEmbeddings)
    .where(eq(topicShiftEmbeddings.meetingId, meetingId))
    .orderBy(desc(topicShiftEmbeddings.recordedAtMs))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    meetingId: r.meetingId,
    recordedAtMs: r.recordedAtMs,
    textPreview: r.textPreview,
    embedding: Array.isArray(r.embedding) ? (r.embedding as number[]) : [],
    immediateSimilarity: similarityFromText(r.immediateSimilarity),
    baselineSimilarity: similarityFromText(r.baselineSimilarity),
    movingAvgSimilarity: similarityFromText(r.movingAvgSimilarity),
    outcome: r.outcome,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function loadBaselineEmbedding(
  meetingId: number,
): Promise<number[] | null> {
  const [confirmed] = await db
    .select()
    .from(topicShiftEmbeddings)
    .where(
      and(
        eq(topicShiftEmbeddings.meetingId, meetingId),
        eq(topicShiftEmbeddings.outcome, 'shift_confirmed'),
      ),
    )
    .orderBy(desc(topicShiftEmbeddings.recordedAtMs))
    .limit(1);
  if (confirmed && Array.isArray(confirmed.embedding)) {
    return confirmed.embedding as number[];
  }
  const [first] = await db
    .select()
    .from(topicShiftEmbeddings)
    .where(eq(topicShiftEmbeddings.meetingId, meetingId))
    .orderBy(topicShiftEmbeddings.recordedAtMs)
    .limit(1);
  if (first && Array.isArray(first.embedding)) {
    return first.embedding as number[];
  }
  return null;
}

export interface HistoryRow {
  id: number;
  recordedAtMs: number;
  textPreview: string | null;
  immediateSimilarity: number | null;
  baselineSimilarity: number | null;
  movingAvgSimilarity: number | null;
  outcome: string | null;
}

export async function loadHistoryForClient(
  meetingId: number,
  sinceMs: number = 0,
): Promise<HistoryRow[]> {
  const rows = await db
    .select({
      id: topicShiftEmbeddings.id,
      recordedAtMs: topicShiftEmbeddings.recordedAtMs,
      textPreview: topicShiftEmbeddings.textPreview,
      immediateSimilarity: topicShiftEmbeddings.immediateSimilarity,
      baselineSimilarity: topicShiftEmbeddings.baselineSimilarity,
      movingAvgSimilarity: topicShiftEmbeddings.movingAvgSimilarity,
      outcome: topicShiftEmbeddings.outcome,
    })
    .from(topicShiftEmbeddings)
    .where(
      and(
        eq(topicShiftEmbeddings.meetingId, meetingId),
        gte(topicShiftEmbeddings.recordedAtMs, sinceMs),
      ),
    )
    .orderBy(topicShiftEmbeddings.recordedAtMs);

  return rows.map((r) => ({
    id: r.id,
    recordedAtMs: r.recordedAtMs,
    textPreview: r.textPreview,
    immediateSimilarity: similarityFromText(r.immediateSimilarity),
    baselineSimilarity: similarityFromText(r.baselineSimilarity),
    movingAvgSimilarity: similarityFromText(r.movingAvgSimilarity),
    outcome: r.outcome,
  }));
}
