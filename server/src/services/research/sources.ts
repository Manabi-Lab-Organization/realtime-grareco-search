import { httpUrlOrNull } from '../urlSafety.js';
import type { ResearchCard } from './types.js';

type RawSource = { url?: unknown; title?: unknown; author?: unknown; publishedAt?: unknown; trustScore?: unknown };

export function sanitizeResearchSources(raw: unknown): ResearchCard['sources'] {
  if (!Array.isArray(raw)) return [];
  const out: ResearchCard['sources'] = [];
  for (const item of raw as RawSource[]) {
    if (!item || typeof item !== 'object') continue;
    const url = httpUrlOrNull(item.url);
    if (!url) continue;
    out.push({
      url,
      title: typeof item.title === 'string' ? item.title : '',
      author: typeof item.author === 'string' ? item.author : undefined,
      publishedAt: typeof item.publishedAt === 'string' ? item.publishedAt : undefined,
      trustScore: typeof item.trustScore === 'number' && Number.isFinite(item.trustScore) ? item.trustScore : 0.5,
    });
  }
  return out;
}
