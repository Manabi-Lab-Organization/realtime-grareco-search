
import { Router } from 'express';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { meetings } from '../db/schema.js';
import { requireAuth } from '../middleware/auth.js';
import { meetingAssistantLimiter, imageAnalysisLimiter } from '../middleware/rateLimit.js';
import { imageJsonBody } from '../middleware/bodyLimits.js';
import { uploadImageData, uploadImageMimeType } from '../services/uploadImageTypes.js';
import {
  runAgentTurn,
  runAgentTurnStreaming,
  isAgentEnabled,
  type AgentStreamEvent,
} from '../services/agent/index.js';
import { attachAndAnalyzeImage } from '../services/agent/imageAttachService.js';
import { authUserId } from '../middleware/authContext.js';

const router = Router();

router.use(requireAuth);

router.use((req, res, next) => {
  if (!isAgentEnabled()) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  next();
});

const chatSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().min(1).max(4000),
      })
    )
    .min(1)
    .max(40),
});

router.post('/meetings/:id/chat', meetingAssistantLimiter, async (req, res, next) => {
  try {
    const meetingId = Number(req.params.id);
    const userId = authUserId(req);

    const [meeting] = await db
      .select({ id: meetings.id })
      .from(meetings)
      .where(and(eq(meetings.id, meetingId), eq(meetings.userId, userId)));
    if (!meeting) {
      res.status(404).json({ error: 'meeting_not_found' });
      return;
    }

    const { messages } = chatSchema.parse(req.body);

    const wantsStream = (req.get('Accept') || '').includes('text/event-stream');

    if (!wantsStream) {
      const result = await runAgentTurn({ userId, meetingId, messages });
      res.json(result);
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const sendEvent = (event: AgentStreamEvent) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    let aborted = false;
    req.on('close', () => {
      aborted = true;
    });

    try {
      await runAgentTurnStreaming({
        userId,
        meetingId,
        messages,
        onEvent: (ev) => {
          if (aborted) return;
          sendEvent(ev);
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[agent:stream] error:', err);
      if (!aborted) sendEvent({ type: 'error', error: msg });
    } finally {
      if (!aborted) res.end();
    }
  } catch (err) {
    next(err);
  }
});

const attachImageSchema = z.object({
  data: uploadImageData,
  mimeType: uploadImageMimeType,
  fileName: z.string().optional(),
  originalData: uploadImageData.optional(),
  originalMimeType: uploadImageMimeType.optional(),
});

router.post('/meetings/:id/attach-image', imageAnalysisLimiter, imageJsonBody, async (req, res, next) => {
  try {
    const meetingId = Number(req.params.id);
    const userId = authUserId(req);
    const body = attachImageSchema.parse(req.body);

    const result = await attachAndAnalyzeImage({
      meetingId,
      userId,
      ...body,
    });

    res.status(201).json(result);
  } catch (err) {
    if (err instanceof Error && err.message === 'meeting_not_found') {
      res.status(404).json({ error: 'meeting_not_found' });
      return;
    }
    next(err);
  }
});

router.get('/availability', (_req, res) => {
  res.json({ enabled: true });
});

export default router;
