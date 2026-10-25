import sharp from 'sharp';

const DATA_URL_RE = /^data:(image\/[\w.+-]+);base64,(.+)$/s;

export const DEFAULT_GRARECO_WEBP_QUALITY = 85;
export const EMAIL_JPEG_QUALITY = 90;

const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export function extensionForMime(mimeType: string): string {
  return MIME_EXTENSIONS[mimeType.toLowerCase()] ?? 'png';
}

export function parseImageDataUrl(imageUrl: string): { mimeType: string; data: Buffer } | null {
  const m = imageUrl.match(DATA_URL_RE);
  if (!m) return null;
  return { mimeType: m[1].toLowerCase(), data: Buffer.from(m[2], 'base64') };
}

export function grarecoWebpQuality(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.GRARECO_WEBP_QUALITY?.trim();
  if (!raw) return DEFAULT_GRARECO_WEBP_QUALITY;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_GRARECO_WEBP_QUALITY;
  if (n <= 0) return 0;
  return Math.min(100, Math.max(1, Math.round(n)));
}

export async function compressGrarecoImageUrl(
  imageUrl: string,
  label: string,
  quality: number = grarecoWebpQuality(),
): Promise<string> {
  if (quality <= 0) return imageUrl;
  const parsed = parseImageDataUrl(imageUrl);
  if (!parsed || parsed.mimeType === 'image/webp') return imageUrl;
  const started = Date.now();
  try {
    const webp = await sharp(parsed.data).webp({ quality }).toBuffer();
    console.log(
      `[grareco:webp] ${label} ${parsed.mimeType} ${parsed.data.length}B -> image/webp ${webp.length}B quality=${quality} ${Date.now() - started}ms`,
    );
    return `data:image/webp;base64,${webp.toString('base64')}`;
  } catch (err) {
    console.warn(
      `[grareco:webp] ${label} WebP への変換に失敗したため、元の画像のまま保存します: ${err instanceof Error ? err.message : String(err)}`,
    );
    return imageUrl;
  }
}

export async function withCompressedGrarecoImage<T extends { imageUrl: string }>(result: T, label: string): Promise<T> {
  return { ...result, imageUrl: await compressGrarecoImageUrl(result.imageUrl, label) };
}

export async function toEmailAttachmentImage(imageUrl: string): Promise<{ content: Buffer; extension: string } | null> {
  const parsed = parseImageDataUrl(imageUrl);
  if (!parsed) return null;
  try {
    const jpeg = await sharp(parsed.data)
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: EMAIL_JPEG_QUALITY })
      .toBuffer();
    return { content: jpeg, extension: 'jpg' };
  } catch (err) {
    console.warn(`[grareco:email] JPEG への変換に失敗したため、元の画像を添付します: ${err instanceof Error ? err.message : String(err)}`);
    return { content: parsed.data, extension: extensionForMime(parsed.mimeType) };
  }
}
