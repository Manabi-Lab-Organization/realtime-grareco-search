import { runWithAuditContext } from '../services/audit/requestContext.js';
import { serverFeatures } from '../services/features.js';
import { Server as SocketIOServer, Socket } from 'socket.io';
import { Server as HTTPServer } from 'http';
import { db } from '../db/index.js';
import { meetings, transcripts, structuredSummaries, analyses, graphicRecordings, users } from '../db/schema.js';
import { eq, and, desc, ne } from 'drizzle-orm';
import { ElevenLabsSession, ElevenLabsTranscriptEvent } from '../services/elevenLabsService.js';
import { buildKeyterms } from '../services/keytermsBuilder.js';
import { generateStructuredSummary, generateMeetingTitle, generateMeetingMinutes, generateGraphicRecording, consolidateSummaryThemes, hasConsolidatedMarker, withConsolidatedMarker } from '../services/geminiService.js';
import { buildParticipantsSection } from '../services/grareco/grarecoPrompt.js';
import { sendMeetingMinutesEmail } from '../services/emailService.js';
import { getSupplementaryContext, rebuildSummaryAtMeetingEnd } from '../routes/meetings.js';
import { generateManualGrareco } from '../services/grareco/manualGrareco.js';
import { reconcileSupplementaryIntoSummary } from '../services/summaryAppendService.js';
import { detectAndExplainTerms, excludeTerm, clearMeetingCache } from '../services/termGlossaryService.js';
import { markPausedSet, foldPausedSet, resumeSet, recordedSecondsAt, recordedDurationSeconds } from '../services/recordingMeter.js';
import { recordingMsForNewTranscript } from '../services/recordingClock.js';
import { markAudioReceived } from '../services/audioWatchdog.js';
import { acquireRecording, registerRecording, releaseRecording, pauseRecording, getActiveRecording, markMeetingEnded, wasRecentlyEndedByOther, clearRecentEnd, type ActiveRecording, type ConnectionType } from './meetingRegistry.js';
import { issueAudioToken } from './browserAudioWs.js';
import { onFinalTranscript, cleanupResearch, fetchUserResearchSettings } from '../services/research/managedAgent.js';
import { maybeTriggerInitialProfile, clearMeetingProfileState } from '../services/participantProfileTrigger.js';
import { registerConnection, unregisterConnection, broadcastToUser } from '../services/research/connectionRegistry.js';
import { processFinalTranscript as autoGrarecoOnTranscript, cleanupAutoGrareco } from '../services/grareco/autoGrarecoOrchestrator.js';
import { isMeetingType, type MeetingType } from '../services/research/types.js';
import { applySocketAuth } from '../middleware/socketAuth.js';
import { setPartialTranscript, clearPartialTranscript, getPartialTranscript } from './transcriptCache.js';
import { parseNgKeywords, filterNgTranscripts } from '../services/ngKeywordFilterService.js';
import { allowedBrowserOrigins, normalizeOrigin } from '../config/allowedOrigins.js';
export { getPartialTranscript };

interface ActiveSession {
  meetingId: number;
  userId: number;
  elevenlabs: ElevenLabsSession;
  watchdogTimer: NodeJS.Timeout | null;
  summaryTimer: NodeJS.Timeout | null;
  lastAudioTime: number;
  sessionStartTime: number;
}

const activeSessions = new Map<string, ActiveSession>();
const WATCHDOG_TIMEOUT = 5 * 60 * 1000;
const SUMMARY_INTERVAL = 180 * 1000;
const CONSOLIDATION_THRESHOLD_SEC = 900;
const DISCONNECT_GRACE_PERIOD = 10 * 60 * 1000;
const consolidationDone = new Set<number>();

async function sendMeetingEndEmail(meetingId: number, userId: number, title: string, endedAt: Date) {
  console.log(`[MeetingEmail] meetingId=${meetingId} メール送信処理を開始...`);

  try {
    const [mtgCheck] = await db.select().from(meetings).where(eq(meetings.id, meetingId));
    if (mtgCheck?.emailSentAt) {
      console.log(`[MeetingEmail] meetingId=${meetingId} メール送信済み（${mtgCheck.emailSentAt}）— スキップ`);
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
    let summaryContent = summary?.content || '';

    const allTranscriptRows = await db
      .select()
      .from(transcripts)
      .where(and(eq(transcripts.meetingId, meetingId), eq(transcripts.isFinal, true)))
      .orderBy(transcripts.startTime);
    const rows = filterNgTranscripts(allTranscriptRows, parseNgKeywords(mtgCheck?.ngKeywords));
    const transcriptText = rows.map((r) => {
      const totalSeconds = Math.floor(r.startTime / 1000);
      const mins = Math.floor(totalSeconds / 60);
      const secs = totalSeconds % 60;
      const ts = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
      const speaker = r.speaker ? `${r.speaker}: ` : '';
      return `[${ts}] ${speaker}${r.content}`;
    }).join('\n');

    if (!transcriptText && !summaryContent) {
      console.log(`[MeetingEmail] meetingId=${meetingId} 文字起こし・サマリーが空のためスキップ`);
      await db.update(meetings).set({ emailSentAt: null }).where(eq(meetings.id, meetingId)).catch(() => {});
      return;
    }

    const MIN_DURATION_MS = 3 * 60 * 1000;
    const MIN_TRANSCRIPT_LENGTH = 200;
    const rawTranscriptLength = rows.reduce((sum, r) => sum + (r.content?.length || 0), 0);
    const durationMs = mtgCheck?.startedAt
      ? endedAt.getTime() - new Date(mtgCheck.startedAt).getTime()
      : 0;
    console.log(
      `[MeetingEmail] meetingId=${meetingId} 判定 duration=${Math.floor(durationMs / 1000)}秒 transcript=${rawTranscriptLength}文字 startedAt=${mtgCheck?.startedAt ? new Date(mtgCheck.startedAt).toISOString() : 'NULL'}`,
    );
    if (durationMs < MIN_DURATION_MS || rawTranscriptLength < MIN_TRANSCRIPT_LENGTH) {
      console.log(`[MeetingEmail] meetingId=${meetingId} テスト操作と判断してスキップ（時間=${Math.floor(durationMs / 1000)}秒, 文字数=${rawTranscriptLength}文字）`);
      await db.update(meetings).set({ emailSentAt: null }).where(eq(meetings.id, meetingId)).catch(() => {});
      return;
    }

    const [mtg] = await db.select().from(meetings).where(eq(meetings.id, meetingId));
    const participantsArray = Array.isArray(mtg?.participants) ? mtg.participants as any[] : [];

    summaryContent = await rebuildSummaryAtMeetingEnd(
      { id: meetingId, participants: mtg?.participants, ngKeywords: mtg?.ngKeywords },
      summaryContent,
    );

    if (mtg && !mtg.isTitleEdited && summaryContent) {
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

    const sourceTextParts: string[] = [];
    if (summaryContent) sourceTextParts.push(`【サマリー】\n${summaryContent}`);
    if (supplementary) sourceTextParts.push(supplementary);
    if (transcriptText) sourceTextParts.push(`【全文書き起こし】\n${transcriptText}`);
    const sourceText = sourceTextParts.join('\n\n') || transcriptText;

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
    console.log(`[MeetingEmail] グラレコ用テキスト: ${grarecoSourceText.length}文字（書き起こし: ${Math.min(transcriptText.length, GRARECO_TRANSCRIPT_LIMIT)}文字, 参加者: ${participantsArray.length}名）`);

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
        meetingType: mtg?.meetingType,
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

    console.log(`[MeetingEmail] meetingId=${meetingId} メール送信完了 userId=${userId}`);
  } catch (err) {
    console.error(`[MeetingEmail] meetingId=${meetingId} メール送信失敗:`, err);
    await db.update(meetings).set({ emailSentAt: null }).where(eq(meetings.id, meetingId)).catch(() => {});
    console.log(`[MeetingEmail] meetingId=${meetingId} emailSentAtをリセット（再送信可能）`);
  }
}

function resetWatchdog(socketId: string): void {
  const session = activeSessions.get(socketId);
  if (!session) return;

  if (session.watchdogTimer) clearTimeout(session.watchdogTimer);
  session.lastAudioTime = Date.now();
  session.watchdogTimer = setTimeout(() => {
    console.log(`[Watchdog] Reconnecting ElevenLabs for socket ${socketId}`);
    session.elevenlabs.close();
    session.elevenlabs.connect();
  }, WATCHDOG_TIMEOUT);
}

async function saveTranscript(
  meetingId: number,
  event: ElevenLabsTranscriptEvent,
  meetingStartTime: number
): Promise<void> {
  if (!event.text?.trim()) return;

  const elapsedMs = Date.now() - meetingStartTime;
  const durationMs =
    event.start !== undefined && event.end !== undefined
      ? Math.round((event.end - event.start) * 1000)
      : 0;

  let speakerId: number | null = null;
  if (event.speaker_id) {
    const match = event.speaker_id.match(/(\d+)/);
    if (match) speakerId = parseInt(match[1], 10);
  }

  const [mtgForTime] = await db.select().from(meetings).where(eq(meetings.id, meetingId)).catch(() => [null as any]);
  const recordingMs = await recordingMsForNewTranscript(mtgForTime);

  await db.insert(transcripts).values({
    meetingId,
    content: event.text,
    speaker: speakerId !== null ? `話者${speakerId + 1}` : null,
    speakerId,
    startTime: elapsedMs,
    endTime: elapsedMs + durationMs,
    recordingMs,
    isFinal: true,
    confidence: event.confidence?.toString() ?? null,
  });

  const mtgForRestore = mtgForTime;
  if (mtgForRestore && mtgForRestore.status === 'completed' && !mtgForRestore.endedAt) {
    await db
      .update(meetings)
      .set({ status: 'active', ...resumeSet })
      .where(eq(meetings.id, meetingId))
      .catch((err) => console.error('[SocketIO] Error restoring active status:', err));
  }
}

async function runSummaryUpdate(meetingId: number, force = false): Promise<void> {
  try {
    const [meeting] = await db.select().from(meetings).where(eq(meetings.id, meetingId));
    if (!meeting) return;
    if (!force && meeting.status !== 'active') return;

    const [existing] = await db
      .select()
      .from(structuredSummaries)
      .where(eq(structuredSummaries.meetingId, meetingId))
      .orderBy(desc(structuredSummaries.updatedAt))
      .limit(1);

    const lastProcessedTime = existing?.lastProcessedTime ?? -1;

    const allRows = await db
      .select()
      .from(transcripts)
      .where(and(eq(transcripts.meetingId, meetingId), eq(transcripts.isFinal, true)))
      .orderBy(transcripts.startTime);

    const newRows = lastProcessedTime < 0
      ? allRows
      : allRows.filter((r) => r.startTime > lastProcessedTime);
    if (newRows.length === 0) return;

    const newMaxTime = newRows[newRows.length - 1].startTime;

    const ngKeywords = parseNgKeywords(meeting.ngKeywords);
    const visibleRows = filterNgTranscripts(newRows, ngKeywords);
    if (visibleRows.length === 0) {
      if (existing) {
        await db
          .update(structuredSummaries)
          .set({ lastProcessedTime: newMaxTime, updatedAt: new Date() })
          .where(eq(structuredSummaries.id, existing.id));
      }
      return;
    }

    const formatTs = (ms: number) => {
      const totalSeconds = Math.floor(ms / 1000);
      const mins = Math.floor(totalSeconds / 60);
      const secs = totalSeconds % 60;
      return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    };

    const newText = visibleRows
      .map((r) => {
        const ts = formatTs(r.recordingMs ?? r.startTime);
        const speaker = r.speaker ? `${r.speaker}: ` : '';
        return `[${ts}] ${speaker}${r.content}`;
      })
      .join('\n');

    if (!newText.trim()) return;

    const participants = Array.isArray(meeting.participants) ? (meeting.participants as any[]) : [];
    const newContent = await generateStructuredSummary(
      newText,
      existing?.content ?? null,
      participants,
    );

    let savedContent = newContent;
    if (existing) {
      savedContent = hasConsolidatedMarker(existing.content)
        ? withConsolidatedMarker(newContent)
        : newContent;
      await db
        .update(structuredSummaries)
        .set({
          previousContent: existing.content,
          content: savedContent,
          lastProcessedTime: newMaxTime,
          updatedAt: new Date(),
        })
        .where(eq(structuredSummaries.id, existing.id));
    } else {
      await db.insert(structuredSummaries).values({
        meetingId,
        content: savedContent,
        lastProcessedTime: newMaxTime,
      });
      await reconcileSupplementaryIntoSummary(meetingId).catch((err) =>
        console.error('[Summary] supplementary reconcile failed:', err),
      );
    }

    console.log(`[Summary] Updated for meeting ${meetingId}`);

    if (existing && !hasConsolidatedMarker(savedContent)) {
      const recordedSec = recordedSecondsAt(
        meeting.transcriptionStartedAt,
        Date.now(),
        meeting.pausedSeconds,
        meeting.pausedSince,
      );
      if (recordedSec >= CONSOLIDATION_THRESHOLD_SEC) {
        try {
          const consolidated = await consolidateSummaryThemes(savedContent, participants);
          const marked = withConsolidatedMarker(consolidated);
          const [summaryRow] = await db
            .select()
            .from(structuredSummaries)
            .where(eq(structuredSummaries.meetingId, meetingId))
            .orderBy(desc(structuredSummaries.updatedAt))
            .limit(1);
          if (summaryRow) {
            await db
              .update(structuredSummaries)
              .set({ content: marked, updatedAt: new Date() })
              .where(eq(structuredSummaries.id, summaryRow.id));
          }
          console.log(`[Summary] Themes consolidated for meeting ${meetingId} (recordedSec=${recordedSec})`);
        } catch (e) {
          console.error('[Summary] Consolidation error:', e);
        }
      }
    }
  } catch (err) {
    console.error('[Summary] Error:', err);
  }
}

export function setupSocketIO(httpServer: HTTPServer): SocketIOServer {
  const allowedWsOrigins = allowedBrowserOrigins();

  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: allowedWsOrigins,
      credentials: true,
    },
    allowRequest: (req, cb) => {
      const origin = req.headers.origin;
      if (!origin || allowedWsOrigins.includes(normalizeOrigin(origin))) {
        cb(null, true);
      } else {
        console.warn(`[SocketIO] Rejected handshake from disallowed origin=${origin}`);
        cb('origin_not_allowed', false);
      }
    },
    pingInterval: 25000,
    pingTimeout: 10000,
  });

  applySocketAuth(io);

  io.on('connection', (socket: Socket) => {
    const userId = socket.data.userId;
    socket.use((_packet, next) => runWithAuditContext({ channel: 'socketio', actorId: userId }, () => next()));
    console.log(`[SocketIO] Client connected: ${socket.id}, userId=${userId}`);

    registerConnection({
      id: socket.id,
      userId,
      tokenId: socket.data.tokenId ?? null,
      sessionId: (socket.request as { sessionID?: string }).sessionID ?? null,
      emit: (eventName, data) => socket.emit(eventName, data),
      isAlive: () => socket.connected,
    });
    socket.on('disconnect', () => {
      unregisterConnection(userId, socket.id);
    });

    void (async () => {
      try {
        const settings = await fetchUserResearchSettings(userId);
        socket.emit('research_settings_updated', settings);
      } catch (e) {
        console.error('[SocketIO] initial research settings push failed:', e instanceof Error ? e.message : String(e));
      }
    })();

    socket.on('start_meeting', async ({ meetingId, mode }: { meetingId: number; mode?: 'online' | 'real' }) => {
      if (activeSessions.has(socket.id)) {
        socket.emit('error', { message: 'Session already active' });
        return;
      }

      const apiKey = process.env.ELEVENLABS_API_KEY;
      if (!apiKey) {
        socket.emit('error', { message: 'ElevenLabs API key not configured' });
        return;
      }

      const [meeting] = await db
        .select()
        .from(meetings)
        .where(and(eq(meetings.id, meetingId), eq(meetings.userId, userId)));

      if (!meeting) {
        socket.emit('error', { message: 'Meeting not found' });
        return;
      }

      const meetingStartTime = Date.now();
      const meetingMode = mode || 'real';
      const initialKeyterms = await buildKeyterms(meetingId);

      const elevenlabs = new ElevenLabsSession(
        apiKey,
        async (event: ElevenLabsTranscriptEvent) => {
          if (!event.text?.trim()) return;

          const elapsedSec = (Date.now() - meetingStartTime) / 1000;
          const speakerNum = event.speaker_id?.match(/(\d+)/)?.[1];
          socket.emit('transcript', {
            transcript: event.text,
            isFinal: event.isFinal,
            speaker: speakerNum !== undefined ? parseInt(speakerNum, 10) : undefined,
            start: elapsedSec,
            duration:
              event.start !== undefined && event.end !== undefined
                ? event.end - event.start
                : undefined,
            confidence: event.confidence,
          });

          if (event.isFinal) {
            clearPartialTranscript(meetingId);
            await saveTranscript(meetingId, event, meetingStartTime).catch((err) =>
              console.error('[SocketIO] Save transcript error:', err)
            );
            detectAndExplainTerms(event.text, meetingId, userId, meetingStartTime)
              .then(terms => {
                for (const term of terms) {
                  broadcastToUser(userId, 'term_detected', term);
                }
              })
              .catch(err => console.error('[SocketIO] Term detection error:', err));

            {
              const tStartMs = Date.now() - meetingStartTime;
              const tEndMs =
                event.start !== undefined && event.end !== undefined
                  ? tStartMs + Math.round((event.end - event.start) * 1000)
                  : tStartMs;
              onFinalTranscript(
                event.text,
                meetingId,
                userId,
                meetingStartTime,
                (getActiveRecording(meetingId) as any)?.meetingType ?? 'general',
                (eventName: string, data: unknown) => {
                  broadcastToUser(userId, eventName, data);
                },
                tStartMs,
                tEndMs,
              ).catch(err => console.error('[research] Orchestrator error:', err));
            }

            autoGrarecoOnTranscript(meetingId, userId).catch(err =>
              console.error('[autoGrareco] orchestrator error:', err)
            );

            maybeTriggerInitialProfile(meetingId, userId)
              .catch(err => console.error('[ProfileTrigger] error:', err));
          } else {
            setPartialTranscript(meetingId, event.text);
          }
        },
        (err) => {
          socket.emit('stt-error', { message: err.message });
        },
        () => {
          if (!activeSessions.has(socket.id)) {
            socket.emit('stt-closed', {});
          }
        },
        meetingMode,
        initialKeyterms
      );

      const summaryTimer = setInterval(async () => {
        await runSummaryUpdate(meetingId);
        socket.emit('structured_summary', {});
      }, SUMMARY_INTERVAL);

      acquireRecording(meetingId, 'socketIO', socket.id);

      activeSessions.set(socket.id, {
        meetingId,
        userId,
        elevenlabs,
        watchdogTimer: null,
        summaryTimer,
        lastAudioTime: Date.now(),
        sessionStartTime: meetingStartTime,
      });

      elevenlabs.connect();
      resetWatchdog(socket.id);

      registerRecording({
        meetingId,
        userId,
        connectionType: 'socketIO',
        connectionId: socket.id,
        elevenlabs,
        summaryTimer,
        startTime: meetingStartTime,
        transcriptBuffer: '',
        previousSummary: null,
        transcriptsWithTime: [],
        lastSummaryTranscriptIndex: 0,
        lastSummaryTime: Date.now(),
        consolidationDone: false,
        onTakeover: (mid, newDevice) => {
          socket.emit('device_takeover', { meetingId: mid, takenOverBy: newDevice });
        },
      });

      const audioToken = issueAudioToken(meetingId, userId);
      socket.emit('recording-started', { meetingId, audioToken });

      await db.update(meetings).set({ status: 'active', ...resumeSet }).where(eq(meetings.id, meetingId));

      console.log(`[SocketIO] Meeting started: ${meetingId}`);
    });

    socket.on('resume_meeting', async ({ meetingId, mode }: { meetingId: number; mode?: 'online' | 'real' }) => {
      if (activeSessions.has(socket.id)) {
        socket.emit('error', { message: 'Session already active' });
        return;
      }

      const [ownedMeeting] = await db
        .select({ id: meetings.id })
        .from(meetings)
        .where(and(eq(meetings.id, meetingId), eq(meetings.userId, userId)));
      if (!ownedMeeting) {
        socket.emit('error', { message: 'Meeting not found' });
        return;
      }

      const restored = acquireRecording(meetingId, 'socketIO', socket.id);
      if (restored) {
        console.log(`[SocketIO] Restoring paused session for meeting ${meetingId}`);

        restored.elevenlabs.setOnTranscript(async (event: ElevenLabsTranscriptEvent) => {
          if (!event.text?.trim()) return;
          const elapsedSec = (Date.now() - restored.startTime) / 1000;
          const speakerNum = event.speaker_id?.match(/(\d+)/)?.[1];
          socket.emit('transcript', {
            transcript: event.text,
            isFinal: event.isFinal,
            speaker: speakerNum !== undefined ? parseInt(speakerNum, 10) : undefined,
            start: elapsedSec,
            duration: event.start !== undefined && event.end !== undefined ? event.end - event.start : undefined,
            confidence: event.confidence,
          });
          if (event.isFinal) {
            clearPartialTranscript(meetingId);
            await saveTranscript(meetingId, event, restored.startTime).catch((err) =>
              console.error('[SocketIO] Save transcript error:', err)
            );
            detectAndExplainTerms(event.text, meetingId, userId, restored.startTime)
              .then(terms => {
                for (const term of terms) broadcastToUser(userId, 'term_detected', term);
              })
              .catch(err => console.error('[SocketIO] Term detection error:', err));

            {
              const tStartMs = Date.now() - restored.startTime;
              const tEndMs =
                event.start !== undefined && event.end !== undefined
                  ? tStartMs + Math.round((event.end - event.start) * 1000)
                  : tStartMs;
              onFinalTranscript(
                event.text,
                meetingId,
                userId,
                restored.startTime,
                (getActiveRecording(meetingId) as any)?.meetingType ?? 'general',
                (eventName: string, data: unknown) => {
                  broadcastToUser(userId, eventName, data);
                },
                tStartMs,
                tEndMs,
              ).catch(err => console.error('[research] Orchestrator error:', err));
            }

            autoGrarecoOnTranscript(meetingId, userId).catch(err =>
              console.error('[autoGrareco] orchestrator error:', err)
            );

            maybeTriggerInitialProfile(meetingId, userId)
              .catch(err => console.error('[ProfileTrigger] error:', err));
          } else {
            setPartialTranscript(meetingId, event.text);
          }
        });
        restored.elevenlabs.setOnError((err) => { socket.emit('stt-error', { message: err.message }); });
        restored.elevenlabs.setOnClose(() => {
          if (!activeSessions.has(socket.id)) socket.emit('stt-closed', {});
        });

        const summaryTimer = setInterval(async () => {
          await runSummaryUpdate(meetingId);
          socket.emit('structured_summary', {});
        }, SUMMARY_INTERVAL);

        activeSessions.set(socket.id, {
          meetingId,
          userId,
          elevenlabs: restored.elevenlabs,
          watchdogTimer: null,
          summaryTimer,
          lastAudioTime: Date.now(),
          sessionStartTime: restored.startTime,
        });
        resetWatchdog(socket.id);

        registerRecording({
          ...restored,
          connectionType: 'socketIO',
          connectionId: socket.id,
          summaryTimer,
          onTakeover: (mid, newDevice) => {
            socket.emit('device_takeover', { meetingId: mid, takenOverBy: newDevice });
          },
        });

        await db.update(meetings).set({ status: 'active', ...resumeSet }).where(eq(meetings.id, meetingId));
        const audioToken = issueAudioToken(meetingId, userId);
        socket.emit('recording-started', { meetingId, audioToken });
        return;
      }

      const apiKey = process.env.ELEVENLABS_API_KEY;
      if (!apiKey) {
        socket.emit('error', { message: 'ElevenLabs API key not configured' });
        return;
      }

      const [meeting] = await db
        .select()
        .from(meetings)
        .where(and(eq(meetings.id, meetingId), eq(meetings.userId, userId)));

      if (!meeting) {
        socket.emit('error', { message: 'Meeting not found' });
        return;
      }

      if (wasRecentlyEndedByOther(meetingId, socket.id)) {
        console.warn(
          `[SocketIO] resume_meeting rejected: meeting ${meetingId} was recently ended by a different connection (requester=${socket.id})`,
        );
        socket.emit('meeting_ended', { meetingId });
        socket.emit('error', {
          code: 'recent_end_by_other',
          meetingId,
          message:
            '別デバイスでこの会議は終了されました。続けて記録したい場合は終了したデバイスから再開してください。',
        });
        return;
      }

      const meetingStartTime = meeting.startedAt
        ? new Date(meeting.startedAt).getTime()
        : Date.now();
      const meetingMode = mode || 'real';
      const initialKeyterms = await buildKeyterms(meetingId);

      const elevenlabs = new ElevenLabsSession(
        apiKey,
        async (event: ElevenLabsTranscriptEvent) => {
          if (!event.text?.trim()) return;

          const elapsedSec = (Date.now() - meetingStartTime) / 1000;
          const speakerNum = event.speaker_id?.match(/(\d+)/)?.[1];
          socket.emit('transcript', {
            transcript: event.text,
            isFinal: event.isFinal,
            speaker: speakerNum !== undefined ? parseInt(speakerNum, 10) : undefined,
            start: elapsedSec,
            duration:
              event.start !== undefined && event.end !== undefined
                ? event.end - event.start
                : undefined,
            confidence: event.confidence,
          });

          if (event.isFinal) {
            clearPartialTranscript(meetingId);
            await saveTranscript(meetingId, event, meetingStartTime).catch((err) =>
              console.error('[SocketIO] Save transcript error:', err)
            );
            detectAndExplainTerms(event.text, meetingId, userId, meetingStartTime)
              .then(terms => {
                for (const term of terms) {
                  broadcastToUser(userId, 'term_detected', term);
                }
              })
              .catch(err => console.error('[SocketIO] Term detection error:', err));

            {
              const tStartMs = Date.now() - meetingStartTime;
              const tEndMs =
                event.start !== undefined && event.end !== undefined
                  ? tStartMs + Math.round((event.end - event.start) * 1000)
                  : tStartMs;
              onFinalTranscript(
                event.text,
                meetingId,
                userId,
                meetingStartTime,
                (getActiveRecording(meetingId) as any)?.meetingType ?? 'general',
                (eventName: string, data: unknown) => {
                  broadcastToUser(userId, eventName, data);
                },
                tStartMs,
                tEndMs,
              ).catch(err => console.error('[research] Orchestrator error:', err));
            }

            autoGrarecoOnTranscript(meetingId, userId).catch(err =>
              console.error('[autoGrareco] orchestrator error:', err)
            );

            maybeTriggerInitialProfile(meetingId, userId)
              .catch(err => console.error('[ProfileTrigger] error:', err));
          } else {
            setPartialTranscript(meetingId, event.text);
          }
        },
        (err) => {
          socket.emit('stt-error', { message: err.message });
        },
        () => {
          if (!activeSessions.has(socket.id)) {
            socket.emit('stt-closed', {});
          }
        },
        meetingMode,
        initialKeyterms
      );

      const summaryTimer = setInterval(async () => {
        await runSummaryUpdate(meetingId);
        socket.emit('structured_summary', {});
      }, SUMMARY_INTERVAL);

      activeSessions.set(socket.id, {
        meetingId,
        userId,
        elevenlabs,
        watchdogTimer: null,
        summaryTimer,
        lastAudioTime: Date.now(),
        sessionStartTime: meetingStartTime,
      });

      elevenlabs.connect();
      resetWatchdog(socket.id);

      registerRecording({
        meetingId,
        userId,
        connectionType: 'socketIO',
        connectionId: socket.id,
        elevenlabs,
        summaryTimer,
        startTime: meetingStartTime,
        transcriptBuffer: '',
        previousSummary: null,
        transcriptsWithTime: [],
        lastSummaryTranscriptIndex: 0,
        lastSummaryTime: Date.now(),
        consolidationDone: false,
        onTakeover: (mid, newDevice) => {
          socket.emit('device_takeover', { meetingId: mid, takenOverBy: newDevice });
        },
      });

      await db.update(meetings).set({ status: 'active', ...resumeSet }).where(eq(meetings.id, meetingId));
      clearRecentEnd(meetingId);
      const audioToken2 = issueAudioToken(meetingId, userId);
      socket.emit('recording-started', { meetingId, audioToken: audioToken2 });

      console.log(`[SocketIO] Meeting resumed: ${meetingId}`);
    });

    socket.on('audio', (data: ArrayBuffer | Buffer) => {
      const session = activeSessions.get(socket.id);
      if (!session) return;

      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      session.elevenlabs.sendAudio(buffer);
      resetWatchdog(socket.id);
      markAudioReceived(session.meetingId);
    });

    socket.on('audio-chunk', (data: ArrayBuffer | Buffer) => {
      const session = activeSessions.get(socket.id);
      if (!session) return;

      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      session.elevenlabs.sendAudio(buffer);
      resetWatchdog(socket.id);
      markAudioReceived(session.meetingId);
    });

    socket.on('end_meeting', async () => {
      const session = activeSessions.get(socket.id);
      if (!session) return;

      if (session.watchdogTimer) clearTimeout(session.watchdogTimer);
      if (session.summaryTimer) clearInterval(session.summaryTimer);

      releaseRecording(session.meetingId, session.elevenlabs);

      session.elevenlabs.finalize();

      setTimeout(async () => {
        session.elevenlabs.close();
        activeSessions.delete(socket.id);
        clearPartialTranscript(session.meetingId);
        consolidationDone.delete(session.meetingId);

        const endedAt = new Date();
        const [mtg] = await db.select().from(meetings).where(eq(meetings.id, session.meetingId));

        const duration = mtg ? recordedDurationSeconds(mtg, endedAt.getTime()) : undefined;

        const completed = await db
          .update(meetings)
          .set({ status: 'completed', endedAt, duration, ...foldPausedSet })
          .where(and(eq(meetings.id, session.meetingId), ne(meetings.status, 'completed')))
          .returning({ id: meetings.id });

        await runSummaryUpdate(session.meetingId, true);

        socket.emit('recording-stopped', { meetingId: session.meetingId });
        clearMeetingCache(session.meetingId);
        cleanupResearch(session.meetingId);
        cleanupAutoGrareco(session.meetingId, session.userId).catch((err) =>
          console.error('[autoGrareco] cleanup error:', err),
        );
        clearMeetingProfileState(session.meetingId);
        console.log(`[SocketIO] Meeting ended: ${session.meetingId}`);
        const broadcastResult = broadcastToUser(
          session.userId,
          'meeting_ended',
          { meetingId: session.meetingId },
          socket.id,
        );
        if (broadcastResult.sent > 0) {
          console.log(
            `[SocketIO] meeting_ended broadcasted to ${broadcastResult.sent} other connection(s) for meeting ${session.meetingId}`
          );
        }

        markMeetingEnded(session.meetingId, socket.id);

        sendMeetingEndEmail(session.meetingId, session.userId, mtg?.title || '無題の会議', endedAt);
      }, 2000);
    });

    socket.on('stop-recording', async () => {
      const session = activeSessions.get(socket.id);
      if (!session) return;

      if (session.watchdogTimer) clearTimeout(session.watchdogTimer);
      if (session.summaryTimer) clearInterval(session.summaryTimer);

      releaseRecording(session.meetingId, session.elevenlabs);

      session.elevenlabs.finalize();

      setTimeout(async () => {
        session.elevenlabs.close();
        activeSessions.delete(socket.id);
        clearPartialTranscript(session.meetingId);
        consolidationDone.delete(session.meetingId);

        const endedAt = new Date();
        const [mtg] = await db.select().from(meetings).where(eq(meetings.id, session.meetingId));

        const duration = mtg ? recordedDurationSeconds(mtg, endedAt.getTime()) : undefined;

        const completed = await db
          .update(meetings)
          .set({ status: 'completed', endedAt, duration, ...foldPausedSet })
          .where(and(eq(meetings.id, session.meetingId), ne(meetings.status, 'completed')))
          .returning({ id: meetings.id });

        await runSummaryUpdate(session.meetingId, true);

        socket.emit('recording-stopped', { meetingId: session.meetingId });
        const broadcastResult = broadcastToUser(
          session.userId,
          'meeting_ended',
          { meetingId: session.meetingId },
          socket.id,
        );
        if (broadcastResult.sent > 0) {
          console.log(
            `[SocketIO:stop-recording] meeting_ended broadcasted to ${broadcastResult.sent} other connection(s)`
          );
        }

        markMeetingEnded(session.meetingId, socket.id);

        sendMeetingEndEmail(session.meetingId, session.userId, mtg?.title || '無題の会議', endedAt);
      }, 2000);
    });

    socket.on('pause-recording', async () => {
      const session = activeSessions.get(socket.id);
      if (!session) return;
      const [mtg] = await db
        .select({ status: meetings.status })
        .from(meetings)
        .where(eq(meetings.id, session.meetingId));
      if (mtg && mtg.status === 'completed') {
        console.log(
          `[SocketIO] pause-recording ignored: meeting ${session.meetingId} already completed`,
        );
        session.elevenlabs.finalize();
        socket.emit('meeting_ended', { meetingId: session.meetingId });
        return;
      }
      session.elevenlabs.finalize();
      await db.update(meetings).set({ status: 'paused', ...markPausedSet }).where(eq(meetings.id, session.meetingId));
      socket.emit('recording-paused', {});
    });

    socket.on('resume-recording', async () => {
      const session = activeSessions.get(socket.id);
      if (!session) return;
      await db.update(meetings).set({ status: 'active', ...resumeSet }).where(eq(meetings.id, session.meetingId));
      socket.emit('recording-resumed', {});
    });

    socket.on('reset_transcription', () => {
      const session = activeSessions.get(socket.id);
      if (!session) return;
      console.log(`[SocketIO] Transcription reset requested for meeting ${session.meetingId}`);
      session.elevenlabs.forceReconnect();
      socket.emit('transcription_reset', { meetingId: session.meetingId });
    });

    socket.on('dismiss_term', async ({ term }: { term: string }) => {
      const session = activeSessions.get(socket.id);
      if (!session) return;
      excludeTerm(session.userId, term).catch(err =>
        console.error('[SocketIO] Exclude term error:', err)
      );
    });

    socket.on('research_set_meeting_type', (payload: { meetingType?: unknown } | undefined) => {
      const session = activeSessions.get(socket.id);
      if (!session) return;
      const meetingType = payload?.meetingType;
      if (!isMeetingType(meetingType)) return;
      const rec = getActiveRecording(session.meetingId);
      if (rec) {
        (rec as any).meetingType = meetingType;
      }
    });

    socket.on('research_dismiss', ({ cardId }: { cardId: string }) => {
      console.log(`[research] Card dismissed: ${cardId}`);
    });

    socket.on('disconnect', async () => {
      console.log(`[SocketIO] Client disconnected: ${socket.id}`);
      const session = activeSessions.get(socket.id);
      if (session) {
        if (session.watchdogTimer) clearTimeout(session.watchdogTimer);
        session.watchdogTimer = null;
        activeSessions.delete(socket.id);

        const meetingId = session.meetingId;
        const paused = pauseRecording(
          meetingId,
          socket.id,
          DISCONNECT_GRACE_PERIOD,
          async (recording) => {
            const [mtg] = await db.select().from(meetings).where(eq(meetings.id, meetingId));
            if (!mtg || mtg.status !== 'paused') {
              console.log(`[SocketIO] Grace period expired for meeting ${meetingId}, status=${mtg?.status} — skipping auto-complete`);
              return;
            }

            console.log(`[SocketIO] Grace period expired for meeting ${meetingId}, auto-completing`);
            const endedAt = new Date();
            const duration = recordedDurationSeconds(mtg, endedAt.getTime());
            const completed = await db.update(meetings)
              .set({ status: 'completed', endedAt, duration, ...foldPausedSet })
              .where(and(eq(meetings.id, meetingId), ne(meetings.status, 'completed')))
              .returning({ id: meetings.id });

            await runSummaryUpdate(meetingId, true);

            clearMeetingCache(meetingId);
            cleanupResearch(meetingId);
            cleanupAutoGrareco(meetingId, session.userId).catch((err) =>
              console.error('[SocketIO] cleanupAutoGrareco (grace expire) failed:', err),
            );

            sendMeetingEndEmail(meetingId, session.userId, mtg.title || '無題の会議', endedAt).catch((err) =>
              console.error('[SocketIO] sendMeetingEndEmail (grace expire) failed:', err),
            );
          },
        );

        if (paused) {
          await db.update(meetings).set({ status: 'paused', ...markPausedSet })
            .where(and(eq(meetings.id, meetingId), eq(meetings.status, 'active'))).catch(() => {});
          console.log(`[SocketIO] Meeting ${meetingId} paused — ${DISCONNECT_GRACE_PERIOD / 1000}s grace period (ElevenLabs preserved)`);
        } else {
          if (session.summaryTimer) clearInterval(session.summaryTimer);
          session.elevenlabs.close();
          console.log(`[SocketIO] Meeting ${meetingId} already taken over by another device — DB status untouched`);
        }
      }
    });
  });

  return io;
}
