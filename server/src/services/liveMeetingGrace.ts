import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { meetings } from '../db/schema.js';

export const LIVE_MEETING_STATUSES = ['active', 'paused'] as const;
export const LIVE_MEETING_STALE_HOURS = 12;
const HOUR_MS = 60 * 60 * 1000;

export interface MeetingLiveness {
  status: string;
  lastAudioAt?: Date | null;
  transcriptionStartedAt?: Date | null;
  startedAt?: Date | null;
}

export function isLiveMeeting(m: MeetingLiveness, now: number = Date.now()): boolean {
  if (!(LIVE_MEETING_STATUSES as readonly string[]).includes(m.status)) return false;
  const last = m.lastAudioAt ?? m.transcriptionStartedAt ?? m.startedAt;
  if (!last) return false;
  return now - last.getTime() <= LIVE_MEETING_STALE_HOURS * HOUR_MS;
}

export function applyLiveMeetingGrace(expired: boolean, hasLive: boolean): 'valid' | 'grace' | 'expired' {
  if (!expired) return 'valid';
  return hasLive ? 'grace' : 'expired';
}

const liveCache = new Map<number, { live: boolean; at: number }>();
const LIVE_CACHE_MS = 30_000;

export async function hasLiveMeeting(userId: number, now: number = Date.now()): Promise<boolean> {
  const c = liveCache.get(userId);
  if (c && now - c.at < LIVE_CACHE_MS) return c.live;
  let live = false;
  try {
    const rows = await db
      .select({
        status: meetings.status,
        lastAudioAt: meetings.lastAudioAt,
        transcriptionStartedAt: meetings.transcriptionStartedAt,
        startedAt: meetings.startedAt,
      })
      .from(meetings)
      .where(and(eq(meetings.userId, userId), inArray(meetings.status, [...LIVE_MEETING_STATUSES])))
      .orderBy(sql`${meetings.id} DESC`)
      .limit(5);
    live = rows.some((m) => isLiveMeeting(m, now));
  } catch (err) {
    console.error('[liveMeetingGrace] 会議状態の確認に失敗:', err instanceof Error ? err.message : String(err));
    return false;
  }
  liveCache.set(userId, { live, at: now });
  if (liveCache.size > 10_000) liveCache.clear();
  return live;
}

export function clearLiveMeetingCache(): void {
  liveCache.clear();
}
