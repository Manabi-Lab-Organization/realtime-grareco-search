
export interface ShareMeta {
  title: string | null;
  status: string;
  live: boolean;
  contents: string[];
}

export interface PublicTerm {
  term: string;
  reading: string | null;
  explanation: string;
  category: 'technical' | 'business' | 'industry' | 'acronym' | 'other';
}

export interface PublicResearchSource {
  url: string;
  title: string;
  trustScore?: number;
}

export interface PublicResearchCard {
  id: string;
  cardType: string;
  agentType: string;
  keyword: string;
  title: string;
  body: string;
  importance: number;
  sources: PublicResearchSource[];
  timestamp: number;
}

export interface PublicGrareco {
  id: string;
  imageUrl: string;
  pinnedAt: number | null;
  timestamp: number;
}

export interface PublicSummary {
  content: string;
  updatedAt: number;
}

export class ShareGoneError extends Error {
  constructor() {
    super('share_ended');
    this.name = 'ShareGoneError';
  }
}
export class ShareNotFoundError extends Error {
  constructor() {
    super('not_found');
    this.name = 'ShareNotFoundError';
  }
}

async function publicGet<T>(token: string, sub: string): Promise<T> {
  const res = await fetch(`/api/share/${encodeURIComponent(token)}/${sub}`, {
    credentials: 'omit',
    headers: { 'Content-Type': 'application/json' },
  });
  if (res.status === 410) throw new ShareGoneError();
  if (res.status === 404) throw new ShareNotFoundError();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (res.status === 204) return null as T;
  return res.json() as Promise<T>;
}

export const fetchShareMeta = (token: string) => publicGet<ShareMeta>(token, 'meta');
export const fetchShareTerms = (token: string) => publicGet<PublicTerm[]>(token, 'term-glossary');
export const fetchShareResearch = (token: string) => publicGet<PublicResearchCard[]>(token, 'research-insights');
export const fetchShareGrarecos = (token: string) =>
  publicGet<PublicGrareco[]>(token, 'graphic-recordings');
export const fetchShareSummary = (token: string) =>
  publicGet<PublicSummary | null>(token, 'structured-summary');

export const TERM_CATEGORY_LABEL: Record<PublicTerm['category'], string> = {
  technical: 'IT',
  business: 'BIZ',
  industry: '業界',
  acronym: '略語',
  other: 'その他',
};

export function researchCardLabel(cardType: string): string {
  switch (cardType) {
    case 'fact-check':
      return '事実確認';
    case 'info':
      return '参考情報';
    default:
      return '情報';
  }
}

export function formatTermForCopy(t: PublicTerm): string {
  const head = t.reading ? `${t.term}（${t.reading}）` : t.term;
  return `【${TERM_CATEGORY_LABEL[t.category]}】${head}\n${t.explanation}`;
}

export function formatResearchForCopy(c: PublicResearchCard): string {
  const lines: string[] = [];
  lines.push(`【${researchCardLabel(c.cardType)}】 ${c.keyword}`);
  lines.push(`■ ${c.title}`);
  if (c.body) lines.push('', c.body);
  if (c.sources && c.sources.length > 0) {
    lines.push('', '出典:');
    for (const s of c.sources) lines.push(`- ${s.title || s.url} (${s.url})`);
  }
  return lines.join('\n');
}
