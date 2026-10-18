import express, { type RequestHandler } from 'express';

export const DEFAULT_BODY_LIMIT = '1mb';

export const IMAGE_BODY_LIMIT = '50mb';

export const LARGE_BODY_ROUTES: ReadonlyArray<{ method: string; pattern: RegExp }> = [
  { method: 'POST', pattern: /^\/api\/meetings\/[^/]+\/images\/?$/i },
  { method: 'POST', pattern: /^\/api\/meetings\/[^/]+\/participant-images\/?$/i },
  { method: 'POST', pattern: /^\/api\/meetings\/[^/]+\/analyze\/?$/i },
  { method: 'POST', pattern: /^\/api\/agent\/meetings\/[^/]+\/attach-image\/?$/i },
  { method: 'POST', pattern: /^\/api\/ext\/meetings\/[^/]+\/images\/?$/i },
  { method: 'POST', pattern: /^\/api\/ext\/meetings\/[^/]+\/observations\/?$/i },
];

export function isLargeBodyRoute(method: string, path: string): boolean {
  return LARGE_BODY_ROUTES.some((r) => r.method === method && r.pattern.test(path));
}

export function defaultBodyParsers(): RequestHandler[] {
  const json = express.json({ limit: DEFAULT_BODY_LIMIT });
  const urlencoded = express.urlencoded({ extended: true, limit: DEFAULT_BODY_LIMIT });
  const skipLarge = (parser: RequestHandler): RequestHandler => (req, res, next) => {
    if (isLargeBodyRoute(req.method, req.path)) return next();
    return parser(req, res, next);
  };
  return [skipLarge(json), skipLarge(urlencoded)];
}

export const imageJsonBody: RequestHandler = express.json({ limit: IMAGE_BODY_LIMIT });
