import { useState } from 'react'

interface Props {
  currentServerURL: string
  onSaved: (serverURL: string) => void
  onCancel?: () => void
}

function toDisplay(wsURL: string): string {
  return wsURL ? wsURL.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/ws\/?$/, '') : ''
}

export default function ServerSetupScreen({ currentServerURL, onSaved, onCancel }: Props) {
  const [input, setInput] = useState(toDisplay(currentServerURL))
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const result = await window.electronAPI.setServerURL(input)
      if (result.ok) {
        onSaved(result.serverURL)
      } else {
        setError(result.message)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '接続先を保存できませんでした')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="h-screen flex items-center justify-center bg-brand-50/40 p-6">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-md border border-brand-100 p-6 space-y-5">
        <div className="text-center">
          <h1 className="text-xl font-bold text-brand-700">接続先のサーバ</h1>
          <p className="mt-1 text-xs text-gray-500 leading-relaxed">
            お使いの Realtime GraReco &amp; Search のサーバーのアドレスを入力してください。
            分からないときは、管理者に確かめてください。
          </p>
        </div>

        <form onSubmit={onSubmit} className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">サーバのアドレス</label>
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              required
              autoFocus
              spellCheck={false}
              autoComplete="url"
              className="w-full px-3 py-2 text-sm font-mono border border-gray-300 rounded-md focus:border-brand-500 focus:ring-1 focus:ring-brand-500 outline-none"
              placeholder="https://grareco.example.co.jp"
              disabled={submitting}
            />
            <p className="mt-1 text-[10px] text-gray-400">Web 版を開くときのアドレスと同じです</p>
          </div>

          {error && <div className="text-xs text-red-600 bg-red-50 rounded-md p-2 leading-relaxed">{error}</div>}

          {currentServerURL && (
            <p className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded-md p-2 leading-relaxed">
              接続先を変えると、いまのサーバからはログアウトします。
            </p>
          )}

          <button
            type="submit"
            disabled={submitting || !input.trim()}
            className="w-full py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 disabled:bg-gray-300 disabled:cursor-not-allowed rounded-md transition-colors"
          >
            {submitting ? '確かめています…' : '接続する'}
          </button>
        </form>

        {onCancel && (
          <button type="button" onClick={onCancel} className="block w-full text-xs text-center text-brand-600 hover:underline">
            変更しないで戻る
          </button>
        )}
      </div>
    </div>
  )
}
