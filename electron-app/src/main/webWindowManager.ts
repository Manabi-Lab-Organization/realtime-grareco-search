
import { BrowserWindow, session } from 'electron'
import { openExternalSafe } from './openExternal'
import { wsUrlToHttpUrl } from './apiClient'

function isSameServerOrigin(url: string, serverURL: string): boolean {
  try {
    return new URL(url).origin === new URL(wsUrlToHttpUrl(serverURL)).origin
  } catch {
    return false
  }
}

const openWindows = new Map<string, BrowserWindow>()

let mainWindowRef: BrowserWindow | null = null

export function setMainWindowReference(win: BrowserWindow): void {
  mainWindowRef = win
}

export interface OpenWebWindowParams {
  key: string
  serverURL: string
  mintCode: () => Promise<string>
  path: string
  title?: string
  width?: number
  height?: number
}

async function buildExchangeURL(params: OpenWebWindowParams, path = params.path): Promise<string> {
  const baseHttpURL = wsUrlToHttpUrl(params.serverURL)
  const code = await params.mintCode()
  return (
    `${baseHttpURL}/api/auth/desktop-exchange` +
    `?code=${encodeURIComponent(code)}` +
    `&redirect=${encodeURIComponent(path)}`
  )
}

interface WebWindowState {
  params: OpenWebWindowParams
  lastPath: string
  lastReexchangeAt: number
}
const windowStates = new Map<BrowserWindow, WebWindowState>()
const REEXCHANGE_MIN_INTERVAL_MS = 60 * 1000

function isLoginPath(pathname: string): boolean {
  return pathname === '/login' || pathname.startsWith('/login/')
}

function reexchange(win: BrowserWindow, why: string): void {
  const st = windowStates.get(win)
  if (!st || win.isDestroyed()) return
  const now = Date.now()
  if (now - st.lastReexchangeAt < REEXCHANGE_MIN_INTERVAL_MS) {
    console.warn(`[webWindowManager:${st.params.key}] re-exchange skipped (rate limit) reason=${why}`)
    return
  }
  st.lastReexchangeAt = now
  console.log(`[webWindowManager:${st.params.key}] session lost (${why}) — re-exchanging to ${st.lastPath}`)
  buildExchangeURL(st.params, st.lastPath)
    .then((url) => (win.isDestroyed() ? undefined : win.loadURL(url)))
    .catch((err) => {
      console.error(`[webWindowManager:${st.params.key}] re-exchange failed:`, err instanceof Error ? err.message : err)
    })
}

function trackNavigation(win: BrowserWindow, url: string, httpCode: number): void {
  const st = windowStates.get(win)
  if (!st) return
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return
  }
  if (!isSameServerOrigin(url, st.params.serverURL)) return
  if (isLoginPath(u.pathname) || httpCode === 401) {
    reexchange(win, isLoginPath(u.pathname) ? 'login_redirect' : 'http_401')
    return
  }
  if (!u.pathname.startsWith('/api/')) st.lastPath = `${u.pathname}${u.search}`
}

export async function revalidateWebWindows(): Promise<void> {
  for (const [win, st] of windowStates) {
    if (win.isDestroyed()) continue
    if (!isSameServerOrigin(win.webContents.getURL(), st.params.serverURL)) continue
    try {
      const ok = await win.webContents.executeJavaScript(
        `fetch('/api/auth/me', { credentials: 'include' }).then(r => r.ok).catch(() => null)`,
        true,
      )
      if (ok === false) reexchange(win, 'resume_session_expired')
    } catch (err) {
      console.warn(`[webWindowManager:${st.params.key}] revalidate failed:`, err instanceof Error ? err.message : err)
    }
  }
}

const MEETING_DETAIL_EXCLUSIVE_KEYS = new Set([
  'active-meeting',
])
function isMeetingDetailKey(key: string): boolean {
  return MEETING_DETAIL_EXCLUSIVE_KEYS.has(key) || key.startsWith('meeting:')
}

export function openWebWindow(params: OpenWebWindowParams): BrowserWindow {
  const existing = openWindows.get(params.key)
  if (existing && !existing.isDestroyed()) {
    const currentURL = existing.webContents.getURL()
    const alreadyOnTarget =
      currentURL.endsWith(params.path) ||
      currentURL.endsWith(params.path + '/') ||
      currentURL.includes(`redirect=${encodeURIComponent(params.path)}`)
    if (!alreadyOnTarget) {
      buildExchangeURL(params)
        .then((url) => existing.loadURL(url))
        .catch((err) => {
          console.error('[webWindowManager] loadURL on existing failed:', err)
        })
    }
    const st = windowStates.get(existing)
    if (st) {
      st.params = params
      if (!alreadyOnTarget) st.lastPath = params.path
    }
    if (params.title) existing.setTitle(params.title)
    if (existing.isMinimized()) existing.restore()
    existing.focus()
    return existing
  }

  if (isMeetingDetailKey(params.key)) {
    for (const [otherKey, otherWin] of openWindows) {
      if (otherKey === params.key) continue
      if (otherWin.isDestroyed()) continue
      if (!isMeetingDetailKey(otherKey)) continue
      console.log(`[webWindowManager] closing stale meeting window key=${otherKey}`)
      try {
        otherWin.close()
      } catch (e) {
        console.warn(`[webWindowManager] failed to close ${otherKey}:`, e)
      }
    }
  }

  const isMac = process.platform === 'darwin'

  let initialX: number | undefined
  let initialY: number | undefined
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    const mb = mainWindowRef.getBounds()
    initialX = mb.x + 60
    initialY = mb.y + 60
  }

  const win = new BrowserWindow({
    title: params.title ?? 'Realtime GraReco & Search',
    width: params.width ?? 1280,
    height: params.height ?? 800,
    x: initialX,
    y: initialY,
    minWidth: 900,
    minHeight: 600,
    minimizable: false,
    backgroundColor: '#f0f4ff',
    titleBarStyle: 'default',
    tabbingIdentifier: '',
    parent: undefined,
    autoHideMenuBar: !isMac,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
    show: true,
  })

  if (!isMac) {
    win.setMenuBarVisibility(false)
  }

  win.webContents.on('page-title-updated', (e, pageTitle) => {
    e.preventDefault()
    if (pageTitle && pageTitle !== 'Realtime GraReco & Search') {
      win.setTitle(`${pageTitle}`)
    }
  })

  win.once('ready-to-show', () => {
    if (!win.isVisible()) win.show()
    win.focus()
  })

  setTimeout(() => {
    if (!win.isDestroyed() && !win.isVisible()) {
      console.warn(`[webWindowManager:${params.key}] window not visible after 5s, forcing show`)
      win.show()
    }
  }, 5000)

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSameServerOrigin(url, params.serverURL)) {
      void win.loadURL(url)
      return { action: 'deny' }
    }
    if (/^https?:\/\//i.test(url)) void openExternalSafe(url)
    return { action: 'deny' }
  })

  const guardNavigation = (kind: string) => (event: Electron.Event, url: string): void => {
    if (isSameServerOrigin(url, params.serverURL)) {
      console.log(`[webWindowManager:${params.key}] ${kind} -> ${url.replace(/code=[^&]+/, 'code=***')}`)
      return
    }
    event.preventDefault()
    console.warn(`[webWindowManager:${params.key}] blocked ${kind} to foreign origin: ${url}`)
    if (/^https?:\/\//i.test(url)) void openExternalSafe(url)
  }
  win.webContents.on('will-navigate', guardNavigation('will-navigate'))
  win.webContents.on('will-redirect', guardNavigation('will-redirect'))
  win.webContents.on('will-attach-webview', (event) => event.preventDefault())

  win.on('closed', () => {
    openWindows.delete(params.key)
    windowStates.delete(win)
  })

  win.on('focus', () => console.log(`[WebWindow:${params.key}] focus`))
  win.on('blur', () => console.log(`[WebWindow:${params.key}] blur`))
  win.on('restore', () => console.log(`[WebWindow:${params.key}] restore`))
  win.on('minimize', () => {
    console.warn(`[WebWindow:${params.key}] minimize fired (minimizable:false なのに発火) — 即 restore`)
    setTimeout(() => {
      if (!win.isDestroyed() && win.isMinimized()) {
        win.restore()
      }
    }, 50)
  })

  win.webContents.on('did-redirect-navigation', (_e, url) => {
    console.log(`[webWindowManager:${params.key}] redirect-> ${url}`)
  })
  win.webContents.on('did-navigate', (_e, url, httpCode) => {
    console.log(`[webWindowManager:${params.key}] did-navigate ${httpCode} ${url.replace(/code=[^&]+/, 'code=***')}`)
    trackNavigation(win, url, httpCode)
  })
  win.webContents.on('did-navigate-in-page', (_e, url, isMainFrame) => {
    if (isMainFrame) trackNavigation(win, url, 200)
  })
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[webWindowManager:${params.key}] did-fail-load ${code} ${desc} ${url}`)
  })
  win.webContents.on('did-finish-load', () => {
    console.log(`[webWindowManager:${params.key}] finish-load: ${win.webContents.getURL()}`)
  })

  openWindows.set(params.key, win)
  windowStates.set(win, { params, lastPath: params.path, lastReexchangeAt: 0 })

  buildExchangeURL(params)
    .then((exchangeURL) => {
      console.log(
        `[webWindowManager:${params.key}] loadURL -> ${exchangeURL.replace(/code=[^&]+/, 'code=***')}`,
      )
      return win.loadURL(exchangeURL)
    })
    .catch((err) => {
      console.error('[webWindowManager] buildExchange/loadURL failed:', err)
      if (!win.isDestroyed()) win.close()
    })

  return win
}

export function closeAllWebWindows(): void {
  for (const win of openWindows.values()) {
    if (!win.isDestroyed()) {
      win.close()
    }
  }
  openWindows.clear()
  windowStates.clear()
}

export async function clearAllSessionCookies(serverURL: string): Promise<void> {
  const baseHttpURL = wsUrlToHttpUrl(serverURL)
  try {
    const cookies = await session.defaultSession.cookies.get({ name: 'connect.sid' })
    for (const c of cookies) {
      const scheme = c.secure ? 'https' : 'http'
      const host = c.domain?.replace(/^\./, '') ?? new URL(baseHttpURL).host
      const url = `${scheme}://${host}${c.path ?? '/'}`
      try {
        await session.defaultSession.cookies.remove(url, c.name)
      } catch {
      }
    }
  } catch (err) {
    console.warn('[webWindowManager] clearAllSessionCookies failed:', err)
  }
}
