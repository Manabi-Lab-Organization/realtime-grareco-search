import { useCallback, useEffect, useRef, useState } from 'react'
import { CameraCapture, type CameraFacing } from './cameraCapturePlugin'
import { uploadObservation } from './api'

const CAPTURE_INTERVAL_MS = 60_000
const WARMUP_MS = 3000
const LS_ENABLED = 'obs-enabled'
const LS_FACING = 'obs-facing'

export type ObservationStatus = 'idle' | 'observing' | 'error'

export interface UseRoomObservation {
  enabled: boolean
  facing: CameraFacing
  status: ObservationStatus
  lastError: string | null
  toggle: () => Promise<void>
  setFacing: (f: CameraFacing) => void
}

export function useRoomObservation(params: {
  token: string
  meetingId: number | null
  active: boolean
}): UseRoomObservation {
  const { token, meetingId, active } = params

  const [enabled, setEnabledState] = useState<boolean>(
    () => localStorage.getItem(LS_ENABLED) === '1',
  )
  const [facing, setFacingState] = useState<CameraFacing>(
    () => (localStorage.getItem(LS_FACING) === 'back' ? 'back' : 'front'),
  )
  const [status, setStatus] = useState<ObservationStatus>('idle')
  const [lastError, setLastError] = useState<string | null>(null)

  const facingRef = useRef(facing)
  useEffect(() => {
    facingRef.current = facing
  }, [facing])

  const setEnabled = useCallback((v: boolean) => {
    localStorage.setItem(LS_ENABLED, v ? '1' : '0')
    setEnabledState(v)
  }, [])

  const setFacing = useCallback((f: CameraFacing) => {
    localStorage.setItem(LS_FACING, f)
    setFacingState(f)
  }, [])

  const busyRef = useRef(false)
  const captureOnce = useCallback(async () => {
    if (busyRef.current || !meetingId) return
    busyRef.current = true
    try {
      const { dataUrl } = await CameraCapture.capture({ facing: facingRef.current })
      const r = await uploadObservation(token, meetingId, dataUrl)
      if (r.ok) {
        setLastError(null)
        setStatus('observing')
      } else {
        setLastError(r.error ?? 'upload_failed')
        setStatus('error')
      }
    } catch (err) {
      setLastError(err instanceof Error ? err.message : 'capture_failed')
    } finally {
      busyRef.current = false
    }
  }, [meetingId, token])

  useEffect(() => {
    const shouldRun = enabled && active && meetingId != null
    if (!shouldRun) {
      setStatus('idle')
      return
    }
    setStatus('observing')
    const kick = window.setTimeout(() => void captureOnce(), WARMUP_MS)
    const timer = window.setInterval(() => void captureOnce(), CAPTURE_INTERVAL_MS)
    return () => {
      clearTimeout(kick)
      clearInterval(timer)
    }
  }, [enabled, active, meetingId, captureOnce])

  const toggle = useCallback(async () => {
    if (enabled) {
      setEnabled(false)
      return
    }
    try {
      const p = await CameraCapture.requestPermission()
      if (!p.granted) {
        setLastError('カメラ権限が許可されていません。設定アプリで許可してください。')
        return
      }
    } catch (err) {
      setLastError(err instanceof Error ? err.message : 'permission_error')
      return
    }
    setLastError(null)
    setEnabled(true)
  }, [enabled, setEnabled])

  return { enabled, facing, status, lastError, toggle, setFacing }
}
