import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { DB_FAILURE_MESSAGE } from '../../db/queryError.js';

const runAgentTurnStreaming = vi.fn();

vi.mock('../../db/index.js', () => ({
  db: { select: () => ({ from: () => ({ where: async () => [{ id: 1 }] }) }) },
  pool: {},
}));
vi.mock('../../middleware/auth.js', () => ({
  requireAuth: (_req: unknown, res: { locals: Record<string, unknown> }, next: () => void) => {
    res.locals.auth = { userId: 7, method: 'session' };
    next();
  },
}));
vi.mock('../../middleware/rateLimit.js', () => {
  const pass = (_req: unknown, _res: unknown, next: () => void) => next();
  return { meetingAssistantLimiter: pass, imageAnalysisLimiter: pass };
});
vi.mock('../agent/index.js', () => ({
  runAgentTurn: vi.fn(),
  runAgentTurnStreaming: (...args: unknown[]) => runAgentTurnStreaming(...args),
  isAgentEnabled: () => true,
}));
vi.mock('../agent/imageAttachService.js', () => ({ attachAndAnalyzeImage: vi.fn() }));

let server: Server;
let url: string;

beforeAll(async () => {
  const { default: agentRouter } = await import('../../routes/agent.js');
  const app = express();
  app.use(express.json());
  app.use(agentRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function streamBody(): Promise<string> {
  const res = await fetch(`${url}/meetings/1/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
  });
  return res.text();
}

describe('会話の失敗を画面へ送る文', () => {
  beforeEach(() => {
    runAgentTurnStreaming.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('データベースの失敗は固定の文にする', async () => {
    runAgentTurnStreaming.mockRejectedValue(
      new DrizzleQueryError('select "secret_column" from "users"', ['secret-value'], new Error('cause-value')),
    );
    const body = await streamBody();
    expect(body).toContain(JSON.stringify({ type: 'error', error: DB_FAILURE_MESSAGE }));
    expect(body).not.toContain('secret_column');
    expect(body).not.toContain('secret-value');
    expect(body).not.toContain('cause-value');
  });

  it('ほかの失敗は今の文のまま送る', async () => {
    runAgentTurnStreaming.mockRejectedValue(new Error('upstream_failed'));
    const body = await streamBody();
    expect(body).toContain(JSON.stringify({ type: 'error', error: 'upstream_failed' }));
  });
});
