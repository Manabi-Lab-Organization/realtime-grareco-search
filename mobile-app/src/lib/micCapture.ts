import { registerPlugin, type PluginListenerHandle } from '@capacitor/core'

export interface PcmChunkEvent {
  data: string
}

export interface InterruptionEvent {
  state: 'began' | 'ended' | 'resume_failed'
  error?: string
}

export interface MicCapturePlugin {
  start(): Promise<void>
  stop(): Promise<void>
  isRecording(): Promise<{ recording: boolean }>
  requestPermission(): Promise<{ granted: boolean }>
  addListener(
    eventName: 'pcmChunk',
    listener: (event: PcmChunkEvent) => void,
  ): Promise<PluginListenerHandle>
  addListener(
    eventName: 'interruption',
    listener: (event: InterruptionEvent) => void,
  ): Promise<PluginListenerHandle>
}

export const MicCapture = registerPlugin<MicCapturePlugin>('MicCapture')

export function base64ToPcmBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}
