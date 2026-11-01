import { normalizeClientType } from '../services/apiTokenService.js';

export function deviceClientTypeFromBody(body: unknown): 'desktop' | 'mobile' | null {
  if (typeof body !== 'object' || body === null) return null;
  const { clientType, client_type: snakeCaseClientType } = body as Record<string, unknown>;
  const normalized = normalizeClientType(clientType ?? snakeCaseClientType);
  return normalized === 'desktop' || normalized === 'mobile' ? normalized : null;
}
