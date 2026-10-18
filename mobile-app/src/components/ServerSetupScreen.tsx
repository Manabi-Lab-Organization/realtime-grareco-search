import { useState } from 'react'
import { APP_VERSION, getHttpURL, saveServer } from '../lib/config'
import { checkServerInfo, normalizeServerInput } from '../lib/serverUrl'

interface Props {
  onSaved: (changed: boolean) => void
  onCancel?: () => void
}

export default function ServerSetupScreen({ onSaved, onCancel }: Props) {
  const current = getHttpURL()
  const [input, setInput] = useState(current)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    const normalized = normalizeServerInput(input)
    if ('error' in normalized) {
      setError(normalized.error)
      return
    }
    setSubmitting(true)
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 10_000)
      const res = await fetch(`${normalized.httpBase}/api/server-info`, {
        headers: { 'X-Client-Version': APP_VERSION || '0.0.0', 'X-Client-Platform': 'mobile' },
        signal: controller.signal,
      })
      clearTimeout(timer)
      if (res.status === 426) {
        setError('このアプリは古いため、このサーバには接続できません。App Store から最新版に更新してください')
        return
      }
      const info = res.ok ? await res.json().catch(() => null) : null
      const checked = checkServerInfo(info)
      if ('error' in checked) {
        setError(checked.error)
        return
      }
      const changed = normalized.httpBase !== current
      await saveServer(normalized.httpBase)
      onSaved(changed)
    } catch {
      setError('サーバに接続できませんでした。アドレスと、ネットワークにつながっているかを確かめてください')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex h-full flex-col items-stretch bg-gray-950 px-6 py-8 overflow-auto">
      <div className="mx-auto w-full max-w-sm space-y-6 pt-8">
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-semibold text-white">接続先のサーバ</h1>
          <p className="text-xs text-gray-400 leading-relaxed">
            お使いの Realtime GraReco &amp; Search のサーバーのアドレスを入力してください。
            分からないときは、管理者に確かめてください。
          </p>
        </div>

        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-1">
            <label className="block text-xs font-medium text-gray-300">サーバのアドレス</label>
            <input
              type="url"
              inputMode="url"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="https://grareco.example.co.jp"
              disabled={submitting}
              className="w-full rounded-md border border-gray-700 bg-gray-900 px-3 py-3 text-base font-mono text-white placeholder:text-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <p className="text-[11px] text-gray-500">Web 版を開くときのアドレスと同じです</p>
          </div>

          {error && <div className="rounded-md bg-red-900/40 px-3 py-2 text-xs text-red-200 leading-relaxed">{error}</div>}

          {current && (
            <p className="rounded-md border border-amber-700 bg-amber-900/30 px-3 py-2 text-[11px] text-amber-100 leading-relaxed">
              接続先を変えると、いまのサーバからはログアウトします。
            </p>
          )}

          <button
            type="submit"
            disabled={submitting || !input.trim()}
            className="w-full rounded-md bg-blue-600 px-4 py-3 text-sm font-semibold text-white hover:bg-blue-500 active:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? '確かめています…' : '接続する'}
          </button>
        </form>

        {onCancel && (
          <button type="button" onClick={onCancel} className="block w-full text-center text-xs text-blue-400">
            変更しないで戻る
          </button>
        )}
      </div>
    </div>
  )
}
