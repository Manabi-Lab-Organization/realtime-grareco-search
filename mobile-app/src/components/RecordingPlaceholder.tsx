import { useEffect, useMemo, useRef, useState } from 'react'
import type { PluginListenerHandle } from '@capacitor/core'
import { KeepAwake } from '@capacitor-community/keep-awake'
import { MicCapture, base64ToPcmBytes } from '../lib/micCapture'
import {
  WSClient,
  type ConnectionStatus,
  type TranscriptData,
} from '../lib/ws'
import MeetingListModal from './MeetingListModal'
import {
  getResearchSettings,
  updateResearchSettings,
  postRoomObservationConsent,
  ROOM_OBSERVATION_CONSENT_REQUIRED,
  type MeetingSummary,
} from '../lib/api'
import { openInWeb } from '../lib/webBridge'
import { useRoomObservation } from '../lib/useRoomObservation'
import RoomObservationConsentModal from './RoomObservationConsentModal'
import { ROOM_OBSERVATION_CONSENT_OUTDATED_MESSAGE, ROOM_OBSERVATION_CONSENT_TEXT_VERSION } from '../lib/roomObservationConsent'
import { addImagesFromLibrary } from '../lib/supplementaryImages'
import { APP_VERSION } from '../lib/config'
import { LegalLinks } from './LegalLinks'

interface Props {
  email: string
  token: string
  onLogout: (reason?: 'logout_click' | 'session_invalidated') => void
  roomObservationEnabled: boolean
  roomObservationConsentVersion: number | null
  roomObservationConsentRequiredVersion: number | null
}

type MeetingState = 'idle' | 'starting' | 'recording' | 'paused' | 'stopping' | 'error'

interface FinalLine {
  id: string
  speaker?: string | null
  content: string
  startTime: number
}

const RECENT_WINDOW_MS = 10 * 60 * 1000

const wsLabel: Record<ConnectionStatus, string> = {
  disconnected: '未接続',
  connecting: '接続中…',
  connected: '接続済み',
  reconnecting: '再接続中…',
  error: 'エラー',
}

const wsColor: Record<ConnectionStatus, string> = {
  disconnected: 'text-gray-500',
  connecting: 'text-yellow-400',
  connected: 'text-green-400',
  reconnecting: 'text-yellow-400',
  error: 'text-red-400',
}

export default function RecordingPlaceholder({
  email,
  token,
  onLogout,
  roomObservationEnabled,
  roomObservationConsentVersion,
  roomObservationConsentRequiredVersion,
}: Props) {
  const wsRef = useRef<WSClient | null>(null)
  const [wsStatus, setWsStatus] = useState<ConnectionStatus>('disconnected')
  const [meetingState, setMeetingState] = useState<MeetingState>('idle')
  const [meetingId, setMeetingId] = useState<number | null>(null)
  const [finalLines, setFinalLines] = useState<FinalLine[]>([])
  const [partialText, setPartialText] = useState('')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [interruption, setInterruption] = useState<string | null>(null)
  const [showMeetingList, setShowMeetingList] = useState(false)
  const [researchMain, setResearchMain] = useState<boolean | null>(null)
  const [researchToggling, setResearchToggling] = useState(false)
  const [recentEndAlert, setRecentEndAlert] = useState<{
    open: boolean
    meetingId?: number
  }>({ open: false })

  const roomObservationAvailable =
    roomObservationEnabled && roomObservationConsentRequiredVersion != null
  const [consentVersion, setConsentVersion] = useState<number | null>(roomObservationConsentVersion)
  const consented =
    roomObservationConsentRequiredVersion != null &&
    consentVersion != null &&
    consentVersion >= roomObservationConsentRequiredVersion
  const [consentModalOpen, setConsentModalOpen] = useState(false)
  const [consentBusy, setConsentBusy] = useState(false)
  const [consentError, setConsentError] = useState<string | null>(null)
  const [consentNotice, setConsentNotice] = useState<string | null>(null)
  const obs = useRoomObservation({
    token,
    meetingId,
    active: roomObservationAvailable && consented && meetingState === 'recording',
  })
  const obsOn = obs.enabled && consented

  const [seenObsError, setSeenObsError] = useState<string | null>(null)
  if (obs.lastError !== seenObsError) {
    setSeenObsError(obs.lastError)
    if (obs.lastError === ROOM_OBSERVATION_CONSENT_REQUIRED) {
      setConsentVersion(null)
      setConsentNotice('環境観察の説明が更新されました。内容をご確認のうえ、もう一度オンにしてください。')
    }
  }

  function handleToggleRoomObservation() {
    if (obsOn) {
      void obs.toggle()
      return
    }
    if (!consented) {
      setConsentError(null)
      setConsentModalOpen(true)
      return
    }
    void obs.toggle()
  }

  async function handleConsentAgree() {
    if (roomObservationConsentRequiredVersion == null) return
    if (roomObservationConsentRequiredVersion > ROOM_OBSERVATION_CONSENT_TEXT_VERSION) {
      setConsentError(ROOM_OBSERVATION_CONSENT_OUTDATED_MESSAGE)
      return
    }
    setConsentBusy(true)
    setConsentError(null)
    try {
      const ok = await postRoomObservationConsent(token, ROOM_OBSERVATION_CONSENT_TEXT_VERSION)
      if (!ok) {
        setConsentError('同意を記録できませんでした。通信状況を確認して、もう一度お試しください。')
        return
      }
      setConsentVersion(ROOM_OBSERVATION_CONSENT_TEXT_VERSION)
      setConsentNotice(null)
      setConsentModalOpen(false)
      if (!obs.enabled) await obs.toggle()
    } catch {
      setConsentError('同意を記録できませんでした。もう一度ログインしてからお試しください。')
    } finally {
      setConsentBusy(false)
    }
  }

  const [imgBusy, setImgBusy] = useState(false)
  const [imgMsg, setImgMsg] = useState<string | null>(null)

  const meetingStartRef = useRef<number | null>(null)
  const accumulatedMsRef = useRef<number>(0)
  const [elapsedSec, setElapsedSec] = useState(0)
  const transcriptScrollRef = useRef<HTMLDivElement | null>(null)

  const meetingIdRef = useRef<number | null>(null)
  useEffect(() => {
    meetingIdRef.current = meetingId
  }, [meetingId])

  useEffect(() => {
    const ws = new WSClient()
    wsRef.current = ws
    const offStatus = ws.on('status', setWsStatus)
    const offMeetingCreated = ws.on('meetingCreated', ({ meetingId: id }) => {
      setMeetingId(id)
      setMeetingState('recording')
      meetingStartRef.current = Date.now()
      accumulatedMsRef.current = 0
      setElapsedSec(0)
      ws.setActiveMeeting(id, 'real')
    })
    const offMeetingEnded = ws.on('meetingEnded', (d) => {
      if (
        d?.meetingId != null &&
        meetingIdRef.current != null &&
        d.meetingId !== meetingIdRef.current
      ) {
        return
      }
      setMeetingState('idle')
      setMeetingId(null)
      meetingStartRef.current = null
      accumulatedMsRef.current = 0
      setElapsedSec(0)
      setPartialText('')
      ws.clearActiveMeeting()
      void MicCapture.stop().catch(() => undefined)
      void KeepAwake.allowSleep().catch(() => undefined)
    })
    const offTranscript = ws.on('transcript', (data: TranscriptData) => {
      if (data.isFinal) {
        setFinalLines((prev) => [
          ...prev,
          {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            speaker: data.speaker ?? null,
            content: data.content,
            startTime: data.startTime ?? Date.now(),
          },
        ])
        setPartialText('')
      } else {
        setPartialText(data.content)
      }
    })
    const offTakeover = ws.on('deviceTakeover', ({ takenOverBy }) => {
      setInfo(`他のデバイス (${takenOverBy}) に引き継がれました。「再開」で取り戻せます`)
      setMeetingState('paused')
      void MicCapture.stop().catch(() => undefined)
      void KeepAwake.allowSleep().catch(() => undefined)
    })
    const offError = ws.on('error', (msg) => setErrorMsg(`WS: ${msg}`))
    const offErrorDetail = ws.on('errorDetail', (detail) => {
      if (detail.code === 'recent_end_by_other') {
        setRecentEndAlert({
          open: true,
          meetingId: detail.meetingId,
        })
        setMeetingState('idle')
        setMeetingId(null)
        meetingStartRef.current = null
        ws.clearActiveMeeting()
        void MicCapture.stop().catch(() => undefined)
        void KeepAwake.allowSleep().catch(() => undefined)
      }
    })
    const offResearchSettings = ws.on('researchSettingsUpdated', (settings) => {
      setResearchMain(settings.main)
    })
    const offSessionInvalidated = ws.on('sessionInvalidated', () => {
      onLogout('session_invalidated')
    })

    ws.connect(token)

    return () => {
      offStatus()
      offMeetingCreated()
      offMeetingEnded()
      offTranscript()
      offTakeover()
      offError()
      offErrorDetail()
      offResearchSettings()
      offSessionInvalidated()
      ws.disconnect()
      void KeepAwake.allowSleep().catch(() => undefined)
      wsRef.current = null
    }
  }, [token])

  useEffect(() => {
    let chunkHandle: PluginListenerHandle | null = null
    let interruptHandle: PluginListenerHandle | null = null

    void MicCapture.addListener('pcmChunk', (event) => {
      if (wsRef.current?.getStatus() === 'connected') {
        const bytes = base64ToPcmBytes(event.data)
        wsRef.current.sendAudioChunk(bytes)
      }
    }).then((h) => {
      chunkHandle = h
    })
    void MicCapture.addListener('interruption', (event) => {
      setInterruption(`${event.state}${event.error ? ': ' + event.error : ''}`)
    }).then((h) => {
      interruptHandle = h
    })

    return () => {
      void chunkHandle?.remove()
      void interruptHandle?.remove()
    }
  }, [])

  useEffect(() => {
    let mounted = true
    void getResearchSettings(token).then((s) => {
      if (mounted && s) setResearchMain(s.main)
    })
    return () => {
      mounted = false
    }
  }, [token])

  async function handleToggleResearch() {
    if (researchMain === null || researchToggling) return
    const next = !researchMain
    setResearchToggling(true)
    setResearchMain(next)
    const result = await updateResearchSettings(token, { main: next })
    setResearchToggling(false)
    if (!result) {
      setResearchMain(!next)
      setErrorMsg('リアルタイム調査の設定の更新に失敗しました')
    } else {
      setResearchMain(result.main)
    }
  }

  useEffect(() => {
    if (meetingState !== 'recording') return
    const segStart = Date.now()
    const tick = (): void => {
      setElapsedSec(Math.floor((accumulatedMsRef.current + (Date.now() - segStart)) / 1000))
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => {
      accumulatedMsRef.current += Date.now() - segStart
      clearInterval(id)
    }
  }, [meetingState])

  useEffect(() => {
    const el = transcriptScrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [finalLines.length, partialText])

  const visibleLines = useMemo(() => {
    if (finalLines.length === 0) return []
    const latest = finalLines[finalLines.length - 1].startTime
    const cutoff = latest - RECENT_WINDOW_MS
    let startIdx = finalLines.length
    for (let i = finalLines.length - 1; i >= 0; i--) {
      if (finalLines[i].startTime < cutoff) break
      startIdx = i
    }
    return finalLines.slice(startIdx)
  }, [finalLines])

  async function ensureMicPermission(): Promise<boolean> {
    const perm = await MicCapture.requestPermission()
    if (!perm.granted) {
      setErrorMsg('マイク権限が拒否されました。設定アプリで許可してください。')
      setMeetingState('error')
      return false
    }
    return true
  }

  async function handleStart() {
    setErrorMsg(null)
    setInfo(null)
    setInterruption(null)
    setFinalLines([])
    setPartialText('')

    if (!wsRef.current || wsRef.current.getStatus() !== 'connected') {
      setErrorMsg('サーバーに接続できていません。少し待ってから再試行してください。')
      return
    }

    setMeetingState('starting')
    try {
      if (!(await ensureMicPermission())) return
      await MicCapture.start()
      void KeepAwake.keepAwake().catch(() => undefined)
      wsRef.current.startMeeting('real')
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err))
      setMeetingState('error')
      void MicCapture.stop().catch(() => undefined)
      void KeepAwake.allowSleep().catch(() => undefined)
    }
  }

  async function handleStop() {
    setMeetingState('stopping')
    try {
      wsRef.current?.pauseMeeting()
      await MicCapture.stop()
      void KeepAwake.allowSleep().catch(() => undefined)
      setMeetingState('paused')
      setInfo('一時停止中。「再開」「終了」「新しい会議」から選んでください')
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err))
      setMeetingState('error')
    }
  }

  async function handleResume() {
    if (!meetingId) {
      setErrorMsg('再開する会議がありません')
      return
    }
    if (!wsRef.current || wsRef.current.getStatus() !== 'connected') {
      setErrorMsg('サーバーに接続できていません')
      return
    }
    setErrorMsg(null)
    setInfo(null)
    setMeetingState('starting')
    try {
      if (!(await ensureMicPermission())) return
      await MicCapture.start()
      void KeepAwake.keepAwake().catch(() => undefined)
      wsRef.current.setActiveMeeting(meetingId, 'real')
      wsRef.current.resumeMeeting(meetingId, 'real')
      setMeetingState('recording')
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err))
      setMeetingState('paused')
      void MicCapture.stop().catch(() => undefined)
      void KeepAwake.allowSleep().catch(() => undefined)
    }
  }

  async function handleEnd() {
    setMeetingState('stopping')
    try {
      wsRef.current?.endMeeting()
      wsRef.current?.clearActiveMeeting()
      setMeetingState('idle')
      setMeetingId(null)
      meetingStartRef.current = null
      setInfo('会議を終了しました')
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err))
      setMeetingState('error')
    }
  }

  function handleNewMeetingPrep() {
    setMeetingId(null)
    meetingStartRef.current = null
    setFinalLines([])
    setPartialText('')
    setMeetingState('idle')
    setInfo('新しい会議の準備ができました。「新規文字起こし」を押してください')
    wsRef.current?.clearActiveMeeting()
  }

  async function handleResumeMeeting(meeting: MeetingSummary) {
    setShowMeetingList(false)
    setErrorMsg(null)
    setInfo(null)
    setInterruption(null)
    setFinalLines([])
    setPartialText('')

    if (!wsRef.current || wsRef.current.getStatus() !== 'connected') {
      setErrorMsg('サーバーに接続できていません。少し待ってから再試行してください。')
      return
    }

    setMeetingState('starting')
    try {
      if (!(await ensureMicPermission())) return
      await MicCapture.start()
      void KeepAwake.keepAwake().catch(() => undefined)
      wsRef.current.setActiveMeeting(meeting.id, 'real')
      wsRef.current.resumeMeeting(meeting.id, 'real')
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err))
      setMeetingState('error')
      void MicCapture.stop().catch(() => undefined)
      void KeepAwake.allowSleep().catch(() => undefined)
    }
  }

  async function handleAddImagesFromLibrary() {
    if (!meetingId || imgBusy) return
    setImgBusy(true)
    setImgMsg('写真を選択中…')
    try {
      const r = await addImagesFromLibrary(token, meetingId, (done, total) => {
        if (total > 0) setImgMsg(`アップロード中 ${done}/${total}`)
      })
      setImgMsg(
        r.cancelled || r.total === 0
          ? null
          : `補足資料に${r.uploaded}枚追加${r.failed ? `（${r.failed}枚失敗）` : ''}`,
      )
    } catch (err) {
      setImgMsg(err instanceof Error ? `失敗: ${err.message}` : '画像の追加に失敗しました')
    } finally {
      setImgBusy(false)
    }
  }

  const isRecording = meetingState === 'recording'
  const isPaused = meetingState === 'paused'
  const isBusy = meetingState === 'starting' || meetingState === 'stopping'
  const buttonDisabled =
    isBusy || (wsStatus !== 'connected' && !isRecording && !isPaused)

  const elapsedLabel = useMemo(() => {
    const m = Math.floor(elapsedSec / 60)
    const s = elapsedSec % 60
    return `${m}:${String(s).padStart(2, '0')}`
  }, [elapsedSec])

  return (
    <div className="relative flex h-full flex-col p-4 pt-12 gap-3">
      {recentEndAlert.open && (
        <div className="rounded-md border border-yellow-700 bg-yellow-950/40 p-3 text-xs text-yellow-100 space-y-2">
          <div className="flex items-start gap-2">
            <span className="text-base">⚠️</span>
            <div className="flex-1">
              <p className="font-semibold text-yellow-200 mb-1">
                この会議は別デバイスで終了されました
              </p>
              <p className="text-yellow-100/90 leading-relaxed">
                続けて記録したい場合は <strong>終了したデバイスから</strong> 再開してください。<br />
                このデバイスで新しい会議を始める場合は <strong>「新規文字起こし」</strong> を、<br />
                過去会議に追記する場合は <strong>1分後</strong> に再度お試しください。
              </p>
              {recentEndAlert.meetingId && (
                <p className="text-yellow-300/60 mt-1">会議 #{recentEndAlert.meetingId}</p>
              )}
            </div>
            <button
              type="button"
              onClick={() => setRecentEndAlert({ open: false })}
              className="text-yellow-300 hover:text-yellow-100 text-sm shrink-0 px-1"
              aria-label="閉じる"
            >
              ×
            </button>
          </div>
        </div>
      )}

      <header className="flex items-center justify-between text-xs">
        <div className="min-w-0">
          <p className="text-white text-sm font-semibold">Realtime GraReco &amp; Search</p>
          <p className="text-gray-500 truncate">{email}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <div className="text-right">
            <p className={wsColor[wsStatus]}>● {wsLabel[wsStatus]}</p>
            {meetingId && <p className="text-gray-500">#{meetingId}</p>}
          </div>
          {meetingId && (
            <button
              type="button"
              onClick={() => {
                void openInWeb(`/meetings/${meetingId}`, token)
              }}
              className="px-2 py-1 text-[10px] font-medium rounded border border-blue-700 bg-blue-900/30 text-blue-300 hover:bg-blue-900/60 active:bg-blue-900"
              title="現在の会議の詳細を Safari で開く"
            >
              Web
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              void openInWeb('/mypage', token)
            }}
            className="px-2 py-1 text-[10px] font-medium rounded border border-gray-700 bg-gray-900 text-gray-400 hover:bg-gray-800"
            title="設定 (Web)"
          >
            ⚙️
          </button>
        </div>
      </header>

      <button
        type="button"
        onClick={handleToggleResearch}
        disabled={researchMain === null || researchToggling || wsStatus !== 'connected'}
        className={`flex items-center justify-between rounded-xl px-4 py-3.5 border-2 transition-colors disabled:opacity-50 ${
          researchMain
            ? 'bg-purple-900/40 border-purple-500 text-purple-50'
            : 'bg-gray-900 border-gray-700 text-gray-300'
        }`}
      >
        <span className="text-base font-medium">🧠 リアルタイム調査</span>
        <span
          className={`text-sm font-bold px-2.5 py-1 rounded-full ${
            researchMain ? 'bg-purple-500 text-white' : 'bg-gray-700 text-gray-300'
          }`}
        >
          {researchMain === null ? '…' : researchMain ? 'ON' : 'OFF'}
        </span>
      </button>

      {roomObservationAvailable && (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={handleToggleRoomObservation}
            className={`flex items-center justify-between rounded-xl px-4 py-3.5 border-2 transition-colors ${
              obsOn
                ? 'bg-teal-900/40 border-teal-500 text-teal-50'
                : 'bg-gray-900 border-gray-700 text-gray-300'
            }`}
          >
            <span className="text-base font-medium">📷 環境観察（カメラ）</span>
            <span
              className={`text-sm font-bold px-2.5 py-1 rounded-full ${
                obsOn ? 'bg-teal-500 text-white' : 'bg-gray-700 text-gray-300'
              }`}
            >
              {obsOn ? 'ON' : 'OFF'}
            </span>
          </button>

          {consentNotice && !obsOn && (
            <p className="text-xs text-amber-300 px-1 leading-relaxed">{consentNotice}</p>
          )}

          {obsOn && (
            <div className="flex flex-col gap-2 rounded-xl border border-gray-800 bg-gray-900/40 p-3">
              <span className="text-sm text-gray-300">カメラの向き</span>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => obs.setFacing('front')}
                  className={`py-3 rounded-lg text-base font-medium border-2 transition-colors ${
                    obs.facing === 'front'
                      ? 'border-teal-500 bg-teal-900/50 text-teal-50'
                      : 'border-gray-700 bg-gray-900 text-gray-400'
                  }`}
                >
                  前面（自分側）
                </button>
                <button
                  type="button"
                  onClick={() => obs.setFacing('back')}
                  className={`py-3 rounded-lg text-base font-medium border-2 transition-colors ${
                    obs.facing === 'back'
                      ? 'border-teal-500 bg-teal-900/50 text-teal-50'
                      : 'border-gray-700 bg-gray-900 text-gray-400'
                  }`}
                >
                  背面（部屋側）
                </button>
              </div>
              <p className="text-xs text-gray-400 leading-relaxed">
                {meetingState === 'recording'
                  ? obs.status === 'error'
                    ? '⚠ 解析待機中（接続・権限を確認）'
                    : '● 環境解析中（画像は保存されません）'
                  : '録音を開始すると解析します（アプリ表示中のみ）'}
              </p>
            </div>
          )}
          {obsOn && obs.lastError && obs.lastError !== ROOM_OBSERVATION_CONSENT_REQUIRED && (
            <p className="text-xs text-red-400 px-1 leading-relaxed">{obs.lastError}</p>
          )}
        </div>
      )}

      <div className="flex flex-col items-center gap-2">
        <button
          type="button"
          onClick={
            isRecording
              ? handleStop
              : isPaused
                ? handleResume
                : handleStart
          }
          disabled={buttonDisabled}
          className={`h-28 w-28 rounded-full flex items-center justify-center text-white font-semibold transition-colors disabled:opacity-50 ${
            isRecording
              ? 'bg-red-600 hover:bg-red-500 active:bg-red-700'
              : isPaused
                ? 'bg-green-600 hover:bg-green-500 active:bg-green-700'
                : 'bg-blue-600 hover:bg-blue-500 active:bg-blue-700'
          }`}
        >
          {meetingState === 'starting' && '準備中…'}
          {meetingState === 'stopping' && '停止中…'}
          {meetingState === 'recording' && '一時停止'}
          {meetingState === 'paused' && '再開'}
          {(meetingState === 'idle' || meetingState === 'error') && '新規文字起こし'}
        </button>

        {isRecording && (
          <p className="text-xs text-gray-300 font-mono">{elapsedLabel}</p>
        )}

        {isRecording && (
          <div className="w-full flex flex-col gap-2 mt-1">
            <button
              type="button"
              onClick={handleAddImagesFromLibrary}
              disabled={imgBusy}
              className="w-full py-3 rounded-lg text-sm font-medium border-2 border-blue-700 bg-blue-900/30 text-blue-100 active:bg-blue-900 disabled:opacity-50"
            >
              📎 補足資料に画像を追加（複数可）
            </button>
            {imgMsg && (
              <p className="text-center text-xs text-amber-300">{imgMsg}</p>
            )}
          </div>
        )}

        {isPaused && (
          <div className="flex items-center gap-3 mt-1">
            <button
              type="button"
              onClick={handleEnd}
              disabled={isBusy}
              className="text-xs px-3 py-1.5 rounded-md bg-red-900/30 border border-red-700 text-red-300 hover:bg-red-900/50 active:bg-red-900 disabled:opacity-50"
            >
              ✓ 終了
            </button>
            <button
              type="button"
              onClick={handleNewMeetingPrep}
              disabled={isBusy}
              className="text-xs px-3 py-1.5 rounded-md bg-gray-900 border border-gray-700 text-gray-300 hover:bg-gray-800 active:bg-gray-700 disabled:opacity-50"
            >
              + 新しい会議
            </button>
          </div>
        )}

        {meetingState === 'idle' && (
          <button
            type="button"
            onClick={() => setShowMeetingList(true)}
            disabled={wsStatus !== 'connected'}
            className="text-xs text-blue-400 underline disabled:opacity-50"
          >
            過去の会議を再開…
          </button>
        )}

        {info && <p className="text-xs text-yellow-300 text-center px-4">{info}</p>}
        {errorMsg && <p className="text-xs text-red-400 text-center px-4">{errorMsg}</p>}
        {interruption && (
          <p className="text-xs text-yellow-400">中断: {interruption}</p>
        )}
      </div>

      <div className="flex items-center justify-between text-[10px] text-gray-600 px-1">
        <span>{finalLines.length} 件 / 直近10分表示</span>
        {meetingState === 'recording' && wsStatus === 'connected' && (
          <span className="text-green-400/70">● rec</span>
        )}
        {meetingState === 'recording' && wsStatus !== 'connected' && (
          <span className="text-amber-400 font-semibold">⚠ 再接続中・未記録</span>
        )}
      </div>

      <div
        ref={transcriptScrollRef}
        className="flex-1 min-h-0 bg-gray-900/60 rounded-md border border-gray-800 p-3 overflow-y-auto"
      >
        {visibleLines.length === 0 && !partialText && (
          <p className="text-xs text-gray-600 text-center mt-4">
            {isRecording
              ? '文字起こし結果がここに表示されます…'
              : '会議を開始すると文字起こしが表示されます'}
          </p>
        )}
        <div className="space-y-2 text-[13px] leading-relaxed">
          {visibleLines.map((line) => (
            <p key={line.id} className="text-gray-100">
              {line.speaker && (
                <span className="text-gray-500 mr-1">[{line.speaker}]</span>
              )}
              {line.content}
            </p>
          ))}
          {partialText && (
            <p className="text-gray-400 italic">{partialText}</p>
          )}
        </div>
      </div>

      <button
        type="button"
        onClick={() => onLogout('logout_click')}
        disabled={isRecording}
        title={isRecording ? '文字起こし中はログアウトできません。先に一時停止または終了してください' : undefined}
        className="text-[10px] text-gray-700 underline self-center disabled:opacity-40 disabled:no-underline disabled:cursor-not-allowed"
      >
        ログアウト
      </button>

      {APP_VERSION && (
        <button
          type="button"
          onClick={() => {
            void openInWeb('/changelog', token)
          }}
          className="text-[10px] text-gray-700 self-center"
          title="更新履歴を見る"
        >
          v{APP_VERSION}
        </button>
      )}

      <LegalLinks />

      {consentModalOpen && (
        <RoomObservationConsentModal
          busy={consentBusy}
          error={consentError}
          onAgree={() => void handleConsentAgree()}
          onDecline={() => setConsentModalOpen(false)}
        />
      )}

      {showMeetingList && (
        <MeetingListModal
          token={token}
          onClose={() => setShowMeetingList(false)}
          onResume={handleResumeMeeting}
        />
      )}
    </div>
  )
}
