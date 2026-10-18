export type AnalysisType =
  | 'minutes'
  | 'research'
  | 'summary'
  | 'logic'
  | 'expert'
  | 'user'
  | 'creator'
  | 'graphic';

export interface AnalysisMetadata {
  sourceType: 'clipboard' | 'meeting_transcript';
  clipboardLength?: number;
  hasAdditionalContext: boolean;
  hasAdditionalInstructions: boolean;
  imageCount: number;
}

export interface Analysis {
  id: number;
  meetingId: number;
  type: AnalysisType;
  content: string;
  metadata: AnalysisMetadata | null;
  createdAt: string;
}

export interface GraphicRecording {
  id: number;
  meetingId: number;
  sourceText: string;
  imageUrl: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  triggerType?: string;
  stage?: string;
  pinnedAt?: string | null;
  draftJson?: unknown;
  researchInsightIds?: number[] | null;
  visualStyle?: string | null;
}
