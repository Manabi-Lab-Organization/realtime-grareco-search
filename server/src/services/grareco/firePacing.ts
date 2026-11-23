import type { AutoGrarecoSettings } from './types.js';

export const BASE_MIN_AUTO_INTERVAL_MS = 5 * 60 * 1000;

const ONE_HOUR_MS = 60 * 60 * 1000;

type PacingSettings = Pick<AutoGrarecoSettings, 'autoPromoteMode' | 'maxImagesPerHour'>;

export function minAutoFireIntervalMs(settings: PacingSettings): number {
  if (settings.autoPromoteMode !== 'auto') return BASE_MIN_AUTO_INTERVAL_MS;
  const raw = Number(settings.maxImagesPerHour);
  if (!Number.isFinite(raw) || raw < 1) return BASE_MIN_AUTO_INTERVAL_MS;
  return Math.max(BASE_MIN_AUTO_INTERVAL_MS, Math.ceil(ONE_HOUR_MS / Math.floor(raw)));
}

export function isInFireCooldown(lastAutoFireAt: number, now: number, settings: PacingSettings): boolean {
  if (!lastAutoFireAt) return false;
  return now - lastAutoFireAt < minAutoFireIntervalMs(settings);
}
