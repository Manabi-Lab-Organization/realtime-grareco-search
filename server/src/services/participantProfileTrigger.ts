import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { meetings } from '../db/schema.js';
import { profileFromTranscripts } from './participantProfilerService.js';
import { mergeAndUpdateParticipants } from './participantMergeService.js';
import { refreshSessionKeyterms } from './keytermsBuilder.js';
import { broadcastToUser } from './research/connectionRegistry.js';

const FINAL_COUNT_THRESHOLD = 50;
const ELAPSED_MS_THRESHOLD = 10 * 60 * 1000;
const REPROFILE_COOLDOWN_MS = 60 * 1000;

interface TriggerState {
  finalCount: number;
  startedAt: number;
  triggered: boolean;
  loaded: boolean;
  lastReprofileAt: number;
}

const stateMap = new Map<number, TriggerState>();

async function ensureState(meetingId: number): Promise<TriggerState> {
  const cached = stateMap.get(meetingId);
  if (cached?.loaded) return cached;

  const [row] = await db
    .select({ startedAt: meetings.startedAt, doneAt: meetings.initialProfilingDoneAt })
    .from(meetings)
    .where(eq(meetings.id, meetingId))
    .limit(1);

  const state: TriggerState = {
    finalCount: cached?.finalCount ?? 0,
    startedAt: row?.startedAt?.getTime() ?? Date.now(),
    triggered: !!row?.doneAt,
    loaded: true,
    lastReprofileAt: cached?.lastReprofileAt ?? 0,
  };
  stateMap.set(meetingId, state);
  return state;
}

export async function maybeTriggerInitialProfile(meetingId: number, userId: number): Promise<void> {
  const state = await ensureState(meetingId);
  if (state.triggered) return;

  state.finalCount += 1;
  const elapsed = Date.now() - state.startedAt;
  const shouldFire = state.finalCount >= FINAL_COUNT_THRESHOLD || elapsed >= ELAPSED_MS_THRESHOLD;
  if (!shouldFire) return;

  state.triggered = true;

  void (async () => {
    try {
      const result = await profileFromTranscripts(meetingId, { mode: 'initial' });
      await mergeAndUpdateParticipants(meetingId);
      await refreshSessionKeyterms(meetingId);
      await db
        .update(meetings)
        .set({ initialProfilingDoneAt: new Date() })
        .where(eq(meetings.id, meetingId));

      broadcastToUser(userId, 'participants_updated', { meetingId });

      console.log(
        `[ProfileTrigger] meeting=${meetingId} initial profile fired (count=${state.finalCount}, elapsed=${Math.floor(elapsed / 1000)}s, extracted=${result.extractedCount})`
      );
    } catch (err) {
      console.error('[ProfileTrigger] Initial profile error (one-shot, will not auto-retry):', err);
    }
  })();
}

export async function triggerReprofile(
  meetingId: number,
  userId: number,
  options?: { windowMs?: number }
): Promise<{ extractedCount: number; cooldownRemainingMs: number }> {
  const state = await ensureState(meetingId);
  const now = Date.now();
  const sinceLast = now - state.lastReprofileAt;
  if (sinceLast < REPROFILE_COOLDOWN_MS) {
    return { extractedCount: 0, cooldownRemainingMs: REPROFILE_COOLDOWN_MS - sinceLast };
  }
  state.lastReprofileAt = now;

  const result = await profileFromTranscripts(meetingId, {
    mode: 'reprofile',
    windowMs: options?.windowMs,
  });
  await mergeAndUpdateParticipants(meetingId);
  await refreshSessionKeyterms(meetingId);

  broadcastToUser(userId, 'participants_updated', { meetingId });

  console.log(
    `[ProfileTrigger] meeting=${meetingId} reprofile fired (extracted=${result.extractedCount})`
  );
  return { extractedCount: result.extractedCount, cooldownRemainingMs: 0 };
}

export function clearMeetingProfileState(meetingId: number): void {
  stateMap.delete(meetingId);
}
