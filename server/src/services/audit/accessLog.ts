import type { Request, Response, NextFunction } from 'express';
import { getClientIp, clipUserAgent, redactPath } from './logSafety.js';

const SKIP = /^\/(assets\/|favicon|robots\.txt|manifest|.*\.(js|css|map|png|jpg|jpeg|svg|ico|webp|woff2?)$)/;

export interface AccessLogLine {
  type: 'access';
  ts: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  userId: number | null;
  ip: string | null;
  ua: string | null;
  requestId: string | null;
}

export function buildAccessLogLine(req: Request, res: Response, startedAt: bigint, now: bigint = process.hrtime.bigint()): AccessLogLine {
  const rawPath = (req.originalUrl || req.url || '').split('?')[0];
  return {
    type: 'access',
    ts: new Date().toISOString(),
    method: req.method,
    path: redactPath(rawPath),
    status: res.statusCode,
    durationMs: Math.round(Number(now - startedAt) / 1e5) / 10,
    userId: (res.locals?.auth as { userId?: number } | undefined)?.userId ?? (req as Request & { session?: { userId?: number } }).session?.userId ?? null,
    ip: getClientIp(req),
    ua: clipUserAgent(req.headers['user-agent']),
    requestId: req.requestId ?? null,
  };
}

export function accessLogMiddleware(req: Request, res: Response, next: NextFunction): void {
  const pathOnly = (req.originalUrl || req.url || '').split('?')[0];
  if (SKIP.test(pathOnly)) {
    next();
    return;
  }
  const startedAt = process.hrtime.bigint();
  let done = false;
  const write = () => {
    if (done) return;
    done = true;
    try {
      console.log(JSON.stringify(buildAccessLogLine(req, res, startedAt)));
    } catch {
    }
  };
  res.on('finish', write);
  res.on('close', write);
  next();
}
