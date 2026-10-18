import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  meetings,
  participantImages,
  participantTexts,
  participantConversationExtractions,
} from '../db/schema.js';

interface ParticipantEntry {
  name: string;
  gender: string;
  age: string;
  other: string;
  speakerIds?: number[];
  source?: string;
  confirmedAt?: string;
}

const HONORIFIC_RE = /(さま|さん|様|氏|殿|君|ちゃん)$/u;

export function normalizeNameKey(name: string): string {
  if (!name) return '';
  let s = String(name).replace(/[　\s]+/g, ' ').trim();
  for (let i = 0; i < 2; i++) {
    const m = s.match(HONORIFIC_RE);
    if (!m) break;
    s = s.slice(0, s.length - m[0].length).trim();
  }
  return s.toLowerCase();
}

export async function undismissNames(meetingId: number, names: string[]): Promise<void> {
  const removeKeys = new Set(
    names.map((n) => normalizeNameKey(String(n ?? ''))).filter((k) => k)
  );
  if (removeKeys.size === 0) return;

  const [row] = await db
    .select({ dismissedParticipantNames: meetings.dismissedParticipantNames })
    .from(meetings)
    .where(eq(meetings.id, meetingId))
    .limit(1);
  const current = Array.isArray(row?.dismissedParticipantNames)
    ? (row!.dismissedParticipantNames as unknown[]).filter((s): s is string => typeof s === 'string')
    : [];
  const next = current.filter((k) => !removeKeys.has(k));
  if (next.length === current.length) return;

  await db
    .update(meetings)
    .set({ dismissedParticipantNames: next })
    .where(eq(meetings.id, meetingId));
}

export async function mergeAndUpdateParticipants(meetingId: number): Promise<void> {
  const [meetingRow] = await db
    .select({
      participants: meetings.participants,
      dismissedParticipantNames: meetings.dismissedParticipantNames,
    })
    .from(meetings)
    .where(eq(meetings.id, meetingId))
    .limit(1);
  const existingParticipants = Array.isArray(meetingRow?.participants)
    ? (meetingRow!.participants as any[])
    : [];
  const dismissedKeys = new Set(
    Array.isArray(meetingRow?.dismissedParticipantNames)
      ? (meetingRow!.dismissedParticipantNames as unknown[]).filter(
          (s): s is string => typeof s === 'string'
        )
      : []
  );

  const images = await db
    .select({ aiExtractedParticipants: participantImages.aiExtractedParticipants })
    .from(participantImages)
    .where(eq(participantImages.meetingId, meetingId));
  const texts = await db
    .select({ aiExtractedParticipants: participantTexts.aiExtractedParticipants })
    .from(participantTexts)
    .where(eq(participantTexts.meetingId, meetingId));
  const conversations = await db
    .select({ aiExtractedParticipants: participantConversationExtractions.aiExtractedParticipants })
    .from(participantConversationExtractions)
    .where(eq(participantConversationExtractions.meetingId, meetingId));

  const merged = new Map<string, ParticipantEntry>();

  for (const p of existingParticipants) {
    if (!p?.name) continue;
    const key = normalizeNameKey(String(p.name));
    if (!key) continue;
    merged.set(key, {
      name: String(p.name).trim(),
      gender: p.gender || '分からない',
      age: p.age || '分からない',
      other: p.other || '',
      speakerIds: Array.isArray(p.speakerIds) ? [...p.speakerIds] : undefined,
      source: p.source,
      confirmedAt: p.confirmedAt,
    });
  }

  const allExtracted: any[] = [];
  for (const row of [...images, ...texts, ...conversations]) {
    if (Array.isArray(row.aiExtractedParticipants)) {
      allExtracted.push(...(row.aiExtractedParticipants as any[]));
    }
  }

  for (const p of allExtracted) {
    const rawName = String(p?.name ?? '').trim();
    const key = normalizeNameKey(rawName);
    if (!key) continue;
    if (dismissedKeys.has(key)) continue;
    const existing = merged.get(key);
    if (existing) {
      if (p.gender && p.gender !== '分からない' && existing.gender === '分からない') existing.gender = p.gender;
      if (p.age && p.age !== '分からない' && existing.age === '分からない') existing.age = p.age;
      if (p.other && !existing.other) existing.other = p.other;
    } else {
      merged.set(key, {
        name: rawName,
        gender: p.gender || '分からない',
        age: p.age || '分からない',
        other: p.other || '',
      });
    }
  }

  const participants = Array.from(merged.values()).map((p) => {
    const out: ParticipantEntry = { name: p.name, gender: p.gender, age: p.age, other: p.other };
    if (p.speakerIds && p.speakerIds.length > 0) out.speakerIds = p.speakerIds;
    if (p.source) out.source = p.source;
    if (p.confirmedAt) out.confirmedAt = p.confirmedAt;
    return out;
  });

  await db.update(meetings).set({ participants }).where(eq(meetings.id, meetingId));
}
