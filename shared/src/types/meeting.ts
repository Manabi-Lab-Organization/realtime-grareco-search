export type MeetingPlatform = 'zoom' | 'meet' | 'teams' | 'webex' | 'web-recorder' | 'unknown';
export type MeetingStatus = 'idle' | 'active' | 'paused' | 'completed';

export type ParticipantSource = 'manual' | 'image' | 'text' | 'conversation';

export interface Participant {
  name: string;
  gender: '男' | '女' | '分からない';
  age: '10才未満' | '10代' | '20代' | '30代' | '40代' | '50代' | '60代' | '70代' | '80才以上' | '分からない';
  other: string;
  speakerIds?: number[];
  source?: ParticipantSource;
  confirmedAt?: string;
}

export interface Meeting {
  id: number;
  userId: string;
  title: string;
  platform: MeetingPlatform;
  status: MeetingStatus;
  isTitleEdited: boolean;
  participants: Participant[];
  startedAt: string;
  endedAt: string | null;
  duration: number | null;
  transcriptionStartedAt: string | null;
  pausedSeconds: number;
  pausedSince: string | null;
  ngKeywords?: string[];
  shareActive?: boolean;
}

export interface Transcript {
  id: number;
  meetingId: number;
  speaker: string | null;
  speakerId: number | null;
  content: string;
  startTime: number;
  endTime: number;
  isFinal: boolean;
  confidence: string | null;
  createdAt: string;
  ngExcluded?: boolean;
}

export interface MeetingImage {
  id: number;
  meetingId: number;
  imageData: string;
  mimeType: string;
  fileName: string | null;
  uploadedAt: string;
  meetingElapsedMs: number | null;
  aiAnalysis: string | null;
  aiDiagram: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface MeetingObservation {
  id: number;
  meetingId: number;
  capturedAt: string;
  meetingElapsedMs: number | null;
  peopleCount: number | null;
  fiveW1h: {
    when: string | null;
    where: string | null;
    who: string | null;
    what: string | null;
    why: string | null;
    how: string | null;
  } | null;
  people: Array<{
    position: string | null;
    posture: string | null;
    activity: string | null;
    inferredEmotion: string | null;
    inferredThought: string | null;
  }> | null;
  location: { lat: number; lng: number; source?: string } | null;
  rawSummary: string | null;
  materialsText: string | null;
  materialsDiagram: string | null;
  sourceType: string;
  linkedImageId: number | null;
  createdAt: string;
}

export interface MeetingMemo {
  id: number;
  meetingId: number;
  content: string;
  meetingElapsedMs: number | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface ParticipantImage {
  id: number;
  meetingId: number;
  imageData: string;
  mimeType: string;
  fileName: string | null;
  aiExtractedParticipants: Participant[] | null;
  createdAt: string;
}

export interface ParticipantText {
  id: number;
  meetingId: number;
  content: string;
  aiExtractedParticipants: Participant[] | null;
  createdAt: string;
  updatedAt: string;
}

export type ParticipantProfileCardStatus = 'pending' | 'confirmed' | 'dismissed';
export type ParticipantProfileCardOrigin = 'initial' | 'reprofile';

export interface ParticipantProfileCard {
  id: number;
  meetingId: number;
  speakerId: number;
  utterance: string;
  transcriptId: number | null;
  suggestedName: string;
  finalName: string | null;
  status: ParticipantProfileCardStatus;
  origin: ParticipantProfileCardOrigin;
  createdAt: string;
  resolvedAt: string | null;
}

export interface StructuredSummary {
  id: number;
  meetingId: number;
  content: string;
  previousContent: string | null;
  lastProcessedTime: number | null;
  createdAt: string;
  updatedAt: string;
}
