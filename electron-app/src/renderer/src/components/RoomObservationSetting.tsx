import { useState } from 'react'
import type {
  CameraDevice,
  WindowSource,
  DisplaySource,
  ObservationStatus,
  ObservationSource,
} from '../hooks/useRoomObservation'

interface Props {
  enabled: boolean
  setEnabled: (v: boolean) => void
  source: ObservationSource
  setSource: (s: ObservationSource) => void
  deviceId: string
  setDeviceId: (id: string) => void
  devices: CameraDevice[]
  refreshDevices: () => Promise<unknown>
  windows: WindowSource[]
  refreshWindows: () => Promise<unknown>
  windowId: string
  windowName: string
  selectWindow: (id: string, name: string) => void
  displays: DisplaySource[]
  refreshDisplays: () => Promise<unknown>
  selectedDisplayIds: string[]
  toggleDisplay: (displayId: string) => void
  status: ObservationStatus
  lastError: string | null
  windowHidden?: boolean
  notice?: string | null
}

export function RoomObservationSetting({
  enabled,
  setEnabled,
  source,
  setSource,
  deviceId,
  setDeviceId,
  devices,
  refreshDevices,
  windows,
  refreshWindows,
  windowId,
  windowName,
  selectWindow,
  displays,
  refreshDisplays,
  selectedDisplayIds,
  toggleDisplay,
  status,
  lastError,
  windowHidden,
  notice,
}: Props): React.JSX.Element {
  const [open, setOpen] = useState(false)

  return (
    <div className="rounded-lg bg-gray-50 border border-gray-200/80">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium text-gray-600 hover:bg-gray-100 transition-colors rounded-lg"
      >
        <span className="flex items-center gap-1.5">
          環境観察（カメラ / 画面）
          {status === 'observing' && !lastError && (
            <span className="inline-flex items-center gap-1 text-[10px] text-emerald-600">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              環境解析中
            </span>
          )}
          {status === 'observing' && lastError && (
            <span className="inline-flex items-center gap-1 text-[10px] text-amber-600">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
              {windowHidden ? 'ウィンドウが見えないため一時停止中（戻すと自動で再開）' : '映像が取得できていません'}
            </span>
          )}
        </span>
        <svg
          className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-2">
          <label className="flex items-center gap-2 text-xs text-gray-700">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="rounded border-gray-300"
            />
            文字起こし中に環境観察を有効にする
          </label>
          {notice && <p className="text-[10px] text-amber-600">{notice}</p>}

          <div className="flex items-center gap-1 text-xs">
            {([
              { key: 'camera', label: 'カメラ' },
              { key: 'window', label: 'ウィンドウ' },
              { key: 'display', label: 'ディスプレイ' },
            ] as const).map((opt) => (
              <button
                key={opt.key}
                onClick={() => {
                  setSource(opt.key)
                  if (opt.key === 'window') void refreshWindows()
                  if (opt.key === 'display') void refreshDisplays()
                }}
                className={`flex-1 px-2 py-1.5 rounded border ${
                  source === opt.key
                    ? 'bg-brand-50 border-brand-400 text-brand-700 font-medium'
                    : 'bg-white border-gray-300 text-gray-600'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {source === 'camera' ? (
            <select
              value={deviceId}
              onChange={(e) => setDeviceId(e.target.value)}
              onFocus={() => void refreshDevices()}
              className="w-full px-2 py-1.5 text-xs border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-brand-500 bg-white"
            >
              <option value="">既定のカメラ</option>
              {devices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label}
                </option>
              ))}
            </select>
          ) : source === 'display' ? (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-gray-500">
                  解析するディスプレイを選択（複数可＝両方）
                </span>
                <button
                  onClick={() => void refreshDisplays()}
                  className="text-[10px] text-brand-600 underline hover:text-brand-700"
                >
                  更新
                </button>
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                {displays.map((d) => {
                  return (
                    <button
                      key={d.displayId || d.id}
                      onClick={() => toggleDisplay(d.displayId)}
                      className={`text-left rounded border overflow-hidden ${
                        selectedDisplayIds.includes(d.displayId)
                          ? 'border-brand-500 ring-1 ring-brand-400'
                          : 'border-gray-300'
                      }`}
                      title={d.name}
                    >
                      <img src={d.dataUrl} alt="" className="w-full h-16 object-cover bg-gray-200" />
                      <div className="px-1 py-0.5 text-[9px] text-gray-600 truncate flex items-center gap-1">
                        <input type="checkbox" readOnly checked={selectedDisplayIds.includes(d.displayId)} className="scale-75" />
                        {d.name}
                      </div>
                    </button>
                  )
                })}
                {displays.length === 0 && (
                  <div className="col-span-2 text-[10px] text-gray-400 py-2 text-center">
                    「更新」を押してディスプレイを取得
                  </div>
                )}
              </div>
              <div className="text-[10px] text-gray-400">
                未選択の場合は全ディスプレイを解析します。
              </div>
            </div>
          ) : (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-gray-500">
                  解析するウィンドウを1つ選択（会議アプリの共有画面など）
                </span>
                <button
                  onClick={() => void refreshWindows()}
                  className="text-[10px] text-brand-600 underline hover:text-brand-700"
                >
                  更新
                </button>
              </div>
              {windowName && (
                <div className="text-[10px] text-emerald-700 truncate">選択中: {windowName}</div>
              )}
              <div className="max-h-40 overflow-y-auto grid grid-cols-2 gap-1.5">
                {windows.map((w) => (
                  <button
                    key={w.id}
                    onClick={() => selectWindow(w.id, w.name)}
                    className={`text-left rounded border overflow-hidden ${
                      windowId === w.id ? 'border-brand-500 ring-1 ring-brand-400' : 'border-gray-300'
                    }`}
                    title={w.name}
                  >
                    <img src={w.dataUrl} alt="" className="w-full h-16 object-cover bg-gray-200" />
                    <div className="px-1 py-0.5 text-[9px] text-gray-600 truncate">{w.name}</div>
                  </button>
                ))}
                {windows.length === 0 && (
                  <div className="col-span-2 text-[10px] text-gray-400 py-2 text-center">
                    「更新」を押してウィンドウを取得
                  </div>
                )}
              </div>
            </div>
          )}

          {status === 'error' && (
            <p className="text-[10px] text-red-500">
              開始できませんでした{lastError ? `（${lastError}）` : ''}
            </p>
          )}

          {status === 'observing' && lastError && (
            <p className="text-[10px] text-amber-600">{lastError}</p>
          )}

          <p className="text-[10px] text-gray-400 leading-relaxed">
            {source === 'camera'
              ? 'その場の様子を1分に1回観察・解析します（人数や場の状況を推定）。'
              : source === 'display'
                ? '選んだディスプレイを1分に1回解析し、共有資料を構造化します。参加者の顔が写っていればその様子も推定します（メール等の私的内容は記録しません）。'
                : '選んだウィンドウを1分に1回解析し、共有資料を構造化します。参加者の顔が写っていればその様子も推定します（メール等の私的内容は記録しません）。'}
            <span className="text-gray-500">画像は保存されません。</span>
            会議中も入力元を切り替えられます。位置情報は許可した場合のみ付与されます。
          </p>
        </div>
      )}
    </div>
  )
}
