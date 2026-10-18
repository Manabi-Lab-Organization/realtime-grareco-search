import { KeychainAccess, SecureStorage } from '@aparajita/capacitor-secure-storage'

const TOKEN_KEY = 'apiToken'

export async function getToken(): Promise<string | null> {
  const value = await SecureStorage.get(TOKEN_KEY, false, false)
  return typeof value === 'string' && value ? value : null
}

export async function setToken(token: string): Promise<void> {
  await SecureStorage.set(TOKEN_KEY, token, false, false, KeychainAccess.whenUnlockedThisDeviceOnly)
}

export async function clearToken(): Promise<void> {
  await SecureStorage.remove(TOKEN_KEY, false)
}
