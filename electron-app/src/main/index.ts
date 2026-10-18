import {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  desktopCapturer,
  session,
  systemPreferences,
  screen,
  globalShortcut,
  dialog,
  powerMonitor
} from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import type { StoreSchema } from './store'
import {
  getSettings,
  saveSettings,
  setSavedMeetingId,
  getSavedMeetingId,
  loadTokenAtStartup,
  DEFAULT_SCREENSHOT_SHORTCUT
} from './store'
import { wsManager } from './websocket'
import {
  openWebWindow,
  closeAllWebWindows,
  clearAllSessionCookies,
  setMainWindowReference,
  revalidateWebWindows
} from './webWindowManager'
import { logAuthEvent, getPendingReloginReason, clearPendingReloginReason } from './authLog'
import { openExternalSafe } from './openExternal'
import {
  apiFetch,
  ApiNotReadyError,
  checkUpdateRequired,
  clientHeaders,
  getApiBaseURL,
  setOnTokenInvalid,
  wsUrlToHttpUrl
} from './apiClient'
import { hostname } from 'os'
import { normalizeServerInput, checkServerInfo } from './serverUrl'
import { net } from 'electron'

async function mintDesktopExchangeCode(): Promise<string> {
  const res = await apiFetch('/api/auth/desktop-exchange-code', { method: 'POST' })
  if (!res.ok) throw new Error(`exchange_code_failed_${res.status}`)
  const data = (await res.json()) as { code: string }
  return data.code
}

interface LoginUser {
  id: number
  email: string
  displayName: string | null
  inviteVerified: boolean
  role: string
}
type LoginResult = { ok: true; user: LoginUser } | { ok: false; error: string; message: string }

function completeLogin(token: unknown, user: unknown): LoginResult {
  if (typeof token !== 'string' || !token) {
    return { ok: false, error: 'no_token', message: 'ログイン応答にトークンがありません' }
  }
  saveSettings({ token, savedMeetingId: null })
  clearPendingReloginReason()
  return { ok: true, user: user as LoginUser }
}

function loginClientInfo(): Record<string, string> {
  const os = process.platform === 'darwin' ? 'Mac' : process.platform === 'win32' ? 'Windows' : 'Linux'
  let host = ''
  try {
    host = hostname().replace(/\.local$/, '').slice(0, 64)
  } catch {
    host = ''
  }
  const base = `GraReco (${os})`
  return {
    deviceName: (host ? `${base} - ${host}` : base).slice(0, 100),
    clientType: 'desktop'
  }
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0
}

function isInternalPath(p: unknown): p is string {
  return (
    typeof p === 'string' &&
    p.length > 0 &&
    p.length < 2048 &&
    p.startsWith('/') &&
    !p.startsWith('//') &&
    !p.includes('\\') &&
    !/[\u0000-\u001f]/.test(p)
  )
}

function trustedCaptureOrigin(): string | null {
  const { serverURL } = getSettings()
  if (!serverURL) return null
  try {
    return new URL(wsUrlToHttpUrl(serverURL)).origin
  } catch {
    return null
  }
}
function isTrustedCaptureOrigin(rawUrl: string): boolean {
  if (!rawUrl) return false
  if (rawUrl.startsWith('file://')) return true
  try {
    const u = new URL(rawUrl)
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return true
    return u.origin === trustedCaptureOrigin()
  } catch {
    return false
  }
}

const RENDERER_INDEX_FILE_URL = pathToFileURL(join(__dirname, '../renderer/index.html')).href
function isAppOwnURL(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl)
    if (u.protocol === 'file:') {
      return `${u.protocol}//${u.host}${u.pathname}` === RENDERER_INDEX_FILE_URL
    }
    const devURL = is.dev ? process.env['ELECTRON_RENDERER_URL'] : undefined
    return !!devURL && u.origin === new URL(devURL).origin
  } catch {
    return false
  }
}

let windowMode: 'expanded' | 'compact' = 'expanded'
let expandedBounds: { width: number; height: number; x: number; y: number } | null = null

let isRecordingNow = false
function updateRecordingIndicator(): void {
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setBadge(isRecordingNow ? '●' : '')
  }
}

const MAIN_MIN_WIDTH = 640
const MAIN_MIN_HEIGHT = 400

function createWindow(): BrowserWindow {
  const settings = getSettings()
  const rawBounds = settings.windowBounds

  let bounds: { width: number; height: number; x?: number; y?: number } | null = null
  if (rawBounds && rawBounds.width >= MAIN_MIN_WIDTH && rawBounds.height >= MAIN_MIN_HEIGHT) {
    bounds = rawBounds
  } else if (rawBounds) {
    console.warn(
      `[MainWindow] discarding invalid persisted bounds: ${JSON.stringify(rawBounds)} ` +
        `(min ${MAIN_MIN_WIDTH}x${MAIN_MIN_HEIGHT})`,
    )
    saveSettings({ windowBounds: null })
  }

  const mainWindow = new BrowserWindow({
    width: bounds?.width ?? 900,
    height: bounds?.height ?? 560,
    x: bounds?.x,
    y: bounds?.y,
    minWidth: MAIN_MIN_WIDTH,
    minHeight: MAIN_MIN_HEIGHT,
    show: false,
    title: 'Realtime GraReco & Search',
    tabbingIdentifier: '',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
    if (mainWindow.isMinimized()) {
      console.log('[MainWindow] starting minimized — forcing restore')
      mainWindow.restore()
    }
  })

  mainWindow.on('minimize', () => console.log('[MainWindow] minimize'))
  mainWindow.on('restore', () => console.log('[MainWindow] restore'))
  mainWindow.on('focus', () => console.log('[MainWindow] focus'))
  mainWindow.on('blur', () => console.log('[MainWindow] blur'))

  let boundsTimer: ReturnType<typeof setTimeout> | null = null
  const persistBounds = (): void => {
    if (windowMode !== 'expanded') return
    if (boundsTimer) clearTimeout(boundsTimer)
    boundsTimer = setTimeout(() => {
      if (mainWindow.isDestroyed()) return
      const [width, height] = mainWindow.getSize()
      const [x, y] = mainWindow.getPosition()
      if (width < MAIN_MIN_WIDTH || height < MAIN_MIN_HEIGHT) {
        console.warn(
          `[MainWindow] skip persisting too-small bounds: ${width}x${height}`,
        )
        return
      }
      saveSettings({ windowBounds: { width, height, x, y } })
    }, 500)
  }
  mainWindow.on('resize', persistBounds)
  mainWindow.on('moved', persistBounds)

  mainWindow.on('close', (e) => {
    if (isRecordingNow && !mainWindow.isDestroyed()) {
      const choice = dialog.showMessageBoxSync(mainWindow, {
        type: 'warning',
        buttons: ['キャンセル', '文字起こしを中断して閉じる'],
        defaultId: 0,
        cancelId: 0,
        title: '文字起こし中です',
        message: '文字起こし中です。ウィンドウを閉じると文字起こしが中断されます。',
        detail: '文字起こしを続ける場合は「キャンセル」を押してください。',
      })
      if (choice === 0) {
        e.preventDefault()
      }
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    void openExternalSafe(details.url)
    return { action: 'deny' }
  })
  const blockForeignNavigation = (event: Electron.Event, url: string): void => {
    if (isAppOwnURL(url)) return
    event.preventDefault()
    console.warn(`[MainWindow] blocked navigation to ${url}`)
    if (/^https?:\/\//i.test(url)) void openExternalSafe(url)
  }
  mainWindow.webContents.on('will-navigate', blockForeignNavigation)
  mainWindow.webContents.on('will-redirect', blockForeignNavigation)
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault())

  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      const frameURL = request.frame?.url ?? ''
      if (!isTrustedCaptureOrigin(frameURL)) {
        console.warn(`[DisplayMedia] 信頼できないオリジンからのキャプチャ要求を拒否: ${frameURL}`)
        callback({})
        return
      }
      desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
        if (sources.length > 0) {
          callback({ video: sources[0], audio: 'loopback' })
        } else {
          callback({})
        }
      })
    },
    { useSystemPicker: false }
  )

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  wsManager.setMainWindow(mainWindow)
  setMainWindowReference(mainWindow)

  return mainWindow
}

let startupAuthReported = false

function reloginInfo(): Record<string, string> {
  const r = getPendingReloginReason()
  return r ? { reloginReason: r } : {}
}

function setupIPC(): void {
  ipcMain.on('app:setRecordingState', (_event, recording: boolean) => {
    isRecordingNow = !!recording
    updateRecordingIndicator()
  })

  ipcMain.handle('settings:get', async () => {
    const failure = await loadTokenAtStartup()
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { token, pendingReloginReason: _pending, ...rest } = getSettings()
    let tokenReadFailed = false
    if (!startupAuthReported) {
      startupAuthReported = true
      if (failure) {
        logAuthEvent(failure.reason, failure.detail)
        tokenReadFailed = true
      } else if (!token) {
        logAuthEvent('no_token')
      }
    }
    return { ...rest, loggedIn: !!token, tokenReadFailed }
  })

  ipcMain.handle('settings:save', (_event, settings) => {
    if (!settings || typeof settings !== 'object') return
    const src = settings as Record<string, unknown>
    const sanitized: Partial<StoreSchema> = {}
    if (
      Object.prototype.hasOwnProperty.call(src, 'savedMeetingId') &&
      (src.savedMeetingId === null || typeof src.savedMeetingId === 'number')
    ) {
      sanitized.savedMeetingId = src.savedMeetingId as number | null
    }
    if (
      Object.prototype.hasOwnProperty.call(src, 'meetingMode') &&
      (src.meetingMode === 'online' || src.meetingMode === 'real')
    ) {
      sanitized.meetingMode = src.meetingMode
    }
    saveSettings(sanitized)
  })

  ipcMain.handle('server:set', async (_event, raw: unknown) => {
    if (typeof raw !== 'string') return { ok: false, message: '接続先のアドレスを入力してください' }
    const normalized = normalizeServerInput(raw)
    if ('error' in normalized) return { ok: false, message: normalized.error }
    let info: unknown
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 10_000)
      const res = await net.fetch(`${normalized.httpBase}/api/server-info`, {
        headers: clientHeaders(),
        signal: controller.signal
      })
      clearTimeout(timer)
      if (res.status === 426) {
        return { ok: false, message: 'このアプリは古いため、このサーバには接続できません。最新版に更新してください' }
      }
      if (!res.ok) {
        return { ok: false, message: 'このアドレスでは Realtime GraReco & Search のサーバが見つかりませんでした。アドレスを確かめてください' }
      }
      info = await res.json().catch(() => null)
    } catch {
      return { ok: false, message: 'サーバに接続できませんでした。アドレスと、ネットワークにつながっているかを確かめてください' }
    }
    const checked = checkServerInfo(info)
    if ('error' in checked) return { ok: false, message: checked.error }

    const { serverURL: current, token } = getSettings()
    if (current !== normalized.wsURL) {
      wsManager.disconnect()
      if (current && token) {
        try {
          await apiFetch('/api/auth/logout', { method: 'POST', timeoutMs: 5000, handleAuthErrors: false })
        } catch {
        }
      }
      closeAllWebWindows()
      if (current) await clearAllSessionCookies(current)
      saveSettings({ serverURL: normalized.wsURL, token: '', savedMeetingId: null })
      logAuthEvent('server_changed')
    }
    return { ok: true, serverURL: normalized.wsURL, httpBase: normalized.httpBase, serverVersion: checked.version }
  })

  ipcMain.handle('meeting:getSavedId', () => {
    return getSavedMeetingId()
  })

  ipcMain.handle('meeting:setSavedId', (_event, id: number | null) => {
    setSavedMeetingId(id)
  })

  ipcMain.handle('ws:connect', () => {
    const { serverURL, token } = getSettings()
    if (!serverURL || !token) return
    wsManager.connect(serverURL, token)
  })

  ipcMain.handle('ws:disconnect', () => {
    wsManager.disconnect()
  })

  ipcMain.handle('ws:getStatus', () => {
    return wsManager.getStatus()
  })

  ipcMain.handle('ws:startMeeting', (_event, mode: 'online' | 'real', meetingType?: string) => {
    wsManager.startMeeting(mode, meetingType)
  })

  ipcMain.handle('ws:resumeMeeting', (_event, meetingId: number, mode: 'online' | 'real', auto?: boolean) => {
    wsManager.resumeMeeting(meetingId, mode, auto ?? false)
  })

  ipcMain.handle('ws:pauseMeeting', () => {
    wsManager.pauseMeeting()
  })

  ipcMain.handle('ws:resetTranscription', () => {
    wsManager.resetTranscription()
  })

  ipcMain.handle('ws:endMeeting', () => {
    wsManager.endMeeting()
  })

  ipcMain.handle('ws:dismissTerm', (_event, term: string) => {
    wsManager.dismissTerm(term)
  })

  ipcMain.on('audio:send', (_event, data: ArrayBuffer) => {
    wsManager.sendAudioChunk(Buffer.from(data))
  })

  ipcMain.handle('shell:openExternal', (_event, url: string) => {
    return openExternalSafe(url)
  })

  ipcMain.handle('permissions:check', () => {
    if (process.platform !== 'darwin') {
      return { microphone: 'granted' as const, screen: 'granted' as const }
    }
    return {
      microphone: systemPreferences.getMediaAccessStatus('microphone'),
      screen: systemPreferences.getMediaAccessStatus('screen')
    }
  })

  ipcMain.handle('permissions:requestMicrophone', async () => {
    if (process.platform !== 'darwin') return true
    return systemPreferences.askForMediaAccess('microphone')
  })

  ipcMain.handle('permissions:triggerScreenCapture', async () => {
    if (process.platform !== 'darwin') return true
    try {
      await desktopCapturer.getSources({ types: ['screen'] })
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle('permissions:openScreenRecordingSettings', () => {
    if (process.platform === 'darwin') {
      shell.openExternal(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
      )
    }
  })

  ipcMain.handle('app:relaunch', () => {
    app.relaunch()
    app.exit(0)
  })

  ipcMain.handle('app:getVersion', () => app.getVersion())

  ipcMain.handle('app:openThirdPartyNotices', async () => {
    const file = app.isPackaged
      ? join(process.resourcesPath, 'THIRD_PARTY_NOTICES.txt')
      : join(app.getAppPath(), 'build', 'THIRD_PARTY_NOTICES.txt')
    const error = await shell.openPath(file)
    return error ? { ok: false as const, error } : { ok: true as const }
  })

  ipcMain.handle('window:setCompact', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win || win.isDestroyed()) return

    const [w, h] = win.getSize()
    const [x, y] = win.getPosition()
    expandedBounds = { width: w, height: h, x, y }
    saveSettings({ windowBounds: { width: w, height: h, x, y } })

    windowMode = 'compact'

    win.setAlwaysOnTop(true, 'floating')
    win.setMinimumSize(360, 72)
    win.setResizable(false)
    if (process.platform === 'darwin') {
      win.setWindowButtonVisibility(false)
    }

    const compactWidth = 480
    const compactHeight = 88
    const margin = 16
    const display = screen.getDisplayNearestPoint({ x, y })
    const newX = display.workArea.x + display.workArea.width - compactWidth - margin
    const newY = display.workArea.y + display.workArea.height - compactHeight - margin
    win.setBounds({ x: newX, y: newY, width: compactWidth, height: compactHeight })

    win.webContents.send('window:mode-changed', 'compact')
  })

  ipcMain.handle('window:setExpanded', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win || win.isDestroyed()) return

    windowMode = 'expanded'

    win.setAlwaysOnTop(false)
    win.setMinimumSize(640, 400)
    win.setResizable(true)
    if (process.platform === 'darwin') {
      win.setWindowButtonVisibility(true)
    }

    if (expandedBounds) {
      win.setBounds(expandedBounds)
    } else {
      win.setSize(900, 560)
    }

    win.webContents.send('window:mode-changed', 'expanded')
  })

  ipcMain.handle('window:getMode', () => {
    return windowMode
  })

  ipcMain.handle('api:getSiteConfig', async (): Promise<unknown | null> => {
    try {
      const res = await apiFetch('/api/site-config', { auth: false, timeoutMs: 8000 })
      if (!res.ok) return null
      return await res.json()
    } catch {
      return null
    }
  })

  ipcMain.handle('api:fetchMeetings', async (): Promise<unknown[]> => {
    try {
      const res = await apiFetch('/api/ext/meetings')
      if (!res.ok) return []
      const data = await res.json()
      return Array.isArray(data) ? data : []
    } catch {
      return []
    }
  })

  ipcMain.handle('api:fetchMeetingDetail', async (_event, meetingId: unknown): Promise<unknown | null> => {
    try {
      if (!isPositiveInt(meetingId)) return null
      const res = await apiFetch(`/api/ext/meetings/${meetingId}`)
      if (!res.ok) return null
      return await res.json()
    } catch {
      return null
    }
  })

  ipcMain.handle('api:fetchAnnouncements', async (): Promise<unknown[]> => {
    try {
      const res = await apiFetch('/api/announcements')
      if (!res.ok) return []
      const data = await res.json()
      return Array.isArray(data) ? data : []
    } catch {
      return []
    }
  })

  ipcMain.handle('api:markReadAnnouncement', async (_event, id: unknown): Promise<boolean> => {
    try {
      if (!isPositiveInt(id)) return false
      const res = await apiFetch(`/api/announcements/${id}/read`, { method: 'POST' })
      return res.ok
    } catch {
      return false
    }
  })

  ipcMain.handle(
    'api:updateMeetingTitle',
    async (
      _event,
      meetingId: unknown,
      title: unknown,
    ): Promise<{ ok: true; title: string } | { ok: false; error: string }> => {
      try {
        if (!isPositiveInt(meetingId)) return { ok: false, error: 'invalid_meeting' }
        const trimmed = typeof title === 'string' ? title.trim() : ''
        if (!trimmed) return { ok: false, error: 'empty_title' }
        const res = await apiFetch(`/api/ext/meetings/${meetingId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: trimmed }),
        })
        if (!res.ok) {
          const data = await res.json().catch(() => ({}))
          return { ok: false, error: data?.error ?? `http_${res.status}` }
        }
        const data = await res.json()
        return { ok: true, title: data?.title ?? trimmed }
      } catch (err) {
        if (err instanceof ApiNotReadyError) return { ok: false, error: 'not_logged_in' }
        return { ok: false, error: err instanceof Error ? err.message : 'network_error' }
      }
    },
  )

  ipcMain.handle(
    'api:getAuthMe',
    async (): Promise<{
      email: string
      role: string
      roomObservationEnabled?: boolean
      roomObservationConsentVersion?: number | null
      roomObservationConsentRequiredVersion?: number
    } | null> => {
      try {
        const res = await apiFetch('/api/ext/auth-me')
        if (!res.ok) {
          console.log('[Auth] getAuthMe HTTP', res.status)
          return null
        }
        return await res.json()
      } catch (err) {
        console.log('[Auth] getAuthMe error', err instanceof Error ? err.message : err)
        return null
      }
    },
  )

  ipcMain.handle(
    'auth:loginWithEmail',
    async (_event, email: unknown, password: unknown): Promise<LoginResult> => {
      try {
        if (typeof email !== 'string' || typeof password !== 'string') {
          return { ok: false, error: 'invalid_input', message: 'メールアドレスとパスワードを入力してください' }
        }
        const res = await apiFetch('/api/auth/login-with-token', {
          auth: false,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password, ...loginClientInfo(), ...reloginInfo() }),
          timeoutMs: 15000,
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
          return {
            ok: false,
            error: data?.error ?? `http_${res.status}`,
            message: data?.message ?? data?.error ?? 'ログインに失敗しました',
          }
        }
        return completeLogin(data?.token, data?.user)
      } catch (err) {
        return {
          ok: false,
          error: 'network_error',
          message: err instanceof Error ? err.message : 'ネットワークエラー',
        }
      }
    },
  )

  ipcMain.handle('auth:loginWithGoogle', async (_event, credential: unknown): Promise<LoginResult> => {
    try {
      if (typeof credential !== 'string' || !credential) {
        return { ok: false, error: 'no_credential', message: 'Google 認証情報がありません' }
      }
      const res = await apiFetch('/api/auth/google-with-token', {
        auth: false,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential, ...loginClientInfo(), ...reloginInfo() }),
        timeoutMs: 15000,
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        return {
          ok: false,
          error: data?.error ?? `http_${res.status}`,
          message: data?.message ?? data?.error ?? 'Google ログインに失敗しました',
        }
      }
      return completeLogin(data?.token, data?.user)
    } catch (err) {
      return {
        ok: false,
        error: 'network_error',
        message: err instanceof Error ? err.message : 'ネットワークエラー',
      }
    }
  })

  ipcMain.handle('auth:getGoogleClientId', async (): Promise<{ clientId: string } | null> => {
    try {
      const res = await apiFetch('/api/auth/google/client-id', { auth: false })
      if (!res.ok) return null
      return await res.json()
    } catch {
      return null
    }
  })

  ipcMain.handle('auth:loginViaWebWindow', async (): Promise<LoginResult> => {
    const baseURL = getApiBaseURL()
    if (!baseURL) return { ok: false, error: 'no_server', message: 'サーバー URL が未設定です' }
    const isMac = process.platform === 'darwin'
    const PARTITION = 'persist:grareco-login'

    try {
      const partitionSession = session.fromPartition(PARTITION)
      await partitionSession.clearStorageData({
        origin: baseURL,
        storages: ['cookies'],
      })
    } catch (err) {
      console.warn('[auth:loginViaWebWindow] cookie clear failed:', err)
    }

    const loginWin = new BrowserWindow({
      title: 'Realtime GraReco & Search にログイン',
      width: 520,
      height: 760,
      resizable: true,
      minimizable: false,
      maximizable: false,
      titleBarStyle: isMac ? 'hiddenInset' : 'default',
      autoHideMenuBar: !isMac,
      backgroundColor: '#f0f4ff',
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        partition: PARTITION,
      },
      show: true,
    })
    if (!isMac) loginWin.setMenuBarVisibility(false)
    loginWin.once('ready-to-show', () => {
      if (!loginWin.isVisible()) loginWin.show()
    })

    const tokenReqBody = JSON.stringify({ ...loginClientInfo(), ...reloginInfo() })
    const tokenReqHeaders = JSON.stringify({ 'Content-Type': 'application/json', ...clientHeaders() })

    return new Promise<LoginResult>((resolve) => {
      let resolved = false

      const finishWith = (result: LoginResult): void => {
        if (resolved) return
        resolved = true
        if (!loginWin.isDestroyed()) loginWin.close()
        resolve(result)
      }

      const tryGetToken = async (): Promise<void> => {
        if (resolved || loginWin.isDestroyed()) return
        try {
          if (new URL(loginWin.webContents.getURL()).origin !== new URL(baseURL).origin) return
        } catch {
          return
        }
        try {
          const me = await loginWin.webContents.executeJavaScript(
            `fetch('/api/auth/me', { credentials: 'include' }).then(r => r.ok ? r.json() : null)`,
            true,
          )
          if (!me) return
          const tok = await loginWin.webContents.executeJavaScript(
            `fetch('/api/auth/token', { method: 'POST', credentials: 'include', headers: ${tokenReqHeaders}, body: ${JSON.stringify(tokenReqBody)} })` +
              `.then(r => { if (r.status === 426) return { __updateRequired: true }; return r.ok ? r.json() : null })`,
            true,
          )
          if (tok?.__updateRequired) {
            checkUpdateRequired(426)
            finishWith({ ok: false, error: 'update_required', message: '新しいバージョンに更新してください' })
            return
          }
          if (!tok?.token) {
            return
          }
          finishWith(
            completeLogin(tok.token, {
              id: me.id,
              email: me.email,
              displayName: me.displayName ?? null,
              inviteVerified: !!me.inviteVerified,
              role: me.role ?? 'user',
            }),
          )
        } catch (err) {
          console.log('[auth:loginViaWebWindow] tryGetToken error:', err instanceof Error ? err.message : err)
        }
      }

      loginWin.webContents.on('did-navigate', tryGetToken)
      loginWin.webContents.on('did-navigate-in-page', tryGetToken)
      loginWin.webContents.on('did-finish-load', tryGetToken)

      loginWin.on('closed', () => {
        if (!resolved) {
          resolve({
            ok: false,
            error: 'cancelled',
            message: 'ログインがキャンセルされました',
          })
        }
      })

      loginWin.loadURL(`${baseURL}/login`).catch((err) => {
        finishWith({
          ok: false,
          error: 'load_failed',
          message: err instanceof Error ? err.message : 'ログイン画面のロードに失敗しました',
        })
      })
    })
  })

  ipcMain.handle('auth:logout', async (_event, reason?: unknown) => {
    const { serverURL, token } = getSettings()
    if (reason !== 'session_invalidated' && token) logAuthEvent('logout_click')
    wsManager.disconnect()
    if (serverURL && token) {
      try {
        await apiFetch('/api/auth/logout', { method: 'POST', timeoutMs: 5000, handleAuthErrors: false })
      } catch (err) {
        console.warn('[auth:logout] server logout failed:', err instanceof Error ? err.message : err)
      }
    }
    saveSettings({ token: '' })
    closeAllWebWindows()
    if (serverURL) await clearAllSessionCookies(serverURL)
    return { ok: true }
  })

  ipcMain.handle(
    'web:openWindow',
    (
      _event,
      params: { key: string; path: string; title?: string; width?: number; height?: number },
    ): { ok: true } | { ok: false; error: string } => {
      const { serverURL, token } = getSettings()
      if (!token) return { ok: false, error: 'not_logged_in' }
      if (!serverURL) return { ok: false, error: 'no_server' }
      if (!params || typeof params.key !== 'string' || !isInternalPath(params.path)) {
        return { ok: false, error: 'invalid_params' }
      }
      try {
        openWebWindow({
          key: params.key,
          serverURL,
          mintCode: () => mintDesktopExchangeCode(),
          path: params.path,
          title: typeof params.title === 'string' ? params.title : undefined,
          width: typeof params.width === 'number' ? params.width : undefined,
          height: typeof params.height === 'number' ? params.height : undefined,
        })
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'unknown' }
      }
    },
  )

  ipcMain.handle(
    'web:openInBrowser',
    async (_event, path: unknown): Promise<{ ok: true } | { ok: false; error: string }> => {
      const { serverURL, token } = getSettings()
      if (!token) return { ok: false, error: 'not_logged_in' }
      if (!serverURL) return { ok: false, error: 'no_server' }
      if (!isInternalPath(path)) return { ok: false, error: 'invalid_path' }
      try {
        const baseURL = wsUrlToHttpUrl(serverURL)
        const sep = path.includes('?') ? '&' : '?'
        const pathWithFlag = `${path}${sep}from=desktop`
        let code: string | null = null
        try {
          code = await mintDesktopExchangeCode()
        } catch (err) {
          console.warn('[web:openInBrowser] exchange code failed, opening plain URL:', err instanceof Error ? err.message : err)
        }
        if (!getSettings().token) return { ok: false, error: 'not_logged_in' }
        const target = code
          ? `${baseURL}/api/auth/desktop-exchange` +
            `?code=${encodeURIComponent(code)}` +
            `&redirect=${encodeURIComponent(pathWithFlag)}`
          : `${baseURL}${pathWithFlag}`
        await openExternalSafe(target)
        return { ok: true }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'unknown' }
      }
    },
  )

  ipcMain.handle('capture:allDisplays', async () => {
    const displays = screen.getAllDisplays()
    const maxW = Math.max(...displays.map((d) => Math.round(d.size.width * d.scaleFactor)), 1920)
    const maxH = Math.max(...displays.map((d) => Math.round(d.size.height * d.scaleFactor)), 1080)
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: maxW, height: maxH }
    })
    return sources.map((s, i) => {
      const size = s.thumbnail.getSize()
      return {
        id: s.id,
        name: s.name || `画面 ${i + 1}`,
        displayId: s.display_id,
        dataUrl: s.thumbnail.toDataURL(),
        width: size.width,
        height: size.height
      }
    })
  })

  ipcMain.handle(
    'api:uploadScreenshot',
    async (_event, meetingId: number, dataUrl: string, fileName?: string) => {
      if (!isPositiveInt(meetingId)) return { ok: false, error: 'invalid_meeting' }
      const m = typeof dataUrl === 'string' ? dataUrl.match(/^data:(image\/[a-zA-Z+]+);base64,(.*)$/) : null
      if (!m) return { ok: false, error: 'bad_dataurl' }
      try {
        const res = await apiFetch(`/api/ext/meetings/${meetingId}/images`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            data: m[2],
            mimeType: m[1],
            fileName: typeof fileName === 'string' && fileName ? fileName : 'screenshot.png'
          }),
          timeoutMs: 30000
        })
        if (!res.ok) return { ok: false, error: `http_${res.status}` }
        return { ok: true, image: await res.json() }
      } catch (err) {
        if (err instanceof ApiNotReadyError) return { ok: false, error: 'no_auth' }
        return { ok: false, error: err instanceof Error ? err.message : 'unknown' }
      }
    }
  )

  ipcMain.handle('capture:listWindows', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 320, height: 200 },
      fetchWindowIcons: false
    })
    return sources
      .filter((s) => s.name && s.name.trim())
      .map((s) => ({ id: s.id, name: s.name, dataUrl: s.thumbnail.toDataURL() }))
  })

  ipcMain.handle('capture:windowShot', async (_event, windowId: string, windowName?: string) => {
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 1920, height: 1200 }
    })
    let match = sources.find((s) => s.id === windowId)
    if (!match && windowName) match = sources.find((s) => s.name === windowName)
    if (!match) return { ok: false, error: 'window_not_found' }
    return { ok: true, dataUrl: match.thumbnail.toDataURL(), name: match.name }
  })

  ipcMain.handle('api:postRoomObservationConsent', async (_event, version: number) => {
    if (!isPositiveInt(version)) return { ok: false, error: 'invalid_version' }
    try {
      const res = await apiFetch('/api/ext/room-observation/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version })
      })
      if (!res.ok) return { ok: false, error: `http_${res.status}` }
      return { ok: true }
    } catch (err) {
      if (err instanceof ApiNotReadyError) return { ok: false, error: 'no_auth' }
      return { ok: false, error: err instanceof Error ? err.message : 'unknown' }
    }
  })

  ipcMain.handle(
    'api:uploadObservation',
    async (
      _event,
      meetingId: number,
      dataUrl: string,
      opts?: {
        sourceType?: 'camera' | 'window'
        location?: { lat: number; lng: number; source?: string }
      }
    ) => {
      if (!isPositiveInt(meetingId)) return { ok: false, error: 'invalid_meeting' }
      const m = typeof dataUrl === 'string' ? dataUrl.match(/^data:(image\/[a-zA-Z+]+);base64,(.*)$/) : null
      if (!m) return { ok: false, error: 'bad_dataurl' }
      const sourceType = opts?.sourceType ?? 'camera'
      try {
        const res = await apiFetch(`/api/ext/meetings/${meetingId}/observations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            data: m[2],
            mimeType: m[1],
            fileName: sourceType === 'window' ? 'observation-window.jpg' : 'observation.jpg',
            sourceType,
            ...(opts?.location ? { location: opts.location } : {})
          }),
          timeoutMs: 60000
        })
        if (res.status === 403) {
          const body = await res.json().catch(() => ({}))
          if (body?.error === 'room_observation_consent_required') {
            return { ok: false, error: 'room_observation_consent_required' }
          }
        }
        if (!res.ok) return { ok: false, error: `http_${res.status}` }
        return { ok: true, observation: await res.json() }
      } catch (err) {
        if (err instanceof ApiNotReadyError) return { ok: false, error: 'no_auth' }
        return { ok: false, error: err instanceof Error ? err.message : 'unknown' }
      }
    }
  )

  ipcMain.handle('shortcut:get', () => getSettings().screenshotShortcut || DEFAULT_SCREENSHOT_SHORTCUT)
  ipcMain.handle('shortcut:set', (_event, accel: string) => {
    const result = registerCaptureShortcut(accel)
    if (result.ok) saveSettings({ screenshotShortcut: accel })
    return result
  })
}

function registerCaptureShortcut(accel: string): { ok: boolean; error?: string } {
  globalShortcut.unregisterAll()
  if (!accel) return { ok: true }
  try {
    const ok = globalShortcut.register(accel, () => {
      const main = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
      main?.webContents.send('shortcut:capture')
    })
    return ok ? { ok: true } : { ok: false, error: 'register_failed' }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'unknown' }
  }
}

function focusMainWindow(): void {
  const main = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
  if (main) {
    if (main.isMinimized()) main.restore()
    main.show()
    main.focus()
  }
}

app.setAsDefaultProtocolClient('grareco')

app.on('open-url', (event) => {
  event.preventDefault()
  focusMainWindow()
})

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  console.log('[App] Another instance already running — quitting this one.')
  app.quit()
} else {
  app.on('second-instance', () => {
    focusMainWindow()
  })
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('jp.manabi-lab.grareco')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  setupIPC()
  setOnTokenInvalid(() => {
    if (!getSettings().token) return
    logAuthEvent('token_invalid')
    saveSettings({ token: '' })
    wsManager.disconnect()
    closeAllWebWindows()
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('ws:session-invalidated')
    }
  })
  createWindow()

  powerMonitor.on('resume', () => {
    setTimeout(() => {
      wsManager.reconnectNow()
      void revalidateWebWindows()
    }, 3000)
  })

  registerCaptureShortcut(getSettings().screenshotShortcut || DEFAULT_SCREENSHOT_SHORTCUT)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  wsManager.destroy()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
