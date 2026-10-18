import crypto from 'crypto';
import { and, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { apiTokens, users } from '../db/schema.js';
import { applyLiveMeetingGrace, hasLiveMeeting } from './liveMeetingGrace.js';

export type ClientType = 'desktop' | 'mobile' | 'api' | 'legacy';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function positiveNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function tokenIdleDays(): number {
  return positiveNumberEnv('TOKEN_IDLE_DAYS', 30);
}

export function tokenAbsoluteDays(): number {
  const raw = process.env.TOKEN_ABSOLUTE_DAYS;
  if (raw != null && raw.trim() === '0') return 0;
  return positiveNumberEnv('TOKEN_ABSOLUTE_DAYS', 90);
}

export function isTokenExpired(
  lastUsedAt: Date,
  now: number = Date.now(),
  idleDays: number = tokenIdleDays(),
  createdAt?: Date | null,
  absoluteDays: number = tokenAbsoluteDays(),
): boolean {
  if (now - lastUsedAt.getTime() > idleDays * DAY_MS) return true;
  if (createdAt && absoluteDays > 0 && now - createdAt.getTime() > absoluteDays * DAY_MS) return true;
  return false;
}

export interface TokenExpiryInfo {
  tokenExpiresAt: string | null;
  daysUntilReauth: number | null;
  tokenIdleExpiresAt: string;
}

export function tokenExpiryInfo(
  lastUsedAt: Date,
  createdAt: Date,
  now: number = Date.now(),
  idleDays: number = tokenIdleDays(),
  absoluteDays: number = tokenAbsoluteDays(),
): TokenExpiryInfo {
  const idleAt = lastUsedAt.getTime() + idleDays * DAY_MS;
  const absAt = absoluteDays > 0 ? createdAt.getTime() + absoluteDays * DAY_MS : null;
  return {
    tokenExpiresAt: absAt != null ? new Date(absAt).toISOString() : null,
    daysUntilReauth: absAt != null ? Math.max(0, Math.ceil((absAt - now) / DAY_MS)) : null,
    tokenIdleExpiresAt: new Date(idleAt).toISOString(),
  };
}

export function shouldTouch(lastUsedAt: Date, now: number = Date.now()): boolean {
  return now - lastUsedAt.getTime() >= HOUR_MS;
}

const DEVICE_NAME_MAX = 100;
export function normalizeDeviceName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const s = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, DEVICE_NAME_MAX);
  return s || null;
}

export function normalizeClientType(raw: unknown): ClientType | null {
  return raw === 'desktop' || raw === 'mobile' || raw === 'api' ? raw : null;
}

export interface IssueOptions {
  deviceName?: string | null;
  clientType: ClientType;
  clientVersion?: string | null;
}

export async function issueApiToken(userId: number, opts: IssueOptions): Promise<{ token: string; id: number }> {
  const token = crypto.randomBytes(32).toString('hex');
  const [row] = await db
    .insert(apiTokens)
    .values({
      userId,
      tokenHash: sha256(token),
      deviceName: normalizeDeviceName(opts.deviceName),
      clientType: opts.clientType,
      clientVersion: opts.clientVersion ? String(opts.clientVersion).slice(0, 40) : null,
      sudoAt: new Date(),
    })
    .returning({ id: apiTokens.id });
  return { token, id: row.id };
}

export interface ActiveToken {
  tokenId: number;
  userId: number;
  email: string;
  displayName: string | null;
  deviceName: string | null;
  clientType: string;
  createdAt: Date;
  lastUsedAt: Date;
  inLiveMeetingGrace?: boolean;
}

export async function findActiveToken(rawToken: string): Promise<ActiveToken | null> {
  if (!rawToken || rawToken.length > 256) return null;
  const hash = sha256(rawToken);

  const [row] = await db
    .select({
      tokenId: apiTokens.id,
      userId: apiTokens.userId,
      lastUsedAt: apiTokens.lastUsedAt,
      createdAt: apiTokens.createdAt,
      revokedAt: apiTokens.revokedAt,
      deviceName: apiTokens.deviceName,
      clientType: apiTokens.clientType,
      email: users.email,
      displayName: users.displayName,
    })
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.userId))
    .where(eq(apiTokens.tokenHash, hash))
    .limit(1);

  if (row) {
    if (row.revokedAt) return null;
    const now = Date.now();
    const expired = isTokenExpired(row.lastUsedAt, now, undefined, row.createdAt);
    const verdict = expired ? applyLiveMeetingGrace(true, await hasLiveMeeting(row.userId, now)) : 'valid';
    if (verdict === 'expired') {
      void db
        .update(apiTokens)
        .set({ revokedAt: new Date(now), revokedReason: 'idle_expired' })
        .where(and(eq(apiTokens.id, row.tokenId), isNull(apiTokens.revokedAt)))
        .catch(() => {});
      return null;
    }
    if (shouldTouch(row.lastUsedAt, now)) {
      void db
        .update(apiTokens)
        .set({ lastUsedAt: new Date(now) })
        .where(eq(apiTokens.id, row.tokenId))
        .catch((err) => console.error('[apiToken] last_used_at の更新に失敗:', err instanceof Error ? err.message : String(err)));
    }
    return {
      tokenId: row.tokenId,
      userId: row.userId,
      email: row.email,
      displayName: row.displayName,
      deviceName: row.deviceName,
      clientType: row.clientType,
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt,
      ...(verdict === 'grace' ? { inLiveMeetingGrace: true } : {}),
    };
  }

  const [legacy] = await db
    .select({ id: users.id, email: users.email, displayName: users.displayName })
    .from(users)
    .where(eq(users.apiTokenHash, hash))
    .limit(1);
  if (!legacy) return null;
  const [moved] = await db
    .insert(apiTokens)
    .values({ userId: legacy.id, tokenHash: hash, deviceName: '以前のログイン', clientType: 'legacy' })
    .onConflictDoNothing()
    .returning({ id: apiTokens.id });
  await db.update(users).set({ apiTokenHash: null }).where(eq(users.id, legacy.id));
  if (!moved) return findActiveToken(rawToken);
  return {
    tokenId: moved.id,
    userId: legacy.id,
    email: legacy.email,
    displayName: legacy.displayName,
    deviceName: '以前のログイン',
    clientType: 'legacy',
    createdAt: new Date(),
    lastUsedAt: new Date(),
  };
}

const activeCache = new Map<number, { active: boolean; at: number }>();
const ACTIVE_CACHE_MS = 30_000;

export async function isTokenActive(tokenId: number): Promise<boolean> {
  const c = activeCache.get(tokenId);
  if (c && Date.now() - c.at < ACTIVE_CACHE_MS) return c.active;
  const [row] = await db
    .select({ userId: apiTokens.userId, lastUsedAt: apiTokens.lastUsedAt, createdAt: apiTokens.createdAt, revokedAt: apiTokens.revokedAt })
    .from(apiTokens)
    .where(eq(apiTokens.id, tokenId))
    .limit(1);
  let active = !!row && !row.revokedAt;
  if (row && active && isTokenExpired(row.lastUsedAt, Date.now(), undefined, row.createdAt)) {
    active = applyLiveMeetingGrace(true, await hasLiveMeeting(row.userId)) === 'grace';
  }
  activeCache.set(tokenId, { active, at: Date.now() });
  if (activeCache.size > 10_000) activeCache.clear();
  return active;
}

function forgetCached(ids: number[]): void {
  for (const id of ids) activeCache.delete(id);
}

async function deleteSessionsBoundToTokens(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await db.execute(sql`DELETE FROM session WHERE (sess->>'apiTokenId') IS NOT NULL AND (sess->>'apiTokenId')::int IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`);
}

export async function revokeToken(userId: number, tokenId: number, reason: string): Promise<boolean> {
  const rows = await db
    .update(apiTokens)
    .set({ revokedAt: new Date(), revokedReason: reason.slice(0, 40) })
    .where(and(eq(apiTokens.id, tokenId), eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)))
    .returning({ id: apiTokens.id });
  const ids = rows.map((r) => r.id);
  forgetCached(ids);
  await deleteSessionsBoundToTokens(ids);
  return ids.length > 0;
}

export async function revokeAllTokens(userId: number, reason: string, exceptTokenId?: number | null): Promise<number> {
  const conds = [eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)];
  if (exceptTokenId != null) conds.push(ne(apiTokens.id, exceptTokenId));
  const rows = await db
    .update(apiTokens)
    .set({ revokedAt: new Date(), revokedReason: reason.slice(0, 40) })
    .where(and(...conds))
    .returning({ id: apiTokens.id });
  const ids = rows.map((r) => r.id);
  forgetCached(ids);
  await deleteSessionsBoundToTokens(ids);
  await db.update(users).set({ apiToken: null, apiTokenHash: null }).where(eq(users.id, userId));
  return ids.length;
}

export interface DeviceRow {
  id: number;
  deviceName: string | null;
  clientType: string;
  clientVersion: string | null;
  createdAt: Date;
  lastUsedAt: Date;
}

export async function listActiveTokens(userId: number): Promise<DeviceRow[]> {
  const cutoff = new Date(Date.now() - tokenIdleDays() * DAY_MS);
  const abs = tokenAbsoluteDays();
  const createdCutoff = new Date(abs > 0 ? Date.now() - abs * DAY_MS : 0);
  return db
    .select({
      id: apiTokens.id,
      deviceName: apiTokens.deviceName,
      clientType: apiTokens.clientType,
      clientVersion: apiTokens.clientVersion,
      createdAt: apiTokens.createdAt,
      lastUsedAt: apiTokens.lastUsedAt,
    })
    .from(apiTokens)
    .where(and(eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt), gt(apiTokens.lastUsedAt, cutoff), gt(apiTokens.createdAt, createdCutoff)))
    .orderBy(sql`${apiTokens.lastUsedAt} DESC`);
}

export async function revokeTokensOfType(userId: number, clientType: ClientType, reason: string): Promise<number> {
  const rows = await db
    .update(apiTokens)
    .set({ revokedAt: new Date(), revokedReason: reason.slice(0, 40) })
    .where(and(eq(apiTokens.userId, userId), eq(apiTokens.clientType, clientType), isNull(apiTokens.revokedAt)))
    .returning({ id: apiTokens.id });
  const ids = rows.map((r) => r.id);
  forgetCached(ids);
  await deleteSessionsBoundToTokens(ids);
  return ids.length;
}

export async function markTokenSudo(tokenId: number): Promise<void> {
  await db.update(apiTokens).set({ sudoAt: new Date() }).where(eq(apiTokens.id, tokenId));
}

export async function getTokenSudoAt(tokenId: number): Promise<Date | null> {
  const [row] = await db.select({ sudoAt: apiTokens.sudoAt }).from(apiTokens).where(eq(apiTokens.id, tokenId)).limit(1);
  return row?.sudoAt ?? null;
}
