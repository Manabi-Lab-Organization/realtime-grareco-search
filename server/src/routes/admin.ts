import { Router, type Request } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { eq, sql, desc, and, inArray, gte } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  users,
  meetings,
  inviteCodes,
  inviteRedemptions,
  announcements,
} from '../db/schema.js';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/admin.js';
import { hasRecentAuth, requireRecentAuth, sendReauthRequired } from '../middleware/recentAuth.js';
import { deleteUserAccount } from '../services/accountDeletionService.js';
import { adminResetPassword } from '../services/authService.js';
import { listActiveRecordings, forceCleanupMeeting } from '../websocket/meetingRegistry.js';
import { audit, auditLater, type AuditOptions } from '../services/audit/audit.js';
import { authUserId, getAuth } from '../middleware/authContext.js';

const router = Router();
router.use(requireAuth);
router.use(requireAdmin);

function adminAudit(req: Request, event: string, opts: Omit<AuditOptions, 'actor' | 'strict'>): Promise<void> {
  return audit(event, {
    ...opts,
    actor: { id: authUserId(req), email: getAuth(req)?.email ?? null, role: 'admin', authMethod: 'session' },
    strict: true,
  }, req);
}

async function userSnapshot(userId: number) {
  const [row] = await db
    .select({
      role: users.role,
      inviteVerified: users.inviteVerified,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row ?? null;
}

const updateUserSchema = z.object({
  role: z.enum(['user', 'admin']).optional(),
  inviteVerified: z.boolean().optional(),
});

router.get('/users', async (_req, res, next) => {
  try {
    const rows = await db.execute(sql`
      SELECT
        u.id,
        u.email,
        u.display_name AS "displayName",
        u.role,
        u.invite_verified AS "inviteVerified",
        u.invite_verified_at AS "inviteVerifiedAt",
        u.created_at AS "createdAt",
        COALESCE(m.meeting_count, 0)::int AS "meetingCount"
      FROM users u
      LEFT JOIN (
        SELECT user_id, COUNT(*) AS meeting_count
        FROM meetings
        GROUP BY user_id
      ) m ON m.user_id = u.id
      ORDER BY u.created_at DESC
    `);

    await adminAudit(_req, 'admin.user_list', { target: { type: 'user' }, detail: { count: rows.rows.length } });
    res.json(rows.rows);
  } catch (err) {
    next(err);
  }
});

router.patch('/users/:id', async (req, res, next) => {
  try {
    const userId = parseInt(req.params.id, 10);
    if (isNaN(userId)) {
      res.status(400).json({ error: 'Invalid user ID' });
      return;
    }

    const body = updateUserSchema.parse(req.body);
    if (body.role !== undefined && !(await hasRecentAuth(req))) {
      sendReauthRequired(res);
      return;
    }
    const before = await userSnapshot(userId);

    if (body.role === 'user') {
      const [target] = await db
        .select({ role: users.role })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (target?.role === 'admin') {
        const adminCountResult = await db.execute(sql`
          SELECT COUNT(*)::int AS count FROM users
          WHERE role = 'admin'
        `);
        const adminCount = Number((adminCountResult.rows[0] as { count?: number } | undefined)?.count ?? 0);
        if (adminCount <= 1) {
          res.status(400).json({ error: 'last_admin', message: '管理者が1人もいなくなるため、一般の利用者には戻せません' });
          return;
        }
      }
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (body.role !== undefined) updates.role = body.role;
    if (body.inviteVerified !== undefined) {
      updates.inviteVerified = body.inviteVerified;
      if (body.inviteVerified) updates.inviteVerifiedAt = new Date();
    }

    if (Object.keys(updates).length > 1) {
      await db.update(users).set(updates).where(eq(users.id, userId));
    }

    const [updated] = await db
      .select({
        id: users.id,
        email: users.email,
        role: users.role,
        inviteVerified: users.inviteVerified,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!updated) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const target = { type: 'user', id: userId };
    if (body.role !== undefined) {
      await adminAudit(req, 'admin.role_change', { target, detail: { before: before?.role ?? null, after: updated.role } });
    }
    const changes: Record<string, { before: unknown; after: unknown }> = {};
    if (body.inviteVerified !== undefined) changes.inviteVerified = { before: before?.inviteVerified ?? null, after: updated.inviteVerified };
    if (Object.keys(changes).length > 0) {
      await adminAudit(req, 'admin.user_update', { target, detail: { changes } });
    }

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

function isAnonymizedEmail(email: string): boolean {
  return email.startsWith('deleted+') && email.endsWith('@removed.local');
}

router.delete('/users/:id', requireRecentAuth, async (req, res, next) => {
  try {
    const targetId = parseInt(req.params.id, 10);
    if (isNaN(targetId)) {
      res.status(400).json({ error: 'Invalid user ID' });
      return;
    }

    const adminId = authUserId(req);
    if (targetId === adminId) {
      res.status(400).json({ error: '自分自身は削除できません' });
      return;
    }

    const [target] = await db.select().from(users).where(eq(users.id, targetId)).limit(1);
    if (!target) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    if (isAnonymizedEmail(target.email)) {
      res.json({ ok: true, alreadyDeleted: true });
      return;
    }

    const confirm = typeof req.body?.confirm === 'string' ? req.body.confirm.trim() : '';
    if (confirm !== target.email) {
      res.status(400).json({ error: 'confirm_mismatch', message: '確認用メールアドレスが一致しません' });
      return;
    }

    if (target.role === 'admin') {
      const adminCountResult = await db.execute(sql`
        SELECT COUNT(*)::int AS count FROM users
        WHERE role = 'admin'
          AND email NOT LIKE 'deleted+%@removed.local'
      `);
      const adminCount = Number((adminCountResult.rows[0] as { count?: number } | undefined)?.count ?? 0);
      if (adminCount <= 1) {
        res.status(400).json({ error: 'last_admin', message: '管理者が1人もいなくなるため、削除できません' });
        return;
      }
    }

    await deleteUserAccount(targetId, 'admin.user_delete');

    await adminAudit(req, 'admin.user_delete', {
      target: { type: 'user', id: targetId },
      detail: { before: { email: target.email, role: target.role, createdAt: target.createdAt } },
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/users/:id/reset-password', requireRecentAuth, async (req, res, next) => {
  try {
    const targetId = parseInt(req.params.id, 10);
    if (isNaN(targetId)) {
      res.status(400).json({ error: 'Invalid user ID' });
      return;
    }
    const [target] = await db.select({ email: users.email }).from(users).where(eq(users.id, targetId)).limit(1);
    if (!target || isAnonymizedEmail(target.email)) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    const temporaryPassword = await adminResetPassword(targetId);
    await adminAudit(req, 'admin.password_reset', { target: { type: 'user', id: targetId } });
    res.json({ temporaryPassword });
  } catch (err) {
    next(err);
  }
});

router.get('/analytics/overview', async (_req, res, next) => {
  try {
    const result = await db.execute(sql`
      SELECT
        (SELECT COUNT(*)::int FROM users) AS "totalUsers",
        (SELECT COUNT(*)::int FROM users WHERE invite_verified = true) AS "verifiedUsers",
        (SELECT COUNT(*)::int FROM users WHERE created_at >= now() - interval '7 days') AS "newUsers7d",
        (SELECT COUNT(*)::int FROM users WHERE created_at >= now() - interval '30 days') AS "newUsers30d",
        (SELECT COUNT(*)::int FROM meetings) AS "totalMeetings",
        (SELECT COUNT(*)::int FROM meetings WHERE started_at >= now() - interval '7 days') AS "meetings7d",
        (SELECT COUNT(*)::int FROM meetings WHERE started_at >= now() - interval '30 days') AS "meetings30d"
    `);

    res.json(result.rows[0] ?? {});
  } catch (err) {
    next(err);
  }
});

const createInviteSchema = z.object({
  code: z.string().trim().min(8, 'コードは8文字以上にしてください').max(64).regex(/^[A-Z0-9_-]+$/i, '英数字 / ハイフン / アンダースコアのみ').optional(),
  maxUses: z.number().int().min(1).nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  note: z.string().max(500).nullable().optional(),
});

const updateInviteSchema = z.object({
  isActive: z.boolean().optional(),
  maxUses: z.number().int().min(1).nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  note: z.string().max(500).nullable().optional(),
});

function generateInviteCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(12);
  let s = '';
  for (let i = 0; i < 12; i++) s += alphabet[bytes[i] % alphabet.length];
  return s;
}

router.get('/invite-codes', async (_req, res, next) => {
  try {
    const rows = await db
      .select()
      .from(inviteCodes)
      .orderBy(desc(inviteCodes.createdAt));
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/invite-codes', async (req, res, next) => {
  try {
    const body = createInviteSchema.parse(req.body);
    const code = (body.code ?? generateInviteCode()).toUpperCase();
    const userId = authUserId(req);

    const [created] = await db
      .insert(inviteCodes)
      .values({
        code,
        maxUses: body.maxUses ?? null,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
        note: body.note ?? null,
        createdBy: userId,
      })
      .returning();

    await adminAudit(req, 'admin.invite_code_create', {
      target: { type: 'invite_code', id: created.code },
      detail: { after: { maxUses: created.maxUses, expiresAt: created.expiresAt } },
    });
    res.status(201).json(created);
  } catch (err: any) {
    if (err?.code === '23505') {
      res.status(409).json({ error: 'duplicate_code', message: 'このコードはすでに存在します' });
      return;
    }
    next(err);
  }
});

router.patch('/invite-codes/:code', async (req, res, next) => {
  try {
    const code = req.params.code.toUpperCase();
    const body = updateInviteSchema.parse(req.body);

    const updates: Record<string, unknown> = {};
    if (body.isActive !== undefined) updates.isActive = body.isActive;
    if (body.maxUses !== undefined) updates.maxUses = body.maxUses;
    if (body.expiresAt !== undefined) {
      updates.expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
    }
    if (body.note !== undefined) updates.note = body.note;

    const [beforeCode] = await db.select().from(inviteCodes).where(eq(inviteCodes.code, code)).limit(1);
    const [updated] = await db
      .update(inviteCodes)
      .set(updates)
      .where(eq(inviteCodes.code, code))
      .returning();

    if (!updated) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    await adminAudit(req, 'admin.invite_code_update', {
      target: { type: 'invite_code', id: code },
      detail: {
        before: beforeCode ? { isActive: beforeCode.isActive, maxUses: beforeCode.maxUses, expiresAt: beforeCode.expiresAt } : null,
        after: { isActive: updated.isActive, maxUses: updated.maxUses, expiresAt: updated.expiresAt },
      },
    });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

router.delete('/invite-codes/:code', async (req, res, next) => {
  try {
    const code = req.params.code.toUpperCase();
    const deleted = await db.delete(inviteCodes).where(eq(inviteCodes.code, code)).returning();
    if (deleted.length === 0) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    await adminAudit(req, 'admin.invite_code_delete', { target: { type: 'invite_code', id: code } });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get('/invite-codes/:code/redemptions', async (req, res, next) => {
  try {
    const code = req.params.code.toUpperCase();
    const rows = await db.execute(sql`
      SELECT r.user_id AS "userId", u.email, u.display_name AS "displayName", r.redeemed_at AS "redeemedAt"
      FROM invite_redemptions r
      JOIN users u ON u.id = r.user_id
      WHERE r.code = ${code}
      ORDER BY r.redeemed_at DESC
    `);
    await adminAudit(req, 'admin.invite_redemptions_view', { target: { type: 'invite_code', id: code }, detail: { count: rows.rows.length } });
    res.json(rows.rows);
  } catch (err) {
    next(err);
  }
});

const SEGMENT_VALUES = ['all', 'admin', 'invite_verified'] as const;

const createAnnouncementSchema = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().min(1).max(20000),
  important: z.boolean().optional(),
  targetSegment: z.enum(SEGMENT_VALUES).optional(),
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().nullable().optional(),
  isPublished: z.boolean().optional(),
});

const updateAnnouncementSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  body: z.string().min(1).max(20000).optional(),
  important: z.boolean().optional(),
  targetSegment: z.enum(SEGMENT_VALUES).optional(),
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().nullable().optional(),
  isPublished: z.boolean().optional(),
});

router.get('/announcements', async (_req, res, next) => {
  try {
    const rows = await db.select().from(announcements).orderBy(desc(announcements.createdAt));
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/announcements', async (req, res, next) => {
  try {
    const body = createAnnouncementSchema.parse(req.body);
    const [created] = await db
      .insert(announcements)
      .values({
        title: body.title,
        body: body.body,
        important: body.important ?? false,
        targetSegment: body.targetSegment ?? 'all',
        startsAt: body.startsAt ? new Date(body.startsAt) : new Date(),
        endsAt: body.endsAt ? new Date(body.endsAt) : null,
        isPublished: body.isPublished ?? true,
      })
      .returning();
    await adminAudit(req, 'admin.announcement_create', {
      target: { type: 'announcement', id: created.id },
      detail: { title: created.title, targetSegment: created.targetSegment, isPublished: created.isPublished },
    });
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

router.patch('/announcements/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid announcement ID' });
      return;
    }
    const body = updateAnnouncementSchema.parse(req.body);
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (body.title !== undefined) updates.title = body.title;
    if (body.body !== undefined) updates.body = body.body;
    if (body.important !== undefined) updates.important = body.important;
    if (body.targetSegment !== undefined) updates.targetSegment = body.targetSegment;
    if (body.startsAt !== undefined) updates.startsAt = new Date(body.startsAt);
    if (body.endsAt !== undefined) updates.endsAt = body.endsAt ? new Date(body.endsAt) : null;
    if (body.isPublished !== undefined) updates.isPublished = body.isPublished;

    const [updated] = await db
      .update(announcements)
      .set(updates)
      .where(eq(announcements.id, id))
      .returning();
    if (!updated) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    await adminAudit(req, 'admin.announcement_update', {
      target: { type: 'announcement', id },
      detail: { fields: Object.keys(updates).filter((k) => k !== 'updatedAt'), isPublished: updated.isPublished },
    });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

router.delete('/announcements/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid announcement ID' });
      return;
    }
    const deleted = await db.delete(announcements).where(eq(announcements.id, id)).returning();
    if (deleted.length === 0) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    await adminAudit(req, 'admin.announcement_delete', { target: { type: 'announcement', id }, detail: { title: deleted[0].title } });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get('/recordings', (_req, res) => {
  res.json(listActiveRecordings());
});

router.post('/meetings/:id/force-cleanup', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'invalid_id', message: 'meetingId が不正です' });
    return;
  }
  const result = forceCleanupMeeting(id);
  auditLater('admin.force_cleanup', {
    actor: { id: authUserId(req), email: getAuth(req)?.email ?? null, role: 'admin', authMethod: 'session' },
    target: { type: 'meeting', id },
  }, req);
  res.json({ meetingId: id, ...result });
});

export default router;
