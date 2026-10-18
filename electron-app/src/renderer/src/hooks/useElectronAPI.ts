import { useEffect, useRef, useCallback, useState } from 'react'
import type { ConnectionStatus, TranscriptData, Settings, MeetingInfo, DetectedTerm } from '../../../preload/index.d'

export { type ConnectionStatus, type TranscriptData, type Settings, type MeetingInfo, type DetectedTerm }

const MAX_TRANSCRIPTS = 500

export function useElectronAPI() {
  const api = window.electronAPI

  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected')
  const [currentMeetingId, setCurrentMeetingId] = useState<number | null>(null)
  const [transcripts, setTranscripts] = useState<TranscriptData[]>([])
  const [partialTranscript, setPartialTranscript] = useState<string>('')
  const [detectedTerms, setDetectedTerms] = useState<DetectedTerm[]>([])
  const [error, setError] = useState<string | null>(null)
  const [windowMode, setWindowMode] = useState<'expanded' | 'compact'>('expanded')

  const currentMeetingIdRef = useRef(currentMeetingId)
  useEffect(() => {
    currentMeetingIdRef.current = currentMeetingId
  }, [currentMeetingId])

  useEffect(() => {
    api.getWindowMode().then(setWindowMode)
  }, [])

  useEffect(() => {
    const unsubs = [
      api.onWindowModeChanged((mode) => setWindowMode(mode)),
      api.onConnectionStatus((status) => setConnectionStatus(status)),
      api.onTranscript((data) => {
        if (data.isFinal) {
          setTranscripts((prev) => {
            const next = [...prev, data]
            return next.length > MAX_TRANSCRIPTS ? next.slice(-MAX_TRANSCRIPTS) : next
          })
          setPartialTranscript('')
        } else {
          setPartialTranscript(data.content)
        }
      }),
      api.onMeetingCreated((meetingId) => {
        setCurrentMeetingId(meetingId)
        api.setSavedMeetingId(meetingId)
      }),
      api.onMeetingEnded((meetingId) => {
        if (currentMeetingIdRef.current === meetingId) {
          setCurrentMeetingId(null)
          api.setSavedMeetingId(null)
        }
      }),
      api.onDeviceTakeover((_data) => {
      }),
      api.onTermDetected((term) => {
        setDetectedTerms((prev) => {
          const without = prev.filter((t) => t.term !== term.term)
          return [...without, term]
        })
      }),
      api.onError((msg) => setError(msg))
    ]

    return () => unsubs.forEach((fn) => fn())
  }, [])

  const connect = useCallback(() => api.connect(), [])
  const disconnect = useCallback(() => api.disconnect(), [])

  const startMeeting = useCallback(
    (mode: 'online' | 'real', meetingType = 'general') => api.startMeeting(mode, meetingType),
    []
  )
  const resumeMeeting = useCallback(
    (meetingId: number, mode: 'online' | 'real', auto = false) =>
      api.resumeMeeting(meetingId, mode, auto),
    []
  )
  const pauseMeeting = useCallback(() => api.pauseMeeting(), [])
  const endMeeting = useCallback(() => {
    api.endMeeting()
    setCurrentMeetingId(null)
    api.setSavedMeetingId(null)
  }, [])

  const sendAudio = useCallback((data: ArrayBuffer) => api.sendAudio(data), [])

  const getSettings = useCallback(() => api.getSettings(), [])
  const saveSettings = useCallback((s: Partial<Settings>) => api.saveSettings(s), [])

  const openExternal = useCallback((url: string) => api.openExternal(url), [])

  const fetchMeetings = useCallback(() => api.fetchMeetings(), [])

  const getSavedMeetingId = useCallback(() => api.getSavedMeetingId(), [])
  const setSavedMeetingId = useCallback((id: number | null) => api.setSavedMeetingId(id), [])

  const dismissTerm = useCallback((term: string) => {
    setDetectedTerms((prev) => prev.filter((t) => t.term !== term))
    api.dismissTerm(term)
  }, [])

  const clearTranscripts = useCallback(() => {
    setTranscripts([])
    setPartialTranscript('')
    setDetectedTerms([])
  }, [])

  const clearError = useCallback(() => setError(null), [])
  const setCompactMode = useCallback(() => api.setCompactMode(), [])
  const setExpandedMode = useCallback(() => api.setExpandedMode(), [])

  return {
    connectionStatus,
    windowMode,
    setCompactMode,
    setExpandedMode,
    currentMeetingId,
    transcripts,
    partialTranscript,
    detectedTerms,
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
    openExternal,
    fetchMeetings,
    getSavedMeetingId,
    setSavedMeetingId,
    dismissTerm,
    clearTranscripts,
    clearError,
    setCurrentMeetingId
  }
}

export function useAudioCapture(
  sendAudio: (data: ArrayBuffer) => void,
  meetingMode: 'online' | 'real'
) {
  const audioContextRef = useRef<AudioContext | null>(null)
  const workletNodeRef = useRef<AudioWorkletNode | null>(null)
  const systemStreamRef = useRef<MediaStream | null>(null)
  const micStreamRef = useRef<MediaStream | null>(null)
  const [isCapturing, setIsCapturing] = useState(false)
  const [audioChunkCount, setAudioChunkCount] = useState(0)
  const audioChunkCountRef = useRef(0)
  const chunkCountTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [micStatus, setMicStatus] = useState<'off' | 'active' | 'error'>('off')
  const [systemAudioStatus, setSystemAudioStatus] = useState<'off' | 'active' | 'error'>('off')
  const meetingModeRef = useRef(meetingMode)

  useEffect(() => {
    meetingModeRef.current = meetingMode
  }, [meetingMode])

  const startCapture = useCallback(async () => {
    try {
      const isRealMode = meetingModeRef.current === 'real'

      let systemStream: MediaStream | null = null
      if (!isRealMode) {
        try {
          systemStream = await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: true
          })
          systemStream.getVideoTracks().forEach((t) => t.stop())
          const audioTracks = systemStream.getAudioTracks()
          console.log('[SystemAudio] getDisplayMedia succeeded, audio tracks:', audioTracks.length)
          audioTracks.forEach((t, i) => {
            console.log(`[SystemAudio] track[${i}]:`, t.label, t.readyState, t.enabled, t.muted)
          })
          if (audioTracks.length > 0) {
            systemStreamRef.current = systemStream
            setSystemAudioStatus('active')
          } else {
            console.warn('[SystemAudio] No audio tracks returned from getDisplayMedia')
            setSystemAudioStatus('error')
          }
        } catch (err) {
          console.warn('[SystemAudio] getDisplayMedia failed:', err)
          setSystemAudioStatus('error')
        }
      }

      let micStream: MediaStream | null = null
      try {
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        })
        micStreamRef.current = micStream
        setMicStatus('active')
      } catch {
        setMicStatus('error')
      }

      if (!systemStream?.getAudioTracks().length && !micStream) {
        throw new Error('音声ソースが見つかりません。マイクの権限を確認してください。')
      }

      const ctx = new AudioContext({ sampleRate: 48000 })
      audioContextRef.current = ctx

      await ctx.audioWorklet.addModule(
        new URL('../lib/pcm-processor.js', import.meta.url).href
      )

      const workletNode = new AudioWorkletNode(ctx, 'pcm-processor', {
        processorOptions: {
          inputSampleRate: 48000,
          outputSampleRate: 16000,
          chunkDurationMs: 100
        }
      })
      workletNodeRef.current = workletNode

      workletNode.port.onmessage = (event) => {
        if (event.data.type === 'pcm') {
          sendAudio(event.data.buffer)
          audioChunkCountRef.current++
        }
      }

      if (systemStream && systemStream.getAudioTracks().length > 0) {
        const systemSource = ctx.createMediaStreamSource(systemStream)
        const systemGain = ctx.createGain()
        systemGain.gain.value = 1.5
        systemSource.connect(systemGain)
        systemGain.connect(workletNode)
      }

      if (micStream) {
        const micSource = ctx.createMediaStreamSource(micStream)
        const micGainNode = ctx.createGain()
        micGainNode.gain.value = isRealMode ? 4.0 : 2.0
        micSource.connect(micGainNode)
        micGainNode.connect(workletNode)
      }

      workletNode.connect(ctx.destination)
      setIsCapturing(true)
      audioChunkCountRef.current = 0
      setAudioChunkCount(0)
      chunkCountTimerRef.current = setInterval(() => {
        setAudioChunkCount(audioChunkCountRef.current)
      }, 1000)
    } catch (err) {
      console.error('Failed to start audio capture:', err)
      throw err
    }
  }, [sendAudio])

  const stopCapture = useCallback(() => {
    if (chunkCountTimerRef.current) {
      clearInterval(chunkCountTimerRef.current)
      chunkCountTimerRef.current = null
    }
    if (workletNodeRef.current) {
      workletNodeRef.current.disconnect()
      workletNodeRef.current = null
    }
    if (audioContextRef.current) {
      audioContextRef.current.close()
      audioContextRef.current = null
    }
    if (systemStreamRef.current) {
      systemStreamRef.current.getTracks().forEach((t) => t.stop())
      systemStreamRef.current = null
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((t) => t.stop())
      micStreamRef.current = null
    }
    setIsCapturing(false)
    setMicStatus('off')
    setSystemAudioStatus('off')
  }, [])

  return { isCapturing, audioChunkCount, micStatus, systemAudioStatus, startCapture, stopCapture }
}
