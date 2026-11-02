import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const query = vi.fn();
const release = vi.fn();

vi.mock('../../../db/index.js', () => ({
  pool: { connect: async () => ({ query, release }) },
  db: {},
}));

import { runAuditExportOnce } from '../auditExport.js';

const NOW = new Date('2026-01-02T03:00:00.000Z');

function answerQueries() {
  query.mockImplementation(async (sql: string) => {
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ ok: true }] };
    if (sql.includes('min(ts)')) return { rows: [{ min: new Date('2026-01-01T01:00:00.000Z') }] };
    if (sql.includes('FROM audit_export_state')) return { rows: [] };
    if (sql.includes('FROM audit_log WHERE')) return { rows: [{ id: 1, ts: new Date('2026-01-01T01:00:00.000Z') }] };
    return { rows: [], rowCount: 0 };
  });
}

describe('操作の記録の書き出し', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    query.mockReset();
    answerQueries();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('同じ場所に既にあって保存しなかった日は、警告を出して今までどおり進む', async () => {
    const put = vi.fn().mockResolvedValue('exists');
    const result = await runAuditExportOnce({ now: NOW, put });
    expect(result?.skipped).toEqual(['2026-01-01']);
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(String(warn.mock.calls[0][0]));
    expect(logged).toMatchObject({ type: 'audit_export_not_saved', day: '2026-01-01', rows: 1 });
    expect(logged.message).toContain('AUDIT_R2_ENV');
    expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO audit_export_state'))).toBe(true);
  });

  it('保存できた日は、警告を出さない', async () => {
    const put = vi.fn().mockResolvedValue('created');
    const result = await runAuditExportOnce({ now: NOW, put });
    expect(result?.exported).toEqual(['2026-01-01']);
    expect(warn).not.toHaveBeenCalled();
  });
});
