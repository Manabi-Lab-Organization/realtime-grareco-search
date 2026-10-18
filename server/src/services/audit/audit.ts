import type { Request } from 'express';
import { pool } from '../../db/index.js';
import { getAuditContext, currentRequest } from './requestContext.js';
import { getClientIp, clipUserAgent, sanitizeDetail } from './logSafety.js';
import { getAuth } from '../../middleware/authContext.js';

export const AUDIT_APP_NAME = 'realtime-grareco-search';

export type AuditResult = 'success' | 'failure' | 'denied';

export interface AuditActor {
  id?: number | string | null;
  email?: string | null;
  role?: string | null;
  authMethod?: string | null;
}

export interface AuditOptions {
  result?: AuditResult;
  actor?: AuditActor;
  target?: { type: string; id?: number | string | null };
  tenantId?: string | null;
  detail?: Record<string, unknown>;
  strict?: boolean;
}

export interface AuditRecord {
  app: string;
  event: string;
  result: AuditResult;
  actorId: string | null;
  actorEmail: string | null;
  actorRole: string | null;
  authMethod: string | null;
  tenantId: string | null;
  targetType: string | null;
  targetId: string | null;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
  detail: unknown;
}

export function buildAuditRecord(event: string, opts: AuditOptions = {}, req?: Request): AuditRecord {
  const ctx = getAuditContext();
  const r = req ?? currentRequest();
  const auth = r ? getAuth(r) : undefined;

  const actorId = opts.actor?.id ?? auth?.userId ?? ctx?.actorId ?? null;
  const actorEmail = opts.actor?.email ?? (opts.actor?.id == null ? auth?.email : undefined) ?? null;
  const authMethod = opts.actor?.authMethod ?? (opts.actor?.id == null && auth?.method === 'token' ? 'api_token' : null);
  const actorRole =
    opts.actor?.role ??
    (authMethod === 'api_token' ? 'token' : actorId != null ? 'user' : r ? null : 'system');

  return {
    app: AUDIT_APP_NAME,
    event,
    result: opts.result ?? 'success',
    actorId: actorId != null ? String(actorId) : null,
    actorEmail: actorEmail ? String(actorEmail).slice(0, 320) : null,
    actorRole,
    authMethod,
    tenantId: opts.tenantId ?? null,
    targetType: opts.target?.type ?? null,
    targetId: opts.target?.id != null ? String(opts.target.id) : null,
    ip: r ? getClientIp(r) : null,
    userAgent: r ? clipUserAgent(r.headers?.['user-agent']) : null,
    requestId: r?.requestId ?? ctx?.requestId ?? null,
    detail: opts.detail ? sanitizeDetail(opts.detail) : null,
  };
}

type Writer = (rec: AuditRecord) => Promise<void>;

const pgWriter: Writer = async (rec) => {
  await pool.query(
    `INSERT INTO audit_log
       (app, event, result, actor_id, actor_email, actor_role, auth_method, tenant_id,
        target_type, target_id, ip, user_agent, request_id, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)`,
    [
      rec.app, rec.event, rec.result, rec.actorId, rec.actorEmail, rec.actorRole, rec.authMethod,
      rec.tenantId, rec.targetType, rec.targetId, rec.ip, rec.userAgent, rec.requestId,
      rec.detail == null ? null : JSON.stringify(rec.detail),
    ],
  );
};

let writer: Writer = pgWriter;

export function __setAuditWriterForTest(w: Writer | null): void {
  writer = w ?? pgWriter;
}

export async function audit(event: string, opts: AuditOptions = {}, req?: Request): Promise<void> {
  let rec: AuditRecord;
  try {
    rec = buildAuditRecord(event, opts, req);
  } catch (err) {
    console.error('[audit] 記録の組み立てに失敗:', event, err);
    if (opts.strict) throw err;
    return;
  }
  console.log(JSON.stringify({
    type: 'audit',
    event: rec.event,
    result: rec.result,
    actorId: rec.actorId,
    actorRole: rec.actorRole,
    authMethod: rec.authMethod,
    targetType: rec.targetType,
    targetId: rec.targetId,
    requestId: rec.requestId,
  }));
  try {
    await writer(rec);
  } catch (err) {
    console.error(JSON.stringify({
      type: 'audit_write_failed',
      event: rec.event,
      requestId: rec.requestId,
      error: err instanceof Error ? err.message : String(err),
    }));
    if (opts.strict) throw err;
  }
}

export function auditLater(event: string, opts: AuditOptions = {}, req?: Request): void {
  void audit(event, { ...opts, strict: false }, req);
}

export interface LlmCallInfo {
  feature: string;
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
  costUsd?: number | null;
  userId?: number | null;
  meetingId?: number | null;
  ok?: boolean;
  extra?: Record<string, unknown>;
}

export function auditLlmCall(info: LlmCallInfo): void {
  const detail: Record<string, unknown> = {
    feature: info.feature,
    model: info.model ?? null,
    inputTokens: info.inputTokens ?? null,
    outputTokens: info.outputTokens ?? null,
  };
  if (info.cacheReadTokens) detail.cacheReadTokens = info.cacheReadTokens;
  if (info.cacheCreationTokens) detail.cacheCreationTokens = info.cacheCreationTokens;
  if (info.costUsd != null) detail.costUsd = Math.round(info.costUsd * 1_000_000) / 1_000_000;
  if (info.extra) Object.assign(detail, info.extra);
  auditLater('llm.call', {
    result: info.ok === false ? 'failure' : 'success',
    actor: info.userId != null ? { id: info.userId } : undefined,
    target: info.meetingId != null ? { type: 'meeting', id: info.meetingId } : undefined,
    detail,
  });
}

export function auditAuthFailure(
  event: string,
  authMethod: string,
  err: unknown,
  req: Request,
): void {
  const name = (err as { name?: string } | null)?.name;
  if (name === 'ZodError') return;
  const status = (err as { statusCode?: number } | null)?.statusCode;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const email = typeof body.email === 'string' && body.email.includes('@') ? body.email.trim().toLowerCase().slice(0, 320) : null;
  auditLater(event, {
    result: 'failure',
    actor: { id: getAuth(req)?.userId ?? null, email, authMethod },
    detail: { status: status ?? null, reason: (err as { publicMessage?: string } | null)?.publicMessage ?? name ?? 'error' },
  }, req);
}

export function auditGeminiCall(feature: string, model: string | null | undefined, response: unknown, extra?: Partial<LlmCallInfo>): void {
  try {
    const u = ((response as { usageMetadata?: Record<string, number> } | null)?.usageMetadata ?? {}) as Record<string, number | undefined>;
    auditLlmCall({
      feature,
      model: model ?? null,
      inputTokens: u.promptTokenCount ?? null,
      outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
      cacheReadTokens: u.cachedContentTokenCount ?? null,
      ...extra,
    });
  } catch {
  }
}
