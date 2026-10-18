import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { eq, sql, desc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users, inviteCodes, inviteRedemptions } from '../db/schema.js';
import { sendPasswordResetEmail } from './emailService.js';
import { audit } from './audit/audit.js';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError, UnauthorizedError } from '../errors/AppError.js';
import { sha256 } from '../middleware/tokenAuth.js';
import { invalidateAllUserAccess } from './authSessionService.js';
import { DEFAULT_AUTO_GRARECO_SETTINGS } from './grareco/types.js';
import { clearInitialSetupCode, issueInitialSetupCode, matchesInitialSetupCode } from './initialSetupCode.js';

export const NEW_USER_RESEARCH_SETTINGS = {
  main: true,
  web: true,
  fact: true,
  gap: true,
  tech: true,
  autoGrareco: {
    ...DEFAULT_AUTO_GRARECO_SETTINGS,
    enabled: true,
  },
};

const BCRYPT_ROUNDS = 12;

type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function assertInviteUsable(row: {
  maxUses: number | null;
  usedCount: number;
  expiresAt: Date | null;
  isActive: boolean;
} | undefined): void {
  if (!row || !row.isActive) {
    throw new BadRequestError('招待コードが無効です');
  }
  if (row.expiresAt && new Date(row.expiresAt) < new Date()) {
    throw new BadRequestError('招待コードの有効期限が切れています');
  }
  if (row.maxUses !== null && row.usedCount >= row.maxUses) {
    throw new BadRequestError('招待コードの利用上限に達しています');
  }
}

export async function validateInviteCode(code: string): Promise<void> {
  const normalized = code.toUpperCase();
  const [row] = await db
    .select({
      maxUses: inviteCodes.maxUses,
      usedCount: inviteCodes.usedCount,
      expiresAt: inviteCodes.expiresAt,
      isActive: inviteCodes.isActive,
    })
    .from(inviteCodes)
    .where(eq(inviteCodes.code, normalized))
    .limit(1);

  assertInviteUsable(row);
}

async function consumeInviteCodeTx(tx: DbTx, userId: number, code: string): Promise<void> {
  const normalized = code.toUpperCase();
  const [row] = await tx
    .select({
      maxUses: inviteCodes.maxUses,
      usedCount: inviteCodes.usedCount,
      expiresAt: inviteCodes.expiresAt,
      isActive: inviteCodes.isActive,
    })
    .from(inviteCodes)
    .where(eq(inviteCodes.code, normalized))
    .for('update')
    .limit(1);

  assertInviteUsable(row);

  const inserted = await tx
    .insert(inviteRedemptions)
    .values({ userId, code: normalized })
    .onConflictDoNothing({ target: inviteRedemptions.userId })
    .returning({ id: inviteRedemptions.id });

  if (inserted.length > 0) {
    await tx
      .update(inviteCodes)
      .set({ usedCount: sql`${inviteCodes.usedCount} + 1` })
      .where(eq(inviteCodes.code, normalized));
  }
}

export const INITIAL_ADMIN_MISMATCH_MESSAGE = '最初の管理者は、サーバに設定したメールアドレス（INITIAL_ADMIN_EMAIL）でしか登録できません';

export const SETUP_CODE_REQUIRED_MESSAGE = '最初の管理者の登録には、サーバのログに出ている初期設定コードが必要です。ウェブ画面の登録ページで入力してください';

export const INVITE_REQUIRED_MESSAGE = '登録には管理者からの招待が必要です。招待のリンクから登録してください';

export class InviteRequiredError extends ForbiddenError {
  constructor() {
    super(INVITE_REQUIRED_MESSAGE);
  }
}

async function countActiveUsers(q: Pick<DbTx, 'select'>): Promise<number> {
  const [row] = await q
    .select({ count: sql<number>`count(*)::int` })
    .from(users)
    .where(sql`${users.email} NOT LIKE 'deleted+%@removed.local'`)
    .limit(1);
  return row?.count ?? 0;
}

export async function isAwaitingFirstAdmin(): Promise<boolean> {
  return (await countActiveUsers(db)) === 0;
}

async function decideNewUserRoleTx(tx: DbTx, code: string | undefined, email: string): Promise<'admin' | 'user'> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(724001)`);
  if ((await countActiveUsers(tx)) === 0) {
    const allowed = normalizeEmail(process.env.INITIAL_ADMIN_EMAIL ?? '');
    if (allowed && normalizeEmail(email) !== allowed) throw new ForbiddenError(INITIAL_ADMIN_MISMATCH_MESSAGE);
    if (!matchesInitialSetupCode(code)) {
      issueInitialSetupCode();
      throw new ForbiddenError(SETUP_CODE_REQUIRED_MESSAGE);
    }
    return 'admin';
  }
  if (!code) throw new InviteRequiredError();
  return 'user';
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function emailMatches(email: string) {
  return sql`lower(${users.email}) = ${normalizeEmail(email)}`;
}

async function findUsersByEmail(email: string, max = 5) {
  return db
    .select()
    .from(users)
    .where(emailMatches(email))
    .orderBy(desc(sql`${users.email} = ${email.trim()}`), users.id)
    .limit(max);
}

export class GoogleLinkNotAllowedError extends ConflictError {
  readonly code = 'google_link_requires_verification';
  constructor() {
    super(
      'このメールアドレスは、すでにパスワードで登録されています。' +
        'メールアドレスの確認が済んでいないため、Google アカウントとは自動で連携しません。' +
        'パスワードでログインしてください。パスワードが分からない場合は、ログイン画面の' +
        '「パスワードをお忘れですか？」から再設定メールを受け取り、再設定を完了すると、' +
        '以後は Google でもログインできるようになります。',
    );
  }
}

export class GoogleAccountMismatchError extends ConflictError {
  readonly code = 'google_account_mismatch';
  constructor() {
    super(
      'このメールアドレスのアカウントは、別の Google アカウントと連携済みです。' +
        '以前ログインに使った Google アカウント、またはパスワードでログインしてください。',
    );
  }
}

export async function register(
  email: string,
  password: string,
  displayName: string | undefined,
  code?: string
) {
  email = normalizeEmail(email);
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  const created = await db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: users.id })
      .from(users)
      .where(emailMatches(email))
      .limit(1);

    if (existing.length > 0) {
      throw new ConflictError('このメールアドレスはすでに登録されています');
    }

    const role = await decideNewUserRoleTx(tx, code, email);

    const [user] = await tx
      .insert(users)
      .values({
        email,
        passwordHash,
        displayName: displayName || null,
        role,
        researchSettings: NEW_USER_RESEARCH_SETTINGS,
        inviteVerified: true,
        inviteVerifiedAt: new Date(),
      })
      .returning();

    if (role === 'user' && code) {
      await consumeInviteCodeTx(tx, user.id, code);
    }

    return user;
  });
  if (created.role === 'admin') clearInitialSetupCode();
  return created;
}

export async function verifyPassword(user: { passwordHash: string | null }, password: string): Promise<boolean> {
  if (!user.passwordHash) return false;
  return bcrypt.compare(password, user.passwordHash);
}

export async function login(email: string, password: string) {
  const candidates = await findUsersByEmail(email);
  let user: (typeof candidates)[number] | undefined;
  for (const c of candidates) {
    if (c.passwordHash && (await bcrypt.compare(password, c.passwordHash))) {
      user = c;
      break;
    }
  }

  if (!user || !user.passwordHash) {
    throw new UnauthorizedError('メールアドレスまたはパスワードが正しくありません');
  }

  try {
    if (bcrypt.getRounds(user.passwordHash) < BCRYPT_ROUNDS) {
      const upgraded = await bcrypt.hash(password, BCRYPT_ROUNDS);
      await db.update(users).set({ passwordHash: upgraded }).where(eq(users.id, user.id));
    }
  } catch {
  }

  return user;
}

export async function getUserById(id: number) {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  return user || null;
}

export async function requestPasswordReset(email: string): Promise<void> {
  const [user] = await findUsersByEmail(email, 1);

  if (!user) return;

  const resetToken = crypto.randomBytes(32).toString('hex');
  const resetTokenExpiry = new Date(Date.now() + 60 * 60 * 1000);

  await db
    .update(users)
    .set({ resetToken: null, resetTokenHash: sha256(resetToken), resetTokenExpiry })
    .where(eq(users.id, user.id));

  await sendPasswordResetEmail(user.email, resetToken);
}

export async function resetPassword(token: string, newPassword: string): Promise<number> {
  const tokenHash = sha256(token);
  let [user] = await db
    .select()
    .from(users)
    .where(eq(users.resetTokenHash, tokenHash))
    .limit(1);

  if (!user) {
    [user] = await db
      .select()
      .from(users)
      .where(eq(users.resetToken, token))
      .limit(1);
  }

  if (!user) {
    throw new BadRequestError('無効なリセットトークンです');
  }

  if (!user.resetTokenExpiry || user.resetTokenExpiry < new Date()) {
    throw new BadRequestError('リセットトークンの有効期限が切れています');
  }

  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

  await db
    .update(users)
    .set({
      passwordHash,
      resetToken: null,
      resetTokenHash: null,
      resetTokenExpiry: null,
      emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
      updatedAt: new Date(),
    })
    .where(eq(users.id, user.id));

  await invalidateAllUserAccess(user.id, 'password.reset');
  return user.id;
}

export async function changePassword(
  userId: number,
  currentPassword: string,
  newPassword: string
): Promise<void> {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) {
    throw new NotFoundError('ユーザーが見つかりません');
  }

  if (!user.passwordHash) {
    throw new BadRequestError('Googleアカウントでログインしているため、パスワード変更はできません');
  }

  const valid = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!valid) {
    throw new UnauthorizedError('現在のパスワードが正しくありません');
  }

  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

  await db
    .update(users)
    .set({ passwordHash, updatedAt: new Date() })
    .where(eq(users.id, userId));

  await invalidateAllUserAccess(userId, 'password.change');
}

export function isGoogleEmailVerified(payload: { email_verified?: boolean | string } | null | undefined): boolean {
  const v = payload?.email_verified;
  return v === true || v === 'true';
}

export async function findExistingByGoogle(
  googleId: string,
  email: string,
): Promise<typeof users.$inferSelect | null> {
  const [byGoogleId] = await db
    .select()
    .from(users)
    .where(eq(users.googleId, googleId))
    .limit(1);

  if (byGoogleId) {
    if (!byGoogleId.emailVerifiedAt && normalizeEmail(byGoogleId.email) === normalizeEmail(email)) {
      const now = new Date();
      await db.update(users).set({ emailVerifiedAt: now }).where(eq(users.id, byGoogleId.id));
      return { ...byGoogleId, emailVerifiedAt: now };
    }
    return byGoogleId;
  }

  const candidates = await findUsersByEmail(email);
  if (candidates.length === 0) return null;

  if (candidates.length > 1) throw new GoogleLinkNotAllowedError();

  const [byEmail] = candidates;

  if (byEmail.googleId && byEmail.googleId !== googleId) throw new GoogleAccountMismatchError();

  if (!byEmail.emailVerifiedAt) throw new GoogleLinkNotAllowedError();

  const updated = await db
    .update(users)
    .set({ googleId, updatedAt: new Date() })
    .where(sql`${users.id} = ${byEmail.id} and ${users.googleId} is null`)
    .returning({ id: users.id });
  if (updated.length === 0) throw new GoogleAccountMismatchError();

  await audit('google.link', { actor: { id: byEmail.id, email: byEmail.email, authMethod: 'google' }, target: { type: 'user', id: byEmail.id }, detail: { hadPassword: !!byEmail.passwordHash } });
  return { ...byEmail, googleId };
}

export async function findOrCreateByGoogle(
  googleId: string,
  email: string,
  displayName?: string | null,
  code?: string,
): Promise<{ user: typeof users.$inferSelect; created: boolean }> {
  const existing = await findExistingByGoogle(googleId, email);
  if (existing) return { user: existing, created: false };

  email = normalizeEmail(email);

  const newUser = await db.transaction(async (tx) => {
    const role = await decideNewUserRoleTx(tx, code, email);
    const [created] = await tx
      .insert(users)
      .values({
        email,
        passwordHash: null,
        displayName: displayName || null,
        googleId,
        role,
        emailVerifiedAt: new Date(),
        researchSettings: NEW_USER_RESEARCH_SETTINGS,
        inviteVerified: true,
        inviteVerifiedAt: new Date(),
      })
      .returning();
    if (role === 'user' && code) await consumeInviteCodeTx(tx, created.id, code);
    return created;
  });
  if (newUser.role === 'admin') clearInitialSetupCode();

  return { user: newUser, created: true };
}

export async function adminResetPassword(userId: number): Promise<string> {
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new NotFoundError('ユーザーが見つかりません');
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(12);
  const temporary = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
  const passwordHash = await bcrypt.hash(temporary, BCRYPT_ROUNDS);
  await db
    .update(users)
    .set({ passwordHash, resetToken: null, resetTokenHash: null, resetTokenExpiry: null, updatedAt: new Date() })
    .where(eq(users.id, userId));
  await invalidateAllUserAccess(userId, 'admin.password_reset');
  return temporary;
}
