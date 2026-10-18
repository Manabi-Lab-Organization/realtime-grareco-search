
export interface ResearchCard {
  id: string;
  cardType: 'info' | 'fact-check' | 'gap-alert' | 'minutes-todo';
  agentType: AgentType;
  keyword: string;
  title: string;
  body: string;
  importance: number;
  sources: Source[];
  timestamp: number;
  metadata?: Record<string, unknown>;
  meetingId?: number;
}

export interface Source {
  url: string;
  title: string;
  author?: string;
  publishedAt?: string;
  trustScore: number;
}

export type AgentType = 'web' | 'fact' | 'gap' | 'tech';

export type MeetingType = 'executive' | 'technical' | 'training' | 'seminar' | 'one_on_one' | 'general';

export const VALID_MEETING_TYPES: ReadonlySet<string> = new Set<MeetingType>(['executive', 'technical', 'training', 'seminar', 'one_on_one', 'general']);

export function isMeetingType(v: unknown): v is MeetingType {
  return typeof v === 'string' && VALID_MEETING_TYPES.has(v);
}

export const AGENT_PRIORITIES: Record<MeetingType, AgentType[]> = {
  executive: ['fact', 'web', 'gap'],
  technical: ['tech', 'web'],
  training: ['web', 'tech'],
  seminar: ['web', 'fact'],
  one_on_one: ['gap', 'fact'],
  general: ['web', 'fact', 'gap'],
};

export type EmitFn = (event: string, data: unknown) => void;

export function isResearchEnabled(): boolean {
  return process.env.RESEARCH_ENABLED !== 'false';
}
