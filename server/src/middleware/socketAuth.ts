import type { Socket } from 'socket.io';
import type { Request, Response, NextFunction } from 'express';
import { sessionMiddleware } from '../config/session.js';
import { applySessionPolicy } from './sessionPolicy.js';
import { authenticateToken } from './tokenAuth.js';
import {
  auditLegacyQueryToken,
  isLegacyQueryTokenAllowed,
  readClientInfo,
  requiredMinVersion,
  UPDATE_REQUIRED_MESSAGE,
} from './clientVersion.js';

function updateRequiredError(minVersion?: string | null): Error {
  const err = new Error('update_required') as Error & { data?: unknown };
  err.data = { code: 'update_required', message: UPDATE_REQUIRED_MESSAGE, ...(minVersion ? { minVersion } : {}) };
  return err;
}

export function applySocketAuth(io: {
  engine: { use: (fn: (req: Request, res: Response, next: NextFunction) => void) => void };
  use: (fn: (socket: Socket, next: (err?: Error) => void) => void) => void;
}): void {
  io.engine.use(sessionMiddleware as unknown as (req: Request, res: Response, next: NextFunction) => void);
  io.engine.use((req: Request, _res: Response, next: NextFunction) => {
    applySessionPolicy(req).then(() => next(), () => next());
  });

  io.use((socket, next) => {
    void (async () => {
      const req = socket.request as Request & {
        session?: { userId?: number; email?: string; displayName?: string | null };
      };
      const hs = socket.handshake;
      const authPayload = (hs.auth ?? {}) as { token?: unknown; clientVersion?: unknown; clientPlatform?: unknown };
      const info = readClientInfo(hs.headers, { version: authPayload.clientVersion, platform: authPayload.clientPlatform });

      const sessionUserId = req.session?.userId;
      if (sessionUserId) {
        socket.data.userId = sessionUserId;
        socket.data.email = req.session?.email;
        socket.data.displayName = req.session?.displayName ?? null;
        return next();
      }

      let token = typeof authPayload.token === 'string' && authPayload.token ? authPayload.token : null;
      const legacy = typeof hs.query?.token === 'string' && hs.query.token ? (hs.query.token as string) : null;
      if (!token && legacy) {
        const accepted = isLegacyQueryTokenAllowed();
        auditLegacyQueryToken(legacy, { headers: hs.headers, channel: 'socket_io', accepted });
        if (!accepted) return next(updateRequiredError());
        token = legacy;
      }
      if (!token) return next(new Error('Unauthorized'));

      const min = requiredMinVersion(info, true);
      if (min) return next(updateRequiredError(min));

      const user = await authenticateToken(token);
      if (!user) return next(new Error('Unauthorized'));
      socket.data.userId = user.userId;
      socket.data.email = user.email;
      socket.data.displayName = user.displayName;
      socket.data.tokenId = user.tokenId;
      next();
    })().catch(() => next(new Error('Unauthorized')));
  });
}

declare module 'socket.io' {
  interface SocketData {
    userId: number;
    email?: string;
    displayName?: string | null;
    tokenId?: number;
  }
}
