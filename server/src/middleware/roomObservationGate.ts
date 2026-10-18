
export const ROOM_OBSERVATION_CONSENT_VERSION = 3;

export function roomObservationEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.ROOM_OBSERVATION_ENABLED === 'true';
}

export function hasCurrentRoomObservationConsent(
  storedVersion: number | null | undefined,
  requiredVersion: number = ROOM_OBSERVATION_CONSENT_VERSION,
): boolean {
  return typeof storedVersion === 'number' && storedVersion >= requiredVersion;
}

export function roomObservationConsentEnforced(_env: Record<string, string | undefined> = process.env): boolean {
  return true;
}
