import { describe, it, expect } from 'vitest';
import {
  expectedSchema, diffSchema, formatDriftReport, hasBlockingDrift,
  readActualSchema, auditSchemaDrift, shouldBlockStartup, blockingDriftMessage,
  type TableColumns, type SchemaDrift,
} from '../schemaAudit.js';

const expected: TableColumns[] = [
  { table: 'user_profiles', columns: ['user_id', 'settings', 'reminder_at'] },
  { table: 'projects', columns: ['id', 'title'] },
];

describe('expectedSchema', () => {
  it('テーブルの定義から列の一覧を読み取る', () => {
    const tables = expectedSchema();
    const meetings = tables.find((t) => t.table === 'meetings');
    expect(meetings).toBeDefined();
    expect(meetings!.columns).toEqual(expect.arrayContaining(['id', 'user_id', 'title']));
    expect(tables.length).toBeGreaterThanOrEqual(20);
  });
});

describe('diffSchema', () => {
  it('一致していれば差分は空になる', () => {
    const drift = diffSchema(expected, [
      { table: 'user_profiles', columns: ['user_id', 'settings', 'reminder_at'] },
      { table: 'projects', columns: ['id', 'title'] },
    ]);
    expect(drift).toEqual({ missingTables: [], missingColumns: [], extraColumns: [] });
    expect(hasBlockingDrift(drift)).toBe(false);
  });

  it('データベースに無い列を挙げる', () => {
    const drift = diffSchema(expected, [
      { table: 'user_profiles', columns: ['user_id', 'settings'] },
      { table: 'projects', columns: ['id', 'title'] },
    ]);
    expect(drift.missingColumns).toEqual([{ table: 'user_profiles', columns: ['reminder_at'] }]);
    expect(hasBlockingDrift(drift)).toBe(true);
  });

  it('データベースに無いテーブルを挙げ、その列は別に挙げない', () => {
    const drift = diffSchema(expected, [{ table: 'projects', columns: ['id', 'title'] }]);
    expect(drift.missingTables).toEqual(['user_profiles']);
    expect(drift.missingColumns).toEqual([]);
  });

  it('データベースにだけある列も挙げ、起動は止めない', () => {
    const drift = diffSchema(expected, [
      { table: 'user_profiles', columns: ['user_id', 'settings', 'reminder_at', 'old_column'] },
      { table: 'projects', columns: ['id', 'title'] },
    ]);
    expect(drift.extraColumns).toEqual([{ table: 'user_profiles', columns: ['old_column'] }]);
    expect(hasBlockingDrift(drift)).toBe(false);
  });

  it('定義に無いテーブルは比べない', () => {
    const drift = diffSchema(expected, [
      { table: 'user_profiles', columns: ['user_id', 'settings', 'reminder_at'] },
      { table: 'projects', columns: ['id', 'title'] },
      { table: 'drizzle_migrations', columns: ['hash'] },
    ]);
    expect(drift).toEqual({ missingTables: [], missingColumns: [], extraColumns: [] });
  });
});

describe('formatDriftReport', () => {
  it('差分が無ければ 1 行だけ返す', () => {
    const lines = formatDriftReport({ missingTables: [], missingColumns: [], extraColumns: [] });
    expect(lines).toEqual(['[DB:audit] schema.ts と実DBは一致（ズレなし）']);
  });

  it('件数と、足りないテーブル・列と余分な列をすべて挙げる', () => {
    const lines = formatDriftReport({
      missingTables: ['archive_x'],
      missingColumns: [{ table: 'user_profiles', columns: ['a', 'b'] }],
      extraColumns: [{ table: 'users', columns: ['old'] }],
    });
    expect(lines[0]).toContain('欠落テーブル1件');
    expect(lines[0]).toContain('欠落列2件');
    expect(lines[0]).toContain('余剰列1件');
    expect(lines.join('\n')).toContain('欠落列: user_profiles → a, b');
    expect(lines.join('\n')).toContain('欠落テーブル: archive_x');
    expect(lines.join('\n')).toContain('余剰列（DBにのみ存在）: users → old');
  });
});

describe('readActualSchema / auditSchemaDrift', () => {
  const client = (rows: Array<{ table_name: string; column_name: string }>) => ({
    query: async () => ({ rows }),
  });

  it('列の情報の行をテーブルごとにまとめる', async () => {
    const actual = await readActualSchema(client([
      { table_name: 'projects', column_name: 'id' },
      { table_name: 'projects', column_name: 'title' },
      { table_name: 'users', column_name: 'id' },
    ]));
    expect(actual).toEqual([
      { table: 'projects', columns: ['id', 'title'] },
      { table: 'users', columns: ['id'] },
    ]);
  });

  it('結果をログに出す', async () => {
    const lines: string[] = [];
    await auditSchemaDrift(client([]), (l) => lines.push(l));
    expect(lines.join('\n')).toContain('[DB:audit]');
  });

  it('読み取りに失敗したら null を返し、例外は投げない', async () => {
    const lines: string[] = [];
    const broken = { query: async () => { throw new Error('DB down'); } };
    const drift = await auditSchemaDrift(broken, (l) => lines.push(l));
    expect(drift).toBeNull();
    expect(lines.join('\n')).toContain('検査に失敗（起動は続行）');
  });
});

const clean: SchemaDrift = { missingTables: [], missingColumns: [], extraColumns: [] };

describe('shouldBlockStartup', () => {
  it('差分が無ければ止めない', () => {
    expect(shouldBlockStartup(clean, {})).toBe(false);
  });

  it('足りない列があれば止める', () => {
    expect(shouldBlockStartup(
      { ...clean, missingColumns: [{ table: 'user_profiles', columns: ['reminder_at'] }] },
      {},
    )).toBe(true);
  });

  it('足りないテーブルがあれば止める', () => {
    expect(shouldBlockStartup({ ...clean, missingTables: ['archive_x'] }, {})).toBe(true);
  });

  it('余分な列だけなら止めない', () => {
    expect(shouldBlockStartup(
      { ...clean, extraColumns: [{ table: 'users', columns: ['old'] }] },
      {},
    )).toBe(false);
  });

  it('結果が null なら止めない', () => {
    expect(shouldBlockStartup(null, {})).toBe(false);
  });

  it('設定で false を指定すると止めない', () => {
    const drift = { ...clean, missingTables: ['archive_x'] };
    expect(shouldBlockStartup(drift, { SCHEMA_AUDIT_ENFORCE: 'false' })).toBe(false);
    expect(shouldBlockStartup(drift, { SCHEMA_AUDIT_ENFORCE: 'true' })).toBe(true);
    expect(shouldBlockStartup(drift, {})).toBe(true);
  });
});

describe('blockingDriftMessage', () => {
  const lines = blockingDriftMessage({
    ...clean, missingColumns: [{ table: 'user_profiles', columns: ['a'] }],
  });

  it('直し方と足りない場所を含める', () => {
    const text = lines.join('\n');
    expect(text).toContain('起動を中止します');
    expect(text).toContain('ADD COLUMN IF NOT EXISTS');
    expect(text).toContain('ensureTables');
    expect(text).toContain('欠落列: user_profiles → a');
  });

  it('止めないための設定も含める', () => {
    expect(lines.join('\n')).toContain('SCHEMA_AUDIT_ENFORCE=false');
  });
});
