const DEV_CLIENT_URL = 'http://localhost:5173';

export function normalizeOrigin(url: string): string {
  return url.replace(/\/+$/, '');
}

export function allowedBrowserOrigins(env: Record<string, string | undefined> = process.env): string[] {
  const isProd = env.NODE_ENV === 'production';
  const candidates = [env.APP_URL, env.CLIENT_URL || (isProd ? undefined : DEV_CLIENT_URL)];
  return [...new Set(candidates.filter((v): v is string => !!v).map(normalizeOrigin))];
}
