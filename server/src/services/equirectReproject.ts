
import sharp from 'sharp';

const VIEW_YAWS_DEG = [0, 90, 180, 270];
const VIEW_HFOV_DEG = 120;
const OUT_W = 960;
const OUT_H = 540;

export const VIEW_LABELS = ['前方(view1)', '右側(view2)', '後方(view3)', '左側(view4)'];

export function isEquirectangular(width: number, height: number): boolean {
  if (!width || !height) return false;
  const ratio = width / height;
  return ratio >= 1.9 && ratio <= 2.1;
}

const lutCache = new Map<string, Int32Array[]>();

function buildLut(srcW: number, srcH: number, yawRad: number): Int32Array {
  const lut = new Int32Array(OUT_W * OUT_H);
  const tanHalf = Math.tan((VIEW_HFOV_DEG * Math.PI) / 180 / 2);
  const aspect = OUT_H / OUT_W;
  const cosY = Math.cos(yawRad);
  const sinY = Math.sin(yawRad);
  const TWO_PI = Math.PI * 2;

  for (let j = 0; j < OUT_H; j++) {
    const ny = (2 * (j + 0.5)) / OUT_H - 1;
    const yc = -ny * tanHalf * aspect;
    for (let i = 0; i < OUT_W; i++) {
      const nx = (2 * (i + 0.5)) / OUT_W - 1;
      const xc = nx * tanHalf;
      const X = xc * cosY + sinY;
      const Z = -xc * sinY + cosY;
      const Y = yc;
      const lon = Math.atan2(X, Z);
      const lat = Math.atan2(Y, Math.hypot(X, Z));
      let sx = Math.round((lon / TWO_PI + 0.5) * srcW);
      let sy = Math.round((0.5 - lat / Math.PI) * srcH);
      sx = ((sx % srcW) + srcW) % srcW;
      if (sy < 0) sy = 0;
      else if (sy >= srcH) sy = srcH - 1;
      lut[j * OUT_W + i] = sy * srcW + sx;
    }
  }
  return lut;
}

function getLuts(srcW: number, srcH: number): Int32Array[] {
  const key = `${srcW}x${srcH}`;
  let luts = lutCache.get(key);
  if (!luts) {
    luts = VIEW_YAWS_DEG.map((deg) => buildLut(srcW, srcH, (deg * Math.PI) / 180));
    lutCache.set(key, luts);
  }
  return luts;
}

export async function reprojectEquirectToViews(imageBuffer: Buffer): Promise<Buffer[]> {
  const { data: src, info } = await sharp(imageBuffer)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const srcW = info.width;
  const srcH = info.height;
  const ch = info.channels;

  const luts = getLuts(srcW, srcH);
  const views: Buffer[] = [];

  for (const lut of luts) {
    const out = Buffer.allocUnsafe(OUT_W * OUT_H * 3);
    for (let p = 0; p < lut.length; p++) {
      const s = lut[p] * ch;
      const d = p * 3;
      out[d] = src[s];
      out[d + 1] = src[s + 1];
      out[d + 2] = src[s + 2];
    }
    const jpeg = await sharp(out, { raw: { width: OUT_W, height: OUT_H, channels: 3 } })
      .jpeg({ quality: 80 })
      .toBuffer();
    views.push(jpeg);
  }
  return views;
}
