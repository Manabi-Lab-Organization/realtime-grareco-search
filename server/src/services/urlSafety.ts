
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

export function httpUrlOrNull(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) <= 0x20) return null;
  }
  try {
    const u = new URL(s);
    return ALLOWED_PROTOCOLS.has(u.protocol) ? s : null;
  } catch {
    return null;
  }
}

export function isHttpUrl(raw: unknown): boolean {
  return httpUrlOrNull(raw) !== null;
}
