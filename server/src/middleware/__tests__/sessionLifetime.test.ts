import { describe, it, expect, afterEach } from 'vitest';
import {
  compareVersions,
  parseVersion,
  readClientInfo,
  requiredMinVersion,
  isLegacyQueryTokenAllowed,
  shouldAuditLegacyQuery,
} from '../clientVersion.js';
import { isTokenExpired, shouldTouch, normalizeDeviceName, normalizeClientType } from '../../services/apiTokenService.js';
import { sessionInvalidReason } from '../sessionPolicy.js';
import { isWithinSudoWindow } from '../recentAuth.js';
import { webSessionIdleMs, webSessionAbsoluteMs, adminIdleMs, sudoWindowMs } from '../../config/sessionLifetime.js';

const DAY = 24 * 60 * 60 * 1000;
const env = { ...process.env };
afterEach(() => { process.env = { ...env }; });

describe('アプリの最低バージョン', () => {
  it('バージョンの文字列を読み取って大小を比べる', () => {
    expect(parseVersion('v1.2.3-beta')).toEqual([1, 2, 3]);
    expect(compareVersions('1.9.0', '1.10.0')).toBeLessThan(0);
    expect(compareVersions('2.0', '1.99.99')).toBeGreaterThan(0);
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });

  it('末尾に付いた -dev などの印は無視して比べる', () => {
    process.env.MIN_DESKTOP_VERSION = '2.4.6';
    expect(parseVersion('2.4.6-dev')).toEqual([2, 4, 6]);
    expect(requiredMinVersion({ platform: 'desktop', version: '2.4.6-dev' }, true)).toBeNull();
    expect(requiredMinVersion({ platform: 'desktop', version: '2.4.7-beta.2' }, true)).toBeNull();
    expect(requiredMinVersion({ platform: 'desktop', version: '2.4.5-dev' }, true)).toBe('2.4.6');
    process.env.MIN_DESKTOP_VERSION = '2.4.6-rc.1';
    expect(requiredMinVersion({ platform: 'desktop', version: '2.4.6' }, true)).toBeNull();
  });

  it('最低バージョンの設定が無ければ null を返す', () => {
    delete process.env.MIN_DESKTOP_VERSION;
    delete process.env.MIN_MOBILE_VERSION;
    expect(requiredMinVersion({ platform: 'desktop', version: '0.0.1' }, true)).toBeNull();
  });

  it('最低バージョンより古ければその値を返し、満たしていれば null を返す', () => {
    process.env.MIN_DESKTOP_VERSION = '1.8.0';
    expect(requiredMinVersion({ platform: 'desktop', version: '1.7.9' }, true)).toBe('1.8.0');
    expect(requiredMinVersion({ platform: 'desktop', version: '1.8.0' }, true)).toBeNull();
    expect(requiredMinVersion({ platform: 'mobile', version: '0.1.0' }, true)).toBeNull();
  });

  it('バージョンの分からないアプリでも、最低バージョンの設定があればその値を返す', () => {
    process.env.MIN_DESKTOP_VERSION = '1.8.0';
    delete process.env.MIN_MOBILE_VERSION;
    expect(requiredMinVersion({ platform: null, version: null }, true)).toBe('1.8.0');
  });

  it('アプリでない要求には null を返す', () => {
    process.env.MIN_DESKTOP_VERSION = '9.9.9';
    process.env.MIN_MOBILE_VERSION = '9.9.9';
    expect(requiredMinVersion({ platform: null, version: null }, false)).toBeNull();
  });

  it('ヘッダ・クエリ・ユーザーエージェントから種類とバージョンを読む', () => {
    expect(readClientInfo({ 'x-client-version': '1.2.3', 'x-client-platform': 'Desktop' })).toEqual({ platform: 'desktop', version: '1.2.3' });
    expect(readClientInfo({}, { version: '2.0.0', platform: 'mobile' })).toEqual({ platform: 'mobile', version: '2.0.0' });
    expect(readClientInfo({ 'user-agent': 'Mozilla/5.0 SampleApp Electron/33.2.1' }).platform).toBe('desktop');
  });
});

describe('URL に載せたトークン', () => {
  it('設定が "true" のときだけ許可する', () => {
    delete process.env.ALLOW_LEGACY_QUERY_TOKEN;
    expect(isLegacyQueryTokenAllowed()).toBe(false);
    process.env.ALLOW_LEGACY_QUERY_TOKEN = 'false';
    expect(isLegacyQueryTokenAllowed()).toBe(false);
    process.env.ALLOW_LEGACY_QUERY_TOKEN = 'true';
    expect(isLegacyQueryTokenAllowed()).toBe(true);
  });

  it('同じトークンの記録は 1 分に 1 回までにする', () => {
    const t0 = 1_000_000;
    expect(shouldAuditLegacyQuery('tok-a', t0)).toBe(true);
    expect(shouldAuditLegacyQuery('tok-a', t0 + 30_000)).toBe(false);
    expect(shouldAuditLegacyQuery('tok-b', t0 + 30_000)).toBe(true);
    expect(shouldAuditLegacyQuery('tok-a', t0 + 60_000)).toBe(true);
  });
});

describe('トークンの有効期限', () => {
  it('既定では 30 日使われなければ無効になる', () => {
    delete process.env.TOKEN_IDLE_DAYS;
    const now = Date.now();
    expect(isTokenExpired(new Date(now - 29 * DAY), now)).toBe(false);
    expect(isTokenExpired(new Date(now - 31 * DAY), now)).toBe(true);
  });

  it('既定では発行から 90 日で無効になり、0 を設定すると期限が無くなる', () => {
    delete process.env.TOKEN_ABSOLUTE_DAYS;
    const now = Date.now();
    expect(isTokenExpired(new Date(now - DAY), now, undefined, new Date(now - 89 * DAY))).toBe(false);
    expect(isTokenExpired(new Date(now - DAY), now, undefined, new Date(now - 91 * DAY))).toBe(true);
    process.env.TOKEN_ABSOLUTE_DAYS = '0';
    expect(isTokenExpired(new Date(now - DAY), now, undefined, new Date(now - 900 * DAY))).toBe(false);
  });

  it('使われない期間の上限を環境変数で変えられる', () => {
    process.env.TOKEN_IDLE_DAYS = '180';
    const now = Date.now();
    expect(isTokenExpired(new Date(now - 100 * DAY), now)).toBe(false);
  });

  it('最終利用時刻の更新は 1 時間に 1 回までにする', () => {
    const now = Date.now();
    expect(shouldTouch(new Date(now - 59 * 60 * 1000), now)).toBe(false);
    expect(shouldTouch(new Date(now - 60 * 60 * 1000), now)).toBe(true);
  });

  it('端末の名前と種類を整える', () => {
    expect(normalizeDeviceName('  会議室のノートPC\n ')).toBe('会議室のノートPC');
    expect(normalizeDeviceName('x'.repeat(300))?.length).toBe(100);
    expect(normalizeDeviceName('')).toBeNull();
    expect(normalizeClientType('mobile')).toBe('mobile');
    expect(normalizeClientType('admin')).toBeNull();
  });
});

describe('セッションと再認証の期間', () => {
  it('既定の期間は無操作 1 時間・最長 12 時間・管理画面 15 分・再認証 10 分', () => {
    for (const k of ['WEB_SESSION_IDLE_MINUTES', 'WEB_SESSION_ABSOLUTE_MINUTES', 'ADMIN_SESSION_IDLE_MINUTES', 'SUDO_WINDOW_MINUTES']) delete process.env[k];
    expect(webSessionIdleMs()).toBe(60 * 60 * 1000);
    expect(webSessionAbsoluteMs()).toBe(12 * 60 * 60 * 1000);
    expect(adminIdleMs()).toBe(15 * 60 * 1000);
    expect(sudoWindowMs()).toBe(10 * 60 * 1000);
  });

  it('最長期間を過ぎたセッションとトークンが無効になったセッションを無効と判定する', () => {
    const now = Date.now();
    const abs = 12 * 60 * 60 * 1000;
    expect(sessionInvalidReason({ userId: 1, issuedAt: now - abs - 1 }, now, { absoluteMs: abs, tokenActive: null })).toBe('absolute_expired');
    expect(sessionInvalidReason({ userId: 1, issuedAt: now - 1000 }, now, { absoluteMs: abs, tokenActive: null })).toBeNull();
    expect(sessionInvalidReason({ userId: 1, issuedAt: now, apiTokenId: 3 }, now, { absoluteMs: abs, tokenActive: false })).toBe('token_revoked');
    expect(sessionInvalidReason({ userId: 1, issuedAt: now, apiTokenId: 3 }, now, { absoluteMs: abs, tokenActive: true })).toBeNull();
    expect(sessionInvalidReason({ userId: 1, issuedAt: now - 10 * abs }, now, { absoluteMs: 0, tokenActive: null })).toBeNull();
  });

  it('再認証から 10 分以内かどうかを判定する', () => {
    const now = Date.now();
    expect(isWithinSudoWindow(now - 9 * 60 * 1000, now)).toBe(true);
    expect(isWithinSudoWindow(now - 11 * 60 * 1000, now)).toBe(false);
    expect(isWithinSudoWindow(undefined, now)).toBe(false);
  });
});
