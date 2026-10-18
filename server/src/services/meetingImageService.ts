
import sharp from 'sharp';
import exifr from 'exifr';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { meetingImages } from '../db/schema.js';
import { analyzeMeetingImage } from './geminiService.js';
import { appendSupplementaryToSummary, formatElapsedLabel } from './summaryAppendService.js';

export async function extractExifData(buffer: Buffer): Promise<Record<string, any> | null> {
  try {
    const allExif = await exifr.parse(buffer, true);
    if (!allExif) return null;

    const result: Record<string, any> = {};
    const fields = [
      'DateTimeOriginal', 'CreateDate', 'ModifyDate', 'DateTime', 'DateCreated',
      'GPSLatitude', 'GPSLongitude', 'GPSAltitude',
      'Make', 'Model', 'LensModel',
      'ExposureTime', 'FNumber', 'ISO', 'FocalLength',
      'latitude', 'longitude',
    ];
    for (const key of fields) {
      if (allExif[key] != null) result[key] = allExif[key];
    }
    if (!result.GPSLatitude && result.latitude) result.GPSLatitude = result.latitude;
    if (!result.GPSLongitude && result.longitude) result.GPSLongitude = result.longitude;

    console.log(`[EXIF] 取得フィールド:`, Object.keys(result).join(', ') || '(なし)');
    return Object.keys(result).length > 0 ? result : null;
  } catch (err) {
    console.warn('[EXIF] 抽出失敗:', err);
    return null;
  }
}

export function formatExifForPrompt(exif: Record<string, any>): string {
  const lines: string[] = [];
  const dateTime = exif.DateTimeOriginal || exif.CreateDate || exif.ModifyDate || exif.DateTime;
  if (dateTime) {
    const d = dateTime instanceof Date ? dateTime.toISOString().replace('T', ' ').slice(0, 19) : String(dateTime);
    lines.push(`撮影日時: ${d}`);
  }
  if (exif.GPSLatitude != null && exif.GPSLongitude != null) {
    lines.push(`GPS: ${exif.GPSLatitude}, ${exif.GPSLongitude}`);
    if (exif.GPSAltitude != null) lines.push(`高度: ${exif.GPSAltitude}m`);
  }
  if (exif.Make || exif.Model) {
    lines.push(`カメラ: ${[exif.Make, exif.Model].filter(Boolean).join(' ')}`);
  }
  if (exif.LensModel) lines.push(`レンズ: ${exif.LensModel}`);
  const params: string[] = [];
  if (exif.FocalLength) params.push(`${exif.FocalLength}mm`);
  if (exif.FNumber) params.push(`f/${exif.FNumber}`);
  if (exif.ExposureTime) params.push(`${exif.ExposureTime < 1 ? `1/${Math.round(1 / exif.ExposureTime)}` : exif.ExposureTime}s`);
  if (exif.ISO) params.push(`ISO${exif.ISO}`);
  if (params.length > 0) lines.push(`撮影パラメータ: ${params.join(' ')}`);
  return lines.join('\n');
}

export interface MeetingImageUploadInput {
  data: string;
  mimeType: string;
  fileName?: string;
  originalData?: string;
  originalMimeType?: string;
  precomputedAnalysis?: { analysis: string; diagram: string | null };
}

export async function processMeetingImageUpload(
  meetingId: number,
  meetingStartedAt: Date | string | null,
  input: MeetingImageUploadInput,
) {
  const { data, mimeType, fileName, originalData, originalMimeType, precomputedAnalysis } = input;
  const inputBuffer = Buffer.from(data, 'base64');

  const exifBuffer = originalData ? Buffer.from(originalData, 'base64') : inputBuffer;
  const exifData = await extractExifData(exifBuffer);
  if (exifData) {
    console.log(`[EXIF] 抽出成功:`, Object.keys(exifData).join(', '));
  } else {
    console.log(`[EXIF] メタデータなし`);
  }

  let compressedBase64: string;
  let finalMimeType: string;
  let compressedSize: number;

  try {
    const compressed = await sharp(inputBuffer)
      .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    compressedBase64 = compressed.toString('base64');
    finalMimeType = 'image/jpeg';
    compressedSize = compressed.length;
  } catch (sharpErr: any) {
    compressedBase64 = data;
    finalMimeType = mimeType;
    compressedSize = inputBuffer.length;
    console.warn(`[ImageUpload] 圧縮不可、元データで保存 (${mimeType})`);
  }

  const now = new Date();
  const meetingElapsedMs = meetingStartedAt
    ? Math.round(now.getTime() - new Date(meetingStartedAt).getTime())
    : null;

  const metadata: Record<string, any> = {
    originalMimeType: mimeType,
    originalSize: inputBuffer.length,
    compressedSize,
  };
  if (exifData) {
    metadata.exif = exifData;
  }

  const [image] = await db.insert(meetingImages).values({
    meetingId,
    imageData: compressedBase64,
    mimeType: finalMimeType,
    fileName: fileName || null,
    uploadedAt: now,
    meetingElapsedMs,
    metadata,
  }).returning();

  if (precomputedAnalysis) {
    await db.update(meetingImages)
      .set({ aiAnalysis: precomputedAnalysis.analysis, aiDiagram: precomputedAnalysis.diagram })
      .where(eq(meetingImages.id, image.id));
    appendSupplementaryToSummary({
      meetingId,
      marker: `image:${image.id}`,
      heading: `画像: ${image.fileName ?? '無題'}`,
      content: precomputedAnalysis.analysis,
      elapsedTimeLabel: formatElapsedLabel(image.meetingElapsedMs),
    }).catch((err) => console.error('[summaryAppend:image] failed:', err));
    console.log(`[ImageAnalysis] meetingImage ${image.id} は事前分析結果を流用（AI再分析なし）`);
    return image;
  }

  const exifText = exifData ? formatExifForPrompt(exifData) : null;
  const aiImageData = originalData || data;
  const aiImageMimeType = originalMimeType || mimeType;
  console.log(`[ImageAnalysis] AI分析開始: hasExif=${!!exifText}, hasOriginal=${!!originalData}`);
  analyzeMeetingImage(aiImageData, aiImageMimeType, exifText).then(async (result) => {
    await db.update(meetingImages)
      .set({ aiAnalysis: result.analysis, aiDiagram: result.diagram })
      .where(eq(meetingImages.id, image.id));
    console.log(`[ImageAnalysis] meetingImage ${image.id} 分析完了`);

    appendSupplementaryToSummary({
      meetingId,
      marker: `image:${image.id}`,
      heading: `画像: ${image.fileName ?? '無題'}`,
      content: result.analysis,
      elapsedTimeLabel: formatElapsedLabel(image.meetingElapsedMs),
    }).catch((err) => console.error('[summaryAppend:image] failed:', err));
  }).catch((err) => {
    console.error(`[ImageAnalysis] meetingImage ${image.id} 分析失敗:`, err);
  });

  return image;
}

export async function insertSupplementaryText(
  meetingId: number,
  meetingStartedAt: Date | string | null,
  input: { analysis: string; diagram?: string | null; fileName?: string },
) {
  const now = new Date();
  const meetingElapsedMs = meetingStartedAt
    ? Math.round(now.getTime() - new Date(meetingStartedAt).getTime())
    : null;

  const [row] = await db.insert(meetingImages).values({
    meetingId,
    imageData: '',
    mimeType: 'text/plain',
    fileName: input.fileName ?? '環境観察の資料',
    uploadedAt: now,
    meetingElapsedMs,
    aiAnalysis: input.analysis,
    aiDiagram: input.diagram ?? null,
    metadata: { sourceType: 'observation-material', imageDiscarded: true },
  }).returning();

  appendSupplementaryToSummary({
    meetingId,
    marker: `image:${row.id}`,
    heading: input.fileName ?? '資料（環境観察）',
    content: input.analysis,
    elapsedTimeLabel: formatElapsedLabel(row.meetingElapsedMs),
  }).catch((err) => console.error('[summaryAppend:observation-material] failed:', err));

  return row;
}
