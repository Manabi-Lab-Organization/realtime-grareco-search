
export type GrarecoTriggerType =
  | 'manual'
  | 'auto_reflect'
  | 'auto_discover'
  | 'auto_milestone'
  | 'auto_fallback'
  | 'auto_meeting_end'
  | 'user_reflect'
  | 'user_discover';

export type GrarecoStage = 'draft' | 'image';

export type GrarecoVisualStyle =
  | 'reflect_map'
  | 'tree'
  | 'fishbone'
  | '2x2'
  | 'blank_quadrant';

export type AutoPromoteMode = 'auto' | 'manual';

export interface ResearchInsightRef {
  insightId: number;
  headline: string;
  createdAt: string;
}

export interface GrarecoDraftSection {
  icon: string;
  heading: string;
  bullets: string[];
}

export interface GrarecoDraftHighlight {
  text: string;
  kind: 'decision' | 'question' | 'risk' | 'insight';
}

export interface GrarecoDraft {
  title: string;
  subtitle?: string;
  sections: GrarecoDraftSection[];
  highlights: GrarecoDraftHighlight[];
  researchRefs: ResearchInsightRef[];
  visualStyle: GrarecoVisualStyle;
  mermaid?: string;
}

export interface AutoGrarecoSettings {
  enabled: boolean;
  reflect: boolean;
  discover: boolean;
  maxImagesPerHour: number;
  autoPromoteMode: AutoPromoteMode;
  includeResearchRefs: boolean;
}

export const DEFAULT_AUTO_GRARECO_SETTINGS: AutoGrarecoSettings = {
  enabled: true,
  reflect: true,
  discover: true,
  maxImagesPerHour: 6,
  autoPromoteMode: 'auto',
  includeResearchRefs: true,
};

export interface GrarecoDraftEvent {
  recordingId: number;
  meetingId: number;
  triggerType: GrarecoTriggerType;
  draft: GrarecoDraft;
  willAutoPromote: boolean;
  cancelDeadlineMs: number;
}

export interface GrarecoImageReadyEvent {
  recordingId: number;
  meetingId: number;
  imageUrl: string;
}

export interface GrarecoSkippedEvent {
  recordingId: number;
  meetingId: number;
  reason: 'limit_reached' | 'manual_mode' | 'cancelled' | 'generation_failed';
}

export interface TopicShiftCandidateEvent {
  meetingId: number;
  similarity: number;
  detectedAt: number;
}

export interface TopicShiftCandidateClearedEvent {
  meetingId: number;
  reason: 'recovered' | 'fired' | 'dismissed';
}

export type TopicShiftSignal = {
  immediate: number | null;
  baseline: number | null;
  movingAverage: number | null;
  recentMin: number | null;
};

export interface TopicShiftHistoryRecord {
  id: number;
  meetingId: number;
  recordedAtMs: number;
  textPreview: string | null;
  immediateSimilarity: number | null;
  baselineSimilarity: number | null;
  movingAvgSimilarity: number | null;
  outcome: string | null;
  createdAt: string;
}
