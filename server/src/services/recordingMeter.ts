import { sql } from 'drizzle-orm';
import { meetings } from '../db/schema.js';

export const markPausedSet = {
  pausedSince: sql`COALESCE(${meetings.pausedSince}, now())`,
};

export const foldPausedSet = {
  pausedSeconds: sql`${meetings.pausedSeconds} + COALESCE(EXTRACT(EPOCH FROM (now() - ${meetings.pausedSince}))::int, 0)`,
  pausedSince: sql`NULL`,
};

export const resumeSet = {
  transcriptionStartedAt: sql`CASE WHEN ${meetings.status} IN ('completed', 'idle') THEN now() ELSE COALESCE(${meetings.transcriptionStartedAt}, now()) END`,
  pausedSeconds: sql`CASE WHEN ${meetings.status} IN ('completed', 'idle') THEN 0 ELSE ${meetings.pausedSeconds} + COALESCE(EXTRACT(EPOCH FROM (now() - ${meetings.pausedSince}))::int, 0) END`,
  pausedSince: sql`NULL`,
  lastAudioAt: sql`now()`,
};

export function recordedSecondsAt(
  transcriptionStartedAt: Date | string | null | undefined,
  refTimeMs: number,
  pausedSeconds: number | null | undefined,
  pausedSince: Date | string | null | undefined,
): number {
  if (!transcriptionStartedAt) return 0;
  const tsaMs = new Date(transcriptionStartedAt).getTime();
  const grossSec = Math.floor((refTimeMs - tsaMs) / 1000);
  const openPauseSec = pausedSince
    ? Math.max(0, Math.floor((refTimeMs - new Date(pausedSince).getTime()) / 1000))
    : 0;
  return Math.max(0, grossSec - (pausedSeconds ?? 0) - openPauseSec);
}

export function recordedDurationSeconds(
  meeting: {
    transcriptionStartedAt?: Date | string | null;
    pausedSeconds?: number | null;
    pausedSince?: Date | string | null;
  },
  endedAtMs: number,
): number {
  return recordedSecondsAt(
    meeting.transcriptionStartedAt,
    endedAtMs,
    meeting.pausedSeconds,
    meeting.pausedSince,
  );
}
