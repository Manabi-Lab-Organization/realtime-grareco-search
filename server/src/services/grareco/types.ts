
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

export const REFLECT_TRIGGERS: ReadonlySet<GrarecoTriggerType> = new Set([
  'auto_reflect',
  'auto_milestone',
  'auto_fallback',
  'auto_meeting_end',
  'user_reflect',
]);

export const DISCOVER_TRIGGERS: ReadonlySet<GrarecoTriggerType> = new Set([
  'auto_discover',
  'user_discover',
]);
