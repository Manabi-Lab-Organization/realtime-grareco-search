
export interface SummarySection {
  heading: string;
  content: string;
  fullText: string;
  startMs: number | null;
  endMs: number | null;
}

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

  for (const line of lines) {
    const headingMatch = line.match(/^(##\s*\d+[\.\s].+)/);
    if (headingMatch) {
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

  return sections;
}
