
const SCAN_INTERVAL_MS = 30 * 1000;
const SILENCE_GRACE_MS = 5 * 60 * 1000;
const SILENCE_GAP_MS = 75 * 1000;
const SILENCE_LOOKBACK_MS = 120 * 1000;
const SILENCE_RATIO_THRESHOLD = 0.4;
const SILENCE_COOLDOWN_MS = 8 * 60 * 1000;

const FALLBACK_INTERVAL_MS = 10 * 60 * 1000;

interface ActiveMeeting {
  meetingId: number;
  userId: number;
  startedAt: number;
  lastTranscriptAt: number;
  lastSilenceFireAt: number;
  lastAnyFireAt: number;
}

const activeMeetings = new Map<number, ActiveMeeting>();

export interface SilenceFireCallbacks {
  fireDiscover: (meetingId: number, userId: number) => Promise<void>;
  fireFallback: (meetingId: number, userId: number) => Promise<void>;
  getRecentSpokenStats: (meetingId: number) => Promise<{ recentCount: number; priorCount: number }>;
  isMeetingActive: (meetingId: number) => Promise<boolean>;
  shouldFireDiscover: (userId: number) => Promise<boolean>;
  shouldFireFallback: (userId: number) => Promise<boolean>;
}

let intervalHandle: NodeJS.Timeout | null = null;
let callbacks: SilenceFireCallbacks | null = null;

export function startSilenceDetector(cb: SilenceFireCallbacks): void {
  if (intervalHandle) return;
  callbacks = cb;
  intervalHandle = setInterval(() => {
    void scanLoop();
  }, SCAN_INTERVAL_MS);
  console.log('[silenceDetector] started');
}

export function stopSilenceDetector(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  callbacks = null;
  activeMeetings.clear();
  console.log('[silenceDetector] stopped');
}

export function registerActiveMeeting(meetingId: number, userId: number): void {
  let m = activeMeetings.get(meetingId);
  if (m) {
    m.lastTranscriptAt = Date.now();
    return;
  }
  m = {
    meetingId,
    userId,
    startedAt: Date.now(),
    lastTranscriptAt: Date.now(),
    lastSilenceFireAt: 0,
    lastAnyFireAt: 0,
  };
  activeMeetings.set(meetingId, m);
  console.log(`[silenceDetector] register meeting=${meetingId} userId=${userId}`);
}

export function recordTranscript(meetingId: number): void {
  const m = activeMeetings.get(meetingId);
  if (m) m.lastTranscriptAt = Date.now();
}

export function recordAnyFire(meetingId: number): void {
  const m = activeMeetings.get(meetingId);
  if (m) m.lastAnyFireAt = Date.now();
}

export function unregisterMeeting(meetingId: number): void {
  activeMeetings.delete(meetingId);
}

async function scanLoop(): Promise<void> {
  if (!callbacks) return;
  const now = Date.now();

  for (const m of activeMeetings.values()) {
    try {
      const active = await callbacks.isMeetingActive(m.meetingId);
      if (!active) {
        activeMeetings.delete(m.meetingId);
        continue;
      }

      const meetingAge = now - m.startedAt;
      if (meetingAge < SILENCE_GRACE_MS) continue;

      const sinceLastSilenceFire = now - m.lastSilenceFireAt;
      if (sinceLastSilenceFire >= SILENCE_COOLDOWN_MS) {
        if (await callbacks.shouldFireDiscover(m.userId)) {
          const sinceLastSpoken = now - m.lastTranscriptAt;
          if (sinceLastSpoken >= SILENCE_GAP_MS) {
            const stats = await callbacks.getRecentSpokenStats(m.meetingId);
            const ratio = stats.priorCount > 0 ? stats.recentCount / stats.priorCount : 0;
            if (ratio < SILENCE_RATIO_THRESHOLD) {
              console.log(`[silenceDetector] silence detected meeting=${m.meetingId} gap=${Math.round(sinceLastSpoken / 1000)}s ratio=${ratio.toFixed(2)}`);
              try {
                await callbacks.fireDiscover(m.meetingId, m.userId);
                m.lastSilenceFireAt = now;
                m.lastAnyFireAt = now;
              } catch (err) {
                console.error('[silenceDetector] fireDiscover failed:', err instanceof Error ? err.message : err);
              }
              continue;
            }
          }
        }
      }

      const sinceLastAny = now - m.lastAnyFireAt;
      if (sinceLastAny >= FALLBACK_INTERVAL_MS) {
        if (await callbacks.shouldFireFallback(m.userId)) {
          console.log(`[silenceDetector] fallback fire meeting=${m.meetingId} sinceLastAny=${Math.round(sinceLastAny / 1000)}s`);
          try {
            await callbacks.fireFallback(m.meetingId, m.userId);
            m.lastAnyFireAt = now;
          } catch (err) {
            console.error('[silenceDetector] fireFallback failed:', err instanceof Error ? err.message : err);
          }
        }
      }
    } catch (err) {
      console.error(`[silenceDetector] scan error meeting=${m.meetingId}:`, err instanceof Error ? err.message : err);
    }
  }
}

export const __test__ = {
  SILENCE_GAP_MS,
  SILENCE_RATIO_THRESHOLD,
  FALLBACK_INTERVAL_MS,
};
