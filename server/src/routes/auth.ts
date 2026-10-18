import { Router, type Request } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import * as authService from '../services/authService.js';
import { requireAuth } from '../middleware/auth.js';
import { terminateUserLiveMeetings } from '../services/authSessionService.js';
import { db, pool } from '../db/index.js';
import { users, desktopExchangeCodes, apiTokens } from '../db/schema.js';
import { eq, and, isNull, gt, lt } from 'drizzle-orm';
import { sha256, requireTokenAuth } from '../middleware/tokenAuth.js';
import { extractBearer } from '../middleware/authContext.js';
import { requireRecentAuth, hasRecentAuth, markRecentAuth } from '../middleware/recentAuth.js';
import {
  auditLegacyQueryToken,
  isLegacyQueryTokenAllowed,
  readClientInfo,
} from '../middleware/clientVersion.js';
import {
  findActiveToken,
  isTokenActive,
  issueApiToken,
  listActiveTokens,
  normalizeClientType,
  normalizeDeviceName,
  revokeToken,
  revokeTokensOfType,
  tokenExpiryInfo,
  type ClientType,
} from '../services/apiTokenService.js';
import { logoutOtherDevices, notifyTokenRevoked } from '../services/authSessionService.js';
import { authLimiter, loginAccountLimiter, registerLimiter, passwordResetLimiter, inviteLimiter } from '../middleware/rateLimit.js';
import { isDisposableEmail } from '../services/emailValidation.js';
import { audit, auditAuthFailure } from '../services/audit/audit.js';
import { tokenLast4 } from '../services/audit/logSafety.js';
import { authUserId, getAuth } from '../middleware/authContext.js';
import { INVITE_VERIFIED_FOR_CLIENTS } from '../middleware/inviteVerified.js';
import { serverFeatures } from '../services/features.js';
import { issueInitialSetupCode } from '../services/initialSetupCode.js';

const googleClient = new OAuth2Client();

const GOOGLE_EMAIL_UNVERIFIED_MESSAGE =
  'この Google アカウントのメールアドレスは Google で確認されていないため、ログインに使えません。' +
  'Google でメールアドレスの確認を済ませてから、もう一度お試しください。';

const router = Router();

function regenerateSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
}

function markFreshLogin(req: Request): void {
  const now = Date.now();
  req.session.issuedAt = now;
  req.session.touchedAt = now;
  req.session.sudoAt = now;
  req.session.adminSeenAt = now;
}

function safeRelativeRedirect(raw: string): string {
  try {
    const base = 'https://internal.invalid';
    const u = new URL(raw, base);
    if (u.origin !== base) return '/';
    return u.pathname + u.search + u.hash;
  } catch {
    return '/';
  }
}

const registerSchema = z.object({
  email: z
    .string()
    .email('有効なメールアドレスを入力してください')
    .refine((e) => !e.toLowerCase().endsWith('@removed.local'), {
      message: 'このドメインは使用できません',
    })
    .refine((e) => !isDisposableEmail(e), {
      message: '使い捨てメールアドレスは登録に使用できません。常用のメールアドレスをご利用ください。',
    }),
  password: z.string().min(8, 'パスワードは8文字以上必要です'),
  displayName: z.string().min(1).max(100).optional(),
  code: z.string().trim().max(64).optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

router.post('/register', authLimiter, registerLimiter, async (req, res, next) => {
  try {
    const { email, password, displayName, code } = registerSchema.parse(req.body);
    const user = await authService.register(email, password, displayName, code);

    await regenerateSession(req);
    req.session.userId = user.id;
    req.session.email = user.email;
    req.session.displayName = user.displayName;
    markFreshLogin(req);
    await audit('signup', { actor: { id: user.id, email: user.email, authMethod: 'password' } }, req);

    res.status(201).json({
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      inviteVerified: INVITE_VERIFIED_FOR_CLIENTS,
      createdAt: user.createdAt,
      roomObservationEnabled: process.env.ROOM_OBSERVATION_ENABLED === 'true',
      features: serverFeatures(),
    });
  } catch (err) {
    next(err);
  }
});

const checkInviteSchema = z.object({
  code: z.string().trim().min(1, '招待コードを入力してください').max(64),
});

router.post('/check-invite', inviteLimiter, async (req, res, next) => {
  try {
    const { code } = checkInviteSchema.parse(req.body);
    await authService.validateInviteCode(code);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

const verifyInviteSchema = z.object({
  code: z.string().trim().min(1, '招待コードを入力してください').max(64),
});

router.post('/verify-invite', inviteLimiter, requireAuth, async (req, res, next) => {
  try {
    const userId = authUserId(req);
    const { code } = verifyInviteSchema.parse(req.body);
    const normalized = code.toUpperCase();

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: meRows } = await client.query<{ invite_verified: boolean }>(
        'SELECT invite_verified FROM users WHERE id = $1 FOR UPDATE',
        [userId]
      );
      if (meRows[0]?.invite_verified) {
        await client.query('COMMIT');
        res.json({ ok: true, alreadyVerified: true });
        return;
      }

      const { rows: codeRows } = await client.query<{
        code: string;
        max_uses: number | null;
        used_count: number;
        expires_at: Date | null;
        is_active: boolean;
      }>(
        'SELECT code, max_uses, used_count, expires_at, is_active FROM invite_codes WHERE code = $1 FOR UPDATE',
        [normalized]
      );
      const row = codeRows[0];
      if (!row || !row.is_active) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: 'invalid_code', message: '招待コードが無効です' });
        return;
      }
      if (row.expires_at && new Date(row.expires_at) < new Date()) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: 'expired_code', message: '招待コードの有効期限が切れています' });
        return;
      }
      if (row.max_uses !== null && row.used_count >= row.max_uses) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: 'exhausted_code', message: '招待コードの利用上限に達しています' });
        return;
      }

      await client.query(
        `UPDATE users
         SET invite_verified = true, invite_verified_at = now(), updated_at = now()
         WHERE id = $1`,
        [userId]
      );
      await client.query(
        'UPDATE invite_codes SET used_count = used_count + 1 WHERE code = $1',
        [normalized]
      );
      await client.query(
        `INSERT INTO invite_redemptions (user_id, code) VALUES ($1, $2)
         ON CONFLICT (user_id) DO NOTHING`,
        [userId, normalized]
      );

      await client.query('COMMIT');
      res.json({ ok: true });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

router.post('/login', authLimiter, loginAccountLimiter, async (req, res, next) => {
  try {
    const { email, password } = loginSchema.parse(req.body);
    const user = await authService.login(email, password);

    await regenerateSession(req);
    req.session.userId = user.id;
    req.session.email = user.email;
    req.session.displayName = user.displayName;
    markFreshLogin(req);
    await audit('login.success', { actor: { id: user.id, email: user.email, authMethod: 'password' } }, req);

    res.json({
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      inviteVerified: INVITE_VERIFIED_FOR_CLIENTS,
      createdAt: user.createdAt,
      roomObservationEnabled: process.env.ROOM_OBSERVATION_ENABLED === 'true',
      features: serverFeatures(),
    });
  } catch (err) {
    auditAuthFailure('login.failure', 'password', err, req);
    next(err);
  }
});

router.post('/logout', async (req, res, next) => {
  const bearer = extractBearer(req);
  if (bearer) {
    try {
      const found = await findActiveToken(bearer);
      if (found) {
        await revokeToken(found.userId, found.tokenId, 'logout');
        await audit('logout', { actor: { id: found.userId, email: found.email, authMethod: 'api_token' }, detail: { deviceName: found.deviceName } }, req);
        await audit('token.revoke', { actor: { id: found.userId, authMethod: 'api_token' }, target: { type: 'api_token', id: found.tokenId }, detail: { reason: 'logout', scope: 'one' } }, req);
      }
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
    return;
  }
  const userId = getAuth(req)?.userId;
  if (userId) void audit('logout', { actor: { id: userId, email: getAuth(req)?.email ?? null } }, req);
  if (userId) {
    terminateUserLiveMeetings(userId, ['socketIO']).catch((e) =>
      console.error('[Auth] logout terminate live meetings failed:', e),
    );
  }
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

function meTokenExpiry(req: Request): {
  tokenExpiresAt: string | null;
  daysUntilReauth: number | null;
  tokenIdleExpiresAt: string | null;
} {
  const a = getAuth(req);
  if (a?.method !== 'token' || !a.tokenCreatedAt || !a.tokenLastUsedAt) {
    return { tokenExpiresAt: null, daysUntilReauth: null, tokenIdleExpiresAt: null };
  }
  return tokenExpiryInfo(a.tokenLastUsedAt, a.tokenCreatedAt);
}

router.post('/heartbeat', requireAuth, (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.status(204).end();
});

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const user = await authService.getUserById(authUserId(req));
    if (!user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    res.json({
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      inviteVerified: INVITE_VERIFIED_FOR_CLIENTS,
      createdAt: user.createdAt,
      roomObservationEnabled: process.env.ROOM_OBSERVATION_ENABLED === 'true',
      features: serverFeatures(),
      ...meTokenExpiry(req),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/token', requireAuth, async (req, res, next) => {
  try {
    const devices = await listActiveTokens(authUserId(req));
    res.json({ hasToken: devices.some((d) => d.clientType === 'api') });
  } catch (err) {
    next(err);
  }
});

router.post('/token', requireAuth, requireRecentAuth, async (req, res, next) => {
  try {
    const userId = authUserId(req);
    await revokeTokensOfType(userId, 'api', 'rotated');
    const { token: newToken, id } = await issueApiToken(userId, { clientType: 'api', deviceName: '外部連携用 API トークン' });
    await audit('token.issue', { target: { type: 'api_token', id }, detail: { via: 'settings', rotated: true, clientType: 'api', tokenLast4: tokenLast4(newToken) } }, req);
    res.json({ token: newToken });
  } catch (err) {
    next(err);
  }
});

router.get('/devices', requireAuth, async (req, res, next) => {
  try {
    const auth = getAuth(req)!;
    const rows = await listActiveTokens(auth.userId);
    res.json({
      devices: rows.map((d) => ({
        id: d.id,
        deviceName: d.deviceName,
        clientType: d.clientType,
        clientVersion: d.clientVersion,
        createdAt: d.createdAt,
        lastUsedAt: d.lastUsedAt,
        current: auth.tokenId != null && auth.tokenId === d.id,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.delete('/devices/:id', requireAuth, async (req, res, next) => {
  try {
    const userId = authUserId(req);
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      res.status(400).json({ error: 'invalid_id' });
      return;
    }
    const ok = await revokeToken(userId, id, 'device_logout');
    if (!ok) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    notifyTokenRevoked(userId, id);
    await audit('token.revoke', { target: { type: 'api_token', id }, detail: { reason: 'device_logout', scope: 'one' } }, req);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/logout-others', requireAuth, async (req, res, next) => {
  try {
    const auth = getAuth(req)!;
    const result = await logoutOtherDevices(auth.userId, {
      tokenId: auth.method === 'token' ? auth.tokenId ?? null : req.session?.apiTokenId ?? null,
      sessionId: auth.method === 'session' ? req.sessionID : null,
    });
    await audit('logout.others', { detail: { ...result, via: auth.method } }, req);
    if (result.revokedTokens > 0) {
      await audit('token.revoke', { target: { type: 'api_token', id: auth.userId }, detail: { reason: 'logout_others', scope: 'others', revokedTokens: result.revokedTokens } }, req);
    }
    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

const sudoSchema = z.object({
  password: z.string().min(1).max(200).optional(),
  credential: z.string().min(1).max(4096).optional(),
});

router.get('/sudo', requireAuth, async (req, res, next) => {
  try {
    const user = await authService.getUserById(authUserId(req));
    res.json({ active: await hasRecentAuth(req), method: user?.passwordHash ? 'password' : 'google' });
  } catch (err) {
    next(err);
  }
});

router.post('/sudo', authLimiter, requireAuth, async (req, res, next) => {
  try {
    const { password, credential } = sudoSchema.parse(req.body);
    const userId = authUserId(req);
    const user = await authService.getUserById(userId);
    if (!user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    let ok = false;
    let method: 'password' | 'google' = 'password';
    if (password && user.passwordHash) {
      ok = await authService.verifyPassword(user, password);
    } else if (credential && user.googleId) {
      method = 'google';
      const clientId = process.env.GOOGLE_CLIENT_ID;
      if (clientId) {
        const ticket = await googleClient
          .verifyIdToken({ idToken: credential, audience: clientId })
          .catch(() => null);
        const payload = ticket?.getPayload();
        ok = !!payload && payload.sub === user.googleId && authService.isGoogleEmailVerified(payload);
      }
    }
    if (!ok) {
      await audit('auth.sudo', { result: 'failure', detail: { method } }, req);
      res.status(401).json({ error: 'reauth_failed', message: method === 'google' ? 'Google アカウントを確認できませんでした' : 'パスワードが正しくありません' });
      return;
    }
    await markRecentAuth(req);
    await audit('auth.sudo', { detail: { method } }, req);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

const forgotPasswordSchema = z.object({
  email: z.string().email('有効なメールアドレスを入力してください'),
});

router.post('/forgot-password', passwordResetLimiter, async (req, res, next) => {
  try {
    const { email } = forgotPasswordSchema.parse(req.body);
    await authService.requestPasswordReset(email);
    await audit('password.reset', { actor: { email: email.trim().toLowerCase() }, detail: { stage: 'request' } }, req);
    res.json({ ok: true, message: 'リセットメールを送信しました' });
  } catch (err) {
    next(err);
  }
});

const resetPasswordSchema = z.object({
  token: z.string().min(1, 'トークンが必要です'),
  newPassword: z.string().min(8, 'パスワードは8文字以上必要です'),
});

router.post('/reset-password', authLimiter, async (req, res, next) => {
  try {
    const { token, newPassword } = resetPasswordSchema.parse(req.body);
    const userId = await authService.resetPassword(token, newPassword);
    await audit('password.reset', { actor: { id: userId ?? null }, detail: { stage: 'complete' } }, req);
    res.json({ ok: true, message: 'パスワードをリセットしました' });
  } catch (err) {
    auditAuthFailure('password.reset', 'reset_token', err, req);
    next(err);
  }
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, '現在のパスワードを入力してください'),
  newPassword: z.string().min(8, '新しいパスワードは8文字以上必要です'),
});

router.post('/change-password', authLimiter, requireAuth, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);
    const userId = authUserId(req);
    await authService.changePassword(userId, currentPassword, newPassword);
    await audit('password.change', { actor: { id: userId } }, req);
    res.json({ ok: true, message: 'パスワードを変更しました' });
  } catch (err) {
    auditAuthFailure('password.change', 'password', err, req);
    next(err);
  }
});

const googleLoginSchema = z.object({
  credential: z.string().min(1, 'Google認証情報が必要です'),
  code: z.string().trim().max(64).optional(),
  confirmRegistration: z.boolean().optional(),
});

router.get('/google/client-id', (_req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID || '';
  res.json({ clientId });
});

router.get('/signup-status', async (_req, res, next) => {
  try {
    const awaiting = await authService.isAwaitingFirstAdmin();
    if (awaiting) issueInitialSetupCode();
    res.json({ mode: awaiting ? 'first_admin' : 'invite_only' });
  } catch (err) {
    next(err);
  }
});

router.post('/google', authLimiter, async (req, res, next) => {
  try {
    const { credential, confirmRegistration, code } = googleLoginSchema.parse(req.body);
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) {
      res.status(500).json({ error: 'Google認証が設定されていません' });
      return;
    }

    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: clientId,
    });
    const payload = ticket.getPayload();
    if (!payload || !payload.sub || !payload.email) {
      res.status(401).json({ error: 'Google認証に失敗しました' });
      return;
    }
    if (!authService.isGoogleEmailVerified(payload)) {
      res.status(403).json({ error: GOOGLE_EMAIL_UNVERIFIED_MESSAGE, code: 'google_email_unverified' });
      return;
    }

    const existing = await authService.findExistingByGoogle(payload.sub, payload.email);

    if (!existing && !code && !(await authService.isAwaitingFirstAdmin())) {
      res.status(403).json({ error: authService.INVITE_REQUIRED_MESSAGE, code: 'invite_required' });
      return;
    }

    if (!existing && confirmRegistration !== true) {
      res.json({
        needsRegistration: true,
        email: payload.email,
        name: payload.name ?? null,
      });
      return;
    }

    const { user, created } = existing
      ? { user: existing, created: false }
      : await authService.findOrCreateByGoogle(
          payload.sub,
          payload.email,
          payload.name,
          code,
        );

    await regenerateSession(req);
    req.session.userId = user.id;
    req.session.email = user.email;
    req.session.displayName = user.displayName;
    markFreshLogin(req);
    if (created) await audit('signup', { actor: { id: user.id, email: user.email, authMethod: 'google' } }, req);
    await audit('login.success', { actor: { id: user.id, email: user.email, authMethod: 'google' } }, req);

    res.json({
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      inviteVerified: INVITE_VERIFIED_FOR_CLIENTS,
      createdAt: user.createdAt,
      created,
      roomObservationEnabled: process.env.ROOM_OBSERVATION_ENABLED === 'true',
      features: serverFeatures(),
    });
  } catch (err) {
    auditAuthFailure('login.failure', 'google', err, req);
    next(err);
  }
});

router.get('/settings', requireAuth, async (_req, res) => {
  res.json({});
});

router.patch('/settings', requireAuth, async (_req, res) => {
  res.json({});
});

const RELOGIN_REASONS = ['logout_click', 'session_invalidated', 'decrypt_failed', 'encryption_unavailable', 'no_token'] as const;
const appLoginExtrasSchema = z.object({
  deviceName: z.string().max(200).optional(),
  device_name: z.string().max(200).optional(),
  clientType: z.string().max(20).optional(),
  client_type: z.string().max(20).optional(),
  reloginReason: z.string().max(40).optional(),
  relogin_reason: z.string().max(40).optional(),
});

function readAppLoginExtras(req: Request) {
  const parsed = appLoginExtrasSchema.safeParse(req.body ?? {});
  const b = parsed.success ? parsed.data : {};
  const info = readClientInfo(req.headers);
  const clientType: ClientType = normalizeClientType(b.clientType ?? b.client_type) ?? info.platform ?? 'desktop';
  const rawReason = b.reloginReason ?? b.relogin_reason;
  const reloginReason = (RELOGIN_REASONS as readonly string[]).includes(rawReason ?? '') ? rawReason! : null;
  return {
    deviceName: normalizeDeviceName(b.deviceName ?? b.device_name),
    clientType,
    clientVersion: info.version,
    reloginReason,
  };
}

async function issueAppToken(
  userId: number,
  extras: ReturnType<typeof readAppLoginExtras>,
): Promise<{ token: string; id: number }> {
  return issueApiToken(userId, {
    deviceName: extras.deviceName,
    clientType: extras.clientType,
    clientVersion: extras.clientVersion,
  });
}

function shapeUserForClient(user: Awaited<ReturnType<typeof authService.getUserById>>) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    inviteVerified: INVITE_VERIFIED_FOR_CLIENTS,
    createdAt: user.createdAt,
  };
}

router.post('/login-with-token', authLimiter, loginAccountLimiter, async (req, res, next) => {
  try {
    const { email, password } = loginSchema.parse(req.body);
    const extras = readAppLoginExtras(req);
    const user = await authService.login(email, password);
    const { token, id: tokenId } = await issueAppToken(user.id, extras);
    await audit('login.success', { actor: { id: user.id, email: user.email, authMethod: 'password' }, detail: { client: 'app', clientType: extras.clientType, deviceName: extras.deviceName, clientVersion: extras.clientVersion, reloginReason: extras.reloginReason } }, req);
    await audit('token.issue', { actor: { id: user.id }, target: { type: 'api_token', id: tokenId }, detail: { via: 'login-with-token', clientType: extras.clientType, deviceName: extras.deviceName, tokenLast4: tokenLast4(token) } }, req);
    const full = await authService.getUserById(user.id);
    res.json({ token, user: shapeUserForClient(full) });
  } catch (err) {
    auditAuthFailure('login.failure', 'password', err, req);
    next(err);
  }
});

const HANDOFF_TTL_SEC = 60;
router.post('/desktop-exchange-code', authLimiter, requireTokenAuth, async (req, res, next) => {
  try {
    const auth = getAuth(req);
    if (!auth || auth.method !== 'token' || auth.tokenId == null) {
      res.status(401).json({ error: 'not_authenticated' });
      return;
    }
    const code = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + HANDOFF_TTL_SEC * 1000);
    await db.insert(desktopExchangeCodes).values({ code: sha256(code), userId: auth.userId, apiTokenId: auth.tokenId, expiresAt });
    await audit('token.issue', { actor: { id: auth.userId, authMethod: 'api_token' }, target: { type: 'desktop_exchange_code', id: auth.tokenId }, detail: { ttlSec: HANDOFF_TTL_SEC } }, req);
    await db.delete(desktopExchangeCodes).where(lt(desktopExchangeCodes.expiresAt, new Date()));
    res.json({ code, expiresInSec: HANDOFF_TTL_SEC });
  } catch (err) {
    next(err);
  }
});

router.get('/desktop-exchange', authLimiter, async (req, res, next) => {
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  try {
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const legacyToken = typeof req.query.token === 'string' ? req.query.token : '';
    const redirectRaw =
      typeof req.query.next === 'string' ? req.query.next : typeof req.query.redirect === 'string' ? req.query.redirect : '/';
    const safeRedirect = safeRelativeRedirect(redirectRaw);
    const fail = () => res.redirect('/login?handoff=failed');

    let userId: number | null = null;
    let apiTokenId: number | null = null;
    let deviceName: string | null = null;

    if (code) {
      const [claimed] = await db
        .update(desktopExchangeCodes)
        .set({ usedAt: new Date() })
        .where(
          and(
            eq(desktopExchangeCodes.code, sha256(code)),
            isNull(desktopExchangeCodes.usedAt),
            gt(desktopExchangeCodes.expiresAt, new Date()),
          ),
        )
        .returning({ userId: desktopExchangeCodes.userId, apiTokenId: desktopExchangeCodes.apiTokenId });
      if (claimed && claimed.apiTokenId != null && (await isTokenActive(claimed.apiTokenId))) {
        userId = claimed.userId;
        apiTokenId = claimed.apiTokenId;
        const [t] = await db.select({ deviceName: apiTokens.deviceName }).from(apiTokens).where(eq(apiTokens.id, apiTokenId)).limit(1);
        deviceName = t?.deviceName ?? null;
      }
    } else if (legacyToken) {
      const accepted = isLegacyQueryTokenAllowed();
      auditLegacyQueryToken(legacyToken, { headers: req.headers, channel: 'desktop_exchange', accepted, path: req.path }, req);
      if (!accepted) {
        res
          .status(426)
          .type('text/html; charset=utf-8')
          .send('<!doctype html><meta charset="utf-8"><title>更新のお願い</title><p>新しいバージョンに更新してください</p>');
        return;
      }
      const found = await findActiveToken(legacyToken);
      if (found) {
        userId = found.userId;
        apiTokenId = found.tokenId;
        deviceName = found.deviceName;
      }
    } else {
      fail();
      return;
    }

    if (userId == null) {
      void audit('auth.handoff', { result: 'failure', actor: { authMethod: 'token' }, detail: { via: code ? 'exchange_code' : 'legacy_query_token' } }, req);
      fail();
      return;
    }

    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) {
      fail();
      return;
    }

    if (req.session.userId && req.session.userId !== user.id) {
      void audit('auth.handoff', { result: 'failure', actor: { id: req.session.userId }, detail: { via: code ? 'exchange_code' : 'legacy_query_token', reason: 'other_account_signed_in' } }, req);
      res
        .status(409)
        .type('text/html; charset=utf-8')
        .send(
          '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
            '<title>別のアカウントでログイン中です</title>' +
            '<div style="font-family: system-ui, sans-serif; max-width: 520px; margin: 48px auto; padding: 0 16px; line-height: 1.8">' +
            '<h1 style="font-size: 18px">このブラウザは、別のアカウントでログイン中です</h1>' +
            '<p>アプリから開いたアカウントには切り替えませんでした。切り替えるときは、このブラウザでいったんログアウトしてから、アプリからもう一度開いてください。</p>' +
            '<p><a href="/">いまのアカウントのまま開く</a></p></div>',
        );
      return;
    }

    await regenerateSession(req);
    req.session.userId = user.id;
    req.session.email = user.email;
    req.session.displayName = user.displayName;
    if (apiTokenId != null) req.session.apiTokenId = apiTokenId;
    req.session.issuedAt = Date.now();
    req.session.touchedAt = Date.now();
    await audit('auth.handoff', { actor: { id: user.id, email: user.email, authMethod: 'token' }, target: { type: 'api_token', id: apiTokenId }, detail: { via: code ? 'exchange_code' : 'legacy_query_token', deviceName } }, req);

    req.session.save((err) => {
      if (err) return next(err);
      res.redirect(safeRedirect);
    });
  } catch (err) {
    next(err);
  }
});

router.post('/google-with-token', authLimiter, async (req, res, next) => {
  try {
    const { credential } = googleLoginSchema.parse(req.body);
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) {
      res.status(500).json({ error: 'Google認証が設定されていません' });
      return;
    }
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: clientId,
    });
    const payload = ticket.getPayload();
    if (!payload || !payload.sub || !payload.email) {
      res.status(401).json({ error: 'Google認証に失敗しました' });
      return;
    }
    if (!authService.isGoogleEmailVerified(payload)) {
      res.status(403).json({ error: 'google_email_unverified', message: GOOGLE_EMAIL_UNVERIFIED_MESSAGE });
      return;
    }
    if (!(await authService.findExistingByGoogle(payload.sub, payload.email)) && !(await authService.isAwaitingFirstAdmin())) {
      res.status(403).json({ error: 'invite_required', message: authService.INVITE_REQUIRED_MESSAGE });
      return;
    }
    const extras = readAppLoginExtras(req);
    const { user, created } = await authService.findOrCreateByGoogle(payload.sub, payload.email, payload.name);
    const { token, id: tokenId } = await issueAppToken(user.id, extras);
    if (created) await audit('signup', { actor: { id: user.id, email: user.email, authMethod: 'google' }, detail: { client: 'app' } }, req);
    await audit('login.success', { actor: { id: user.id, email: user.email, authMethod: 'google' }, detail: { client: 'app', clientType: extras.clientType, deviceName: extras.deviceName, clientVersion: extras.clientVersion, reloginReason: extras.reloginReason } }, req);
    await audit('token.issue', { actor: { id: user.id }, target: { type: 'api_token', id: tokenId }, detail: { via: 'google-with-token', clientType: extras.clientType, deviceName: extras.deviceName, tokenLast4: tokenLast4(token) } }, req);
    const full = await authService.getUserById(user.id);
    res.json({ token, user: shapeUserForClient(full) });
  } catch (err) {
    auditAuthFailure('login.failure', 'google', err, req);
    next(err);
  }
});

export default router;
