import type { Request, Response, NextFunction } from 'express';
import { isTokenActive } from '../services/apiTokenService.js';
import { hasLiveMeeting } from '../services/liveMeetingGrace.js';
import { webSessionAbsoluteMs, sessionRefreshIntervalMs } from '../config/sessionLifetime.js';

type SessionLike = {
  userId?: number;
  apiTokenId?: number;
  issuedAt?: number;
  touchedAt?: number;
};

export function sessionInvalidReason(
  s: SessionLike,
  now: number,
  opts: { absoluteMs: number; tokenActive: boolean | null; hasLiveMeeting?: boolean },
): 'absolute_expired' | 'token_revoked' | null {
  if (s.apiTokenId != null && opts.tokenActive === false) return 'token_revoked';
  if (opts.absoluteMs > 0 && s.issuedAt && now - s.issuedAt > opts.absoluteMs && !opts.hasLiveMeeting) return 'absolute_expired';
  return null;
}

function isPastAbsolute(s: SessionLike, now: number, absoluteMs: number): boolean {
  return absoluteMs > 0 && !!s.issuedAt && now - s.issuedAt > absoluteMs;
}

export async function checkSessionPolicy(req: Request): Promise<void> {
  const s = req.session as (typeof req.session & SessionLike) | undefined;
  if (!s?.userId) return;
  const now = Date.now();
  if (!s.issuedAt) s.issuedAt = now;
  const tokenActive = s.apiTokenId != null ? await isTokenActive(s.apiTokenId) : null;
  const absoluteMs = webSessionAbsoluteMs();
  const live = isPastAbsolute(s, now, absoluteMs) ? await hasLiveMeeting(s.userId, now) : false;
  const reason = sessionInvalidReason(s, now, { absoluteMs, tokenActive, hasLiveMeeting: live });
  if (reason) {
    await new Promise<void>((resolve) => req.session.regenerate(() => resolve()));
    return;
  }
  if (!s.touchedAt || now - s.touchedAt >= sessionRefreshIntervalMs()) {
    s.touchedAt = now;
  }
}

export function treatSessionAsSignedOut(req: Request): void {
  const s = req.session as (typeof req.session & SessionLike & Record<string, unknown>) | undefined;
  if (!s?.userId) return;
  for (const key of ['userId', 'email', 'displayName', 'apiTokenId', 'issuedAt', 'touchedAt', 'sudoAt', 'adminSeenAt']) {
    delete s[key];
  }
  s.save = ((cb?: (err?: unknown) => void) => {
    cb?.();
    return s;
  }) as typeof s.save;
}

export async function applySessionPolicy(req: Request): Promise<void> {
  try {
    await checkSessionPolicy(req);
  } catch (err) {
    console.error('[sessionPolicy] check failed (treated as signed out):', err instanceof Error ? err.message : String(err));
    treatSessionAsSignedOut(req);
  }
}

export async function sessionPolicyMiddleware(req: Request, _res: Response, next: NextFunction): Promise<void> {
  await applySessionPolicy(req);
  next();
}
