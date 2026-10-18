import { Server as HTTPServer, IncomingMessage } from 'http';
import { serverFeatures } from '../services/features.js';
import { WebSocketServer, WebSocket } from 'ws';
import { WS_MAX_PAYLOAD_BYTES } from './wsLimits.js';
import { VALID_MEETING_TYPES, isMeetingType } from '../services/research/types.js';
import { URL } from 'url';
import { authenticateToken } from '../middleware/tokenAuth.js';
import {
  auditLegacyQueryToken,
  isLegacyQueryTokenAllowed,
  readClientInfo,
  requiredMinVersion,
  WS_UPDATE_REQUIRED_CODE,
  WS_UPDATE_REQUIRED_REASON,
} from '../middleware/clientVersion.js';
import { db } from '../db/index.js';
import { meetings, transcripts, structuredSummaries, analyses, graphicRecordings, users, researchInsights } from '../db/schema.js';
import { eq, and, desc, or, isNull, ne } from 'drizzle-orm';
import { ElevenLabsSession, ElevenLabsTranscriptEvent, MeetingMode } from '../services/elevenLabsService.js';
import { buildKeyterms } from '../services/keytermsBuilder.js';
import { generateStructuredSummary, generateMeetingTitle, generateMeetingMinutes, generateGraphicRecording, consolidateSummaryThemes, hasConsolidatedMarker, withConsolidatedMarker } from '../services/geminiService.js';
import { buildParticipantsSection } from '../services/grareco/grarecoPrompt.js';
import { sendMeetingMinutesEmail } from '../services/emailService.js';
import { getSupplementaryContext, rebuildSummaryAtMeetingEnd } from '../routes/meetings.js';
import { generateManualGrareco } from '../services/grareco/manualGrareco.js';
import { reconcileSupplementaryIntoSummary } from '../services/summaryAppendService.js';
import { flushObservationConsolidation } from '../services/observationService.js';
import { detectAndExplainTerms, excludeTerm, clearMeetingCache } from '../services/termGlossaryService.js';
import { markPausedSet, foldPausedSet, resumeSet, recordedSecondsAt, recordedDurationSeconds } from '../services/recordingMeter.js';
import { recordingMsForNewTranscript } from '../services/recordingClock.js';
import { markAudioReceived } from '../services/audioWatchdog.js';
import { acquireRecording, registerRecording, releaseRecording, pauseRecording, getActiveRecording, markMeetingEnded, wasRecentlyEndedByOther, clearRecentEnd, forceCleanupMeeting, listActiveRecordings, type ActiveRecording, type ConnectionType } from './meetingRegistry.js';
import { onFinalTranscript, cleanupResearch, fetchUserResearchSettings } from '../services/research/managedAgent.js';
import { maybeTriggerInitialProfile, clearMeetingProfileState } from '../services/participantProfileTrigger.js';
import { registerConnection, unregisterConnection, broadcastToUser } from '../services/research/connectionRegistry.js';
import { processFinalTranscript as autoGrarecoOnTranscript, cleanupAutoGrareco } from '../services/grareco/autoGrarecoOrchestrator.js';
import { setPartialTranscript, clearPartialTranscript } from './transcriptCache.js';
import { parseNgKeywords, filterNgTranscripts, isNgContent } from '../services/ngKeywordFilterService.js';
import { bindAuditContext } from '../services/audit/requestContext.js';

interface NativeWsSession {
  userId: number;
  connectionId: string;
  meetingId: number | null;
  elevenlabs: ElevenLabsSession | null;
  summaryTimer: NodeJS.Timeout | null;
  keepaliveTimer: NodeJS.Timeout | null;
  startTime: number;
  transcriptBuffer: string;
  lastSummaryTime: number;
  previousSummary: string | null;
  transcriptsWithTime: Array<{ content: string; time: number; transcriptStartTime: number; recordingMs?: number | null }>;
  lastSummaryTranscriptIndex: number;
  consolidationDone: boolean;
  ending?: boolean;
  summaryInFlight?: boolean;
}

const SUMMARY_INTERVAL_MS = 180_000;
const CONSOLIDATION_THRESHOLD_SEC = 900;
const MIN_SUMMARY_CHARS = 100;
const DISCONNECT_GRACE_PERIOD = 600_000;

let nativeWsConnectionCounter = 0;

const activeNativeConnections = new Map<number, WebSocket>();

const nativeSessionsByMeeting = new Map<number, NativeWsSession>();

export function syncSessionAfterRebuild(meetingId: number, content: string): void {
  const session = nativeSessionsByMeeting.get(meetingId);
  if (!session) return;
  session.previousSummary = content;
  session.lastSummaryTranscriptIndex = session.transcriptsWithTime.length;
  session.lastSummaryTime = Date.now();
  console.log(`[NativeWS] Session synced after summary rebuild for meeting ${meetingId}`);
}

export function sendForceEndToDesktop(meetingId: number): boolean {
  const ws = activeNativeConnections.get(meetingId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    sendJson(ws, { type: 'meeting_force_ended', meetingId });
    console.log(`[NativeWS] Sent meeting_force_ended to desktop for meeting ${meetingId}`);
    return true;
  }
  console.log(`[NativeWS] No active desktop connection for meeting ${meetingId} — skip force-end`);
  return false;
}

function sendJson(ws: WebSocket, data: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(data));
    } catch {  }
  }
}

async function saveTranscript(
  meetingId: number,
  text: string,
  startTime: number,
  endTime: number,
  speakerId: number | null
): Promise<number | null> {
  const [mtgForTime] = await db.select().from(meetings).where(eq(meetings.id, meetingId)).catch(() => [null as any]);
  const recordingMs = await recordingMsForNewTranscript(mtgForTime);

  await db.insert(transcripts).values({
    meetingId,
    content: text,
    speaker: speakerId !== null ? `話者${speakerId + 1}` : null,
    speakerId,
    startTime,
    endTime,
    recordingMs,
    isFinal: true,
    confidence: null,
  });

  const mtgForRestore = mtgForTime;
  if (mtgForRestore && mtgForRestore.status === 'completed' && !mtgForRestore.endedAt) {
    await db
      .update(meetings)
      .set({ status: 'active', ...resumeSet })
      .where(eq(meetings.id, meetingId))
      .catch((err) => console.error('[NativeWS] Error restoring active status:', err));
  }

  return recordingMs;
}

async function getMeetingParticipants(meetingId: number): Promise<any[] | null> {
  try {
    const [meeting] = await db.select().from(meetings).where(eq(meetings.id, meetingId));
    return (meeting?.participants as any[] | null) || null;
  } catch {
    return null;
  }
}

async function tryAutoTitle(meetingId: number, summaryContent: string): Promise<void> {
  try {
    const [meeting] = await db.select().from(meetings).where(eq(meetings.id, meetingId));
    if (!meeting || meeting.isTitleEdited) return;
    const title = await generateMeetingTitle(summaryContent);
    if (title && title.length > 0 && title.length <= 50) {
      await db.update(meetings).set({ title }).where(eq(meetings.id, meetingId));
    }
  } catch (e) {
    console.error('[NativeWS] Auto title generation failed:', e);
  }
}

async function sendMeetingEndEmail(meetingId: number, userId: number, title: string, endedAt: Date) {
  console.log(`[NativeWS-Email] meetingId=${meetingId} メール送信処理を開始...`);

  try {
    const [mtgCheck] = await db.select().from(meetings).where(eq(meetings.id, meetingId));

    await flushObservationConsolidation(meetingId, mtgCheck?.startedAt ?? null)
      .catch((err) => console.error('[NativeWS-Email] observation flush 失敗:', err));

    if (mtgCheck?.emailSentAt) {
      console.log(`[NativeWS-Email] meetingId=${meetingId} メール送信済み（${mtgCheck.emailSentAt}）— スキップ`);
      return;
    }
    await db.update(meetings).set({ emailSentAt: new Date() }).where(eq(meetings.id, meetingId));

    const [user] = await db.select().from(users).where(eq(users.id, userId));
    if (!user?.email) {
      console.error(`[NativeWS-Email] userId=${userId} メールアドレスが見つかりません`);
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
      console.log(`[NativeWS-Email] meetingId=${meetingId} 文字起こし・サマリーが空のためスキップ`);
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
      `[NativeWS-Email] meetingId=${meetingId} 判定 duration=${Math.floor(durationMs / 1000)}秒 transcript=${rawTranscriptLength}文字 startedAt=${mtgCheck?.startedAt ? new Date(mtgCheck.startedAt).toISOString() : 'NULL'}`,
    );
    if (durationMs < MIN_DURATION_MS || rawTranscriptLength < MIN_TRANSCRIPT_LENGTH) {
      console.log(`[NativeWS-Email] meetingId=${meetingId} テスト操作と判断してスキップ（時間=${Math.floor(durationMs / 1000)}秒, 文字数=${rawTranscriptLength}文字）`);
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
        console.error(`[NativeWS-Email] タイトル自動生成失敗:`, e);
      }
    }

    const supplementary = await getSupplementaryContext(meetingId).catch(() => null);
    console.log(`[NativeWS-Email] meetingId=${meetingId} supplementary=${supplementary ? supplementary.length + 'chars' : 'null'}`);

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
    console.log(`[NativeWS-Email] グラレコ用テキスト: ${grarecoSourceText.length}文字（書き起こし: ${Math.min(transcriptText.length, GRARECO_TRANSCRIPT_LIMIT)}文字, 参加者: ${participantsArray.length}名）`);

    const [minutesText, grarecoResult] = await Promise.all([
      generateMeetingMinutes(summaryContent || '（サマリーなし）', transcriptText, participantsArray, supplementary).catch(
        (err) => {
          console.error(`[NativeWS-Email] 議事録生成失敗:`, err);
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
        console.error(`[NativeWS-Email] グラレコ生成失敗:`, err);
        return undefined;
      }),
    ]);
    const grarecoImageUrl = grarecoResult?.imageUrl;

    await db.insert(analyses).values({
      meetingId,
      type: 'minutes',
      content: minutesText,
      metadata: { source: 'auto_meeting_end', generatedAt: endedAt.toISOString() },
    }).catch((err) => console.error(`[NativeWS-Email] 議事録DB保存失敗:`, err));

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
      }).catch((err) => console.error(`[NativeWS-Email] グラレコDB保存失敗:`, err));
    }

    let minutesWithResearch = minutesText;
    try {
      const researchRows = await db.select().from(researchInsights)
        .where(eq(researchInsights.meetingId, meetingId))
        .orderBy(desc(researchInsights.importance));

      if (researchRows.length > 0) {
        const topInsights = researchRows.slice(0, 5);
        const researchSection = '\n\n---\n🧠 リアルタイム調査のハイライト\n\n' +
          topInsights.map(i => {
            const content = JSON.parse(i.content as string);
            return `• ${content.title || i.keyword}\n  ${(content.body || '').substring(0, 100)}`;
          }).join('\n\n');
        minutesWithResearch = minutesText + researchSection;
      }
    } catch (e) {
      console.error('[research] Failed to fetch insights for email:', e);
    }

    await sendMeetingMinutesEmail({
      to: user.email,
      meetingId,
      meetingTitle: title,
      endedAt,
      minutesText: minutesWithResearch,
      grarecoImageBase64: grarecoImageUrl,
    });

    console.log(`[NativeWS-Email] meetingId=${meetingId} メール送信完了 userId=${userId}`);
  } catch (err) {
    console.error(`[NativeWS-Email] meetingId=${meetingId} メール送信失敗:`, err);
    await db.update(meetings).set({ emailSentAt: null }).where(eq(meetings.id, meetingId)).catch(() => {});
    console.log(`[NativeWS-Email] meetingId=${meetingId} emailSentAtをリセット（再送信可能）`);
  }
}

async function handleTranscriptEvent(
  ws: WebSocket,
  session: NativeWsSession,
  meetingId: number,
  event: ElevenLabsTranscriptEvent,
): Promise<void> {
  if (!event.text?.trim()) return;

  const speakerNum = event.speaker_id?.match(/(\d+)/)?.[1];
  const elapsedMs = Date.now() - session.startTime;
  const durationMs =
    event.start !== undefined && event.end !== undefined
      ? Math.round((event.end - event.start) * 1000)
      : 0;

  sendJson(ws, {
    type: 'transcript',
    data: {
      content: event.text,
      isFinal: event.isFinal,
      speaker: speakerNum !== undefined ? `話者${parseInt(speakerNum, 10) + 1}` : null,
      speakerId: speakerNum !== undefined ? parseInt(speakerNum, 10) : null,
      startTime: elapsedMs,
      endTime: elapsedMs + durationMs,
      confidence: event.confidence?.toString() ?? null,
    },
  });

  if (event.isFinal) {
    clearPartialTranscript(meetingId);
    const recMs = await saveTranscript(
      meetingId,
      event.text,
      elapsedMs,
      elapsedMs + durationMs,
      speakerNum !== undefined ? parseInt(speakerNum, 10) : null
    ).catch((err) => { console.error('[NativeWS] Save transcript error:', err); return null; });

    detectAndExplainTerms(event.text, meetingId, session.userId, session.startTime)
      .then(terms => {
        for (const term of terms) {
          broadcastToUser(session.userId, 'term_detected', term);
        }
      })
      .catch(err => console.error('[NativeWS] Term detection error:', err));

    {
      const tStartMs = Date.now() - session.startTime;
      const tEndMs =
        event.start !== undefined && event.end !== undefined
          ? tStartMs + Math.round((event.end - event.start) * 1000)
          : tStartMs;
      onFinalTranscript(
        event.text,
        meetingId,
        session.userId,
        session.startTime,
        (getActiveRecording(meetingId) as any)?.meetingType ?? 'general',
        (eventName: string, data: unknown) => {
          broadcastToUser(session.userId, eventName, data);
        },
        tStartMs,
        tEndMs,
      ).catch(err => console.error('[research] Orchestrator error:', err));
    }

    autoGrarecoOnTranscript(meetingId, session.userId).catch(err =>
      console.error('[autoGrareco] orchestrator error:', err)
    );

    maybeTriggerInitialProfile(meetingId, session.userId)
      .catch(err => console.error('[ProfileTrigger] error:', err));

    const now = Date.now();
    session.transcriptBuffer += event.text + ' ';
    session.transcriptsWithTime.push({
      content: event.text,
      time: now,
      transcriptStartTime: elapsedMs,
      recordingMs: recMs,
    });

    if (
      now - session.lastSummaryTime > SUMMARY_INTERVAL_MS &&
      session.transcriptBuffer.length > MIN_SUMMARY_CHARS &&
      !session.summaryInFlight
    ) {
      session.summaryInFlight = true;
      try {
      const newTranscripts = session.transcriptsWithTime.slice(session.lastSummaryTranscriptIndex);
      if (newTranscripts.length > 0) {
        const [mtgRow] = await db
          .select({
            ngKeywords: meetings.ngKeywords,
            transcriptionStartedAt: meetings.transcriptionStartedAt,
            pausedSeconds: meetings.pausedSeconds,
            pausedSince: meetings.pausedSince,
          })
          .from(meetings)
          .where(eq(meetings.id, meetingId))
          .limit(1);
        const ngKeywords = parseNgKeywords(mtgRow?.ngKeywords);
        const newText = newTranscripts
          .filter((t) => !isNgContent(t.content, ngKeywords))
          .map((t) => {
            const baseMs = t.recordingMs ?? t.transcriptStartTime;
            const totalSec = Math.max(0, Math.floor(baseMs / 1000));
            const mm = String(Math.floor(totalSec / 60)).padStart(2, '0');
            const ss = String(totalSec % 60).padStart(2, '0');
            return `[${mm}:${ss}] ${t.content}`;
          })
          .join('\n');

        if (newText.length > 50) {
          try {
            const [existing] = await db
              .select()
              .from(structuredSummaries)
              .where(eq(structuredSummaries.meetingId, meetingId))
              .orderBy(desc(structuredSummaries.updatedAt))
              .limit(1);

            const previousSummary = existing?.content ?? session.previousSummary;
            const participants = await getMeetingParticipants(meetingId);
            const structuredSummary = await generateStructuredSummary(
              newText,
              previousSummary,
              participants,
            );
            session.lastSummaryTranscriptIndex = session.transcriptsWithTime.length;
            session.lastSummaryTime = now;

            const newMaxTime = newTranscripts[newTranscripts.length - 1].transcriptStartTime;

            let savedContent = structuredSummary;
            if (existing) {
              savedContent = hasConsolidatedMarker(existing.content)
                ? withConsolidatedMarker(structuredSummary)
                : structuredSummary;
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
                console.error('[NativeWS] supplementary reconcile failed:', err),
              );
            }
            session.previousSummary = savedContent;

            sendJson(ws, {
              type: 'structured_summary',
              data: { content: savedContent },
            });

            console.log(`[NativeWS] Summary updated for meeting ${meetingId}`);

            if (existing && !hasConsolidatedMarker(savedContent)) {
              const recordedSec = recordedSecondsAt(
                mtgRow?.transcriptionStartedAt,
                now,
                mtgRow?.pausedSeconds,
                mtgRow?.pausedSince,
              );
              if (recordedSec >= CONSOLIDATION_THRESHOLD_SEC) {
                try {
                  const consolidated = await consolidateSummaryThemes(savedContent, participants);
                  const marked = withConsolidatedMarker(consolidated);
                  session.previousSummary = marked;
                  await db
                    .update(structuredSummaries)
                    .set({ content: marked, updatedAt: new Date() })
                    .where(eq(structuredSummaries.id, existing.id));
                  sendJson(ws, {
                    type: 'structured_summary',
                    data: { content: marked },
                  });
                  console.log(`[NativeWS] Themes consolidated for meeting ${meetingId} (recordedSec=${recordedSec})`);
                } catch (e) {
                  console.error('[NativeWS] Consolidation error:', e);
                }
              }
            }
          } catch (e) {
            console.error('[NativeWS] Summary error:', e);
          }
        }
      }
      } finally {
        session.summaryInFlight = false;
      }
    }
  } else {
    setPartialTranscript(meetingId, event.text);
  }
}

function rebindElevenLabsCallbacks(
  ws: WebSocket,
  session: NativeWsSession,
  meetingId: number,
): void {
  if (!session.elevenlabs) return;

  session.elevenlabs.setOnTranscript((event: ElevenLabsTranscriptEvent) =>
    handleTranscriptEvent(ws, session, meetingId, event),
  );

  session.elevenlabs.setOnError((err) => {
    sendJson(ws, { type: 'error', message: `STT error: ${err.message}` });
  });

  session.elevenlabs.setOnClose(() => {
  });
}

async function createElevenLabsForSession(
  ws: WebSocket,
  session: NativeWsSession,
  mode: MeetingMode
): Promise<void> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    sendJson(ws, { type: 'error', message: 'ElevenLabs API key not configured' });
    return;
  }
  if (!session.meetingId) return;
  const meetingId = session.meetingId;

  if (session.elevenlabs) {
    session.elevenlabs.close();
  }
  if (session.summaryTimer) {
    clearInterval(session.summaryTimer);
  }

  const keyterms = await buildKeyterms(meetingId);

  const elevenlabs = new ElevenLabsSession(
    apiKey,
    (event: ElevenLabsTranscriptEvent) => handleTranscriptEvent(ws, session, meetingId, event),
    (err) => {
      sendJson(ws, { type: 'error', message: `STT error: ${err.message}` });
    },
    () => {
    },
    mode,
    keyterms
  );

  session.elevenlabs = elevenlabs;
  elevenlabs.connect();

  registerRecording({
    meetingId,
    userId: session.userId,
    connectionType: 'nativeWs',
    connectionId: session.connectionId,
    elevenlabs,
    summaryTimer: null,
    startTime: session.startTime,
    transcriptBuffer: session.transcriptBuffer,
    previousSummary: session.previousSummary,
    transcriptsWithTime: session.transcriptsWithTime,
    lastSummaryTranscriptIndex: session.lastSummaryTranscriptIndex,
    lastSummaryTime: session.lastSummaryTime,
    consolidationDone: session.consolidationDone,
    onTakeover: (mid, newDevice) => {
      sendJson(ws, { type: 'device_takeover', meetingId: mid, takenOverBy: newDevice });
    },
  });

  console.log(`[NativeWS] ElevenLabs connected for meeting ${meetingId} (mode: ${mode})`);
}

export function setupNativeWebSocket(httpServer: HTTPServer): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD_BYTES });

  httpServer.on('upgrade', (request: IncomingMessage, socket, head) => {
    const url = new URL(request.url || '', `http://${request.headers.host}`);

    if (url.pathname !== '/ws') return;

    let token: string | null = null;

    const authHeader = request.headers['authorization'];
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7);
    }

    if (!token) {
      const proto = request.headers['sec-websocket-protocol'];
      if (typeof proto === 'string') {
        const parts = proto.split(',').map((p) => p.trim());
        const idx = parts.indexOf('bearer');
        if (idx >= 0 && parts[idx + 1]) {
          token = parts[idx + 1];
        }
      }
    }

    const rejectUpdateRequired = () => {
      wss.handleUpgrade(request, socket, head, (ws) => {
        ws.close(WS_UPDATE_REQUIRED_CODE, WS_UPDATE_REQUIRED_REASON);
      });
    };

    if (!token) {
      const queryToken = url.searchParams.get('token');
      if (queryToken) {
        const accepted = isLegacyQueryTokenAllowed();
        auditLegacyQueryToken(queryToken, { headers: request.headers, channel: 'native_ws', accepted });
        if (!accepted) {
          rejectUpdateRequired();
          return;
        }
        token = queryToken;
      }
    }

    if (!token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const clientInfo = readClientInfo(request.headers, {
      version: url.searchParams.get('client_version') ?? undefined,
      platform: url.searchParams.get('client_platform') ?? undefined,
    });
    if (requiredMinVersion(clientInfo, true)) {
      rejectUpdateRequired();
      return;
    }

    authenticateToken(token)
      .then((user) => {
        if (!user) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }

        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit('connection', ws, request, user);
        });
      })
      .catch(() => {
        socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
        socket.destroy();
      });
  });

  wss.on('connection', (ws: WebSocket, _request: IncomingMessage, user: { userId: number; email: string; displayName: string | null; tokenId: number }) => {
    const connectionId = `native-${++nativeWsConnectionCounter}`;
    console.log(`[NativeWS] Client connected: userId=${user.userId}, connectionId=${connectionId}`);

    const session: NativeWsSession = {
      userId: user.userId,
      connectionId,
      meetingId: null,
      elevenlabs: null,
      summaryTimer: null,
      keepaliveTimer: null,
      startTime: Date.now(),
      transcriptBuffer: '',
      lastSummaryTime: Date.now(),
      previousSummary: null,
      transcriptsWithTime: [],
      lastSummaryTranscriptIndex: 0,
      consolidationDone: false,
    };

    registerConnection({
      id: connectionId,
      userId: user.userId,
      tokenId: user.tokenId,
      emit: (eventName, data) => {
        if (
          eventName === 'meeting_ended' &&
          data &&
          typeof data === 'object' &&
          'meetingId' in data
        ) {
          sendJson(ws, { type: eventName, ...(data as Record<string, unknown>) });
        } else {
          sendJson(ws, { type: eventName, data });
        }
      },
      isAlive: () => ws.readyState === WebSocket.OPEN,
    });

    void (async () => {
      try {
        const settings = await fetchUserResearchSettings(user.userId);
        sendJson(ws, { type: 'research_settings_updated', data: settings });
      } catch (e) {
        console.error('[WS] initial research settings push failed:', e instanceof Error ? e.message : String(e));
      }
    })();

    const PONG_TIMEOUT_MS = 45000;
    let lastPongAt = Date.now();
    session.keepaliveTimer = setInterval(() => {
      if (Date.now() - lastPongAt > PONG_TIMEOUT_MS) {
        console.warn(`[NativeWS] no pong for ${PONG_TIMEOUT_MS / 1000}s — terminating dead connection (meeting=${session.meetingId})`);
        try { ws.terminate(); } catch {  }
        return;
      }
      sendJson(ws, { type: 'keepalive', ts: Date.now() });
      try { ws.ping(); } catch {  }
    }, 15000);

    ws.on('pong', () => {
      lastPongAt = Date.now();
    });

    ws.on('message', bindAuditContext({ channel: 'native_ws', actorId: user.userId }, async (data, isBinary) => {
      if (isBinary || Buffer.isBuffer(data)) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        const firstByte = buf.length > 0 ? buf[0] : 0;
        if (firstByte === 0x7b) {
          try {
            const msg = JSON.parse(buf.toString('utf8'));
            await handleJsonMessage(ws, session, user, msg);
            return;
          } catch {
          }
        }

        if (session.elevenlabs && session.meetingId) {
          session.elevenlabs.sendAudio(buf);
          markAudioReceived(session.meetingId);
        }
        return;
      }

      try {
        const msg = JSON.parse(data.toString());
        await handleJsonMessage(ws, session, user, msg);
      } catch (err) {
        console.error('[NativeWS] Message parse error:', err);
      }
    }));

    ws.on('close', async (code, reason) => {
      console.log(`[NativeWS] Client disconnected: userId=${user.userId}, connectionId=${session.connectionId}, code=${code}, reason=${reason?.toString() || 'none'}`);

      unregisterConnection(user.userId, connectionId);

      if (session.keepaliveTimer) clearInterval(session.keepaliveTimer);

      if (session.meetingId) {
        activeNativeConnections.delete(session.meetingId);
        nativeSessionsByMeeting.delete(session.meetingId);
        clearPartialTranscript(session.meetingId);
      }

      if (session.meetingId) {
        const [meeting] = await db.select().from(meetings).where(eq(meetings.id, session.meetingId)).catch(() => [null]);
        if (meeting && meeting.status === 'active') {
          const meetingId = session.meetingId;
          const userId = session.userId;

          const paused = pauseRecording(
            meetingId,
            session.connectionId,
            DISCONNECT_GRACE_PERIOD,
            async (recording) => {
              const [m] = await db.select().from(meetings).where(eq(meetings.id, meetingId)).catch(() => [null]);
              if (!m || m.status !== 'paused') {
                console.log(`[NativeWS] Grace period expired for meeting ${meetingId}, status=${m?.status} — skipping auto-complete`);
                return;
              }

              const endedAt = new Date();
              const duration = recordedDurationSeconds(m, endedAt.getTime());
              const completed = await db.update(meetings)
                .set({ status: 'completed', endedAt, duration, ...foldPausedSet })
                .where(and(eq(meetings.id, meetingId), ne(meetings.status, 'completed')))
                .returning({ id: meetings.id })
                .catch((err) => { console.error('[NativeWS] Error completing meeting:', err); return [] as { id: number }[]; });

              clearMeetingCache(meetingId);
              cleanupResearch(meetingId);
              cleanupAutoGrareco(meetingId, userId).catch((err) =>
                console.error('[NativeWS] cleanupAutoGrareco (grace expire) failed:', err),
              );

              console.log(`[NativeWS] Meeting ${meetingId} auto-completed after grace period`);

              sendMeetingEndEmail(meetingId, userId, m.title || '無題の会議', endedAt).catch((err) =>
                console.error('[NativeWS] sendMeetingEndEmail (grace expire) failed:', err),
              );
            },
          );

          if (!paused) {
            if (session.summaryTimer) clearInterval(session.summaryTimer);
            if (session.elevenlabs) session.elevenlabs.close();
            console.log(`[NativeWS] Meeting ${meetingId} already taken over by another device — DB status untouched`);
          } else {
            await db.update(meetings).set({ status: 'paused', ...markPausedSet })
              .where(and(eq(meetings.id, meetingId), eq(meetings.status, 'active')))
              .catch((err) => console.error('[NativeWS] Error pausing meeting:', err));
            console.log(`[NativeWS] Meeting ${meetingId} paused (client disconnected, ElevenLabs preserved)`);
          }
        } else {
          if (session.summaryTimer) clearInterval(session.summaryTimer);
          if (session.elevenlabs) session.elevenlabs.close();
        }
      } else {
        if (session.summaryTimer) clearInterval(session.summaryTimer);
        if (session.elevenlabs) session.elevenlabs.close();
      }
    });

    ws.on('error', (err) => {
      console.error(`[NativeWS] WebSocket error: ${err.message}`);
    });
  });

  console.log('[NativeWS] WebSocket server ready at /ws');
}

async function endOtherActiveMeetingsForUser(
  userId: number,
  exceptMeetingId: number,
): Promise<void> {
  try {
    const others = await db
      .select()
      .from(meetings)
      .where(and(
        eq(meetings.userId, userId),
        or(eq(meetings.status, 'active'), eq(meetings.status, 'paused')),
        ne(meetings.id, exceptMeetingId),
      ));

    for (const m of others) {
      forceCleanupMeeting(m.id);

      const endedAt = m.endedAt || new Date();
      const duration = recordedDurationSeconds(m, endedAt.getTime());
      const r3completed = await db
        .update(meetings)
        .set({ status: 'completed', endedAt, duration, ...foldPausedSet })
        .where(and(eq(meetings.id, m.id), ne(meetings.status, 'completed')))
        .returning({ id: meetings.id });

      activeNativeConnections.delete(m.id);
      nativeSessionsByMeeting.delete(m.id);
      clearPartialTranscript(m.id);
      clearMeetingCache(m.id);
      cleanupResearch(m.id);
      cleanupAutoGrareco(m.id, userId).catch((err) =>
        console.error('[autoGrareco] cleanup error:', err),
      );
      clearMeetingProfileState(m.id);

      markMeetingEnded(m.id, `auto-switch:${userId}`);

      broadcastToUser(userId, 'meeting_ended', { meetingId: m.id });

      sendMeetingEndEmail(m.id, userId, m.title || '無題の会議', endedAt);

      console.log(
        `[NativeWS] auto-ended meeting ${m.id} for user ${userId} (switching to ${exceptMeetingId})`,
      );
    }

    for (const rec of listActiveRecordings()) {
      if (rec.userId === userId && rec.meetingId !== exceptMeetingId) {
        forceCleanupMeeting(rec.meetingId);
        broadcastToUser(userId, 'meeting_ended', { meetingId: rec.meetingId });
        console.log(
          `[NativeWS] force-cleaned registry session ${rec.meetingId} for user ${userId}`,
        );
      }
    }
  } catch (err) {
    console.error('[NativeWS] endOtherActiveMeetingsForUser error:', err);
  }
}

async function handleJsonMessage(
  ws: WebSocket,
  session: NativeWsSession,
  user: { userId: number },
  msg: any
): Promise<void> {
  const msgType = msg.type as string;

  switch (msgType) {
    case 'ping': {
      sendJson(ws, { type: 'pong' });
      break;
    }

    case 'start_meeting': {
      try {
        const title = msg.title || 'Mac Desktop Meeting';
        const platform = msg.platform || 'desktop';
        const mode: MeetingMode = msg.mode === 'real' ? 'real' : 'online';
        const meetingType = VALID_MEETING_TYPES.has(msg.meetingType) ? msg.meetingType : 'general';

        const [newMeeting] = await db.insert(meetings).values({
          userId: user.userId,
          title,
          platform: `${platform}-${mode}`,
          meetingType,
          status: 'active',
          startedAt: new Date(),
          transcriptionStartedAt: new Date(),
        }).returning();

        session.meetingId = newMeeting.id;
        session.startTime = Date.now();
        session.transcriptBuffer = '';
        session.lastSummaryTime = Date.now();
        session.previousSummary = null;
        session.transcriptsWithTime = [];
        session.lastSummaryTranscriptIndex = 0;
        session.consolidationDone = false;

        acquireRecording(newMeeting.id, 'nativeWs', session.connectionId);

        const startedRec = getActiveRecording(newMeeting.id);
        if (startedRec) (startedRec as any).meetingType = meetingType;

        activeNativeConnections.set(newMeeting.id, ws);
        nativeSessionsByMeeting.set(newMeeting.id, session);

        await endOtherActiveMeetingsForUser(user.userId, newMeeting.id);

        console.log(`[NativeWS] Meeting started: ${newMeeting.id} (mode: ${mode})`);
        sendJson(ws, { type: 'meeting_created', meetingId: newMeeting.id });

        await createElevenLabsForSession(ws, session, mode);
      } catch (err) {
        console.error('[NativeWS] Error starting meeting:', err);
        sendJson(ws, { type: 'error', message: '会議の開始に失敗しました' });
      }
      break;
    }

    case 'resume_meeting': {
      try {
        const meetingId = msg.meetingId as number;
        if (!meetingId) {
          sendJson(ws, { type: 'error', message: 'meetingId required' });
          break;
        }

        const [meeting] = await db
          .select()
          .from(meetings)
          .where(and(eq(meetings.id, meetingId), eq(meetings.userId, user.userId)));

        if (!meeting) {
          sendJson(ws, { type: 'error', message: '会議が見つかりません' });
          break;
        }

        const isAutoResume = msg.auto !== false;
        if (isAutoResume && wasRecentlyEndedByOther(meetingId, session.connectionId)) {
          console.warn(
            `[NativeWS] resume_meeting rejected (auto): meeting ${meetingId} was recently ended by a different connection (requester=${session.connectionId})`,
          );
          sendJson(ws, { type: 'meeting_ended', meetingId });
          sendJson(ws, {
            type: 'error',
            code: 'recent_end_by_other',
            meetingId,
            message:
              '別デバイスでこの会議は終了されました。続けて記録したい場合は終了したデバイスから再開してください。新しく始める場合は「新規文字起こし」、過去会議に追記する場合は1分後にお試しください。',
          });
          break;
        }

        if (isAutoResume && meeting.status === 'completed' && meeting.endedAt) {
          console.warn(
            `[NativeWS] resume_meeting rejected (auto): meeting ${meetingId} is already ended (endedAt set)`,
          );
          sendJson(ws, { type: 'meeting_ended', meetingId });
          sendJson(ws, {
            type: 'error',
            code: 'already_ended',
            meetingId,
            message: 'この会議は終了済みです。続けて記録する場合は「新規文字起こし」を開始してください。',
          });
          break;
        }

        if (session.elevenlabs) {
          session.elevenlabs.close();
          session.elevenlabs = null;
        }

        const restored = acquireRecording(meetingId, 'nativeWs', session.connectionId);

        const resumedRec = getActiveRecording(meetingId);
        if (resumedRec) (resumedRec as any).meetingType = meeting.meetingType ?? 'general';

        clearRecentEnd(meetingId);

        await endOtherActiveMeetingsForUser(user.userId, meetingId);

        await db.update(meetings).set({ status: 'active', ...resumeSet }).where(eq(meetings.id, meetingId));

        activeNativeConnections.set(meetingId, ws);
        nativeSessionsByMeeting.set(meetingId, session);

        const mode: MeetingMode = msg.mode === 'real' ? 'real' : 'online';

        if (restored) {
          console.log(`[NativeWS] Restoring paused session for meeting ${meetingId}`);

          session.meetingId = meetingId;
          session.startTime = restored.startTime;
          session.transcriptBuffer = restored.transcriptBuffer;
          session.lastSummaryTime = restored.lastSummaryTime;
          session.previousSummary = restored.previousSummary;
          session.transcriptsWithTime = restored.transcriptsWithTime;
          session.lastSummaryTranscriptIndex = restored.lastSummaryTranscriptIndex;
          session.consolidationDone = restored.consolidationDone;
          session.elevenlabs = restored.elevenlabs;

          rebindElevenLabsCallbacks(ws, session, meetingId);

          registerRecording({
            meetingId,
            userId: session.userId,
            connectionType: 'nativeWs',
            connectionId: session.connectionId,
            elevenlabs: session.elevenlabs,
            summaryTimer: null,
            startTime: session.startTime,
            transcriptBuffer: session.transcriptBuffer,
            previousSummary: session.previousSummary,
            transcriptsWithTime: session.transcriptsWithTime,
            lastSummaryTranscriptIndex: session.lastSummaryTranscriptIndex,
            lastSummaryTime: session.lastSummaryTime,
            consolidationDone: session.consolidationDone,
            onTakeover: (mid, newDevice) => {
              sendJson(ws, { type: 'device_takeover', meetingId: mid, takenOverBy: newDevice });
            },
          });

          sendJson(ws, { type: 'meeting_created', meetingId });
          console.log(`[NativeWS] Meeting resumed (restored): ${meetingId}`);
        } else {

          const [existingSummary] = await db
            .select()
            .from(structuredSummaries)
            .where(eq(structuredSummaries.meetingId, meetingId))
            .orderBy(desc(structuredSummaries.updatedAt))
            .limit(1);

          session.meetingId = meetingId;
          session.startTime = meeting.startedAt ? new Date(meeting.startedAt).getTime() : Date.now();
          session.transcriptBuffer = '';
          session.lastSummaryTime = Date.now();
          session.previousSummary = existingSummary?.content || null;
          session.transcriptsWithTime = [];
          session.lastSummaryTranscriptIndex = 0;

          console.log(`[NativeWS] Meeting resumed (fresh): ${meetingId} (mode: ${mode})`);
          sendJson(ws, { type: 'meeting_created', meetingId });

          await createElevenLabsForSession(ws, session, mode);
        }
      } catch (err) {
        console.error('[NativeWS] Error resuming meeting:', err);
        sendJson(ws, { type: 'error', message: '会議の再開に失敗しました' });
      }
      break;
    }

    case 'pause_meeting': {
      if (session.ending) {
        console.log(
          `[NativeWS] pause_meeting ignored: meeting ${session.meetingId} is being ended`,
        );
        break;
      }
      if (session.meetingId) {
        const [mtg] = await db
          .select({ status: meetings.status })
          .from(meetings)
          .where(eq(meetings.id, session.meetingId));
        if (mtg && mtg.status === 'completed') {
          console.log(
            `[NativeWS] pause_meeting ignored: meeting ${session.meetingId} already completed`,
          );
          if (session.elevenlabs) {
            session.elevenlabs.finalize();
            session.elevenlabs.close();
            session.elevenlabs = null;
          }
          if (session.summaryTimer) {
            clearInterval(session.summaryTimer);
            session.summaryTimer = null;
          }
          const endedMeetingId = session.meetingId;
          session.meetingId = null;
          sendJson(ws, { type: 'meeting_ended', meetingId: endedMeetingId });
          break;
        }
        if (session.elevenlabs) {
          session.elevenlabs.finalize();
          session.elevenlabs.close();
          session.elevenlabs = null;
        }
        if (session.summaryTimer) {
          clearInterval(session.summaryTimer);
          session.summaryTimer = null;
        }
        await db.update(meetings).set({ status: 'paused', ...markPausedSet }).where(eq(meetings.id, session.meetingId));
        console.log(`[NativeWS] Meeting paused: ${session.meetingId}`);
      }
      break;
    }

    case 'reset_transcription': {
      if (!session.meetingId || !session.elevenlabs) {
        sendJson(ws, { type: 'error', message: '文字起こし中ではないため文字起こしをリセットできません' });
        break;
      }
      console.log(`[NativeWS] Transcription reset requested for meeting ${session.meetingId}`);
      session.elevenlabs.forceReconnect();
      sendJson(ws, { type: 'transcription_reset', meetingId: session.meetingId });
      break;
    }

    case 'end_meeting':
    case 'end_meeting_by_id': {
      const endMeetingId = (msg.meetingId as number) || session.meetingId;
      if (!endMeetingId) break;

      session.ending = true;

      try {
        const [ownerRow] = await db
          .select({ userId: meetings.userId })
          .from(meetings)
          .where(eq(meetings.id, endMeetingId));
        if (!ownerRow || ownerRow.userId !== session.userId) {
          console.warn(
            `[NativeWS] end_meeting rejected: meeting ${endMeetingId} is not owned by user ${session.userId}`,
          );
          break;
        }

        releaseRecording(endMeetingId, session.elevenlabs);

        const endedAt = new Date();
        const [mtg] = await db.select().from(meetings).where(eq(meetings.id, endMeetingId));
        const duration = mtg ? recordedDurationSeconds(mtg, endedAt.getTime()) : undefined;

        const completed = await db
          .update(meetings)
          .set({ status: 'completed', endedAt, duration, ...foldPausedSet })
          .where(and(eq(meetings.id, endMeetingId), ne(meetings.status, 'completed')))
          .returning({ id: meetings.id });

        const elevenlabsRef = session.elevenlabs;
        session.elevenlabs = null;
        if (session.summaryTimer) {
          clearInterval(session.summaryTimer);
          session.summaryTimer = null;
        }
        if (elevenlabsRef) {
          elevenlabsRef.finalize();
          await new Promise((r) => setTimeout(r, 2000));
          elevenlabsRef.close();
        }

        if (session.meetingId === endMeetingId) {
          session.meetingId = null;
        }

        activeNativeConnections.delete(endMeetingId);
        nativeSessionsByMeeting.delete(endMeetingId);
        clearPartialTranscript(endMeetingId);

        clearMeetingCache(endMeetingId);
        cleanupResearch(endMeetingId);
        cleanupAutoGrareco(endMeetingId, session.userId).catch((err) =>
          console.error('[autoGrareco] cleanup error:', err),
        );
        clearMeetingProfileState(endMeetingId);
        console.log(`[NativeWS] Meeting ended: ${endMeetingId}`);
        sendJson(ws, { type: 'meeting_ended', meetingId: endMeetingId });
        const broadcastResult = broadcastToUser(
          session.userId,
          'meeting_ended',
          { meetingId: endMeetingId },
          session.connectionId,
        );
        if (broadcastResult.sent > 0) {
          console.log(
            `[NativeWS] meeting_ended broadcasted to ${broadcastResult.sent} other connection(s) for meeting ${endMeetingId}`
          );
        }

        markMeetingEnded(endMeetingId, session.connectionId);

        sendMeetingEndEmail(endMeetingId, session.userId, mtg?.title || '無題の会議', endedAt);
      } catch (err) {
        console.error('[NativeWS] Error ending meeting:', err);
      } finally {
        session.ending = false;
      }
      break;
    }

    case 'dismiss_term': {
      if (msg.term) {
        excludeTerm(user.userId, msg.term).catch(err =>
          console.error('[NativeWS] Exclude term error:', err)
        );
      }
      break;
    }

    case 'research_set_meeting_type': {
      if (session.meetingId && isMeetingType(msg.meetingType)) {
        const rec = getActiveRecording(session.meetingId);
        if (rec) {
          (rec as any).meetingType = msg.meetingType;
        }
      }
      break;
    }

    case 'research_dismiss': {
      console.log(`[research] Card dismissed: ${msg.cardId}`);
      break;
    }

    default:
      break;
  }
}
