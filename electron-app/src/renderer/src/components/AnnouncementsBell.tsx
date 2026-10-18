import { useState, useEffect, useCallback } from 'react'

interface UserAnnouncement {
  id: number
  title: string
  body: string
  important: boolean
  startsAt: string
  endsAt: string | null
  createdAt: string
  readAt: string | null
}

export function AnnouncementsBell({ loggedIn }: { loggedIn: boolean }): JSX.Element | null {
  const [items, setItems] = useState<UserAnnouncement[]>([])
  const [open, setOpen] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    if (!loggedIn) return
    try {
      const data = (await window.electronAPI.fetchAnnouncements()) as UserAnnouncement[]
      setItems(data)
    } catch {
    }
  }, [loggedIn])

  useEffect(() => {
    void refresh()
    const id = setInterval(() => void refresh(), 60_000)
    return () => clearInterval(id)
  }, [refresh])

  const markRead = useCallback(
    async (id: number): Promise<void> => {
      const now = new Date().toISOString()
      setItems((prev) => prev.map((a) => (a.id === id ? { ...a, readAt: a.readAt ?? now } : a)))
      try {
        await window.electronAPI.markReadAnnouncement(id)
      } catch {
      }
    },
    [],
  )

  useEffect(() => {
    if (!open) return
    for (const a of items) {
      if (!a.readAt) void markRead(a.id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (!loggedIn) return null

  const unread = items.filter((a) => !a.readAt).length

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="relative p-1.5 rounded-md text-brand-200 hover:text-white hover:bg-brand-500 transition-colors cursor-pointer"
        aria-label={`お知らせ${unread > 0 ? `（未読 ${unread} 件）` : ''}`}
        title="お知らせ"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
          />
        </svg>
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 bg-red-500 text-white text-[9px] font-bold leading-none min-w-[14px] h-[14px] px-1 rounded-full flex items-center justify-center">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center pt-12"
          onClick={() => setOpen(false)}
        >
          <div
            className="bg-white rounded-md w-[420px] max-w-[90vw] max-h-[80vh] overflow-y-auto p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-center mb-3">
              <h2 className="font-semibold text-sm text-gray-800">お知らせ</h2>
              <button
                onClick={() => setOpen(false)}
                className="text-gray-400 hover:text-gray-700"
                aria-label="閉じる"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            </div>
            {items.length === 0 ? (
              <p className="text-sm text-gray-500 text-center py-6">お知らせはまだありません</p>
            ) : (
              <div className="space-y-2">
                {items.map((a) => {
                  const isUnread = !a.readAt
                  return (
                    <div
                      key={a.id}
                      className={`border rounded p-2.5 ${isUnread ? 'bg-indigo-50 border-indigo-200' : 'border-gray-200'}`}
                    >
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {a.important && (
                          <span className="text-[10px] bg-red-500 text-white px-1.5 py-0.5 rounded">
                            重要
                          </span>
                        )}
                        {isUnread && (
                          <span className="text-[10px] bg-indigo-500 text-white px-1.5 py-0.5 rounded">
                            NEW
                          </span>
                        )}
                        <span className="font-medium text-sm text-gray-900">{a.title}</span>
                      </div>
                      <div className="text-[10px] text-gray-500 mt-1">
                        {new Date(a.createdAt).toLocaleDateString('ja-JP')}
                      </div>
                      <div className="mt-1.5 whitespace-pre-wrap text-xs text-gray-700 break-words">
                        {a.body}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}
