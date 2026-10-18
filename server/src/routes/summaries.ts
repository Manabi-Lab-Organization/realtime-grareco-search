import { Router } from 'express';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { meetings, structuredSummaries } from '../db/schema.js';
import { requireAuth } from '../middleware/auth.js';
import { authUserId } from '../middleware/authContext.js';

const router = Router();

router.use(requireAuth);

router.get('/:meetingId', async (req, res, next) => {
  try {
    const meetingId = Number(req.params.meetingId);
    const [meeting] = await db
      .select()
      .from(meetings)
      .where(and(eq(meetings.id, meetingId), eq(meetings.userId, authUserId(req))));

    if (!meeting) {
      res.status(404).json({ error: 'Meeting not found' });
      return;
    }

    const [summary] = await db
      .select()
      .from(structuredSummaries)
      .where(eq(structuredSummaries.meetingId, meetingId))
      .orderBy(desc(structuredSummaries.updatedAt))
      .limit(1);

    res.json(summary || null);
  } catch (err) {
    next(err);
  }
});

export default router;
