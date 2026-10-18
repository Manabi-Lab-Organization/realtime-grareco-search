import { APP_VERSION, getHttpURL } from './config'

export const CLIENT_HEADERS: Record<string, string> = {
  'X-Client-Version': APP_VERSION || '0.0.0',
  'X-Client-Platform': 'mobile',
}

export const UPDATE_REQUIRED_MESSAGE = '新しいバージョンに更新してください'

type UpdateRequiredListener = (message: string) => void
const updateRequiredListeners = new Set<UpdateRequiredListener>()

export function onUpdateRequired(listener: UpdateRequiredListener): () => void {
  updateRequiredListeners.add(listener)
  return () => {
    updateRequiredListeners.delete(listener)
  }
}

export function notifyUpdateRequired(message: string = UPDATE_REQUIRED_MESSAGE): void {
  for (const l of updateRequiredListeners) l(message)
}

export class UpdateRequiredError extends Error {
  constructor(message: string = UPDATE_REQUIRED_MESSAGE) {
    super(message)
    this.name = 'UpdateRequiredError'
  }
}

async function handleUpdateRequired(res: Response): Promise<never> {
  const body = await res.json().catch(() => ({}))
  const message = typeof body?.message === 'string' ? body.message : UPDATE_REQUIRED_MESSAGE
  notifyUpdateRequired(message)
  throw new UpdateRequiredError(message)
}

function deviceName(): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  const model = /iPad/.test(ua) ? 'iPad' : /iPhone/.test(ua) ? 'iPhone' : 'iOS'
  return `GraReco (${model})`
}

export type ReloginReason = 'logout_click' | 'session_invalidated' | 'decrypt_failed' | 'encryption_unavailable' | 'no_token'

export interface AuthMe {
  email: string
  role: string
  roomObservationEnabled?: boolean
  roomObservationConsentVersion?: number | null
  roomObservationConsentRequiredVersion?: number
}

export class TokenInvalidError extends Error {
  constructor() {
    super('token_invalid')
    this.name = 'TokenInvalidError'
  }
}

async function extFetch(path: string, token: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${getHttpURL()}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      ...CLIENT_HEADERS,
      Authorization: `Bearer ${token}`,
    },
    signal: AbortSignal.timeout(10000),
  })
  if (res.status === 401) throw new TokenInvalidError()
  if (res.status === 426) await handleUpdateRequired(res)
  return res
}

async function publicFetch(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${getHttpURL()}${path}`, {
    ...init,
    headers: { ...(init?.headers ?? {}), ...CLIENT_HEADERS },
    signal: AbortSignal.timeout(10000),
  })
  if (res.status === 426) await handleUpdateRequired(res)
  return res
}

export async function logoutRemote(token: string): Promise<void> {
  try {
    await fetch(`${getHttpURL()}/api/auth/logout`, {
      method: 'POST',
      headers: { ...CLIENT_HEADERS, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    })
  } catch {
  }
}

export async function mintDesktopExchangeCode(token: string): Promise<string> {
  const res = await extFetch('/api/auth/desktop-exchange-code', token, { method: 'POST' })
  if (!res.ok) throw new Error(`exchange_code_failed_${res.status}`)
  const data = (await res.json()) as { code: string }
  return data.code
}

export interface LoginResult {
  ok: boolean
  token?: string
  user?: {
    id: number
    email: string
    displayName: string | null
    inviteVerified: boolean
    role: string
  }
  error?: string
  message?: string
}

export async function loginWithPassword(email: string, password: string, reloginReason?: ReloginReason): Promise<LoginResult> {
  try {
    const res = await publicFetch('/api/auth/login-with-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, deviceName: deviceName(), clientType: 'mobile', reloginReason }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      return {
        ok: false,
        error: data?.error ?? `http_${res.status}`,
        message: data?.message ?? 'ログインに失敗しました',
      }
    }
    return { ok: true, token: data.token, user: data.user }
  } catch (err) {
    if (err instanceof UpdateRequiredError) return { ok: false, error: 'update_required', message: err.message }
    return {
      ok: false,
      error: 'network_error',
      message: err instanceof Error ? err.message : '通信エラー',
    }
  }
}

export async function getAuthMe(token: string): Promise<AuthMe> {
  const res = await extFetch('/api/ext/auth-me', token)
  if (!res.ok) throw new Error(`auth-me failed: ${res.status}`)
  return res.json()
}

export interface MeetingSummary {
  id: number
  title: string | null
  status: string
  platform?: string | null
  startedAt: string | null
  endedAt: string | null
  duration: number | null
}

export async function getMeetings(token: string): Promise<MeetingSummary[]> {
  const res = await extFetch('/api/ext/meetings', token)
  if (!res.ok) throw new Error(`meetings failed: ${res.status}`)
  const data = (await res.json()) as unknown
  return Array.isArray(data) ? (data as MeetingSummary[]) : []
}

export interface ResearchSettings {
  main: boolean
  web: boolean
  fact: boolean
  gap: boolean
  tech: boolean
}

export async function getResearchSettings(token: string): Promise<ResearchSettings | null> {
  try {
    const res = await extFetch('/api/ext/research-settings', token)
    if (!res.ok) return null
    return (await res.json()) as ResearchSettings
  } catch {
    return null
  }
}

export async function updateResearchSettings(
  token: string,
  patch: Partial<ResearchSettings>,
): Promise<ResearchSettings | null> {
  try {
    const res = await extFetch('/api/ext/research-settings', token, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
    if (!res.ok) return null
    return (await res.json()) as ResearchSettings
  } catch {
    return null
  }
}

export async function postRoomObservationConsent(token: string, version: number): Promise<boolean> {
  try {
    const res = await extFetch('/api/ext/room-observation/consent', token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version }),
    })
    return res.ok
  } catch (err) {
    if (err instanceof TokenInvalidError || err instanceof UpdateRequiredError) throw err
    return false
  }
}

export const ROOM_OBSERVATION_CONSENT_REQUIRED = 'room_observation_consent_required'

export interface UploadObservationResult {
  ok: boolean
  error?: string
}

export async function uploadObservation(
  token: string,
  meetingId: number,
  dataUrl: string,
): Promise<UploadObservationResult> {
  const m = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/)
  if (!m) return { ok: false, error: 'bad_dataurl' }
  try {
    const url = `${getHttpURL()}/api/ext/meetings/${meetingId}/observations`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...CLIENT_HEADERS, Authorization: `Bearer ${token}` },
      body: JSON.stringify({ data: m[2], mimeType: m[1], sourceType: 'camera' }),
      signal: AbortSignal.timeout(60000),
    })
    if (res.status === 401) throw new TokenInvalidError()
    if (res.status === 426) await handleUpdateRequired(res)
    if (res.status === 403) {
      const body = await res.json().catch(() => ({}))
      if (body?.error === ROOM_OBSERVATION_CONSENT_REQUIRED) {
        return { ok: false, error: ROOM_OBSERVATION_CONSENT_REQUIRED }
      }
    }
    if (!res.ok) return { ok: false, error: `http_${res.status}` }
    return { ok: true }
  } catch (err) {
    if (err instanceof TokenInvalidError || err instanceof UpdateRequiredError) throw err
    return { ok: false, error: err instanceof Error ? err.message : 'network_error' }
  }
}

export interface UploadImageResult {
  ok: boolean
  error?: string
}

export async function uploadMeetingImage(
  token: string,
  meetingId: number,
  dataUrl: string,
  fileName?: string,
): Promise<UploadImageResult> {
  const m = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/)
  if (!m) return { ok: false, error: 'bad_dataurl' }
  try {
    const url = `${getHttpURL()}/api/ext/meetings/${meetingId}/images`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...CLIENT_HEADERS, Authorization: `Bearer ${token}` },
      body: JSON.stringify({ data: m[2], mimeType: m[1], ...(fileName ? { fileName } : {}) }),
      signal: AbortSignal.timeout(60000),
    })
    if (res.status === 401) throw new TokenInvalidError()
    if (res.status === 426) await handleUpdateRequired(res)
    if (!res.ok) return { ok: false, error: `http_${res.status}` }
    return { ok: true }
  } catch (err) {
    if (err instanceof TokenInvalidError || err instanceof UpdateRequiredError) throw err
    return { ok: false, error: err instanceof Error ? err.message : 'network_error' }
  }
}
