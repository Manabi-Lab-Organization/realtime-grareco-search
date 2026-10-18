import { registerPlugin } from '@capacitor/core'

export type CameraFacing = 'front' | 'back'

export interface CameraCapturePlugin {
  requestPermission(): Promise<{ granted: boolean }>
  capture(options: { facing: CameraFacing }): Promise<{ dataUrl: string }>
}

export const CameraCapture = registerPlugin<CameraCapturePlugin>('CameraCapture')
