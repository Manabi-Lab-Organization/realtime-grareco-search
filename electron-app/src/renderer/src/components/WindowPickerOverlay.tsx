import { useEffect, useMemo, useRef, useState } from 'react'
import type { WindowSource } from '../hooks/useRoomObservation'
import { groupWindows, moveSelection, orderedWindows } from '../lib/windowPicker'

interface Props {
  windows: WindowSource[]
  refreshWindows: () => Promise<unknown>
  currentId: string
  onConfirm: (id: string, name: string) => void
  onCancel: () => void
}

export function WindowPickerOverlay({
  windows,
  refreshWindows,
  currentId,
  onConfirm,
  onCancel,
}: Props): React.JSX.Element {
  const [pendingId, setPendingId] = useState(currentId)
  const [loading, setLoading] = useState(true)
  const listRef = useRef<HTMLDivElement>(null)

  const reload = async (): Promise<void> => {
    setLoading(true)
    try {
      await refreshWindows()
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const grouped = useMemo(() => groupWindows(windows), [windows])
  const ordered = useMemo(() => orderedWindows(windows), [windows])
  const pending = ordered.find((w) => w.id === pendingId)

  const confirm = (w: WindowSource | undefined): void => {
    if (w) onConfirm(w.id, w.name)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setPendingId((cur) => moveSelection(ordered, cur, e.key === 'ArrowDown' ? 1 : -1))
      } else if (e.key === 'Enter') {
        const t = e.target as HTMLElement | null
        if (t instanceof HTMLButtonElement && t.getAttribute('role') !== 'option') return
        e.preventDefault()
        confirm(pending)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ordered, pending, onCancel, onConfirm])

  useEffect(() => {
    if (!pendingId) return
    const el = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')
    el?.scrollIntoView({ block: 'nearest' })
  }, [pendingId])

  const row = (w: WindowSource): React.JSX.Element => {
    const selected = w.id === pendingId
    return (
      <button
        key={w.id}
        type="button"
        role="option"
        aria-selected={selected}
        onClick={() => setPendingId(w.id)}
        onDoubleClick={() => confirm(w)}
        title={w.name}
        className={`w-full flex items-center gap-2.5 px-2 py-1.5 rounded-md border text-left ${
          selected ? 'bg-brand-50 border-brand-400' : 'border-transparent hover:bg-gray-50'
        }`}
      >
        <span className="shrink-0 w-14 h-9 rounded border border-gray-200 bg-gray-100 overflow-hidden flex items-center justify-center">
          {w.dataUrl && <img src={w.dataUrl} alt="" className="max-w-full max-h-full object-contain" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            {w.iconDataUrl && <img src={w.iconDataUrl} alt="" className="shrink-0 w-4 h-4" />}
            <span className="truncate text-[13px] font-medium text-gray-800">{w.name}</span>
          </span>
          {w.id === currentId && <span className="block text-[11px] text-emerald-700">いま解析中</span>}
        </span>
      </button>
    )
  }

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-white"
      role="dialog"
      aria-modal="true"
      aria-label="解析するウィンドウを選択"
    >
      <header className="shrink-0 flex items-center justify-between gap-2 px-3 py-2 border-b border-gray-200">
        <h2 className="text-[13px] font-medium text-gray-800">解析するウィンドウを選択</h2>
        <button
          type="button"
          onClick={() => void reload()}
          disabled={loading}
          className="px-2.5 py-1 text-xs rounded border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-50"
        >
          {loading ? '取得中…' : '一覧を更新'}
        </button>
      </header>

      <div className="flex-1 min-h-0 grid grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <div
          ref={listRef}
          role="listbox"
          aria-label="ウィンドウの一覧"
          className="min-h-0 overflow-y-auto px-1.5 py-1 border-r border-gray-200"
        >
          {grouped.meeting.length > 0 && (
            <>
              <p className="px-2 pt-1.5 pb-0.5 text-[11px] text-gray-400">会議アプリ</p>
              {grouped.meeting.map(row)}
            </>
          )}
          {grouped.others.length > 0 && (
            <>
              {grouped.meeting.length > 0 && (
                <p className="px-2 pt-2 pb-0.5 text-[11px] text-gray-400">そのほか</p>
              )}
              {grouped.others.map(row)}
            </>
          )}
          {ordered.length === 0 && (
            <p className="px-2 py-6 text-xs text-gray-500 text-center leading-relaxed">
              {loading
                ? 'ウィンドウを取得しています…'
                : '選べるウィンドウがありません。解析したい画面を表示してから「一覧を更新」を押してください（最小化したウィンドウ・別のデスクトップにあるウィンドウは出ません）。'}
            </p>
          )}
        </div>

        <div className="min-h-0 p-3 flex flex-col gap-2">
          <div className="flex-1 min-h-0 rounded-md border border-gray-200 bg-gray-100 flex items-center justify-center overflow-hidden">
            {pending?.dataUrl ? (
              <img src={pending.dataUrl} alt="" className="max-w-full max-h-full object-contain" />
            ) : (
              <span className="px-3 text-xs text-gray-400 text-center">
                {pending ? 'この画面の縮小表示は取得できませんでした' : '左の一覧から選ぶと、ここで画面を確かめられます'}
              </span>
            )}
          </div>
          <p className="shrink-0 text-[13px] font-medium text-gray-800 truncate" title={pending?.name}>
            {pending ? pending.name : '未選択'}
          </p>
        </div>
      </div>

      <footer className="shrink-0 flex items-center justify-end gap-2 px-3 py-2 border-t border-gray-200">
        <span className="mr-auto text-[11px] text-gray-400">ダブルクリックでも確定できます</span>
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 text-xs rounded-md border border-gray-300 text-gray-600 hover:bg-gray-50"
        >
          キャンセル
        </button>
        <button
          type="button"
          onClick={() => confirm(pending)}
          disabled={!pending}
          className="px-3 py-1.5 text-xs font-medium rounded-md bg-brand-600 text-white hover:bg-brand-500 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          これを解析
        </button>
      </footer>
    </div>
  )
}
