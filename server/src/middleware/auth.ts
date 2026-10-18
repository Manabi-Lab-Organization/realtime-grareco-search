import { Request, Response, NextFunction } from 'express';
import { authenticateRequestToken } from './tokenAuth.js';
import { getAuth, type AuthContext } from './authContext.js';

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (getAuth(req)?.userId) {
    const auth: AuthContext = getAuth(req)!;
    res.locals.auth = auth;
    next();
    return;
  }

  try {
    const r = await authenticateRequestToken(req, res);
    if (r === 'ok') {
      next();
      return;
    }
    if (r === 'responded') return;
  } catch (err) {
    console.error('[auth] token auth failed:', err instanceof Error ? err.message : String(err));
  }

  res.status(401).json({ error: 'Unauthorized' });
}
