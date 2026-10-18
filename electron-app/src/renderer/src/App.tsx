import { useState, useEffect, useRef, useCallback } from 'react'
import { useElectronAPI, useAudioCapture } from './hooks/useElectronAPI'
import { TranscriptView } from './components/TranscriptView'
import { MeetingList } from './components/MeetingList'
import { PermissionGuide } from './components/PermissionGuide'
import { CompactBar } from './components/CompactBar'
import LoginScreen from './components/LoginScreen'
import ServerSetupScreen from './components/ServerSetupScreen'
import { AnnouncementsBell } from './components/AnnouncementsBell'
import { CaptureReviewModal } from './components/CaptureReviewModal'
import type { DisplayShot } from './components/CaptureReviewModal'
import { ScreenshotShortcutSetting } from './components/ScreenshotShortcutSetting'
import { RoomObservationSetting } from './components/RoomObservationSetting'
import { useRoomObservation } from './hooks/useRoomObservation'
import { RoomObservationConsentModal } from './components/RoomObservationConsentModal'
import {
  ROOM_OBSERVATION_CONSENT_OUTDATED_MESSAGE,
  ROOM_OBSERVATION_CONSENT_REQUIRED,
  ROOM_OBSERVATION_CONSENT_TEXT_VERSION,
} from './lib/roomObservationConsent'
import { LegalLinks } from './components/LegalLinks'

function Spinner({ className = 'w-3.5 h-3.5' }: { className?: string }) {
  return (
    <svg className={`${className} animate-spin`} fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  )
}

function formatStartedAt(iso: string): string {
  try {
    return new Date(iso).toLocaleString('ja-JP', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
  } catch {
    return ''
  }
}

function useLiveMeetingStatus(meetingId: number | null): {
  elapsedText: string
  participantCount: number | null
} {
  const [elapsed, setElapsed] = useState(0)
  const [participantCount, setParticipantCount] = useState<number | null>(null)
  const baseRef = useRef<{ seconds: number; atMs: number; running: boolean }>({
    seconds: 0,
    atMs: Date.now(),
    running: false
  })

  useEffect(() => {
    if (meetingId == null) {
      baseRef.current = { seconds: 0, atMs: Date.now(), running: false }
      setElapsed(0)
      setParticipantCount(null)
      return undefined
    }

    let cancelled = false
    const poll = async (): Promise<void> => {
      try {
        const m = await window.electronAPI.fetchMeetingDetail(meetingId)
        if (cancelled || !m) return
        const running = m.status === 'active' && !m.pausedSince
        baseRef.current = { seconds: m.recordedSeconds ?? 0, atMs: Date.now(), running }
        setParticipantCount(typeof m.participantCount === 'number' ? m.participantCount : null)
      } catch {
      }
    }

    void poll()
    const pollTimer = setInterval(() => void poll(), 7000)
    const tickTimer = setInterval(() => {
      const b = baseRef.current
      const secs = b.running ? b.seconds + Math.floor((Date.now() - b.atMs) / 1000) : b.seconds
      setElapsed(Math.max(0, secs))
    }, 1000)

    return () => {
      cancelled = true
      clearInterval(pollTimer)
      clearInterval(tickTimer)
    }
  }, [meetingId])

  const hours = Math.floor(elapsed / 3600)
  const minutes = Math.floor((elapsed % 3600) / 60)
  const seconds = elapsed % 60
  const elapsedText =
    hours > 0
      ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
      : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  return { elapsedText, participantCount }
}

const RELOGIN_BUTTON_DELAY_MS = 60_000

export default function App() {
  const {
    connectionStatus,
    currentMeetingId,
    transcripts,
    partialTranscript,
    error,
    connect,
    disconnect,
    startMeeting,
    resumeMeeting,
    pauseMeeting,
    endMeeting,
    sendAudio,
    getSettings,
    saveSettings,
    fetchMeetings,
    getSavedMeetingId,
    setSavedMeetingId: persistSavedMeetingId,
    detectedTerms,
    dismissTerm,
    clearTranscripts,
    clearError,
    setCurrentMeetingId,
    windowMode,
    setCompactMode,
    setExpandedMode
  } = useElectronAPI()

  const [serverURL, setServerURL] = useState('')
  const [editingServer, setEditingServer] = useState(false)
  const [appVersion, setAppVersion] = useState('')
  const [loggedIn, setLoggedIn] = useState(false)
  const [tokenReadFailed, setTokenReadFailed] = useState(false)
  const [meetingMode, setMeetingMode] = useState<'online' | 'real'>('online')
  const [isRecording, setIsRecording] = useState(false)
  const [statusMessage, setStatusMessage] = useState('待機中')
  const [savedMeetingId, setSavedMeetingId] = useState<number | null>(null)
  const [savedMeetingInfo, setSavedMeetingInfo] = useState<{
    title: string | null
    startedAt: string
  } | null>(null)
  const meetingType = 'general'
  const [isToggling, setIsToggling] = useState(false)
  const [isEnding, setIsEnding] = useState(false)
  const [isConnecting, setIsConnecting] = useState(false)
  const [showPermissionGuide, setShowPermissionGuide] = useState(false)
  const [showSystemAudioWarning, setShowSystemAudioWarning] = useState(false)
  const [showReloginButton, setShowReloginButton] = useState(false)
  useEffect(() => {
    if (connectionStatus === 'connected' || connectionStatus === 'connecting') {
      setShowReloginButton(false)
      return
    }
    const timer = window.setTimeout(() => setShowReloginButton(true), RELOGIN_BUTTON_DELAY_MS)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionStatus === 'connected' || connectionStatus === 'connecting'])

  const [sessionExpired, setSessionExpired] = useState(false)
  const [showLoginOverlay, setShowLoginOverlay] = useState(false)
  const expiredEmailRef = useRef<string | undefined>(undefined)
  const sessionExpiredRef = useRef(false)
  sessionExpiredRef.current = sessionExpired
  const [authEpoch, setAuthEpoch] = useState(0)

  const [authEmail, setAuthEmail] = useState<string | undefined>(undefined)
  const [roomObsServer, setRoomObsServer] = useState<{
    enabled: boolean
    consentVersion: number | null
    requiredVersion: number | null
  }>({ enabled: false, consentVersion: null, requiredVersion: null })
  const [settingsLoaded, setSettingsLoaded] = useState(false)
  const pendingRecordRef = useRef(false)
  const prevConnectionStatusRef = useRef<typeof connectionStatus>(connectionStatus)
  const isAutoResumingRef = useRef(false)
  const [recentEndDialog, setRecentEndDialog] = useState<{
    open: boolean
    meetingId?: number
    message: string
  }>({ open: false, message: '' })

  useEffect(() => {
    void window.electronAPI
      .getAppVersion()
      .then((v) => setAppVersion(v))
      .catch(() => setAppVersion(''))
  }, [])

  useEffect(() => {
    const unsub = window.electronAPI.onErrorDetail((detail) => {
      console.log('[App] onErrorDetail:', detail)
      if (detail.code === 'recent_end_by_other') {
        setRecentEndDialog({
          open: true,
          meetingId: detail.meetingId,
          message: detail.message,
        })
        setIsToggling(false)
      }
    })
    return unsub
  }, [])

  const [meetingTitle, setMeetingTitle] = useState<string>('')
  const [isEditingTitle, setIsEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [savingTitle, setSavingTitle] = useState(false)

  const { isCapturing, audioChunkCount, micStatus, systemAudioStatus, startCapture, stopCapture } = useAudioCapture(
    sendAudio,
    meetingMode
  )

  const { elapsedText: elapsedTime, participantCount } = useLiveMeetingStatus(currentMeetingId)

  useEffect(() => {
    getSettings().then((settings) => {
      setServerURL(settings.serverURL)
      setLoggedIn(settings.loggedIn)
      setTokenReadFailed(!!settings.tokenReadFailed)
      setMeetingMode(settings.meetingMode)
      if (settings.loggedIn) {
        connect()
      }
      setSettingsLoaded(true)
    })
    getSavedMeetingId().then((id) => setSavedMeetingId(id))
  }, [])

  const handleLoggedIn = useCallback(
    async (user: { email: string }) => {
      if (sessionExpired) {
        if (expiredEmailRef.current && user.email !== expiredEmailRef.current) {
          setSavedMeetingId(null)
          setCurrentMeetingId(null)
          clearTranscripts()
        }
        expiredEmailRef.current = undefined
        setSessionExpired(false)
        setShowLoginOverlay(false)
        setStatusMessage('再ログインしました')
      }
      setAuthEpoch((n) => n + 1)
      setLoggedIn(true)
      setTokenReadFailed(false)
      setAuthEmail(user.email)
      connect()
    },
    [connect, sessionExpired, setCurrentMeetingId, clearTranscripts],
  )

  const logoutWith = useCallback(async (reason: 'user' | 'session_invalidated') => {
    try {
      disconnect()
    } catch {
    }
    await window.electronAPI.logout(reason)
    setLoggedIn(false)
    setAuthEmail(undefined)
    setRoomObsServer({ enabled: false, consentVersion: null, requiredVersion: null })
    setSavedMeetingId(null)
    setCurrentMeetingId(null)
    clearTranscripts()
  }, [disconnect, setCurrentMeetingId, clearTranscripts])
  const handleLogout = useCallback(() => void logoutWith('user'), [logoutWith])

  useEffect(() => {
    const unsub = window.electronAPI.onSessionInvalidated(() => {
      console.log('[App] session invalidated by server — keeping meeting view, asking to re-login')
      const wasRecording = isRecording
      if (isCapturing) stopCapture()
      setIsRecording(false)
      setIsToggling(false)
      setIsEnding(false)
      try {
        disconnect()
      } catch {
      }
      void window.electronAPI.logout('session_invalidated')
      if (!sessionExpired) expiredEmailRef.current = authEmail
      setSessionExpired(true)
      if (windowMode === 'compact') setExpandedMode()
      setStatusMessage(wasRecording ? 'ログインの期限が切れたため、文字起こしを止めました' : 'ログインの期限が切れました')
      if (wasRecording) {
        try {
          if (Notification.permission === 'granted') {
            new Notification('Realtime GraReco & Search', {
              body: 'ログインの期限が切れたため、文字起こしを止めました。アプリから再ログインしてください。',
            })
          }
        } catch {
        }
      }
    })
    return unsub
  }, [isRecording, isCapturing, stopCapture, disconnect, sessionExpired, authEmail, windowMode, setExpandedMode])

  useEffect(() => {
    if (error) {
      if (isAutoResumingRef.current) {
        isAutoResumingRef.current = false
        stopCapture()
        setIsRecording(false)
        setStatusMessage('会議が既に終了していました。文字起こしボタンで新しい会議を開始できます')
        try {
          if (Notification.permission === 'granted') {
            new Notification('Realtime GraReco & Search', {
              body: '接続が回復しましたが、会議は既に自動終了していました。文字起こしボタンで新しい会議を開始できます。'
            })
          } else if (Notification.permission !== 'denied') {
            Notification.requestPermission().then((permission) => {
              if (permission === 'granted') {
                new Notification('Realtime GraReco & Search', {
                  body: '接続が回復しましたが、会議は既に自動終了していました。文字起こしボタンで新しい会議を開始できます。'
                })
              }
            })
          }
        } catch {  }
      } else {
        setStatusMessage(`${error}`)
      }
      setIsToggling(false)
      setIsEnding(false)
      setIsConnecting(false)
      clearError()
    }
  }, [error, stopCapture])

  useEffect(() => {
    if (connectionStatus === 'connected' || connectionStatus === 'disconnected' || connectionStatus === 'error') {
      setIsConnecting(false)
    }
  }, [connectionStatus])

  useEffect(() => {
    if (!loggedIn) {
      setAuthEmail(undefined)
      setRoomObsServer({ enabled: false, consentVersion: null, requiredVersion: null })
      return
    }
    let cancelled = false
    window.electronAPI.getAuthMe().then((me) => {
      if (cancelled) return
      if (me) setAuthEmail(me.email)
      setRoomObsServer({
        enabled: me?.roomObservationEnabled === true,
        consentVersion: typeof me?.roomObservationConsentVersion === 'number' ? me.roomObservationConsentVersion : null,
        requiredVersion:
          typeof me?.roomObservationConsentRequiredVersion === 'number' ? me.roomObservationConsentRequiredVersion : null,
      })
    }).catch((err) => { console.log('[Auth] getAuthMe threw', err) })
    return () => { cancelled = true }
  }, [loggedIn, authEpoch])

  useEffect(() => {
    const wasDisconnected =
      prevConnectionStatusRef.current === 'disconnected' ||
      prevConnectionStatusRef.current === 'reconnecting'
    prevConnectionStatusRef.current = connectionStatus

    if (connectionStatus === 'connected' && wasDisconnected && isRecording && currentMeetingId) {
      isAutoResumingRef.current = true
      resumeMeeting(currentMeetingId, meetingMode, true)
      setStatusMessage('接続復旧 – 文字起こしを再開しました')
    }
  }, [connectionStatus, isRecording, currentMeetingId, resumeMeeting, meetingMode])

  useEffect(() => {
    if (!currentMeetingId) {
      setMeetingTitle('')
      setIsEditingTitle(false)
      return
    }
    let cancelled = false
    window.electronAPI.fetchMeetingDetail(currentMeetingId).then((m) => {
      if (cancelled) return
      if (m && !isEditingTitle) {
        setMeetingTitle(m.title ?? '')
      }
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentMeetingId])

  useEffect(() => {
    if (savedMeetingId === null) {
      setSavedMeetingInfo(null)
      return
    }
    let cancelled = false
    window.electronAPI.fetchMeetingDetail(savedMeetingId).then((m) => {
      if (cancelled) return
      setSavedMeetingInfo(m ? { title: m.title, startedAt: m.startedAt } : null)
    }).catch(() => {
      if (!cancelled) setSavedMeetingInfo(null)
    })
    return () => {
      cancelled = true
    }
  }, [savedMeetingId])

  const handleStartEditTitle = useCallback(() => {
    setTitleDraft(meetingTitle)
    setIsEditingTitle(true)
  }, [meetingTitle])

  const handleSaveTitle = useCallback(async () => {
    if (!currentMeetingId) return
    const trimmed = titleDraft.trim()
    if (!trimmed) {
      setStatusMessage('会議名を入力してください')
      return
    }
    setSavingTitle(true)
    const result = await window.electronAPI.updateMeetingTitle(currentMeetingId, trimmed)
    setSavingTitle(false)
    if (result.ok) {
      setMeetingTitle(result.title)
      setIsEditingTitle(false)
      setStatusMessage('会議名を更新しました')
    } else {
      setStatusMessage(`会議名の更新失敗: ${result.error}`)
    }
  }, [currentMeetingId, titleDraft])

  const handleCancelEditTitle = useCallback(() => {
    setIsEditingTitle(false)
    setTitleDraft('')
  }, [])

  useEffect(() => {
    window.electronAPI.setRecordingState(isRecording)
  }, [isRecording])

  useEffect(() => {
    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
        void Notification.requestPermission()
      }
    } catch {
    }
  }, [])

  useEffect(() => {
    const unsub = window.electronAPI.onDeviceTakeover((data) => {
      console.log('[App] device_takeover received:', data)
      if (isCapturing) stopCapture()
      setIsRecording(false)
      setIsToggling(false)
      setIsEnding(false)
      const where =
        data.takenOverBy === 'nativeWs'
          ? '別デバイス（スマホ / 別 PC）'
          : data.takenOverBy === 'socketIO'
            ? 'Web'
            : '別端末'
      setStatusMessage(`${where} に文字起こしを引き継ぎました（停止済み）`)
      try {
        if (Notification.permission === 'granted') {
          new Notification('Realtime GraReco & Search', {
            body: `${where} に会議の文字起こしが引き継がれました。このアプリでは文字起こしを停止しています。`,
          })
        }
      } catch {
      }
    })
    return unsub
  }, [isCapturing, stopCapture])

  useEffect(() => {
    const unsub = window.electronAPI.onMeetingEnded((meetingId) => {
      if (currentMeetingId !== null && currentMeetingId !== meetingId) return
      console.log('[App] meeting_ended received:', meetingId)
      if (isCapturing) stopCapture()
      setIsRecording(false)
      setIsToggling(false)
      setIsEnding(false)
      setStatusMessage('Web 側でこの会議が終了されました（停止済み）')
      try {
        if (Notification.permission === 'granted') {
          new Notification('Realtime GraReco & Search', {
            body: 'Web 側でこの会議が終了されました。このアプリでは文字起こしを停止しています。',
          })
        }
      } catch {
      }
    })
    return unsub
  }, [isCapturing, stopCapture, currentMeetingId])

  const startRecordingFlow = useCallback(async () => {
    setIsToggling(true)
    setShowSystemAudioWarning(false)
    try {
      await startCapture()
      setIsRecording(true)
      if (currentMeetingId) {
        resumeMeeting(currentMeetingId, meetingMode)
        setStatusMessage('文字起こしを再開中…')
      } else if (savedMeetingId) {
        resumeMeeting(savedMeetingId, meetingMode)
        setSavedMeetingId(null)
        setStatusMessage('前回の会議を再開中...')
      } else {
        clearTranscripts()
        startMeeting(meetingMode, meetingType)
        setStatusMessage('新規会議の文字起こし中…')
      }
    } catch (err) {
      stopCapture()
      setIsRecording(false)
      setStatusMessage(`${err instanceof Error ? err.message : 'キャプチャ失敗'}`)
    } finally {
      setIsToggling(false)
    }
  }, [currentMeetingId, savedMeetingId, meetingMode, meetingType, startCapture, stopCapture, startMeeting, resumeMeeting, clearTranscripts])

  useEffect(() => {
    if (isRecording && meetingMode === 'online' && systemAudioStatus === 'error') {
      setShowSystemAudioWarning(true)
    }
    if (!isRecording) {
      setShowSystemAudioWarning(false)
    }
  }, [isRecording, meetingMode, systemAudioStatus])

  const [showStartModeDialog, setShowStartModeDialog] = useState(false)

  const proceedWithStartRecording = useCallback(async () => {
    setShowStartModeDialog(false)

    const perms = await window.electronAPI.checkPermissions()
    const micOk = perms.microphone === 'granted'
    const needsScreen = meetingMode === 'online'
    const screenNotAsked = needsScreen && perms.screen === 'not-determined'
    if (!micOk || screenNotAsked) {
      pendingRecordRef.current = true
      setShowPermissionGuide(true)
      return
    }
    await startRecordingFlow()
  }, [meetingMode, startRecordingFlow])

  const handleToggleRecording = useCallback(async () => {
    if (sessionExpiredRef.current) {
      setShowLoginOverlay(true)
      return
    }
    if (isRecording) {
      setIsToggling(true)
      stopCapture()
      pauseMeeting()
      setIsRecording(false)
      setIsToggling(false)
      setStatusMessage(currentMeetingId ? '一時停止中' : '一時停止しました')
    } else {
      if (windowMode === 'compact') setExpandedMode()
      setShowStartModeDialog(true)
    }
  }, [isRecording, currentMeetingId, stopCapture, pauseMeeting, windowMode, setExpandedMode])

  const handlePermissionsGranted = useCallback(async () => {
    setShowPermissionGuide(false)
    if (pendingRecordRef.current) {
      pendingRecordRef.current = false
      await startRecordingFlow()
    }
  }, [startRecordingFlow])

  const handleEndMeeting = useCallback(() => {
    if (sessionExpiredRef.current) {
      setShowLoginOverlay(true)
      return
    }
    setIsEnding(true)
    if (isRecording) { stopCapture(); setIsRecording(false) }
    endMeeting(); clearTranscripts(); setSavedMeetingId(null)
    setStatusMessage('文字起こしを終了しました')
    setTimeout(() => setIsEnding(false), 500)
  }, [isRecording, stopCapture, endMeeting, clearTranscripts])

  const [isResettingTranscription, setIsResettingTranscription] = useState(false)
  const handleResetTranscription = useCallback(() => {
    if (sessionExpiredRef.current) {
      setShowLoginOverlay(true)
      return
    }
    if (!isRecording) return
    if (!window.confirm('文字起こし接続をリセットします。直前の数秒の音声は失われますが、文字起こしは継続します。よろしいですか？')) return
    setIsResettingTranscription(true)
    setStatusMessage('文字起こしをリセット中…')
    void window.electronAPI.resetTranscription()
    setTimeout(() => setIsResettingTranscription(false), 5000)
  }, [isRecording])

  useEffect(() => {
    const unsub = window.electronAPI.onTranscriptionReset(() => {
      setIsResettingTranscription(false)
      setStatusMessage('文字起こしをリセットしました')
    })
    return unsub
  }, [])

  const handleNewMeeting = useCallback(() => {
    if (sessionExpiredRef.current) {
      setShowLoginOverlay(true)
      return
    }
    clearTranscripts(); setSavedMeetingId(null); setCurrentMeetingId(null)
    setStatusMessage('新しい会議を準備しました')
  }, [clearTranscripts, setCurrentMeetingId])

  const handleRestoreMeeting = useCallback(() => {
    if (sessionExpiredRef.current) {
      setShowLoginOverlay(true)
      return
    }
    if (savedMeetingId === null) return
    setCurrentMeetingId(savedMeetingId)
    setSavedMeetingId(null)
    persistSavedMeetingId(savedMeetingId)
    setStatusMessage('前回の会議を再開準備中')
    setShowStartModeDialog(true)
  }, [savedMeetingId, setCurrentMeetingId, persistSavedMeetingId])

  const handleClearSavedMeeting = useCallback(() => {
    setSavedMeetingId(null); persistSavedMeetingId(null)
    setStatusMessage('待機中')
  }, [persistSavedMeetingId])

  const handleSelectMeetingForResume = useCallback((meetingId: number) => {
    if (sessionExpiredRef.current) {
      setShowLoginOverlay(true)
      return
    }
    setCurrentMeetingId(meetingId); setSavedMeetingId(null); persistSavedMeetingId(meetingId)
    setStatusMessage('会議を再開準備中')
    setShowStartModeDialog(true)
  }, [setCurrentMeetingId, persistSavedMeetingId])

  const handleMeetingModeChange = useCallback((mode: 'online' | 'real') => {
    setMeetingMode(mode); saveSettings({ meetingMode: mode })
  }, [saveSettings])

  const boundFetchMeetings = useCallback(() => fetchMeetings(), [fetchMeetings])

  const handleOpenDashboard = useCallback(() => {
    if (sessionExpiredRef.current) {
      setShowLoginOverlay(true)
      return
    }
    void window.electronAPI.openMeetingInBrowser('/')
  }, [])

  const handleOpenMeetingsListInApp = useCallback(() => {
    if (sessionExpiredRef.current) {
      setShowLoginOverlay(true)
      return
    }
    void window.electronAPI.openMeetingInBrowser('/?v=2')
  }, [])

  const handleOpenCurrentMeetingInApp = useCallback(() => {
    if (sessionExpiredRef.current) {
      setShowLoginOverlay(true)
      return
    }
    if (!currentMeetingId) return
    void window.electronAPI.openMeetingInBrowser(`/meetings/${currentMeetingId}`)
  }, [currentMeetingId])

  const isConnected = connectionStatus === 'connected'
  const hasMeeting = currentMeetingId !== null

  const [captureShots, setCaptureShots] = useState<DisplayShot[] | null>(null)
  const [captureUploading, setCaptureUploading] = useState(false)
  const [captureToast, setCaptureToast] = useState<string | null>(null)
  const captureBusyRef = useRef(false)

  const showCaptureToast = useCallback((msg: string) => {
    setCaptureToast(msg)
    window.setTimeout(() => setCaptureToast(null), 2500)
  }, [])

  const uploadShots = useCallback(
    async (shots: DisplayShot[]) => {
      if (currentMeetingId === null) return
      setCaptureUploading(true)
      let ok = 0
      for (const s of shots) {
        const r = await window.electronAPI.uploadScreenshot(
          currentMeetingId,
          s.dataUrl,
          `screenshot-${s.name || 'display'}.png`,
        )
        if (r.ok) ok++
      }
      setCaptureUploading(false)
      setCaptureShots(null)
      showCaptureToast(
        ok === shots.length
          ? `${ok}枚を補足資料に追加しました`
          : `${ok}/${shots.length}枚を追加（一部失敗）`,
      )
    },
    [currentMeetingId, showCaptureToast],
  )

  const handleScreenCapture = useCallback(async () => {
    if (sessionExpiredRef.current) {
      setShowLoginOverlay(true)
      return
    }
    if (currentMeetingId === null || captureBusyRef.current) return
    captureBusyRef.current = true
    try {
      const shots = await window.electronAPI.captureAllDisplays()
      if (!shots || shots.length === 0) {
        showCaptureToast('画面を取得できませんでした')
        return
      }
      if (shots.length === 1) {
        await uploadShots(shots)
      } else {
        setCaptureShots(shots)
      }
    } catch {
      showCaptureToast('画面の撮影に失敗しました')
    } finally {
      captureBusyRef.current = false
    }
  }, [currentMeetingId, uploadShots, showCaptureToast])

  useEffect(() => {
    const off = window.electronAPI.onShortcutCapture(() => { void handleScreenCapture() })
    return off
  }, [handleScreenCapture])

  const roomObservationAvailable = roomObsServer.enabled && roomObsServer.requiredVersion != null
  const roomObservationConsented =
    roomObsServer.requiredVersion != null &&
    roomObsServer.consentVersion != null &&
    roomObsServer.consentVersion >= roomObsServer.requiredVersion
  const roomObservation = useRoomObservation({
    isRecording,
    currentMeetingId,
    available: roomObservationAvailable && roomObservationConsented,
  })
  const [consentModalOpen, setConsentModalOpen] = useState(false)
  const [consentBusy, setConsentBusy] = useState(false)
  const [consentError, setConsentError] = useState<string | null>(null)
  const [consentNotice, setConsentNotice] = useState<string | null>(null)
  const [seenObsError, setSeenObsError] = useState<string | null>(null)
  if (roomObservation.lastError !== seenObsError) {
    setSeenObsError(roomObservation.lastError)
    if (roomObservation.lastError === ROOM_OBSERVATION_CONSENT_REQUIRED) {
      setRoomObsServer((prev) => ({ ...prev, consentVersion: null }))
      setConsentNotice('環境観察の説明が更新されました。内容をご確認のうえ、もう一度オンにしてください。')
    }
  }
  const roomObservationOn = roomObservation.enabled && roomObservationConsented
  const setRoomObservationEnabled = useCallback((v: boolean) => {
    if (v && !roomObservationConsented) {
      setConsentError(null)
      setConsentModalOpen(true)
      return
    }
    roomObservation.setEnabled(v)
  }, [roomObservationConsented, roomObservation.setEnabled])
  const handleConsentAgree = useCallback(async () => {
    const required = roomObsServer.requiredVersion
    if (required == null) return
    if (required > ROOM_OBSERVATION_CONSENT_TEXT_VERSION) {
      setConsentError(ROOM_OBSERVATION_CONSENT_OUTDATED_MESSAGE)
      return
    }
    const version = ROOM_OBSERVATION_CONSENT_TEXT_VERSION
    setConsentBusy(true)
    setConsentError(null)
    try {
      const r = await window.electronAPI.postRoomObservationConsent(version)
      if (!r.ok) {
        setConsentError('同意を記録できませんでした。通信状況を確認して、もう一度お試しください。')
        return
      }
      setRoomObsServer((prev) => ({ ...prev, consentVersion: version }))
      setConsentNotice(null)
      setConsentModalOpen(false)
      roomObservation.setEnabled(true)
    } catch {
      setConsentError('同意を記録できませんでした。もう一度お試しください。')
    } finally {
      setConsentBusy(false)
    }
  }, [roomObsServer.requiredVersion, roomObservation.setEnabled])
  const observationSettingEl = !roomObservationAvailable ? null : (
    <RoomObservationSetting
      enabled={roomObservationOn}
      setEnabled={setRoomObservationEnabled}
      notice={roomObservationOn ? null : consentNotice}
      source={roomObservation.source}
      setSource={roomObservation.setSource}
      deviceId={roomObservation.deviceId}
      setDeviceId={roomObservation.setDeviceId}
      devices={roomObservation.devices}
      refreshDevices={roomObservation.refreshDevices}
      windows={roomObservation.windows}
      refreshWindows={roomObservation.refreshWindows}
      windowId={roomObservation.windowId}
      windowName={roomObservation.windowName}
      selectWindow={roomObservation.selectWindow}
      displays={roomObservation.displays}
      refreshDisplays={roomObservation.refreshDisplays}
      selectedDisplayIds={roomObservation.selectedDisplayIds}
      toggleDisplay={roomObservation.toggleDisplay}
      status={roomObservation.status}
      lastError={
        roomObservation.lastError === ROOM_OBSERVATION_CONSENT_REQUIRED ? null : roomObservation.lastError
      }
    />
  )

  const latestTranscript = partialTranscript || (transcripts.length > 0 ? transcripts[transcripts.length - 1].content : '')

  if (!settingsLoaded) {
    return (
      <div className="h-screen flex items-center justify-center bg-brand-50/40">
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <Spinner />
          起動中…
        </div>
      </div>
    )
  }

  if (!serverURL || (editingServer && !loggedIn)) {
    return (
      <ServerSetupScreen
        currentServerURL={serverURL}
        onSaved={(url) => {
          setServerURL(url)
          setEditingServer(false)
          setLoggedIn(false)
          setAuthEmail(undefined)
          setSavedMeetingId(null)
          setCurrentMeetingId(null)
          clearTranscripts()
        }}
        onCancel={serverURL ? () => setEditingServer(false) : undefined}
      />
    )
  }

  if (!loggedIn) {
    return (
      <LoginScreen
        serverURL={serverURL}
        onLoggedIn={handleLoggedIn}
        onChangeServer={() => setEditingServer(true)}
        notice={
          tokenReadFailed
            ? '保存されたログイン情報を読み取れませんでした（アプリの署名が変わった可能性）。お手数ですが再度ログインしてください。'
            : null
        }
      />
    )
  }

  if (sessionExpired && showLoginOverlay) {
    return (
      <LoginScreen
        serverURL={serverURL}
        onLoggedIn={handleLoggedIn}
        onCancel={() => setShowLoginOverlay(false)}
        notice={
          expiredEmailRef.current
            ? `ログインの期限が切れました。${expiredEmailRef.current} でもう一度ログインすると、この会議を続けられます。`
            : 'ログインの期限が切れました。もう一度ログインしてください。'
        }
      />
    )
  }

  if (windowMode === 'compact') {
    return (
      <CompactBar
        latestTranscript={latestTranscript}
        isRecording={isRecording}
        elapsedTime={elapsedTime}
        micStatus={micStatus}
        systemAudioStatus={systemAudioStatus}
        meetingMode={meetingMode}
        statusMessage={statusMessage}
        isConnected={isConnected}
        isToggling={isToggling}
        hasMeeting={hasMeeting}
        onExpand={setExpandedMode}
        onToggleRecording={handleToggleRecording}
        roomObserving={roomObservation.status === 'observing'}
      />
    )
  }

  const connStatus = {
    disconnected: { color: 'bg-gray-400', label: '未接続' },
    connecting: { color: 'bg-brand-200', label: '接続中' },
    connected: { color: 'bg-brand-500', label: '接続済み' },
    reconnecting: { color: 'bg-brand-200', label: '再接続中' },
    error: { color: 'bg-red-500', label: 'エラー' }
  }[connectionStatus]

  return (
    <div className="h-screen flex flex-col bg-brand-50/40">
      {showPermissionGuide && (
        <PermissionGuide
          meetingMode={meetingMode}
          onAllGranted={handlePermissionsGranted}
          onClose={() => { setShowPermissionGuide(false); pendingRecordRef.current = false }}
        />
      )}

      {showStartModeDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-md space-y-5">
            <div>
              <h3 className="text-lg font-bold text-gray-900">
                {hasMeeting ? 'この会議の文字起こしを再開しますか？' : '文字起こしを開始'}
              </h3>
              <p className="text-xs text-gray-500 mt-1">
                {hasMeeting
                  ? 'この会議に文字起こしの続きを追記します。音声モードを選んで再開してください。'
                  : '会議の種類を選択してください（後から変更不可）'}
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => handleMeetingModeChange('online')}
                className={`p-4 rounded-lg border-2 text-left transition cursor-pointer ${
                  meetingMode === 'online'
                    ? 'border-brand-600 bg-brand-50'
                    : 'border-gray-200 hover:border-gray-300'
                }`}
              >
                <div className="text-2xl mb-1">📞</div>
                <div className="font-bold text-gray-900">Online</div>
                <div className="text-[11px] text-gray-600 mt-1 leading-snug">
                  Zoom / Teams / Google Meet 等。<br />マイク + システム音声
                </div>
                {meetingMode === 'online' && (
                  <div className="mt-2 text-[10px] text-brand-600 font-semibold">✓ 選択中</div>
                )}
              </button>
              <button
                onClick={() => handleMeetingModeChange('real')}
                className={`p-4 rounded-lg border-2 text-left transition cursor-pointer ${
                  meetingMode === 'real'
                    ? 'border-brand-600 bg-brand-50'
                    : 'border-gray-200 hover:border-gray-300'
                }`}
              >
                <div className="text-2xl mb-1">🎙️</div>
                <div className="font-bold text-gray-900">Real (対面)</div>
                <div className="text-[11px] text-gray-600 mt-1 leading-snug">
                  対面会議。<br />マイクのみ・増幅高め
                </div>
                {meetingMode === 'real' && (
                  <div className="mt-2 text-[10px] text-brand-600 font-semibold">✓ 選択中</div>
                )}
              </button>
            </div>

            <div className="flex gap-2 pt-1">
              <button
                onClick={() => setShowStartModeDialog(false)}
                className="flex-1 px-4 py-2.5 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-md transition-colors cursor-pointer"
              >
                キャンセル
              </button>
              <button
                onClick={proceedWithStartRecording}
                className="flex-1 px-4 py-2.5 text-sm font-semibold text-white bg-brand-600 hover:bg-brand-700 rounded-md transition-colors cursor-pointer"
              >
                {meetingMode === 'online' ? '📞 Online' : '🎙️ Real'} で{hasMeeting ? '再開' : '開始'}
              </button>
            </div>
          </div>
        </div>
      )}

      <header className="flex items-center justify-between px-4 py-2.5 bg-brand-600 shrink-0">
        <div className="flex items-center gap-3">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" className="h-5 w-5">
            <circle cx="50" cy="50" r="46" fill="white" />
            <path d="M52,18 A32,32 0 1,1 26,32" fill="none" stroke="#6366F1" strokeWidth="5" strokeLinecap="round" />
            <g transform="translate(26,32) rotate(225)">
              <line x1="0" y1="0" x2="12" y2="0" stroke="#312E81" strokeWidth="3.5" strokeLinecap="round" />
              <polygon points="0,0 -4.5,-3 -4.5,3" fill="#6366F1" opacity="0.7" />
            </g>
          </svg>
          <h1 className="text-sm font-semibold text-white tracking-wide">Realtime GraReco &amp; Search</h1>
          {appVersion && (
            <button
              onClick={() => void window.electronAPI.openMeetingInBrowser('/changelog')}
              className="text-[10px] text-brand-200 hover:text-white transition-colors cursor-pointer"
              title="更新履歴を見る"
            >
              v{appVersion}
            </button>
          )}
          <div className="flex items-center gap-1.5">
            <span className={`w-2 h-2 rounded-full ${connectionStatus === 'connected' ? 'bg-white' : connectionStatus === 'error' ? 'bg-red-300' : 'bg-brand-300'} ${connectionStatus === 'connecting' || connectionStatus === 'reconnecting' ? 'animate-pulse' : ''}`} />
            <span className="text-[11px] text-brand-200">{connStatus.label}</span>
          </div>
          {hasMeeting && (
            <span
              className="px-1.5 py-0.5 text-[10px] font-semibold bg-white/15 text-white rounded"
              title={meetingMode === 'online' ? 'オンライン会議モード（マイク＋システム音声で文字起こし）' : 'リアル会議モード（マイクのみで文字起こし）'}
            >
              {meetingMode === 'online' ? '📞 オンライン' : '🎙️ リアル'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {loggedIn && (
            <div className="flex items-center gap-1.5 mr-1">
              {authEmail && (
                <span className="text-[11px] text-brand-100 max-w-[180px] truncate" title={authEmail}>{authEmail}</span>
              )}
              <button
                onClick={handleLogout}
                disabled={isRecording}
                className="px-1.5 py-0.5 text-[10px] font-medium text-brand-200 border border-brand-400/50 rounded hover:text-white hover:bg-brand-500 disabled:opacity-40 transition-colors cursor-pointer"
                title={isRecording ? '文字起こし中はログアウトできません' : 'ログアウト'}
              >
                ログアウト
              </button>
            </div>
          )}
          <AnnouncementsBell loggedIn={loggedIn} />
          {hasMeeting && (
            <>
              {participantCount !== null &&
                (participantCount === 0 ? (
                  <button
                    onClick={handleOpenCurrentMeetingInApp}
                    className="px-2 py-1 ml-1 rounded-md bg-amber-400 text-amber-950 text-[11px] font-semibold hover:bg-amber-300 transition-colors cursor-pointer flex items-center gap-1.5"
                    title="参加者が未登録です。会議画面で登録すると、サマリーに「誰が何を発言したか」が反映されます"
                  >
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-900 animate-pulse-live" />
                    参加者 未登録
                  </button>
                ) : (
                  <button
                    onClick={handleOpenCurrentMeetingInApp}
                    className="px-2 py-1 ml-1 rounded-md border border-brand-400/50 text-brand-200 text-[11px] font-medium hover:text-white hover:bg-brand-500 transition-colors cursor-pointer"
                    title="会議画面で参加者を確認・編集できます"
                  >
                    参加者 {participantCount}名
                  </button>
                ))}
              <button
                onClick={handleOpenCurrentMeetingInApp}
                className="px-2 py-1 ml-1 rounded-md bg-white text-brand-700 text-[11px] font-medium hover:bg-brand-50 transition-colors cursor-pointer flex items-center gap-1"
                title="現在の会議のサマリー/グラレコ/アシスタントを別ウィンドウで開く"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                  />
                </svg>
                会議画面
              </button>
            </>
          )}
          {!isRecording && (
            <button
              onClick={handleOpenMeetingsListInApp}
              className="p-1.5 rounded-md text-brand-200 hover:text-white hover:bg-brand-500 transition-colors cursor-pointer"
              aria-label="会議一覧をアプリで開く"
              title="会議一覧をアプリ内別ウィンドウで開く"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
              </svg>
            </button>
          )}
          <button
            onClick={setCompactMode}
            className="p-1.5 rounded-md text-brand-200 hover:text-white hover:bg-brand-500 transition-colors cursor-pointer"
            aria-label="コンパクト表示"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14H5" />
            </svg>
          </button>
          {loggedIn && !sessionExpired && showReloginButton && (connectionStatus === 'disconnected' || connectionStatus === 'error') && (
            <button
              onClick={handleLogout}
              disabled={isRecording}
              className="ml-1 px-2.5 py-1 text-[11px] font-medium rounded-md bg-yellow-400 text-yellow-900 hover:bg-yellow-300 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              title={isRecording ? '文字起こし中はログアウトできません' : 'ログイン画面に戻ってアカウントを切り替える'}
            >
              再ログイン
            </button>
          )}
        </div>
      </header>

      {sessionExpired && (
        <div className="px-4 py-2 bg-amber-100 border-b border-amber-300 shrink-0 flex items-center gap-3 text-sm text-amber-900">
          <span className="font-semibold">⚠ ログインの期限が切れました。文字起こしは止まっています。</span>
          <button
            onClick={() => setShowLoginOverlay(true)}
            className="ml-auto px-3 py-1 text-xs font-semibold rounded-md bg-amber-500 text-white hover:bg-amber-600 transition-colors cursor-pointer"
          >
            再ログイン
          </button>
        </div>
      )}

      {hasMeeting && currentMeetingId !== null && (
        <div className="px-4 py-1.5 bg-brand-50/80 border-b border-brand-200/60 shrink-0 flex items-center gap-2 text-xs">
          <span className="text-brand-500/70 font-mono shrink-0">#{currentMeetingId}</span>
          {isEditingTitle ? (
            <>
              <input
                type="text"
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    void handleSaveTitle()
                  }
                  if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
                    handleCancelEditTitle()
                  }
                }}
                autoFocus
                maxLength={200}
                placeholder="会議名を入力（Enter で保存・Esc でキャンセル）"
                className="flex-1 px-2 py-1 text-xs border border-brand-300 rounded focus:outline-none focus:ring-1 focus:ring-brand-500 bg-white"
                disabled={savingTitle}
              />
              <button
                onClick={() => void handleSaveTitle()}
                disabled={savingTitle || !titleDraft.trim()}
                className="px-2 py-0.5 text-[11px] font-medium text-white bg-brand-600 hover:bg-brand-500 rounded disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
              >
                {savingTitle ? '保存中…' : '保存'}
              </button>
              <button
                onClick={handleCancelEditTitle}
                disabled={savingTitle}
                className="px-2 py-0.5 text-[11px] text-gray-500 hover:text-gray-700 rounded hover:bg-gray-100 cursor-pointer"
              >
                キャンセル
              </button>
            </>
          ) : (
            <>
              <span className="flex-1 text-brand-700 font-medium truncate">
                {meetingTitle || <span className="text-brand-400 italic font-normal">(タイトル未設定 — 文字起こしから AI 自動生成 or 編集で設定)</span>}
              </span>
              <button
                onClick={handleStartEditTitle}
                className="text-brand-500 hover:text-brand-700 px-2 py-0.5 text-[11px] rounded hover:bg-brand-100 cursor-pointer shrink-0"
                title="会議名を編集"
              >
                ✏️ 編集
              </button>
            </>
          )}
        </div>
      )}

      {!isRecording && !hasMeeting && savedMeetingId !== null && (
        <div className="flex items-center justify-between gap-3 px-4 py-2 bg-brand-50 border-b border-brand-200/60 shrink-0">
          <div className="flex flex-col min-w-0">
            <span className="text-xs font-medium text-brand-700 truncate">
              {savedMeetingInfo?.title?.trim() || '前回の会議（タイトル未設定）'}
            </span>
            <span className="text-[10px] text-brand-500/80 truncate">
              {savedMeetingInfo?.startedAt && formatStartedAt(savedMeetingInfo.startedAt)
                ? `文字起こし開始 ${formatStartedAt(savedMeetingInfo.startedAt)} ・ 続きから再開できます`
                : '続きから再開できます'}
            </span>
          </div>
          <div className="flex gap-2 shrink-0">
            <button
              onClick={handleRestoreMeeting}
              className="px-2.5 py-1 text-[11px] font-medium bg-brand-600 text-white rounded-md hover:bg-brand-500 transition-colors cursor-pointer"
            >
              再開する
            </button>
            <button
              onClick={handleClearSavedMeeting}
              className="px-2.5 py-1 text-[11px] text-gray-500 hover:text-gray-700 transition-colors cursor-pointer"
            >
              クリア
            </button>
          </div>
        </div>
      )}

      {showSystemAudioWarning && (
        <div className="px-4 py-2.5 bg-red-50 border-b border-red-200 shrink-0">
          <div className="flex items-start gap-2">
            <svg className="w-4 h-4 text-red-500 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
            <div className="flex-1">
              <p className="text-xs font-medium text-red-800">システム音声を取得できません</p>
              <p className="text-[10px] text-red-600 mt-0.5">
                マイクのみで文字起こし中です。システム音声も拾うには:
              </p>
              <ol className="text-[10px] text-red-600 mt-1 space-y-0.5 list-decimal list-inside">
                <li>このアプリ（Realtime GraReco &amp; Search）をONにする（既にONなら一度OFFにしてONに戻す）</li>
                <li>アプリを <strong>Cmd+Q</strong> で完全終了して再度開く</li>
              </ol>
              <div className="flex items-center gap-2 mt-2">
                <button
                  onClick={() => window.electronAPI.openScreenRecordingSettings()}
                  className="px-2.5 py-1 text-[10px] font-medium bg-red-600 text-white rounded-md hover:bg-red-500 transition-colors cursor-pointer"
                >
                  画面収録の設定を開く
                </button>
                <button
                  onClick={() => window.electronAPI.relaunchApp()}
                  className="px-2.5 py-1 text-[10px] font-medium text-red-600 border border-red-300 rounded-md hover:bg-red-100 transition-colors cursor-pointer"
                >
                  アプリを再起動
                </button>
              </div>
            </div>
            <button
              onClick={() => setShowSystemAudioWarning(false)}
              className="text-red-400 hover:text-red-600 shrink-0 cursor-pointer"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 flex min-h-0">
        <div className="flex-1 flex flex-col min-w-0">
          <TranscriptView transcripts={transcripts} partialTranscript={partialTranscript} />
        </div>
      </div>

      {!isRecording && !hasMeeting && (
        <div className="px-4 py-2 border-t border-gray-200/80 bg-white shrink-0">
          <MeetingList
            fetchMeetings={boundFetchMeetings}
            onSelectMeeting={handleSelectMeetingForResume}
            onOpenWebDetail={(id, _title) =>
              void window.electronAPI.openMeetingInBrowser(`/meetings/${id}`)
            }
            disabled={!isConnected}
          />
          <div className="mt-2 space-y-2">
            <ScreenshotShortcutSetting />
            {observationSettingEl}
            <LegalLinks serverURL={serverURL} />
          </div>
        </div>
      )}

      {observationSettingEl && (isRecording || hasMeeting) && (
        <div className="px-4 pt-2 bg-white shrink-0">{observationSettingEl}</div>
      )}

      <footer className="flex items-center gap-3 px-4 py-2.5 bg-white border-t border-gray-200/80 shrink-0">
        <button
          onClick={handleToggleRecording}
          disabled={!isConnected || isToggling}
          className={`flex items-center gap-2 px-4 py-1.5 text-xs font-medium rounded-md transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
            isRecording
              ? 'bg-red-500 hover:bg-red-400 text-white'
              : 'bg-brand-600 hover:bg-brand-500 text-white'
          }`}
        >
          {isToggling ? (
            <>
              <Spinner className="w-3.5 h-3.5" />
              処理中...
            </>
          ) : isRecording ? (
            <>
              <span className="flex gap-[2px]">
                <span className="w-[3px] h-2.5 rounded-sm bg-white animate-pulse-recording" />
                <span className="w-[3px] h-2.5 rounded-sm bg-white animate-pulse-recording" />
              </span>
              一時停止
            </>
          ) : (
            <>
              <span className="w-2.5 h-2.5 rounded-full bg-white" />
              {hasMeeting ? '再開' : '新規文字起こし'}
            </>
          )}
        </button>

        {isCapturing && (
          <span className="text-xs font-mono text-red-500 animate-pulse-recording">{elapsedTime}</span>
        )}

        {isRecording && connectionStatus !== 'connected' && (
          <span className="text-xs font-semibold text-amber-700 bg-amber-50 border border-amber-300 rounded px-2 py-0.5">
            ⚠ 再接続中（音声は記録されていません）
          </span>
        )}

        {isRecording && (
          <button
            onClick={handleResetTranscription}
            disabled={isResettingTranscription}
            title="文字起こしが暴走したとき（実際には発言していないテキストが連発するとき）に接続を張り直してクリーンな文字起こしを再開します。文字起こしは継続します。"
            className="px-3 py-1.5 text-[11px] font-medium text-gray-500 border border-gray-300 rounded-md hover:bg-gray-50 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
          >
            {isResettingTranscription && <Spinner className="w-3 h-3" />}
            {isResettingTranscription ? 'リセット中…' : '文字起こしリセット'}
          </button>
        )}

        {isRecording && hasMeeting && (
          <button
            onClick={handleScreenCapture}
            disabled={captureUploading}
            title="今の画面をキャプチャして補足資料に追加します（ショートカット: ⌘/Ctrl+Shift+2）"
            className="px-3 py-1.5 text-[11px] font-medium text-gray-500 border border-gray-300 rounded-md hover:bg-gray-50 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
          >
            {captureUploading && <Spinner className="w-3 h-3" />}
            画面を撮影
          </button>
        )}

        {hasMeeting && !isRecording && (
          <>
            <button
              onClick={handleEndMeeting}
              disabled={isEnding}
              className="px-3 py-1.5 text-[11px] font-medium text-red-500 border border-red-200 rounded-md hover:bg-red-50 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
            >
              {isEnding && <Spinner className="w-3 h-3" />}
              終了
            </button>
            <button onClick={handleNewMeeting} className="px-3 py-1.5 text-[11px] font-medium text-gray-500 border border-gray-300 rounded-md hover:bg-gray-50 transition-colors cursor-pointer">
              新規
            </button>
          </>
        )}

        <div className="flex-1" />

        <div className="flex items-center gap-3 text-[11px] text-gray-400">
          {isCapturing && (
            <>
              <span className="flex items-center gap-1" title="マイク">
                <svg className={`w-3 h-3 ${micStatus === 'active' ? 'text-brand-500' : 'text-gray-300'}`} fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
                  <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
                </svg>
                {micStatus === 'active' ? 'ON' : 'OFF'}
              </span>
              {meetingMode === 'online' && (
                <span className={`flex items-center gap-1 ${systemAudioStatus === 'active' ? 'text-brand-500' : systemAudioStatus === 'error' ? 'text-red-400' : 'text-gray-300'}`} title="システム音声">
                  <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
                  </svg>
                  {systemAudioStatus === 'active' ? 'ON' : systemAudioStatus === 'error' ? 'NG' : 'OFF'}
                </span>
              )}
              <span>{audioChunkCount}</span>
            </>
          )}
          <span className="truncate max-w-[160px]">{statusMessage}</span>
        </div>
      </footer>

      {recentEndDialog.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-xl shadow-xl p-6 max-w-md w-full">
            <div className="flex items-center gap-2 mb-3">
              <svg className="w-5 h-5 text-yellow-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
              <h3 className="font-bold text-gray-900">この会議は別デバイスで終了されました</h3>
            </div>
            <div className="text-sm text-gray-700 space-y-2 mb-4 leading-relaxed">
              <p>続けて記録したい場合は、<strong>終了したデバイスから</strong>「再開」してください。</p>
              <p>このデバイスで新しい会議を始める場合は <strong>「新規文字起こし」</strong> を押してください。</p>
              <p>過去会議として追記する場合は <strong>1 分後</strong> に再度お試しください。</p>
              {recentEndDialog.meetingId && (
                <p className="text-xs text-gray-500 mt-2">会議 #{recentEndDialog.meetingId}</p>
              )}
            </div>
            <div className="flex justify-end">
              <button
                onClick={() => setRecentEndDialog({ open: false, message: '' })}
                className="px-4 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg transition-colors"
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}

      {consentModalOpen && (
        <RoomObservationConsentModal
          busy={consentBusy}
          error={consentError}
          onAgree={() => { void handleConsentAgree() }}
          onDecline={() => setConsentModalOpen(false)}
        />
      )}

      {captureShots && captureShots.length > 1 && (
        <CaptureReviewModal
          shots={captureShots}
          uploading={captureUploading}
          onConfirm={(kept) => { void uploadShots(kept) }}
          onCancel={() => setCaptureShots(null)}
        />
      )}

      {captureToast && (
        <div className="fixed bottom-16 left-1/2 -translate-x-1/2 z-50 px-4 py-2 bg-gray-900 text-white text-xs rounded-lg shadow-lg">
          {captureToast}
        </div>
      )}

    </div>
  )
}
