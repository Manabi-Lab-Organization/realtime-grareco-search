import { useCallback, useEffect, useState } from 'react'
import LoginScreen from './components/LoginScreen'
import ServerSetupScreen from './components/ServerSetupScreen'
import RecordingPlaceholder from './components/RecordingPlaceholder'
import { clearToken, getToken, setToken } from './lib/tokenStore'
import { getAuthMe, logoutRemote, onUpdateRequired, TokenInvalidError, UpdateRequiredError, type AuthMe, type ReloginReason } from './lib/api'
import { getHttpURL, loadServer } from './lib/config'

type Stage = 'loading' | 'server' | 'login' | 'ready'

function AppInner() {
  const [stage, setStage] = useState<Stage>('loading')
  const [token, setLocalToken] = useState<string | null>(null)
  const [me, setMe] = useState<AuthMe | null>(null)
  const [bootError, setBootError] = useState<string | null>(null)
  const [loginNotice, setLoginNotice] = useState<string | null>(null)
  const [reloginReason, setReloginReason] = useState<ReloginReason | undefined>(undefined)

  const checkToken = useCallback(async (existing: string | null) => {
    setBootError(null)
    setLoginNotice(null)
    if (!existing) {
      setReloginReason('no_token')
      setStage('login')
      return
    }
    try {
      const fetched = await getAuthMe(existing)
      setMe(fetched)
      setLocalToken(existing)
      setStage('ready')
    } catch (err) {
      if (err instanceof TokenInvalidError) {
        await clearToken()
        setReloginReason('session_invalidated')
        setStage('login')
      } else if (err instanceof UpdateRequiredError) {
        setStage('login')
      } else {
        setBootError(err instanceof Error ? err.message : 'ネットワークエラー')
        setStage('login')
      }
    }
  }, [])

  useEffect(() => {
    void (async () => {
      const server = await loadServer()
      if (!server) {
        setStage('server')
        return
      }
      await checkToken(await getToken())
    })()
  }, [checkToken])

  async function handleServerSaved(changed: boolean) {
    if (changed) {
      if (token) await logoutRemote(token).catch(() => {})
      await clearToken()
      setLocalToken(null)
      setMe(null)
      await checkToken(null)
    } else {
      await checkToken(await getToken())
    }
  }

  async function handleLoggedIn(newToken: string) {
    await setToken(newToken)
    await checkToken(newToken)
  }

  async function handleLogout(reason: 'logout_click' | 'session_invalidated' = 'logout_click') {
    if (token && reason === 'logout_click') await logoutRemote(token)
    setReloginReason(reason)
    await clearToken()
    setLocalToken(null)
    setMe(null)
    setStage('login')
  }

  if (stage === 'loading') {
    return (
      <div className="flex h-full items-center justify-center text-sm text-gray-500">
        読み込み中...
      </div>
    )
  }

  if (stage === 'server') {
    return (
      <ServerSetupScreen
        onSaved={(changed) => void handleServerSaved(changed)}
        onCancel={getHttpURL() ? () => void getToken().then(checkToken) : undefined}
      />
    )
  }

  if (stage === 'login') {
    return (
      <div className="flex h-full flex-col">
        {bootError && (
          <div className="bg-red-900/40 border-b border-red-700 px-4 py-2 text-xs text-red-200">
            前回の起動でエラー: {bootError}
          </div>
        )}
        {loginNotice && (
          <div className="bg-amber-900/40 border-b border-amber-700 px-4 py-2 text-xs text-amber-100">
            {loginNotice}
          </div>
        )}
        <div className="flex-1">
          <LoginScreen onLoggedIn={handleLoggedIn} reloginReason={reloginReason} onChangeServer={() => setStage('server')} />
        </div>
      </div>
    )
  }

  if (stage === 'ready' && me && token) {
    return (
      <RecordingPlaceholder
        email={me.email}
        token={token}
        onLogout={handleLogout}
        roomObservationEnabled={me.roomObservationEnabled === true}
        roomObservationConsentVersion={me.roomObservationConsentVersion ?? null}
        roomObservationConsentRequiredVersion={me.roomObservationConsentRequiredVersion ?? null}
      />
    )
  }

  return null
}

function App() {
  const [updateMessage, setUpdateMessage] = useState<string | null>(null)
  useEffect(() => onUpdateRequired((message) => setUpdateMessage(message)), [])

  if (updateMessage) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-base font-bold">{updateMessage}</p>
        <p className="text-xs text-gray-500">App Store からこのアプリを最新版に更新してから、もう一度開いてください。</p>
      </div>
    )
  }

  return (
    <>
      <AppInner />
    </>
  )
}

export default App
