import { audit } from '../services/audit/audit.js';
import { serverFeatures } from '../services/features.js';
import { tokenLast4, maskEmail } from '../services/audit/logSafety.js';
import { Router } from 'express';
import { eq, and, desc, inArray, notInArray, or, isNull, ne, sql, getTableColumns } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { meetings, transcripts, structuredSummaries, analyses, graphicRecordings, users, meetingImages, meetingMemos, participantImages, participantTexts, researchInsights, meetingObservations } from '../db/schema.js';
import { authUserId } from '../middleware/authContext.js';
import { requireAuth } from '../middleware/auth.js';
import {
  summaryRebuildLimiter,
  titleBatchLimiter,
  imageAnalysisLimiter,
  participantReprofileLimiter,
  meetingAnalysisLimiter,
} from '../middleware/rateLimit.js';
import { imageJsonBody } from '../middleware/bodyLimits.js';
import { uploadImageData, uploadImageMimeType } from '../services/uploadImageTypes.js';
import {
  generateMeetingTitle,
  generateMeetingMinutes,
  generateStructuredSummary,
  rebuildStructuredSummary,
  analyzeTranscript,
  generateGraphicRecording,
  reviseGraphicRecording,
  analyzeImagesForGrareco,
  validateImages,
  extractParticipantsFromImage,
  extractParticipantsFromText,
  consolidateSummaryThemes,
  withConsolidatedMarker,
  type AnalysisType,
} from '../services/geminiService.js';
import { splitTranscriptIntoWindows, windowIndexForElapsed, type TimedLine } from '../services/summaryThemes.js';
import { buildParticipantsSection } from '../services/grareco/grarecoPrompt.js';
import { generateManualGrareco } from '../services/grareco/manualGrareco.js';
import type { GrarecoImageResult } from '../services/grareco/imageOutput.js';
import { sendMeetingMinutesEmail } from '../services/emailService.js';
import { getDetectedTermsByMeeting, excludeTerm } from '../services/termGlossaryService.js';
import { foldPausedSet, recordedDurationSeconds } from '../services/recordingMeter.js';
import { buildSpeakerMapping, applySpeakerMapping } from '../services/participantMappingService.js';
import { parseNgKeywords, filterNgTranscripts, isNgContent } from '../services/ngKeywordFilterService.js';
import { triggerReprofile } from '../services/participantProfileTrigger.js';
import { mergeAndUpdateParticipants, normalizeNameKey, undismissNames } from '../services/participantMergeService.js';
import { refreshSessionKeyterms } from '../services/keytermsBuilder.js';
import {
  appendSupplementaryToSummary,
  formatElapsedLabel,
  loadClockPoints,
  removeSupplementaryFromSummary,
  reconcileSupplementaryIntoSummary,
  toRecordingElapsedMs,
} from '../services/summaryAppendService.js';
import { sendGrarecoImage, sendGrarecoThumbnail } from '../services/grareco/grarecoImageResponse.js';
import { processMeetingImageUpload } from '../services/meetingImageService.js';
import {
  createOrRefreshShare,
  revokeShareByMeeting,
  getShareByMeeting,
  buildShareUrl,
  isShareLive,
  getSharedContents,
  getExcludedItems,
  updateShareSettings,
  getActiveShareMeetingIds,
  isMeetingLive,
} from '../services/shareService.js';

const router = Router();

router.use(requireAuth);

const createMeetingSchema = z.object({
  title: z.string().optional(),
  platform: z.enum(['zoom', 'meet', 'teams', 'webex', 'web-recorder', 'unknown']).optional(),
});

const updateMeetingSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  isTitleEdited: z.boolean().optional(),
  participants: z.array(z.any()).optional(),
});

interface SupplementaryItem {
  kind: 'memo' | 'image';
  elapsedMs: number | null;
  line: string;
}

function formatSupplementaryContext(items: SupplementaryItem[]): string | null {
  const parts: string[] = [];
  for (const [kind, header] of [['memo', '【参加者メモ】'], ['image', '【画像分析結果】']] as const) {
    const lines = items.filter((i) => i.kind === kind).map((i) => i.line);
    if (lines.length > 0) parts.push(header, ...lines);
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

export async function getSupplementaryContext(meetingId: number): Promise<string | null> {
  return formatSupplementaryContext(await getSupplementaryItems(meetingId));
}

async function getSupplementaryItems(meetingId: number): Promise<SupplementaryItem[]> {
  const memos = await db.select().from(meetingMemos)
    .where(eq(meetingMemos.meetingId, meetingId))
    .orderBy(meetingMemos.createdAt);
  const images = await db.select({ id: meetingImages.id, aiAnalysis: meetingImages.aiAnalysis, fileName: meetingImages.fileName, uploadedAt: meetingImages.uploadedAt, meetingElapsedMs: meetingImages.meetingElapsedMs })
    .from(meetingImages)
    .where(eq(meetingImages.meetingId, meetingId))
    .orderBy(meetingImages.uploadedAt);

  const clockPoints = await loadClockPoints(meetingId);
  const items: SupplementaryItem[] = [];
  for (const memo of memos) {
    const recMs = toRecordingElapsedMs(clockPoints, memo.meetingElapsedMs);
    const elapsed = formatElapsedLabel(recMs);
    items.push({ kind: 'memo', elapsedMs: recMs, line: `- ${elapsed ? `[${elapsed}] ` : ''}${memo.content}` });
  }
  for (const img of images.filter((i) => i.aiAnalysis)) {
    const recMs = toRecordingElapsedMs(clockPoints, img.meetingElapsedMs);
    const elapsed = formatElapsedLabel(recMs);
    items.push({
      kind: 'image',
      elapsedMs: recMs,
      line: `${elapsed ? `[${elapsed}] ` : ''}[${img.fileName || `画像${img.id}`}] ${img.aiAnalysis}`,
    });
  }
  return items;
}

async function getMeetingOrFail(id: number, userId: number) {
  const [meeting] = await db
    .select()
    .from(meetings)
    .where(and(eq(meetings.id, id), eq(meetings.userId, userId)));
  return meeting || null;
}

async function getTranscriptText(
  meetingId: number,
  options?: { afterTime?: number; participants?: unknown; ngKeywords?: unknown }
): Promise<{ text: string; lines: TimedLine[]; minTime: number; maxTime: number }> {
  const rows = await db
    .select()
    .from(transcripts)
    .where(and(eq(transcripts.meetingId, meetingId), eq(transcripts.isFinal, true)))
    .orderBy(transcripts.startTime);

  const afterTime = options?.afterTime;
  const filtered = afterTime !== undefined ? rows.filter((r) => r.startTime >= afterTime) : rows;

  const minTime = filtered.length > 0 ? filtered[0].startTime : 0;
  const maxTime = filtered.length > 0 ? filtered[filtered.length - 1].startTime : 0;

  const mapping = buildSpeakerMapping(options?.participants);
  const mapped = applySpeakerMapping(filtered, mapping);
  const visible = filterNgTranscripts(mapped, parseNgKeywords(options?.ngKeywords));

  const lines = visible.map((r) => {
    const ms = r.recordingMs ?? r.startTime;
    const speaker = r.speaker ? `${r.speaker}: ` : '';
    return { ms, text: `[${formatTimestamp(ms)}] ${speaker}${r.content}` };
  });
  const text = lines.map((l) => l.text).join('\n');

  return { text, lines, minTime, maxTime };
}

function formatTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

router.get('/', async (req, res, next) => {
  try {
    const rows = await db
      .select()
      .from(meetings)
      .where(eq(meetings.userId, authUserId(req)))
      .orderBy(desc(meetings.startedAt));
    const activeShareIds = await getActiveShareMeetingIds(rows.map((r) => r.id));
    const now = Date.now();
    res.json(
      rows.map((r) => ({
        ...r,
        shareActive: activeShareIds.has(r.id) && isMeetingLive(r, now),
      })),
    );
  } catch (err) {
    next(err);
  }
});

const pendingOldMeetingTimers = new Map<number, NodeJS.Timeout>();
const OLD_MEETING_EMAIL_DELAY = 2 * 60 * 1000;

router.post('/', async (req, res, next) => {
  try {
    const body = createMeetingSchema.parse(req.body);
    const userId = authUserId(req);

    const oldMeetings = await db
      .select()
      .from(meetings)
      .where(and(
        eq(meetings.userId, userId),
        or(eq(meetings.status, 'active'), eq(meetings.status, 'paused')),
        isNull(meetings.emailSentAt),
      ));

    const [meeting] = await db
      .insert(meetings)
      .values({
        userId,
        title: body.title || '無題の会議',
        platform: body.platform || 'web-recorder',
        status: 'idle',
        startedAt: new Date(),
      })
      .returning();

    for (const old of oldMeetings) {
      if (old.id === meeting.id) continue;
      if (pendingOldMeetingTimers.has(old.id)) continue;

      console.log(`[MeetingEmail] 旧会議 ${old.id} に対して${OLD_MEETING_EMAIL_DELAY / 1000}秒後のメール送信タイマーをセット`);
      const timer = setTimeout(async () => {
        pendingOldMeetingTimers.delete(old.id);
        try {
          const [current] = await db.select().from(meetings).where(eq(meetings.id, old.id));
          if (!current || current.emailSentAt) return;

          if (getActiveRecording(old.id) !== null) {
            console.log(`[MeetingEmail] 旧会議 ${old.id} は再開中のため強制完了・メールをスキップ`);
            return;
          }

          const endedAt = current.endedAt || new Date();
          const duration = recordedDurationSeconds(current, endedAt.getTime());
          if (current.status !== 'completed') {
            await db.update(meetings)
              .set({ status: 'completed', endedAt, duration, ...foldPausedSet })
              .where(and(eq(meetings.id, old.id), ne(meetings.status, 'completed')));
          }

          console.log(`[MeetingEmail] 旧会議 ${old.id} のメール送信を実行`);
          sendMeetingEndEmailFromHttp(old.id, userId, current.title, endedAt, current.participants);
        } catch (err) {
          console.error(`[MeetingEmail] 旧会議 ${old.id} タイマー処理エラー:`, err);
        }
      }, OLD_MEETING_EMAIL_DELAY);
      pendingOldMeetingTimers.set(old.id, timer);
    }

    res.status(201).json(meeting);
  } catch (err) {
    next(err);
  }
});

router.post('/bulk-delete', async (req, res, next) => {
  try {
    const { ids } = z.object({ ids: z.array(z.number()) }).parse(req.body);
    if (ids.length === 0) {
      res.json({ deleted: 0 });
      return;
    }

    const deleted = await db
      .delete(meetings)
      .where(and(
        inArray(meetings.id, ids),
        eq(meetings.userId, authUserId(req)),
        notInArray(meetings.status, ['active', 'paused']),
      ))
      .returning();

    await audit('meeting.delete', {
      target: { type: 'meeting' },
      detail: { mode: 'bulk', requested: ids.length, deletedIds: deleted.map((m) => m.id) },
    }, req);
    res.json({ deleted: deleted.length });
  } catch (err) {
    next(err);
  }
});

const TITLE_BATCH_MAX = 50;

router.post('/generate-all-titles', titleBatchLimiter, async (req, res, next) => {
  try {
    const allMeetings = await db
      .select()
      .from(meetings)
      .where(and(eq(meetings.userId, authUserId(req)), eq(meetings.isTitleEdited, false)))
      .orderBy(desc(meetings.startedAt))
      .limit(TITLE_BATCH_MAX);

    let updated = 0;
    for (const meeting of allMeetings) {
      const [summary] = await db
        .select()
        .from(structuredSummaries)
        .where(eq(structuredSummaries.meetingId, meeting.id))
        .orderBy(desc(structuredSummaries.updatedAt))
        .limit(1);

      if (summary?.content) {
        const newTitle = await generateMeetingTitle(summary.content);
        if (newTitle) {
          await db
            .update(meetings)
            .set({ title: newTitle })
            .where(eq(meetings.id, meeting.id));
          updated++;
        }
      }
    }

    res.json({ updated });
  } catch (err) {
    next(err);
  }
});

router.post('/term-exclusions', async (req, res, next) => {
  try {
    const { term } = z.object({ term: z.string().min(1) }).parse(req.body);
    await excludeTerm(authUserId(req), term);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const meeting = await getMeetingOrFail(Number(req.params.id), authUserId(req));
    if (!meeting) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }
    res.json(meeting);
  } catch (err) {
    next(err);
  }
});

router.get('/:id/share', async (req, res, next) => {
  try {
    const meetingId = Number(req.params.id);
    const meeting = await getMeetingOrFail(meetingId, authUserId(req));
    if (!meeting) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }
    const share = await getShareByMeeting(meetingId);
    if (!share || !share.isActive || share.revokedAt) {
      res.json({ active: false });
      return;
    }
    res.json({
      active: true,
      live: isShareLive(share, meeting),
      token: share.token,
      url: buildShareUrl(share.token),
      sharedContents: getSharedContents(share),
      excludedItems: getExcludedItems(share),
    });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id/share', async (req, res, next) => {
  try {
    const meetingId = Number(req.params.id);
    const meeting = await getMeetingOrFail(meetingId, authUserId(req));
    if (!meeting) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }
    const body = z
      .object({
        sharedContents: z.array(z.enum(['glossary', 'research', 'grareco', 'summary'])).optional(),
        excludedItems: z
          .object({
            research: z.array(z.string()).optional(),
            grareco: z.array(z.string()).optional(),
            glossary: z.array(z.string()).optional(),
            summary: z
              .array(
                z.union([
                  z.object({ startMs: z.number(), endMs: z.number() }),
                  z.object({ heading: z.string() }),
                ]),
              )
              .optional(),
          })
          .optional(),
      })
      .parse(req.body);

    const updated = await updateShareSettings(meetingId, body);
    if (!updated) {
      res.status(404).json({ error: 'Share not found' });
      return;
    }
    await audit('share_link.update', { target: { type: 'meeting', id: meetingId }, detail: { shareId: updated.id, sharedContents: getSharedContents(updated) } }, req);
    res.json({
      active: updated.isActive && !updated.revokedAt,
      sharedContents: getSharedContents(updated),
      excludedItems: getExcludedItems(updated),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/share', async (req, res, next) => {
  try {
    const meetingId = Number(req.params.id);
    const meeting = await getMeetingOrFail(meetingId, authUserId(req));
    if (!meeting) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }
    if (meeting.status !== 'active' && meeting.status !== 'paused') {
      res.status(409).json({ error: 'meeting_not_live' });
      return;
    }
    const share = await createOrRefreshShare(meetingId, authUserId(req));
    await audit('share_link.create', { target: { type: 'meeting', id: meetingId }, detail: { shareId: share.id, tokenLast4: tokenLast4(share.token) } }, req);
    res.status(201).json({
      active: true,
      live: true,
      token: share.token,
      url: buildShareUrl(share.token),
    });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id/share', async (req, res, next) => {
  try {
    const meetingId = Number(req.params.id);
    const meeting = await getMeetingOrFail(meetingId, authUserId(req));
    if (!meeting) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }
    await revokeShareByMeeting(meetingId);
    await audit('share_link.revoke', { target: { type: 'meeting', id: meetingId } }, req);
    res.json({ active: false });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    const body = updateMeetingSchema.parse(req.body);
    const updateData: Record<string, unknown> = {};
    if (body.title !== undefined) { updateData.title = body.title; updateData.isTitleEdited = true; }
    if (body.isTitleEdited !== undefined) updateData.isTitleEdited = body.isTitleEdited;
    if (body.participants !== undefined) updateData.participants = body.participants;

    const [updated] = await db
      .update(meetings)
      .set(updateData)
      .where(and(eq(meetings.id, Number(req.params.id)), eq(meetings.userId, authUserId(req))))
      .returning();

    if (!updated) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

router.patch('/:id/stop', async (req, res, next) => {
  try {
    const meetingId = Number(req.params.id);
    const userId = authUserId(req);
    const meeting = await getMeetingOrFail(meetingId, userId);
    if (!meeting) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }

    const endedAt = new Date();
    const duration = recordedDurationSeconds(meeting, endedAt.getTime());

    const completedRows = await db
      .update(meetings)
      .set({ status: 'completed', endedAt, duration, ...foldPausedSet })
      .where(and(eq(meetings.id, meetingId), ne(meetings.status, 'completed')))
      .returning();
    const didComplete = completedRows.length > 0;
    const updated = completedRows[0] ?? meeting;

    if (didComplete) {
      await revokeShareByMeeting(meetingId).catch((e) =>
        console.error('[Share] revoke on stop failed:', e),
      );
    }

    sendForceEndToDesktop(meetingId);

    const broadcastResult = broadcastToUser(userId, 'meeting_ended', { meetingId });
    if (broadcastResult.sent > 0) {
      console.log(
        `[Stop API] meeting_ended broadcasted to ${broadcastResult.sent} connection(s) for meeting ${meetingId}`,
      );
    }

    markMeetingEnded(meetingId, 'http-force-end');

    cleanupResearch(meetingId).catch((err) => console.error('[Stop API] cleanupResearch error:', err));

    res.json(updated);

    sendMeetingEndEmailFromHttp(meetingId, userId, updated.title, endedAt, meeting.participants);
  } catch (err) {
    next(err);
  }
});

async function sendMeetingEndEmailFromHttp(
  meetingId: number,
  userId: number,
  title: string,
  endedAt: Date,
  participants: any
) {
  console.log(`[MeetingEmail] meetingId=${meetingId} メール送信処理を開始...`);

  try {
    const [mtgCheck] = await db.select().from(meetings).where(eq(meetings.id, meetingId));
    if (mtgCheck?.emailSentAt) {
      console.log(`[MeetingEmail] meetingId=${meetingId} メール送信済み（${mtgCheck.emailSentAt}）— スキップ`);
      return;
    }

    const MIN_DURATION_MS = 3 * 60 * 1000;
    const MIN_TRANSCRIPT_LENGTH = 200;
    const { text: precheckTranscript } = await getTranscriptText(meetingId, {
      participants: Array.isArray(participants) ? (participants as any[]) : [],
      ngKeywords: mtgCheck?.ngKeywords,
    });
    const rawTranscriptLength = precheckTranscript?.length || 0;
    const durationMs = mtgCheck?.startedAt
      ? endedAt.getTime() - new Date(mtgCheck.startedAt).getTime()
      : 0;
    console.log(
      `[MeetingEmail] meetingId=${meetingId} 判定 duration=${Math.floor(durationMs / 1000)}秒 transcript=${rawTranscriptLength}文字 startedAt=${mtgCheck?.startedAt ? new Date(mtgCheck.startedAt).toISOString() : 'NULL'}`,
    );
    if (durationMs < MIN_DURATION_MS || rawTranscriptLength < MIN_TRANSCRIPT_LENGTH) {
      console.log(
        `[MeetingEmail] meetingId=${meetingId} テスト操作と判断してスキップ（時間=${Math.floor(durationMs / 1000)}秒, 文字数=${rawTranscriptLength}文字）`,
      );
      await db.update(meetings).set({ emailSentAt: null }).where(eq(meetings.id, meetingId)).catch(() => {});
      return;
    }

    await db.update(meetings).set({ emailSentAt: new Date() }).where(eq(meetings.id, meetingId));

    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user?.email) {
      console.error(`[MeetingEmail] userId=${userId} メールアドレスが見つかりません`);
      return;
    }

    const [summary] = await db
      .select()
      .from(structuredSummaries)
      .where(eq(structuredSummaries.meetingId, meetingId))
      .orderBy(desc(structuredSummaries.updatedAt));
    const summaryContent = await rebuildSummaryAtMeetingEnd(
      { id: meetingId, participants, ngKeywords: mtgCheck?.ngKeywords },
      summary?.content || '',
    );

    const participantsArray = Array.isArray(participants) ? participants : [];

    const transcriptText = precheckTranscript;
    if (!transcriptText && !summaryContent) {
      console.log(`[MeetingEmail] meetingId=${meetingId} 文字起こし・サマリーが空のためスキップ`);
      return;
    }

    const [mtgForTitle] = await db.select().from(meetings).where(eq(meetings.id, meetingId));
    if (mtgForTitle && !mtgForTitle.isTitleEdited && summaryContent) {
      try {
        const newTitle = await generateMeetingTitle(summaryContent);
        if (newTitle) {
          await db.update(meetings).set({ title: newTitle }).where(eq(meetings.id, meetingId));
          title = newTitle;
        }
      } catch (e) {
        console.error(`[MeetingEmail] タイトル自動生成失敗:`, e);
      }
    }

    const supplementary = await getSupplementaryContext(meetingId).catch(() => null);

    const GRARECO_TRANSCRIPT_LIMIT = 3000;
    const grarecoSourceParts: string[] = [];
    if (summaryContent) grarecoSourceParts.push(`【サマリー】\n${summaryContent}`);
    const participantsSection = buildParticipantsSection(participantsArray);
    if (participantsSection) grarecoSourceParts.push(participantsSection);
    if (supplementary) grarecoSourceParts.push(supplementary);
    if (transcriptText) {
      const truncated = transcriptText.length > GRARECO_TRANSCRIPT_LIMIT
        ? transcriptText.substring(0, GRARECO_TRANSCRIPT_LIMIT) + '\n（以下省略）'
        : transcriptText;
      grarecoSourceParts.push(`【全文書き起こし】\n${truncated}`);
    }
    const grarecoSourceText = grarecoSourceParts.join('\n\n');

    const sourceTextParts: string[] = [];
    if (summaryContent) sourceTextParts.push(`【サマリー】\n${summaryContent}`);
    if (supplementary) sourceTextParts.push(supplementary);
    if (transcriptText) sourceTextParts.push(`【全文書き起こし】\n${transcriptText}`);
    const sourceText = sourceTextParts.join('\n\n') || transcriptText;

    const [minutesText, grarecoResult] = await Promise.all([
      generateMeetingMinutes(summaryContent || '（サマリーなし）', transcriptText, participantsArray, supplementary).catch(
        (err) => {
          console.error(`[MeetingEmail] 議事録生成失敗:`, err);
          return '議事録の自動生成に失敗しました。サマリーページをご確認ください。';
        }
      ),
      !serverFeatures().grareco ? Promise.resolve(undefined) : generateManualGrareco(grarecoSourceText, undefined, generateGraphicRecording, {
        summary: summaryContent,
        material: sourceText,
        meetingDate: mtgCheck?.startedAt ? new Date(mtgCheck.startedAt) : endedAt,
        participants: participantsArray,
        meetingType: mtgCheck?.meetingType,
      }).catch((err) => {
        console.error(`[MeetingEmail] グラレコ生成失敗:`, err);
        return undefined;
      }),
    ]);

    const grarecoImageUrl = grarecoResult?.imageUrl;

    await db.insert(analyses).values({
      meetingId,
      type: 'minutes',
      content: minutesText,
      metadata: { source: 'auto_meeting_end', generatedAt: endedAt.toISOString() },
    }).catch((err) => console.error(`[MeetingEmail] 議事録DB保存失敗:`, err));

    if (grarecoResult) {
      await db.insert(graphicRecordings).values({
        meetingId,
        sourceText,
        imageUrl: grarecoResult.imageUrl,
        metadata: {
          source: 'auto_meeting_end',
          generatedAt: endedAt.toISOString(),
          sourceTextChars: sourceText.length,
          modelUsed: grarecoResult.modelUsed,
          costUsd: grarecoResult.costUsd,
          aspectRatio: grarecoResult.aspectRatio,
          imageDimensions: grarecoResult.imageDimensions,
          refImagesUsed: grarecoResult.refImagesUsed,
          attempt: grarecoResult.attempt,
          imageQuality: grarecoResult.imageQuality,
          draftSections: grarecoResult.draftSections,
          draftKind: grarecoResult.draftKind,
          fallbackReason: grarecoResult.fallbackReason,
        },
      }).catch((err) => console.error(`[MeetingEmail] グラレコDB保存失敗:`, err));
    }

    await sendMeetingMinutesEmail({
      to: user.email,
      meetingId,
      meetingTitle: title,
      endedAt,
      minutesText,
      grarecoImageBase64: grarecoImageUrl,
    });

    console.log(`[MeetingEmail] meetingId=${meetingId} メール送信完了 → ${maskEmail(user.email)}`);
  } catch (err) {
    console.error(`[MeetingEmail] meetingId=${meetingId} メール送信失敗:`, err);
    await db.update(meetings).set({ emailSentAt: null }).where(eq(meetings.id, meetingId)).catch(() => {});
    console.log(`[MeetingEmail] meetingId=${meetingId} emailSentAtをリセット（再送信可能）`);
  }
}

router.delete('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const [target] = await db
      .select({ status: meetings.status })
      .from(meetings)
      .where(and(eq(meetings.id, id), eq(meetings.userId, authUserId(req))));

    if (!target) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }
    if (target.status === 'active' || target.status === 'paused') {
      res.status(409).json({
        error: 'meeting_in_progress',
        message: '文字起こし中の会議は削除できません。先に会議を終了してください。',
      });
      return;
    }

    const [deleted] = await db
      .delete(meetings)
      .where(and(eq(meetings.id, id), eq(meetings.userId, authUserId(req))))
      .returning();

    if (!deleted) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }
    await audit('meeting.delete', { target: { type: 'meeting', id }, detail: { mode: 'single' } }, req);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/transcripts', async (req, res, next) => {
  try {
    const meeting = await getMeetingOrFail(Number(req.params.id), authUserId(req));
    if (!meeting) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }

    const rows = await db
      .select()
      .from(transcripts)
      .where(and(eq(transcripts.meetingId, Number(req.params.id)), eq(transcripts.isFinal, true)))
      .orderBy(transcripts.startTime);

    const ngKeywords = parseNgKeywords(meeting.ngKeywords);
    res.json(rows.map((r) => ({ ...r, ngExcluded: isNgContent(r.content, ngKeywords) })));
  } catch (err) {
    next(err);
  }
});

import { getPartialTranscript } from '../websocket/socketIO.js';
import { sendForceEndToDesktop, syncSessionAfterRebuild } from '../websocket/nativeWs.js';
import { markMeetingEnded, getActiveRecording } from '../websocket/meetingRegistry.js';

router.get('/:id/partial-transcript', async (req, res, next) => {
  try {
    const meetingId = Number(req.params.id);
    const meeting = await getMeetingOrFail(meetingId, authUserId(req));
    if (!meeting) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }
    const partial = getPartialTranscript(meetingId);
    res.json({ partial });
  } catch (err) {
    next(err);
  }
});

import { runManualResearch, cleanupResearch } from '../services/research/managedAgent.js';
import { broadcastToUser } from '../services/research/connectionRegistry.js';
import type { MeetingType } from '../services/research/types.js';
import {
  emitDraft as emitGrarecoDraft,
  cancelPendingPromotion,
  promoteNow as promoteGrarecoNow,
  promotePendingForMeeting,
  dismissTopicShiftCandidate,
  fireFromUserConfirmation,
} from '../services/grareco/autoGrarecoOrchestrator.js';
import { loadHistoryForClient as loadTopicShiftHistory } from '../services/grareco/topicShiftHistoryService.js';
import type { GrarecoTriggerType } from '../services/grareco/types.js';

const manualResearchSchema = z.object({
  summarySections: z.array(z.object({
    heading: z.string(),
    fullText: z.string(),
    startMs: z.number().int().nonnegative().nullable(),
    endMs: z.number().int().nonnegative().nullable(),
  })).min(1).max(5),
});

const lastManualResearchAt = new Map<string, number>();
const MANUAL_RESEARCH_COOLDOWN_MS = 60 * 1000;

router.post('/:id/manual-research', async (req, res, next) => {
  try {
    const meetingId = Number(req.params.id);
    const userId = authUserId(req);
    const meeting = await getMeetingOrFail(meetingId, userId);
    if (!meeting) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }

    const cooldownKey = `${userId}:${meetingId}`;
    const last = lastManualResearchAt.get(cooldownKey) ?? 0;
    const elapsed = Date.now() - last;
    if (elapsed < MANUAL_RESEARCH_COOLDOWN_MS) {
      const waitSec = Math.ceil((MANUAL_RESEARCH_COOLDOWN_MS - elapsed) / 1000);
      res.status(429).json({ error: 'cooldown', message: `あと ${waitSec} 秒待ってから再実行してください` });
      return;
    }

    const { summarySections } = manualResearchSchema.parse(req.body);

    const rawRows = await db
      .select()
      .from(transcripts)
      .where(and(eq(transcripts.meetingId, meetingId), eq(transcripts.isFinal, true)))
      .orderBy(transcripts.startTime);

    const mResearchMapping = buildSpeakerMapping(meeting.participants);
    const allRows = filterNgTranscripts(
      applySpeakerMapping(rawRows, mResearchMapping),
      parseNgKeywords(meeting.ngKeywords)
    );

    const lines: string[] = [];
    const usedRowIds = new Set<number>();
    for (const sec of summarySections) {
      if (sec.startMs === null || sec.endMs === null) continue;
      for (const r of allRows) {
        if (usedRowIds.has(r.id)) continue;
        if (r.startTime >= sec.startMs && r.startTime <= sec.endMs) {
          const ts = formatTimestamp(r.startTime);
          const speaker = r.speaker ? `${r.speaker}: ` : '';
          lines.push(`[${ts}] ${speaker}${r.content}`);
          usedRowIds.add(r.id);
        }
      }
    }

    if (lines.length === 0) {
      res.status(400).json({ error: 'no_transcripts', message: '選択範囲に該当する文字起こしが見つかりませんでした' });
      return;
    }

    const combinedText = lines.join('\n');
    const headings = summarySections.map(s => s.heading);
    const meetingType = (meeting.meetingType ?? 'general') as MeetingType;

    lastManualResearchAt.set(cooldownKey, Date.now());

    res.json({ ok: true, accepted: true });

    (async () => {
      try {
        const emitFn = (event: string, data: unknown): void => {
          broadcastToUser(userId, event, data);
        };
        const result = await runManualResearch(meetingId, userId, meetingType, combinedText, headings, emitFn);
        if (!result.ok) {
          console.error(`[ManualResearch] failed: ${result.error}`);
        }
      } catch (err) {
        console.error('[ManualResearch] background error:', err);
      }
    })();
  } catch (err) {
    next(err);
  }
});

const manualGrarecoTriggerSchema = z.object({
  type: z.enum(['reflect', 'discover']),
});

const lastManualGrarecoAt = new Map<string, number>();
const MANUAL_GRARECO_COOLDOWN_MS = 30 * 1000;

router.post('/:id/grareco/manual-trigger', async (req, res, next) => {
  try {
    const meetingId = Number(req.params.id);
    const userId = authUserId(req);
    const meeting = await getMeetingOrFail(meetingId, userId);
    if (!meeting) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }

    const { type } = manualGrarecoTriggerSchema.parse(req.body);

    const cooldownKey = `${userId}:${meetingId}`;
    const last = lastManualGrarecoAt.get(cooldownKey) ?? 0;
    const elapsed = Date.now() - last;
    if (elapsed < MANUAL_GRARECO_COOLDOWN_MS) {
      const waitSec = Math.ceil((MANUAL_GRARECO_COOLDOWN_MS - elapsed) / 1000);
      res.status(429).json({ error: 'cooldown', message: `あと ${waitSec} 秒待ってから再実行してください` });
      return;
    }
    lastManualGrarecoAt.set(cooldownKey, Date.now());

    res.json({ ok: true, accepted: true });

    (async () => {
      const triggerType: GrarecoTriggerType = type === 'reflect' ? 'user_reflect' : 'user_discover';
      const isReflectFamily = type === 'reflect';
      try {
        await emitGrarecoDraft(meetingId, userId, triggerType, isReflectFamily);
      } catch (err) {
        console.error(`[grareco:manual-trigger] failed (type=${type}):`, err);
        broadcastToUser(userId, 'grareco_skipped', {
          recordingId: -1,
          meetingId,
          reason: 'generation_failed',
        });
      }
    })();
  } catch (err) {
    next(err);
  }
});

router.post('/:id/grareco/:recordingId/cancel-promote', async (req, res, next) => {
  try {
    const meetingId = Number(req.params.id);
    const recordingId = Number(req.params.recordingId);
    const meeting = await getMeetingOrFail(meetingId, authUserId(req));
    if (!meeting) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }
    const cancelled = cancelPendingPromotion(meetingId, recordingId);
    res.json({ ok: true, cancelled });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/grareco/:recordingId/promote-now', async (req, res, next) => {
  try {
    const meetingId = Number(req.params.id);
    const recordingId = Number(req.params.recordingId);
    const userId = authUserId(req);
    const meeting = await getMeetingOrFail(meetingId, userId);
    if (!meeting) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }
    res.json({ ok: true, accepted: true });
    promoteGrarecoNow(meetingId, userId, recordingId).catch((err) =>
      console.error('[grareco:promote-now] failed:', err),
    );
  } catch (err) {
    next(err);
  }
});

router.post('/:id/grareco/promote-pending', async (req, res, next) => {
  try {
    const meetingId = Number(req.params.id);
    const userId = authUserId(req);
    const meeting = await getMeetingOrFail(meetingId, userId);
    if (!meeting) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }
    res.json({ ok: true, accepted: true });
    promotePendingForMeeting(meetingId, userId).catch((err) =>
      console.error('[grareco:promote-pending] failed:', err),
    );
  } catch (err) {
    next(err);
  }
});

router.post('/:id/grareco/dismiss-topic-shift-candidate', async (req, res, next) => {
  try {
    const meetingId = Number(req.params.id);
    const meeting = await getMeetingOrFail(meetingId, authUserId(req));
    if (!meeting) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }
    const wasActive = dismissTopicShiftCandidate(meetingId);
    res.json({ ok: true, wasActive });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/grareco/confirm-topic-shift-candidate', async (req, res, next) => {
  try {
    const meetingId = Number(req.params.id);
    const userId = authUserId(req);
    const meeting = await getMeetingOrFail(meetingId, userId);
    if (!meeting) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }
    res.json({ ok: true, accepted: true });
    fireFromUserConfirmation(meetingId, userId).catch((err) =>
      console.error('[grareco:confirm-topic-shift] failed:', err),
    );
  } catch (err) {
    next(err);
  }
});

router.get('/:id/topic-shift-history', async (req, res, next) => {
  try {
    const meetingId = Number(req.params.id);
    const meeting = await getMeetingOrFail(meetingId, authUserId(req));
    if (!meeting) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }
    const sinceMs = Number(req.query.sinceMs ?? 0);
    const history = await loadTopicShiftHistory(meetingId, sinceMs);
    res.json(history);
  } catch (err) {
    next(err);
  }
});

const pinSchema = z.object({ pinned: z.boolean() });
router.patch('/:id/grareco/:recordingId/pin', async (req, res, next) => {
  try {
    const meetingId = Number(req.params.id);
    const recordingId = Number(req.params.recordingId);
    const meeting = await getMeetingOrFail(meetingId, authUserId(req));
    if (!meeting) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }
    const { pinned } = pinSchema.parse(req.body);
    await db
      .update(graphicRecordings)
      .set({ pinnedAt: pinned ? new Date() : null })
      .where(and(eq(graphicRecordings.id, recordingId), eq(graphicRecordings.meetingId, meetingId)));
    res.json({ ok: true, pinned });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/rebuild-summary', summaryRebuildLimiter, async (req, res, next) => {
  try {
    const meetingId = Number(req.params.id);
    const meeting = await getMeetingOrFail(meetingId, authUserId(req));
    if (!meeting) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }

    const summary = await rebuildMeetingSummary(meeting);
    if (!summary) {
      res.status(400).json({ error: '書き起こしデータがありません' });
      return;
    }
    res.json(summary);
  } catch (err) {
    next(err);
  }
});

export async function rebuildMeetingSummary(meeting: {
  id: number;
  participants: unknown;
  ngKeywords: unknown;
}) {
  const meetingId = meeting.id;
  const participants = Array.isArray(meeting.participants) ? (meeting.participants as any[]) : [];

  const { text, lines, maxTime } = await getTranscriptText(meetingId, {
    participants,
    ngKeywords: meeting.ngKeywords,
  });
  if (!text.trim()) return null;

  const [existing] = await db
    .select()
    .from(structuredSummaries)
    .where(eq(structuredSummaries.meetingId, meetingId))
    .orderBy(desc(structuredSummaries.updatedAt))
    .limit(1);

  const supplementaryItems = await getSupplementaryItems(meetingId).catch(() => []);
  const windows = splitTranscriptIntoWindows(lines);
  const generated = await rebuildStructuredSummary(
    windows.map((w, i) => ({
      transcript: w.lines.join('\n'),
      supplementaryContext: formatSupplementaryContext(
        supplementaryItems.filter((item) => windowIndexForElapsed(windows, item.elapsedMs) === i),
      ),
    })),
    participants,
  );

  if (existing) {
    await db
      .update(structuredSummaries)
      .set({ previousContent: existing.content, content: generated, lastProcessedTime: maxTime, updatedAt: new Date() })
      .where(eq(structuredSummaries.id, existing.id));
  } else {
    await db
      .insert(structuredSummaries)
      .values({ meetingId, content: generated, lastProcessedTime: maxTime });
  }

  const [afterSave] = await db
    .select()
    .from(structuredSummaries)
    .where(eq(structuredSummaries.meetingId, meetingId))
    .orderBy(desc(structuredSummaries.updatedAt))
    .limit(1);
  let finalContent = afterSave?.content ?? generated;
  if (afterSave) {
    const consolidated = await consolidateSummaryThemes(finalContent, participants);
    finalContent = withConsolidatedMarker(consolidated);
    await db
      .update(structuredSummaries)
      .set({ previousContent: afterSave.content, content: finalContent, updatedAt: new Date() })
      .where(eq(structuredSummaries.id, afterSave.id));
  }

  await reconcileSupplementaryIntoSummary(meetingId).catch((err) =>
    console.error('[rebuild-summary] supplementary reconcile failed:', err),
  );

  const [summary] = await db
    .select()
    .from(structuredSummaries)
    .where(eq(structuredSummaries.meetingId, meetingId))
    .orderBy(desc(structuredSummaries.updatedAt))
    .limit(1);

  syncSessionAfterRebuild(meetingId, summary?.content ?? finalContent);

  return summary ?? null;
}

export async function rebuildSummaryAtMeetingEnd(
  meeting: { id: number; participants: unknown; ngKeywords: unknown },
  currentSummary: string,
): Promise<string> {
  const started = Date.now();
  try {
    const rebuilt = await rebuildMeetingSummary(meeting);
    if (rebuilt?.content?.trim()) {
      console.log(`[MeetingEnd] meetingId=${meeting.id} サマリーを全文から作り直した（${Math.round((Date.now() - started) / 1000)}秒）`);
      return rebuilt.content;
    }
  } catch (err) {
    console.error(`[MeetingEnd] meetingId=${meeting.id} サマリーの作り直しに失敗。今のサマリーで続行:`, err);
  }
  return currentSummary;
}

router.get('/:id/structured-summary', async (req, res, next) => {
  try {
    const meetingId = Number(req.params.id);
    const meeting = await getMeetingOrFail(meetingId, authUserId(req));
    if (!meeting) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }

    const [summary] = await db
      .select()
      .from(structuredSummaries)
      .where(eq(structuredSummaries.meetingId, meetingId))
      .orderBy(desc(structuredSummaries.updatedAt))
      .limit(1);

    res.json(summary || null);
  } catch (err) {
    next(err);
  }
});

router.get('/:id/participants', async (req, res, next) => {
  try {
    const meeting = await getMeetingOrFail(Number(req.params.id), authUserId(req));
    if (!meeting) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }
    res.json(Array.isArray(meeting.participants) ? meeting.participants : []);
  } catch (err) {
    next(err);
  }
});

router.put('/:id/participants', async (req, res, next) => {
  try {
    const meetingId = Number(req.params.id);
    const { participants } = z.object({ participants: z.array(z.any()) }).parse(req.body);

    const meeting = await getMeetingOrFail(meetingId, authUserId(req));
    if (!meeting) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }

    const before = (Array.isArray(meeting.participants) ? (meeting.participants as any[]) : [])
      .map((p) => normalizeNameKey(String(p?.name ?? '')))
      .filter((k) => k);
    const after = participants
      .map((p) => normalizeNameKey(String(p?.name ?? '')))
      .filter((k) => k);
    const beforeSet = new Set(before);
    const afterSet = new Set(after);
    const deletedKeys = before.filter((k) => !afterSet.has(k));
    const restoredKeys = after.filter((k) => !beforeSet.has(k));

    const currentDismissed = Array.isArray(meeting.dismissedParticipantNames)
      ? (meeting.dismissedParticipantNames as string[]).filter((s) => typeof s === 'string')
      : [];
    const dismissedSet = new Set(currentDismissed);
    for (const k of deletedKeys) dismissedSet.add(k);
    for (const k of restoredKeys) dismissedSet.delete(k);
    const nextDismissed = Array.from(dismissedSet);

    const [updated] = await db
      .update(meetings)
      .set({ participants, dismissedParticipantNames: nextDismissed })
      .where(eq(meetings.id, meetingId))
      .returning();

    res.json(Array.isArray(updated.participants) ? updated.participants : []);
  } catch (err) {
    next(err);
  }
});

router.put('/:id/ng-keywords', async (req, res, next) => {
  try {
    const meetingId = Number(req.params.id);
    const { keywords } = z
      .object({ keywords: z.array(z.string().trim().min(1).max(100)).max(50) })
      .parse(req.body);

    const meeting = await getMeetingOrFail(meetingId, authUserId(req));
    if (!meeting) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }

    const deduped = Array.from(new Set(keywords.map((k) => k.trim()).filter(Boolean)));

    const [updated] = await db
      .update(meetings)
      .set({ ngKeywords: deduped })
      .where(eq(meetings.id, meetingId))
      .returning();

    res.json(Array.isArray(updated.ngKeywords) ? updated.ngKeywords : []);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/profile-participants', participantReprofileLimiter, async (req, res, next) => {
  try {
    const meetingId = Number(req.params.id);
    const userId = authUserId(req);
    const meeting = await getMeetingOrFail(meetingId, userId);
    if (!meeting) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }
    const windowSec = z.object({ windowSeconds: z.number().int().min(60).max(1800).optional() })
      .parse(req.body ?? {}).windowSeconds;
    const windowMs = windowSec ? windowSec * 1000 : undefined;

    const result = await triggerReprofile(meetingId, userId, { windowMs });
    if (result.cooldownRemainingMs > 0) {
      const waitSec = Math.ceil(result.cooldownRemainingMs / 1000);
      res.json({
        ok: false,
        reason: 'cooldown',
        message: `あと ${waitSec} 秒待ってから再実行してください`,
      });
      return;
    }
    res.json({ ok: true, extractedCount: result.extractedCount });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/participant-images', imageAnalysisLimiter, imageJsonBody, async (req, res, next) => {
  try {
    const meetingId = Number(req.params.id);
    const meeting = await getMeetingOrFail(meetingId, authUserId(req));
    if (!meeting) { res.status(404).json({ error: 'Meeting not found' }); return; }

    const { data, mimeType, fileName } = z.object({
      data: uploadImageData,
      mimeType: uploadImageMimeType,
      fileName: z.string().optional(),
    }).parse(req.body);

    const [inserted] = await db.insert(participantImages).values({
      meetingId,
      imageData: data,
      mimeType,
      fileName: fileName || null,
    }).returning();

    res.status(201).json(inserted);

    extractParticipantsFromImage(data, mimeType).then(async (extracted) => {
      await db.update(participantImages)
        .set({ aiExtractedParticipants: extracted })
        .where(eq(participantImages.id, inserted.id));
      await undismissNames(meetingId, extracted.map((p) => p.name));
      await mergeAndUpdateParticipants(meetingId);
      await refreshSessionKeyterms(meetingId);
      console.log(`[ParticipantImage] Extracted ${extracted.length} participants from image ${inserted.id}`);
    }).catch((err) => console.error('[ParticipantImage] Extraction error:', err));
  } catch (err) { next(err); }
});

router.get('/:id/participant-images', async (req, res, next) => {
  try {
    const meetingId = Number(req.params.id);
    const meeting = await getMeetingOrFail(meetingId, authUserId(req));
    if (!meeting) { res.status(404).json({ error: 'Meeting not found' }); return; }

    const { imageData: _data, ...listColumns } = getTableColumns(participantImages);
    const images = await db.select(listColumns).from(participantImages)
      .where(eq(participantImages.meetingId, meetingId))
      .orderBy(participantImages.createdAt);
    res.json(images.map((img) => ({ ...img, imageUrl: `/api/meetings/${meetingId}/participant-images/${img.id}/image` })));
  } catch (err) { next(err); }
});

router.get('/:id/participant-images/:imageId/image', async (req, res, next) => {
  try {
    const meetingId = Number(req.params.id);
    const imageId = Number(req.params.imageId);
    const meeting = await getMeetingOrFail(meetingId, authUserId(req));
    if (!meeting) { res.status(404).json({ error: 'Meeting not found' }); return; }

    const [row] = await db
      .select({ imageData: participantImages.imageData, mimeType: participantImages.mimeType })
      .from(participantImages)
      .where(and(eq(participantImages.id, imageId), eq(participantImages.meetingId, meetingId)));
    sendGrarecoImage(req, res, row ? `data:${row.mimeType};base64,${row.imageData}` : null);
  } catch (err) { next(err); }
});

router.delete('/:id/participant-images/:imageId', async (req, res, next) => {
  try {
    const meetingId = Number(req.params.id);
    const imageId = Number(req.params.imageId);
    const meeting = await getMeetingOrFail(meetingId, authUserId(req));
    if (!meeting) { res.status(404).json({ error: 'Meeting not found' }); return; }

    const deleted = await db.delete(participantImages)
      .where(and(eq(participantImages.id, imageId), eq(participantImages.meetingId, meetingId)))
      .returning();
    if (deleted.length === 0) { res.status(404).json({ error: 'Image not found' }); return; }

    await mergeAndUpdateParticipants(meetingId);
    await refreshSessionKeyterms(meetingId);
    res.json({ success: true });
  } catch (err) { next(err); }
});

router.post('/:id/participant-texts', imageAnalysisLimiter, async (req, res, next) => {
  try {
    const meetingId = Number(req.params.id);
    const meeting = await getMeetingOrFail(meetingId, authUserId(req));
    if (!meeting) { res.status(404).json({ error: 'Meeting not found' }); return; }

    const { content } = z.object({ content: z.string().min(1) }).parse(req.body);

    const [inserted] = await db.insert(participantTexts).values({
      meetingId,
      content,
    }).returning();

    res.status(201).json(inserted);

    extractParticipantsFromText(content).then(async (extracted) => {
      await db.update(participantTexts)
        .set({ aiExtractedParticipants: extracted })
        .where(eq(participantTexts.id, inserted.id));
      await undismissNames(meetingId, extracted.map((p) => p.name));
      await mergeAndUpdateParticipants(meetingId);
      await refreshSessionKeyterms(meetingId);
      console.log(`[ParticipantText] Extracted ${extracted.length} participants from text ${inserted.id}`);
    }).catch((err) => console.error('[ParticipantText] Extraction error:', err));
  } catch (err) { next(err); }
});

router.get('/:id/participant-texts', async (req, res, next) => {
  try {
    const meetingId = Number(req.params.id);
    const meeting = await getMeetingOrFail(meetingId, authUserId(req));
    if (!meeting) { res.status(404).json({ error: 'Meeting not found' }); return; }

    const texts = await db.select().from(participantTexts)
      .where(eq(participantTexts.meetingId, meetingId))
      .orderBy(participantTexts.createdAt);
    res.json(texts);
  } catch (err) { next(err); }
});

router.delete('/:id/participant-texts/:textId', async (req, res, next) => {
  try {
    const meetingId = Number(req.params.id);
    const textId = Number(req.params.textId);
    const meeting = await getMeetingOrFail(meetingId, authUserId(req));
    if (!meeting) { res.status(404).json({ error: 'Meeting not found' }); return; }

    const deleted = await db.delete(participantTexts)
      .where(and(eq(participantTexts.id, textId), eq(participantTexts.meetingId, meetingId)))
      .returning();
    if (deleted.length === 0) { res.status(404).json({ error: 'Text not found' }); return; }

    await mergeAndUpdateParticipants(meetingId);
    await refreshSessionKeyterms(meetingId);
    res.json({ success: true });
  } catch (err) { next(err); }
});

router.get('/:id/analyses', async (req, res, next) => {
  try {
    const meetingId = Number(req.params.id);
    const meeting = await getMeetingOrFail(meetingId, authUserId(req));
    if (!meeting) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }

    const rows = await db
      .select()
      .from(analyses)
      .where(eq(analyses.meetingId, meetingId))
      .orderBy(desc(analyses.createdAt));

    res.json(rows.filter((r) => r.type !== 'grareco'));
  } catch (err) {
    next(err);
  }
});

const manualGrarecoInFlight = new Set<string>();

router.post('/:id/analyze', meetingAnalysisLimiter, imageJsonBody, async (req, res, next) => {
  let grarecoLockKey: string | null = null;
  try {
    const meetingId = Number(req.params.id);
    const meeting = await getMeetingOrFail(meetingId, authUserId(req));
    if (!meeting) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }

    const { type, content, additionalContext, additionalPrompt, images } = req.body as {
      type: string;
      content?: string;
      additionalContext?: string;
      additionalPrompt?: string;
      images?: Array<{ data: string; mimeType: string }>;
    };

    if (!type) {
      res.status(400).json({ error: 'type is required' });
      return;
    }

    if (images && images.length > 0) {
      const validation = validateImages(images);
      if (!validation.valid) {
        res.status(400).json({ error: validation.error });
        return;
      }
    }

    const participants = Array.isArray(meeting.participants) ? (meeting.participants as any[]) : [];

    let sourceText = content || '';
    let usedMeetingTranscripts = false;
    if (!sourceText.trim()) {
      const { text } = await getTranscriptText(meetingId, { participants, ngKeywords: meeting.ngKeywords });
      sourceText = text;
      usedMeetingTranscripts = true;
    }

    if (!sourceText.trim()) {
      res.status(400).json({ error: '分析するテキストがありません' });
      return;
    }

    if (type === 'grareco') {
      const currentUserId = authUserId(req);
      const lockKey = `${currentUserId}:${meetingId}`;
      if (manualGrarecoInFlight.has(lockKey)) {
        res.status(429).json({ error: 'in_progress', message: 'グラレコを生成中です。完了までお待ちください' });
        return;
      }
      manualGrarecoInFlight.add(lockKey);
      grarecoLockKey = lockKey;

      let imageAnalysisText: string | undefined;
      if (images && images.length > 0) {
        imageAnalysisText = await analyzeImagesForGrareco(images);
      }

      const GRARECO_TRANSCRIPT_LIMIT = 3000;
      const grarecoSourceText = (() => {
        const TRANSCRIPT_MARKERS = ['【全文書き起こし】', '【文字起こし（全体）】', '【文字起こし（該当部分）】'];
        let splitIdx = -1;
        let foundMarker = '';
        for (const m of TRANSCRIPT_MARKERS) {
          const idx = sourceText.indexOf(m);
          if (idx !== -1) { splitIdx = idx; foundMarker = m; break; }
        }

        const headerText = splitIdx !== -1 ? sourceText.substring(0, splitIdx) : sourceText;
        const transcriptBody = splitIdx !== -1 ? sourceText.substring(splitIdx + foundMarker.length) : '';

        const participantsSection = buildParticipantsSection(participants.filter((p: any) => p.name));
        const parts: string[] = [];
        if (headerText.trim()) parts.push(headerText.trim());
        if (participantsSection) parts.push(participantsSection);
        if (transcriptBody.trim()) {
          const truncated = transcriptBody.length > GRARECO_TRANSCRIPT_LIMIT
            ? transcriptBody.substring(0, GRARECO_TRANSCRIPT_LIMIT) + '\n（以下省略）'
            : transcriptBody;
          parts.push(`${foundMarker || '【全文書き起こし】'}\n${truncated}`);
        }
        return parts.join('\n\n');
      })();
      console.log(`[Grareco-Manual] テキスト構築: 元=${sourceText.length}文字 → ${grarecoSourceText.length}文字（参加者: ${participants.filter((p: any) => p.name).length}名）`);

      const result: GrarecoImageResult = await generateManualGrareco(
        grarecoSourceText,
        {
          additionalContext: additionalContext || undefined,
          additionalPrompt,
          imageAnalysisText,
        },
        generateGraphicRecording,
        {
          material: sourceText,
          meetingDate: meeting.startedAt ? new Date(meeting.startedAt) : undefined,
          participants: participants.filter((p: any) => p.name),
          meetingType: meeting.meetingType,
        },
      );

      const metadata: Record<string, unknown> = {
        clipboardTextLength: content?.length || 0,
        clipboardTextPreview: (content || '').substring(0, 200),
        hasAdditionalContext: !!additionalContext,
        hasAdditionalPrompt: !!additionalPrompt,
        imageCount: images?.length || 0,
        imageAnalysisText: imageAnalysisText ? imageAnalysisText.substring(0, 500) : undefined,
        additionalContextPreview: additionalContext ? additionalContext.substring(0, 200) : undefined,
        additionalContextFull: additionalContext || undefined,
        additionalPromptPreview: additionalPrompt ? additionalPrompt.substring(0, 200) : undefined,
        additionalPromptFull: additionalPrompt || undefined,
        usedMeetingTranscripts,
        modelUsed: result.modelUsed,
        costUsd: result.costUsd,
        aspectRatio: result.aspectRatio,
        imageDimensions: result.imageDimensions,
        refImagesUsed: result.refImagesUsed,
        attempt: result.attempt,
        imageQuality: result.imageQuality,
        draftSections: result.draftSections,
        draftKind: result.draftKind,
        fallbackReason: result.fallbackReason,
        sourceTextChars: sourceText.length,
      };

      const [gr] = await db
        .insert(graphicRecordings)
        .values({ meetingId, sourceText, imageUrl: result.imageUrl, metadata })
        .returning();

      res.status(201).json({
        ...gr,
        imageUrl: gr.imageUrl ? `/api/meetings/${meetingId}/grareco/${gr.id}/image` : null,
      });
    } else {
      const analysisContent = await analyzeTranscript(sourceText, type as AnalysisType, {
        additionalContext: additionalContext || undefined,
        additionalPrompt,
        images,
        participants: participants.filter((p: any) => p.name),
      });

      const metadata: Record<string, unknown> = {
        usedMeetingTranscripts,
        clipboardTextLength: content?.length || 0,
        clipboardTextPreview: (content || '').substring(0, 200),
        hasAdditionalContext: !!additionalContext,
        hasAdditionalPrompt: !!additionalPrompt,
        imageCount: images?.length || 0,
        additionalContextPreview: additionalContext ? additionalContext.substring(0, 200) : undefined,
        additionalPromptPreview: additionalPrompt ? additionalPrompt.substring(0, 200) : undefined,
      };

      const [analysis] = await db
        .insert(analyses)
        .values({ meetingId, type, content: analysisContent, metadata })
        .returning();

      res.status(201).json(analysis);
    }
  } catch (err) {
    next(err);
  } finally {
    if (grarecoLockKey) manualGrarecoInFlight.delete(grarecoLockKey);
  }
});

router.get('/:id/graphic-recordings', async (req, res, next) => {
  try {
    const meetingId = Number(req.params.id);
    const meeting = await getMeetingOrFail(meetingId, authUserId(req));
    if (!meeting) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }

    const { imageUrl: _image, ...listColumns } = getTableColumns(graphicRecordings);
    const rows = await db
      .select({ ...listColumns, hasImage: sql<boolean>`${graphicRecordings.imageUrl} is not null` })
      .from(graphicRecordings)
      .where(eq(graphicRecordings.meetingId, meetingId))
      .orderBy(desc(graphicRecordings.createdAt));

    res.json(
      rows.map(({ hasImage, ...rest }) => ({
        ...rest,
        imageUrl: hasImage ? `/api/meetings/${meetingId}/grareco/${rest.id}/image` : null,
      })),
    );
  } catch (err) {
    next(err);
  }
});

router.get('/:id/grareco/:recordingId/image', async (req, res, next) => {
  try {
    const meetingId = Number(req.params.id);
    const recordingId = Number(req.params.recordingId);
    const meeting = await getMeetingOrFail(meetingId, authUserId(req));
    if (!meeting) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }
    const where = and(eq(graphicRecordings.id, recordingId), eq(graphicRecordings.meetingId, meetingId));
    if (req.query.size === 'thumb') {
      const [h] = await db
        .select({ hash: sql<string | null>`md5(${graphicRecordings.imageUrl})` })
        .from(graphicRecordings)
        .where(where);
      await sendGrarecoThumbnail(req, res, h?.hash ?? null, async () => {
        const [row] = await db.select({ imageUrl: graphicRecordings.imageUrl }).from(graphicRecordings).where(where);
        return row?.imageUrl ?? null;
      });
      return;
    }
    const [row] = await db
      .select({ imageUrl: graphicRecordings.imageUrl })
      .from(graphicRecordings)
      .where(where);
    sendGrarecoImage(req, res, row?.imageUrl ?? null);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/graphic-recording/:recordingId/revise', async (req, res, next) => {
  let reviseLockKey: string | null = null;
  try {
    const meetingId = Number(req.params.id);
    const recordingId = Number(req.params.recordingId);

    const meeting = await getMeetingOrFail(meetingId, authUserId(req));
    if (!meeting) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }

    const [original] = await db
      .select()
      .from(graphicRecordings)
      .where(and(eq(graphicRecordings.id, recordingId), eq(graphicRecordings.meetingId, meetingId)));

    if (!original) {
      res.status(404).json({ error: 'Graphic recording not found' });
      return;
    }

    const { instruction } = z.object({
      instruction: z.string().min(2),
    }).parse(req.body);

    if (!original.imageUrl) {
      res.status(400).json({ error: 'Cannot revise a draft-only graphic recording (no image yet)' });
      return;
    }

    const currentUserId = authUserId(req);
    const lockKey = `${currentUserId}:${meetingId}`;
    if (manualGrarecoInFlight.has(lockKey)) {
      res.status(429).json({ error: 'in_progress', message: 'グラレコを生成中です。完了までお待ちください' });
      return;
    }
    manualGrarecoInFlight.add(lockKey);
    reviseLockKey = lockKey;

    const revised = await reviseGraphicRecording(original.imageUrl, original.sourceText, instruction);

    const metadata = {
      ...((original.metadata as Record<string, unknown>) || {}),
      revised: true,
      revisionInstruction: instruction,
      modelUsed: revised.modelUsed,
      costUsd: revised.costUsd,
    };

    const [gr] = await db
      .insert(graphicRecordings)
      .values({
        meetingId,
        sourceText: original.sourceText,
        imageUrl: revised.imageUrl,
        metadata,
      })
      .returning();

    res.status(201).json({
      ...gr,
      imageUrl: gr.imageUrl ? `/api/meetings/${meetingId}/grareco/${gr.id}/image` : null,
    });
  } catch (err) {
    next(err);
  } finally {
    if (reviseLockKey) manualGrarecoInFlight.delete(reviseLockKey);
  }
});

router.post('/:id/images', imageAnalysisLimiter, imageJsonBody, async (req, res, next) => {
  try {
    const meetingId = Number(req.params.id);
    const meeting = await getMeetingOrFail(meetingId, authUserId(req));
    if (!meeting) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }

    const body = z.object({
      data: uploadImageData,
      mimeType: uploadImageMimeType,
      fileName: z.string().optional(),
      originalData: uploadImageData.optional(),
      originalMimeType: uploadImageMimeType.optional(),
    }).parse(req.body);

    const image = await processMeetingImageUpload(meetingId, meeting.startedAt, body);
    res.status(201).json(image);
  } catch (err) {
    next(err);
  }
});

router.get('/:id/images', async (req, res, next) => {
  try {
    const meetingId = Number(req.params.id);
    const meeting = await getMeetingOrFail(meetingId, authUserId(req));
    if (!meeting) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }

    const rows = await db.select().from(meetingImages)
      .where(eq(meetingImages.meetingId, meetingId))
      .orderBy(desc(meetingImages.uploadedAt));

    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/:id/observations', async (req, res, next) => {
  try {
    const meetingId = Number(req.params.id);
    const meeting = await getMeetingOrFail(meetingId, authUserId(req));
    if (!meeting) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }

    const rows = await db.select().from(meetingObservations)
      .where(eq(meetingObservations.meetingId, meetingId))
      .orderBy(meetingObservations.capturedAt);

    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id/observations/:obsId', async (req, res, next) => {
  try {
    const meetingId = Number(req.params.id);
    const obsId = Number(req.params.obsId);
    const meeting = await getMeetingOrFail(meetingId, authUserId(req));
    if (!meeting) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }

    const [obs] = await db.select().from(meetingObservations)
      .where(and(eq(meetingObservations.id, obsId), eq(meetingObservations.meetingId, meetingId)));
    if (!obs) {
      res.status(404).json({ error: 'Observation not found' });
      return;
    }

    if (obs.linkedImageId != null) {
      const others = await db.select({ id: meetingObservations.id })
        .from(meetingObservations)
        .where(and(
          eq(meetingObservations.meetingId, meetingId),
          eq(meetingObservations.linkedImageId, obs.linkedImageId),
        ));
      const sharedByOthers = others.some((o) => o.id !== obsId);
      if (!sharedByOthers) {
        await db.delete(meetingImages)
          .where(and(eq(meetingImages.id, obs.linkedImageId), eq(meetingImages.meetingId, meetingId)));
        await removeSupplementaryFromSummary(meetingId, `image:${obs.linkedImageId}`)
          .catch((err) => console.error('[observation:delete] summary removal failed:', err));
      }
    }

    await db.delete(meetingObservations)
      .where(and(eq(meetingObservations.id, obsId), eq(meetingObservations.meetingId, meetingId)));

    res.json({ ok: true, deletedObservationId: obsId, deletedImageId: obs.linkedImageId ?? null });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id/images/:imgId', async (req, res, next) => {
  try {
    const meetingId = Number(req.params.id);
    const imgId = Number(req.params.imgId);
    const meeting = await getMeetingOrFail(meetingId, authUserId(req));
    if (!meeting) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }

    const [deleted] = await db.delete(meetingImages)
      .where(and(eq(meetingImages.id, imgId), eq(meetingImages.meetingId, meetingId)))
      .returning();

    if (!deleted) {
      res.status(404).json({ error: 'Image not found' });
      return;
    }

    const removeSummarySection =
      req.query.removeSummarySection === 'true' || req.body?.removeSummarySection === true;
    if (removeSummarySection) {
      await removeSupplementaryFromSummary(meetingId, `image:${imgId}`)
        .catch((err) => console.error('[summaryRemove:image] failed:', err));
    }

    res.json({ ok: true, summarySectionRemoved: removeSummarySection });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/memos', async (req, res, next) => {
  try {
    const meetingId = Number(req.params.id);
    const meeting = await getMeetingOrFail(meetingId, authUserId(req));
    if (!meeting) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }

    const { content } = z.object({
      content: z.string().min(1),
    }).parse(req.body);

    const now = new Date();
    const meetingElapsedMs = meeting.startedAt
      ? Math.round(now.getTime() - new Date(meeting.startedAt).getTime())
      : null;

    const [memo] = await db.insert(meetingMemos).values({
      meetingId,
      content,
      meetingElapsedMs,
    }).returning();

    appendSupplementaryToSummary({
      meetingId,
      marker: `memo:${memo.id}`,
      heading: `メモ`,
      content: memo.content,
      elapsedTimeLabel: formatElapsedLabel(memo.meetingElapsedMs),
    }).catch((err) => console.error('[summaryAppend:memo] failed:', err));

    res.status(201).json(memo);
  } catch (err) {
    next(err);
  }
});

router.get('/:id/memos', async (req, res, next) => {
  try {
    const meetingId = Number(req.params.id);
    const meeting = await getMeetingOrFail(meetingId, authUserId(req));
    if (!meeting) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }

    const rows = await db.select().from(meetingMemos)
      .where(eq(meetingMemos.meetingId, meetingId))
      .orderBy(desc(meetingMemos.createdAt));

    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.patch('/:id/memos/:memoId', async (req, res, next) => {
  try {
    const meetingId = Number(req.params.id);
    const memoId = Number(req.params.memoId);
    const meeting = await getMeetingOrFail(meetingId, authUserId(req));
    if (!meeting) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }

    const { content } = z.object({
      content: z.string().min(1),
    }).parse(req.body);

    const [updated] = await db.update(meetingMemos)
      .set({ content, updatedAt: new Date() })
      .where(and(eq(meetingMemos.id, memoId), eq(meetingMemos.meetingId, meetingId)))
      .returning();

    if (!updated) {
      res.status(404).json({ error: 'Memo not found' });
      return;
    }
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id/memos/:memoId', async (req, res, next) => {
  try {
    const meetingId = Number(req.params.id);
    const memoId = Number(req.params.memoId);
    const meeting = await getMeetingOrFail(meetingId, authUserId(req));
    if (!meeting) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }

    const [deleted] = await db.delete(meetingMemos)
      .where(and(eq(meetingMemos.id, memoId), eq(meetingMemos.meetingId, meetingId)))
      .returning();

    if (!deleted) {
      res.status(404).json({ error: 'Memo not found' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/term-glossary', async (req, res, next) => {
  try {
    const meetingId = Number(req.params.id);
    const meeting = await getMeetingOrFail(meetingId, authUserId(req));
    if (!meeting) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }

    const terms = await getDetectedTermsByMeeting(meetingId);
    res.json(terms);
  } catch (err) {
    next(err);
  }
});

router.get('/:id/research-insights', async (req, res, next) => {
  try {
    const meetingId = Number(req.params.id);
    const meeting = await getMeetingOrFail(meetingId, authUserId(req));
    if (!meeting) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }

    const results = await db.select().from(researchInsights)
      .where(eq(researchInsights.meetingId, meetingId))
      .orderBy(desc(researchInsights.createdAt));

    const cards = results.map(r => {
      let content: Record<string, unknown> = {};
      try {
        content = typeof r.content === 'string' ? JSON.parse(r.content) : {};
      } catch {
      }
      return {
        id: String(r.id),
        cardType: r.cardType,
        agentType: r.agentType,
        keyword: r.keyword ?? '',
        title: (content.title as string) ?? r.keyword ?? '',
        body: (content.body as string) ?? '',
        importance: r.importance ?? 50,
        sources: (content.sources as Array<unknown>) ?? [],
        timestamp: r.createdAt.getTime(),
        metadata: (r.metadata as Record<string, unknown>) ?? {},
      };
    });

    res.json(cards);
  } catch (err) {
    next(err);
  }
});

export default router;
