import { useEffect, useState } from 'react'

interface Props {
  onClose: () => void
}

export default function LicensesModal({ onClose }: Props) {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let mounted = true
    fetch('/THIRD_PARTY_NOTICES.txt')
      .then((res) => (res.ok ? res.text() : Promise.reject(new Error(String(res.status)))))
      .then((body) => {
        if (mounted) setText(body)
      })
      .catch(() => {
        if (mounted) setError(true)
      })
    return () => {
      mounted = false
    }
  }, [])

  return (
    <div className="fixed inset-0 z-50 bg-gray-950/95 flex flex-col p-4 pt-12">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-base font-semibold text-white">ライセンス</h2>
        <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm text-gray-300 border border-gray-600 rounded-lg">
          閉じる
        </button>
      </div>
      <p className="text-xs text-gray-400 mb-2">
        このアプリに同梱しているライブラリの著作権表示とライセンス本文です。
      </p>
      <div className="flex-1 overflow-auto rounded-lg bg-gray-900 p-3">
        {text != null ? (
          <pre className="text-[10px] leading-snug text-gray-300 whitespace-pre-wrap break-words">{text}</pre>
        ) : error ? (
          <p className="text-xs text-gray-400">ライセンス表示を読み込めませんでした。</p>
        ) : (
          <p className="text-xs text-gray-400">読み込み中…</p>
        )}
      </div>
    </div>
  )
}
