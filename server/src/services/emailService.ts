import { Resend } from 'resend';
import { siteConfig } from './siteConfig.js';
import { toEmailAttachmentImage } from './grareco/grarecoImageCompress.js';

const APP_NAME = siteConfig().appName;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escUrlAttr(raw: string | null | undefined): string {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) <= 0x20) return '';
  }
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
  } catch {
    return '';
  }
  return escapeHtml(s);
}

function getBaseUrl(): string {
  return process.env.APP_URL || 'http://localhost:3000';
}

function formatDateJST(date: Date): string {
  const jst = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }));
  const yy = String(jst.getFullYear()).slice(-2);
  const mm = String(jst.getMonth() + 1).padStart(2, '0');
  const dd = String(jst.getDate()).padStart(2, '0');
  return `${yy}${mm}${dd}`;
}

let _resend: Resend | null = null;
function getResend(): Resend {
  if (!_resend) {
    const key = process.env.RESEND_API_KEY;
    if (!key) {
      throw new Error('RESEND_API_KEY が設定されていません。サーバの環境変数（.env）に追加してください。');
    }
    _resend = new Resend(key);
  }
  return _resend;
}

type MailPayload = Parameters<Resend['emails']['send']>[0];

interface MailError {
  statusCode?: number | null;
  message?: string;
  name?: string;
}

export function isTransientMailError(error: MailError | null | undefined): boolean {
  if (!error) return false;
  const code = error.statusCode;
  if (code == null) return true;
  if (code === 408 || code === 429) return true;
  return code >= 500;
}

const MAIL_RETRY_BASE_MS = 2000;

async function sendWithRetry(
  payload: MailPayload,
  label: string,
  { attempts = 3, sleepFn = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) } = {},
): Promise<void> {
  const resend = getResend();
  let last: MailError | null = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const { error } = await resend.emails.send(payload);
    if (!error) {
      if (attempt > 1) console.log(`[Mail] ${label}: ${attempt}回目で送信できました`);
      return;
    }
    last = error as MailError;
    if (!isTransientMailError(last) || attempt === attempts) break;
    const waitMs = MAIL_RETRY_BASE_MS * 2 ** (attempt - 1);
    console.warn(`[Mail] ${label}の送信に失敗、${waitMs / 1000}秒後に再試行`
      + ` (${attempt}/${attempts - 1}): ${JSON.stringify(last).slice(0, 200)}`);
    await sleepFn(waitMs);
  }
  throw new Error(`${label}の送信に失敗: ${JSON.stringify(last)}`);
}

export async function sendPasswordResetEmail(
  to: string,
  resetToken: string
): Promise<void> {
  const baseUrl = getBaseUrl();
  const resetUrl = `${baseUrl}/reset-password?token=${resetToken}`;

  const fromEmail = process.env.FROM_EMAIL || 'onboarding@resend.dev';

  await sendWithRetry({
    from: `${APP_NAME} <${fromEmail}>`,
    to: [to],
    subject: `[${APP_NAME}] パスワードリセット`,
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h2 style="color: #333;">${APP_NAME}</h2>
        <p>パスワードリセットのリクエストを受け付けました。</p>
        <p>下のボタンをクリックして、新しいパスワードを設定してください。</p>
        <div style="margin: 30px 0; text-align: center;">
          <a href="${resetUrl}"
             style="background-color: #0f172a; color: white; padding: 12px 32px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: bold;">
            パスワードをリセット
          </a>
        </div>
        <p style="color: #666; font-size: 14px;">
          このリンクは1時間後に無効になります。
        </p>
        <p style="color: #666; font-size: 14px;">
          このメールに心当たりがない場合は、無視してください。パスワードは変更されません。
        </p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;" />
        <p style="color: #999; font-size: 12px;">
          ボタンが機能しない場合は、以下のURLをブラウザに貼り付けてください：<br />
          <a href="${resetUrl}" style="color: #666;">${resetUrl}</a>
        </p>
      </div>
    `,
  }, 'パスワード再設定メール');
}

function convertMinutesToHtml(text: string): string {
  const lines = text.split('\n');
  const htmlParts: string[] = [];
  let inList = false;
  let paragraphLines: string[] = [];

  function flushParagraph() {
    if (paragraphLines.length > 0) {
      htmlParts.push(`<p style="margin: 8px 0; line-height: 1.6;">${paragraphLines.join('<br />')}</p>`);
      paragraphLines = [];
    }
  }

  function closeList() {
    if (inList) {
      htmlParts.push('</ul>');
      inList = false;
    }
  }

  for (const line of lines) {
    const trimmed = escapeHtml(line.trim());

    if (!trimmed) {
      flushParagraph();
      closeList();
      continue;
    }

    const h1Match = trimmed.match(/^# (.+)$/);
    const h2Match = trimmed.match(/^## (.+)$/);
    const h3Match = trimmed.match(/^### (.+)$/);
    if (h3Match) {
      flushParagraph(); closeList();
      htmlParts.push(`<h4 style="color: #1e293b; margin: 12px 0 4px; font-size: 14px;">${h3Match[1]}</h4>`);
      continue;
    }
    if (h2Match) {
      flushParagraph(); closeList();
      htmlParts.push(`<h3 style="color: #0f172a; margin: 16px 0 4px; font-size: 16px;">${h2Match[1]}</h3>`);
      continue;
    }
    if (h1Match) {
      flushParagraph(); closeList();
      htmlParts.push(`<h2 style="color: #0f172a; margin: 18px 0 6px; font-size: 18px;">${h1Match[1]}</h2>`);
      continue;
    }

    const listMatch = trimmed.match(/^[・•\-\*]\s*(.+)$/);
    if (listMatch) {
      flushParagraph();
      if (!inList) {
        htmlParts.push('<ul style="margin: 4px 0; padding-left: 20px;">');
        inList = true;
      }
      htmlParts.push(`<li style="margin: 2px 0; line-height: 1.5;">${listMatch[1]}</li>`);
      continue;
    }

    const processed = trimmed.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

    closeList();
    paragraphLines.push(processed);
  }

  flushParagraph();
  closeList();

  return htmlParts.join('\n');
}

export async function sendMeetingMinutesEmail(params: {
  to: string;
  meetingId: number;
  meetingTitle: string;
  endedAt: Date;
  minutesText: string;
  grarecoImageBase64?: string;
}): Promise<void> {
  const { to, meetingId, meetingTitle, endedAt, minutesText, grarecoImageBase64 } = params;
  if (!process.env.RESEND_API_KEY) {
    console.log(`[MeetingEmail] meetingId=${meetingId} メールは未設定（RESEND_API_KEY なし）のため送らない。議事録は画面に保存済み`);
    return;
  }
  const baseUrl = getBaseUrl();
  const summaryUrl = `${baseUrl}/meetings/${meetingId}`;
  const dateStr = formatDateJST(endedAt);
  const subject = `${dateStr}_【議事録】${meetingTitle}`;
  const fromEmail = process.env.FROM_EMAIL || 'onboarding@resend.dev';

  const minutesHtml = convertMinutesToHtml(minutesText);

  const attachments: Array<{ filename: string; content: Buffer }> = [];
  const grarecoAttachment = grarecoImageBase64 ? await toEmailAttachmentImage(grarecoImageBase64) : null;
  if (grarecoAttachment) {
    attachments.push({
      filename: `${dateStr}_グラレコ_${meetingTitle}.${grarecoAttachment.extension}`,
      content: grarecoAttachment.content,
    });
  }

  await sendWithRetry({
    from: `${APP_NAME} <${fromEmail}>`,
    to: [to],
    subject,
    html: `
      <div style="font-family: 'Helvetica Neue', Arial, 'Hiragino Kaku Gothic ProN', 'Hiragino Sans', Meiryo, sans-serif; max-width: 700px; margin: 0 auto; padding: 20px; color: #333;">
        <div style="background: linear-gradient(135deg, #0f172a, #1e40af); padding: 24px; border-radius: 12px 12px 0 0;">
          <h1 style="color: white; margin: 0; font-size: 20px;">📋 ${escapeHtml(meetingTitle)}</h1>
          <p style="color: #94a3b8; margin: 8px 0 0; font-size: 14px;">会議議事録 - ${dateStr}</p>
        </div>

        <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-top: none; padding: 24px; border-radius: 0 0 12px 12px;">
          <div style="margin-bottom: 24px;">
            ${minutesHtml}
          </div>

          <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;" />

          <div style="text-align: center; margin: 24px 0;">
            <a href="${summaryUrl}"
               style="background-color: #0f172a; color: white; padding: 12px 32px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: bold;">
              サマリーを確認する
            </a>
          </div>

          ${grarecoImageBase64 ? '<p style="color: #64748b; font-size: 13px; text-align: center;">📎 グラフィックレコーディングを添付しています</p>' : ''}
        </div>

        <p style="color: #94a3b8; font-size: 11px; text-align: center; margin-top: 16px;">
          ${APP_NAME} より自動送信
        </p>
      </div>
    `,
    attachments,
  }, '議事録メール');
}

export async function sendOperationsEmail(params: {
  to: string;
  subject: string;
  text: string;
  html: string;
}): Promise<void> {
  const { to, subject, text, html } = params;
  const fromEmail = process.env.FROM_EMAIL || 'onboarding@resend.dev';
  await sendWithRetry({
    from: `${APP_NAME} <${fromEmail}>`,
    to: [to],
    subject,
    text,
    html: `<div style="font-family: 'Helvetica Neue', Arial, 'Hiragino Kaku Gothic ProN', 'Hiragino Sans', Meiryo, sans-serif; max-width: 640px; margin: 0 auto; padding: 20px; color: #333; line-height: 1.7;">${html}</div>`,
  }, '運用連絡メール');
}
