import { useState, useEffect, useCallback } from 'react'

type PermissionStatus = 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown'

interface PermissionState {
  microphone: PermissionStatus
  screen: PermissionStatus
}

interface PermissionGuideProps {
  meetingMode: 'online' | 'real'
  onAllGranted: () => void
  onClose: () => void
}

export function PermissionGuide({ meetingMode, onAllGranted, onClose }: PermissionGuideProps) {
  const api = window.electronAPI
  const [permissions, setPermissions] = useState<PermissionState | null>(null)
  const [requesting, setRequesting] = useState(false)
  const [screenTriggered, setScreenTriggered] = useState(false)
  const needsScreen = meetingMode === 'online'

  const checkPermissions = useCallback(async () => {
    const result = await api.checkPermissions()
    setPermissions(result as PermissionState)
  }, [])

  useEffect(() => {
    checkPermissions()
    const interval = setInterval(checkPermissions, 2000)
    return () => clearInterval(interval)
  }, [checkPermissions])

  useEffect(() => {
    if (!permissions) return
    const micOk = permissions.microphone === 'granted'
    const screenOk = !needsScreen || permissions.screen === 'granted'
    if (micOk && screenOk) {
      onAllGranted()
    }
  }, [permissions, needsScreen, onAllGranted])

  const handleRequestMicrophone = useCallback(async () => {
    setRequesting(true)
    await api.requestMicrophone()
    await checkPermissions()
    setRequesting(false)
  }, [checkPermissions])

  const handleTriggerScreenCapture = useCallback(async () => {
    setRequesting(true)
    await api.triggerScreenCapture()
    setScreenTriggered(true)
    setTimeout(async () => {
      await checkPermissions()
      setRequesting(false)
    }, 1000)
  }, [checkPermissions])

  const handleOpenScreenSettings = useCallback(() => {
    api.openScreenRecordingSettings()
  }, [])

  const handleRelaunch = useCallback(() => {
    api.relaunchApp()
  }, [])

  if (!permissions) return null

  const micGranted = permissions.microphone === 'granted'
  const screenGranted = permissions.screen === 'granted'
  const micNotAsked = permissions.microphone === 'not-determined'
  const screenNotAsked = permissions.screen === 'not-determined'

  const screenNeedsFirstTrigger = needsScreen && !screenGranted && !screenTriggered

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="bg-white rounded-xl shadow-2xl w-[420px] max-w-[90vw] overflow-hidden">
        <div className="bg-brand-600 px-5 py-3.5">
          <h2 className="text-sm font-semibold text-white">権限の設定</h2>
          <p className="text-[11px] text-brand-200 mt-0.5">
            {needsScreen
              ? '文字起こしを行うにはマイクと画面収録の権限が必要です'
              : '文字起こしを行うにはマイクの権限が必要です'}
          </p>
        </div>

        <div className="p-5 space-y-4">
          <PermissionStep
            step={1}
            title="マイクのアクセス"
            status={micGranted ? 'granted' : micNotAsked ? 'pending' : 'denied'}
            isActive={!micGranted}
          >
            {!micGranted && (
              <>
                <button
                  onClick={handleRequestMicrophone}
                  disabled={requesting}
                  className="mt-2 px-3 py-1.5 text-xs font-medium bg-brand-600 text-white rounded-md hover:bg-brand-500 disabled:opacity-40 transition-colors cursor-pointer flex items-center gap-1.5"
                >
                  {requesting && <LoadingSpinner />}
                  {micNotAsked ? '許可する' : '再度許可する'}
                </button>
                {permissions.microphone === 'denied' && (
                  <p className="mt-1.5 text-[10px] text-red-500">
                    拒否されています → システム設定 → プライバシーとセキュリティ → マイク で許可してください
                  </p>
                )}
              </>
            )}
          </PermissionStep>

          {needsScreen && (
            <PermissionStep
              step={2}
              title="画面収録（システム音声の取得に必要）"
              status={screenGranted ? 'granted' : 'pending'}
              isActive={micGranted && !screenGranted}
            >
              {!screenGranted && micGranted && (
                <>
                  {screenNeedsFirstTrigger ? (
                    <>
                      <p className="text-[10px] text-gray-500 mt-1">
                        まずOSの許可ダイアログを表示します
                      </p>
                      <button
                        onClick={handleTriggerScreenCapture}
                        disabled={requesting}
                        className="mt-2 px-3 py-1.5 text-xs font-medium bg-brand-600 text-white rounded-md hover:bg-brand-500 disabled:opacity-40 transition-colors cursor-pointer flex items-center gap-1.5"
                      >
                        {requesting && <LoadingSpinner />}
                        画面収録を許可する
                      </button>
                    </>
                  ) : (
                    <>
                      <p className="text-[10px] text-gray-500 mt-1">
                        システム設定で「Realtime GraReco & Search」にチェックを入れてください
                      </p>
                      <button
                        onClick={handleOpenScreenSettings}
                        className="mt-2 px-3 py-1.5 text-xs font-medium bg-brand-600 text-white rounded-md hover:bg-brand-500 transition-colors cursor-pointer"
                      >
                        システム設定を開く
                      </button>
                    </>
                  )}
                </>
              )}
            </PermissionStep>
          )}

          {needsScreen && !screenGranted && micGranted && !screenNeedsFirstTrigger && (
            <PermissionStep
              step={3}
              title="アプリの再起動"
              status="pending"
              isActive={true}
            >
              <p className="text-[10px] text-gray-500 mt-1">
                画面収録の権限を変更した後はアプリの再起動が必要です
              </p>
              <button
                onClick={handleRelaunch}
                className="mt-2 px-3 py-1.5 text-xs font-medium bg-brand-600 text-white rounded-md hover:bg-brand-500 transition-colors cursor-pointer flex items-center gap-1.5"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                今すぐ再起動
              </button>
            </PermissionStep>
          )}

          {!needsScreen && micGranted && (
            <p className="text-xs text-brand-600 font-medium">
              準備完了です。このまま文字起こしを開始できます。
            </p>
          )}
        </div>

        <div className="px-5 py-3 bg-gray-50 border-t border-gray-200 flex items-center justify-between">
          <button
            onClick={handleRelaunch}
            className="text-[11px] text-gray-500 hover:text-brand-600 transition-colors cursor-pointer flex items-center gap-1"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            アプリを再起動
          </button>
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-[11px] text-gray-500 hover:text-gray-700 transition-colors cursor-pointer"
          >
            閉じる
          </button>
        </div>
      </div>
    </div>
  )
}

function PermissionStep({
  step,
  title,
  status,
  isActive,
  children
}: {
  step: number
  title: string
  status: 'granted' | 'pending' | 'denied'
  isActive: boolean
  children?: React.ReactNode
}) {
  return (
    <div
      className={`flex gap-3 p-3 rounded-lg border transition-colors ${
        isActive
          ? 'border-brand-200 bg-brand-50/50'
          : status === 'granted'
            ? 'border-green-200 bg-green-50/50'
            : 'border-gray-200 bg-gray-50/50 opacity-60'
      }`}
    >
      <div className="shrink-0">
        {status === 'granted' ? (
          <span className="flex items-center justify-center w-6 h-6 rounded-full bg-green-500 text-white">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
            </svg>
          </span>
        ) : (
          <span className={`flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold ${
            isActive ? 'bg-brand-600 text-white' : 'bg-gray-300 text-white'
          }`}>
            {step}
          </span>
        )}
      </div>

      <div className="flex-1 min-w-0">
        <p className={`text-xs font-medium ${status === 'granted' ? 'text-green-700' : 'text-gray-800'}`}>
          {title}
          {status === 'granted' && (
            <span className="ml-1.5 text-[10px] text-green-500 font-normal">許可済み</span>
          )}
        </p>
        {children}
      </div>
    </div>
  )
}

function LoadingSpinner() {
  return (
    <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  )
}
