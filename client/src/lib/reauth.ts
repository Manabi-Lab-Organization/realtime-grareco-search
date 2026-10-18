
type ReauthHandler = () => Promise<boolean>;

let handler: ReauthHandler | null = null;
let inFlight: Promise<boolean> | null = null;

export function setReauthHandler(h: ReauthHandler | null): void {
  handler = h;
}

export function requestReauth(): Promise<boolean> {
  if (!handler) return Promise.resolve(false);
  if (!inFlight) {
    inFlight = handler().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

export async function isReauthRequired(res: Response): Promise<boolean> {
  if (res.status !== 403) return false;
  const body = await res.json().catch(() => null);
  return body?.code === 'reauth_required';
}

export async function fetchWithReauth(input: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, init);
  if (await isReauthRequired(res.clone())) {
    if (await requestReauth()) return fetch(input, init);
  }
  return res;
}

export async function ensureRecentAuth(): Promise<boolean> {
  try {
    const res = await fetch('/api/auth/sudo', { credentials: 'include' });
    if (res.ok) {
      const body = (await res.json()) as { active?: boolean };
      if (body.active) return true;
    }
  } catch {
  }
  return requestReauth();
}
