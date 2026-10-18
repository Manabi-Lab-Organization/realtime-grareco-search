
const KEY = 'postLoginNext';
const EXPIRY_MS = 10 * 60 * 1000;

export function isSafeNextPath(raw: string | null | undefined): boolean {
  if (!raw) return false;
  if (!raw.startsWith('/')) return false;
  if (raw.startsWith('//') || raw.includes('://')) return false;
  if (raw === '/login' || raw.startsWith('/login?')) return false;
  if (raw === '/register' || raw.startsWith('/register?')) return false;
  return true;
}

interface Stored {
  path: string;
  at: number;
}

export function rememberNext(path: string, now: number = Date.now()): void {
  if (!isSafeNextPath(path)) return;
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ path, at: now } satisfies Stored));
  } catch {
  }
}

export function takeNext(now: number = Date.now()): string | null {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(KEY);
    if (raw !== null) sessionStorage.removeItem(KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Stored>;
    if (typeof parsed.path !== 'string' || typeof parsed.at !== 'number') return null;
    if (now - parsed.at > EXPIRY_MS) return null;
    return isSafeNextPath(parsed.path) ? parsed.path : null;
  } catch {
    return null;
  }
}

export function resolvePostLoginPath(
  { search, currentPath, stored }: { search: string; currentPath: string; stored: string | null },
): string | null {
  const fromUrl = new URLSearchParams(search).get('next');
  const candidate = isSafeNextPath(fromUrl) ? fromUrl! : (isSafeNextPath(stored) ? stored! : null);
  if (!candidate) return null;
  return candidate === currentPath ? null : candidate;
}
