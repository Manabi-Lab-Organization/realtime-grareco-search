import { and, eq, ne, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { meetings, users } from '../db/schema.js';
import { listActiveRecordings, forceCleanupMeeting, type ConnectionType } from '../websocket/meetingRegistry.js';
import { recordedDurationSeconds, foldPausedSet } from './recordingMeter.js';
import { broadcastToUser, broadcastToUserWhere } from './research/connectionRegistry.js';
import { revokeAllTokens } from './apiTokenService.js';
import { audit } from './audit/audit.js';

export async function deleteWebSessions(userId: number): Promise<void> {
  await db.execute(sql`DELETE FROM session WHERE (sess->>'userId')::int = ${userId}`);
}

export async function rotateApiToken(userId: number, reason = 'invalidate_all'): Promise<number> {
  return revokeAllTokens(userId, reason);
}

export async function terminateUserLiveMeetings(
  userId: number,
  connectionTypes?: ConnectionType[],
): Promise<number> {
  const recs = listActiveRecordings().filter(
    (r) => r.userId === userId && (!connectionTypes || connectionTypes.includes(r.connectionType)),
  );
  for (const r of recs) {
    try {
      const [m] = await db.select().from(meetings).where(eq(meetings.id, r.meetingId));
      if (m && m.status !== 'completed') {
        const endedAt = new Date();
        const duration = recordedDurationSeconds(m, endedAt.getTime());
        await db
          .update(meetings)
          .set({ status: 'completed', endedAt, duration, ...foldPausedSet })
          .where(and(eq(meetings.id, r.meetingId), ne(meetings.status, 'completed')));
      }
    } catch (err) {
      console.error(`[AuthSession] terminate meeting ${r.meetingId} failed:`, err);
    }
    forceCleanupMeeting(r.meetingId);
  }
  return recs.length;
}

export type InvalidateReason =
  | 'password.change'
  | 'password.reset'
  | 'account.delete'
  | 'admin.user_delete'
  | 'admin.suspend'
  | 'admin.password_reset'
  | 'invalidate_all_access';

export async function invalidateAllUserAccess(userId: number, reason: InvalidateReason = 'invalidate_all_access'): Promise<void> {
  await deleteWebSessions(userId);
  const revokedTokens = await rotateApiToken(userId, reason);
  await audit('token.revoke', {
    target: { type: 'api_token', id: userId },
    detail: { reason, scope: 'all', revokedTokens, webSessions: 'deleted' },
  });
  await terminateUserLiveMeetings(userId).catch((err) =>
    console.error('[AuthSession] terminate live meetings failed:', err),
  );
  broadcastToUser(userId, 'session_invalidated', {});
}

export async function logoutOtherDevices(
  userId: number,
  current: { tokenId?: number | null; sessionId?: string | null },
): Promise<{ revokedTokens: number; deletedSessions: number }> {
  const revokedTokens = await revokeAllTokens(userId, 'logout_others', current.tokenId ?? null);
  const keepTokenId = current.tokenId ?? null;
  const keepSid = current.sessionId ?? null;
  const result = await db.execute(sql`
    DELETE FROM session
    WHERE (sess->>'userId')::int = ${userId}
      AND (${keepSid}::text IS NULL OR sid <> ${keepSid}::text)
      AND (${keepTokenId}::int IS NULL OR (sess->>'apiTokenId') IS NULL OR (sess->>'apiTokenId')::int <> ${keepTokenId}::int)
  `);
  broadcastToUserWhere(userId, 'session_invalidated', {}, (sub) => {
    if (keepTokenId != null && sub.tokenId === keepTokenId) return false;
    if (keepSid != null && sub.sessionId === keepSid) return false;
    return true;
  });
  return { revokedTokens, deletedSessions: result.rowCount ?? 0 };
}

export function notifyTokenRevoked(userId: number, tokenId: number): void {
  broadcastToUserWhere(userId, 'session_invalidated', {}, (sub) => sub.tokenId === tokenId);
}
