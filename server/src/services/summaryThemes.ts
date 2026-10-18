
export interface SummaryTheme {
  index: number;
  title: string;
  timeStart: string;
  timeEnd: string;
  bullets: string[];
  hasTimeRange: boolean;
}

export function parseSummaryIntoThemes(markdown: string): SummaryTheme[] {
  const themes: SummaryTheme[] = [];
  const strictHeadingRegex = /^##\s*(\d+)[\.\s]+(.+?)\s*\[(\d{1,3}:\d{2})\s*[-–]\s*(\d{1,3}:\d{2})\]\s*$/;
  const looseHeadingRegex = /^##\s*(\d+)[\.\s]+(.+?)\s*$/;
  const lines = markdown.split('\n');

  let current: SummaryTheme | null = null;

  for (const line of lines) {
    const strictMatch = line.match(strictHeadingRegex);
    if (strictMatch) {
      if (current) themes.push(current);
      current = {
        index: parseInt(strictMatch[1]),
        title: strictMatch[2].trim(),
        timeStart: strictMatch[3],
        timeEnd: strictMatch[4],
        bullets: [],
        hasTimeRange: true,
      };
      continue;
    }
    const looseMatch = line.match(looseHeadingRegex);
    if (looseMatch) {
      if (current) themes.push(current);
      current = {
        index: parseInt(looseMatch[1]),
        title: looseMatch[2].trim(),
        timeStart: '',
        timeEnd: '',
        bullets: [],
        hasTimeRange: false,
      };
      continue;
    }
    if (current) {
      if (isSupplementaryTitle(current.title)) {
        current.bullets.push(line.replace(/\s+$/, ''));
        continue;
      }
      const trimmed = line.trim();
      if (trimmed.length > 0) {
        if (trimmed.startsWith('<!--')) {
          current.bullets.push(trimmed);
        } else {
          current.bullets.push(trimmed.startsWith('・') ? trimmed : `・${trimmed}`);
        }
      }
    }
  }
  if (current) themes.push(current);
  for (const t of themes) {
    if (!isSupplementaryTitle(t.title)) continue;
    while (t.bullets.length > 0 && t.bullets[0] === '') t.bullets.shift();
    while (t.bullets.length > 0 && t.bullets[t.bullets.length - 1] === '') t.bullets.pop();
  }
  return themes;
}

function isSupplementaryTitle(title: string): boolean {
  return title.includes('[補足資料');
}

export function formatThemeHeading(theme: SummaryTheme): string {
  return theme.hasTimeRange
    ? `## ${theme.index}. ${theme.title} [${theme.timeStart}-${theme.timeEnd}]`
    : `## ${theme.index}. ${theme.title}`;
}

export function assembleSummaryMarkdown(themes: SummaryTheme[]): string {
  return themes.map((t) => `${formatThemeHeading(t)}\n${t.bullets.join('\n')}`).join('\n\n');
}

export function renumberThemes(themes: SummaryTheme[]): SummaryTheme[] {
  return themes.map((t, i) => ({ ...t, index: i + 1 }));
}

export function isSupplementaryTheme(theme: SummaryTheme): boolean {
  return theme.title.includes('[補足資料') || theme.bullets.some((b) => b.startsWith('<!-- supplementary:'));
}

function toSeconds(mmss: string): number {
  const [m, s] = mmss.split(':').map(Number);
  return m * 60 + s;
}

export interface ThemeGroup {
  title: string;
  themes: number[];
}

export function applyThemeGroups(themes: SummaryTheme[], groups: ThemeGroup[]): SummaryTheme[] | null {
  const flat = groups.flatMap((g) => g.themes);
  if (flat.length !== themes.length || flat.some((n, i) => n !== i + 1)) return null;

  const merged: SummaryTheme[] = [];
  for (const group of groups) {
    const members = group.themes.map((n) => themes[n - 1]);
    if (members.length === 0) return null;
    if (members.length === 1) {
      merged.push({ ...members[0], bullets: [...members[0].bullets] });
      continue;
    }
    if (members.some(isSupplementaryTheme)) return null;
    const title = cleanGroupTitle(group.title);
    if (!title) return null;
    const timed = members.filter((m) => m.hasTimeRange);
    const first = timed.reduce<SummaryTheme | null>((a, m) => (!a || toSeconds(m.timeStart) < toSeconds(a.timeStart) ? m : a), null);
    const last = timed.reduce<SummaryTheme | null>((a, m) => (!a || toSeconds(m.timeEnd) > toSeconds(a.timeEnd) ? m : a), null);
    merged.push({
      index: 0,
      title,
      timeStart: first?.timeStart ?? '',
      timeEnd: last?.timeEnd ?? '',
      bullets: members.flatMap((m) => m.bullets),
      hasTimeRange: timed.length > 0,
    });
  }
  return renumberThemes(merged);
}

function cleanGroupTitle(title: string): string {
  return String(title ?? '')
    .replace(/^#+\s*/, '')
    .replace(/^\d+[.\s]+/, '')
    .replace(/\s*\[\d{1,3}:\d{2}\s*[-–]\s*\d{1,3}:\d{2}\]\s*$/, '')
    .trim();
}

export function findLostLines(before: string, after: string): string[] {
  const remaining = new Map<string, number>();
  for (const t of parseSummaryIntoThemes(after)) {
    for (const b of t.bullets) remaining.set(b, (remaining.get(b) ?? 0) + 1);
  }
  const lost: string[] = [];
  for (const t of parseSummaryIntoThemes(before)) {
    for (const b of t.bullets) {
      const n = remaining.get(b) ?? 0;
      if (n > 0) remaining.set(b, n - 1);
      else lost.push(b);
    }
  }
  return lost;
}

export const REBUILD_WINDOW_MS = 15 * 60 * 1000;
export const REBUILD_MIN_WINDOW_CHARS = 1500;

export interface TimedLine {
  ms: number;
  text: string;
}

export interface TranscriptWindow {
  startMs: number;
  lines: string[];
}

export function splitTranscriptIntoWindows(
  lines: TimedLine[],
  windowMs = REBUILD_WINDOW_MS,
  minChars = REBUILD_MIN_WINDOW_CHARS,
): TranscriptWindow[] {
  const buckets = new Map<number, string[]>();
  for (const l of lines) {
    const key = Math.floor(Math.max(0, l.ms) / windowMs);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(l.text);
    else buckets.set(key, [l.text]);
  }
  const keys = [...buckets.keys()].sort((a, b) => a - b);

  const windows: TranscriptWindow[] = [];
  let pending: TranscriptWindow | null = null;
  let pendingChars = 0;
  for (const key of keys) {
    const bucket = buckets.get(key)!;
    if (!pending) {
      pending = { startMs: windows.length === 0 ? -Infinity : key * windowMs, lines: [] };
      pendingChars = 0;
    }
    pending.lines.push(...bucket);
    pendingChars += bucket.reduce((n, t) => n + t.length + 1, 0);
    if (pendingChars >= minChars) {
      windows.push(pending);
      pending = null;
    }
  }
  if (pending) {
    const prev = windows[windows.length - 1];
    if (prev) prev.lines.push(...pending.lines);
    else windows.push(pending);
  }
  return windows;
}

export function windowIndexForElapsed(windows: TranscriptWindow[], elapsedMs: number | null | undefined): number {
  if (elapsedMs == null) return 0;
  let idx = 0;
  windows.forEach((w, i) => {
    if (w.startMs <= elapsedMs) idx = i;
  });
  return idx;
}

export function mergeSummaryParts(parts: string[]): string {
  return assembleSummaryMarkdown(renumberThemes(parts.flatMap((p) => parseSummaryIntoThemes(p))));
}

export function lastRegularThemeIndex(themes: SummaryTheme[]): number {
  for (let i = themes.length - 1; i >= 0; i--) {
    if (!isSupplementaryTheme(themes[i])) return i;
  }
  return -1;
}

export function separateSupplementary(markdown: string): { regular: string; supplementary: string[][] } {
  const blocks: string[][] = [];
  let current: string[] | null = null;
  const preamble: string[] = [];
  for (const line of markdown.split('\n')) {
    if (/^##\s*\d+[.\s]/.test(line)) {
      if (current) blocks.push(current);
      current = [line];
    } else if (current) {
      current.push(line);
    } else {
      preamble.push(line);
    }
  }
  if (current) blocks.push(current);

  const trimEnd = (b: string[]) => {
    const c = [...b];
    while (c.length > 0 && c[c.length - 1].trim() === '') c.pop();
    return c;
  };
  const isSupp = (b: string[]) => b[0].includes('[補足資料') || b.some((l) => l.trim().startsWith('<!-- supplementary:'));
  const regularBlocks = blocks.filter((b) => !isSupp(b)).map((b) => trimEnd(b).join('\n'));
  const pre = trimEnd(preamble).join('\n');
  return {
    regular: [pre, ...regularBlocks].filter((s) => s.length > 0).join('\n\n'),
    supplementary: blocks.filter(isSupp).map(trimEnd),
  };
}
