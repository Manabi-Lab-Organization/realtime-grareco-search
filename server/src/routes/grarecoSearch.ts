
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { searchGrarecoSemantics } from '../services/grareco/grarecoSearchService.js';
import { grarecoSearchLimiter } from '../middleware/rateLimit.js';
import { authUserId } from '../middleware/authContext.js';

const router = Router();

router.use(requireAuth);

router.get('/search', grarecoSearchLimiter, async (req, res, next) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!q) {
      res.status(400).json({ error: '検索語（q）を指定してください' });
      return;
    }
    if (q.length > 200) {
      res.status(400).json({ error: '検索語は200文字以内で指定してください' });
      return;
    }
    const meetingIdRaw = Number(req.query.meeting_id);
    if (!Number.isInteger(meetingIdRaw) || meetingIdRaw <= 0) {
      res.status(400).json({ error: 'meeting_id を指定してください' });
      return;
    }
    const limit = Number(req.query.limit) || undefined;
    const results = await searchGrarecoSemantics(authUserId(req), meetingIdRaw, q, limit ?? 8);
    res.json({ query: q, results });
  } catch (err) {
    next(err);
  }
});

export default router;
