
const MIN_MS = 60 * 1000;

function minutesEnv(name: string, fallback: number, allowZero = false): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  if (n === 0) return allowZero ? 0 : fallback;
  return n;
}

export function webSessionIdleMs(): number {
  return minutesEnv('WEB_SESSION_IDLE_MINUTES', 60) * MIN_MS;
}

export function webSessionAbsoluteMs(): number {
  return minutesEnv('WEB_SESSION_ABSOLUTE_MINUTES', 720, true) * MIN_MS;
}

export function adminIdleMs(): number {
  return minutesEnv('ADMIN_SESSION_IDLE_MINUTES', 15) * MIN_MS;
}

export function sudoWindowMs(): number {
  return minutesEnv('SUDO_WINDOW_MINUTES', 10) * MIN_MS;
}

export function sessionRefreshIntervalMs(): number {
  return Math.min(60 * MIN_MS, Math.max(MIN_MS, Math.floor(webSessionIdleMs() / 4)));
}
