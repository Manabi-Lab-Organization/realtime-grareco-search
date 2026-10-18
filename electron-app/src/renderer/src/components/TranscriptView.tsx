import { useEffect, useRef, useMemo } from 'react'
import type { TranscriptData } from '../hooks/useElectronAPI'

interface TranscriptViewProps {
  transcripts: TranscriptData[]
  partialTranscript: string
}

function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

export function TranscriptView({ transcripts, partialTranscript }: TranscriptViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  const recentTranscripts = useMemo(() => {
    if (transcripts.length === 0) return []
    const latestTime = transcripts[transcripts.length - 1].startTime
    const cutoff = latestTime - 600000
    let startIdx = transcripts.length
    for (let i = transcripts.length - 1; i >= 0; i--) {
      if (transcripts[i].startTime < cutoff) break
      startIdx = i
    }
    return transcripts.slice(startIdx)
  }, [transcripts])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [transcripts.length, partialTranscript])

  return (
    <div className="flex-1 flex flex-col min-h-0 p-4">
      <div className="flex items-center justify-between mb-2 shrink-0">
        <h3 className="text-xs font-medium text-gray-400 uppercase tracking-wider">Transcript</h3>
        {transcripts.length > 0 && (
          <span className="text-[10px] text-gray-400">
            {transcripts.length}件 / 直近10分表示
          </span>
        )}
      </div>

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto rounded-lg bg-white border border-gray-200/80"
      >
        <div className="p-3 space-y-1">
          {recentTranscripts.length === 0 && !partialTranscript && (
            <div className="flex items-center justify-center h-32 text-sm text-gray-400">
              <div className="text-center">
                <svg className="w-8 h-8 mx-auto mb-2 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                </svg>
                文字起こしを開始してください
              </div>
            </div>
          )}

          {recentTranscripts.map((t, i) => (
            <div key={i} className="text-[13px] leading-relaxed py-0.5">
              <span className="text-gray-400 font-mono text-[11px] mr-1.5">{formatTime(t.startTime)}</span>
              {t.speaker && (
                <span className="text-brand-600 font-medium mr-1.5">{t.speaker}</span>
              )}
              <span className="text-gray-700">{t.content}</span>
            </div>
          ))}

          {partialTranscript && (
            <div className="flex items-start gap-2 py-1 mt-1">
              <span className="text-[10px] px-1.5 py-0.5 bg-brand-100 text-brand-600 rounded shrink-0 font-medium">
                認識中
              </span>
              <span className="text-[13px] text-gray-400 italic">{partialTranscript}</span>
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      </div>
    </div>
  )
}
