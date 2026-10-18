
import { ElevenLabsSession, listLiveSessions } from '../services/elevenLabsService.js';

export type ConnectionType = 'nativeWs' | 'socketIO';

export interface ActiveRecording {
  meetingId: number;
  userId: number;
  connectionType: ConnectionType;
  connectionId: string;
  elevenlabs: ElevenLabsSession;
  summaryTimer: NodeJS.Timeout | null;
  startTime: number;
  transcriptBuffer: string;
  previousSummary: string | null;
  transcriptsWithTime: Array<{ content: string; time: number; transcriptStartTime: number }>;
  lastSummaryTranscriptIndex: number;
  lastSummaryTime: number;
  consolidationDone: boolean;
  onTakeover: (meetingId: number, newDevice: ConnectionType) => void;
}

interface PausedRecording {
  recording: ActiveRecording;
  cleanupTimer: NodeJS.Timeout;
  pausedAt: number;
}

const activeRecordings = new Map<number, ActiveRecording>();
const pausedRecordings = new Map<number, PausedRecording>();

interface RecentEnd {
  endedByConnId: string;
  endedAt: number;
  cleanupTimer: NodeJS.Timeout;
}
const recentEnds = new Map<number, RecentEnd>();
const RECENT_END_TTL_MS = 60_000;

export function acquireRecording(
  meetingId: number,
  connectionType: ConnectionType,
  connectionId: string,
): ActiveRecording | null {
  const paused = pausedRecordings.get(meetingId);
  if (paused) {
    clearTimeout(paused.cleanupTimer);
    pausedRecordings.delete(meetingId);

    const rec = paused.recording;
    if (rec.summaryTimer) {
      clearInterval(rec.summaryTimer);
      rec.summaryTimer = null;
    }
    rec.connectionType = connectionType;
    rec.connectionId = connectionId;
    activeRecordings.set(meetingId, rec);

    console.log(
      `[MeetingRegistry] Restored paused session for meeting ${meetingId} ` +
      `(was ${paused.recording.connectionType}, now ${connectionType}, ` +
      `paused ${Math.round((Date.now() - paused.pausedAt) / 1000)}s ago)`
    );
    return rec;
  }

  const existing = activeRecordings.get(meetingId);
  if (existing && existing.connectionId !== connectionId) {
    console.log(
      `[MeetingRegistry] Takeover: meeting ${meetingId} from ${existing.connectionType}:${existing.connectionId} ` +
      `to ${connectionType}:${connectionId}`
    );

    try {
      existing.onTakeover(meetingId, connectionType);
    } catch (e) {
      console.error('[MeetingRegistry] onTakeover callback error:', e);
    }

    if (existing.summaryTimer) clearInterval(existing.summaryTimer);
    existing.elevenlabs.close();
    activeRecordings.delete(meetingId);

    return null;
  }

  if (existing) {
    if (existing.summaryTimer) clearInterval(existing.summaryTimer);
    existing.elevenlabs.close();
    activeRecordings.delete(meetingId);
  }

  return null;
}

export function registerRecording(recording: ActiveRecording): void {
  const existing = activeRecordings.get(recording.meetingId);
  if (existing && existing.elevenlabs !== recording.elevenlabs) {
    if (existing.summaryTimer) clearInterval(existing.summaryTimer);
    existing.elevenlabs.close();
    console.log(
      `[MeetingRegistry] registerRecording: closed orphan ElevenLabs session for meeting ${recording.meetingId}`
    );
  }
  activeRecordings.set(recording.meetingId, recording);
  console.log(
    `[MeetingRegistry] Registered recording for meeting ${recording.meetingId} ` +
    `(${recording.connectionType}:${recording.connectionId})`
  );
}

export function releaseRecording(
  meetingId: number,
  ownedByCaller?: ElevenLabsSession | null,
): ActiveRecording | null {
  const rec = activeRecordings.get(meetingId);
  if (rec) {
    activeRecordings.delete(meetingId);
    if (rec.elevenlabs !== ownedByCaller) {
      if (rec.summaryTimer) clearInterval(rec.summaryTimer);
      rec.elevenlabs.close();
      console.log(`[MeetingRegistry] Released recording for meeting ${meetingId} (closed orphan ElevenLabs session)`);
    } else {
      console.log(`[MeetingRegistry] Released recording for meeting ${meetingId}`);
    }
  }

  const paused = pausedRecordings.get(meetingId);
  if (paused) {
    clearTimeout(paused.cleanupTimer);
    paused.recording.elevenlabs.close();
    pausedRecordings.delete(meetingId);
    console.log(`[MeetingRegistry] Also cancelled paused recording for meeting ${meetingId}`);
  }

  return rec || null;
}

export function pauseRecording(
  meetingId: number,
  connectionId: string,
  gracePeriodMs: number,
  onExpire: (recording: ActiveRecording) => void,
): boolean {
  const rec = activeRecordings.get(meetingId);
  if (!rec || rec.connectionId !== connectionId) {
    console.log(
      `[MeetingRegistry] pauseRecording skipped for meeting ${meetingId}: ` +
      `current owner=${rec?.connectionId ?? 'none'}, requester=${connectionId}`
    );
    return false;
  }

  activeRecordings.delete(meetingId);

  const cleanupTimer = setTimeout(() => {
    const p = pausedRecordings.get(meetingId);
    if (!p) return;

    pausedRecordings.delete(meetingId);

    if (p.recording.summaryTimer) clearInterval(p.recording.summaryTimer);
    p.recording.elevenlabs.close();

    console.log(`[MeetingRegistry] Grace period expired for meeting ${meetingId}, auto-completing`);
    onExpire(p.recording);
  }, gracePeriodMs);

  pausedRecordings.set(meetingId, {
    recording: rec,
    cleanupTimer,
    pausedAt: Date.now(),
  });

  console.log(
    `[MeetingRegistry] Meeting ${meetingId} paused (${rec.connectionType}), ` +
    `${gracePeriodMs / 1000}s grace period`
  );
  return true;
}

export function getActiveRecording(meetingId: number): ActiveRecording | null {
  return activeRecordings.get(meetingId) ?? null;
}

export function getPausedRecording(meetingId: number): PausedRecording | null {
  return pausedRecordings.get(meetingId) ?? null;
}

export function listActiveRecordings(): Array<{
  meetingId: number;
  userId: number;
  connectionType: ConnectionType;
  connectionId: string;
  state: 'active' | 'paused';
  pausedForMs?: number;
}> {
  const out: Array<{
    meetingId: number;
    userId: number;
    connectionType: ConnectionType;
    connectionId: string;
    state: 'active' | 'paused';
    pausedForMs?: number;
  }> = [];
  for (const rec of activeRecordings.values()) {
    out.push({
      meetingId: rec.meetingId,
      userId: rec.userId,
      connectionType: rec.connectionType,
      connectionId: rec.connectionId,
      state: 'active',
    });
  }
  for (const p of pausedRecordings.values()) {
    out.push({
      meetingId: p.recording.meetingId,
      userId: p.recording.userId,
      connectionType: p.recording.connectionType,
      connectionId: p.recording.connectionId,
      state: 'paused',
      pausedForMs: Date.now() - p.pausedAt,
    });
  }
  return out;
}

export function forceCleanupMeeting(meetingId: number): {
  hadActive: boolean;
  hadPaused: boolean;
} {
  let hadActive = false;
  let hadPaused = false;

  const active = activeRecordings.get(meetingId);
  if (active) {
    if (active.summaryTimer) clearInterval(active.summaryTimer);
    active.elevenlabs.close();
    activeRecordings.delete(meetingId);
    hadActive = true;
  }

  const paused = pausedRecordings.get(meetingId);
  if (paused) {
    clearTimeout(paused.cleanupTimer);
    if (paused.recording.summaryTimer) clearInterval(paused.recording.summaryTimer);
    paused.recording.elevenlabs.close();
    pausedRecordings.delete(meetingId);
    hadPaused = true;
  }

  const recent = recentEnds.get(meetingId);
  if (recent) {
    clearTimeout(recent.cleanupTimer);
    recentEnds.delete(meetingId);
  }

  console.log(
    `[MeetingRegistry] Force cleanup meeting ${meetingId}: active=${hadActive}, paused=${hadPaused}`,
  );
  return { hadActive, hadPaused };
}

export function markMeetingEnded(meetingId: number, endedByConnId: string): void {
  const prev = recentEnds.get(meetingId);
  if (prev) clearTimeout(prev.cleanupTimer);

  const cleanupTimer = setTimeout(() => {
    recentEnds.delete(meetingId);
  }, RECENT_END_TTL_MS);

  recentEnds.set(meetingId, {
    endedByConnId,
    endedAt: Date.now(),
    cleanupTimer,
  });
}

export function wasRecentlyEndedByOther(meetingId: number, requestingConnId: string): boolean {
  const entry = recentEnds.get(meetingId);
  if (!entry) return false;
  if (entry.endedByConnId === requestingConnId) return false;
  return true;
}

export function clearRecentEnd(meetingId: number): void {
  const entry = recentEnds.get(meetingId);
  if (entry) {
    clearTimeout(entry.cleanupTimer);
    recentEnds.delete(meetingId);
  }
}

const ORPHAN_GRACE_MS = 60_000;
const ORPHAN_SWEEP_INTERVAL_MS = 30_000;

let orphanSweeper: NodeJS.Timeout | null = null;

function ownedSessions(): Set<ElevenLabsSession> {
  const owned = new Set<ElevenLabsSession>();
  for (const rec of activeRecordings.values()) owned.add(rec.elevenlabs);
  for (const p of pausedRecordings.values()) owned.add(p.recording.elevenlabs);
  return owned;
}

export function sweepOrphanSessions(now: number = Date.now()): number {
  const owned = ownedSessions();
  let closed = 0;
  for (const session of listLiveSessions()) {
    if (owned.has(session)) continue;
    if (now - session.createdAt < ORPHAN_GRACE_MS) continue;
    console.warn(
      `[MeetingRegistry] 孤児セッションを回収: ${session.sessionId} ` +
        `(生成から ${Math.round((now - session.createdAt) / 1000)}秒・どの録音からも参照されていない)`
    );
    session.close();
    closed++;
  }
  return closed;
}

export function startOrphanSweeper(): void {
  if (orphanSweeper) return;
  orphanSweeper = setInterval(() => {
    try {
      sweepOrphanSessions();
    } catch (err) {
      console.error('[MeetingRegistry] 孤児スイープに失敗:', err);
    }
  }, ORPHAN_SWEEP_INTERVAL_MS);
  orphanSweeper.unref?.();
  console.log(`[MeetingRegistry] 孤児 ElevenLabs セッションのスイーパーを開始（${ORPHAN_SWEEP_INTERVAL_MS / 1000}秒ごと）`);
}

export function stopOrphanSweeper(): void {
  if (orphanSweeper) {
    clearInterval(orphanSweeper);
    orphanSweeper = null;
  }
}
