import { useEffect, useState } from 'react'

const DEFAULT_SHORTCUT = 'CommandOrControl+Shift+2'

const PRESETS: { label: string; value: string }[] = [
  { label: '⌘ / Ctrl + Shift + 2（既定）', value: 'CommandOrControl+Shift+2' },
  { label: '⌘ / Ctrl + Shift + 0', value: 'CommandOrControl+Shift+0' },
  { label: '⌘ / Ctrl + Option/Alt + S', value: 'CommandOrControl+Alt+S' }
]

export function ScreenshotShortcutSetting(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [current, setCurrent] = useState<string>(DEFAULT_SHORTCUT)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    window.electronAPI.getScreenshotShortcut().then((s) => {
      if (s) setCurrent(s)
    })
  }, [])

  const apply = async (value: string): Promise<void> => {
    setError(null)
    const prev = current
    setCurrent(value)
    const r = await window.electronAPI.setScreenshotShortcut(value)
    if (r.ok) {
      setSaved(true)
      window.setTimeout(() => setSaved(false), 2000)
    } else {
      setCurrent(prev)
      setError(r.error === 'register_failed' ? 'このキーは他で使用中の可能性があります' : '設定に失敗しました')
    }
  }

  const options = PRESETS.some((p) => p.value === current)
    ? PRESETS
    : [{ label: `現在: ${current}`, value: current }, ...PRESETS]

  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-[10px] text-gray-400 hover:text-gray-600 transition-colors cursor-pointer"
      >
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
        <span>画面キャプチャのショートカット設定</span>
        <svg
          className={`w-2.5 h-2.5 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="mt-1.5 px-3 py-2.5 space-y-2 rounded-md bg-gray-50 border border-gray-200/80">
          <select
            value={current}
            onChange={(e) => void apply(e.target.value)}
            className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-brand-500 bg-white"
          >
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <div className="flex items-center justify-between">
            <button
              onClick={() => void apply(DEFAULT_SHORTCUT)}
              className="text-[10px] text-gray-500 underline hover:text-gray-700"
            >
              既定に戻す
            </button>
            {saved && <span className="text-[10px] text-green-600">保存しました</span>}
          </div>
          {error && <p className="text-[10px] text-red-500">{error}</p>}
          <p className="text-[10px] text-gray-400">
            文字起こし中に押すと、今の画面を補足資料に追加します。
          </p>
        </div>
      )}
    </div>
  )
}
