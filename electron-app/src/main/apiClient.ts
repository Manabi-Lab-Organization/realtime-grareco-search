
import { app, BrowserWindow, dialog, net } from 'electron'
import { getSettings } from './store'
import { openExternalSafe } from './openExternal'

export function wsUrlToHttpUrl(wsUrl: string): string {
  return wsUrl.replace('wss://', 'https://').replace('ws://', 'http://').replace(/\/ws$/, '')
}

export function getApiBaseURL(): string {
  const { serverURL } = getSettings()
  return serverURL ? wsUrlToHttpUrl(serverURL) : ''
}

export function getClientVersion(): string {
  return app.getVersion()
}

export function clientHeaders(): Record<string, string> {
  return { 'X-Client-Version': getClientVersion(), 'X-Client-Platform': 'desktop' }
}

export const DEFAULT_UPDATE_MESSAGE = '新しいバージョンに更新してください'

let onTokenInvalid: (() => void) | null = null
export function setOnTokenInvalid(fn: () => void): void {
  onTokenInvalid = fn
}
export function notifyTokenInvalid(): void {
  console.warn('[api] token_invalid — clearing stored token')
  onTokenInvalid?.()
}

let updateDialogOpen = false
let updateDialogLastClosedAt = 0
const UPDATE_DIALOG_COOLDOWN_MS = 30 * 60 * 1000

export function getDownloadPageURL(): string {
  const base = getApiBaseURL()
  return base ? `${base}/download` : 'https://github.com/Manabi-Lab-Organization/realtime-grareco-search/releases/latest'
}

export function showUpdateRequiredDialog(serverMessage?: string): void {
  if (updateDialogOpen) return
  if (updateDialogLastClosedAt && Date.now() - updateDialogLastClosedAt < UPDATE_DIALOG_COOLDOWN_MS) return
  updateDialogOpen = true
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    title: 'アップデートが必要です',
    message: serverMessage || DEFAULT_UPDATE_MESSAGE,
    detail:
      'お使いのデスクトップアプリは古いバージョンのため、サーバーに接続できません。\n' +
      'ダウンロードページから最新版をインストールしてください。',
    buttons: ['ダウンロードページを開く', '閉じる'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  }
  const p = win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options)
  p.then(({ response }) => {
    if (response === 0) void openExternalSafe(getDownloadPageURL())
  })
    .catch((err) => console.error('[update] dialog failed:', err))
    .finally(() => {
      updateDialogOpen = false
      updateDialogLastClosedAt = Date.now()
    })
}

export function checkUpdateRequired(status: number, serverMessage?: string): boolean {
  if (status !== 426) return false
  console.warn('[api] server responded 426 update_required')
  showUpdateRequiredDialog(serverMessage)
  return true
}

export class ApiNotReadyError extends Error {}

interface ApiFetchOptions extends Omit<RequestInit, 'signal'> {
  auth?: boolean
  timeoutMs?: number
  handleAuthErrors?: boolean
}

export async function apiFetch(path: string, opts: ApiFetchOptions = {}): Promise<Response> {
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('invalid_api_path')
  const { auth = true, timeoutMs = 10000, handleAuthErrors = true, headers: extraHeaders, ...init } = opts
  const { serverURL, token } = getSettings()
  if (!serverURL) throw new ApiNotReadyError('no_server')
  if (auth && !token) throw new ApiNotReadyError('not_logged_in')
  const headers = new Headers(extraHeaders)
  for (const [k, v] of Object.entries(clientHeaders())) headers.set(k, v)
  if (auth) headers.set('Authorization', `Bearer ${token}`)
  const res = await net.fetch(`${wsUrlToHttpUrl(serverURL)}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(timeoutMs)
  })
  if (!handleAuthErrors) return res
  if (res.status === 426) {
    const body = await res.clone().json().catch(() => null)
    checkUpdateRequired(426, typeof body?.message === 'string' ? body.message : undefined)
  } else if (res.status === 401 && auth) {
    const body = await res.clone().json().catch(() => null)
    if (body?.code === 'token_invalid') notifyTokenInvalid()
  }
  return res
}
