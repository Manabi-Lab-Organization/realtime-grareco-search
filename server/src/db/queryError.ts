import { DrizzleQueryError } from 'drizzle-orm/errors';

export const DB_FAILURE_MESSAGE = 'データの読み書きに失敗しました。少し待ってから、もう一度お試しください。';

export function stripQueryParams(err: Error): Error {
  if (!(err instanceof DrizzleQueryError)) return err;
  return err.cause instanceof Error ? err.cause : new Error('Failed query');
}

export function publicErrorMessage(err: unknown): string {
  if (err instanceof DrizzleQueryError) return DB_FAILURE_MESSAGE;
  // pool.query・client.query の素の失敗も、message に入力値が残ることがあるので同じ扱い
  if (isPgDatabaseError(err)) return DB_FAILURE_MESSAGE;
  return err instanceof Error ? err.message : String(err);
}

/** pg の失敗（DatabaseError）か。code（5 文字の SQLSTATE）と severity を持つ */
export function isPgDatabaseError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) && 'severity' in err;
}

export function isUniqueViolation(err: unknown): boolean {
  const source = err instanceof DrizzleQueryError ? err.cause : err;
  return (source as { code?: unknown } | null | undefined)?.code === '23505';
}
