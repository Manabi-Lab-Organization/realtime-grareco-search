
import sharp from 'sharp';
import { eq, desc, asc, isNull, isNotNull, and, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { meetingObservations, meetingImages } from '../db/schema.js';
import { analyzeRoomObservation, analyzeRoomObservationMultiView, consolidateMaterials } from './geminiService.js';
import { insertSupplementaryText } from './meetingImageService.js';
import { isEquirectangular, reprojectEquirectToViews, VIEW_LABELS } from './equirectReproject.js';

const CONSOLIDATE_WINDOW_MS = 10 * 60 * 1000;

export interface ObservationInput {
  data: string;
  mimeType: string;
  fileName?: string;
  sourceType?: 'camera' | 'window' | 'display';
  location?: { lat: number; lng: number; source?: string };
}

const DUP_THRESHOLD = 0.6;

function normalizeForDup(s: string): string {
  return s
    .toLowerCase()
    .replace(/^#+\s*/gm, '')
    .replace(/(スライド|共有資料|共有コンテンツ|共有画面の資料|共有内容|共有された資料)[：:]\s*/g, '')
    .replace(/[#*\-`>|（）()【】「」、。,.\s]/g, '');
}
function charBigrams(s: string): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}
function similarity(a: string, b: string): number {
  const A = charBigrams(normalizeForDup(a));
  const B = charBigrams(normalizeForDup(b));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const g of B) if (A.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}
function isDuplicateAgainst(recent: Array<string | null>, next: string): boolean {
  return recent.some((r) => r && similarity(r, next) >= DUP_THRESHOLD);
}

export async function processObservation(
  meetingId: number,
  meetingStartedAt: Date | string | null,
  input: ObservationInput,
) {
  const { data, mimeType, location } = input;
  const sourceType = input.sourceType ?? 'camera';
  const isScreen = sourceType !== 'camera';
  const now = new Date();

  let aiData = data;
  let aiMime = mimeType;
  let cameraViews: Array<{ data: string; mimeType: string; label: string }> | null = null;
  try {
    const src = Buffer.from(data, 'base64');
    const meta = await sharp(src).metadata();
    const buf = await sharp(src)
      .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    aiData = buf.toString('base64');
    aiMime = 'image/jpeg';

    if (!isScreen && isEquirectangular(meta.width ?? 0, meta.height ?? 0)) {
      const viewBufs = await reprojectEquirectToViews(buf);
      cameraViews = viewBufs.map((b, i) => ({
        data: b.toString('base64'),
        mimeType: 'image/jpeg',
        label: VIEW_LABELS[i] ?? `view${i + 1}`,
      }));
    }
  } catch (err) {
    console.warn('[Observation] 画像前処理に失敗、元データで解析:', (err as Error).message);
  }

  const capturedAtText = now.toISOString().replace('T', ' ').slice(0, 19);
  const locationText = location ? `緯度 ${location.lat}, 経度 ${location.lng}` : null;
  const result = cameraViews
    ? await analyzeRoomObservationMultiView(cameraViews, { capturedAtText, locationText })
    : await analyzeRoomObservation(aiData, aiMime, {
        capturedAtText,
        locationText,
        mode: isScreen ? 'screen' : 'camera',
      });

  const meetingElapsedMs = meetingStartedAt
    ? Math.round(now.getTime() - new Date(meetingStartedAt).getTime())
    : null;

  let materialsText: string | null = null;
  let materialsDiagram: string | null = null;
  const materials = result.materials;
  if (materials) {
    const recent = await db
      .select({ t: meetingObservations.materialsText })
      .from(meetingObservations)
      .where(and(
        eq(meetingObservations.meetingId, meetingId),
        eq(meetingObservations.sourceType, sourceType),
        isNotNull(meetingObservations.materialsText),
      ))
      .orderBy(desc(meetingObservations.id))
      .limit(6);
    if (!isDuplicateAgainst(recent.map((r) => r.t), materials.analysis)) {
      materialsText = materials.analysis;
      materialsDiagram = materials.diagram;
    }
  }

  const [observation] = await db.insert(meetingObservations).values({
    meetingId,
    capturedAt: now,
    meetingElapsedMs,
    peopleCount: result.peopleCount,
    fiveW1h: result.fiveW1H,
    people: result.people,
    location: location ?? null,
    rawSummary: result.rawSummary,
    materialsText,
    materialsDiagram,
    sourceType,
    linkedImageId: null,
    viewCount: cameraViews ? cameraViews.length : 1,
  }).returning();

  console.log(`[Observation] meeting ${meetingId} obs ${observation.id} 記録（people=${result.peopleCount ?? '?'}, materials=${materialsText ? 'あり' : 'なし'}）`);

  await maybeConsolidate(meetingId, meetingStartedAt, false).catch((err) =>
    console.error('[Observation] consolidate 失敗:', err),
  );

  return observation;
}

export async function maybeConsolidate(
  meetingId: number,
  meetingStartedAt: Date | string | null,
  force: boolean,
): Promise<void> {
  const pending = await db
    .select({ id: meetingObservations.id, materialsText: meetingObservations.materialsText, capturedAt: meetingObservations.capturedAt })
    .from(meetingObservations)
    .where(and(
      eq(meetingObservations.meetingId, meetingId),
      isNotNull(meetingObservations.materialsText),
      isNull(meetingObservations.consolidatedAt),
    ))
    .orderBy(asc(meetingObservations.capturedAt));

  if (pending.length === 0) return;

  const oldestMs = new Date(pending[0].capturedAt).getTime();
  if (!force && Date.now() - oldestMs < CONSOLIDATE_WINDOW_MS) return;

  const texts = pending.map((p) => p.materialsText!).filter(Boolean);

  const [prevDigest] = await db
    .select({ a: meetingImages.aiAnalysis })
    .from(meetingImages)
    .where(and(
      eq(meetingImages.meetingId, meetingId),
      inArray(meetingImages.fileName, ['共有画面の資料', '環境観察の資料']),
    ))
    .orderBy(desc(meetingImages.id))
    .limit(1);

  const merged = await consolidateMaterials(texts, prevDigest?.a ?? null);

  let digestId: number | null = null;
  if (merged && merged.trim()) {
    try {
      const row = await insertSupplementaryText(meetingId, meetingStartedAt, {
        analysis: merged.trim(),
        diagram: null,
        fileName: '共有画面の資料',
      });
      digestId = row.id;
    } catch (err) {
      console.error('[Observation] ダイジェストの補足資料登録に失敗:', err);
    }
  }

  const ids = pending.map((p) => p.id);
  await db.update(meetingObservations)
    .set({ consolidatedAt: new Date(), linkedImageId: digestId })
    .where(inArray(meetingObservations.id, ids));

  console.log(`[Observation] meeting ${meetingId} 集約 ${ids.length}件 → 補足資料=${digestId ?? '新規なし'}（force=${force}）`);
}

export async function flushObservationConsolidation(
  meetingId: number,
  meetingStartedAt: Date | string | null,
): Promise<void> {
  await maybeConsolidate(meetingId, meetingStartedAt, true).catch((err) =>
    console.error('[Observation] flush 失敗:', err),
  );
}

export async function listObservations(meetingId: number) {
  return db
    .select()
    .from(meetingObservations)
    .where(eq(meetingObservations.meetingId, meetingId));
}
