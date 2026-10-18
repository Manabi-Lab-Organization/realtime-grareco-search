
export type FallbackAlertKind = 'openai_quota' | 'openai_auth' | 'openai_key_missing';

export const ALERT_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function classifyFallbackReason(reason: string): FallbackAlertKind | null {
  if (/OPENAI_API_KEY が設定されていません/.test(reason)) return 'openai_key_missing';
  if (/OpenAI HTTP 429/.test(reason) && /insufficient_quota|credit_balance_exhausted|billing_hard_limit/.test(reason)) {
    return 'openai_quota';
  }
  if (/OpenAI HTTP (401|403)\b/.test(reason)) return 'openai_auth';
  return null;
}

const KIND_LABELS: Record<FallbackAlertKind, { title: string; action: string }> = {
  openai_quota: {
    title: 'OpenAI の残高切れ（または請求上限）',
    action:
      'platform.openai.com → Settings → Billing で残高（API credit balance）を確認し、「Buy credits」で追加してください。' +
      '自動チャージがオンなのに残高が 0 の場合は、Payment methods のカードの有効期限・決済失敗を確認してください。',
  },
  openai_auth: {
    title: 'OpenAI の API キーが拒否された',
    action:
      'platform.openai.com → API keys でキーが無効化・削除されていないか確認し、' +
      '必要なら新しいキーを発行して、サーバの環境変数 OPENAI_API_KEY を差し替えてください。',
  },
  openai_key_missing: {
    title: 'OPENAI_API_KEY が未設定',
    action: 'サーバの環境変数 OPENAI_API_KEY を設定してください。',
  },
};

const lastSentAt = new Map<FallbackAlertKind, number>();

export function resetFallbackAlertState(): void {
  lastSentAt.clear();
}

export interface FallbackAlertMail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export function buildFallbackAlertMail(kind: FallbackAlertKind, reason: string, now: Date, to: string): FallbackAlertMail {
  const label = KIND_LABELS[kind];
  const env = process.env.NODE_ENV || 'unknown';
  const at = now.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  const subject = `【要対応】グラレコが Gemini に切り替わっています：${label.title}（${env}）`;
  const lines = [
    `手動グラレコ／会議終了時グラレコの作画で OpenAI が使えず、Gemini（予備の方式）に切り替わりました。`,
    `直すまで、以降のグラレコもすべて Gemini で作られます（利用者には表示されません）。`,
    ``,
    `■ 原因: ${label.title}`,
    `■ 発生: ${at}（${env} 環境）`,
    `■ 対処: ${label.action}`,
    ``,
    `■ OpenAI からの応答（先頭200字）:`,
    reason.slice(0, 200),
    ``,
    `※ 同じ原因のメールは ${ALERT_INTERVAL_MS / 3_600_000} 時間に 1 通までです。`,
  ];
  const text = lines.join('\n');
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = lines.map((l) => (l ? `<p style="margin:4px 0">${esc(l)}</p>` : '<br>')).join('');
  return { to, subject, text, html };
}

export async function notifyGrarecoFallback(
  reason: string,
  deps: { now?: Date; sendMail?: (mail: FallbackAlertMail) => Promise<void> } = {},
): Promise<boolean> {
  try {
    const kind = classifyFallbackReason(reason);
    if (!kind) return false;
    const to = process.env.OPS_EMAIL;
    if (!to) {
      console.warn(`[Grareco-Alert] OPS_EMAIL が未設定のため通知しません kind=${kind}`);
      return false;
    }
    const now = deps.now ?? new Date();
    const last = lastSentAt.get(kind);
    if (last !== undefined && now.getTime() - last < ALERT_INTERVAL_MS) return false;
    lastSentAt.set(kind, now.getTime());

    const mail = buildFallbackAlertMail(kind, reason, now, to);
    const send =
      deps.sendMail ??
      (async (m: FallbackAlertMail) => {
        const { sendOperationsEmail } = await import('../emailService.js');
        await sendOperationsEmail(m);
      });
    await send(mail);
    console.log(`[Grareco-Alert] 管理者に通知しました kind=${kind}`);
    return true;
  } catch (err) {
    console.error('[Grareco-Alert] 管理者への通知に失敗しました:', err instanceof Error ? err.message : err);
    return false;
  }
}
