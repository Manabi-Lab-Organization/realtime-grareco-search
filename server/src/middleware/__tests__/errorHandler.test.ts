import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { errorHandler } from '../errorHandler.js';

function run(err: Error) {
  const json = vi.fn();
  const res = { status: vi.fn().mockReturnThis(), json } as unknown as Response;
  const req = { path: '/x', method: 'POST', body: {} } as unknown as Request;
  errorHandler(err, req, res, vi.fn() as unknown as NextFunction);
  return { res, json };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('errorHandler のクエリの失敗の扱い', () => {
  it('開発時のログと応答にクエリのパラメータを出さない', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = new DrizzleQueryError('update users', ['secret-value'], new Error('pg error'));
    const { res, json } = run(err);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret-value');
    expect(JSON.stringify(json.mock.calls)).not.toContain('secret-value');
    expect(JSON.stringify(log.mock.calls)).toContain('pg error');
    expect(json.mock.calls[0][0].error).toBe('pg error');
  });

  it('本番のログにクエリのパラメータを出さず、応答は定型文だけにする', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = new DrizzleQueryError('update users', ['secret-value'], new Error('pg error'));
    const { res, json } = run(err);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret-value');
    expect(json.mock.calls[0][0].error).toBe('Internal server error');
    expect(json.mock.calls[0][0].stack).toBeUndefined();
  });

  it('クエリ以外の失敗はこれまでどおりログに出す', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { json } = run(new Error('other failure'));
    expect(JSON.stringify(log.mock.calls)).toContain('other failure');
    expect(json.mock.calls[0][0].error).toBe('other failure');
  });
});
