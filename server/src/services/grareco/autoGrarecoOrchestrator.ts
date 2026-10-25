
import { serverFeatures } from '../features.js';
import { eq, and, gte, sql, inArray, isNull, asc } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { transcripts, graphicRecordings, users, meetings, structuredSummaries } from '../../db/schema.js';
import { parseNgKeywords, filterNgTranscripts } from '../ngKeywordFilterService.js';
import {
  detectTopicShift,
  cleanupTopicShiftDetector,
  setTopicShiftNotifier,
  updateBaselineToLatest,
  confirmTopicShiftCandidate,
} from './topicShiftDetector.js';
import {
  detectSectionTransition,
  cleanupSectionTransitionDetector,
} from './sectionTransitionDetector.js';
import {
  registerActiveMeeting,
  recordTranscript,
  recordAnyFire,
  unregisterMeeting,
  startSilenceDetector,
  type SilenceFireCallbacks,
} from './silenceDetector.js';
import {
  generateReflectDraft,
  generateDiscoverDraft,
} from './autoGrarecoService.js';
import { generateGraphicRecording } from '../geminiService.js';
import { withCompressedGrarecoImage } from './grarecoImageCompress.js';
import { broadcastToUser } from '../research/connectionRegistry.js';
import {
  DEFAULT_AUTO_GRARECO_SETTINGS,
  type AutoGrarecoSettings,
  type GrarecoTriggerType,
  type GrarecoDraft,
} from './types.js';

function buildImageSourceFromDraft(draft: GrarecoDraft): string {
  const lines: string[] = [];
  lines.push(`【タイトル】${draft.title}`);
  if (draft.subtitle) {
    lines.push(`【副題】${draft.subtitle}`);
  }
  for (const section of draft.sections) {
    lines.push('');
    lines.push(`${section.icon} ${section.heading}`);
    for (const bullet of section.bullets) {
      lines.push(`・${bullet}`);
    }
  }
  if (draft.highlights.length > 0) {
    lines.push('');
    lines.push('【ハイライト】');
    const kindLabels: Record<string, string> = {
      decision: '決定',
      question: '問い',
      risk: 'リスク',
      insight: '気付き',
    };
    for (const h of draft.highlights) {
      lines.push(`[${kindLabels[h.kind] ?? h.kind}] ${h.text}`);
    }
  }
  return lines.join('\n');
}

const RECENT_WINDOW_MS = 90 * 1000;
const SECTION_RECENT_MS = 30 * 1000;
const MIN_AUTO_INTERVAL_MS = 5 * 60 * 1000;
const PROMOTE_DELAY_MS = 30 * 1000;
const STAGE2_HOURLY_LIMIT_DEFAULT = 8;
const SILENCE_LOOKBACK_MS = 120 * 1000;
const MIN_NEW_TRANSCRIPTS_FOR_AUTO_FIRE = 5;
const MIN_NEW_CHARS_FOR_AUTO_FIRE = 1000;

interface MeetingState {
  userId: number;
  lastAutoFireAt: number;
  lastFiredTranscriptEndMs: number;
  isProcessing: boolean;
  pendingPromotions: Map<number, NodeJS.Timeout>;
}

const meetingState = new Map<number, MeetingState>();

function ensureMeetingState(meetingId: number, userId?: number): MeetingState {
  let s = meetingState.get(meetingId);
  if (!s) {
    s = {
      userId: userId ?? 0,
      lastAutoFireAt: 0,
      lastFiredTranscriptEndMs: 0,
      isProcessing: false,
      pendingPromotions: new Map(),
    };
    meetingState.set(meetingId, s);
  } else if (userId && s.userId === 0) {
    s.userId = userId;
  }
  return s;
}

async function isSummaryReady(meetingId: number): Promise<boolean> {
  try {
    const [row] = await db
      .select({ id: structuredSummaries.id })
      .from(structuredSummaries)
      .where(eq(structuredSummaries.meetingId, meetingId))
      .limit(1);
    return !!row;
  } catch {
    return false;
  }
}

async function getUserAutoGrarecoSettings(userId: number): Promise<AutoGrarecoSettings> {
  try {
    const [row] = await db
      .select({ researchSettings: users.researchSettings })
      .from(users)
      .where(eq(users.id, userId));
    if (!row) return DEFAULT_AUTO_GRARECO_SETTINGS;
    const settings = row.researchSettings as Record<string, unknown> | null;
    if (!settings) return DEFAULT_AUTO_GRARECO_SETTINGS;
    const ag = settings.autoGrareco as Partial<AutoGrarecoSettings> | undefined;
    if (!ag) return DEFAULT_AUTO_GRARECO_SETTINGS;
    return { ...DEFAULT_AUTO_GRARECO_SETTINGS, ...ag };
  } catch (err) {
    console.error(
      '[autoGrarecoOrchestrator] fetch settings failed:',
      err instanceof Error ? err.message : err,
    );
    return DEFAULT_AUTO_GRARECO_SETTINGS;
  }
}

async function getRecentWindowText(meetingId: number, windowMs: number): Promise<string> {
  const [{ maxStart } = { maxStart: null }] = await db
    .select({ maxStart: sql<number | null>`max(${transcripts.startTime})` })
    .from(transcripts)
    .where(and(eq(transcripts.meetingId, meetingId), eq(transcripts.isFinal, true)));
  if (maxStart == null) return '';
  const cutoff = Math.max(0, maxStart - windowMs);

  const rawRows = await db
    .select({
      content: transcripts.content,
      startTime: transcripts.startTime,
      speaker: transcripts.speaker,
    })
    .from(transcripts)
    .where(
      and(
        eq(transcripts.meetingId, meetingId),
        eq(transcripts.isFinal, true),
        gte(transcripts.startTime, cutoff),
      ),
    )
    .orderBy(transcripts.startTime);
  const [mtg] = await db
    .select({ ngKeywords: meetings.ngKeywords })
    .from(meetings)
    .where(eq(meetings.id, meetingId))
    .limit(1);
  const rows = filterNgTranscripts(rawRows, parseNgKeywords(mtg?.ngKeywords));
  if (rows.length === 0) return '';
  return rows.map((r) => `${r.speaker ?? '?'}: ${r.content}`).join('\n');
}

async function countStage2InLastHour(meetingId: number, userId: number): Promise<number> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(graphicRecordings)
    .innerJoin(meetings, eq(graphicRecordings.meetingId, meetings.id))
    .where(
      and(
        eq(meetings.userId, userId),
        eq(graphicRecordings.stage, 'image'),
        inArray(graphicRecordings.triggerType, [
          'auto_reflect',
          'auto_discover',
          'auto_milestone',
          'auto_fallback',
        ]),
        gte(graphicRecordings.createdAt, oneHourAgo),
      ),
    );
  return Number(count ?? 0);
}

export type PromoteResult = 'ok' | 'limit' | 'failed' | 'skipped';

async function promoteToImage(
  meetingId: number,
  userId: number,
  recordingId: number,
  options: { bypassHourlyLimit?: boolean } = {},
): Promise<PromoteResult> {
  const s = ensureMeetingState(meetingId);
  s.pendingPromotions.delete(recordingId);

  if (!options.bypassHourlyLimit) {
    const settings = await getUserAutoGrarecoSettings(userId);
    const used = await countStage2InLastHour(meetingId, userId);
    const limit = Math.max(1, settings.maxImagesPerHour ?? STAGE2_HOURLY_LIMIT_DEFAULT);
    if (used >= limit) {
      broadcastToUser(userId, 'grareco_skipped', {
        recordingId,
        meetingId,
        reason: 'limit_reached',
      });
      console.log(`[autoGrarecoOrchestrator] stage2 skipped (limit) meeting=${meetingId} rec=${recordingId} used=${used}/${limit}`);
      return 'limit';
    }
  }

  const [row] = await db
    .select({
      sourceText: graphicRecordings.sourceText,
      stage: graphicRecordings.stage,
      draftJson: graphicRecordings.draftJson,
      metadata: graphicRecordings.metadata,
    })
    .from(graphicRecordings)
    .where(and(eq(graphicRecordings.id, recordingId), eq(graphicRecordings.meetingId, meetingId)));
  if (!row || row.stage === 'image') return 'skipped';

  const draft = row.draftJson as GrarecoDraft | null;
  const imageInput = draft ? buildImageSourceFromDraft(draft) : row.sourceText;

  try {
    const result = await withCompressedGrarecoImage(await generateGraphicRecording(imageInput), `auto meeting=${meetingId} rec=${recordingId}`);
    const imageUrl = result.imageUrl;
    await db
      .update(graphicRecordings)
      .set({
        imageUrl,
        stage: 'image',
        metadata: {
          ...((row.metadata as Record<string, unknown>) || {}),
          modelUsed: result.modelUsed,
          costUsd: result.costUsd,
          aspectRatio: result.aspectRatio,
          imageDimensions: result.imageDimensions,
          refImagesUsed: result.refImagesUsed,
          attempt: result.attempt,
        },
      })
      .where(and(eq(graphicRecordings.id, recordingId), eq(graphicRecordings.meetingId, meetingId)));
    broadcastToUser(userId, 'grareco_image_ready', {
      recordingId,
      meetingId,
      imageUrl,
    });
    console.log(`[autoGrarecoOrchestrator] stage2 ok meeting=${meetingId} rec=${recordingId}`);
    return 'ok';
  } catch (err) {
    console.error(`[autoGrarecoOrchestrator] stage2 failed rec=${recordingId}:`, err instanceof Error ? err.message : err);
    broadcastToUser(userId, 'grareco_skipped', {
      recordingId,
      meetingId,
      reason: 'generation_failed',
    });
    return 'failed';
  }
}

function schedulePromotion(meetingId: number, userId: number, recordingId: number): void {
  const s = ensureMeetingState(meetingId);
  if (s.pendingPromotions.has(recordingId)) return;
  const timer = setTimeout(() => {
    void promoteToImage(meetingId, userId, recordingId);
  }, PROMOTE_DELAY_MS);
  s.pendingPromotions.set(recordingId, timer);
}

export function cancelPendingPromotion(meetingId: number, recordingId: number): boolean {
  const s = ensureMeetingState(meetingId);
  const timer = s.pendingPromotions.get(recordingId);
  if (!timer) return false;
  clearTimeout(timer);
  s.pendingPromotions.delete(recordingId);
  if (s.userId) {
    broadcastToUser(s.userId, 'grareco_skipped', {
      recordingId,
      meetingId,
      reason: 'cancelled',
    });
  }
  return true;
}

export async function promoteNow(
  meetingId: number,
  userId: number,
  recordingId: number,
): Promise<void> {
  const s = ensureMeetingState(meetingId);
  const timer = s.pendingPromotions.get(recordingId);
  if (timer) {
    clearTimeout(timer);
    s.pendingPromotions.delete(recordingId);
  }
  await promoteToImage(meetingId, userId, recordingId);
}

export async function promotePendingForMeeting(
  meetingId: number,
  userId: number,
): Promise<{ promoted: number; remaining: number; total: number }> {
  const pending = await db
    .select({ id: graphicRecordings.id })
    .from(graphicRecordings)
    .where(
      and(
        eq(graphicRecordings.meetingId, meetingId),
        isNull(graphicRecordings.imageUrl),
      ),
    )
    .orderBy(asc(graphicRecordings.createdAt));

  const total = pending.length;
  let promoted = 0;

  for (let i = 0; i < pending.length; i++) {
    const result = await promoteToImage(meetingId, userId, pending[i].id, {
      bypassHourlyLimit: true,
    });
    if (result === 'ok') {
      promoted++;
    }
  }

  const remaining = total - promoted;
  broadcastToUser(userId, 'grareco_bulk_done', { meetingId, promoted, remaining });
  console.log(`[autoGrarecoOrchestrator] bulk done meeting=${meetingId} promoted=${promoted}/${total}`);
  return { promoted, remaining, total };
}

export async function emitDraft(
  meetingId: number,
  userId: number,
  triggerType: GrarecoTriggerType,
  isReflectFamily: boolean,
  options: { forceManualPromote?: boolean; sinceTranscriptStartMs?: number } = {},
): Promise<void> {
  const ms = ensureMeetingState(meetingId, userId);
  const sinceMs = options.sinceTranscriptStartMs ?? ms.lastFiredTranscriptEndMs;
  const generator = isReflectFamily ? generateReflectDraft : generateDiscoverDraft;
  const { draft, sourceText, researchRefs, lastTranscriptStartMs } = await generator(
    meetingId,
    triggerType,
    sinceMs > 0 ? sinceMs : undefined,
  );

  const [saved] = await db
    .insert(graphicRecordings)
    .values({
      meetingId,
      sourceText,
      imageUrl: null,
      triggerType,
      stage: 'draft',
      draftJson: draft,
      researchInsightIds: researchRefs.map((r) => r.insightId),
      visualStyle: draft.visualStyle,
    })
    .returning({ id: graphicRecordings.id });

  const settings = await getUserAutoGrarecoSettings(userId);
  const willAutoPromote = !options.forceManualPromote && settings.autoPromoteMode === 'auto';
  const cancelDeadlineMs = willAutoPromote ? Date.now() + PROMOTE_DELAY_MS : 0;

  broadcastToUser(userId, 'grareco_draft', {
    recordingId: saved.id,
    meetingId,
    triggerType,
    draft,
    willAutoPromote,
    cancelDeadlineMs,
  });

  if (willAutoPromote) {
    schedulePromotion(meetingId, userId, saved.id);
  }

  ms.lastAutoFireAt = Date.now();
  if (lastTranscriptStartMs > ms.lastFiredTranscriptEndMs) {
    ms.lastFiredTranscriptEndMs = lastTranscriptStartMs;
  }
  updateBaselineToLatest(meetingId);
  recordAnyFire(meetingId);
  console.log(
    `[autoGrarecoOrchestrator] ${triggerType} fired meeting=${meetingId} rec=${saved.id} willAutoPromote=${willAutoPromote} cutoff=${ms.lastFiredTranscriptEndMs}`,
  );
}

export async function processFinalTranscript(
  meetingId: number,
  userId: number,
): Promise<void> {
  const s = ensureMeetingState(meetingId, userId);
  registerActiveMeeting(meetingId, userId);
  recordTranscript(meetingId);

  if (s.isProcessing) return;

  if (!serverFeatures().autoGrareco) return;
  const settings = await getUserAutoGrarecoSettings(userId);
  if (!settings.enabled) return;

  if (!(await isSummaryReady(meetingId))) return;

  const now = Date.now();
  const inFireCooldown = now - s.lastAutoFireAt < MIN_AUTO_INTERVAL_MS;

  s.isProcessing = true;
  try {
    if (settings.reflect) {
      const windowText = await getRecentWindowText(meetingId, RECENT_WINDOW_MS);
      if (windowText.length > 0) {
        const detection = await detectTopicShift(meetingId, windowText);
        if (detection.shifted && !inFireCooldown) {
          await emitDraft(meetingId, userId, 'auto_reflect', true);
          return;
        }
      }
    }

    if (settings.reflect && !inFireCooldown) {
      const recentText = await getRecentWindowText(meetingId, SECTION_RECENT_MS);
      const prevContext = await getRecentWindowText(meetingId, RECENT_WINDOW_MS);
      if (recentText.length > 0) {
        const result = await detectSectionTransition(meetingId, recentText, prevContext);
        if (result.shifted) {
          await emitDraft(meetingId, userId, 'auto_milestone', true);
          return;
        }
      }
    }
  } catch (err) {
    console.error(
      `[autoGrarecoOrchestrator] meeting=${meetingId} error:`,
      err instanceof Error ? err.message : err,
    );
  } finally {
    s.isProcessing = false;
  }
}

export async function fireFromUserConfirmation(
  meetingId: number,
  userId: number,
): Promise<{ ok: boolean; recordingId?: number }> {
  const s = ensureMeetingState(meetingId, userId);
  if (s.isProcessing) return { ok: false };

  confirmTopicShiftCandidate(meetingId);

  s.isProcessing = true;
  try {
    await emitDraft(meetingId, userId, 'auto_reflect', true);
    return { ok: true };
  } catch (err) {
    console.error(
      `[autoGrarecoOrchestrator] user confirm fire failed meeting=${meetingId}:`,
      err instanceof Error ? err.message : err,
    );
    return { ok: false };
  } finally {
    s.isProcessing = false;
  }
}

const silenceCallbacks: SilenceFireCallbacks = {
  fireDiscover: async (meetingId, userId) => {
    const ms = ensureMeetingState(meetingId);
    if (ms.isProcessing) return;
    if (!(await isSummaryReady(meetingId))) return;
    const stats = await getNewTranscriptStats(meetingId, ms.lastFiredTranscriptEndMs);
    if (stats.count < MIN_NEW_TRANSCRIPTS_FOR_AUTO_FIRE || stats.chars < MIN_NEW_CHARS_FOR_AUTO_FIRE) {
      console.log(
        `[autoGrarecoOrchestrator] auto_discover skipped meeting=${meetingId} newTranscripts=${stats.count} newChars=${stats.chars} (need >= ${MIN_NEW_TRANSCRIPTS_FOR_AUTO_FIRE} AND >= ${MIN_NEW_CHARS_FOR_AUTO_FIRE})`,
      );
      return;
    }
    ms.isProcessing = true;
    try {
      await emitDraft(meetingId, userId, 'auto_discover', false);
    } finally {
      ms.isProcessing = false;
    }
  },
  fireFallback: async (meetingId, userId) => {
    const ms = ensureMeetingState(meetingId);
    if (ms.isProcessing) return;
    if (!(await isSummaryReady(meetingId))) return;
    const stats = await getNewTranscriptStats(meetingId, ms.lastFiredTranscriptEndMs);
    if (stats.count < MIN_NEW_TRANSCRIPTS_FOR_AUTO_FIRE || stats.chars < MIN_NEW_CHARS_FOR_AUTO_FIRE) {
      console.log(
        `[autoGrarecoOrchestrator] auto_fallback skipped meeting=${meetingId} newTranscripts=${stats.count} newChars=${stats.chars} (need >= ${MIN_NEW_TRANSCRIPTS_FOR_AUTO_FIRE} AND >= ${MIN_NEW_CHARS_FOR_AUTO_FIRE})`,
      );
      return;
    }
    ms.isProcessing = true;
    try {
      await emitDraft(meetingId, userId, 'auto_fallback', true);
    } finally {
      ms.isProcessing = false;
    }
  },
  getRecentSpokenStats: async (meetingId) => {
    const rows = await db
      .select({ startTime: transcripts.startTime })
      .from(transcripts)
      .where(and(eq(transcripts.meetingId, meetingId), eq(transcripts.isFinal, true)))
      .orderBy(transcripts.startTime);
    if (rows.length === 0) {
      return { recentCount: 0, priorCount: 0 };
    }
    const lastStart = rows[rows.length - 1].startTime;
    const recentCutoff = lastStart - SILENCE_LOOKBACK_MS;
    const priorCutoff = lastStart - 2 * SILENCE_LOOKBACK_MS;
    const recent = rows.filter((r) => r.startTime >= recentCutoff).length;
    const prior = rows.filter((r) => r.startTime >= priorCutoff && r.startTime < recentCutoff).length;
    return { recentCount: recent, priorCount: prior };
  },
  isMeetingActive: async (meetingId) => {
    const [m] = await db
      .select({ status: meetings.status })
      .from(meetings)
      .where(eq(meetings.id, meetingId));
    return !!m && m.status === 'active';
  },
  shouldFireDiscover: async (userId) => {
    const settings = await getUserAutoGrarecoSettings(userId);
    return settings.enabled && settings.discover;
  },
  shouldFireFallback: async (userId) => {
    const settings = await getUserAutoGrarecoSettings(userId);
    return settings.enabled && settings.reflect;
  },
};

let silenceStarted = false;
export function ensureSilenceDetectorStarted(): void {
  if (silenceStarted) return;
  startSilenceDetector(silenceCallbacks);
  setTopicShiftNotifier({
    onCandidate: (meetingId, similarity) => {
      const s = meetingState.get(meetingId);
      const userId = s?.userId ?? 0;
      if (!userId) return;
      broadcastToUser(userId, 'topic_shift_candidate', {
        meetingId,
        similarity,
        detectedAt: Date.now(),
      });
    },
    onCandidateCleared: (meetingId, reason) => {
      const s = meetingState.get(meetingId);
      const userId = s?.userId ?? 0;
      if (!userId) return;
      broadcastToUser(userId, 'topic_shift_candidate_cleared', {
        meetingId,
        reason,
      });
    },
  });
  silenceStarted = true;
}

export async function cleanupAutoGrareco(
  meetingId: number,
  userId?: number,
): Promise<void> {
  const s = meetingState.get(meetingId);
  if (s) {
    for (const t of s.pendingPromotions.values()) clearTimeout(t);
    s.pendingPromotions.clear();

    const effectiveUserId = userId ?? s.userId;
    if (effectiveUserId && !s.isProcessing) {
      try {
        const newTranscriptCount = await getNewTranscriptCount(meetingId, s.lastFiredTranscriptEndMs);
        if (newTranscriptCount >= 2) {
          s.isProcessing = true;
          try {
            await emitDraft(meetingId, effectiveUserId, 'auto_meeting_end', true, {
              forceManualPromote: true,
              sinceTranscriptStartMs: s.lastFiredTranscriptEndMs,
            });
          } finally {
            s.isProcessing = false;
          }
        } else {
          console.log(`[autoGrarecoOrchestrator] meeting end card skipped meeting=${meetingId} newTranscripts=${newTranscriptCount}`);
        }
      } catch (err) {
        console.error(
          `[autoGrarecoOrchestrator] meeting end card failed meeting=${meetingId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }
  cleanupTopicShiftDetector(meetingId);
  cleanupSectionTransitionDetector(meetingId);
  unregisterMeeting(meetingId);
  meetingState.delete(meetingId);
}

async function getNewTranscriptCount(meetingId: number, sinceStartMs: number): Promise<number> {
  const rows = await db
    .select({ id: transcripts.id })
    .from(transcripts)
    .where(
      and(
        eq(transcripts.meetingId, meetingId),
        eq(transcripts.isFinal, true),
        gte(transcripts.startTime, sinceStartMs + 1),
      ),
    );
  return rows.length;
}

async function getNewTranscriptStats(
  meetingId: number,
  sinceStartMs: number,
): Promise<{ count: number; chars: number }> {
  const rawRows = await db
    .select({ content: transcripts.content })
    .from(transcripts)
    .where(
      and(
        eq(transcripts.meetingId, meetingId),
        eq(transcripts.isFinal, true),
        gte(transcripts.startTime, sinceStartMs + 1),
      ),
    );
  const [mtg] = await db
    .select({ ngKeywords: meetings.ngKeywords })
    .from(meetings)
    .where(eq(meetings.id, meetingId))
    .limit(1);
  const rows = filterNgTranscripts(rawRows, parseNgKeywords(mtg?.ngKeywords));
  let chars = 0;
  for (const r of rows) {
    chars += (r.content ?? '').length;
  }
  return { count: rows.length, chars };
}

export { dismissTopicShiftCandidate } from './topicShiftDetector.js';
