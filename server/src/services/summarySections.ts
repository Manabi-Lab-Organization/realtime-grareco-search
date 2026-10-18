
export interface SummarySection {
  heading: string;
  content: string;
  fullText: string;
  startMs: number | null;
  endMs: number | null;
}

export type SummaryExclusion = { startMs: number; endMs: number } | { heading: string };

export function parseTimeRange(heading: string): {
  startMs: number | null;
  endMs: number | null;
} {
  const match = heading.match(/\[(\d{1,3}):(\d{2})\s*[-–]\s*(\d{1,3}):(\d{2})\]/);
  if (match) {
    const startMs = (parseInt(match[1]) * 60 + parseInt(match[2])) * 1000;
    const endMs = (parseInt(match[3]) * 60 + parseInt(match[4])) * 1000;
    return { startMs, endMs };
  }
  return { startMs: null, endMs: null };
}

export function parseSummarySections(content: string): SummarySection[] {
  const lines = content.split('\n');
  const sections: SummarySection[] = [];
  let currentHeadingLine = '';
  let currentHeadingDisplay = '';
  let currentTimeRange: { startMs: number | null; endMs: number | null } = {
    startMs: null,
    endMs: null,
  };
  let currentLines: string[] = [];

  const flush = (): void => {
    if (currentHeadingLine || currentLines.length > 0) {
      const body = currentLines.join('\n').trim();
      sections.push({
        heading: currentHeadingDisplay,
        content: body,
        fullText: currentHeadingLine ? `${currentHeadingLine}\n${body}` : body,
        startMs: currentTimeRange.startMs,
        endMs: currentTimeRange.endMs,
      });
    }
  };

  for (const line of lines) {
    const headingMatch = line.match(/^(##\s*\d+[\.\s].+)/);
    if (headingMatch) {
      flush();
      currentHeadingLine = headingMatch[1].trim();
      const displayMatch = currentHeadingLine.match(/^##\s*(\d+[\.\s].+)/);
      currentHeadingDisplay = displayMatch
        ? displayMatch[1].trim()
        : currentHeadingLine.replace(/^##\s*/, '');
      currentTimeRange = parseTimeRange(currentHeadingDisplay);
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }
  flush();

  return sections;
}

export function isSectionExcluded(
  section: SummarySection,
  exclusions: SummaryExclusion[] | undefined,
): boolean {
  if (!exclusions || exclusions.length === 0) return false;
  for (const ex of exclusions) {
    if ('startMs' in ex) {
      if (section.startMs == null || section.endMs == null) continue;
      if (section.startMs <= ex.endMs && section.endMs >= ex.startMs) return true;
    } else if ('heading' in ex) {
      if (section.heading.trim() === ex.heading.trim()) return true;
    }
  }
  return false;
}

export function filterSummaryContent(
  content: string,
  exclusions: SummaryExclusion[] | undefined,
): string {
  if (!exclusions || exclusions.length === 0) return content;
  const sections = parseSummarySections(content);
  const kept = sections.filter((s) => !isSectionExcluded(s, exclusions));
  return kept.map((s) => s.fullText).join('\n\n').trim();
}
