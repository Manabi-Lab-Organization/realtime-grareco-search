import archiver from 'archiver';
import { and, asc, desc, eq } from 'drizzle-orm';
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

async function buildMeetingMarkdown(meeting: typeof meetings.$inferSelect): Promise<string> {
  const rows = await db
    .select()
    .from(transcripts)
    .where(and(eq(transcripts.meetingId, meeting.id), eq(transcripts.isFinal, true)))
    .orderBy(asc(transcripts.startTime));
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

  const [summary] = await db
    .select({ content: structuredSummaries.content })
    .from(structuredSummaries)
    .where(eq(structuredSummaries.meetingId, meeting.id))
    .orderBy(desc(structuredSummaries.updatedAt))
    .limit(1);

  const [minutes] = await db
    .select({ content: analyses.content })
    .from(analyses)
    .where(and(eq(analyses.meetingId, meeting.id), eq(analyses.type, 'minutes')))
    .orderBy(desc(analyses.createdAt))
    .limit(1);

  const parts: string[] = [];
  parts.push(`# ${meeting.title || '無題の会議'}`, '');
  const started = meeting.startedAt ? new Date(meeting.startedAt).toLocaleString('ja-JP') : '';
  if (started) parts.push(`- 日時: ${started}`);
  const participantsMd = formatParticipants(meeting.participants);
  parts.push('');
  if (participantsMd) {
    parts.push('## 参加者', '', participantsMd, '');
  }
  if (summary?.content) {
    parts.push('## 要約', '', summary.content, '');
  }
  if (minutes?.content) {
    parts.push('## 議事録', '', minutes.content, '');
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
    for (const meeting of list) {
      i++;
      const md = await buildMeetingMarkdown(meeting);
      const idx = String(i).padStart(3, '0');
      archive.append(md, { name: `${idx}_${sanitizeFileName(meeting.title)}.md` });
    }
  }

  await archive.finalize();
  await done;
  return Buffer.concat(chunks);
}
