import { readFileSync } from 'node:fs';

export const API_LEVEL = 1;

export const SERVER_APP_ID = 'realtime-grareco-search';

let cachedVersion: string | null = null;
function serverVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: string };
    cachedVersion = pkg.version ?? '0.0.0';
  } catch {
    cachedVersion = '0.0.0';
  }
  return cachedVersion;
}

export function serverInfo(env: NodeJS.ProcessEnv = process.env) {
  return {
    app: SERVER_APP_ID,
    version: serverVersion(),
    apiLevel: API_LEVEL,
    minDesktopVersion: env.MIN_DESKTOP_VERSION || null,
    minMobileVersion: env.MIN_MOBILE_VERSION || null,
  };
}
