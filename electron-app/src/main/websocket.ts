import { BrowserWindow } from 'electron'
import WebSocket from 'ws'
import type { IncomingMessage } from 'http'
import { clientHeaders, checkUpdateRequired, notifyTokenInvalid } from './apiClient'
import { logAuthEvent } from './authLog'

const CLOSE_UPDATE_REQUIRED = 4426

type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error'

interface ServerMessage {
  type: string
  [key: string]: unknown
}

export class WebSocketManager {
  private ws: WebSocket | null = null
  private serverURL = ''
  private token = ''
  private reconnectAttempts = 0
  private maxReconnectAttempts = 100
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null
  private status: ConnectionStatus = 'disconnected'
  private mainWindow: BrowserWindow | null = null
  private lastServerMsgAt = 0
  private static readonly PONG_TIMEOUT_MS = 25000
  private updateRequired = false

  setMainWindow(win: BrowserWindow): void {
    this.mainWindow = win
  }

  private sendToRenderer(channel: string, ...args: unknown[]): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, ...args)
    }
  }

  private updateStatus(status: ConnectionStatus): void {
    this.status = status
    this.sendToRenderer('ws:connection-status', status)
  }

  getStatus(): ConnectionStatus {
    return this.status
  }

  connect(serverURL: string, token: string): void {
    this.serverURL = serverURL
    this.token = token
    this.reconnectAttempts = 0
    this.updateRequired = false
    this.doConnect()
  }

  private doConnect(): void {
    this.cleanup()
    this.updateStatus(this.reconnectAttempts > 0 ? 'reconnecting' : 'connecting')

    try {
      this.ws = new WebSocket(this.serverURL, {
        headers: {
          ...clientHeaders(),
          Authorization: `Bearer ${this.token}`,
        },
      })
    } catch {
      this.updateStatus('error')
      this.scheduleReconnect()
      return
    }

    this.ws.on('open', () => {
      console.log('[WS] Connected')
      this.reconnectAttempts = 0
      this.updateStatus('connected')
      this.startKeepalive()
    })

    this.ws.on('message', (data: WebSocket.Data, isBinary: boolean) => {
      if (isBinary) return
      this.lastServerMsgAt = Date.now()

      try {
        const msg: ServerMessage = JSON.parse(data.toString())
        this.handleMessage(msg)
      } catch {
        console.error('[WS] Failed to parse message')
      }
    })

    this.ws.on('unexpected-response', (_req, res: IncomingMessage) => {
      const status = res.statusCode ?? 0
      console.warn(`[WS] handshake rejected: HTTP ${status}`)
      res.resume()
      if (status === 426) {
        this.stopForUpdate()
        return
      }
      if (status === 401) {
        this.status = 'disconnected'
        this.cleanup()
        this.updateStatus('error')
        notifyTokenInvalid()
        return
      }
      this.cleanup()
      this.updateStatus('error')
      this.scheduleReconnect()
    })

    this.ws.on('close', (code: number, reason: Buffer) => {
      console.log(`[WS] Closed: code=${code}, reason=${reason.toString() || 'none'}`)
      this.stopKeepalive()
      if (code === CLOSE_UPDATE_REQUIRED || reason.toString() === 'update_required') {
        this.stopForUpdate()
        return
      }
      if (this.status !== 'disconnected') {
        this.updateStatus('disconnected')
        this.scheduleReconnect()
      }
    })

    this.ws.on('error', (err: Error) => {
      console.error('[WS] Error:', err.message)
      this.updateStatus('error')
    })
  }

  private handleMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'meeting_created':
        this.sendToRenderer('ws:meeting-created', msg.meetingId)
        break
      case 'transcript':
        this.sendToRenderer('ws:transcript', msg.data)
        break
      case 'structured_summary':
        this.sendToRenderer('ws:structured-summary', msg.data)
        break
      case 'meeting_ended':
        this.sendToRenderer('ws:meeting-ended', msg.meetingId)
        break
      case 'transcription_reset':
        this.sendToRenderer('ws:transcription-reset', msg.meetingId)
        break
      case 'device_takeover':
        this.sendToRenderer('ws:device-takeover', {
          meetingId: msg.meetingId,
          takenOverBy: msg.takenOverBy,
        })
        break
      case 'term_detected':
        this.sendToRenderer('ws:term-detected', msg.data)
        break
      case 'error':
        this.sendToRenderer('ws:error', msg.message)
        if (msg.code || msg.meetingId !== undefined) {
          this.sendToRenderer('ws:error-detail', {
            message: msg.message,
            code: msg.code,
            meetingId: msg.meetingId,
          })
        }
        break
      case 'session_invalidated':
        logAuthEvent('session_invalidated', 'ws session_invalidated')
        this.sendToRenderer('ws:session-invalidated')
        break
      case 'keepalive':
        this.sendJSON({ type: 'ping' })
        break
      case 'pong':
        break
      default:
        console.log('[WS] Unknown message type:', msg.type)
    }
  }

  private startKeepalive(): void {
    this.stopKeepalive()
    this.lastServerMsgAt = Date.now()
    this.keepaliveTimer = setInterval(() => {
      if (this.lastServerMsgAt && Date.now() - this.lastServerMsgAt > WebSocketManager.PONG_TIMEOUT_MS) {
        console.log('[WS] Server unresponsive — treating as disconnected')
        this.updateStatus('reconnecting')
        this.cleanup()
        this.scheduleReconnect()
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

  private stopForUpdate(): void {
    this.updateRequired = true
    this.status = 'disconnected'
    this.cleanup()
    this.updateStatus('error')
    checkUpdateRequired(426)
  }

  private scheduleReconnect(): void {
    if (this.updateRequired) return
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.log('[WS] Max reconnect attempts reached')
      this.updateStatus('error')
      return
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000)
    this.reconnectAttempts++
    console.log(`[WS] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`)

    this.reconnectTimer = setTimeout(() => {
      this.doConnect()
    }, delay)
  }

  private sendJSON(data: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data))
    }
  }

  sendAudioChunk(data: Buffer): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data)
    }
  }

  startMeeting(mode: 'online' | 'real', meetingType = 'general'): void {
    const now = new Date()
    const hh = String(now.getHours()).padStart(2, '0')
    const mm = String(now.getMinutes()).padStart(2, '0')
    this.sendJSON({
      type: 'start_meeting',
      platform: 'desktop',
      title: `Desktop Meeting (${hh}:${mm})`,
      mode,
      meetingType
    })
  }

  resumeMeeting(meetingId: number, mode: 'online' | 'real', auto = false): void {
    this.sendJSON({
      type: 'resume_meeting',
      meetingId,
      mode,
      auto
    })
  }

  pauseMeeting(): void {
    this.sendJSON({ type: 'pause_meeting' })
  }

  resetTranscription(): void {
    this.sendJSON({ type: 'reset_transcription' })
  }

  endMeeting(): void {
    this.sendJSON({ type: 'end_meeting' })
  }

  dismissTerm(term: string): void {
    this.sendJSON({ type: 'dismiss_term', term })
  }

  reconnectNow(): void {
    if (this.updateRequired || !this.serverURL || !this.token) return
    if (this.status === 'disconnected' && !this.reconnectTimer && !this.ws) return
    if (
      this.status === 'connected' &&
      Date.now() - this.lastServerMsgAt < WebSocketManager.PONG_TIMEOUT_MS
    ) {
      return
    }
    console.log('[WS] Reconnecting now (resume)')
    this.reconnectAttempts = 0
    this.doConnect()
  }

  disconnect(): void {
    this.status = 'disconnected'
    this.cleanup()
    this.sendToRenderer('ws:connection-status', 'disconnected')
  }

  private cleanup(): void {
    this.stopKeepalive()

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    if (this.ws) {
      this.ws.removeAllListeners()
      this.ws.on('error', () => {})
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

  destroy(): void {
    this.disconnect()
  }
}

export const wsManager = new WebSocketManager()
