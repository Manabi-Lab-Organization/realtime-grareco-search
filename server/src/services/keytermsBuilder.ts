
import { db } from '../db/index.js';
import { meetings } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { getTopTermsByMeeting } from './termGlossaryService.js';
import { getActiveRecording } from '../websocket/meetingRegistry.js';

const KEYTERMS_MAX = 50;
const KEYTERM_MAX_CHARS = 20;
const HONORIFIC_SUFFIX = /(さん|さま|様|氏|殿|君|くん|ちゃん)\s*$/u;

interface ParticipantEntry {
  name?: string | null;
  [key: string]: unknown;
}

function normalizeNameForKeyterm(raw: string): string {
  return raw
    .replace(/　/g, ' ')
    .replace(HONORIFIC_SUFFIX, '')
    .trim();
}

export async function buildKeyterms(meetingId: number): Promise<string[]> {
  const seen = new Set<string>();
  const out: string[] = [];

  try {
    const rows = await db.select({ participants: meetings.participants })
      .from(meetings)
      .where(eq(meetings.id, meetingId))
      .limit(1);
    const participants = (rows[0]?.participants ?? []) as ParticipantEntry[];
    for (const p of participants) {
      if (out.length >= KEYTERMS_MAX) break;
      const raw = typeof p?.name === 'string' ? p.name : '';
      const normalized = normalizeNameForKeyterm(raw);
      if (!normalized) continue;
      const trimmed = normalized.slice(0, KEYTERM_MAX_CHARS);
      if (seen.has(trimmed)) continue;
      seen.add(trimmed);
      out.push(trimmed);
    }
  } catch (err) {
    console.warn('[keytermsBuilder] failed to load participants', err);
  }

  const remaining = KEYTERMS_MAX - out.length;
  if (remaining > 0) {
    try {
      const topTerms = await getTopTermsByMeeting(meetingId, remaining * 2);
      for (const term of topTerms) {
        if (out.length >= KEYTERMS_MAX) break;
        const trimmed = term.slice(0, KEYTERM_MAX_CHARS);
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        out.push(trimmed);
      }
    } catch (err) {
      console.warn('[keytermsBuilder] failed to load top terms', err);
    }
  }

  return out;
}

export async function refreshSessionKeyterms(meetingId: number): Promise<void> {
  const recording = getActiveRecording(meetingId);
  if (!recording) return;
  try {
    const terms = await buildKeyterms(meetingId);
    recording.elevenlabs.setKeyterms(terms);
  } catch (err) {
    console.warn(`[keytermsBuilder] refresh failed for meeting ${meetingId}`, err);
  }
}
