import { Camera, CameraResultType, CameraSource } from '@capacitor/camera'
import { uploadMeetingImage } from './api'

const MAX_EDGE = 1600
const JPEG_QUALITY = 0.8

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('image_load_failed'))
    img.src = src
  })
}

async function toJpegDataUrl(srcUrl: string): Promise<string> {
  const img = await loadImage(srcUrl)
  const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight))
  const w = Math.max(1, Math.round(img.naturalWidth * scale))
  const h = Math.max(1, Math.round(img.naturalHeight * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas_unavailable')
  ctx.drawImage(img, 0, 0, w, h)
  return canvas.toDataURL('image/jpeg', JPEG_QUALITY)
}

export interface BatchResult {
  uploaded: number
  failed: number
  total: number
  cancelled?: boolean
}

function isCancel(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /cancel/i.test(msg)
}

export async function addImagesFromLibrary(
  token: string,
  meetingId: number,
  onProgress?: (done: number, total: number) => void,
): Promise<BatchResult> {
  let photos
  try {
    const picked = await Camera.pickImages({ quality: 90 })
    photos = picked.photos ?? []
  } catch (err) {
    if (isCancel(err)) return { uploaded: 0, failed: 0, total: 0, cancelled: true }
    throw err
  }
  let uploaded = 0
  let failed = 0
  for (let i = 0; i < photos.length; i++) {
    onProgress?.(i, photos.length)
    try {
      const src = photos[i].webPath
      if (!src) {
        failed++
        continue
      }
      const dataUrl = await toJpegDataUrl(src)
      const r = await uploadMeetingImage(token, meetingId, dataUrl, `補足画像${i + 1}`)
      if (r.ok) uploaded++
      else failed++
    } catch {
      failed++
    }
  }
  onProgress?.(photos.length, photos.length)
  return { uploaded, failed, total: photos.length }
}

export async function addImageFromCamera(
  token: string,
  meetingId: number,
): Promise<BatchResult> {
  let dataUrl: string | undefined
  try {
    const photo = await Camera.getPhoto({
      source: CameraSource.Camera,
      resultType: CameraResultType.DataUrl,
      quality: 80,
      width: MAX_EDGE,
      correctOrientation: true,
    })
    dataUrl = photo.dataUrl
  } catch (err) {
    if (isCancel(err)) return { uploaded: 0, failed: 0, total: 0, cancelled: true }
    throw err
  }
  if (!dataUrl) return { uploaded: 0, failed: 1, total: 1 }
  const r = await uploadMeetingImage(token, meetingId, dataUrl, '撮影画像')
  return { uploaded: r.ok ? 1 : 0, failed: r.ok ? 0 : 1, total: 1 }
}
