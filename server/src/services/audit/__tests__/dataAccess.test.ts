import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { __setAuditWriterForTest, type AuditRecord } from '../audit.js';
import {
  classifyDataAccess,
  kindFromRest,
  shouldRecord,
  dataAccessAuditMiddleware,
  __resetDataAccessDedupeForTest,
  DATA_ACCESS_DEDUPE_MS,
} from '../dataAccess.js';

beforeEach(() => __resetDataAccessDedupeForTest());
afterEach(() => __setAuditWriterForTest(null));

describe('kindFromRest', () => {
  it('パスの数字の部分を :id に置き換えて種類を返す', () => {
    expect(kindFromRest(undefined)).toBe('detail');
    expect(kindFromRest('/')).toBe('detail');
    expect(kindFromRest('/transcripts')).toBe('transcripts');
    expect(kindFromRest('/grareco/12/image')).toBe('grareco/:id/image');
    expect(kindFromRest('/participant-images/7/image/')).toBe('participant-images/:id/image');
  });
});

describe('classifyDataAccess', () => {
  it('会議のデータを読む要求を meeting.view に分類する', () => {
    expect(classifyDataAccess('GET', '/api/meetings/5')).toEqual({ event: 'meeting.view', meetingId: 5, kind: 'detail', via: 'web' });
    expect(classifyDataAccess('GET', '/api/meetings/5/transcripts')).toMatchObject({ event: 'meeting.view', kind: 'transcripts' });
    expect(classifyDataAccess('GET', '/api/meetings/5/participant-images/9/image')).toMatchObject({ kind: 'participant-images/:id/image' });
    expect(classifyDataAccess('GET', '/api/summaries/5')).toMatchObject({ event: 'meeting.view', meetingId: 5, kind: 'summaries' });
    expect(classifyDataAccess('GET', '/api/analyses/5')).toMatchObject({ event: 'meeting.view', meetingId: 5, kind: 'analyses' });
    expect(classifyDataAccess('GET', '/api/ext/meetings/5/observations')).toMatchObject({ event: 'meeting.view', kind: 'observations', via: 'ext' });
    expect(classifyDataAccess('POST', '/api/agent/meetings/5/chat')).toMatchObject({ event: 'meeting.view', meetingId: 5, kind: 'assistant-chat' });
  });

  it('一覧と検索の要求を meeting.list と meeting.search に分類する', () => {
    expect(classifyDataAccess('GET', '/api/meetings')).toMatchObject({ event: 'meeting.list', via: 'web' });
    expect(classifyDataAccess('GET', '/api/ext/meetings')).toMatchObject({ event: 'meeting.list', via: 'ext' });
    expect(classifyDataAccess('GET', '/api/grareco/search')).toMatchObject({ event: 'meeting.search' });
  });

  it('自動で繰り返し呼ばれる要求は null を返す', () => {
    expect(classifyDataAccess('GET', '/api/meetings/5/partial-transcript')).toBeNull();
    expect(classifyDataAccess('GET', '/api/meetings/5/share')).toBeNull();
  });

  it('書き換えの要求を meeting.update に分類し、対象外のものは null を返す', () => {
    expect(classifyDataAccess('PUT', '/api/meetings/5/participants')).toEqual({
      event: 'meeting.update', meetingId: 5, kind: 'participants', via: 'web', method: 'PUT',
    });
    expect(classifyDataAccess('PATCH', '/api/meetings/5')).toMatchObject({ event: 'meeting.update', kind: 'detail', method: 'PATCH' });
    expect(classifyDataAccess('PATCH', '/api/ext/meetings/5')).toMatchObject({ event: 'meeting.update', via: 'ext' });
    expect(classifyDataAccess('POST', '/api/meetings')).toMatchObject({ event: 'meeting.update', kind: 'create' });
    expect(classifyDataAccess('DELETE', '/api/analyses/item/3')).toMatchObject({ event: 'meeting.update', kind: 'analysis-item' });
    expect(classifyDataAccess('DELETE', '/api/meetings/5')).toBeNull();
    expect(classifyDataAccess('POST', '/api/meetings/5/share')).toBeNull();
    expect(classifyDataAccess('PATCH', '/api/meetings/5/share')).toBeNull();
  });

  it('会議のデータに関係しない要求は null を返す', () => {
    expect(classifyDataAccess('GET', '/api/auth/me')).toBeNull();
    expect(classifyDataAccess('GET', '/api/agent/availability')).toBeNull();
    expect(classifyDataAccess('GET', '/api/share/abc/meta')).toBeNull();
  });
});

describe('shouldRecord', () => {
  it('同じキーは一定時間内に 1 回だけ記録し、時間を過ぎたら再び記録する', () => {
    const t0 = 1_000_000;
    expect(shouldRecord('k', t0)).toBe(true);
    expect(shouldRecord('k', t0 + 1000)).toBe(false);
    expect(shouldRecord('k2', t0 + 1000)).toBe(true);
    expect(shouldRecord('k', t0 + DATA_ACCESS_DEDUPE_MS)).toBe(true);
  });
});

describe('dataAccessAuditMiddleware', () => {
  async function run(requests: Array<{ path: string; method?: string; status?: number; userId?: number | null; ip?: string }>): Promise<AuditRecord[]> {
    const recs: AuditRecord[] = [];
    __setAuditWriterForTest(async (r) => { recs.push(r); });
    const app = express();
    app.set('trust proxy', 1);
    app.use(dataAccessAuditMiddleware);
    app.use((req, res) => {
      const userId = req.header('x-test-user');
      if (userId) res.locals.auth = { userId: Number(userId), email: 'a@example.com', displayName: null, method: 'session' };
      res.status(Number(req.header('x-test-status') ?? 200)).json({ body: '新商品の企画会議の発言' });
    });
    const server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    try {
      for (const r of requests) {
        const headers: Record<string, string> = { 'x-test-status': String(r.status ?? 200) };
        if (r.userId !== null) headers['x-test-user'] = String(r.userId ?? 16);
        if (r.ip) headers['x-forwarded-for'] = r.ip;
        await fetch(`http://127.0.0.1:${port}${r.path}`, { method: r.method ?? 'GET', headers });
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      server.close();
    }
    return recs;
  }

  it('読み取りを 1 件記録し、応答の本文は含めない', async () => {
    const recs = await run([{ path: '/api/meetings/5/transcripts?since=0', ip: '203.0.113.7' }]);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({
      event: 'meeting.view', result: 'success', actorId: '16', targetType: 'meeting', targetId: '5', ip: '203.0.113.7',
      detail: { kind: 'transcripts', via: 'web' },
    });
    expect(JSON.stringify(recs[0])).not.toContain('新商品の企画会議の発言');
  });

  it('利用者・会議・種類・IP がすべて同じ要求は 1 件にまとめ、IP が違えば別に記録する', async () => {
    const recs = await run([
      { path: '/api/meetings/5/transcripts', ip: '203.0.113.7' },
      { path: '/api/meetings/5/transcripts', ip: '203.0.113.7' },
      { path: '/api/meetings/5/participants', ip: '203.0.113.7' },
      { path: '/api/meetings/5/transcripts', ip: '198.51.100.9' },
    ]);
    expect(recs.map((r) => `${r.detail && (r.detail as { kind: string }).kind}@${r.ip}`)).toEqual([
      'transcripts@203.0.113.7', 'participants@203.0.113.7', 'transcripts@198.51.100.9',
    ]);
  });

  it('ログインしていない要求・エラーの応答・対象外のパスは記録しない', async () => {
    const recs = await run([
      { path: '/api/meetings/5', userId: null },
      { path: '/api/meetings/6', status: 404 },
      { path: '/api/meetings/7', status: 403 },
      { path: '/api/meetings/5/partial-transcript' },
      { path: '/api/auth/me' },
    ]);
    expect(recs).toHaveLength(0);
  });

  it('304 の応答も読み取りとして記録する', async () => {
    const recs = await run([{ path: '/api/meetings/8/memos', status: 304 }]);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ event: 'meeting.view', targetId: '8' });
  });

  it('書き換えの要求はメソッドと種類を記録する', async () => {
    const recs = await run([{ path: '/api/meetings/5/participants', method: 'PUT' }]);
    expect(recs[0]).toMatchObject({ event: 'meeting.update', targetId: '5', detail: { kind: 'participants', via: 'web', method: 'PUT' } });
  });
});
