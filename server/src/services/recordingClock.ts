
import { and, eq, lt, max } from 'drizzle-orm';
import { db } from '../db/index.js';
import { transcripts } from '../db/schema.js';
import { recordedSecondsAt } from './recordingMeter.js';

interface MeetingClock {
  id: number;
  transcriptionStartedAt: Date | string | null;
  pausedSeconds: number | null;
  pausedSince: Date | string | null;
}

export function displayRecordingMs(
  priorSessionsMs: number,
  transcriptionStartedAt: Date | string | null | undefined,
  nowMs: number,
  pausedSeconds: number | null | undefined,
  pausedSince: Date | string | null | undefined,
): number | null {
  if (!transcriptionStartedAt) return null;
  return priorSessionsMs + recordedSecondsAt(transcriptionStartedAt, nowMs, pausedSeconds, pausedSince) * 1000;
}

const priorCache = new Map<string, number>();
const PRIOR_CACHE_MAX = 500;

async function priorSessionsMs(meetingId: number, sessionStartedAt: Date): Promise<number> {
  const key = `${meetingId}:${sessionStartedAt.getTime()}`;
  const cached = priorCache.get(key);
  if (cached !== undefined) return cached;
  const [row] = await db
    .select({ v: max(transcripts.recordingMs) })
    .from(transcripts)
    .where(and(eq(transcripts.meetingId, meetingId), lt(transcripts.createdAt, sessionStartedAt)));
  const value = row?.v ?? 0;
  if (priorCache.size >= PRIOR_CACHE_MAX) priorCache.clear();
  priorCache.set(key, value);
  return value;
}

export async function recordingMsForNewTranscript(meeting: MeetingClock | null | undefined): Promise<number | null> {
  if (!meeting?.transcriptionStartedAt) return null;
  const sessionStartedAt = new Date(meeting.transcriptionStartedAt);
  const prior = await priorSessionsMs(meeting.id, sessionStartedAt).catch(() => 0);
  return displayRecordingMs(prior, sessionStartedAt, Date.now(), meeting.pausedSeconds, meeting.pausedSince);
}
