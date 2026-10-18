import { Router } from 'express';

const router = Router();

interface PlatformAsset {
  id: number;
  url: string;
  size: number;
  filename: string;
}

interface DownloadInfo {
  available: boolean;
  version?: string;
  mac?: PlatformAsset;
  win?: PlatformAsset;
}

let cachedInfo: DownloadInfo | null = null;
let cacheTimestamp = 0;
const CACHE_TTL = 5 * 60 * 1000;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

async function fetchLatestRelease(): Promise<DownloadInfo> {
  const now = Date.now();
  if (cachedInfo && now - cacheTimestamp < CACHE_TTL) {
    return cachedInfo;
  }

  const repo = process.env.GITHUB_REPO || 'Manabi-Lab-Organization/realtime-grareco-search';
  const url = `https://api.github.com/repos/${repo}/releases/latest`;

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
      cachedInfo = { available: false };
      cacheTimestamp = now;
      return cachedInfo;
    }

    if (!res.ok) {
      console.error(`[Download] GitHub API error: ${res.status} ${res.statusText}`);
      if (cachedInfo) return cachedInfo;
      return { available: false };
    }

    const data = await res.json();
    const assets: Array<{ id: number; name: string; browser_download_url: string; size: number }> =
      data.assets || [];

    const macAsset =
      assets.find((a) => a.name.endsWith('-universal.dmg')) ||
      assets.find((a) => a.name.endsWith('-arm64.dmg')) ||
      assets.find((a) => a.name.endsWith('-x64.dmg')) ||
      assets.find((a) => a.name.endsWith('.dmg') || a.name.endsWith('.zip'));
    const winAsset = assets.find(
      (a) => a.name.endsWith('.exe') || a.name.endsWith('.msi')
    );

    const info: DownloadInfo = {
      available: !!(macAsset || winAsset),
      version: data.tag_name?.replace(/^v/, ''),
    };

    if (macAsset) {
      info.mac = {
        id: macAsset.id,
        url: macAsset.browser_download_url,
        size: macAsset.size,
        filename: macAsset.name,
      };
    }
    if (winAsset) {
      info.win = {
        id: winAsset.id,
        url: winAsset.browser_download_url,
        size: winAsset.size,
        filename: winAsset.name,
      };
    }

    cachedInfo = info;
    cacheTimestamp = now;
    return info;
  } catch (err) {
    console.error('[Download] Failed to fetch release info:', err);
    if (cachedInfo) return cachedInfo;
    return { available: false };
  }
}

router.get('/info', async (_req, res, next) => {
  try {
    const info = await fetchLatestRelease();
    res.json(info);
  } catch (err) {
    next(err);
  }
});

router.get('/:platform', async (req, res, next) => {
  try {
    const { platform } = req.params;
    if (platform !== 'mac' && platform !== 'win') {
      res.status(400).json({ error: 'Platform must be "mac" or "win"' });
      return;
    }

    const token = process.env.GITHUB_RELEASES_TOKEN;
    const info = await fetchLatestRelease();

    if (!info.available) {
      res.status(404).json({ error: 'No release available' });
      return;
    }

    const asset = platform === 'mac' ? info.mac : info.win;
    if (!asset) {
      res.status(404).json({ error: `No ${platform} release available` });
      return;
    }

    if (!token) {
      res.redirect(302, asset.url);
      return;
    }

    const repo = process.env.GITHUB_REPO || 'Manabi-Lab-Organization/realtime-grareco-search';
    const assetRes = await fetch(
      `https://api.github.com/repos/${repo}/releases/assets/${asset.id}`,
      {
        headers: {
          Accept: 'application/octet-stream',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'Realtime-GraReco-Search-Server',
        },
        redirect: 'manual',
      }
    );

    const temporaryUrl = assetRes.headers.get('location');
    if (!temporaryUrl) {
      console.error(`[Download] No redirect location for asset ${asset.id} (status: ${assetRes.status})`);
      res.status(502).json({ error: 'Failed to resolve download URL' });
      return;
    }

    res.redirect(302, temporaryUrl);
  } catch (err) {
    next(err);
  }
});

export default router;
