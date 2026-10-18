
import { and, asc, eq, desc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { structuredSummaries, meetings, meetingImages, meetingMemos, transcripts } from '../db/schema.js';
import { broadcastToUser } from './research/connectionRegistry.js';

export interface ClockPoint {
  wallMs: number;
  recMs: number;
}

export function wallToRecordingMs(points: ClockPoint[], wallMs: number): number {
  if (points.length === 0) return wallMs;
  if (wallMs < points[0].wallMs) return Math.max(0, points[0].recMs - (points[0].wallMs - wallMs));
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (points[mid].wallMs <= wallMs) lo = mid;
    else hi = mid - 1;
  }
  const p = points[lo];
  const next = points[lo + 1];
  if (!next) return p.recMs;
  const recStep = Math.max(0, next.recMs - p.recMs);
  return p.recMs + Math.min(wallMs - p.wallMs, recStep);
}

export async function loadClockPoints(meetingId: number): Promise<ClockPoint[]> {
  const rows = await db
    .select({ wallMs: transcripts.startTime, recMs: transcripts.recordingMs })
    .from(transcripts)
    .where(and(eq(transcripts.meetingId, meetingId), eq(transcripts.isFinal, true)))
    .orderBy(asc(transcripts.startTime));
  return rows.map((r) => ({ wallMs: r.wallMs, recMs: r.recMs ?? r.wallMs }));
}

export function toRecordingElapsedMs(points: ClockPoint[], wallMs: number | null | undefined): number | null {
  if (wallMs == null || wallMs < 0) return null;
  return points.length > 0 ? wallToRecordingMs(points, wallMs) : wallMs;
}

export function parseTimeLabelToSec(label: string): number | null {
  const m = label.trim().match(/^(\d{1,3}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  return m[3] !== undefined
    ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
    : Number(m[1]) * 60 + Number(m[2]);
}

export function headingStartSec(headingLine: string): number | null {
  const m = headingLine.match(/\[(\d{1,3}:\d{2}(?::\d{2})?)/);
  return m ? parseTimeLabelToSec(m[1]) : null;
}

export function splitIntoSections(content: string): { preamble: string[]; sections: string[][] } {
  const preamble: string[] = [];
  const sections: string[][] = [];
  let current: string[] | null = null;
  for (const line of content.split('\n')) {
    if (/^##\s*\d+[.\s]/.test(line)) {
      if (current) sections.push(current);
      current = [line];
    } else if (current) {
      current.push(line);
    } else {
      preamble.push(line);
    }
  }
  if (current) sections.push(current);
  return { preamble, sections };
}

export function insertSectionChronologically(
  content: string,
  sectionLines: string[],
  elapsedSec: number | null,
): { content: string; sectionNumber: number } {
  const { preamble, sections } = splitIntoSections(content);

  let insertAt = sections.length;
  if (elapsedSec != null) {
    let lastKnownSec = -1;
    for (let i = 0; i < sections.length; i++) {
      const start = headingStartSec(sections[i][0]);
      const effective = start ?? lastKnownSec;
      if (start != null) lastKnownSec = start;
      if (effective > elapsedSec) {
        insertAt = i;
        break;
      }
    }
  }
  sections.splice(insertAt, 0, [...sectionLines]);

  sections.forEach((sec, i) => {
    sec[0] = sec[0].replace(/^##\s*\d+[.\s]\s*/, `## ${i + 1}. `);
  });

  const joinBlock = (lines: string[]) => {
    const copy = [...lines];
    while (copy.length > 0 && copy[copy.length - 1].trim() === '') copy.pop();
    return copy.join('\n');
  };
  const parts: string[] = [];
  const pre = joinBlock(preamble);
  if (pre) parts.push(pre);
  for (const sec of sections) parts.push(joinBlock(sec));
  return { content: parts.join('\n\n'), sectionNumber: insertAt + 1 };
}

export function demoteHeadingsInSupplementary(content: string): string {
  return content
    .split('\n')
    .map((line) => line.replace(/^(\s{0,3})(#{1,2})(\s+)/, '$1###$3'))
    .join('\n');
}

export interface AppendSupplementaryInput {
  meetingId: number;
  marker: string;
  heading: string;
  content: string;
  elapsedTimeLabel?: string;
  clockPoints?: ClockPoint[];
}

export async function appendSupplementaryToSummary(
  input: AppendSupplementaryInput,
): Promise<{ appended: boolean; reason?: string }> {
  const [meeting] = await db
    .select({ id: meetings.id, userId: meetings.userId })
    .from(meetings)
    .where(eq(meetings.id, input.meetingId));
  if (!meeting) {
    return { appended: false, reason: 'meeting_not_found' };
  }

  const hiddenMarker = `<!-- supplementary:${input.marker} -->`;

  const [existing] = await db
    .select()
    .from(structuredSummaries)
    .where(eq(structuredSummaries.meetingId, input.meetingId))
    .orderBy(desc(structuredSummaries.updatedAt))
    .limit(1);

  if (!existing?.content?.trim()) {
    return { appended: false, reason: 'no_summary_yet' };
  }

  if (existing.content.includes(hiddenMarker)) {
    return { appended: false, reason: 'already_appended' };
  }

  const wallSec = input.elapsedTimeLabel ? parseTimeLabelToSec(input.elapsedTimeLabel) : null;
  let elapsedLabel: string | undefined;
  if (wallSec != null) {
    const points = input.clockPoints ?? (await loadClockPoints(input.meetingId));
    elapsedLabel = formatElapsedLabel(toRecordingElapsedMs(points, wallSec * 1000));
  }
  const elapsedPart = elapsedLabel ? ` [${elapsedLabel}]` : '';
  const headingLine = `## 0. ${input.heading}${elapsedPart} [補足資料]`;
  const body = demoteHeadingsInSupplementary(input.content.trim());
  const sectionLines = [headingLine, ...body.split('\n'), hiddenMarker];

  const elapsedSec = elapsedLabel ? parseTimeLabelToSec(elapsedLabel) : null;
  const { content: newContent, sectionNumber } = insertSectionChronologically(
    existing.content,
    sectionLines,
    elapsedSec,
  );

  await db
    .update(structuredSummaries)
    .set({
      previousContent: existing.content,
      content: newContent,
      updatedAt: new Date(),
    })
    .where(eq(structuredSummaries.id, existing.id));

  broadcastToUser(meeting.userId, 'summary_updated', { meetingId: input.meetingId });

  console.log(
    `[summaryAppend] meeting=${input.meetingId} section=${sectionNumber} marker=${input.marker} ` +
      `heading="${input.heading}" contentChars=${input.content.length}`,
  );
  return { appended: true };
}

export async function removeSupplementaryFromSummary(
  meetingId: number,
  marker: string,
): Promise<{ removed: boolean; reason?: string }> {
  const [meeting] = await db
    .select({ id: meetings.id, userId: meetings.userId })
    .from(meetings)
    .where(eq(meetings.id, meetingId));
  if (!meeting) {
    return { removed: false, reason: 'meeting_not_found' };
  }

  const hiddenMarker = `<!-- supplementary:${marker} -->`;

  const [existing] = await db
    .select()
    .from(structuredSummaries)
    .where(eq(structuredSummaries.meetingId, meetingId))
    .orderBy(desc(structuredSummaries.updatedAt))
    .limit(1);

  if (!existing?.content || !existing.content.includes(hiddenMarker)) {
    return { removed: false, reason: 'marker_not_found' };
  }

  const content = existing.content;
  const markerIdx = content.indexOf(hiddenMarker);

  const headingIdx = content.lastIndexOf('\n## ', markerIdx);
  const blockStart = headingIdx >= 0 ? headingIdx : content.lastIndexOf('\n', markerIdx - 1);
  const blockEnd = markerIdx + hiddenMarker.length;

  const newContent = (content.slice(0, blockStart) + content.slice(blockEnd)).trimEnd();

  await db
    .update(structuredSummaries)
    .set({
      previousContent: content,
      content: newContent,
      updatedAt: new Date(),
    })
    .where(eq(structuredSummaries.id, existing.id));

  broadcastToUser(meeting.userId, 'summary_updated', { meetingId });

  console.log(`[summaryAppend] removed section meeting=${meetingId} marker=${marker}`);
  return { removed: true };
}

export async function reconcileSupplementaryIntoSummary(
  meetingId: number,
): Promise<{ appended: number }> {
  const [existing] = await db
    .select({ content: structuredSummaries.content })
    .from(structuredSummaries)
    .where(eq(structuredSummaries.meetingId, meetingId))
    .orderBy(desc(structuredSummaries.updatedAt))
    .limit(1);
  if (!existing?.content?.trim()) return { appended: 0 };

  const images = await db
    .select()
    .from(meetingImages)
    .where(eq(meetingImages.meetingId, meetingId));
  const memos = await db
    .select()
    .from(meetingMemos)
    .where(eq(meetingMemos.meetingId, meetingId));

  type Item = { ts: number; marker: string; heading: string; content: string; elapsed: number | null };
  const items: Item[] = [];
  for (const img of images) {
    if (!img.aiAnalysis) continue;
    const isObservation = (img.metadata as { sourceType?: string } | null)?.sourceType === 'observation-material';
    items.push({
      ts: new Date(img.uploadedAt).getTime(),
      marker: `image:${img.id}`,
      heading: isObservation ? (img.fileName ?? '共有画面の資料') : `画像: ${img.fileName ?? '無題'}`,
      content: img.aiAnalysis,
      elapsed: img.meetingElapsedMs,
    });
  }
  for (const memo of memos) {
    items.push({
      ts: new Date(memo.createdAt).getTime(),
      marker: `memo:${memo.id}`,
      heading: 'メモ',
      content: memo.content,
      elapsed: memo.meetingElapsedMs,
    });
  }
  items.sort((a, b) => a.ts - b.ts);

  const clockPoints = await loadClockPoints(meetingId);
  let appended = 0;
  for (const it of items) {
    const r = await appendSupplementaryToSummary({
      meetingId,
      marker: it.marker,
      heading: it.heading,
      content: it.content,
      elapsedTimeLabel: formatElapsedLabel(it.elapsed),
      clockPoints,
    });
    if (r.appended) appended++;
  }
  if (appended > 0) {
    console.log(`[summaryAppend] reconcile meeting=${meetingId} appended=${appended}`);
  }
  return { appended };
}

export function formatElapsedLabel(elapsedMs: number | null | undefined): string | undefined {
  if (elapsedMs == null || elapsedMs < 0) return undefined;
  const totalSec = Math.floor(elapsedMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
