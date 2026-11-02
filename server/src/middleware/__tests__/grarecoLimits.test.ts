import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

const selectRows = vi.fn();
const reviseGraphicRecording = vi.fn();

vi.stubEnv('NODE_ENV', 'production');

vi.mock('../../db/index.js', () => {
  const chain = { from: () => chain, where: () => selectRows() };
  return { db: { select: () => chain }, pool: {} };
});
vi.mock('../auth.js', () => ({
  requireAuth: (_req: unknown, res: { locals: Record<string, unknown> }, next: () => void) => {
    res.locals.auth = { userId: 7, method: 'session' };
    next();
  },
}));
vi.mock('../authContext.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../authContext.js')>()),
  authUserId: () => 7,
  getAuth: () => ({ userId: 7, method: 'session' }),
}));
vi.mock('../../services/geminiService.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/geminiService.js')>()),
  reviseGraphicRecording: (...args: unknown[]) => reviseGraphicRecording(...args),
}));

let server: Server;
let base: string;

beforeAll(async () => {
  const { default: meetingsRouter } = await import('../../routes/meetings.js');
  const { errorHandler } = await import('../errorHandler.js');
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/meetings', meetingsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/meetings`;
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await new Promise((resolve) => { server.close(resolve); });
});

beforeEach(() => {
  selectRows.mockReset();
});

function post(path: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function statusesFor(path: string, body: unknown, times: number) {
  const statuses: number[] = [];
  for (let i = 0; i < times; i++) statuses.push((await post(path, body)).status);
  return statuses;
}

describe('グラレコの修正の窓口', () => {
  it('2000 文字を超える指示は 400 で断り、案内の文を返す', async () => {
    selectRows.mockResolvedValue([{ id: 1, imageUrl: 'data:image/png;base64,AA==', sourceText: '本文' }]);
    const res = await post('/1/graphic-recording/1/revise', { instruction: 'あ'.repeat(2001) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('修正の指示は 2000 文字以内で入力してください');
    expect(reviseGraphicRecording).not.toHaveBeenCalled();
  });

  it('会議が違っても、利用者ごとに 10 分で 20 回までに止める', async () => {
    selectRows.mockResolvedValue([]);
    const first = await statusesFor('/1/graphic-recording/1/revise', { instruction: '直して' }, 10);
    const second = await statusesFor('/2/graphic-recording/1/revise', { instruction: '直して' }, 9);
    expect([...first, ...second].every((s) => s === 404)).toBe(true);
    const blocked = await post('/3/graphic-recording/1/revise', { instruction: '直して' });
    expect(blocked.status).toBe(429);
    expect((await blocked.json()).error).toContain('10分ほど待ってから');
  });
});

describe('グラレコの手動の作成の窓口', () => {
  it('会議が違っても、利用者ごとに 10 分で 20 回までに止める', async () => {
    selectRows.mockResolvedValue([]);
    const allowed: number[] = [];
    for (let id = 1; id <= 20; id++) {
      allowed.push(...await statusesFor(`/${id}/grareco/manual-trigger`, { type: 'reflect' }, 1));
    }
    expect(allowed.every((s) => s === 404)).toBe(true);
    const blocked = await post('/21/grareco/manual-trigger', { type: 'reflect' });
    expect(blocked.status).toBe(429);
    expect((await blocked.json()).error).toContain('10分ほど待ってから');
  });
});
