import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ queries: [] as string[], meetingCount: 0 }));

vi.mock('../../db/schema.js', () => ({
  meetings: { _name: 'meetings', id: 'id', userId: 'userId', startedAt: 'startedAt' },
  transcripts: { _name: 'transcripts', meetingId: 'meetingId', isFinal: 'isFinal', startTime: 'startTime' },
  structuredSummaries: { _name: 'structuredSummaries', meetingId: 'meetingId', content: 'content', updatedAt: 'updatedAt' },
  analyses: { _name: 'analyses', meetingId: 'meetingId', content: 'content', type: 'type', createdAt: 'createdAt' },
}));

vi.mock('drizzle-orm', () => ({
  and: (...a: unknown[]) => ({ and: a }),
  eq: (a: unknown, b: unknown) => ({ eq: [a, b] }),
  inArray: (a: unknown, ids: number[]) => ({ inArray: ids }),
  asc: (a: unknown) => a,
  desc: (a: unknown) => a,
}));

function findIds(cond: any): number[] {
  if (!cond) return [];
  if (cond.inArray) return cond.inArray;
  if (cond.and) return cond.and.flatMap(findIds);
  return [];
}

vi.mock('../../db/index.js', () => ({
  db: {
    select: () => ({
      from: (table: { _name: string }) => ({
        where: (cond: unknown) => ({
          orderBy: async () => {
            state.queries.push(table._name);
            if (table._name === 'meetings') {
              return Array.from({ length: state.meetingCount }, (_, i) => ({
                id: i + 1, title: `会議${i + 1}`, startedAt: null, participants: null, ngKeywords: null,
              }));
            }
            const ids = findIds(cond);
            if (table._name === 'transcripts') {
              return ids.map((id) => ({ meetingId: id, content: `発言${id}`, speaker: null, startTime: 0, recordingMs: 0, isFinal: true }));
            }
            if (table._name === 'structuredSummaries') {
              return ids.flatMap((id) => [{ meetingId: id, content: `新しい要約${id}` }, { meetingId: id, content: `古い要約${id}` }]);
            }
            return [];
          },
        }),
      }),
    }),
  },
}));

import { buildAccountExportZip, EXPORT_BATCH } from '../accountExportService.js';

describe('データの一括ダウンロード', () => {
  beforeEach(() => {
    state.queries.length = 0;
  });

  it('会議を 1 件ずつではなく、まとめて読む', async () => {
    state.meetingCount = EXPORT_BATCH * 2 + 50;
    const zip = await buildAccountExportZip(1);
    expect(zip.length).toBeGreaterThan(0);
    expect(state.queries.filter((q) => q === 'meetings')).toHaveLength(1);
    expect(state.queries.filter((q) => q === 'transcripts')).toHaveLength(3);
    expect(state.queries).toHaveLength(1 + 3 * 3);
  });

  it('会議が無いときは、会議の中身を読みに行かない', async () => {
    state.meetingCount = 0;
    const zip = await buildAccountExportZip(1);
    expect(zip.length).toBeGreaterThan(0);
    expect(state.queries).toEqual(['meetings']);
  });
});
