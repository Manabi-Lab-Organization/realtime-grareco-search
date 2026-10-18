import net from 'node:net';
import type { Request } from 'express';

export function maskEmail(email: unknown): string {
  if (typeof email !== 'string' || !email.includes('@')) return '[no-email]';
  const at = email.lastIndexOf('@');
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  return `${local.slice(0, 1) || '*'}***@${domain}`;
}

export function getClientIp(req: Pick<Request, 'headers' | 'socket'> & { app?: { get?: (k: string) => unknown } }): string | null {
  let raw: string | undefined;
  const behindProxy = Boolean(req.app?.get?.('trust proxy'));
  const xff = req.headers?.['x-forwarded-for'];
  if (behindProxy && xff) {
    const joined = Array.isArray(xff) ? xff.join(',') : xff;
    const parts = joined.split(',').map((s) => s.trim()).filter(Boolean);
    raw = parts[parts.length - 1];
  }
  if (!raw) raw = req.socket?.remoteAddress ?? undefined;
  return normalizeIp(raw);
}

export function normalizeIp(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let ip = raw.trim();
  if (ip.startsWith('::ffff:') && net.isIPv4(ip.slice(7))) ip = ip.slice(7);
  return net.isIP(ip) ? ip : null;
}

export function redactPath(path: string): string {
  return path
    .replace(/^\/api\/share\/[^/]+/, '/api/share/[token]')
    .replace(/^\/share\/[^/]+/, '/share/[token]');
}

const SECRET_KEY = /(pass(word)?|secret|api_?key|credential|authorization|cookie|^token$|access_?token|refresh_?token|reset_?token|id_?token)/i;
const MAX_STRING = 500;
const MAX_DEPTH = 5;

export function sanitizeDetail(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (depth > MAX_DEPTH) return '[depth]';
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, 80)}…[${value.length} chars]` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    const arr = value.slice(0, 200).map((v) => sanitizeDetail(v, depth + 1));
    if (value.length > 200) arr.push(`…[${value.length} items]`);
    return arr;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? '[REDACTED]' : sanitizeDetail(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

export function tokenLast4(token: string | null | undefined): string | null {
  if (!token || token.length < 12) return null;
  return token.slice(-4);
}

export function clipUserAgent(ua: unknown): string | null {
  if (typeof ua !== 'string' || !ua) return null;
  return ua.length > 400 ? ua.slice(0, 400) : ua;
}
