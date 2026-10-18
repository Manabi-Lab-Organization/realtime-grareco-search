
export const DEFAULT_GRARECO_MODEL = 'gemini-3.1-flash-image';

export const GEMINI_IMAGE_COST_USD = 0.067;

const GEMINI_IMAGE_TOKENS_1K = 1_120;
const GEMINI_RATE_INPUT_PER_M = 0.5;
const GEMINI_RATE_TEXT_OUTPUT_PER_M = 3;
const GEMINI_RATE_IMAGE_OUTPUT_PER_M = 60;

export function geminiImageCostUsd(usage?: {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  imageTokenCount?: number;
}): number | undefined {
  if (!usage) return undefined;
  const input = usage.promptTokenCount ?? 0;
  const output = usage.candidatesTokenCount ?? 0;
  if (!input && !output) return undefined;
  const imageTokens = usage.imageTokenCount ?? Math.min(output, GEMINI_IMAGE_TOKENS_1K);
  const textTokens = Math.max(0, output - imageTokens);
  return (
    (imageTokens * GEMINI_RATE_IMAGE_OUTPUT_PER_M +
      textTokens * GEMINI_RATE_TEXT_OUTPUT_PER_M +
      input * GEMINI_RATE_INPUT_PER_M) /
    1_000_000
  );
}

export function readImageTokenCount(usageMetadata: unknown): number | undefined {
  const details = (usageMetadata as any)?.candidatesTokensDetails;
  if (!Array.isArray(details)) return undefined;
  const image = details.find((d: any) => d?.modality === 'IMAGE');
  return typeof image?.tokenCount === 'number' ? image.tokenCount : undefined;
}

export function grarecoRefImageCount(): number {
  const n = Number(process.env.GRARECO_REF_IMAGES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export interface GrarecoImageResult {
  imageUrl: string;
  modelUsed: string;
  costUsd?: number;
  aspectRatio?: string;
  imageDimensions?: string;
  refImagesUsed?: number;
  attempt?: number;
  imageQuality?: string;
  draftSections?: number;
  draftKind?: string;
  fallbackReason?: string;
}

export function decideAspectRatio(contentLength: number): string {
  if (contentLength < 3_000) return '16:9';
  if (contentLength < 10_000) return '4:3';
  return '1:1';
}

export interface GrarecoAttempt {
  refCount: number;
  aspectRatio?: string;
  delayMs?: number;
}

export function buildAttemptLadder(refImageCount: number, aspectRatio: string): GrarecoAttempt[] {
  if (refImageCount > 0) {
    return [
      { refCount: refImageCount, aspectRatio },
      { refCount: 0, aspectRatio },
      { refCount: 0, delayMs: 2000 },
      { refCount: 0, delayMs: 3000 },
      { refCount: 0, delayMs: 5000 },
    ];
  }
  return [
    { refCount: 0, aspectRatio },
    { refCount: 0, delayMs: 2000 },
    { refCount: 0, delayMs: 3000 },
    { refCount: 0, delayMs: 5000 },
    { refCount: 0, delayMs: 5000 },
  ];
}

export function readImageDimensions(buf: Buffer): string | undefined {
  if (buf.length > 24 && buf.toString('hex', 0, 8) === '89504e470d0a1a0a') {
    return `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`;
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return `${buf.readUInt16BE(i + 7)}x${buf.readUInt16BE(i + 5)}`;
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return undefined;
}
