
import { useState } from 'react'
import { Browser } from '@capacitor/browser'
import { getHttpURL } from '../lib/config'
import { loginWithPassword, type ReloginReason } from '../lib/api'
import { LegalLinks } from './LegalLinks'

interface Props {
  onLoggedIn: (token: string) => void
  reloginReason?: ReloginReason
  onChangeServer?: () => void
}

export default function LoginScreen({ onLoggedIn, reloginReason, onChangeServer }: Props) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleEmailLogin() {
    if (!email.trim() || !password) {
      setError('メールアドレスとパスワードを入力してください')
      return
    }
    setSubmitting(true)
    setError(null)
    const result = await loginWithPassword(email.trim(), password, reloginReason)
    setSubmitting(false)
    if (result.ok && result.token) {
      onLoggedIn(result.token)
    } else {
      setError(result.message ?? 'ログインに失敗しました')
    }
  }

  async function openSignupInBrowser() {
    await Browser.open({ url: `${getHttpURL()}/register` })
  }
  async function openForgotPasswordInBrowser() {
    await Browser.open({ url: `${getHttpURL()}/forgot-password` })
  }

  return (
    <div className="flex h-full flex-col items-stretch bg-gray-950 px-6 py-8 overflow-auto">
      <div className="flex-1 flex flex-col justify-center max-w-sm w-full mx-auto gap-5">
        <div className="text-center mb-2">
          <h1 className="text-2xl font-semibold text-white">Realtime GraReco &amp; Search</h1>
          <p className="mt-1 text-sm text-gray-400">アカウントにログイン</p>
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">メールアドレス</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              autoComplete="email"
              className="w-full rounded-md border border-gray-700 bg-gray-900 px-3 py-3 text-base text-white placeholder:text-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="you@example.com"
              disabled={submitting}
            />
          </div>
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-xs font-medium text-gray-400">パスワード</label>
              <button
                type="button"
                onClick={openForgotPasswordInBrowser}
                className="text-[11px] text-blue-400 hover:underline"
              >
                忘れた?
              </button>
            </div>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              className="w-full rounded-md border border-gray-700 bg-gray-900 px-3 py-3 text-base text-white placeholder:text-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
              disabled={submitting}
            />
          </div>

          {error && (
            <div className="rounded-md bg-red-950/60 border border-red-800 px-3 py-2 text-xs text-red-300">
              {error}
            </div>
          )}

          <button
            type="button"
            onClick={handleEmailLogin}
            disabled={submitting || !email.trim() || !password}
            className="w-full rounded-md bg-blue-600 px-4 py-3 text-sm font-semibold text-white hover:bg-blue-500 active:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? 'ログイン中…' : 'ログイン'}
          </button>
        </div>

        <div className="text-center pt-2 border-t border-gray-800">
          <p className="text-xs text-gray-500">
            アカウントは、管理者から届く招待のリンクで作ります。{' '}
            <button
              type="button"
              onClick={openSignupInBrowser}
              className="text-blue-400 hover:underline font-medium"
            >
              Web の登録画面を開く
            </button>
          </p>
        </div>

        <p className="text-[10px] text-gray-600 text-center leading-relaxed">
          ログインすると API トークンが安全に端末内に保存されます。<br />
          サーバ: <span className="font-mono">{getHttpURL().replace(/^https?:\/\//, '').split('/')[0]}</span>
          {onChangeServer && (
            <>
              {' '}
              <button type="button" onClick={onChangeServer} className="text-blue-400">
                接続先を変更
              </button>
            </>
          )}
        </p>

        <LegalLinks />
      </div>
    </div>
  )
}
