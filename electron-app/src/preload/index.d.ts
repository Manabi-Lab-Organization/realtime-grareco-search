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

export interface ElectronAPI {
  getSettings(): Promise<Settings>
  saveSettings(settings: Partial<Pick<Settings, 'meetingMode' | 'savedMeetingId'>>): Promise<void>

  getSavedMeetingId(): Promise<number | null>
  setSavedMeetingId(id: number | null): Promise<void>

  connect(): Promise<void>
  disconnect(): Promise<void>
  getConnectionStatus(): Promise<ConnectionStatus>

  startMeeting(mode: 'online' | 'real', meetingType?: string): Promise<void>
  resumeMeeting(meetingId: number, mode: 'online' | 'real', auto?: boolean): Promise<void>
  pauseMeeting(): Promise<void>
  endMeeting(): Promise<void>
  resetTranscription(): Promise<void>

  sendAudio(data: ArrayBuffer): void

  setRecordingState(recording: boolean): void

  openExternal(url: string): Promise<void>
  openThirdPartyNotices(): Promise<{ ok: true } | { ok: false; error: string }>
  fetchMeetings(): Promise<MeetingInfo[]>
  fetchAnnouncements(): Promise<unknown[]>
  markReadAnnouncement(id: number): Promise<boolean>
  fetchMeetingDetail(meetingId: number): Promise<{
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
    participantCount?: number
  } | null>
  updateMeetingTitle(
    meetingId: number,
    title: string,
  ): Promise<{ ok: true; title: string } | { ok: false; error: string }>

  dismissTerm(term: string): Promise<void>

  captureAllDisplays(): Promise<DisplayShot[]>
  uploadScreenshot(
    meetingId: number,
    dataUrl: string,
    fileName?: string
  ): Promise<{ ok: true; image: unknown } | { ok: false; error: string }>
  getScreenshotShortcut(): Promise<string>
  setScreenshotShortcut(accel: string): Promise<{ ok: boolean; error?: string }>
  onShortcutCapture(callback: () => void): () => void

  uploadObservation(
    meetingId: number,
    dataUrl: string,
    opts?: {
      sourceType?: 'camera' | 'window' | 'display'
      location?: { lat: number; lng: number; source?: string }
    }
  ): Promise<{ ok: true; observation: unknown } | { ok: false; error: string }>
  postRoomObservationConsent(version: number): Promise<{ ok: true } | { ok: false; error: string }>
  listWindows(): Promise<Array<{ id: string; name: string; dataUrl: string }>>
  captureWindowShot(
    windowId: string,
    windowName?: string
  ): Promise<{ ok: true; dataUrl: string; name: string } | { ok: false; error: string }>

  setCompactMode(): Promise<void>
  setExpandedMode(): Promise<void>
  getWindowMode(): Promise<'expanded' | 'compact'>
  onWindowModeChanged(callback: (mode: 'expanded' | 'compact') => void): () => void

  checkPermissions(): Promise<{ microphone: string; screen: string }>
  requestMicrophone(): Promise<boolean>
  triggerScreenCapture(): Promise<boolean>
  openScreenRecordingSettings(): Promise<void>
  relaunchApp(): Promise<void>
  getAppVersion(): Promise<string>

  onConnectionStatus(callback: (status: ConnectionStatus) => void): () => void
  onTranscript(callback: (data: TranscriptData) => void): () => void
  onTermDetected(callback: (data: DetectedTerm) => void): () => void
  onMeetingCreated(callback: (meetingId: number) => void): () => void
  onMeetingEnded(callback: (meetingId: number) => void): () => void
  onTranscriptionReset(callback: (meetingId: number) => void): () => void
  onDeviceTakeover(
    callback: (data: { meetingId: number; takenOverBy: string }) => void,
  ): () => void
  onStructuredSummary(callback: (data: { content: string }) => void): () => void
  onSessionInvalidated(callback: () => void): () => void
  onError(callback: (message: string) => void): () => void
  onErrorDetail(
    callback: (data: { message: string; code?: string; meetingId?: number }) => void,
  ): () => void

  getAuthMe(): Promise<{
    email: string
    role: string
    roomObservationEnabled?: boolean
    roomObservationConsentVersion?: number | null
    roomObservationConsentRequiredVersion?: number
  } | null>

  getSiteConfig(): Promise<{ appName?: string; termsUrl?: string; privacyUrl?: string } | null>

  setServerURL(
    url: string
  ): Promise<
    | { ok: true; serverURL: string; httpBase: string; serverVersion: string }
    | { ok: false; message: string }
  >

  loginWithEmail(
    email: string,
    password: string
  ): Promise<
    | { ok: true; user: { id: number; email: string; displayName: string | null; inviteVerified: boolean; role: string } }
    | { ok: false; error: string; message: string }
  >
  loginWithGoogle(
    credential: string
  ): Promise<
    | { ok: true; user: { id: number; email: string; displayName: string | null; inviteVerified: boolean; role: string } }
    | { ok: false; error: string; message: string }
  >
  getGoogleClientId(): Promise<{ clientId: string } | null>
  loginViaWebWindow(): Promise<
    | { ok: true; user: { id: number; email: string; displayName: string | null; inviteVerified: boolean; role: string } }
    | { ok: false; error: string; message: string }
  >
  logout(reason?: 'user' | 'session_invalidated'): Promise<{ ok: boolean }>

  openWebWindow(params: {
    key: string
    path: string
    title?: string
    width?: number
    height?: number
  }): Promise<{ ok: true } | { ok: false; error: string }>
  openMeetingInBrowser(path: string): Promise<{ ok: true } | { ok: false; error: string }>
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}
