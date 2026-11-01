import { describe, it, expect } from 'vitest';
import { deviceClientTypeFromBody } from '../appTokenRequest.js';

describe('deviceClientTypeFromBody', () => {
  it('端末の種類が desktop か mobile なら、その種類を返す', () => {
    expect(deviceClientTypeFromBody({ deviceName: 'サンプルの端末', clientType: 'desktop' })).toBe('desktop');
    expect(deviceClientTypeFromBody({ clientType: 'mobile', reloginReason: 'session_invalidated' })).toBe('mobile');
  });

  it('スネークケースの client_type も読む', () => {
    expect(deviceClientTypeFromBody({ client_type: 'mobile' })).toBe('mobile');
  });

  it('本文がないときは null を返す', () => {
    expect(deviceClientTypeFromBody(undefined)).toBeNull();
    expect(deviceClientTypeFromBody(null)).toBeNull();
    expect(deviceClientTypeFromBody({})).toBeNull();
  });

  it('api や未知の値、大文字まじりは null を返す', () => {
    for (const clientType of ['api', 'legacy', 'Desktop', 1]) {
      expect(deviceClientTypeFromBody({ clientType })).toBeNull();
    }
  });
});
