import type { Request, Response, NextFunction } from 'express';
import { getAuth } from './authContext.js';
import { getTokenSudoAt, markTokenSudo } from '../services/apiTokenService.js';
import { sudoWindowMs } from '../config/sessionLifetime.js';

export const REAUTH_REQUIRED_MESSAGE = '続行するには、もう一度パスワード（または Google）で本人確認してください';

export function isWithinSudoWindow(sudoAt: number | null | undefined, now: number = Date.now(), windowMs: number = sudoWindowMs()): boolean {
  return typeof sudoAt === 'number' && sudoAt > 0 && now - sudoAt <= windowMs;
}

export async function hasRecentAuth(req: Request): Promise<boolean> {
  const auth = getAuth(req);
  if (!auth) return false;
  if (auth.method === 'session') return isWithinSudoWindow(req.session?.sudoAt);
  if (auth.tokenId == null) return false;
  const at = await getTokenSudoAt(auth.tokenId);
  return isWithinSudoWindow(at?.getTime());
}

export async function markRecentAuth(req: Request): Promise<void> {
  const auth = getAuth(req);
  if (!auth) return;
  if (auth.method === 'session') {
    req.session.sudoAt = Date.now();
    req.session.adminSeenAt = Date.now();
    return;
  }
  if (auth.tokenId != null) await markTokenSudo(auth.tokenId);
}

export function sendReauthRequired(res: Response): void {
  res.status(403).json({ error: 'reauth_required', code: 'reauth_required', message: REAUTH_REQUIRED_MESSAGE });
}

export async function requireRecentAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (await hasRecentAuth(req)) {
      next();
      return;
    }
    sendReauthRequired(res);
  } catch (err) {
    next(err);
  }
}
