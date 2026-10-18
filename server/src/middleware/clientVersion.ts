import type { Request, Response, NextFunction } from 'express';
import type { IncomingHttpHeaders } from 'http';
import { sha256 } from '../services/apiTokenService.js';
import { auditLater } from '../services/audit/audit.js';

export const UPDATE_REQUIRED_MESSAGE = '新しいバージョンに更新してください';
export const WS_UPDATE_REQUIRED_CODE = 4426;
export const WS_UPDATE_REQUIRED_REASON = 'update_required';

export type ClientPlatform = 'desktop' | 'mobile';

export interface ClientInfo {
  platform: ClientPlatform | null;
  version: string | null;
}

export function parseVersion(v: string | null | undefined): [number, number, number] | null {
  if (!v) return null;
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(v).trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a) ?? [0, 0, 0];
  const pb = parseVersion(b) ?? [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

function headerValue(h: string | string[] | undefined): string | null {
  if (Array.isArray(h)) return h[0] ?? null;
  return typeof h === 'string' && h.trim() ? h.trim() : null;
}

export function readClientInfo(
  headers: IncomingHttpHeaders,
  extra?: { version?: unknown; platform?: unknown },
): ClientInfo {
  const version = headerValue(headers['x-client-version']) ?? (typeof extra?.version === 'string' ? extra.version : null);
  const rawPlatform = (headerValue(headers['x-client-platform']) ?? (typeof extra?.platform === 'string' ? extra.platform : ''))
    .toLowerCase();
  let platform: ClientPlatform | null = rawPlatform === 'desktop' || rawPlatform === 'mobile' ? rawPlatform : null;
  if (!platform && /Electron\//.test(headerValue(headers['user-agent']) ?? '')) platform = 'desktop';
  return { platform, version: version ? version.slice(0, 40) : null };
}

function minVersionFor(platform: ClientPlatform): string | null {
  const v = platform === 'desktop' ? process.env.MIN_DESKTOP_VERSION : process.env.MIN_MOBILE_VERSION;
  return v && v.trim() ? v.trim() : null;
}

export function requiredMinVersion(info: ClientInfo, isAppRequest: boolean): string | null {
  if (!info.platform && !info.version && !isAppRequest) return null;
  const version = info.version ?? '0.0.0';
  const candidates = info.platform
    ? [minVersionFor(info.platform)]
    : [minVersionFor('desktop'), minVersionFor('mobile')];
  for (const min of candidates) {
    if (min && compareVersions(version, min) < 0) return min;
  }
  return null;
}

export function sendUpdateRequired(res: Response, minVersion?: string | null): void {
  res.status(426).json({
    code: 'update_required',
    message: UPDATE_REQUIRED_MESSAGE,
    ...(minVersion ? { minVersion } : {}),
  });
}

const EXEMPT_PREFIXES = ['/api/releases', '/api/download', '/api/health', '/api/csp-report'];

export function enforceMinClientVersion(req: Request, res: Response, next: NextFunction): void {
  const path = req.originalUrl.split('?')[0];
  if (!path.startsWith('/api/') || EXEMPT_PREFIXES.some((p) => path === p || path.startsWith(p + '/'))) {
    next();
    return;
  }
  const isAppRequest =
    (typeof req.headers.authorization === 'string' && req.headers.authorization.startsWith('Bearer ')) ||
    typeof req.query?.token === 'string';
  const info = readClientInfo(req.headers);
  const min = requiredMinVersion(info, isAppRequest);
  if (min) {
    if (typeof req.query?.token === 'string' && req.query.token) {
      auditLegacyQueryToken(req.query.token, { headers: req.headers, channel: 'http', accepted: false, path }, req);
    }
    auditLater('client.update_required', {
      result: 'denied',
      detail: { platform: info.platform, clientVersion: info.version, minVersion: min, path },
    }, req);
    sendUpdateRequired(res, min);
    return;
  }
  next();
}

export function isLegacyQueryTokenAllowed(): boolean {
  return (process.env.ALLOW_LEGACY_QUERY_TOKEN ?? '').trim().toLowerCase() === 'true';
}

const legacyAuditAt = new Map<string, number>();
const LEGACY_AUDIT_INTERVAL_MS = 60_000;

export function shouldAuditLegacyQuery(token: string, now: number = Date.now()): boolean {
  const key = sha256(token).slice(0, 32);
  const last = legacyAuditAt.get(key);
  if (last != null && now - last < LEGACY_AUDIT_INTERVAL_MS) return false;
  legacyAuditAt.set(key, now);
  if (legacyAuditAt.size > 5000) {
    for (const [k, t] of legacyAuditAt) if (now - t >= LEGACY_AUDIT_INTERVAL_MS) legacyAuditAt.delete(k);
  }
  return true;
}

export function auditLegacyQueryToken(
  token: string,
  ctx: { headers: IncomingHttpHeaders; channel: 'http' | 'native_ws' | 'socket_io' | 'desktop_exchange'; accepted: boolean; path?: string },
  req?: Request,
): void {
  if (!shouldAuditLegacyQuery(token)) return;
  const info = readClientInfo(ctx.headers);
  auditLater('token.legacy_query', {
    result: ctx.accepted ? 'success' : 'denied',
    actor: { authMethod: 'api_token' },
    detail: {
      channel: ctx.channel,
      accepted: ctx.accepted,
      clientVersion: info.version,
      clientPlatform: info.platform,
      path: ctx.path ?? null,
    },
  }, req);
}
