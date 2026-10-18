
import type { GoogleGenAI } from '@google/genai';
import { createGenAI } from '../llm/genaiClient.js';
import { analyzeWithClaude } from '../anthropicService.js';
import {
  saveEmbeddingHistory,
  loadRecentEmbeddings,
  loadBaselineEmbedding,
  type EmbeddingRecord,
} from './topicShiftHistoryService.js';

const EMBED_MODEL = 'gemini-embedding-001';
const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

const EMBED_INTERVAL_MS = 30 * 1000;
const SIMILARITY_THRESHOLD = 0.70;
const IMMEDIATE_FIRE_THRESHOLD = 0.60;
const HAIKU_CONFIDENCE_THRESHOLD = 0.7;
const MIN_TEXT_CHARS = 80;
const CANDIDATE_DISMISS_COOLDOWN_MS = 5 * 60 * 1000;
const RECENT_HISTORY_N = 5;

interface DetectorState {
  prevEmbedding: number[] | null;
  prevWindowText: string | null;
  baselineEmbedding: number[] | null;
  recentEmbeddings: number[][];
  lastEmbedAt: number;
  candidateAt: number | null;
  candidateSimilarity: number | null;
  candidateConsecutiveRecoveries: number;
  candidateDismissedAt: number;
  embedCalls: number;
  embedTokens: number;
  haikuCalls: number;
  haikuTokens: number;
}

const state = new Map<number, DetectorState>();

let geminiClient: GoogleGenAI | null = null;
function getGeminiClient(): GoogleGenAI {
  if (!geminiClient) {
    geminiClient = createGenAI();
  }
  return geminiClient;
}

function ensureState(meetingId: number): DetectorState {
  let s = state.get(meetingId);
  if (!s) {
    s = {
      prevEmbedding: null,
      prevWindowText: null,
      baselineEmbedding: null,
      recentEmbeddings: [],
      lastEmbedAt: 0,
      candidateAt: null,
      candidateSimilarity: null,
      candidateConsecutiveRecoveries: 0,
      candidateDismissedAt: 0,
      embedCalls: 0,
      embedTokens: 0,
      haikuCalls: 0,
      haikuTokens: 0,
    };
    state.set(meetingId, s);
  }
  return s;
}

type CandidateNotifier = {
  onCandidate: (meetingId: number, similarity: number) => void;
  onCandidateCleared: (meetingId: number, reason: 'recovered' | 'fired' | 'dismissed') => void;
};
let notifier: CandidateNotifier | null = null;
export function setTopicShiftNotifier(n: CandidateNotifier | null): void {
  notifier = n;
}

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

function averageEmbedding(embs: number[][]): number[] | null {
  if (embs.length === 0) return null;
  const dim = embs[0].length;
  const sum = new Array(dim).fill(0);
  for (const e of embs) {
    if (e.length !== dim) continue;
    for (let i = 0; i < dim; i++) sum[i] += e[i];
  }
  return sum.map((v) => v / embs.length);
}

export async function embedText(text: string): Promise<number[]> {
  const ai = getGeminiClient();
  const response = await ai.models.embedContent({
    model: EMBED_MODEL,
    contents: text,
  });
  const values = response.embeddings?.[0]?.values;
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('Empty embedding response');
  }
  return values;
}

async function confirmShiftWithHaiku(
  prevText: string,
  newText: string,
  similarity: number,
): Promise<{ confirmed: boolean; confidence: number; headline: string }> {
  const systemPrompt =
    'あなたは会議解析の補助エージェント。与えられた直前ウィンドウと現ウィンドウの発話を比較し、'
    + '「話題転換」が起きたかを判定する。一時的な脱線・確認質問・冗談は false。'
    + '主題が明確に切り替わった時のみ true。\n\n'
    + '出力は JSON のみ。スキーマ:\n'
    + '{ "confirmed": boolean, "confidence": number(0..1), "headline": string }';

  const userMessage =
    `[直前ウィンドウ]\n${prevText.slice(-1500)}\n\n`
    + `[現ウィンドウ]\n${newText.slice(-1500)}\n\n`
    + `[embedding cosine similarity] ${similarity.toFixed(3)}（${SIMILARITY_THRESHOLD}未満）`;

  let raw: string;
  try {
    raw = await analyzeWithClaude(systemPrompt, userMessage, {
      model: HAIKU_MODEL,
      maxTokens: 256,
      temperature: 0.2,
      feature: 'anthropic:grareco.topicShift',
    });
  } catch (err) {
    console.error('[topicShift] Haiku call failed:', err instanceof Error ? err.message : err);
    return { confirmed: false, confidence: 0, headline: '' };
  }

  const fenceStripped = raw.replace(/```(?:json)?\s*/gi, '').replace(/```\s*/g, '').trim();
  const firstBrace = fenceStripped.indexOf('{');
  const lastBrace = fenceStripped.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace <= firstBrace) {
    console.warn(`[topicShift] Haiku JSON not found. raw=${raw.length} chars`);
    return { confirmed: false, confidence: 0, headline: '' };
  }
  const candidateJson = fenceStripped.slice(firstBrace, lastBrace + 1);
  try {
    const parsed = JSON.parse(candidateJson) as {
      confirmed?: unknown;
      confidence?: unknown;
      headline?: unknown;
    };
    return {
      confirmed: parsed.confirmed === true,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
      headline: typeof parsed.headline === 'string' ? parsed.headline : '',
    };
  } catch {
    console.warn(`[topicShift] Haiku JSON parse failed. raw=${raw.length} chars`);
    return { confirmed: false, confidence: 0, headline: '' };
  }
}

export interface TopicShiftResult {
  shifted: boolean;
  headline: string | null;
  similarity: number | null;
  reason:
    | 'tick_skipped'
    | 'first_window'
    | 'no_shift'
    | 'candidate'
    | 'shift_confirmed'
    | 'shift_rejected';
}

interface MultiSignal {
  immediate: number | null;
  baseline: number | null;
  movingAvg: number | null;
  recentMin: number | null;
}

function computeSignals(s: DetectorState, current: number[]): MultiSignal {
  const immediate = s.prevEmbedding ? cosineSimilarity(s.prevEmbedding, current) : null;
  const baseline = s.baselineEmbedding ? cosineSimilarity(s.baselineEmbedding, current) : null;
  const movAvg =
    s.recentEmbeddings.length >= 2
      ? cosineSimilarity(averageEmbedding(s.recentEmbeddings)!, current)
      : null;
  let recentMin: number | null = null;
  if (s.recentEmbeddings.length >= 2) {
    let min = Infinity;
    for (const e of s.recentEmbeddings) {
      const sim = cosineSimilarity(e, current);
      if (sim < min) min = sim;
    }
    recentMin = min;
  }
  return { immediate, baseline, movingAvg: movAvg, recentMin };
}

function isImmediateFire(signals: MultiSignal): boolean {
  return [signals.immediate, signals.baseline, signals.recentMin].some(
    (v) => v !== null && v < IMMEDIATE_FIRE_THRESHOLD,
  );
}

function isCandidate(signals: MultiSignal): boolean {
  return [signals.immediate, signals.baseline, signals.movingAvg].some(
    (v) => v !== null && v < SIMILARITY_THRESHOLD,
  );
}

function pickLowestSignal(signals: MultiSignal): number | null {
  const values = [signals.immediate, signals.baseline, signals.movingAvg, signals.recentMin].filter(
    (v): v is number => v !== null,
  );
  if (values.length === 0) return null;
  return Math.min(...values);
}

export async function detectTopicShift(
  meetingId: number,
  recentWindowText: string,
): Promise<TopicShiftResult> {
  const s = ensureState(meetingId);
  const now = Date.now();

  if (now - s.lastEmbedAt < EMBED_INTERVAL_MS) {
    return { shifted: false, headline: null, similarity: null, reason: 'tick_skipped' };
  }
  if (recentWindowText.length < MIN_TEXT_CHARS) {
    return { shifted: false, headline: null, similarity: null, reason: 'tick_skipped' };
  }

  let newEmbedding: number[];
  try {
    newEmbedding = await embedText(recentWindowText);
    s.embedCalls++;
    s.embedTokens += Math.ceil(recentWindowText.length / 3);
  } catch (err) {
    console.error(`[topicShift] embed failed (meeting=${meetingId}):`, err instanceof Error ? err.message : err);
    return { shifted: false, headline: null, similarity: null, reason: 'tick_skipped' };
  }

  s.lastEmbedAt = now;

  if (!s.prevEmbedding || !s.prevWindowText) {
    s.prevEmbedding = newEmbedding;
    s.prevWindowText = recentWindowText;
    s.recentEmbeddings = [newEmbedding];
    if (!s.baselineEmbedding) s.baselineEmbedding = newEmbedding;
    await saveEmbeddingHistory({
      meetingId,
      recordedAtMs: now,
      textPreview: recentWindowText.slice(0, 120),
      embedding: newEmbedding,
      immediateSimilarity: null,
      baselineSimilarity: null,
      movingAvgSimilarity: null,
      outcome: 'first_window',
    });
    return { shifted: false, headline: null, similarity: null, reason: 'first_window' };
  }

  const signals = computeSignals(s, newEmbedding);
  const lowestSim = pickLowestSignal(signals);
  console.log(
    `[topicShift] meeting=${meetingId} sim_imm=${signals.immediate?.toFixed(3) ?? 'n/a'} sim_base=${signals.baseline?.toFixed(3) ?? 'n/a'} sim_mavg=${signals.movingAvg?.toFixed(3) ?? 'n/a'} sim_min=${signals.recentMin?.toFixed(3) ?? 'n/a'} candidate=${s.candidateAt !== null}`,
  );

  if (isImmediateFire(signals)) {
    console.log(`[topicShift] immediate fire path (low sim < ${IMMEDIATE_FIRE_THRESHOLD})`);
    const haikuResult = await confirmShiftWithHaiku(s.prevWindowText, recentWindowText, lowestSim ?? 0);
    s.haikuCalls++;
    s.haikuTokens += 2000;
    if (s.candidateAt !== null) {
      s.candidateAt = null;
      s.candidateSimilarity = null;
      s.candidateConsecutiveRecoveries = 0;
    }
    s.prevEmbedding = newEmbedding;
    s.prevWindowText = recentWindowText;
    s.recentEmbeddings.push(newEmbedding);
    if (s.recentEmbeddings.length > RECENT_HISTORY_N) s.recentEmbeddings.shift();

    const outcome = haikuResult.confirmed && haikuResult.confidence >= HAIKU_CONFIDENCE_THRESHOLD ? 'shift_confirmed' : 'shift_rejected';
    await saveEmbeddingHistory({
      meetingId,
      recordedAtMs: now,
      textPreview: recentWindowText.slice(0, 120),
      embedding: newEmbedding,
      immediateSimilarity: signals.immediate,
      baselineSimilarity: signals.baseline,
      movingAvgSimilarity: signals.movingAvg,
      outcome,
    });

    if (haikuResult.confirmed && haikuResult.confidence >= HAIKU_CONFIDENCE_THRESHOLD) {
      console.log(`[topicShift] CONFIRMED (immediate) meeting=${meetingId} confidence=${haikuResult.confidence.toFixed(2)} headline="${haikuResult.headline}"`);
      try { notifier?.onCandidateCleared(meetingId, 'fired'); } catch {  }
      return { shifted: true, headline: haikuResult.headline || null, similarity: lowestSim, reason: 'shift_confirmed' };
    }
    console.log(`[topicShift] rejected (immediate) meeting=${meetingId} confidence=${haikuResult.confidence.toFixed(2)}`);
    return { shifted: false, headline: null, similarity: lowestSim, reason: 'shift_rejected' };
  }

  if (isCandidate(signals)) {
    if (s.candidateAt === null) {
      s.candidateAt = now;
      s.candidateSimilarity = lowestSim;
      s.candidateConsecutiveRecoveries = 0;
      s.prevEmbedding = newEmbedding;
      s.prevWindowText = recentWindowText;
      s.recentEmbeddings.push(newEmbedding);
      if (s.recentEmbeddings.length > RECENT_HISTORY_N) s.recentEmbeddings.shift();

      const sinceDismiss = now - s.candidateDismissedAt;
      if (sinceDismiss >= CANDIDATE_DISMISS_COOLDOWN_MS) {
        try { notifier?.onCandidate(meetingId, lowestSim ?? 0); } catch {  }
      }
      await saveEmbeddingHistory({
        meetingId,
        recordedAtMs: now,
        textPreview: recentWindowText.slice(0, 120),
        embedding: newEmbedding,
        immediateSimilarity: signals.immediate,
        baselineSimilarity: signals.baseline,
        movingAvgSimilarity: signals.movingAvg,
        outcome: 'candidate',
      });
      return { shifted: false, headline: null, similarity: lowestSim, reason: 'candidate' };
    }

    const haikuResult = await confirmShiftWithHaiku(s.prevWindowText, recentWindowText, lowestSim ?? 0);
    s.haikuCalls++;
    s.haikuTokens += 2000;
    s.candidateAt = null;
    s.candidateSimilarity = null;
    s.candidateConsecutiveRecoveries = 0;
    s.prevEmbedding = newEmbedding;
    s.prevWindowText = recentWindowText;
    s.recentEmbeddings.push(newEmbedding);
    if (s.recentEmbeddings.length > RECENT_HISTORY_N) s.recentEmbeddings.shift();

    const outcome = haikuResult.confirmed && haikuResult.confidence >= HAIKU_CONFIDENCE_THRESHOLD ? 'shift_confirmed' : 'shift_rejected';
    await saveEmbeddingHistory({
      meetingId,
      recordedAtMs: now,
      textPreview: recentWindowText.slice(0, 120),
      embedding: newEmbedding,
      immediateSimilarity: signals.immediate,
      baselineSimilarity: signals.baseline,
      movingAvgSimilarity: signals.movingAvg,
      outcome,
    });

    if (haikuResult.confirmed && haikuResult.confidence >= HAIKU_CONFIDENCE_THRESHOLD) {
      console.log(`[topicShift] CONFIRMED meeting=${meetingId} confidence=${haikuResult.confidence.toFixed(2)} headline="${haikuResult.headline}"`);
      try { notifier?.onCandidateCleared(meetingId, 'fired'); } catch {  }
      return { shifted: true, headline: haikuResult.headline || null, similarity: lowestSim, reason: 'shift_confirmed' };
    }
    console.log(`[topicShift] rejected meeting=${meetingId} confidence=${haikuResult.confidence.toFixed(2)}`);
    try { notifier?.onCandidateCleared(meetingId, 'recovered'); } catch {  }
    return { shifted: false, headline: null, similarity: lowestSim, reason: 'shift_rejected' };
  }

  let outcome: 'no_shift' | 'recovered' = 'no_shift';
  if (s.candidateAt !== null) {
    s.candidateConsecutiveRecoveries += 1;
    if (s.candidateConsecutiveRecoveries >= 2) {
      console.log(`[topicShift] candidate dropped (recovered ×2) meeting=${meetingId}`);
      s.candidateAt = null;
      s.candidateSimilarity = null;
      s.candidateConsecutiveRecoveries = 0;
      try { notifier?.onCandidateCleared(meetingId, 'recovered'); } catch {  }
      outcome = 'recovered';
    } else {
      console.log(`[topicShift] candidate held (recovery 1/2) meeting=${meetingId}`);
    }
  }
  s.prevEmbedding = newEmbedding;
  s.prevWindowText = recentWindowText;
  s.recentEmbeddings.push(newEmbedding);
  if (s.recentEmbeddings.length > RECENT_HISTORY_N) s.recentEmbeddings.shift();

  await saveEmbeddingHistory({
    meetingId,
    recordedAtMs: now,
    textPreview: recentWindowText.slice(0, 120),
    embedding: newEmbedding,
    immediateSimilarity: signals.immediate,
    baselineSimilarity: signals.baseline,
    movingAvgSimilarity: signals.movingAvg,
    outcome,
  });
  return { shifted: false, headline: null, similarity: lowestSim, reason: 'no_shift' };
}

export function updateBaselineToLatest(meetingId: number): void {
  const s = state.get(meetingId);
  if (!s || !s.prevEmbedding) return;
  s.baselineEmbedding = s.prevEmbedding;
  console.log(`[topicShift] baseline updated meeting=${meetingId}`);
}

export function dismissTopicShiftCandidate(meetingId: number): boolean {
  const s = state.get(meetingId);
  if (!s) return false;
  const wasActive = s.candidateAt !== null;
  s.candidateAt = null;
  s.candidateSimilarity = null;
  s.candidateConsecutiveRecoveries = 0;
  s.candidateDismissedAt = Date.now();
  if (wasActive) {
    try { notifier?.onCandidateCleared(meetingId, 'dismissed'); } catch {  }
  }
  console.log(`[topicShift] candidate dismissed by user meeting=${meetingId} wasActive=${wasActive}`);
  return wasActive;
}

export function confirmTopicShiftCandidate(meetingId: number): boolean {
  const s = state.get(meetingId);
  if (!s) return false;
  const wasActive = s.candidateAt !== null;
  s.candidateAt = null;
  s.candidateSimilarity = null;
  s.candidateConsecutiveRecoveries = 0;
  if (wasActive) {
    try { notifier?.onCandidateCleared(meetingId, 'fired'); } catch {  }
  }
  console.log(`[topicShift] candidate user-confirmed meeting=${meetingId} wasActive=${wasActive}`);
  return wasActive;
}

export function cleanupTopicShiftDetector(meetingId: number): void {
  const s = state.get(meetingId);
  if (!s) return;
  console.log(
    `[topicShift] cleanup meeting=${meetingId} embedCalls=${s.embedCalls} embedTokens~=${s.embedTokens} haikuCalls=${s.haikuCalls} haikuTokens~=${s.haikuTokens}`,
  );
  state.delete(meetingId);
}

export { loadRecentEmbeddings, loadBaselineEmbedding, type EmbeddingRecord };

export const __test__ = {
  cosineSimilarity,
  averageEmbedding,
};
