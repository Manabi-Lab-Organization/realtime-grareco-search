import type { Request } from 'express';

export type AuthMethod = 'session' | 'token';

export interface AuthContext {
  userId: number;
  email: string | null;
  displayName: string | null;
  method: AuthMethod;
  tokenId?: number | null;
  tokenCreatedAt?: Date;
  tokenLastUsedAt?: Date;
}

declare module 'express-session' {
  interface SessionData {
    userId: number;
    email: string;
    displayName: string | null;
    apiTokenId?: number;
    issuedAt?: number;
    touchedAt?: number;
    sudoAt?: number;
    adminSeenAt?: number;
  }
}

type WithLocals = Request & { res?: { locals?: Record<string, unknown> } };

export function getAuth(req: Request): AuthContext | undefined {
  const fromLocals = (req as WithLocals).res?.locals?.auth as AuthContext | undefined;
  if (fromLocals) return fromLocals;
  const s = req.session;
  if (s?.userId) {
    return {
      userId: s.userId,
      email: s.email ?? null,
      displayName: s.displayName ?? null,
      method: 'session',
      tokenId: s.apiTokenId ?? null,
    };
  }
  return undefined;
}

export function authUserId(req: Request): number {
  const a = getAuth(req);
  if (!a) throw Object.assign(new Error('authUserId() called on unauthenticated request'), { statusCode: 401 });
  return a.userId;
}

export function extractBearer(req: { headers: Request['headers'] }): string | null {
  const h = req.headers.authorization;
  if (typeof h === 'string' && h.startsWith('Bearer ')) {
    const t = h.slice(7).trim();
    return t || null;
  }
  return null;
}
