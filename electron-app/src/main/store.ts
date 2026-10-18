import Store from 'electron-store'
import { safeStorage } from 'electron'

export interface StoreSchema {
  serverURL: string
  token: string
  meetingMode: 'online' | 'real'
  savedMeetingId: number | null
  windowBounds: { width: number; height: number; x?: number; y?: number } | null
  screenshotShortcut: string
  pendingReloginReason: string | null
}

export const DEFAULT_SCREENSHOT_SHORTCUT = 'CommandOrControl+Shift+2'

const store = new Store<StoreSchema>({
  name: 'config',
  defaults: {
    serverURL: __SERVER_URL__,
    token: '',
    meetingMode: 'online',
    savedMeetingId: null,
    windowBounds: null,
    screenshotShortcut: DEFAULT_SCREENSHOT_SHORTCUT,
    pendingReloginReason: null
  }
})

const ENC_TOKEN_PREFIX = 'enc:v1:'

function isEncryptedToken(stored: string): boolean {
  return typeof stored === 'string' && stored.startsWith(ENC_TOKEN_PREFIX)
}

function encryptTokenForStore(plain: string): string {
  if (!plain) return ''
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn('[store] safeStorage が利用不可のため、トークンを平文で保存します')
    return plain
  }
  try {
    const encrypted = safeStorage.encryptString(plain)
    return ENC_TOKEN_PREFIX + encrypted.toString('base64')
  } catch (err) {
    console.warn('[store] トークンの暗号化に失敗したため平文で保存します:', err)
    return plain
  }
}

export type TokenReadFailureReason = 'decrypt_failed' | 'encryption_unavailable'
export interface TokenReadFailure {
  reason: TokenReadFailureReason
  detail?: string
}

let tokenCache: string | undefined

type ReadResult = { token: string; failure: TokenReadFailure | null }

function readStoredTokenOnce(): ReadResult {
  const stored = store.get('token')
  if (typeof stored !== 'string' || !stored) return { token: '', failure: null }
  if (!isEncryptedToken(stored)) {
    const reEncrypted = encryptTokenForStore(stored)
    if (isEncryptedToken(reEncrypted)) store.set('token', reEncrypted)
    return { token: stored, failure: null }
  }
  if (!safeStorage.isEncryptionAvailable()) {
    return { token: '', failure: { reason: 'encryption_unavailable' } }
  }
  try {
    const b64 = stored.slice(ENC_TOKEN_PREFIX.length)
    return { token: safeStorage.decryptString(Buffer.from(b64, 'base64')), failure: null }
  } catch (err) {
    return {
      token: '',
      failure: { reason: 'decrypt_failed', detail: err instanceof Error ? err.message : String(err) }
    }
  }
}

export function hasStoredToken(): boolean {
  const stored = store.get('token')
  return typeof stored === 'string' && stored.length > 0
}

let startupLoad: Promise<TokenReadFailure | null> | null = null

export function loadTokenAtStartup(): Promise<TokenReadFailure | null> {
  if (startupLoad) return startupLoad
  startupLoad = (async () => {
    const delays = [0, 1000, 3000]
    let last: ReadResult = { token: '', failure: null }
    for (let i = 0; i < delays.length; i++) {
      if (delays[i]) await new Promise((r) => setTimeout(r, delays[i]))
      last = readStoredTokenOnce()
      if (!last.failure) {
        tokenCache = last.token
        return null
      }
      console.warn(
        `[store] トークン読み出し失敗 (試行 ${i + 1}/${delays.length}): ${last.failure.reason}` +
          (last.failure.detail ? ` — ${last.failure.detail}` : '')
      )
    }
    tokenCache = ''
    return last.failure
  })()
  return startupLoad
}

export function getSettings(): StoreSchema {
  const raw = { ...store.store } as StoreSchema
  if (tokenCache === undefined) {
    const r = readStoredTokenOnce()
    if (!r.failure) tokenCache = r.token
    raw.token = r.token
  } else {
    raw.token = tokenCache
  }
  return raw
}

export function saveSettings(settings: Partial<StoreSchema>): void {
  if (Object.prototype.hasOwnProperty.call(settings, 'token')) {
    const plain = settings.token ?? ''
    store.set({ ...settings, token: encryptTokenForStore(plain) })
    tokenCache = plain
  } else {
    store.set(settings)
  }
}

export function getSavedMeetingId(): number | null {
  return store.get('savedMeetingId')
}

export function setSavedMeetingId(id: number | null): void {
  store.set('savedMeetingId', id)
}

export { store }
