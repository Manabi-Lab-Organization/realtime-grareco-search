const ALLOWED = new Set(['http:', 'https:']);

export function safeHref(raw: string | null | undefined): string | undefined {
  const s = String(raw ?? '').trim();
  if (!s) return undefined;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) <= 0x20) return undefined;
  }
  try {
    return ALLOWED.has(new URL(s).protocol) ? s : undefined;
  } catch {
    return undefined;
  }
}
