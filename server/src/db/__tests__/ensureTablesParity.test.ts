
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { is } from 'drizzle-orm';
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import * as schema from '../schema.js';

const ensureTablesSql = readFileSync(
  fileURLToPath(new URL('../index.ts', import.meta.url)),
  'utf8',
);

function allTables(): Array<{ name: string; columns: string[] }> {
  return (Object.values(schema) as unknown[])
    .filter((v): v is PgTable => is(v, PgTable))
    .map((t) => {
      const cfg = getTableConfig(t);
      return { name: cfg.name, columns: cfg.columns.map((c) => c.name) };
    });
}

describe('テーブル定義と作成処理の列の一致', () => {
  const tables = allTables();

  it('定義からテーブルの一覧を読み取れる', () => {
    const names = tables.map((t) => t.name);
    expect(names).toContain('users');
    expect(names).toContain('meetings');
    expect(tables.length).toBeGreaterThanOrEqual(20);
  });

  it.each(tables.map((t) => [t.name, t.columns] as const))(
    '%s のすべての列が作成処理に含まれる',
    (tableName, columns) => {
      const missing = columns.filter((c) => !ensureTablesSql.includes(`"${c}"`));
      expect(
        missing,
        `${tableName}: 作成処理に無い列 → ${missing.join(', ')}`,
      ).toEqual([]);
    },
  );
});
