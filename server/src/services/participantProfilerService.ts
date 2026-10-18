import { eq, and, gte } from 'drizzle-orm';
import { db } from '../db/index.js';
import { meetings, transcripts, participantConversationExtractions } from '../db/schema.js';
import { extractParticipantsFromConversation } from './geminiService.js';
import { parseNgKeywords, filterNgTranscripts } from './ngKeywordFilterService.js';

export type ProfilerMode = 'initial' | 'reprofile';

export interface ProfilerOptions {
  mode: ProfilerMode;
  windowMs?: number;
  maxLines?: number;
}

export interface ProfilerResult {
  extractedCount: number;
  source: ProfilerMode;
}

const DEFAULT_INITIAL_MAX_LINES = 200;
const DEFAULT_REPROFILE_WINDOW_MS = 5 * 60 * 1000;

function formatTs(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

export async function profileFromTranscripts(
  meetingId: number,
  options: ProfilerOptions
): Promise<ProfilerResult> {
  const { mode } = options;

  const [meeting] = await db
    .select()
    .from(meetings)
    .where(eq(meetings.id, meetingId))
    .limit(1);
  if (!meeting) {
    return { extractedCount: 0, source: mode };
  }

  let rows;
  if (mode === 'reprofile') {
    const windowMs = options.windowMs ?? DEFAULT_REPROFILE_WINDOW_MS;
    const cutoff = Date.now() - windowMs;
    rows = await db
      .select()
      .from(transcripts)
      .where(
        and(
          eq(transcripts.meetingId, meetingId),
          eq(transcripts.isFinal, true),
          gte(transcripts.createdAt, new Date(cutoff))
        )
      )
      .orderBy(transcripts.startTime);
  } else {
    const maxLines = options.maxLines ?? DEFAULT_INITIAL_MAX_LINES;
    rows = await db
      .select()
      .from(transcripts)
      .where(and(eq(transcripts.meetingId, meetingId), eq(transcripts.isFinal, true)))
      .orderBy(transcripts.startTime)
      .limit(maxLines);
  }

  rows = filterNgTranscripts(rows, parseNgKeywords(meeting.ngKeywords));

  console.log(`[Profiler] meeting=${meetingId} mode=${mode} fetched ${rows.length} transcript rows`);
  if (rows.length === 0) {
    return { extractedCount: 0, source: mode };
  }

  const transcriptText = rows
    .filter((r) => r.content && r.content.trim().length > 0)
    .map((r) => `[${formatTs(r.startTime)}] ${r.content.trim()}`)
    .join('\n');

  if (!transcriptText) {
    console.log(`[Profiler] meeting=${meetingId} no usable content`);
    return { extractedCount: 0, source: mode };
  }

  const knownNames = Array.isArray(meeting.participants)
    ? (meeting.participants as Array<{ name?: string }>).map((p) => String(p?.name ?? '').trim()).filter((n) => n)
    : [];

  const extracted = await extractParticipantsFromConversation(transcriptText, knownNames);
  console.log(`[Profiler] meeting=${meetingId} Gemini returned ${extracted.length} participant candidates`);

  await db.insert(participantConversationExtractions).values({
    meetingId,
    origin: mode,
    aiExtractedParticipants: extracted,
  });

  return { extractedCount: extracted.length, source: mode };
}
