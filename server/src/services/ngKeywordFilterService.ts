
export function parseNgKeywords(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const k of raw) {
    if (typeof k !== 'string') continue;
    const normalized = k.normalize('NFKC').toLowerCase().trim();
    if (!normalized) continue;
    seen.add(normalized);
  }
  return Array.from(seen);
}

export function isNgContent(content: string, keywords: string[]): boolean {
  if (keywords.length === 0) return false;
  const normalized = content.normalize('NFKC').toLowerCase();
  return keywords.some((k) => normalized.includes(k));
}

export function filterNgTranscripts<T extends { content: string }>(
  rows: T[],
  keywords: string[]
): T[] {
  if (keywords.length === 0) return rows;
  return rows.filter((row) => !isNgContent(row.content, keywords));
}
