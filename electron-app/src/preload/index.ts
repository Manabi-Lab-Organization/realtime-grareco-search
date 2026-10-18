import { contextBridge, ipcRenderer } from 'electron'

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error'

export interface TranscriptData {
  content: string
  isFinal: boolean
  speaker: string | null
  speakerId: number | null
  startTime: number
  endTime: number
  confidence: string | null
}

export interface Settings {
  serverURL: string
  loggedIn: boolean
  tokenReadFailed?: boolean
  meetingMode: 'online' | 'real'
  savedMeetingId: number | null
  windowBounds: { width: number; height: number; x?: number; y?: number } | null
  screenshotShortcut: string
}

export interface DisplayShot {
  id: string
  name: string
  displayId: string
  dataUrl: string
  width: number
  height: number
}

export interface DetectedTerm {
  term: string
  reading: string | null
  explanation: string
  category: 'technical' | 'business' | 'industry' | 'acronym' | 'other'
}

export interface MeetingInfo {
  id: number
  title: string
  status: string
  platform: string
  startedAt: string
  endedAt: string | null
  duration: number | null
}

function createListener<T>(channel: string) {
  return (callback: (data: T) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: T): void => callback(data)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  }
}

const api = {
  getSettings: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings: Partial<Pick<Settings, 'meetingMode' | 'savedMeetingId'>>): Promise<void> =>
    ipcRenderer.invoke('settings:save', settings),
  getSiteConfig: (): Promise<{ appName?: string; termsUrl?: string; privacyUrl?: string } | null> =>
    ipcRenderer.invoke('api:getSiteConfig'),
  setServerURL: (
    url: string
  ): Promise<
    | { ok: true; serverURL: string; httpBase: string; serverVersion: string }
    | { ok: false; message: string }
  > => ipcRenderer.invoke('server:set', url),

  getSavedMeetingId: (): Promise<number | null> => ipcRenderer.invoke('meeting:getSavedId'),
  setSavedMeetingId: (id: number | null): Promise<void> =>
    ipcRenderer.invoke('meeting:setSavedId', id),

  connect: (): Promise<void> => ipcRenderer.invoke('ws:connect'),
  disconnect: (): Promise<void> => ipcRenderer.invoke('ws:disconnect'),
  getConnectionStatus: (): Promise<ConnectionStatus> => ipcRenderer.invoke('ws:getStatus'),

  startMeeting: (mode: 'online' | 'real', meetingType = 'general'): Promise<void> =>
    ipcRenderer.invoke('ws:startMeeting', mode, meetingType),
  resumeMeeting: (meetingId: number, mode: 'online' | 'real', auto = false): Promise<void> =>
    ipcRenderer.invoke('ws:resumeMeeting', meetingId, mode, auto),
  pauseMeeting: (): Promise<void> => ipcRenderer.invoke('ws:pauseMeeting'),
  endMeeting: (): Promise<void> => ipcRenderer.invoke('ws:endMeeting'),
  resetTranscription: (): Promise<void> => ipcRenderer.invoke('ws:resetTranscription'),

  sendAudio: (data: ArrayBuffer): void => ipcRenderer.send('audio:send', data),

  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:openExternal', url),
  openThirdPartyNotices: (): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke('app:openThirdPartyNotices'),

  fetchMeetings: (): Promise<MeetingInfo[]> => ipcRenderer.invoke('api:fetchMeetings'),
  fetchAnnouncements: (): Promise<unknown[]> => ipcRenderer.invoke('api:fetchAnnouncements'),
  markReadAnnouncement: (id: number): Promise<boolean> =>
    ipcRenderer.invoke('api:markReadAnnouncement', id),
  fetchMeetingDetail: (meetingId: number): Promise<{
    id: number
    title: string | null
    status: string
    platform: string
    startedAt: string
    endedAt: string | null
    duration: number | null
    isTitleEdited: boolean
    recordedSeconds?: number
    transcriptionStartedAt?: string | null
    pausedSeconds?: number
    pausedSince?: string | null
  } | null> => ipcRenderer.invoke('api:fetchMeetingDetail', meetingId),
  updateMeetingTitle: (
    meetingId: number,
    title: string,
  ): Promise<{ ok: true; title: string } | { ok: false; error: string }> =>
    ipcRenderer.invoke('api:updateMeetingTitle', meetingId, title),

  captureAllDisplays: (): Promise<DisplayShot[]> => ipcRenderer.invoke('capture:allDisplays'),
  uploadScreenshot: (
    meetingId: number,
    dataUrl: string,
    fileName?: string
  ): Promise<{ ok: true; image: unknown } | { ok: false; error: string }> =>
    ipcRenderer.invoke('api:uploadScreenshot', meetingId, dataUrl, fileName),
  uploadObservation: (
    meetingId: number,
    dataUrl: string,
    opts?: {
      sourceType?: 'camera' | 'window' | 'display'
      location?: { lat: number; lng: number; source?: string }
    }
  ): Promise<{ ok: true; observation: unknown } | { ok: false; error: string }> =>
    ipcRenderer.invoke('api:uploadObservation', meetingId, dataUrl, opts),
  postRoomObservationConsent: (version: number): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke('api:postRoomObservationConsent', version),
  listWindows: (): Promise<Array<{ id: string; name: string; dataUrl: string }>> =>
    ipcRenderer.invoke('capture:listWindows'),
  captureWindowShot: (
    windowId: string,
    windowName?: string
  ): Promise<{ ok: true; dataUrl: string; name: string } | { ok: false; error: string }> =>
    ipcRenderer.invoke('capture:windowShot', windowId, windowName),

  getScreenshotShortcut: (): Promise<string> => ipcRenderer.invoke('shortcut:get'),
  setScreenshotShortcut: (accel: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('shortcut:set', accel),
  onShortcutCapture: createListener<void>('shortcut:capture'),

  dismissTerm: (term: string): Promise<void> => ipcRenderer.invoke('ws:dismissTerm', term),

  checkPermissions: (): Promise<{ microphone: string; screen: string }> =>
    ipcRenderer.invoke('permissions:check'),
  requestMicrophone: (): Promise<boolean> =>
    ipcRenderer.invoke('permissions:requestMicrophone'),
  triggerScreenCapture: (): Promise<boolean> =>
    ipcRenderer.invoke('permissions:triggerScreenCapture'),
  openScreenRecordingSettings: (): Promise<void> =>
    ipcRenderer.invoke('permissions:openScreenRecordingSettings'),
  relaunchApp: (): Promise<void> => ipcRenderer.invoke('app:relaunch'),
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('app:getVersion'),

  setCompactMode: (): Promise<void> => ipcRenderer.invoke('window:setCompact'),
  setExpandedMode: (): Promise<void> => ipcRenderer.invoke('window:setExpanded'),
  getWindowMode: (): Promise<'expanded' | 'compact'> => ipcRenderer.invoke('window:getMode'),
  onWindowModeChanged: createListener<'expanded' | 'compact'>('window:mode-changed'),

  getAuthMe: (): Promise<{
    email: string
    role: string
    roomObservationEnabled?: boolean
    roomObservationConsentVersion?: number | null
    roomObservationConsentRequiredVersion?: number
  } | null> =>
    ipcRenderer.invoke('api:getAuthMe'),

  loginWithEmail: (
    email: string,
    password: string
  ): Promise<
    | { ok: true; user: { id: number; email: string; displayName: string | null; inviteVerified: boolean; role: string } }
    | { ok: false; error: string; message: string }
  > => ipcRenderer.invoke('auth:loginWithEmail', email, password),
  loginWithGoogle: (
    credential: string
  ): Promise<
    | { ok: true; user: { id: number; email: string; displayName: string | null; inviteVerified: boolean; role: string } }
    | { ok: false; error: string; message: string }
  > => ipcRenderer.invoke('auth:loginWithGoogle', credential),
  getGoogleClientId: (): Promise<{ clientId: string } | null> =>
    ipcRenderer.invoke('auth:getGoogleClientId'),
  loginViaWebWindow: (): Promise<
    | { ok: true; user: { id: number; email: string; displayName: string | null; inviteVerified: boolean; role: string } }
    | { ok: false; error: string; message: string }
  > => ipcRenderer.invoke('auth:loginViaWebWindow'),
  logout: (reason: 'user' | 'session_invalidated' = 'user'): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('auth:logout', reason),

  openWebWindow: (params: {
    key: string
    path: string
    title?: string
    width?: number
    height?: number
  }): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke('web:openWindow', params),
  openMeetingInBrowser: (
    path: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke('web:openInBrowser', path),

  setRecordingState: (recording: boolean): void => ipcRenderer.send('app:setRecordingState', recording),

  onConnectionStatus: createListener<ConnectionStatus>('ws:connection-status'),
  onTranscript: createListener<TranscriptData>('ws:transcript'),
  onTermDetected: createListener<DetectedTerm>('ws:term-detected'),
  onMeetingCreated: createListener<number>('ws:meeting-created'),
  onMeetingEnded: createListener<number>('ws:meeting-ended'),
  onTranscriptionReset: createListener<number>('ws:transcription-reset'),
  onDeviceTakeover: createListener<{ meetingId: number; takenOverBy: string }>('ws:device-takeover'),
  onStructuredSummary: createListener<{ content: string }>('ws:structured-summary'),
  onSessionInvalidated: createListener<void>('ws:session-invalidated'),
  onError: createListener<string>('ws:error'),
  onErrorDetail: createListener<{
    message: string
    code?: string
    meetingId?: number
  }>('ws:error-detail'),
}

contextBridge.exposeInMainWorld('electronAPI', api)
