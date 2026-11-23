import archiver from 'archiver';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { meetings, transcripts, structuredSummaries, analyses } from '../db/schema.js';
import { buildSpeakerMapping, applySpeakerMapping } from './participantMappingService.js';
import { parseNgKeywords, filterNgTranscripts } from './ngKeywordFilterService.js';

function formatTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

function sanitizeFileName(name: string): string {
  const cleaned = (name || '').replace(/[\\/:*?"<>|\n\r\t]/g, '_').trim().slice(0, 80).trim();
  return cleaned || '無題の会議';
}

function formatParticipants(participants: unknown): string | null {
  if (!Array.isArray(participants) || participants.length === 0) return null;
  const lines = participants
    .map((p) => {
      const rec = (p ?? {}) as Record<string, unknown>;
      const name = typeof rec.name === 'string' ? rec.name.trim() : '';
      if (!name) return null;
      const org = typeof rec.organization === 'string' ? rec.organization.trim() : '';
      const role = typeof rec.role === 'string' ? rec.role.trim() : '';
      const meta = [org, role].filter(Boolean).join(' / ');
      return meta ? `- ${name}（${meta}）` : `- ${name}`;
    })
    .filter((v): v is string => v !== null);
  return lines.length > 0 ? lines.join('\n') : null;
}

export const EXPORT_BATCH = 100;

type TranscriptRow = typeof transcripts.$inferSelect;

interface MeetingExportData {
  transcripts: Map<number, TranscriptRow[]>;
  summaries: Map<number, string>;
  minutes: Map<number, string>;
}

async function loadMeetingExportData(meetingIds: number[]): Promise<MeetingExportData> {
  const data: MeetingExportData = { transcripts: new Map(), summaries: new Map(), minutes: new Map() };
  if (meetingIds.length === 0) return data;

  const transcriptRows = await db
    .select()
    .from(transcripts)
    .where(and(inArray(transcripts.meetingId, meetingIds), eq(transcripts.isFinal, true)))
    .orderBy(asc(transcripts.startTime));
  for (const row of transcriptRows) {
    const list = data.transcripts.get(row.meetingId);
    if (list) list.push(row);
    else data.transcripts.set(row.meetingId, [row]);
  }

  const summaryRows = await db
    .select({ meetingId: structuredSummaries.meetingId, content: structuredSummaries.content })
    .from(structuredSummaries)
    .where(inArray(structuredSummaries.meetingId, meetingIds))
    .orderBy(desc(structuredSummaries.updatedAt));
  for (const row of summaryRows) {
    if (!data.summaries.has(row.meetingId)) data.summaries.set(row.meetingId, row.content);
  }

  const minutesRows = await db
    .select({ meetingId: analyses.meetingId, content: analyses.content })
    .from(analyses)
    .where(and(inArray(analyses.meetingId, meetingIds), eq(analyses.type, 'minutes')))
    .orderBy(desc(analyses.createdAt));
  for (const row of minutesRows) {
    if (!data.minutes.has(row.meetingId)) data.minutes.set(row.meetingId, row.content);
  }
  return data;
}

function buildMeetingMarkdown(meeting: typeof meetings.$inferSelect, data: MeetingExportData): string {
  const rows = data.transcripts.get(meeting.id) ?? [];
  const mapping = buildSpeakerMapping(meeting.participants);
  const mapped = applySpeakerMapping(rows, mapping);
  const visible = filterNgTranscripts(mapped, parseNgKeywords(meeting.ngKeywords));
  const transcriptText = visible
    .map((r) => {
      const ts = formatTimestamp(r.recordingMs ?? r.startTime);
      const speaker = r.speaker ? `${r.speaker}: ` : '';
      return `[${ts}] ${speaker}${r.content}`;
    })
    .join('\n');

  const summary = data.summaries.get(meeting.id);
  const minutes = data.minutes.get(meeting.id);

  const parts: string[] = [];
  parts.push(`# ${meeting.title || '無題の会議'}`, '');
  const started = meeting.startedAt ? new Date(meeting.startedAt).toLocaleString('ja-JP') : '';
  if (started) parts.push(`- 日時: ${started}`);
  const participantsMd = formatParticipants(meeting.participants);
  parts.push('');
  if (participantsMd) {
    parts.push('## 参加者', '', participantsMd, '');
  }
  if (summary) {
    parts.push('## 要約', '', summary, '');
  }
  if (minutes) {
    parts.push('## 議事録', '', minutes, '');
  }
  parts.push('## 文字起こし', '', transcriptText || '（文字起こしはありません）', '');
  return parts.join('\n');
}

export async function buildAccountExportZip(userId: number): Promise<Buffer> {
  const list = await db
    .select()
    .from(meetings)
    .where(eq(meetings.userId, userId))
    .orderBy(asc(meetings.startedAt));

  const archive = archiver('zip', { zlib: { level: 9 } });
  const chunks: Buffer[] = [];
  archive.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve, reject) => {
    archive.on('end', () => resolve());
    archive.on('warning', (err) => reject(err));
    archive.on('error', (err) => reject(err));
  });

  if (list.length === 0) {
    archive.append('エクスポート対象の会議データがありません。\n', { name: 'README.txt' });
  } else {
    let i = 0;
    for (let start = 0; start < list.length; start += EXPORT_BATCH) {
      const batch = list.slice(start, start + EXPORT_BATCH);
      const data = await loadMeetingExportData(batch.map((m) => m.id));
      for (const meeting of batch) {
        i++;
        const md = buildMeetingMarkdown(meeting, data);
        const idx = String(i).padStart(3, '0');
        archive.append(md, { name: `${idx}_${sanitizeFileName(meeting.title)}.md` });
      }
    }
  }

  await archive.finalize();
  await done;
  return Buffer.concat(chunks);
}
