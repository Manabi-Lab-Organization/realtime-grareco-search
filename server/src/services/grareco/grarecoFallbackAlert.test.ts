import { describe, it, expect, afterEach } from 'vitest';
import {
  classifyFallbackReason,
  notifyGrarecoFallback,
  resetFallbackAlertState,
  buildFallbackAlertMail,
  ALERT_INTERVAL_MS,
  type FallbackAlertMail,
} from './grarecoFallbackAlert.js';

const QUOTA =
  'OpenAI HTTP 429: {"message":"Sample message: the account balance is empty. See https://example.com/billing for details.","type":"insufficient_quota","param":null,"code":"credit_balance_exhausted"}';

afterEach(() => {
  resetFallbackAlertState();
  delete process.env.OPS_EMAIL;
});

describe('classifyFallbackReason', () => {
  it('残高不足を示す 429 は openai_quota に分類する', () => {
    expect(classifyFallbackReason(QUOTA)).toBe('openai_quota');
  });
  it('キーの拒否は openai_auth、キーが無いときは openai_key_missing に分類する', () => {
    expect(classifyFallbackReason('OpenAI HTTP 401: {"code":"invalid_api_key"}')).toBe('openai_auth');
    expect(classifyFallbackReason('OPENAI_API_KEY が設定されていません')).toBe('openai_key_missing');
  });
  it('一時的な失敗やそれ以外の理由は分類しない', () => {
    expect(classifyFallbackReason('OpenAI HTTP 429: {"code":"rate_limit_exceeded"}')).toBeNull();
    expect(classifyFallbackReason('OpenAI HTTP 500: {}')).toBeNull();
    expect(classifyFallbackReason('画像の生成が途中で止まりました（サンプルの理由）')).toBeNull();
    expect(classifyFallbackReason('見出しを読み取れませんでした')).toBeNull();
  });
});

describe('notifyGrarecoFallback', () => {
  it('通知先に 1 通送り、間隔をあけるまで同じ種類は送らない', async () => {
    process.env.OPS_EMAIL = 'ops@example.com';
    const sent: FallbackAlertMail[] = [];
    const sendMail = async (m: FallbackAlertMail) => { sent.push(m); };
    const t0 = new Date('2001-04-01T09:00:00Z');
    expect(await notifyGrarecoFallback(QUOTA, { now: t0, sendMail })).toBe(true);
    expect(await notifyGrarecoFallback(QUOTA, { now: new Date(t0.getTime() + 60_000), sendMail })).toBe(false);
    expect(await notifyGrarecoFallback(QUOTA, { now: new Date(t0.getTime() + ALERT_INTERVAL_MS), sendMail })).toBe(true);
    expect(sent).toHaveLength(2);
    expect(sent[0].to).toBe('ops@example.com');
    expect(sent[0].subject).toContain('残高切れ');
  });
  it('通知先が無ければ送らない', async () => {
    delete process.env.OPS_EMAIL;
    const sent: FallbackAlertMail[] = [];
    expect(await notifyGrarecoFallback(QUOTA, { sendMail: async (m) => { sent.push(m); } })).toBe(false);
    expect(sent).toHaveLength(0);
  });
  it('分類できない失敗では送らない', async () => {
    const sent: FallbackAlertMail[] = [];
    expect(await notifyGrarecoFallback('OpenAI HTTP 503: {}', { sendMail: async (m) => { sent.push(m); } })).toBe(false);
    expect(sent).toHaveLength(0);
  });
  it('送信に失敗しても例外を投げずに false を返す', async () => {
    await expect(
      notifyGrarecoFallback(QUOTA, { sendMail: async () => { throw new Error('mail service down'); } }),
    ).resolves.toBe(false);
  });
});

describe('buildFallbackAlertMail', () => {
  it('理由を 200 文字までに切り、HTML の特殊文字をエスケープする', () => {
    const m = buildFallbackAlertMail('openai_quota', `<b>${'x'.repeat(300)}`, new Date(), 'a@example.com');
    expect(m.text).not.toContain('x'.repeat(201));
    expect(m.html).toContain('&lt;b&gt;');
    expect(m.html).not.toContain('<b>');
  });
});
