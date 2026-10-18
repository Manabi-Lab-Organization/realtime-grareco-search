import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  resolveShareToken,
  getPublicResearchCards,
  getPublicGrarecos,
  getPublicGrarecoImage,
  getPublicGrarecoImageHash,
  getPublicSummary,
  getPublicTerms,
  getSharedContents,
  getExcludedItems,
} from '../services/shareService.js';
import { sendGrarecoImage, sendGrarecoThumbnail } from '../services/grareco/grarecoImageResponse.js';
import { auditLater } from '../services/audit/audit.js';
import { getClientIp, clipUserAgent } from '../services/audit/logSafety.js';

type ResolvedShare = NonNullable<Awaited<ReturnType<typeof resolveShareToken>>>;

const ACCESS_DEDUPE_MS = 10 * 60 * 1000;
const recentAccess = new Map<string, number>();

function auditShareAccess(req: Request, resolved: ResolvedShare | null, outcome: 'ok' | 'not_found' | 'ended' | 'rate_limited'): void {
  const ip = getClientIp(req);
  const ua = clipUserAgent(req.headers['user-agent']);
  const key = `${resolved?.share.id ?? 'none'}|${ip}|${ua}|${outcome}`;
  const now = Date.now();
  const last = recentAccess.get(key);
  if (last && now - last < ACCESS_DEDUPE_MS) return;
  if (recentAccess.size > 20_000) recentAccess.clear();
  recentAccess.set(key, now);
  auditLater(outcome === 'rate_limited' ? 'rate_limit.hit' : 'share_link.access', {
    result: outcome === 'ok' ? 'success' : 'denied',
    actor: { authMethod: 'share_link' },
    target: resolved ? { type: 'meeting', id: resolved.meeting.id } : { type: 'share_link' },
    detail: {
      outcome,
      shareId: resolved?.share.id ?? null,
      ownerId: resolved?.meeting.userId ?? null,
      ...(outcome === 'rate_limited' ? { limiter: 'share' } : {}),
    },
  }, req);
}

const router = Router();

const RATE_LIMIT = 180;
const RATE_WINDOW_MS = 60 * 1000;
const MAX_BUCKETS = 50_000;
const buckets = new Map<string, { count: number; resetAt: number }>();

const bucketSweep = setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of buckets) {
    if (now > b.resetAt) buckets.delete(ip);
  }
}, 5 * 60 * 1000);
bucketSweep.unref?.();

function rateLimited(req: Request): boolean {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const b = buckets.get(ip);
  if (!b || now > b.resetAt) {
    if (buckets.size >= MAX_BUCKETS) {
      for (const [k, v] of buckets) {
        if (now > v.resetAt) buckets.delete(k);
      }
    }
    buckets.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  b.count += 1;
  return b.count > RATE_LIMIT;
}

router.use((_req, res, next) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  next();
});

router.use((req, res, next) => {
  if (rateLimited(req)) {
    auditShareAccess(req, null, 'rate_limited');
    res.status(429).json({ error: 'rate_limited' });
    return;
  }
  next();
});

async function resolveLiveOrFail(req: Request, res: Response): Promise<ResolvedShare | null> {
  const token = String(req.params.token || '');
  const resolved = await resolveShareToken(token);
  if (!resolved) {
    auditShareAccess(req, null, 'not_found');
    res.status(404).json({ error: 'not_found' });
    return null;
  }
  if (!resolved.live) {
    auditShareAccess(req, resolved, 'ended');
    res.status(410).json({ error: 'share_ended' });
    return null;
  }
  auditShareAccess(req, resolved, 'ok');
  return resolved;
}

function ensureShared(resolved: ResolvedShare, key: string, res: Response): boolean {
  if (!getSharedContents(resolved.share).includes(key)) {
    res.status(403).json({ error: 'content_not_shared' });
    return false;
  }
  return true;
}

router.get('/:token/meta', async (req, res, next) => {
  try {
    const resolved = await resolveShareToken(String(req.params.token || ''));
    if (!resolved) {
      auditShareAccess(req, null, 'not_found');
      res.status(404).json({ error: 'not_found' });
      return;
    }
    auditShareAccess(req, resolved, resolved.live ? 'ok' : 'ended');
    if (!resolved.live) {
      res.json({ live: false });
      return;
    }
    const contents = (resolved.share.sharedContents as string[] | null) ?? [
      'glossary',
      'research',
      'grareco',
      'summary',
    ];
    res.json({
      title: resolved.meeting.title,
      status: resolved.meeting.status,
      live: true,
      contents,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/:token/term-glossary', async (req, res, next) => {
  try {
    const r = await resolveLiveOrFail(req, res);
    if (!r) return;
    if (!ensureShared(r, 'glossary', res)) return;
    const ex = getExcludedItems(r.share);
    res.json(await getPublicTerms(r.meeting.id, ex.glossary ?? []));
  } catch (err) {
    next(err);
  }
});

router.get('/:token/research-insights', async (req, res, next) => {
  try {
    const r = await resolveLiveOrFail(req, res);
    if (!r) return;
    if (!ensureShared(r, 'research', res)) return;
    const ex = getExcludedItems(r.share);
    res.json(await getPublicResearchCards(r.meeting.id, ex.research ?? []));
  } catch (err) {
    next(err);
  }
});

router.get('/:token/graphic-recordings', async (req, res, next) => {
  try {
    const r = await resolveLiveOrFail(req, res);
    if (!r) return;
    if (!ensureShared(r, 'grareco', res)) return;
    const ex = getExcludedItems(r.share);
    res.json(await getPublicGrarecos(r.meeting.id, ex.grareco ?? [], req.params.token));
  } catch (err) {
    next(err);
  }
});

router.get('/:token/grareco/:recordingId/image', async (req, res, next) => {
  try {
    const r = await resolveLiveOrFail(req, res);
    if (!r) return;
    if (!ensureShared(r, 'grareco', res)) return;
    const ex = getExcludedItems(r.share);
    const recordingId = Number(req.params.recordingId);
    if (!Number.isInteger(recordingId) || recordingId <= 0) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    if (req.query.size === 'thumb') {
      const hash = await getPublicGrarecoImageHash(r.meeting.id, recordingId, ex.grareco ?? []);
      await sendGrarecoThumbnail(req, res, hash, () => getPublicGrarecoImage(r.meeting.id, recordingId, ex.grareco ?? []));
      return;
    }
    const imageUrl = await getPublicGrarecoImage(r.meeting.id, recordingId, ex.grareco ?? []);
    sendGrarecoImage(req, res, imageUrl);
  } catch (err) {
    next(err);
  }
});

router.get('/:token/structured-summary', async (req, res, next) => {
  try {
    const r = await resolveLiveOrFail(req, res);
    if (!r) return;
    if (!ensureShared(r, 'summary', res)) return;
    const ex = getExcludedItems(r.share);
    res.json(await getPublicSummary(r.meeting.id, ex.summary ?? []));
  } catch (err) {
    next(err);
  }
});

export default router;
