import { DrizzleQueryError } from 'drizzle-orm/errors';

export const DB_FAILURE_MESSAGE = 'データの読み書きに失敗しました。少し待ってから、もう一度お試しください。';

export function stripQueryParams(err: Error): Error {
  if (!(err instanceof DrizzleQueryError)) return err;
  return err.cause instanceof Error ? err.cause : new Error('Failed query');
}

export function publicErrorMessage(err: unknown): string {
  if (err instanceof DrizzleQueryError) return DB_FAILURE_MESSAGE;
  return err instanceof Error ? err.message : String(err);
}

export function isUniqueViolation(err: unknown): boolean {
  const source = err instanceof DrizzleQueryError ? err.cause : err;
  return (source as { code?: unknown } | null | undefined)?.code === '23505';
}
