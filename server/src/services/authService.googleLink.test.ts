import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  selectQueue: [] as any[][],
  updates: [] as any[],
  inserts: [] as any[],
  updateReturning: [{ id: 1 }] as any[],
}));

vi.mock('../db/index.js', () => {
  const makeSelect = () => {
    const chain: any = {
      from: () => chain,
      where: () => chain,
      orderBy: () => chain,
      for: () => chain,
      limit: () => Promise.resolve(h.selectQueue.shift() ?? []),
    };
    return chain;
  };
  const update = () => ({
    set: (values: any) => ({
      where: () => {
        h.updates.push(values);
        const p: any = Promise.resolve();
        p.returning = () => Promise.resolve(h.updateReturning);
        return p;
      },
    }),
  });
  const insert = () => ({
    values: (values: any) => {
      h.inserts.push(values);
      return {
        returning: () => Promise.resolve([{ id: 100, ...values }]),
        onConflictDoNothing: () => {
          const p: any = Promise.resolve();
          p.returning = () => Promise.resolve([{ id: 1 }]);
          return p;
        },
      };
    },
  });
  const db: any = { select: makeSelect, update, insert, execute: async () => {} };
  db.transaction = async (cb: any) => cb(db);
  return { db, pool: {} };
});

vi.mock('./emailService.js', () => ({ sendPasswordResetEmail: vi.fn(async () => {}) }));
vi.mock('./authSessionService.js', () => ({ invalidateAllUserAccess: vi.fn(async () => {}) }));

import {
  findExistingByGoogle,
  findOrCreateByGoogle,
  isGoogleEmailVerified,
  register,
  GoogleLinkNotAllowedError,
  GoogleAccountMismatchError,
  InviteRequiredError,
  SETUP_CODE_REQUIRED_MESSAGE,
} from './authService.js';
import { clearInitialSetupCode, hasInitialSetupCode, issueInitialSetupCode } from './initialSetupCode.js';

function user(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    email: 'yamada@example.com',
    passwordHash: '$2a$12$dummyhashvalue',
    googleId: null,
    emailVerifiedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  h.selectQueue = [];
  h.updates = [];
  h.inserts = [];
  h.updateReturning = [{ id: 1 }];
  clearInitialSetupCode();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('isGoogleEmailVerified', () => {
  it('確認済みの印が true または "true" のときだけ true を返す', () => {
    expect(isGoogleEmailVerified({ email_verified: true })).toBe(true);
    expect(isGoogleEmailVerified({ email_verified: 'true' })).toBe(true);
    expect(isGoogleEmailVerified({ email_verified: false })).toBe(false);
    expect(isGoogleEmailVerified({ email_verified: 'false' })).toBe(false);
    expect(isGoogleEmailVerified({})).toBe(false);
    expect(isGoogleEmailVerified(null)).toBe(false);
  });
});

describe('findExistingByGoogle', () => {
  it('メールアドレスが未確認のアカウントには結びつけない', async () => {
    h.selectQueue.push([]);
    h.selectQueue.push([user()]);
    await expect(findExistingByGoogle('google-sub-yamada', 'yamada@example.com')).rejects.toBeInstanceOf(
      GoogleLinkNotAllowedError,
    );
    expect(h.updates).toHaveLength(0);
  });

  it('メールアドレスが確認済みのアカウントには結びつける', async () => {
    h.selectQueue.push([]);
    h.selectQueue.push([user({ emailVerifiedAt: new Date('2001-01-01') })]);
    const result = await findExistingByGoogle('google-sub-yamada', 'Yamada@Example.com');
    expect(result?.id).toBe(1);
    expect(result?.googleId).toBe('google-sub-yamada');
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0].googleId).toBe('google-sub-yamada');
  });

  it('別の Google アカウントと結びついたアカウントは書き換えない', async () => {
    h.selectQueue.push([]);
    h.selectQueue.push([user({ googleId: 'google-sub-other', emailVerifiedAt: new Date() })]);
    await expect(findExistingByGoogle('google-sub-yamada', 'yamada@example.com')).rejects.toBeInstanceOf(
      GoogleAccountMismatchError,
    );
    expect(h.updates).toHaveLength(0);
  });

  it('更新の時点で別のアカウントと結びついていたら書き換えない', async () => {
    h.selectQueue.push([]);
    h.selectQueue.push([user({ emailVerifiedAt: new Date() })]);
    h.updateReturning = [];
    await expect(findExistingByGoogle('google-sub-yamada', 'yamada@example.com')).rejects.toBeInstanceOf(
      GoogleAccountMismatchError,
    );
  });

  it('大文字と小文字だけが違う複数のアカウントがあれば結びつけない', async () => {
    h.selectQueue.push([]);
    h.selectQueue.push([
      user({ emailVerifiedAt: new Date() }),
      user({ id: 2, email: 'Yamada@example.com', emailVerifiedAt: new Date() }),
    ]);
    await expect(findExistingByGoogle('google-sub-yamada', 'yamada@example.com')).rejects.toBeInstanceOf(
      GoogleLinkNotAllowedError,
    );
    expect(h.updates).toHaveLength(0);
  });

  it('Google の ID で見つかればそれを返し、未確認なら確認済みにする', async () => {
    h.selectQueue.push([user({ googleId: 'google-sub-yamada' })]);
    const result = await findExistingByGoogle('google-sub-yamada', 'yamada@example.com');
    expect(result?.id).toBe(1);
    expect(result?.emailVerifiedAt).toBeInstanceOf(Date);
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]).toHaveProperty('emailVerifiedAt');
    expect(h.updates[0]).not.toHaveProperty('googleId');
  });

  it('どちらでも見つからなければ null を返す', async () => {
    h.selectQueue.push([]);
    h.selectQueue.push([]);
    expect(await findExistingByGoogle('google-sub-new', 'new@example.com')).toBeNull();
  });
});

describe('findOrCreateByGoogle', () => {
  it('新しく作るときはメールアドレスを小文字にし、確認済みにする', async () => {
    h.selectQueue.push([]);
    h.selectQueue.push([]);
    h.selectQueue.push([{ count: 0 }]);
    const setup = issueInitialSetupCode();
    const { user: created, created: isNew } = await findOrCreateByGoogle('google-sub-new', 'Sato.Hanako@Example.com', '佐藤', setup);
    expect(isNew).toBe(true);
    expect(created.email).toBe('sato.hanako@example.com');
    const userInsert = h.inserts.find((v) => 'googleId' in v);
    expect(userInsert.emailVerifiedAt).toBeInstanceOf(Date);
  });

  it('未確認のアカウントがあれば新しく作らずにエラーにする', async () => {
    h.selectQueue.push([]);
    h.selectQueue.push([user()]);
    await expect(findOrCreateByGoogle('google-sub-yamada', 'yamada@example.com')).rejects.toBeInstanceOf(
      GoogleLinkNotAllowedError,
    );
    expect(h.inserts).toHaveLength(0);
  });

  it('最初の管理者を Google で作るときも、初期設定コードが無ければ断る', async () => {
    h.selectQueue.push([]);
    h.selectQueue.push([]);
    h.selectQueue.push([{ count: 0 }]);
    await expect(findOrCreateByGoogle('google-sub-new', 'owner@example.com', null)).rejects.toThrow(SETUP_CODE_REQUIRED_MESSAGE);
    expect(h.inserts).toHaveLength(0);
  });
});

describe('register', () => {
  it('メールアドレスを小文字で保存し、確認済みにはしない', async () => {
    h.selectQueue.push([]);
    h.selectQueue.push([{ count: 0 }]);
    const created = await register('Suzuki.Ichiro@Example.com', 'password123', undefined, issueInitialSetupCode());
    expect(created.email).toBe('suzuki.ichiro@example.com');
    const userInsert = h.inserts.find((v) => 'passwordHash' in v);
    expect(userInsert.emailVerifiedAt).toBeUndefined();
  });

  it('最初の 1 人を管理者にする', async () => {
    h.selectQueue.push([]);
    h.selectQueue.push([{ count: 0 }]);
    await register('first@example.com', 'password123', undefined, issueInitialSetupCode());
    expect(h.inserts.find((v) => 'passwordHash' in v).role).toBe('admin');
  });

  it('最初の 1 人は、初期設定コードが無いか違っていると登録できない', async () => {
    h.selectQueue.push([]);
    h.selectQueue.push([{ count: 0 }]);
    await expect(register('first@example.com', 'password123', undefined)).rejects.toThrow(SETUP_CODE_REQUIRED_MESSAGE);
    expect(hasInitialSetupCode()).toBe(true);
    h.selectQueue.push([]);
    h.selectQueue.push([{ count: 0 }]);
    await expect(register('first@example.com', 'password123', undefined, 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF')).rejects.toThrow(SETUP_CODE_REQUIRED_MESSAGE);
    expect(h.inserts).toHaveLength(0);
  });

  it('初期設定コードは小文字や空白が混ざっても通り、使ったあとは無効になる', async () => {
    const setup = issueInitialSetupCode();
    h.selectQueue.push([]);
    h.selectQueue.push([{ count: 0 }]);
    await register('first@example.com', 'password123', undefined, ` ${setup.toLowerCase()} `);
    expect(h.inserts.find((v) => 'passwordHash' in v).role).toBe('admin');
    expect(hasInitialSetupCode()).toBe(false);
  });

  it('最初の管理者のアドレスが設定されていれば、最初の 1 人はそのアドレスだけ登録できる', async () => {
    process.env.INITIAL_ADMIN_EMAIL = 'Owner@Example.com';
    try {
      h.selectQueue.push([]);
      h.selectQueue.push([{ count: 0 }]);
      await expect(register('someone@example.com', 'password123', undefined)).rejects.toThrow('INITIAL_ADMIN_EMAIL');
      expect(h.inserts).toHaveLength(0);
      h.selectQueue.push([]);
      h.selectQueue.push([{ count: 0 }]);
      await register('owner@example.com', 'password123', undefined, issueInitialSetupCode());
      expect(h.inserts.find((v) => 'passwordHash' in v).role).toBe('admin');
    } finally {
      delete process.env.INITIAL_ADMIN_EMAIL;
    }
  });

  it('2 人目からは招待コードが無いと登録できない', async () => {
    h.selectQueue.push([]);
    h.selectQueue.push([{ count: 1 }]);
    await expect(register('second@example.com', 'password123', undefined)).rejects.toBeInstanceOf(InviteRequiredError);
    expect(h.inserts).toHaveLength(0);
  });

  it('招待コードがあれば一般の利用者として作り、コードの使用を記録する', async () => {
    h.selectQueue.push([]);
    h.selectQueue.push([{ count: 1 }]);
    h.selectQueue.push([{ maxUses: null, usedCount: 0, expiresAt: null, isActive: true }]);
    await register('second@example.com', 'password123', undefined, 'sample-code');
    expect(h.inserts.find((v) => 'passwordHash' in v).role).toBe('user');
    expect(h.inserts.find((v) => 'code' in v)).toMatchObject({ code: 'SAMPLE-CODE' });
  });

  it('大文字と小文字だけが違うアカウントがあれば登録済みとしてエラーにする', async () => {
    h.selectQueue.push([{ id: 1 }]);
    await expect(register('YAMADA@example.com', 'password123', undefined)).rejects.toThrow(
      'このメールアドレスはすでに登録されています',
    );
  });
});
