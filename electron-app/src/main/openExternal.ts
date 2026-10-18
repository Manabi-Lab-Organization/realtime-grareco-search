import { shell } from 'electron'

const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'mailto:'])

export function isSafeExternalUrl(rawUrl: unknown): rawUrl is string {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) return false
  try {
    return ALLOWED_SCHEMES.has(new URL(rawUrl).protocol)
  } catch {
    return false
  }
}

export function openExternalSafe(rawUrl: unknown): Promise<boolean> {
  if (!isSafeExternalUrl(rawUrl)) {
    console.warn(`[openExternalSafe] 許可されないスキームの URL を拒否しました: ${String(rawUrl)}`)
    return Promise.resolve(false)
  }
  return shell
    .openExternal(rawUrl)
    .then(() => true)
    .catch((err) => {
      console.error('[openExternalSafe] openExternal に失敗しました:', err)
      return false
    })
}
