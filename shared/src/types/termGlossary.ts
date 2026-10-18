export interface TermEntry {
  id: number;
  term: string;
  reading: string | null;
  explanation: string | null;
  category: 'technical' | 'business' | 'industry' | 'acronym' | 'other' | null;
  isSkip: boolean;
  source: 'ai' | 'manual' | 'seed';
  usageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface DetectedTerm {
  term: string;
  reading: string | null;
  explanation: string;
  category: 'technical' | 'business' | 'industry' | 'acronym' | 'other';
}

export interface MeetingDetectedTerm {
  id: number;
  meetingId: number;
  termId: number;
  firstDetectedAt: number | null;
  createdAt: string;
  term: TermEntry;
}

export interface UserTermExclusion {
  id: number;
  userId: number;
  term: string;
  createdAt: string;
}
