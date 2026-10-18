
export const SERVER_APP_ID = 'realtime-grareco-search'

export const SUPPORTED_API_LEVEL = 1

export interface NormalizedServer {
  httpBase: string
  wsURL: string
}

export interface ServerInfo {
  app: string
  version: string
  apiLevel: number
  minDesktopVersion: string | null
  minMobileVersion: string | null
}

function isPrivateHost(host: string): boolean {
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return true
  if (host.endsWith('.local')) return true
  const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

export function normalizeServerInput(raw: string): NormalizedServer | { error: string } {
  const input = raw.trim()
  if (!input) return { error: '接続先のアドレスを入力してください' }
  const withScheme = /^[a-z]+:\/\//i.test(input) ? input : `https://${input}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return { error: 'アドレスの形が正しくありません（例: https://grareco.example.co.jp）' }
  }
  const scheme = url.protocol.replace(':', '')
  const secure = scheme === 'https' || scheme === 'wss'
  const plain = scheme === 'http' || scheme === 'ws'
  if (!secure && !plain) return { error: 'https:// で始まるアドレスを入力してください' }
  if (plain && !isPrivateHost(url.hostname)) {
    return { error: '暗号化されていない http:// は、組織の中のネットワーク（プライベートアドレス）だけで使えます。https:// のアドレスを入力してください' }
  }
  if (url.username || url.password) return { error: 'アドレスにユーザー名やパスワードは含めないでください' }
  const host = url.host
  return {
    httpBase: `${secure ? 'https' : 'http'}://${host}`,
    wsURL: `${secure ? 'wss' : 'ws'}://${host}/ws`,
  }
}

export function checkServerInfo(info: unknown): ServerInfo | { error: string } {
  const i = info as Partial<ServerInfo> | null
  if (!i || i.app !== SERVER_APP_ID) {
    return { error: 'このアドレスでは Realtime GraReco & Search のサーバが見つかりませんでした。アドレスを確かめてください' }
  }
  if (typeof i.apiLevel === 'number' && i.apiLevel > SUPPORTED_API_LEVEL) {
    return { error: 'サーバが新しくなっています。アプリを最新版に更新してから接続してください' }
  }
  return {
    app: i.app,
    version: typeof i.version === 'string' ? i.version : '',
    apiLevel: typeof i.apiLevel === 'number' ? i.apiLevel : 1,
    minDesktopVersion: i.minDesktopVersion ?? null,
    minMobileVersion: i.minMobileVersion ?? null,
  }
}
