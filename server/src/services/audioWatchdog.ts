import { sql, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { meetings } from '../db/schema.js';

export const AUDIO_STALE_THRESHOLD_MS = 60_000;

const STAMP_THROTTLE_MS = 10_000;

const lastStampedAt = new Map<number, number>();

export function markAudioReceived(meetingId: number | null | undefined): void {
  if (!meetingId) return;
  const now = Date.now();
  const prev = lastStampedAt.get(meetingId) ?? 0;
  if (now - prev < STAMP_THROTTLE_MS) return;
  if (lastStampedAt.size > 2000) {
    for (const [id, ts] of lastStampedAt) {
      if (now - ts > AUDIO_STALE_THRESHOLD_MS) lastStampedAt.delete(id);
    }
  }
  lastStampedAt.set(meetingId, now);
  db.update(meetings)
    .set({ lastAudioAt: sql`now()` })
    .where(eq(meetings.id, meetingId))
    .catch((err) => console.error(`[AudioWatchdog] stamp failed. meetingId=${meetingId}`, err));
}

export function pruneAudioStamps(activeMeetingIds: Set<number>): void {
  for (const id of lastStampedAt.keys()) {
    if (!activeMeetingIds.has(id)) lastStampedAt.delete(id);
  }
}
