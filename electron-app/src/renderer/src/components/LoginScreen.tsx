
import { useEffect, useRef, useState } from 'react'
import { LegalLinks } from './LegalLinks'

interface GoogleUser {
  id: number
  email: string
  displayName: string | null
  inviteVerified: boolean
  role: string
}

interface Props {
  serverURL: string
  onLoggedIn: (user: GoogleUser) => void
  notice?: string | null
  onCancel?: () => void
  onChangeServer?: () => void
}

declare global {
  interface Window {
    google?: {
      accounts?: {
        id?: {
          initialize: (config: {
            client_id: string
            callback: (response: { credential: string }) => void
          }) => void
          renderButton: (
            parent: HTMLElement,
            options: {
              theme?: 'outline' | 'filled_blue' | 'filled_black'
              size?: 'large' | 'medium' | 'small'
              text?: 'signin_with' | 'signup_with' | 'continue_with' | 'signin'
              shape?: 'rectangular' | 'pill' | 'circle' | 'square'
              logo_alignment?: 'left' | 'center'
              width?: number
            },
          ) => void
          prompt: () => void
        }
      }
    }
  }
}

const GIS_SRC = 'https://accounts.google.com/gsi/client'

export default function LoginScreen({ serverURL, onLoggedIn, notice, onCancel, onChangeServer }: Props) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [googleClientId, setGoogleClientId] = useState<string | null>(null)
  const [googleError, setGoogleError] = useState<string | null>(null)
  const googleBtnRef = useRef<HTMLDivElement>(null)

  const handleLoginViaWebWindow = async () => {
    setSubmitting(true)
    setError(null)
    try {
      const result = await window.electronAPI.loginViaWebWindow()
      if (result.ok) {
        onLoggedIn(result.user)
      } else if (result.error !== 'cancelled') {
        setError(result.message || 'ログインに失敗しました')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '通信エラー')
    } finally {
      setSubmitting(false)
    }
  }

  useEffect(() => {
    let mounted = true
    ;(async () => {
      try {
        const res = await window.electronAPI.getGoogleClientId()
        if (!mounted) return
        if (!res?.clientId) {
          setGoogleError('サーバから Google Client ID を取得できませんでした')
          return
        }
        setGoogleClientId(res.clientId)
      } catch (err) {
        setGoogleError(err instanceof Error ? err.message : '通信エラー')
      }
    })()
    return () => {
      mounted = false
    }
  }, [serverURL])

  useEffect(() => {
    if (!googleClientId) return

    const renderButton = () => {
      if (!window.google?.accounts?.id || !googleBtnRef.current) return
      try {
        window.google.accounts.id.initialize({
          client_id: googleClientId,
          callback: async (response) => {
            if (!response?.credential) {
              setGoogleError('Google から credential を取得できませんでした')
              return
            }
            setSubmitting(true)
            setError(null)
            try {
              const result = await window.electronAPI.loginWithGoogle(response.credential)
              if (result.ok) {
                onLoggedIn(result.user)
              } else {
                setError(result.message || 'Google ログインに失敗しました')
              }
            } catch (err) {
              setError(err instanceof Error ? err.message : '通信エラー')
            } finally {
              setSubmitting(false)
            }
          },
        })
        window.google.accounts.id.renderButton(googleBtnRef.current, {
          theme: 'outline',
          size: 'large',
          text: 'signin_with',
          shape: 'rectangular',
          width: 320,
        })
      } catch (err) {
        setGoogleError(
          'Google ログインの初期化に失敗しました。Google Cloud Console の Authorized Origins にこの URL の追加が必要かもしれません。',
        )
        console.error('[LoginScreen] GIS init failed:', err)
      }
    }

    if (window.google?.accounts?.id) {
      renderButton()
      return
    }

    const existing = document.querySelector(`script[src="${GIS_SRC}"]`)
    if (existing) {
      existing.addEventListener('load', renderButton, { once: true })
      return
    }
    const script = document.createElement('script')
    script.src = GIS_SRC
    script.async = true
    script.defer = true
    script.onload = renderButton
    script.onerror = () => setGoogleError('Google ログインライブラリの読み込みに失敗しました')
    document.head.appendChild(script)
  }, [googleClientId, serverURL, onLoggedIn])

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email.trim() || !password) {
      setError('メールアドレスとパスワードを入力してください')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const result = await window.electronAPI.loginWithEmail(email.trim(), password)
      if (result.ok) {
        onLoggedIn(result.user)
      } else {
        setError(result.message || 'ログインに失敗しました')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '通信エラー')
    } finally {
      setSubmitting(false)
    }
  }

  const openWebSignup = () => {
    const baseURL = serverURL.replace(/^ws/, 'http').replace(/(\/api)?\/ws\/?$/, '')
    window.electronAPI.openExternal(`${baseURL}/register`)
  }
  const openWebForgotPassword = () => {
    const baseURL = serverURL.replace(/^ws/, 'http').replace(/(\/api)?\/ws\/?$/, '')
    window.electronAPI.openExternal(`${baseURL}/forgot-password`)
  }

  return (
    <div className="h-screen flex items-center justify-center bg-brand-50/40 p-6">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-md border border-brand-100 p-6 space-y-5">
        <div className="text-center">
          <h1 className="text-xl font-bold text-brand-700">ログイン</h1>
          <p className="mt-1 text-xs text-gray-500">
            アカウント情報を入力するとアプリ内で会議操作が完結します
          </p>
        </div>

        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="block text-xs text-brand-600 hover:underline cursor-pointer"
          >
            ← 会議画面に戻る
          </button>
        )}

        {notice && (
          <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-md p-2 leading-relaxed">
            {notice}
          </div>
        )}

        <button
          type="button"
          onClick={handleLoginViaWebWindow}
          disabled={submitting}
          className="w-full py-2.5 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 disabled:bg-gray-300 disabled:cursor-not-allowed rounded-md transition-colors flex items-center justify-center gap-2"
        >
          {submitting ? (
            <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          ) : (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          )}
          Google・メールでログイン (Web 画面)
        </button>
        <p className="-mt-3 text-[10px] text-center text-gray-500">
          別ウィンドウが開き、Web 版と同じ方法でログインできます
        </p>

        <div className="flex items-center gap-2">
          <div className="flex-1 h-px bg-gray-200" />
          <span className="text-[10px] text-gray-400">またはアプリ内で直接</span>
          <div className="flex-1 h-px bg-gray-200" />
        </div>

        <details className="text-xs">
          <summary className="cursor-pointer text-gray-500 hover:text-gray-700 select-none">
            アプリ内 Google ボタン (一部の環境で動作)
          </summary>
          <div className="mt-2 space-y-1.5">
            <div ref={googleBtnRef} className="flex justify-center" />
            {!googleClientId && !googleError && (
              <p className="text-[10px] text-center text-gray-400">Google ログインを準備中…</p>
            )}
            {googleError && (
              <p className="text-[10px] text-center text-red-600">{googleError}</p>
            )}
          </div>
        </details>

        <form onSubmit={onSubmit} className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">
              メールアドレス
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none"
              placeholder="you@example.com"
              disabled={submitting}
            />
          </div>
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-xs font-medium text-gray-700">パスワード</label>
              <button
                type="button"
                onClick={openWebForgotPassword}
                className="text-[10px] text-brand-600 hover:underline"
              >
                パスワード忘れ?
              </button>
            </div>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
              className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none"
              disabled={submitting}
            />
          </div>

          {error && (
            <div className="text-xs text-red-600 bg-red-50 rounded-md p-2">{error}</div>
          )}

          <button
            type="submit"
            disabled={submitting || !email.trim() || !password}
            className="w-full py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 disabled:bg-gray-300 disabled:cursor-not-allowed rounded-md transition-colors"
          >
            {submitting ? 'ログイン中…' : 'ログイン'}
          </button>
        </form>

        <div className="pt-2 border-t border-gray-100 text-center">
          <p className="text-[11px] text-gray-500">
            アカウントは、管理者から届く招待のリンクで作ります。{' '}
            <button
              type="button"
              onClick={openWebSignup}
              className="text-brand-600 hover:underline font-medium"
            >
              Web の登録画面を開く
            </button>
          </p>
        </div>

        <p className="text-[10px] text-center text-gray-400 leading-relaxed">
          ログインすると API トークンが発行され、アプリ内に安全に保存されます。
          <br />
          サーバ: <span className="font-mono">{serverURL.replace(/^wss?:\/\//, '').split('/')[0]}</span>
          {onChangeServer && (
            <>
              {' '}
              <button type="button" onClick={onChangeServer} className="text-brand-600 hover:underline">
                接続先を変更
              </button>
            </>
          )}
        </p>

        <LegalLinks serverURL={serverURL} />
      </div>
    </div>
  )
}
