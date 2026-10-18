import { is } from 'drizzle-orm';
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core';
import * as schema from './schema.js';

export interface TableColumns { table: string; columns: string[] }

export interface SchemaDrift {
  missingTables: string[];
  missingColumns: Array<{ table: string; columns: string[] }>;
  extraColumns: Array<{ table: string; columns: string[] }>;
}

export function expectedSchema(): TableColumns[] {
  return (Object.values(schema) as unknown[])
    .filter((v): v is PgTable => is(v, PgTable))
    .map((t) => {
      const cfg = getTableConfig(t);
      return { table: cfg.name, columns: cfg.columns.map((c) => c.name) };
    })
    .sort((a, b) => a.table.localeCompare(b.table));
}

export function diffSchema(expected: TableColumns[], actual: TableColumns[]): SchemaDrift {
  const actualByTable = new Map(actual.map((t) => [t.table, new Set(t.columns)]));
  const drift: SchemaDrift = { missingTables: [], missingColumns: [], extraColumns: [] };

  for (const { table, columns } of expected) {
    const have = actualByTable.get(table);
    if (!have) {
      drift.missingTables.push(table);
      continue;
    }
    const missing = columns.filter((c) => !have.has(c));
    if (missing.length > 0) drift.missingColumns.push({ table, columns: missing });

    const want = new Set(columns);
    const extra = [...have].filter((c) => !want.has(c)).sort();
    if (extra.length > 0) drift.extraColumns.push({ table, columns: extra });
  }
  return drift;
}

export function hasBlockingDrift(drift: SchemaDrift): boolean {
  return drift.missingTables.length > 0 || drift.missingColumns.length > 0;
}

export function formatDriftReport(drift: SchemaDrift): string[] {
  const lines: string[] = [];
  const missingCols = drift.missingColumns.reduce((n, t) => n + t.columns.length, 0);
  const extraCols = drift.extraColumns.reduce((n, t) => n + t.columns.length, 0);

  if (!hasBlockingDrift(drift) && extraCols === 0) {
    return ['[DB:audit] schema.ts と実DBは一致（ズレなし）'];
  }
  lines.push(
    `[DB:audit] ズレを検出: 欠落テーブル${drift.missingTables.length}件 / `
    + `欠落列${missingCols}件 / 余剰列${extraCols}件`,
  );
  for (const t of drift.missingTables) {
    lines.push(`[DB:audit] 欠落テーブル: ${t}（このテーブルを読む処理は必ず失敗する）`);
  }
  for (const { table, columns } of drift.missingColumns) {
    lines.push(`[DB:audit] 欠落列: ${table} → ${columns.join(', ')}`);
  }
  for (const { table, columns } of drift.extraColumns) {
    lines.push(`[DB:audit] 余剰列（DBにのみ存在）: ${table} → ${columns.join(', ')}`);
  }
  return lines;
}

export function shouldBlockStartup(
  drift: SchemaDrift | null,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (drift === null) return false;
  if (env.SCHEMA_AUDIT_ENFORCE === 'false') return false;
  return hasBlockingDrift(drift);
}

export function blockingDriftMessage(drift: SchemaDrift): string[] {
  return [
    '[DB:audit] 起動を中止します: アプリが使う列がデータベースにありません',
    '[DB:audit] 同じ版のアプリで作ったデータベースか確かめてください。'
      + 'コードを変えた場合は、db/index.ts の ensureTables に ALTER TABLE ... ADD COLUMN IF NOT EXISTS を足してください',
    '[DB:audit] 確認のために一時的に起動したいときは SCHEMA_AUDIT_ENFORCE=false を設定できます（列が足りないままでは一部の機能が動きません）',
    ...formatDriftReport(drift),
  ];
}

type QueryableClient = {
  query: (sql: string) => Promise<{ rows: Array<{ table_name: string; column_name: string }> }>;
};

export async function readActualSchema(client: QueryableClient): Promise<TableColumns[]> {
  const { rows } = await client.query(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, ordinal_position
  `);
  const byTable = new Map<string, string[]>();
  for (const r of rows) {
    const list = byTable.get(r.table_name) ?? [];
    list.push(r.column_name);
    byTable.set(r.table_name, list);
  }
  return [...byTable].map(([table, columns]) => ({ table, columns }));
}

export async function auditSchemaDrift(
  client: QueryableClient,
  log: (line: string) => void = (l) => console.log(l),
): Promise<SchemaDrift | null> {
  try {
    const drift = diffSchema(expectedSchema(), await readActualSchema(client));
    for (const line of formatDriftReport(drift)) log(line);
    return drift;
  } catch (err) {
    log(`[DB:audit] 検査に失敗（起動は続行）: ${String((err as Error).message ?? err).slice(0, 200)}`);
    return null;
  }
}
