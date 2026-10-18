
import sharp from 'sharp';
import { db } from '../../db/index.js';
import { meetings, meetingImages } from '../../db/schema.js';
import { and, eq } from 'drizzle-orm';
import { analyzeMeetingImage } from '../geminiService.js';
import { appendSupplementaryToSummary, formatElapsedLabel } from '../summaryAppendService.js';
import { extractExifData, formatExifForPrompt } from '../meetingImageService.js';

export interface AttachImageInput {
  meetingId: number;
  userId: number;
  data: string;
  mimeType: string;
  fileName?: string;
  originalData?: string;
  originalMimeType?: string;
}

export interface AttachImageResult {
  imageId: number;
  fileName: string | null;
  aiAnalysis: string | null;
  aiDiagram: string | null;
  analysisFailed: boolean;
}

export async function attachAndAnalyzeImage(
  input: AttachImageInput
): Promise<AttachImageResult> {
  const [meeting] = await db
    .select({ id: meetings.id, startedAt: meetings.startedAt })
    .from(meetings)
    .where(and(eq(meetings.id, input.meetingId), eq(meetings.userId, input.userId)));
  if (!meeting) {
    throw new Error('meeting_not_found');
  }

  const inputBuffer = Buffer.from(input.data, 'base64');

  const exifBuffer = input.originalData ? Buffer.from(input.originalData, 'base64') : inputBuffer;
  const exifData = await extractExifData(exifBuffer);

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
  } catch (sharpErr) {
    console.warn(`[agent:attach-image] 圧縮不可、元データで保存 (${input.mimeType})`, sharpErr);
    compressedBase64 = input.data;
    finalMimeType = input.mimeType;
    compressedSize = inputBuffer.length;
  }

  const now = new Date();
  const meetingElapsedMs = meeting.startedAt
    ? Math.round(now.getTime() - new Date(meeting.startedAt).getTime())
    : null;

  const metadata: Record<string, any> = {
    originalMimeType: input.mimeType,
    originalSize: inputBuffer.length,
    compressedSize,
    source: 'agent_chat',
  };
  if (exifData) {
    metadata.exif = exifData;
  }

  const [image] = await db
    .insert(meetingImages)
    .values({
      meetingId: input.meetingId,
      imageData: compressedBase64,
      mimeType: finalMimeType,
      fileName: input.fileName || null,
      uploadedAt: now,
      meetingElapsedMs,
      metadata,
    })
    .returning();

  const exifText = exifData ? formatExifForPrompt(exifData) : null;
  const aiImageData = input.originalData || input.data;
  const aiImageMimeType = input.originalMimeType || input.mimeType;

  let aiAnalysis: string | null = null;
  let aiDiagram: string | null = null;
  let analysisFailed = false;

  try {
    const result = await analyzeMeetingImage(aiImageData, aiImageMimeType, exifText);
    aiAnalysis = result.analysis;
    aiDiagram = result.diagram;
    await db
      .update(meetingImages)
      .set({ aiAnalysis: result.analysis, aiDiagram: result.diagram })
      .where(eq(meetingImages.id, image.id));

    appendSupplementaryToSummary({
      meetingId: input.meetingId,
      marker: `image:${image.id}`,
      heading: `画像: ${image.fileName ?? '無題'}`,
      content: result.analysis,
      elapsedTimeLabel: formatElapsedLabel(image.meetingElapsedMs),
    }).catch((err) => console.error('[agent:attach-image:summaryAppend] failed:', err));
  } catch (err) {
    console.error(`[agent:attach-image] AI 分析失敗 (imageId=${image.id})`, err);
    analysisFailed = true;
  }

  return {
    imageId: image.id,
    fileName: image.fileName,
    aiAnalysis,
    aiDiagram,
    analysisFailed,
  };
}
