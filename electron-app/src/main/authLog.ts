
import { app } from 'electron'
import { appendFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { store } from './store'

export type ReloginReason =
  | 'logout_click'
  | 'session_invalidated'
  | 'decrypt_failed'
  | 'encryption_unavailable'
  | 'no_token'

export type AuthLogReason = ReloginReason | 'token_invalid' | 'server_changed'

const SERVER_REASON: Record<AuthLogReason, ReloginReason> = {
  logout_click: 'logout_click',
  session_invalidated: 'session_invalidated',
  decrypt_failed: 'decrypt_failed',
  encryption_unavailable: 'encryption_unavailable',
  no_token: 'no_token',
  token_invalid: 'session_invalidated',
  server_changed: 'logout_click'
}

function osVersion(): string {
  try {
    const name = process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : process.platform
    return `${name} ${process.getSystemVersion()}`
  } catch {
    return process.platform
  }
}

export function logAuthEvent(reason: AuthLogReason, detail?: string): void {
  const entry = {
    at: new Date().toISOString(),
    reason,
    ...(detail ? { detail: detail.slice(0, 500) } : {}),
    appVersion: app.getVersion(),
    os: osVersion()
  }
  console.log('[auth-log]', JSON.stringify(entry))
  try {
    const dir = app.getPath('logs')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'auth.log'), JSON.stringify(entry) + '\n', 'utf8')
  } catch (err) {
    console.warn('[auth-log] write failed:', err instanceof Error ? err.message : err)
  }
  try {
    if (reason !== 'no_token' || !store.get('pendingReloginReason')) {
      store.set('pendingReloginReason', SERVER_REASON[reason])
    }
  } catch {
  }
}

export function getPendingReloginReason(): ReloginReason | undefined {
  const v = store.get('pendingReloginReason')
  return typeof v === 'string' && v in SERVER_REASON ? (v as ReloginReason) : undefined
}

export function clearPendingReloginReason(): void {
  try {
    store.set('pendingReloginReason', null)
  } catch {
  }
}
