import type { Request, Response, NextFunction } from 'express';
import { auditLater } from './audit.js';
import { getClientIp } from './logSafety.js';
import { getAuth } from '../../middleware/authContext.js';

export const DATA_ACCESS_DEDUPE_MS = 30 * 60 * 1000;
const DEDUPE_MAX_KEYS = 20_000;

export interface DataAccessEvent {
  event: 'meeting.view' | 'meeting.list' | 'meeting.search' | 'meeting.update';
  meetingId: number | null;
  kind: string;
  via: 'web' | 'ext';
  method?: string;
}

const VIEW_EXCLUDED_KINDS = new Set(['partial-transcript', 'share']);

function isUpdateAlreadyAudited(method: string, kind: string): boolean {
  if (kind.split('/')[0] === 'share') return true;
  if (kind === 'detail' && method === 'DELETE') return true;
  return false;
}

const MEETING_PATH = /^\/api\/meetings\/(\d+)(\/[^?]*)?$/;
const EXT_MEETING_PATH = /^\/api\/ext\/meetings\/(\d+)(\/[^?]*)?$/;

export function kindFromRest(rest: string | undefined): string {
  const k = (rest ?? '').replace(/\/+$/, '').replace(/^\//, '').replace(/(^|\/)\d+(?=\/|$)/g, '$1:id');
  return k === '' ? 'detail' : k;
}
const BY_MEETING_PATH = /^\/api\/(analyses|summaries)\/(\d+)\/?$/;
const AGENT_PATH = /^\/api\/agent\/meetings\/(\d+)\/([a-z-]+)/;

export function classifyDataAccess(method: string, path: string): DataAccessEvent | null {
  const m = method.toUpperCase();
  const isRead = m === 'GET' || m === 'HEAD';

  if (isRead) {
    if (path === '/api/meetings' || path === '/api/meetings/') return { event: 'meeting.list', meetingId: null, kind: 'list', via: 'web' };
    if (path === '/api/ext/meetings' || path === '/api/ext/meetings/') return { event: 'meeting.list', meetingId: null, kind: 'list', via: 'ext' };
    if (path === '/api/grareco/search') return { event: 'meeting.search', meetingId: null, kind: 'grareco-search', via: 'web' };
  }

  let match = MEETING_PATH.exec(path);
  let via: 'web' | 'ext' = 'web';
  if (!match) {
    match = EXT_MEETING_PATH.exec(path);
    via = 'ext';
  }
  if (match) {
    const meetingId = Number(match[1]);
    const kind = kindFromRest(match[2]);
    if (isRead) {
      if (VIEW_EXCLUDED_KINDS.has(kind.split('/')[0])) return null;
      return { event: 'meeting.view', meetingId, kind, via };
    }
    if (isUpdateAlreadyAudited(m, kind)) return null;
    return { event: 'meeting.update', meetingId, kind, via, method: m };
  }

  const by = BY_MEETING_PATH.exec(path);
  if (by && isRead) return { event: 'meeting.view', meetingId: Number(by[2]), kind: by[1], via: 'web' };

  const agent = AGENT_PATH.exec(path);
  if (agent && m === 'POST') return { event: 'meeting.view', meetingId: Number(agent[1]), kind: `assistant-${agent[2]}`, via: 'web' };

  if (!isRead) {
    if (path === '/api/meetings' || path === '/api/meetings/') return { event: 'meeting.update', meetingId: null, kind: 'create', via: 'web', method: m };
    if (/^\/api\/analyses\/item\/\d+\/?$/.test(path)) return { event: 'meeting.update', meetingId: null, kind: 'analysis-item', via: 'web', method: m };
  }
  return null;
}

const recent = new Map<string, number>();

export function shouldRecord(key: string, now: number = Date.now()): boolean {
  const last = recent.get(key);
  if (last !== undefined && now - last < DATA_ACCESS_DEDUPE_MS) return false;
  if (recent.size >= DEDUPE_MAX_KEYS) recent.clear();
  recent.set(key, now);
  return true;
}

export function __resetDataAccessDedupeForTest(): void {
  recent.clear();
}

export function dataAccessAuditMiddleware(req: Request, res: Response, next: NextFunction): void {
  const path = (req.originalUrl || req.url || '').split('?')[0];
  if (!path.startsWith('/api/')) {
    next();
    return;
  }
  const classified = classifyDataAccess(req.method, path);
  if (!classified) {
    next();
    return;
  }
  res.on('finish', () => {
    try {
      const ok = (res.statusCode >= 200 && res.statusCode < 300) || res.statusCode === 304;
      if (!ok) return;
      const auth = getAuth(req);
      if (!auth) return;
      const key = [
        classified.event, auth.userId, auth.method, auth.tokenId ?? '', getClientIp(req) ?? '',
        classified.meetingId ?? '', classified.kind, classified.method ?? '',
      ].join('|');
      if (!shouldRecord(key)) return;
      const rawId = classified.kind === 'analysis-item' ? path.split('/').filter(Boolean).pop() : null;
      auditLater(classified.event, {
        target: classified.meetingId != null
          ? { type: 'meeting', id: classified.meetingId }
          : rawId ? { type: 'analysis', id: rawId } : undefined,
        detail: {
          kind: classified.kind,
          via: classified.via,
          ...(classified.method ? { method: classified.method } : {}),
        },
      }, req);
    } catch {
    }
  });
  next();
}
