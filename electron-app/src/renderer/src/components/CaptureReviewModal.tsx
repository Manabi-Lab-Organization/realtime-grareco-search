import { useState } from 'react'

export interface DisplayShot {
  id: string
  name: string
  displayId: string
  dataUrl: string
  width: number
  height: number
}

export function CaptureReviewModal({
  shots,
  uploading,
  onConfirm,
  onCancel
}: {
  shots: DisplayShot[]
  uploading: boolean
  onConfirm: (kept: DisplayShot[]) => void
  onCancel: () => void
}): React.JSX.Element {
  const [discarded, setDiscarded] = useState<Set<string>>(new Set())
  const kept = shots.filter((s) => !discarded.has(s.id))

  const toggle = (id: string): void => {
    setDiscarded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-2xl space-y-4 max-h-[90vh] overflow-y-auto">
        <div>
          <h3 className="text-lg font-bold text-gray-900">補足資料に追加する画面</h3>
          <p className="text-xs text-gray-500 mt-1">
            撮影した画面です。追加したくない画面の × を押して除外してください。
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          {shots.map((s, i) => {
            const isDiscarded = discarded.has(s.id)
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => toggle(s.id)}
                className={`relative rounded-lg border-2 overflow-hidden text-left transition cursor-pointer ${
                  isDiscarded ? 'border-gray-200 opacity-40' : 'border-brand-600'
                }`}
              >
                <img
                  src={s.dataUrl}
                  alt={s.name}
                  className="w-full aspect-video object-cover bg-gray-100"
                />
                <span
                  className={`absolute top-1.5 right-1.5 rounded-full w-6 h-6 flex items-center justify-center text-sm ${
                    isDiscarded ? 'bg-gray-400 text-white' : 'bg-black/60 text-white'
                  }`}
                  aria-label={isDiscarded ? '追加に戻す' : '除外する'}
                >
                  {isDiscarded ? '+' : '×'}
                </span>
                <div className="px-2 py-1.5 flex items-center justify-between">
                  <span className="text-xs font-medium text-gray-700 truncate">
                    {s.name || `画面 ${i + 1}`}
                  </span>
                  <span className="text-[10px] text-gray-400">
                    {s.width}×{s.height}
                  </span>
                </div>
              </button>
            )
          })}
        </div>

        <div className="flex items-center justify-between gap-3 pt-1">
          <span className="text-xs text-gray-500">{kept.length} 画面を追加します</span>
          <div className="flex gap-2">
            <button
              onClick={onCancel}
              disabled={uploading}
              className="px-4 py-2 text-sm font-medium text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50 transition cursor-pointer disabled:opacity-40"
            >
              キャンセル
            </button>
            <button
              onClick={() => onConfirm(kept)}
              disabled={uploading || kept.length === 0}
              className="px-4 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 transition cursor-pointer disabled:opacity-40"
            >
              {uploading ? '追加中…' : '追加'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
