import { useEffect, useState } from 'react'
import { getMeetings, type MeetingSummary } from '../lib/api'
import { openInWeb } from '../lib/webBridge'

interface Props {
  token: string
  onClose: () => void
  onResume: (meeting: MeetingSummary) => void
}

function formatStarted(s: string | null): string {
  if (!s) return ''
  try {
    const d = new Date(s)
    const m = d.getMonth() + 1
    const day = d.getDate()
    const hh = String(d.getHours()).padStart(2, '0')
    const mm = String(d.getMinutes()).padStart(2, '0')
    return `${m}/${day} ${hh}:${mm}`
  } catch {
    return ''
  }
}

function formatDuration(seconds: number | null): string {
  if (!seconds || seconds <= 0) return ''
  const mins = Math.floor(seconds / 60)
  if (mins < 1) return `${seconds}秒`
  if (mins < 60) return `${mins}分`
  return `${Math.floor(mins / 60)}時間${mins % 60}分`
}

const STATUS_LABELS: Record<string, string> = {
  active: '記録中',
  paused: '一時停止中',
  completed: '終了',
}

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? ''
}

export default function MeetingListModal({ token, onClose, onResume }: Props) {
  const [loading, setLoading] = useState(true)
  const [meetings, setMeetings] = useState<MeetingSummary[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true
    setLoading(true)
    getMeetings(token)
      .then((list) => {
        if (!mounted) return
        setMeetings(list)
        setError(null)
      })
      .catch((err) => {
        if (!mounted) return
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (mounted) setLoading(false)
      })
    return () => {
      mounted = false
    }
  }, [token])

  return (
    <div className="absolute inset-0 z-10 bg-gray-950/95 flex flex-col p-4 pt-12">
      <header className="flex items-center justify-between mb-3">
        <h2 className="text-base font-semibold text-white">過去の会議</h2>
        <button
          type="button"
          onClick={onClose}
          className="text-sm text-gray-400 px-2 py-1"
        >
          閉じる
        </button>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading && (
          <p className="text-sm text-gray-500 text-center mt-8">読み込み中…</p>
        )}
        {error && (
          <p className="text-sm text-red-400 text-center mt-8">{error}</p>
        )}
        {!loading && !error && meetings.length === 0 && (
          <p className="text-sm text-gray-500 text-center mt-8">
            会議がありません
          </p>
        )}
        <ul className="space-y-2">
          {meetings.map((m) => (
            <li
              key={m.id}
              className="bg-gray-900 border border-gray-800 rounded-md p-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-white truncate">
                    {m.title || `会議 #${m.id}`}
                  </p>
                  <p className="text-xs text-gray-500 mt-1">
                    {formatStarted(m.startedAt)}
                    {formatDuration(m.duration) &&
                      ` · ${formatDuration(m.duration)}`}
                    <span className="ml-2 text-gray-600">{statusLabel(m.status)}</span>
                  </p>
                </div>
                <div className="flex flex-col gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => onResume(m)}
                    className="text-xs bg-blue-600 hover:bg-blue-500 active:bg-blue-700 text-white rounded px-3 py-1.5"
                  >
                    再開
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void openInWeb(`/meetings/${m.id}`, token)
                    }}
                    className="text-xs bg-gray-800 hover:bg-gray-700 active:bg-gray-600 text-blue-300 border border-gray-700 rounded px-3 py-1.5"
                  >
                    Web
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
