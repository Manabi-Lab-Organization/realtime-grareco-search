interface CompactBarProps {
  latestTranscript: string
  isRecording: boolean
  elapsedTime: string
  micStatus: 'off' | 'active' | 'error'
  systemAudioStatus: 'off' | 'active' | 'error'
  meetingMode: 'online' | 'real'
  statusMessage: string
  isConnected: boolean
  isToggling: boolean
  hasMeeting: boolean
  onExpand: () => void
  onToggleRecording: () => void
  roomObserving?: boolean
}

function CompactSpinner() {
  return (
    <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  )
}

export function CompactBar({
  latestTranscript,
  isRecording,
  elapsedTime,
  micStatus,
  systemAudioStatus,
  meetingMode,
  statusMessage,
  isConnected,
  isToggling,
  hasMeeting,
  onExpand,
  onToggleRecording,
  roomObserving = false
}: CompactBarProps) {
  return (
    <div className="h-screen bg-brand-600 rounded-b-xl overflow-hidden flex flex-col">
      <div className="flex items-center gap-2 px-3 pt-2 pb-1" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
        <div className="flex-1 min-w-0 text-xs text-white/90 overflow-hidden whitespace-nowrap" dir="rtl">
          {latestTranscript ? (
            <span dir="ltr" className="inline-block">{latestTranscript}</span>
          ) : (
            <span dir="ltr" className="text-white/40">
              文字起こしを待っています
            </span>
          )}
        </div>
        <button
          onClick={onExpand}
          className="w-6 h-6 rounded-md bg-white/10 hover:bg-white/20 text-white flex items-center justify-center shrink-0 transition-colors cursor-pointer"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          aria-label="展開"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
          </svg>
        </button>
      </div>

      <div className="flex items-center gap-2 px-3 pb-2 pt-0.5" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <button
          onClick={onToggleRecording}
          disabled={!isConnected || isToggling}
          className={`flex items-center gap-1.5 px-2.5 py-1 text-[10px] font-semibold rounded-md transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
            isRecording
              ? 'bg-red-500 hover:bg-red-400 text-white'
              : 'bg-white/20 hover:bg-white/30 text-white'
          }`}
        >
          {isToggling ? (
            <CompactSpinner />
          ) : isRecording ? (
            <span className="flex gap-[1.5px]">
              <span className="w-[2px] h-1.5 rounded-sm bg-white animate-pulse-recording" />
              <span className="w-[2px] h-1.5 rounded-sm bg-white animate-pulse-recording" />
            </span>
          ) : (
            <span className="w-1.5 h-1.5 rounded-full bg-white" />
          )}
          {isToggling ? '...' : isRecording ? '一時停止' : hasMeeting ? '再開' : 'Rec'}
        </button>

        {hasMeeting && (
          <span
            className="text-[9px] font-semibold px-1 py-0.5 rounded bg-white/15 text-white/90 shrink-0"
            title={meetingMode === 'online' ? 'オンライン会議モード（マイク＋システム音声）' : 'リアル会議モード（マイクのみ）'}
          >
            {meetingMode === 'online' ? '📞 オンライン' : '🎙️ リアル'}
          </span>
        )}

        {isRecording && (
          <span className="text-[10px] font-mono text-red-300 animate-pulse-recording shrink-0">
            {elapsedTime}
          </span>
        )}

        {isRecording && <div className="w-px h-3 bg-white/15 shrink-0" />}

        {isRecording && (
          <div className="flex items-center gap-1.5 text-[9px] shrink-0">
            <span className={`flex items-center gap-0.5 ${micStatus === 'active' ? 'text-white/80' : 'text-white/30'}`}>
              <svg className="w-2.5 h-2.5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
                <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
              </svg>
              {micStatus === 'active' ? 'ON' : 'OFF'}
            </span>
            {meetingMode === 'online' && (
              <span className={`flex items-center gap-0.5 ${systemAudioStatus === 'active' ? 'text-white/80' : systemAudioStatus === 'error' ? 'text-red-300' : 'text-white/30'}`}>
                <svg className="w-2.5 h-2.5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z" />
                </svg>
                {systemAudioStatus === 'active' ? 'ON' : systemAudioStatus === 'error' ? 'NG' : 'OFF'}
              </span>
            )}
          </div>
        )}

        {roomObserving && (
          <span
            className="flex items-center gap-1 text-[9px] font-semibold px-1 py-0.5 rounded bg-white/15 text-emerald-200 shrink-0"
            title="環境観察中（約1分ごとにカメラ / 画面を解析しています。画像は保存しません）"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            環境観察中
          </span>
        )}

        <div className="flex-1" />

        <span className="text-[9px] text-white/40 truncate max-w-[100px]">
          {statusMessage}
        </span>
      </div>
    </div>
  )
}
