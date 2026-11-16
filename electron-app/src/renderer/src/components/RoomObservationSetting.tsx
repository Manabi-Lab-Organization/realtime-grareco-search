import { useState } from 'react'
import { WindowPickerOverlay } from './WindowPickerOverlay'
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
  const [pickerOpen, setPickerOpen] = useState(false)

  const selectedWindow = windows.find((w) => w.id === windowId)
  const showWindowSummary = enabled && source === 'window'

  return (
    <div className="rounded-lg bg-gray-50 border border-gray-200/80">
      <div className="flex items-center">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex-1 min-w-0 flex items-center justify-between gap-2 px-3 py-2 text-xs font-medium text-gray-600 hover:bg-gray-100 transition-colors rounded-lg"
      >
        <span className="min-w-0 flex items-center gap-1.5">
          <span className="shrink-0">環境観察（カメラ / 画面）</span>
          {showWindowSummary && (
            <span
              className={`min-w-0 truncate font-normal ${windowName ? 'text-gray-800' : 'text-amber-600'}`}
              title={windowName || undefined}
            >
              {windowName ? `ウィンドウ：${windowName}` : 'ウィンドウ：未選択'}
            </span>
          )}
          {status === 'observing' && !lastError && (
            <span className="shrink-0 inline-flex items-center gap-1 text-[10px] text-emerald-600">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              環境解析中
            </span>
          )}
          {status === 'observing' && lastError && (
            <span className="shrink-0 inline-flex items-center gap-1 text-[10px] text-amber-600">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
              {windowHidden ? 'ウィンドウが見えないため一時停止中（戻すと自動で再開）' : '映像が取得できていません'}
            </span>
          )}
        </span>
        <svg
          className={`shrink-0 w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {showWindowSummary && !open && (
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          className="shrink-0 mr-2 px-2.5 py-1 text-xs rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
        >
          {windowName ? '変更' : '選ぶ'}
        </button>
      )}
      </div>

      {pickerOpen && (
        <WindowPickerOverlay
          windows={windows}
          refreshWindows={refreshWindows}
          currentId={windowId}
          onConfirm={(id, name) => {
            selectWindow(id, name)
            setPickerOpen(false)
          }}
          onCancel={() => setPickerOpen(false)}
        />
      )}

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
                      <img src={d.dataUrl} alt="" className="w-full h-20 object-contain bg-gray-200" />
                      <div className="px-1 py-0.5 text-[11px] text-gray-700 truncate flex items-center gap-1">
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
            <div className="flex items-center gap-2.5 rounded border border-gray-200 bg-white px-2 py-1.5">
              {selectedWindow?.dataUrl && (
                <span className="shrink-0 w-16 h-10 rounded border border-gray-200 bg-gray-100 overflow-hidden flex items-center justify-center">
                  <img src={selectedWindow.dataUrl} alt="" className="max-w-full max-h-full object-contain" />
                </span>
              )}
              <span className="min-w-0 flex-1">
                <span className="block text-[11px] text-gray-500">解析するウィンドウ（1つ）</span>
                <span
                  className={`block truncate text-[13px] font-medium ${windowName ? 'text-gray-800' : 'text-amber-600'}`}
                  title={windowName || undefined}
                >
                  {windowName || '未選択'}
                </span>
              </span>
              <button
                type="button"
                onClick={() => setPickerOpen(true)}
                className="shrink-0 px-2.5 py-1 text-xs rounded border border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
              >
                {windowName ? '変更' : 'ウィンドウを選ぶ'}
              </button>
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
