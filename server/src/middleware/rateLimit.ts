import rateLimit, { ipKeyGenerator, type RateLimitRequestHandler, type Options } from 'express-rate-limit';
import type { Request, Response, NextFunction } from 'express';
import { auditLater } from '../services/audit/audit.js';
import { getClientIp } from '../services/audit/logSafety.js';
import { getAuth } from './authContext.js';

const isProd = process.env.NODE_ENV === 'production';

const HIT_DEDUPE_MS = 60_000;
const recentHits = new Map<string, { at: number; suppressed: number }>();

export function rateLimitHitHandler(limiter: string) {
  return (req: Request, res: Response, _next: NextFunction, options: Options): void => {
    const ip = getClientIp(req);
    const key = `${limiter}|${ip ?? '?'}`;
    const now = Date.now();
    const prev = recentHits.get(key);
    if (prev && now - prev.at < HIT_DEDUPE_MS) {
      prev.suppressed += 1;
    } else {
      if (recentHits.size > 10_000) recentHits.clear();
      recentHits.set(key, { at: now, suppressed: 0 });
      auditLater('rate_limit.hit', {
        result: 'denied',
        detail: {
          limiter,
          method: req.method,
          path: req.baseUrl + req.path,
          suppressedSinceLast: prev?.suppressed ?? 0,
        },
      }, req);
    }
    res.status(options.statusCode).send(options.message);
  };
}

export const authLimiter: RateLimitRequestHandler = rateLimit({
  handler: rateLimitHitHandler('auth'),
  windowMs: 15 * 60 * 1000,
  max: isProd ? 5 : 50,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    error: 'リクエストが多すぎます。しばらくしてから再度お試しください。',
  },
});

export const loginAccountLimiter: RateLimitRequestHandler = rateLimit({
  handler: rateLimitHitHandler('login_account'),
  windowMs: 15 * 60 * 1000,
  max: isProd ? 10 : 100,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    return email ? `account:${email}` : `ip:${ipKeyGenerator(req.ip ?? '')}`;
  },
  message: {
    error: 'このアカウントへのログインの失敗が続いたため、しばらく受け付けません。時間をおいてお試しください。',
  },
});

export const registerLimiter: RateLimitRequestHandler = rateLimit({
  handler: rateLimitHitHandler('register'),
  windowMs: 60 * 60 * 1000,
  max: isProd ? 10 : 100,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    error: '登録の試行が多すぎます。しばらくしてから再度お試しください。',
  },
});

export const inviteLimiter: RateLimitRequestHandler = rateLimit({
  handler: rateLimitHitHandler('invite'),
  windowMs: 15 * 60 * 1000,
  max: isProd ? 10 : 50,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    error: 'リクエストが多すぎます。しばらくしてから再度お試しください。',
  },
});

export type RateLimitKeyRequest = {
  ip?: string;
  session?: { userId?: number };
};

export function aiRateLimitKey(req: RateLimitKeyRequest): string {
  const userId = getAuth(req as Request)?.userId;
  if (userId) return `u:${userId}`;
  return req.ip ? `ip:${ipKeyGenerator(req.ip)}` : 'ip:unknown';
}

function aiFeatureLimiter(windowMinutes: number, maxInProd: number): RateLimitRequestHandler {
  return rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    max: isProd ? maxInProd : maxInProd * 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => aiRateLimitKey(req as RateLimitKeyRequest),
    message: {
      error: `AI処理の依頼が短時間に集中しています。${windowMinutes}分ほど待ってから再度お試しください。`,
    },
  });
}

export const summaryRebuildLimiter = aiFeatureLimiter(60, 6);

export const titleBatchLimiter = aiFeatureLimiter(60, 3);

export const imageAnalysisLimiter = aiFeatureLimiter(10, 30);

export const roomObservationLimiter = aiFeatureLimiter(10, 30);

export const participantReprofileLimiter = aiFeatureLimiter(10, 20);

export const meetingAnalysisLimiter = aiFeatureLimiter(10, 20);

export const meetingAssistantLimiter = aiFeatureLimiter(10, 60);

export const grarecoSearchLimiter = aiFeatureLimiter(10, 60);

export const passwordResetLimiter: RateLimitRequestHandler = rateLimit({
  handler: rateLimitHitHandler('passwordReset'),
  windowMs: 15 * 60 * 1000,
  max: isProd ? 3 : 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    error: 'リクエストが多すぎます。しばらくしてから再度お試しください。',
  },
});
