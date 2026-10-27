import { useCallback, useEffect, useRef, useState } from 'react'
import { parseObservationSource, type ObservationSource } from '../lib/observationSource'

const CAPTURE_INTERVAL_MS = 60_000
const WINDOW_RECOVERY_POLL_MS = 5_000
const WINDOW_HIDDEN_MESSAGE =
  '選んだウィンドウが見えないため、観察を一時停止しています。別のデスクトップに切り替えた・最小化した場合は、元に戻すと自動で再開します（閉じた場合はウィンドウを選び直してください）'
const CAPTURE_TIMEOUT_MESSAGE = '画面の取得に時間がかかっています。自動で再試行しています…'
const LS_ENABLED = 'roomObservation.enabled'
const LS_SOURCE = 'roomObservation.source'
const LS_DEVICE = 'roomObservation.deviceId'
const LS_WINDOW_ID = 'roomObservation.windowId'
const LS_WINDOW_NAME = 'roomObservation.windowName'
const LS_DISPLAYS = 'roomObservation.displayIds'

export type ObservationStatus = 'idle' | 'starting' | 'observing' | 'error'
export type { ObservationSource }

export interface CameraDevice {
  deviceId: string
  label: string
}
export interface WindowSource {
  id: string
  name: string
  dataUrl: string
}
export interface DisplaySource {
  id: string
  name: string
  displayId: string
  dataUrl: string
}

interface Options {
  isRecording: boolean
  currentMeetingId: number | null
  available: boolean
}

function isUniformBlackFrame(video: HTMLVideoElement): boolean {
  try {
    const w = 64
    const h = 36
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return false
    ctx.drawImage(video, 0, 0, w, h)
    const data = ctx.getImageData(0, 0, w, h).data
    let sum = 0
    let sumSq = 0
    const n = w * h
    for (let i = 0; i < data.length; i += 4) {
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
      sum += lum
      sumSq += lum * lum
    }
    const mean = sum / n
    const variance = sumSq / n - mean * mean
    return mean < 8 && variance < 16
  } catch {
    return false
  }
}

export function useRoomObservation({ isRecording, currentMeetingId, available }: Options) {
  const [enabled, setEnabledState] = useState<boolean>(
    () => localStorage.getItem(LS_ENABLED) === '1',
  )
  const [source, setSourceState] = useState<ObservationSource>(
    () => parseObservationSource(localStorage.getItem(LS_SOURCE)),
  )
  const [deviceId, setDeviceIdState] = useState<string>(
    () => localStorage.getItem(LS_DEVICE) || '',
  )
  const [windowId, setWindowIdState] = useState<string>(
    () => localStorage.getItem(LS_WINDOW_ID) || '',
  )
  const [windowName, setWindowName] = useState<string>(
    () => localStorage.getItem(LS_WINDOW_NAME) || '',
  )
  const [selectedDisplayIds, setSelectedDisplayIdsState] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(LS_DISPLAYS)
      return raw ? (JSON.parse(raw) as string[]) : []
    } catch {
      return []
    }
  })
  const [devices, setDevices] = useState<CameraDevice[]>([])
  const [windows, setWindows] = useState<WindowSource[]>([])
  const [displays, setDisplays] = useState<DisplaySource[]>([])
  const [status, setStatus] = useState<ObservationStatus>('idle')
  const [lastError, setLastError] = useState<string | null>(null)
  const [windowHidden, setWindowHidden] = useState(false)

  const streamRef = useRef<MediaStream | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const intervalRef = useRef<number | null>(null)
  const kickRef = useRef<number | null>(null)
  const locationRef = useRef<{ lat: number; lng: number; source?: string } | undefined>(undefined)
  const busyRef = useRef(false)
  const frameTickRef = useRef(0)
  const lastSeenTickRef = useRef(-1)
  const rvfcSupportedRef = useRef(false)
  const restartingRef = useRef(false)
  const restartCameraRef = useRef<() => Promise<void>>(async () => {})
  const windowRecoverTimerRef = useRef<number | null>(null)
  const captureOnceRef = useRef<() => Promise<void>>(async () => {})

  const setEnabled = useCallback((v: boolean) => {
    setEnabledState(v)
    localStorage.setItem(LS_ENABLED, v ? '1' : '0')
  }, [])
  const setSource = useCallback((s: ObservationSource) => {
    setSourceState(s)
    localStorage.setItem(LS_SOURCE, s)
  }, [])
  const setDeviceId = useCallback((id: string) => {
    setDeviceIdState(id)
    localStorage.setItem(LS_DEVICE, id)
  }, [])
  const selectWindow = useCallback((id: string, name: string) => {
    setWindowIdState(id)
    setWindowName(name)
    localStorage.setItem(LS_WINDOW_ID, id)
    localStorage.setItem(LS_WINDOW_NAME, name)
  }, [])
  const toggleDisplay = useCallback((displayId: string) => {
    setSelectedDisplayIdsState((prev) => {
      const next = prev.includes(displayId)
        ? prev.filter((d) => d !== displayId)
        : [...prev, displayId]
      localStorage.setItem(LS_DISPLAYS, JSON.stringify(next))
      return next
    })
  }, [])

  const refreshDevices = useCallback(async () => {
    try {
      const list = await navigator.mediaDevices.enumerateDevices()
      const cams = list
        .filter((d) => d.kind === 'videoinput')
        .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `カメラ ${i + 1}` }))
      setDevices(cams)
      return cams
    } catch {
      return []
    }
  }, [])

  const refreshWindows = useCallback(async () => {
    try {
      const list = await window.electronAPI.listWindows()
      setWindows(list)
      return list
    } catch {
      return []
    }
  }, [])

  const refreshDisplays = useCallback(async () => {
    try {
      const list = await window.electronAPI.captureAllDisplays()
      setDisplays(list)
      return list
    } catch {
      return []
    }
  }, [])

  useEffect(() => {
    void refreshDevices()
    const handler = () => void refreshDevices()
    navigator.mediaDevices.addEventListener?.('devicechange', handler)
    return () => navigator.mediaDevices.removeEventListener?.('devicechange', handler)
  }, [refreshDevices])

  const acquireLocation = useCallback(() => {
    if (!('geolocation' in navigator)) return
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        locationRef.current = { lat: pos.coords.latitude, lng: pos.coords.longitude, source: 'device' }
      },
      () => {
        locationRef.current = undefined
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 300_000 },
    )
  }, [])

  const stopCameraStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null
      videoRef.current = null
    }
  }, [])

  const startCameraStream = useCallback(async () => {
    stopCameraStream()
    const stream = await navigator.mediaDevices.getUserMedia({
      video: deviceId ? { deviceId: { exact: deviceId } } : true,
      audio: false,
    })
    streamRef.current = stream
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.srcObject = stream
    await video.play().catch(() => {})
    videoRef.current = video

    frameTickRef.current = 0
    lastSeenTickRef.current = -1
    const rvfc = (video as unknown as {
      requestVideoFrameCallback?: (cb: () => void) => void
    }).requestVideoFrameCallback?.bind(video)
    rvfcSupportedRef.current = typeof rvfc === 'function'
    if (rvfc) {
      const onFrame = (): void => {
        frameTickRef.current++
        if (videoRef.current === video) rvfc(onFrame)
      }
      rvfc(onFrame)
    }

    const track = stream.getVideoTracks()[0]
    if (track) {
      const onLost = (): void => {
        setLastError('カメラ映像が中断されました。自動で再接続しています…')
        window.setTimeout(() => {
          const cur = streamRef.current?.getVideoTracks()[0]
          if (!cur || cur.readyState !== 'live' || cur.muted) void restartCameraRef.current()
        }, 3000)
      }
      track.addEventListener('ended', onLost)
      track.addEventListener('mute', onLost)
    }
  }, [deviceId, stopCameraStream])

  const restartCamera = useCallback(async () => {
    if (restartingRef.current) return
    restartingRef.current = true
    try {
      await startCameraStream()
      setLastError(null)
    } catch {
      setLastError(
        'カメラに再接続できません。カメラの電源・給電（1.5A以上推奨）・USB接続をご確認ください',
      )
    } finally {
      restartingRef.current = false
    }
  }, [startCameraStream])
  useEffect(() => {
    restartCameraRef.current = restartCamera
  }, [restartCamera])

  const stopWindowRecovery = useCallback(() => {
    if (windowRecoverTimerRef.current !== null) {
      window.clearInterval(windowRecoverTimerRef.current)
      windowRecoverTimerRef.current = null
    }
  }, [])

  const startWindowRecovery = useCallback(() => {
    if (windowRecoverTimerRef.current !== null) return
    let probing = false
    windowRecoverTimerRef.current = window.setInterval(() => {
      if (probing) return
      probing = true
      void window.electronAPI
        .isWindowVisible(windowId, windowName)
        .then(async (r) => {
          if (!r.visible || windowRecoverTimerRef.current === null) return
          stopWindowRecovery()
          await captureOnceRef.current()
        })
        .catch(() => {})
        .finally(() => {
          probing = false
        })
    }, WINDOW_RECOVERY_POLL_MS)
  }, [windowId, windowName, stopWindowRecovery])

  const captureCameraFrame = useCallback((): string | null => {
    const video = videoRef.current
    if (!video || video.videoWidth === 0) return null
    const canvas = document.createElement('canvas')
    const scale = Math.min(1, 1600 / Math.max(video.videoWidth, video.videoHeight))
    canvas.width = Math.round(video.videoWidth * scale)
    canvas.height = Math.round(video.videoHeight * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.85)
  }, [])

  const captureOnce = useCallback(async () => {
    if (busyRef.current) return
    const meetingId = currentMeetingId
    if (meetingId === null) return
    busyRef.current = true
    try {
      if (source === 'display') {
        const shots = await window.electronAPI.captureAllDisplays()
        const targets =
          selectedDisplayIds.length > 0
            ? shots.filter((s) => selectedDisplayIds.includes(s.displayId))
            : shots
        if (targets.length === 0) {
          void refreshDisplays()
          setLastError(
            selectedDisplayIds.length > 0
              ? '選択したディスプレイが見つからないため、撮影を止めています。ディスプレイを選び直してください'
              : '対象ディスプレイが見つかりません',
          )
          return
        }
        let lastErr: string | null = null
        for (const s of targets) {
          const r = await window.electronAPI.uploadObservation(meetingId, s.dataUrl, {
            sourceType: 'display',
            location: locationRef.current,
          })
          if (!r.ok) lastErr = r.error
        }
        setLastError(lastErr)
        return
      }

      let dataUrl: string | null = null
      if (source === 'camera') {
        const video = videoRef.current
        const track = streamRef.current?.getVideoTracks()[0] ?? null
        const tick = rvfcSupportedRef.current ? frameTickRef.current : (video?.currentTime ?? -1)
        const frozen = lastSeenTickRef.current >= 0 && tick === lastSeenTickRef.current
        const unhealthy =
          !video ||
          !track ||
          track.readyState !== 'live' ||
          track.muted ||
          video.videoWidth === 0 ||
          frozen
        if (unhealthy) {
          setLastError('カメラ映像が取得できていません。自動で再接続しています…')
          await restartCamera()
          return
        }
        if (isUniformBlackFrame(video)) {
          setLastError('カメラ映像が真っ黒です。自動で再接続しています…（カメラの電源・給電をご確認ください）')
          await restartCamera()
          return
        }
        lastSeenTickRef.current = tick
        dataUrl = captureCameraFrame()
      } else {
        const shot = await window.electronAPI.captureWindowShot(windowId, windowName)
        if (!shot.ok) {
          if (shot.error === 'window_not_found' || shot.error === 'capture_timeout') {
            setWindowHidden(shot.error === 'window_not_found')
            setLastError(shot.error === 'window_not_found' ? WINDOW_HIDDEN_MESSAGE : CAPTURE_TIMEOUT_MESSAGE)
            startWindowRecovery()
          } else {
            setLastError(shot.error)
          }
          return
        }
        stopWindowRecovery()
        setWindowHidden(false)
        dataUrl = shot.dataUrl
      }
      if (!dataUrl) return
      const r = await window.electronAPI.uploadObservation(meetingId, dataUrl, {
        sourceType: source,
        location: locationRef.current,
      })
      setLastError(r.ok ? null : r.error)
    } finally {
      busyRef.current = false
    }
  }, [
    currentMeetingId,
    source,
    windowId,
    windowName,
    selectedDisplayIds,
    captureCameraFrame,
    restartCamera,
    refreshDisplays,
    startWindowRecovery,
    stopWindowRecovery,
  ])
  useEffect(() => {
    captureOnceRef.current = captureOnce
  }, [captureOnce])

  useEffect(() => {
    let cancelled = false
    const ready =
      available &&
      isRecording &&
      enabled &&
      currentMeetingId !== null &&
      (source === 'camera' || source === 'display' || (source === 'window' && !!windowId))

    async function start() {
      setStatus('starting')
      setLastError(null)
      try {
        if (source === 'camera') {
          await startCameraStream()
          if (cancelled) {
            stopCameraStream()
            return
          }
          void refreshDevices()
        }
        if (cancelled) return
        acquireLocation()
        setStatus('observing')
        kickRef.current = window.setTimeout(() => void captureOnce(), source === 'camera' ? 3000 : 1000)
        intervalRef.current = window.setInterval(() => void captureOnce(), CAPTURE_INTERVAL_MS)
      } catch (err) {
        if (!cancelled) {
          setStatus('error')
          setLastError(err instanceof Error ? err.message : 'capture_error')
        }
      }
    }

    function stop() {
      if (kickRef.current !== null) {
        window.clearTimeout(kickRef.current)
        kickRef.current = null
      }
      if (intervalRef.current !== null) {
        window.clearInterval(intervalRef.current)
        intervalRef.current = null
      }
      stopCameraStream()
      stopWindowRecovery()
      setWindowHidden(false)
      locationRef.current = undefined
      setStatus('idle')
    }

    if (ready) {
      void start()
    } else {
      stop()
    }

    return () => {
      cancelled = true
      stop()
    }
  }, [
    available,
    isRecording,
    enabled,
    currentMeetingId,
    source,
    deviceId,
    windowId,
    windowName,
    selectedDisplayIds,
    captureOnce,
    acquireLocation,
    refreshDevices,
    startCameraStream,
    stopCameraStream,
    stopWindowRecovery,
  ])

  return {
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
  }
}
