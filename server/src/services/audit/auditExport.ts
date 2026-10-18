import crypto from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { pool } from '../../db/index.js';
import { AUDIT_APP_NAME } from './audit.js';

const DAY_MS = 24 * 3600_000;
const MAX_DAYS_PER_RUN = 60;
const ADVISORY_LOCK_KEY = 0x4155_4449;

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export function r2ConfigFromEnv(env: Record<string, string | undefined> = process.env): R2Config | null {
  const accountId = env.AUDIT_R2_ACCOUNT_ID?.trim();
  const accessKeyId = env.AUDIT_R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.AUDIT_R2_SECRET_ACCESS_KEY?.trim();
  const bucket = env.AUDIT_R2_BUCKET?.trim();
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null;
  return { accountId, accessKeyId, secretAccessKey, bucket };
}

export function retentionDaysFromEnv(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.AUDIT_DB_RETENTION_DAYS);
  return Number.isFinite(n) && n >= 365 ? Math.floor(n) : 400;
}

export function auditEnvName(env: Record<string, string | undefined> = process.env): string {
  const raw = (env.AUDIT_R2_ENV || '').trim().toLowerCase();
  const safe = raw.replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return safe || 'local';
}

export function objectKeyForDay(day: string, app = AUDIT_APP_NAME, envName = auditEnvName()): string {
  const [y, m, d] = day.split('-');
  return `audit/${app}/${envName}/${y}/${m}/${d}.jsonl.gz`;
}

export function candidateDays(now: Date, earliest: Date | null): string[] {
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const start = earliest
    ? Date.UTC(earliest.getUTCFullYear(), earliest.getUTCMonth(), earliest.getUTCDate())
    : todayUtc - DAY_MS;
  const days: string[] = [];
  for (let t = start; t < todayUtc; t += DAY_MS) days.push(new Date(t).toISOString().slice(0, 10));
  return days;
}

export function toJsonLines(rows: Array<Record<string, unknown>>): string {
  return rows
    .map((r) => JSON.stringify({ ...r, ts: r.ts instanceof Date ? r.ts.toISOString() : r.ts }))
    .join('\n') + (rows.length ? '\n' : '');
}

type PutFn = (key: string, body: Buffer, sha256: string) => Promise<'created' | 'exists'>;

async function makeR2Put(cfg: R2Config): Promise<PutFn> {
  const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${cfg.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
  });
  return async (key, body, sha256) => {
    try {
      await client.send(new PutObjectCommand({
        Bucket: cfg.bucket,
        Key: key,
        Body: body,
        ContentType: 'application/x-ndjson',
        ContentEncoding: 'gzip',
        IfNoneMatch: '*',
        Metadata: { sha256 },
      }));
      return 'created';
    } catch (err) {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (e?.$metadata?.httpStatusCode === 412 || e?.name === 'PreconditionFailed') return 'exists';
      throw err;
    }
  };
}

export interface ExportResult {
  exported: string[];
  skipped: string[];
  retentionDeleted: number;
}

export async function runAuditExportOnce(opts: { now?: Date; put?: PutFn; retentionDays?: number } = {}): Promise<ExportResult | null> {
  const now = opts.now ?? new Date();
  const result: ExportResult = { exported: [], skipped: [], retentionDeleted: 0 };
  const cfg = r2ConfigFromEnv();
  const put = opts.put ?? (cfg ? await makeR2Put(cfg) : null);

  const client = await pool.connect();
  try {
    const { rows: lockRows } = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [ADVISORY_LOCK_KEY]);
    if (!lockRows[0]?.ok) return null;
    try {
      if (put) {
        const { rows: minRows } = await client.query<{ min: Date | null }>('SELECT min(ts) AS min FROM audit_log');
        const days = candidateDays(now, minRows[0]?.min ?? null);
        const { rows: doneRows } = await client.query<{ day: string }>(
          `SELECT day::text AS day FROM audit_export_state WHERE day >= $1::date`,
          [days[0] ?? now.toISOString().slice(0, 10)],
        );
        const done = new Set(doneRows.map((r) => r.day));
        const pending = days.filter((d) => !done.has(d)).slice(0, MAX_DAYS_PER_RUN);
        for (const day of pending) {
          const from = new Date(`${day}T00:00:00.000Z`);
          const to = new Date(from.getTime() + DAY_MS);
          const { rows } = await client.query(
            `SELECT id, ts, app, event, result, actor_id, actor_email, actor_role, auth_method, tenant_id,
                    target_type, target_id, host(ip) AS ip, user_agent, request_id, detail
               FROM audit_log WHERE ts >= $1 AND ts < $2 ORDER BY id`,
            [from, to],
          );
          const body = gzipSync(Buffer.from(toJsonLines(rows), 'utf8'));
          const sha256 = crypto.createHash('sha256').update(body).digest('hex');
          const key = objectKeyForDay(day);
          const outcome = await put(key, body, sha256);
          await client.query(
            `INSERT INTO audit_export_state (day, object_key, row_count, sha256)
             VALUES ($1::date, $2, $3, $4) ON CONFLICT (day) DO NOTHING`,
            [day, key, rows.length, outcome === 'created' ? sha256 : null],
          );
          (outcome === 'created' ? result.exported : result.skipped).push(day);
          console.log(JSON.stringify({ type: 'audit_export', day, key, rows: rows.length, outcome }));
        }
      }

      const retentionDays = opts.retentionDays ?? retentionDaysFromEnv();
      await client.query('BEGIN');
      try {
        await client.query(`SET LOCAL app.audit_retention = 'on'`);
        const del = await client.query(
          `DELETE FROM audit_log a
            WHERE a.ts < now() - make_interval(days => $1::int)
              AND EXISTS (SELECT 1 FROM audit_export_state s WHERE s.day = (a.ts AT TIME ZONE 'UTC')::date)`,
          [retentionDays],
        );
        await client.query('COMMIT');
        result.retentionDeleted = del.rowCount ?? 0;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }
      if (result.retentionDeleted > 0) {
        console.log(JSON.stringify({ type: 'audit_retention', deleted: result.retentionDeleted, retentionDays }));
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => {});
    }
  } finally {
    client.release();
  }
  return result;
}

let timer: NodeJS.Timeout | null = null;
let startupTimer: NodeJS.Timeout | null = null;

export function startAuditExportScheduler(): void {
  if (timer || startupTimer) return;
  if (!r2ConfigFromEnv()) {
    console.warn('[audit-export] AUDIT_R2_* が未設定のため、監査ログの R2 退避は無効です（DB 内の audit_log には記録されます）');
  }
  const run = () => {
    runAuditExportOnce().catch((err) =>
      console.error('[audit-export] 監査ログの退避に失敗しました（次回再試行）:', err instanceof Error ? err.message : err),
    );
  };
  startupTimer = setTimeout(run, 60_000);
  startupTimer.unref?.();
  timer = setInterval(run, DAY_MS);
  timer.unref?.();
}

export function stopAuditExportScheduler(): void {
  if (startupTimer) clearTimeout(startupTimer);
  if (timer) clearInterval(timer);
  startupTimer = null;
  timer = null;
}
