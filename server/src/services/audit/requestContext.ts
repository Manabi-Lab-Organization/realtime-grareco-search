import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

export interface AuditContext {
  requestId?: string;
  actorId?: number | string | null;
  channel?: 'http' | 'socketio' | 'native_ws' | 'job';
  reqRef?: WeakRef<Request>;
}

const storage = new AsyncLocalStorage<AuditContext>();

export function getAuditContext(): AuditContext | undefined {
  return storage.getStore();
}

export function runWithAuditContext<T>(ctx: AuditContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function bindAuditContext<A extends unknown[], R>(
  ctx: AuditContext,
  fn: (...args: A) => R,
): (...args: A) => R {
  return (...args: A) => storage.run(ctx, () => fn(...args));
}

export function currentRequest(): Request | undefined {
  return storage.getStore()?.reqRef?.deref();
}


declare module 'express-serve-static-core' {
  interface Request {
    requestId?: string;
  }
}

export function requestContextMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestId = crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  storage.run({ requestId, channel: 'http', reqRef: new WeakRef(req) }, () => next());
}
