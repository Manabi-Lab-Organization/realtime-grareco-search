import crypto from 'node:crypto';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  meetingShares,
  meetings,
  researchInsights,
  graphicRecordings,
  structuredSummaries,
} from '../db/schema.js';
import { getDetectedTermsByMeeting } from './termGlossaryService.js';
import { filterSummaryContent, type SummaryExclusion } from './summarySections.js';

export const DEFAULT_SHARED_CONTENTS = ['glossary', 'research', 'grareco', 'summary'];

export interface ExcludedItems {
  research?: string[];
  grareco?: string[];
  glossary?: string[];
  summary?: SummaryExclusion[];
}

export const SHARE_TTL_MS = 30 * 60 * 1000;

type MeetingRow = typeof meetings.$inferSelect;
type ShareRow = typeof meetingShares.$inferSelect;

function generateToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function buildShareUrl(token: string): string {
  const base = process.env.APP_URL || process.env.CLIENT_URL || 'http://localhost:5173';
  return `${base.replace(/\/+$/, '')}/share/${token}`;
}

export function isMeetingLive(meeting: MeetingRow, now = Date.now()): boolean {
  if (meeting.status !== 'active' && meeting.status !== 'paused') return false;
  const lastActivity =
    meeting.lastAudioAt ?? meeting.transcriptionStartedAt ?? meeting.startedAt;
  if (!lastActivity) return true;
  return now - new Date(lastActivity).getTime() <= SHARE_TTL_MS;
}

export function isShareLive(share: ShareRow, meeting: MeetingRow, now = Date.now()): boolean {
  if (!share.isActive || share.revokedAt) return false;
  return isMeetingLive(meeting, now);
}

export async function createOrRefreshShare(
  meetingId: number,
  userId: number,
): Promise<ShareRow> {
  const [existing] = await db
    .select()
    .from(meetingShares)
    .where(eq(meetingShares.meetingId, meetingId));

  const now = new Date();

  if (existing) {
    const reuse = existing.isActive && !existing.revokedAt;
    const [updated] = await db
      .update(meetingShares)
      .set({
        token: reuse ? existing.token : generateToken(),
        isActive: true,
        revokedAt: null,
        updatedAt: now,
      })
      .where(eq(meetingShares.id, existing.id))
      .returning();
    return updated;
  }

  const [created] = await db
    .insert(meetingShares)
    .values({ meetingId, token: generateToken(), createdBy: userId })
    .returning();
  return created;
}

export async function revokeShareByMeeting(meetingId: number): Promise<void> {
  await db
    .update(meetingShares)
    .set({ isActive: false, revokedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(meetingShares.meetingId, meetingId), eq(meetingShares.isActive, true)));
}

export function getSharedContents(share: ShareRow): string[] {
  const v = share.sharedContents as string[] | null;
  return Array.isArray(v) ? v : DEFAULT_SHARED_CONTENTS;
}

export function getExcludedItems(share: ShareRow): ExcludedItems {
  return (share.excludedItems as ExcludedItems | null) ?? {};
}

export async function updateShareSettings(
  meetingId: number,
  settings: { sharedContents?: string[]; excludedItems?: ExcludedItems },
): Promise<ShareRow | null> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (settings.sharedContents !== undefined) set.sharedContents = settings.sharedContents;
  if (settings.excludedItems !== undefined) set.excludedItems = settings.excludedItems;
  const [updated] = await db
    .update(meetingShares)
    .set(set)
    .where(eq(meetingShares.meetingId, meetingId))
    .returning();
  return updated ?? null;
}

export async function getActiveShareMeetingIds(meetingIds: number[]): Promise<Set<number>> {
  if (meetingIds.length === 0) return new Set();
  const rows = await db
    .select({ meetingId: meetingShares.meetingId })
    .from(meetingShares)
    .where(
      and(
        inArray(meetingShares.meetingId, meetingIds),
        eq(meetingShares.isActive, true),
        isNull(meetingShares.revokedAt),
      ),
    );
  return new Set(rows.map((r) => r.meetingId));
}

export async function getShareByMeeting(meetingId: number): Promise<ShareRow | null> {
  const [share] = await db
    .select()
    .from(meetingShares)
    .where(eq(meetingShares.meetingId, meetingId));
  return share ?? null;
}

export async function resolveShareToken(
  token: string,
): Promise<{ share: ShareRow; meeting: MeetingRow; live: boolean } | null> {
  const [share] = await db
    .select()
    .from(meetingShares)
    .where(eq(meetingShares.token, token));
  if (!share) return null;

  const [meeting] = await db
    .select()
    .from(meetings)
    .where(eq(meetings.id, share.meetingId));
  if (!meeting) return null;

  return { share, meeting, live: isShareLive(share, meeting) };
}

function isPublicShareableResearch(row: typeof researchInsights.$inferSelect): boolean {
  const meta = (row.metadata as Record<string, unknown> | null) ?? {};
  if (meta.ephemeral === true) return false;
  if (meta.kind === 'acknowledgment' || meta.kind === 'system_notice') return false;
  if (row.cardType === 'info') return true;
  if (row.cardType === 'fact-check') return meta.verdict === 'confirmed';
  return false;
}

export async function getPublicResearchCards(meetingId: number, excluded: string[] = []) {
  const rows = await db
    .select()
    .from(researchInsights)
    .where(eq(researchInsights.meetingId, meetingId))
    .orderBy(desc(researchInsights.createdAt));

  return rows
    .filter(isPublicShareableResearch)
    .filter((r) => !excluded.includes(String(r.id)))
    .map((r) => {
    let content: Record<string, unknown> = {};
    try {
      content = typeof r.content === 'string' ? JSON.parse(r.content) : {};
    } catch {
    }
    return {
      id: String(r.id),
      cardType: r.cardType,
      agentType: r.agentType,
      keyword: r.keyword ?? '',
      title: (content.title as string) ?? r.keyword ?? '',
      body: (content.body as string) ?? '',
      importance: r.importance ?? 50,
      sources: (content.sources as Array<unknown>) ?? [],
      timestamp: r.createdAt.getTime(),
    };
  });
}

export async function getPublicGrarecos(meetingId: number, excluded: string[] = [], token: string) {
  const rows = await db
    .select({
      id: graphicRecordings.id,
      pinnedAt: graphicRecordings.pinnedAt,
      createdAt: graphicRecordings.createdAt,
      hasImage: sql<boolean>`${graphicRecordings.imageUrl} is not null`,
    })
    .from(graphicRecordings)
    .where(eq(graphicRecordings.meetingId, meetingId))
    .orderBy(desc(graphicRecordings.createdAt));

  return rows
    .filter((r) => r.hasImage)
    .filter((r) => !excluded.includes(String(r.id)))
    .map((r) => ({
      id: String(r.id),
      imageUrl: `/api/share/${token}/grareco/${r.id}/image`,
      pinnedAt: r.pinnedAt ? r.pinnedAt.getTime() : null,
      timestamp: r.createdAt.getTime(),
    }));
}

export async function getPublicGrarecoImage(
  meetingId: number,
  recordingId: number,
  excluded: string[] = [],
): Promise<string | null> {
  if (excluded.includes(String(recordingId))) return null;
  const [row] = await db
    .select({ imageUrl: graphicRecordings.imageUrl })
    .from(graphicRecordings)
    .where(and(eq(graphicRecordings.id, recordingId), eq(graphicRecordings.meetingId, meetingId)));
  return row?.imageUrl ?? null;
}

export async function getPublicGrarecoImageHash(
  meetingId: number,
  recordingId: number,
  excluded: string[] = [],
): Promise<string | null> {
  if (excluded.includes(String(recordingId))) return null;
  const [row] = await db
    .select({ hash: sql<string | null>`md5(${graphicRecordings.imageUrl})` })
    .from(graphicRecordings)
    .where(and(eq(graphicRecordings.id, recordingId), eq(graphicRecordings.meetingId, meetingId)));
  return row?.hash ?? null;
}

export async function getPublicSummary(meetingId: number, excluded: SummaryExclusion[] = []) {
  const [summary] = await db
    .select()
    .from(structuredSummaries)
    .where(eq(structuredSummaries.meetingId, meetingId))
    .orderBy(desc(structuredSummaries.updatedAt))
    .limit(1);
  if (!summary) return null;
  const content = filterSummaryContent(summary.content, excluded);
  return { content, updatedAt: summary.updatedAt.getTime() };
}

export async function getPublicTerms(meetingId: number, excluded: string[] = []) {
  const terms = await getDetectedTermsByMeeting(meetingId);
  if (excluded.length === 0) return terms;
  return terms.filter((t) => !excluded.includes(t.term));
}
