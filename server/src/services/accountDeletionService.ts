import { eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  users,
  meetings,
  userTermDictionary,
  userTermExclusions,
  announcementReads,
  desktopExchangeCodes,
  apiTokens,
  inviteRedemptions,
} from '../db/schema.js';
import { invalidateAllUserAccess, type InvalidateReason } from './authSessionService.js';

export function isAnonymizedEmail(email: string): boolean {
  return email.startsWith('deleted+') && email.endsWith('@removed.local');
}

export async function deleteUserAccount(userId: number, reason: InvalidateReason = 'account.delete'): Promise<void> {
  const [target] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!target) return;

  if (isAnonymizedEmail(target.email)) return;

  await db.transaction(async (tx) => {
    await tx.delete(meetings).where(eq(meetings.userId, userId));
    await tx.delete(userTermDictionary).where(eq(userTermDictionary.userId, userId));
    await tx.delete(userTermExclusions).where(eq(userTermExclusions.userId, userId));
    await tx.delete(announcementReads).where(eq(announcementReads.userId, userId));
    await tx.delete(desktopExchangeCodes).where(eq(desktopExchangeCodes.userId, userId));
    await tx.delete(apiTokens).where(eq(apiTokens.userId, userId));
    await tx.delete(inviteRedemptions).where(eq(inviteRedemptions.userId, userId));

    await tx
      .update(users)
      .set({
        email: `deleted+${userId}@removed.local`,
        passwordHash: null,
        googleId: null,
        apiToken: null,
        apiTokenHash: null,
        resetToken: null,
        resetTokenHash: null,
        resetTokenExpiry: null,
        displayName: '削除済みユーザー',
        inviteVerified: false,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));

    await tx.execute(sql`
      DELETE FROM session
      WHERE (sess->>'userId')::int = ${userId}
    `);
  });

  await invalidateAllUserAccess(userId, reason);
}
