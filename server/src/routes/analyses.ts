import { Router } from 'express';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { meetings, analyses } from '../db/schema.js';
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

    const rows = await db
      .select()
      .from(analyses)
      .where(eq(analyses.meetingId, meetingId))
      .orderBy(analyses.createdAt);

    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.delete('/item/:id', async (req, res, next) => {
  try {
    const analysisId = Number(req.params.id);

    const [analysis] = await db
      .select()
      .from(analyses)
      .where(eq(analyses.id, analysisId));

    if (!analysis) {
      res.status(404).json({ error: 'Analysis not found' });
      return;
    }

    const [meeting] = await db
      .select()
      .from(meetings)
      .where(and(eq(meetings.id, analysis.meetingId), eq(meetings.userId, authUserId(req))));

    if (!meeting) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    await db.delete(analyses).where(eq(analyses.id, analysisId));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
