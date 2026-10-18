import { Request, Response, NextFunction } from 'express';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { getAuth } from './authContext.js';
import { sendReauthRequired, isWithinSudoWindow } from './recentAuth.js';
import { adminIdleMs } from '../config/sessionLifetime.js';

export async function requireAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const auth = getAuth(req);
    if (!auth) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (auth.method !== 'session') {
      res.status(403).json({ error: 'admin_requires_session', message: '管理機能はブラウザでログインして利用してください' });
      return;
    }

    const [user] = await db
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, auth.userId))
      .limit(1);

    if (user?.role !== 'admin') {
      res.status(403).json({ error: 'Forbidden: admin role required' });
      return;
    }

    const now = Date.now();
    const lastSeen = Math.max(req.session.adminSeenAt ?? 0, req.session.sudoAt ?? 0);
    if (!isWithinSudoWindow(lastSeen, now, adminIdleMs())) {
      sendReauthRequired(res);
      return;
    }
    req.session.adminSeenAt = now;

    next();
  } catch (err) {
    next(err);
  }
}
