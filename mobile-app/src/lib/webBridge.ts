
import { Browser } from '@capacitor/browser'
import { getHttpURL } from './config'
import { mintDesktopExchangeCode } from './api'

export async function openInWeb(path: string, token: string, toolbarColor?: string): Promise<void> {
  const url = await buildExchangeURL(path, token)
  await Browser.open({
    url,
    presentationStyle: 'popover',
    ...(toolbarColor ? { toolbarColor } : {}),
  })
}

async function buildExchangeURL(path: string, token: string): Promise<string> {
  const code = await mintDesktopExchangeCode(token)
  return (
    `${getHttpURL()}/api/auth/desktop-exchange` +
    `?code=${encodeURIComponent(code)}` +
    `&redirect=${encodeURIComponent(path)}`
  )
}

export async function closeWeb(): Promise<void> {
  try {
    await Browser.close()
  } catch {
  }
}
