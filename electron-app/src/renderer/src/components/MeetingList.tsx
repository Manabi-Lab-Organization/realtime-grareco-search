import { useState } from 'react'
import type { MeetingInfo } from '../hooks/useElectronAPI'

interface MeetingListProps {
  fetchMeetings: () => Promise<MeetingInfo[]>
  onSelectMeeting: (meetingId: number) => void
  onOpenWebDetail?: (meetingId: number, title: string) => void
  disabled: boolean
}

function formatDate(isoString: string): string {
  try {
    const date = new Date(isoString)
    const mm = String(date.getMonth() + 1).padStart(2, '0')
    const dd = String(date.getDate()).padStart(2, '0')
    const hh = String(date.getHours()).padStart(2, '0')
    const min = String(date.getMinutes()).padStart(2, '0')
    return `${mm}/${dd} ${hh}:${min}`
  } catch {
    return isoString.substring(0, 16).replace('T', ' ')
  }
}

function statusLabel(status: string): { text: string; className: string } {
  switch (status) {
    case 'idle':
      return { text: '未開始', className: 'bg-gray-100 text-gray-600' }
    case 'active':
      return { text: '進行中', className: 'bg-brand-100 text-brand-700' }
    case 'paused':
      return { text: '一時停止', className: 'bg-brand-50 text-brand-600' }
    case 'completed':
      return { text: '完了', className: 'bg-gray-100 text-gray-600' }
    default:
      return { text: status, className: 'bg-gray-100 text-gray-600' }
  }
}

export function MeetingList({ fetchMeetings, onSelectMeeting, onOpenWebDetail, disabled }: MeetingListProps) {
  const [meetings, setMeetings] = useState<MeetingInfo[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isOpen, setIsOpen] = useState(false)

  const handleFetch = async () => {
    if (isOpen) { setIsOpen(false); return }
    setIsLoading(true)
    try {
      const result = await fetchMeetings()
      setMeetings(result); setIsOpen(true)
    } catch { setMeetings([]) }
    finally { setIsLoading(false) }
  }

  return (
    <div className="space-y-1.5">
      <button
        onClick={handleFetch}
        disabled={disabled || isLoading}
        className="flex items-center gap-2 text-xs text-gray-500 hover:text-gray-700 disabled:opacity-40 transition-colors cursor-pointer disabled:cursor-not-allowed"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
        </svg>
        過去の会議を再開
        {isLoading && (
          <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        )}
      </button>

      {isOpen && meetings.length > 0 && (
        <div className="space-y-1.5">
          <div className="max-h-[200px] overflow-y-auto rounded-md border border-gray-200 divide-y divide-gray-100">
            {meetings.map((meeting) => {
              const status = statusLabel(meeting.status)
              return (
                <div key={meeting.id} className="px-3 py-2 hover:bg-gray-50 transition-colors">
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-gray-700 truncate">{meeting.title}</p>
                      <p className="text-[10px] text-gray-400">{formatDate(meeting.startedAt)}</p>
                    </div>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full shrink-0 ${status.className}`}>
                      {status.text}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 mt-1.5">
                    <button
                      onClick={() => onSelectMeeting(meeting.id)}
                      className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium text-white bg-brand-600 hover:bg-brand-500 rounded-md transition-colors cursor-pointer"
                      title="この会議に再接続し、文字起こしの続きを文字起こしします"
                    >
                      <span className="w-2 h-2 rounded-full bg-white" />
                      続きを文字起こし
                    </button>
                    {onOpenWebDetail && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          onOpenWebDetail(meeting.id, meeting.title)
                        }}
                        className="flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-gray-500 hover:text-brand-600 hover:bg-brand-50 rounded-md transition-colors cursor-pointer"
                        title="会議の詳細（サマリー・グラレコ・アシスタント等）をブラウザで開く"
                      >
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                        </svg>
                        詳細を見る
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
