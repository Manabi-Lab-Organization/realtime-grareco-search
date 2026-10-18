import { Request, Response, NextFunction } from 'express';
import { findActiveToken, sha256 } from '../services/apiTokenService.js';
import { extractBearer, type AuthContext } from './authContext.js';
import {
  auditLegacyQueryToken,
  isLegacyQueryTokenAllowed,
  sendUpdateRequired,
} from './clientVersion.js';

export { sha256 };

export async function authenticateRequestToken(
  req: Request,
  res: Response,
): Promise<'ok' | 'none' | 'responded'> {
  let token = extractBearer(req);

  if (!token && typeof req.query.token === 'string' && req.query.token) {
    const legacy = req.query.token;
    const accepted = isLegacyQueryTokenAllowed();
    auditLegacyQueryToken(legacy, { headers: req.headers, channel: 'http', accepted, path: req.path }, req);
    if (!accepted) {
      sendUpdateRequired(res);
      return 'responded';
    }
    token = legacy;
  }

  if (!token) return 'none';

  const found = await findActiveToken(token);
  if (!found) {
    res.status(401).json({ error: 'token_invalid', code: 'token_invalid' });
    return 'responded';
  }
  const auth: AuthContext = {
    userId: found.userId,
    email: found.email,
    displayName: found.displayName,
    method: 'token',
    tokenId: found.tokenId,
    tokenCreatedAt: found.createdAt,
    tokenLastUsedAt: found.lastUsedAt,
  };
  res.locals.auth = auth;
  return 'ok';
}

export async function requireTokenAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const r = await authenticateRequestToken(req, res);
    if (r === 'ok') {
      next();
      return;
    }
    if (r === 'none') res.status(401).json({ error: 'token_invalid', code: 'token_invalid', message: 'API token required' });
  } catch (err) {
    next(err);
  }
}

export async function authenticateToken(
  token: string,
): Promise<{ userId: number; email: string; displayName: string | null; tokenId: number } | null> {
  if (!token) return null;
  const found = await findActiveToken(token);
  if (!found) return null;
  return { userId: found.userId, email: found.email, displayName: found.displayName, tokenId: found.tokenId };
}
