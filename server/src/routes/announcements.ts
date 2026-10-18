import { Router } from 'express';
import { and, eq, or, isNull, gte, lte, desc, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { announcements, announcementReads, users } from '../db/schema.js';
import { requireAuth } from '../middleware/auth.js';
import { authUserId } from '../middleware/authContext.js';

const router = Router();
router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    const userId = authUserId(req);
    const [user] = await db
      .select({ role: users.role, inviteVerified: users.inviteVerified })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const segments: string[] = ['all'];
    if (user.role === 'admin') segments.push('admin');
    if (user.inviteVerified) segments.push('invite_verified');

    const now = new Date();
    const rows = await db
      .select({
        id: announcements.id,
        title: announcements.title,
        body: announcements.body,
        important: announcements.important,
        startsAt: announcements.startsAt,
        endsAt: announcements.endsAt,
        createdAt: announcements.createdAt,
        readAt: announcementReads.readAt,
      })
      .from(announcements)
      .leftJoin(
        announcementReads,
        and(
          eq(announcementReads.announcementId, announcements.id),
          eq(announcementReads.userId, userId)
        )
      )
      .where(
        and(
          eq(announcements.isPublished, true),
          inArray(announcements.targetSegment, segments),
          lte(announcements.startsAt, now),
          or(isNull(announcements.endsAt), gte(announcements.endsAt, now))
        )
      )
      .orderBy(desc(announcements.important), desc(announcements.createdAt));

    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/read', async (req, res, next) => {
  try {
    const userId = authUserId(req);
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid announcement ID' });
      return;
    }
    await db
      .insert(announcementReads)
      .values({ userId, announcementId: id })
      .onConflictDoNothing();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
