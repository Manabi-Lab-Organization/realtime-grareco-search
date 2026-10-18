import { Router } from 'express';

const router = Router();

interface ReleaseInfo {
  version: string;
  name: string;
  body: string;
  publishedAt: string | null;
  prerelease: boolean;
}

let cachedReleases: ReleaseInfo[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL = 5 * 60 * 1000;

async function fetchReleases(): Promise<ReleaseInfo[]> {
  const now = Date.now();
  if (cachedReleases && now - cacheTimestamp < CACHE_TTL) {
    return cachedReleases;
  }

  const repo = process.env.GITHUB_REPO || 'Manabi-Lab-Organization/realtime-grareco-search';
  const url = `https://api.github.com/repos/${repo}/releases?per_page=30`;

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'Realtime-GraReco-Search-Server',
  };
  if (process.env.GITHUB_RELEASES_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_RELEASES_TOKEN}`;
  }

  try {
    const res = await fetch(url, { headers });

    if (res.status === 404) {
      cachedReleases = [];
      cacheTimestamp = now;
      return cachedReleases;
    }

    if (!res.ok) {
      console.error(`[Releases] GitHub API error: ${res.status} ${res.statusText}`);
      if (cachedReleases) return cachedReleases;
      return [];
    }

    const data: Array<{
      tag_name?: string;
      name?: string;
      body?: string;
      published_at?: string;
      draft?: boolean;
      prerelease?: boolean;
    }> = await res.json();

    const releases: ReleaseInfo[] = data
      .filter((r) => !r.draft)
      .map((r) => ({
        version: (r.tag_name || '').replace(/^v/, ''),
        name: r.name || r.tag_name || '',
        body: r.body || '',
        publishedAt: r.published_at || null,
        prerelease: !!r.prerelease,
      }));

    cachedReleases = releases;
    cacheTimestamp = now;
    return releases;
  } catch (err) {
    console.error('[Releases] Failed to fetch releases:', err);
    if (cachedReleases) return cachedReleases;
    return [];
  }
}

router.get('/', async (_req, res, next) => {
  try {
    const releases = await fetchReleases();
    res.json(releases);
  } catch (err) {
    next(err);
  }
});

export default router;
