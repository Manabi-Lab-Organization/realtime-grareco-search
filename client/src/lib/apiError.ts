export function apiErrorText(body: { message?: unknown; error?: unknown }, status: number): string {
  if (typeof body.message === 'string' && body.message) return body.message;
  if (typeof body.error === 'string' && body.error) return body.error;
  return `HTTP ${status}`;
}
