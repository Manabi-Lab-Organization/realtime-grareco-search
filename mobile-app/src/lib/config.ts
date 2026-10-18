import { Preferences } from '@capacitor/preferences'

export const APP_VERSION = __APP_VERSION__

const SERVER_KEY = 'serverHttpBase'

let httpBase = ''

export function getHttpURL(): string {
  return httpBase
}

export function getWsURL(): string {
  if (!httpBase) return ''
  return `${httpBase.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:')}/ws`
}

export async function loadServer(): Promise<string> {
  const { value } = await Preferences.get({ key: SERVER_KEY })
  httpBase = value || __DEFAULT_HTTP_URL__ || ''
  return httpBase
}

export async function saveServer(base: string): Promise<void> {
  httpBase = base
  await Preferences.set({ key: SERVER_KEY, value: base })
}
