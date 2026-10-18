import { APP_VERSION, getWsURL } from './config'
import { notifyUpdateRequired } from './api'

const WS_UPDATE_REQUIRED_CODE = 4426

function wsUrlWithClientInfo(): string {
  const sep = getWsURL().includes('?') ? '&' : '?'
  return `${getWsURL()}${sep}client_version=${encodeURIComponent(APP_VERSION || '0.0.0')}&client_platform=mobile`
}

export type ConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'error'

export interface TranscriptData {
  content: string
  isFinal: boolean
  speaker?: string | null
  speakerId?: number | null
  startTime?: number
  endTime?: number
  confidence?: string | null
  [key: string]: unknown
}

export interface MeetingCreatedData {
  meetingId: number
}

export interface MeetingEndedData {
  meetingId: number
}

interface ServerMessage {
  type: string
  [key: string]: unknown
}

export interface DeviceTakeoverData {
  meetingId: number
  takenOverBy: string
}

export interface ResearchSettingsPayload {
  main: boolean
  web: boolean
  fact: boolean
  gap: boolean
  tech: boolean
}

type EventHandlers = {
  status: (s: ConnectionStatus) => void
  meetingCreated: (d: MeetingCreatedData) => void
  meetingEnded: (d: MeetingEndedData) => void
  transcript: (d: TranscriptData) => void
  structuredSummary: (d: unknown) => void
  termDetected: (d: unknown) => void
  researchInsight: (d: unknown) => void
  researchGapAlert: (d: unknown) => void
  researchSettingsUpdated: (d: ResearchSettingsPayload) => void
  deviceTakeover: (d: DeviceTakeoverData) => void
  error: (msg: string) => void
  errorDetail: (d: { message: string; code?: string; meetingId?: number }) => void
  sessionInvalidated: () => void
}

export class WSClient {
  private ws: WebSocket | null = null
  private token = ''
  private status: ConnectionStatus = 'disconnected'
  private reconnectAttempts = 0
  private readonly maxReconnectAttempts = 100
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null
  private lastServerMsgAt = 0
  private static readonly PONG_TIMEOUT_MS = 25000
  private listeners: { [K in keyof EventHandlers]?: Set<EventHandlers[K]> } = {}
  private intentionallyClosed = false
  private activeMeetingId: number | null = null
  private activeMode: 'online' | 'real' | null = null

  on<K extends keyof EventHandlers>(event: K, handler: EventHandlers[K]): () => void {
    let set = this.listeners[event] as Set<EventHandlers[K]> | undefined
    if (!set) {
      set = new Set()
      this.listeners[event] = set as never
    }
    set.add(handler)
    return () => {
      set!.delete(handler)
    }
  }

  private emit<K extends keyof EventHandlers>(
    event: K,
    payload: Parameters<EventHandlers[K]>[0],
  ): void {
    const set = this.listeners[event] as Set<EventHandlers[K]> | undefined
    if (!set) return
    for (const handler of set) {
      ;(handler as (p: unknown) => void)(payload)
    }
  }

  getStatus(): ConnectionStatus {
    return this.status
  }

  connect(token: string): void {
    this.token = token
    this.intentionallyClosed = false
    this.reconnectAttempts = 0
    this.doConnect()
  }

  private doConnect(): void {
    this.cleanup()
    this.updateStatus(this.reconnectAttempts > 0 ? 'reconnecting' : 'connecting')

    let ws: WebSocket
    try {
      ws = new WebSocket(wsUrlWithClientInfo(), ['bearer', this.token])
    } catch {
      this.updateStatus('error')
      this.scheduleReconnect()
      return
    }
    ws.binaryType = 'arraybuffer'
    this.ws = ws

    ws.addEventListener('open', () => {
      const wasReconnect = this.reconnectAttempts > 0
      this.reconnectAttempts = 0
      this.updateStatus('connected')
      this.startKeepalive()
      if (wasReconnect && this.activeMeetingId !== null && this.activeMode !== null) {
        this.sendJSON({
          type: 'resume_meeting',
          meetingId: this.activeMeetingId,
          mode: this.activeMode,
          auto: true,
        })
      }
    })

    ws.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return
      this.lastServerMsgAt = Date.now()
      try {
        const msg = JSON.parse(event.data) as ServerMessage
        this.handleMessage(msg)
      } catch {
      }
    })

    ws.addEventListener('close', (event) => {
      this.stopKeepalive()
      if (event.code === WS_UPDATE_REQUIRED_CODE) {
        this.intentionallyClosed = true
        this.updateStatus('error')
        notifyUpdateRequired()
        return
      }
      if (this.intentionallyClosed) {
        this.updateStatus('disconnected')
        return
      }
      this.updateStatus('disconnected')
      this.scheduleReconnect()
    })

    ws.addEventListener('error', () => {
      this.updateStatus('error')
    })
  }

  private handleMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'meeting_created':
        this.emit('meetingCreated', { meetingId: msg.meetingId as number })
        break
      case 'meeting_ended':
        this.emit('meetingEnded', { meetingId: msg.meetingId as number })
        break
      case 'transcript':
        this.emit('transcript', msg.data as TranscriptData)
        break
      case 'structured_summary':
        this.emit('structuredSummary', msg.data)
        break
      case 'term_detected':
        this.emit('termDetected', msg.data)
        break
      case 'research_insight':
        this.emit('researchInsight', msg.data)
        break
      case 'research_gap_alert':
        this.emit('researchGapAlert', msg.data)
        break
      case 'device_takeover':
        this.emit('deviceTakeover', {
          meetingId: msg.meetingId as number,
          takenOverBy: String(msg.takenOverBy ?? 'unknown'),
        })
        break
      case 'research_settings_updated':
        this.emit('researchSettingsUpdated', msg.data as ResearchSettingsPayload)
        break
      case 'error':
        this.emit('error', String(msg.message ?? 'unknown error'))
        if (msg.code || msg.meetingId !== undefined) {
          this.emit('errorDetail', {
            message: String(msg.message ?? ''),
            code: typeof msg.code === 'string' ? msg.code : undefined,
            meetingId: typeof msg.meetingId === 'number' ? msg.meetingId : undefined,
          })
        }
        break
      case 'session_invalidated':
        this.emit('sessionInvalidated', undefined)
        break
      case 'keepalive':
        this.sendJSON({ type: 'ping' })
        break
      case 'pong':
        break
      default:
        break
    }
  }

  private updateStatus(status: ConnectionStatus): void {
    if (this.status === status) return
    this.status = status
    this.emit('status', status)
  }

  private startKeepalive(): void {
    this.stopKeepalive()
    this.lastServerMsgAt = Date.now()
    this.keepaliveTimer = setInterval(() => {
      if (this.lastServerMsgAt && Date.now() - this.lastServerMsgAt > WSClient.PONG_TIMEOUT_MS) {
        try {
          this.ws?.close()
        } catch {
        }
        return
      }
      this.sendJSON({ type: 'ping' })
    }, 15000)
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer)
      this.keepaliveTimer = null
    }
  }

  private scheduleReconnect(): void {
    if (this.intentionallyClosed) return
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.updateStatus('error')
      return
    }
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000)
    this.reconnectAttempts++
    this.reconnectTimer = setTimeout(() => {
      this.doConnect()
    }, delay)
  }

  private sendJSON(data: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data))
    }
  }

  sendAudioChunk(bytes: Uint8Array): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const ab = new ArrayBuffer(bytes.byteLength)
      new Uint8Array(ab).set(bytes)
      this.ws.send(ab)
    }
  }

  startMeeting(mode: 'online' | 'real', explicitTitle?: string): void {
    let title: string
    if (explicitTitle) {
      title = explicitTitle
    } else {
      const now = new Date()
      const hh = String(now.getHours()).padStart(2, '0')
      const mm = String(now.getMinutes()).padStart(2, '0')
      title = `Mobile Meeting (${hh}:${mm})`
    }
    this.sendJSON({ type: 'start_meeting', platform: 'mobile', title, mode })
  }

  resumeMeeting(meetingId: number, mode: 'online' | 'real', auto = false): void {
    this.sendJSON({ type: 'resume_meeting', meetingId, mode, auto })
  }

  pauseMeeting(): void {
    this.sendJSON({ type: 'pause_meeting' })
  }

  endMeeting(): void {
    this.sendJSON({ type: 'end_meeting' })
  }

  setActiveMeeting(meetingId: number, mode: 'online' | 'real'): void {
    this.activeMeetingId = meetingId
    this.activeMode = mode
  }

  clearActiveMeeting(): void {
    this.activeMeetingId = null
    this.activeMode = null
  }

  disconnect(): void {
    this.intentionallyClosed = true
    this.clearActiveMeeting()
    this.cleanup()
    this.updateStatus('disconnected')
  }

  private cleanup(): void {
    this.stopKeepalive()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      try {
        if (
          this.ws.readyState === WebSocket.OPEN ||
          this.ws.readyState === WebSocket.CONNECTING
        ) {
          this.ws.close()
        }
      } catch {
      }
      this.ws = null
    }
  }
}
