
export const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

export interface HeartbeatDeps {
  send: () => Promise<unknown>;
  isVisible: () => boolean;
  keepAliveWhenHidden?: () => boolean;
  onVisibilityChange: (fn: () => void) => () => void;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (id: unknown) => void;
  now: () => number;
  intervalMs?: number;
}

export function startSessionHeartbeat(deps: HeartbeatDeps): () => void {
  const interval = deps.intervalMs ?? HEARTBEAT_INTERVAL_MS;
  let lastSentAt = deps.now();
  let inFlight = false;

  const beat = (force = false) => {
    if (inFlight) return;
    if (!deps.isVisible() && !deps.keepAliveWhenHidden?.()) return;
    if (!force && deps.now() - lastSentAt < interval) return;
    inFlight = true;
    lastSentAt = deps.now();
    deps
      .send()
      .catch(() => {})
      .finally(() => {
        inFlight = false;
      });
  };

  const timer = deps.setInterval(() => beat(true), interval);
  const unlisten = deps.onVisibilityChange(() => beat(false));
  return () => {
    deps.clearInterval(timer);
    unlisten();
  };
}

export function browserHeartbeatDeps(keepAliveWhenHidden?: () => boolean): HeartbeatDeps {
  return {
    keepAliveWhenHidden,
    send: () =>
      fetch('/api/auth/heartbeat', { method: 'POST', credentials: 'same-origin', cache: 'no-store' }),
    isVisible: () => document.visibilityState === 'visible',
    onVisibilityChange: (fn) => {
      document.addEventListener('visibilitychange', fn);
      return () => document.removeEventListener('visibilitychange', fn);
    },
    setInterval: (fn, ms) => window.setInterval(fn, ms),
    clearInterval: (id) => window.clearInterval(id as number),
    now: () => Date.now(),
  };
}
