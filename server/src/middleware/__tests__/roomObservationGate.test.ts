
import { describe, it, expect } from 'vitest';
import {
  ROOM_OBSERVATION_CONSENT_VERSION,
  roomObservationEnabled,
  hasCurrentRoomObservationConsent,
  roomObservationConsentEnforced,
} from '../roomObservationGate.js';

describe('roomObservationEnabled', () => {
  it('true 以外の値や値が無いときは false を返す', () => {
    expect(roomObservationEnabled({})).toBe(false);
    expect(roomObservationEnabled({ ROOM_OBSERVATION_ENABLED: 'false' })).toBe(false);
    expect(roomObservationEnabled({ ROOM_OBSERVATION_ENABLED: '1' })).toBe(false);
    expect(roomObservationEnabled({ ROOM_OBSERVATION_ENABLED: 'yes' })).toBe(false);
    expect(roomObservationEnabled({ ROOM_OBSERVATION_ENABLED: 'TRUE' })).toBe(false);
  });

  it('"true" のときは true を返す', () => {
    expect(roomObservationEnabled({ ROOM_OBSERVATION_ENABLED: 'true' })).toBe(true);
  });
});

describe('hasCurrentRoomObservationConsent', () => {
  it('同意の記録が無いときは false を返す', () => {
    expect(hasCurrentRoomObservationConsent(null)).toBe(false);
    expect(hasCurrentRoomObservationConsent(undefined)).toBe(false);
  });

  it('現在の版に同意していれば true を返す', () => {
    expect(hasCurrentRoomObservationConsent(ROOM_OBSERVATION_CONSENT_VERSION)).toBe(true);
  });

  it('必要な版より古い同意では false を返す', () => {
    expect(hasCurrentRoomObservationConsent(1, 2)).toBe(false);
    expect(hasCurrentRoomObservationConsent(2, 2)).toBe(true);
    expect(hasCurrentRoomObservationConsent(0)).toBe(false);
  });

  it('説明を残す内容どおりに書き直して版を 3 に上げたので、版 2 までに同意した人にはもう一度同意を求める', () => {
    expect(ROOM_OBSERVATION_CONSENT_VERSION).toBe(3);
    expect(hasCurrentRoomObservationConsent(1)).toBe(false);
    expect(hasCurrentRoomObservationConsent(2)).toBe(false);
    expect(hasCurrentRoomObservationConsent(3)).toBe(true);
  });
});

describe('roomObservationConsentEnforced', () => {
  it('環境変数にかかわらず true を返す', () => {
    expect(roomObservationConsentEnforced({ NODE_ENV: 'production' })).toBe(true);
    expect(roomObservationConsentEnforced({ NODE_ENV: 'development' })).toBe(true);
    expect(roomObservationConsentEnforced({})).toBe(true);
  });
});
