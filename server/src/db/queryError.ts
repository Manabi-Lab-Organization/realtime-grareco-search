import { DrizzleQueryError } from 'drizzle-orm/errors';

export function stripQueryParams(err: Error): Error {
  if (!(err instanceof DrizzleQueryError)) return err;
  return err.cause instanceof Error ? err.cause : new Error('Failed query');
}

export function isUniqueViolation(err: unknown): boolean {
  const source = err instanceof DrizzleQueryError ? err.cause : err;
  return (source as { code?: unknown } | null | undefined)?.code === '23505';
}
