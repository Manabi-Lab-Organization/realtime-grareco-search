import { describe, it, expect } from 'vitest';
import { aiRateLimitKey } from '../rateLimit.js';

describe('aiRateLimitKey', () => {
  it('ログイン中は利用者 ID を鍵にする', () => {
    expect(aiRateLimitKey({ session: { userId: 42 }, ip: '203.0.113.5' })).toBe('u:42');
  });

  it('同じ /64 に属する IPv6 アドレスは同じ鍵になる', () => {
    const a = aiRateLimitKey({ ip: '2001:db8:abcd:1234:0000:0000:0000:0001' });
    const b = aiRateLimitKey({ ip: '2001:db8:abcd:1234:ffff:ffff:ffff:ffff' });
    expect(a).toBe(b);
  });

  it('/64 が異なる IPv6 アドレスは別の鍵になる', () => {
    const a = aiRateLimitKey({ ip: '2001:db8:abcd:1234::1' });
    const b = aiRateLimitKey({ ip: '2001:db8:abcd:5678::1' });
    expect(a).not.toBe(b);
  });

  it('IPv4 アドレスはそのまま鍵にする', () => {
    expect(aiRateLimitKey({ ip: '203.0.113.5' })).toBe('ip:203.0.113.5');
    expect(aiRateLimitKey({ ip: '203.0.113.6' })).toBe('ip:203.0.113.6');
  });

  it('IP が無いときは共通の鍵を返す', () => {
    expect(aiRateLimitKey({})).toBe('ip:unknown');
  });

  it('利用者 ID が 0 または無いときは IP を鍵にする', () => {
    expect(aiRateLimitKey({ session: { userId: 0 }, ip: '203.0.113.5' })).toBe('ip:203.0.113.5');
    expect(aiRateLimitKey({ session: {}, ip: '203.0.113.5' })).toBe('ip:203.0.113.5');
  });
});
