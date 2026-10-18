import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { ZodError } from 'zod';
import { AppError, BadRequestError } from '../errors/AppError.js';

function sanitizeBody(body: unknown): unknown {
  if (!body || typeof body !== 'object') return body;
  const clone: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  const redactKeys = [
    'password',
    'currentPassword',
    'newPassword',
    'token',
    'apiToken',
    'credential',
    'secret',
    'refreshToken',
    'accessToken',
    'authorization',
  ];
  for (const key of redactKeys) {
    if (key in clone) clone[key] = '[REDACTED]';
  }
  const bigFields = ['audioData', 'imageData', 'image', 'audio', 'data', 'content', 'text'];
  for (const key of bigFields) {
    const v = clone[key];
    if (typeof v === 'string' && v.length > 200) {
      clone[key] = `[${v.length} chars omitted]`;
    }
  }
  for (const key of ['attachments', 'messages', 'images', 'files']) {
    const v = clone[key];
    if (Array.isArray(v)) clone[key] = `[${v.length} items omitted]`;
  }
  return clone;
}

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  const requestId = req.requestId ?? crypto.randomUUID();
  const userId = (req as Request & { session?: { userId?: number } }).session?.userId;
  const isProd = process.env.NODE_ENV === 'production';

  if (err instanceof ZodError) {
    const firstIssue = err.issues[0];
    const publicMessage = firstIssue?.message || '入力内容が不正です';
    const appErr = new BadRequestError(publicMessage);
    console.warn(`[${requestId}] ValidationError: ${publicMessage}`, {
      path: req.path,
      method: req.method,
      userId,
      issues: err.issues,
    });
    res.status(appErr.statusCode).json({
      error: appErr.publicMessage,
      requestId,
    });
    return;
  }

  const parserErr = err as Error & { type?: unknown; status?: unknown };
  if (typeof parserErr.type === 'string' && typeof parserErr.status === 'number' && parserErr.status >= 400 && parserErr.status < 500) {
    const tooLarge = parserErr.type === 'entity.too.large';
    console.warn(`[${requestId}] BodyParserError: ${parserErr.type}`, { path: req.path, method: req.method, userId });
    res.status(parserErr.status).json({
      error: tooLarge ? 'リクエストの本文が大きすぎます' : 'リクエストの本文を読み取れませんでした',
      requestId,
    });
    return;
  }

  if (err instanceof AppError) {
    console.warn(`[${requestId}] AppError: ${err.publicMessage}`, {
      statusCode: err.statusCode,
      path: req.path,
      method: req.method,
      userId,
    });
    res.status(err.statusCode).json({
      error: err.publicMessage,
      requestId,
    });
    return;
  }

  console.error(`[${requestId}] Unhandled error:`, {
    message: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    userId,
    body: sanitizeBody(req.body),
  });

  if (isProd) {
    res.status(500).json({
      error: 'Internal server error',
      requestId,
    });
  } else {
    res.status(500).json({
      error: err.message,
      stack: err.stack,
      requestId,
    });
  }
}
