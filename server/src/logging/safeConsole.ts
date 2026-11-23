import { DrizzleQueryError } from 'drizzle-orm/errors';
import { isPgDatabaseError } from '../db/queryError.js';

/**
 * ログに書く前に、エラーから SQL の全文・パラメータ・入力値を取り除く。
 *
 * console.error(..., err) のように失敗をそのままログに渡す箇所は多く、1 つずつ直すと漏れる。
 * そこで起動の最初（env.ts）で console の各関数を包み、渡されたものをここで安全な形に置き換える。
 *
 * 取り除くもの
 * - DrizzleQueryError：`query`（SQL 全文）と `params`（メールアドレス・トークンなど）。元の失敗（cause）に置き換える
 * - pg の失敗（DatabaseError）：`detail`（「Key (email)=(…) already exists」のように値が入る）・`where`・`internalQuery` など。
 *   残すのは message・code・制約／表／列の名前だけ。データの形の失敗（code が 22 で始まる）は message の中の値も伏せる
 * - 文字列：`Failed query: …` 以降（`${err}` で SQL とパラメータが文字列になったもの）と、`Key (列)=(値)` の値
 *
 * - JSON の解釈の失敗：`Unexpected token …, "…" is not valid JSON` の「…」（解釈できなかった文字列の先頭。
 *   AI の出力を読む処理が多いので、会議の中身が入る）
 * - 鍵・トークン：`Bearer …`、決まった書き出しの鍵（sk- / AIza など）、接続文字列のパスワード、
 *   URL の `?key=…` `&token=…` などの値
 * - エラーに付いたリクエスト・応答の中身：HTTP クライアントや SDK のエラーは `config`（Authorization ヘッダ）・
 *   `response`（本文）・`raw` などを持ち、`console.error(err)` はそれをすべて書き出す。HTTP の状態だけ残す
 * - エラーの文の中のメールアドレス：`t***@example.com` の形にする（エラーの文だけ。ふつうのログの文字列は変えない）
 *
 * 呼び出し元の場所（stack の at 行）は残すので、どこで失敗したかは追える。
 * 置き換えが要らないものは、同じものをそのまま返す（ログの見た目を変えない）。
 */

const MAX_DEPTH = 4;
const REDACTED = '…';

// 伏せる対象があるかの早い判定（ログは数が多いので、無ければ何もしない）
const SENSITIVE = /Failed query|Key \(|is not valid JSON|Bearer |Basic |:\/\/|sk-|pk_|rk_|sk_|whsec_|re_|xox|AIza|gh[pousr]_/;

function hasSensitiveText(s: string): boolean {
  return SENSITIVE.test(s);
}

// 鍵の決まった書き出し（OpenAI・Anthropic・Stripe・Resend・Slack・Google・GitHub）
const KEY_LIKE = /\b(?:sk-[A-Za-z0-9_-]{16,}|(?:sk|pk|rk|whsec|re)_[A-Za-z0-9_]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,})/g;
// URL の ? 以降で、鍵・トークンを運ぶ名前の値
const SECRET_PARAM = /([?&](?:key|api_?key|apikey|token|access_token|refresh_token|id_token|secret|client_secret|signature|sig|password|code)=)[^&\s"'<>]+/gi;

/** 文字列の中の SQL・パラメータ、制約違反の値、JSON の断片、鍵・トークンを伏せる */
export function redactLogText(s: string): string {
  if (!hasSensitiveText(s)) return s;
  return s
    .replace(/Failed query:[\s\S]*/g, 'Failed query: [SQL とパラメータは省略]')
    .replace(/Key \(([^)]*)\)=\((?:[^()]|\([^()]*\))*\)/g, `Key ($1)=(${REDACTED})`)
    // JSON.parse の失敗：解釈できなかった文字列の先頭が入る（`Unexpected token '次', "次回の…" is not valid JSON`）
    .replace(/,?\s*"[\s\S]*?"(?:\.\.\.)?\s*is not valid JSON/g, ' [文字列は省略] is not valid JSON')
    // 接続文字列の利用者名とパスワード（postgres://user:pass@host）
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${REDACTED}@`)
    .replace(SECRET_PARAM, `$1${REDACTED}`)
    .replace(/\bBearer +[A-Za-z0-9._~+/=-]{8,}/g, `Bearer ${REDACTED}`)
    .replace(/(Authorization['"]?\s*[:=]\s*['"]?Basic) +[A-Za-z0-9+/=]{8,}/gi, `$1 ${REDACTED}`)
    .replace(KEY_LIKE, REDACTED);
}

/** エラーの文（message・stack）用：上に加えて、メールアドレスを t***@example.com の形にする */
function redactErrorText(s: string): string {
  const out = redactLogText(s);
  return out.includes('@') ? out.replace(/([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, '$1***@$2') : out;
}

/**
 * HTTP クライアント・SDK のエラーが持つ、リクエストや応答の中身。console はエラーの持ち物をすべて書き出すので、
 * ログ用の写しからは外す（`config.headers.Authorization`・応答の本文・Stripe の `raw` など）。状態（status）は残す
 */
const HEAVY_PROPS = new Set(['config', 'request', 'response', 'headers', 'body', 'data', 'raw', 'requestBody', 'error', 'payment_intent', 'setup_intent', 'payment_method', 'charge']);

/** stack の 1 行目（名前と message）を差し替え、at 行だけを残す */
function rebuildStack(name: string, message: string, stack: string | undefined): string {
  const frames = (stack ?? '').split('\n').filter((line) => /^\s+at /.test(line));
  return [`${name}: ${message}`, ...frames].join('\n');
}

function sanitizePgError(e: Error): Error {
  const code = (e as unknown as { code: string }).code;
  // 22xxx（データの形の失敗）は message に入力値が入る（例：invalid input syntax for type integer: "abc"）
  const message = code.startsWith('22') ? redactLogText(e.message).replace(/"[^"]*"/g, `"${REDACTED}"`) : redactLogText(e.message);
  const out = new Error(message);
  out.name = e.name || 'DatabaseError';
  const src = e as unknown as Record<string, unknown>;
  const keep: Record<string, unknown> = { code };
  for (const k of ['constraint', 'table', 'column', 'schema', 'routine'] as const) {
    if (typeof src[k] === 'string') keep[k] = src[k];
  }
  Object.assign(out, keep);
  out.stack = rebuildStack(out.name, message, e.stack);
  return out;
}

/** ログに渡してよい形のエラーを返す。置き換えが要らなければ同じものを返す */
export function sanitizeLogError(e: Error, depth = 0): Error {
  if (depth > MAX_DEPTH) return e;

  if (e instanceof DrizzleQueryError) {
    const cause = e.cause instanceof Error ? sanitizeLogError(e.cause, depth + 1) : undefined;
    const message = cause ? `Failed query: [SQL とパラメータは省略] ${cause.name}: ${cause.message}` : 'Failed query: [SQL とパラメータは省略]';
    const out = new Error(message);
    out.name = 'DrizzleQueryError';
    if (cause && (cause as { code?: unknown }).code !== undefined) {
      (out as Error & { code?: unknown }).code = (cause as { code?: unknown }).code;
    }
    // 呼び出し元の場所は drizzle 側の stack にある
    out.stack = rebuildStack(out.name, message, e.stack);
    return out;
  }

  if (isPgDatabaseError(e)) return sanitizePgError(e);

  const cause = (e as { cause?: unknown }).cause;
  const safeCause = cause instanceof Error ? sanitizeLogError(cause, depth + 1) : cause;
  const message = redactErrorText(e.message ?? '');
  const stack = e.stack === undefined ? undefined : redactErrorText(e.stack);
  const ownKeys = Object.getOwnPropertyNames(e);
  const hasHeavy = ownKeys.some((k) => HEAVY_PROPS.has(k));
  if (safeCause === cause && message === e.message && stack === e.stack && !hasHeavy) return e;

  // 元のエラーは呼び出し元がまだ使うことがあるので書き換えず、写しを作る
  const out = Object.create(Object.getPrototypeOf(e)) as Error;
  for (const key of ownKeys) {
    if (key === 'message' || key === 'stack' || key === 'cause' || HEAVY_PROPS.has(key)) continue;
    const desc = Object.getOwnPropertyDescriptor(e, key);
    if (desc) Object.defineProperty(out, key, desc);
  }
  if (hasHeavy) {
    // 応答の中身は外すが、HTTP の状態は原因を追うのに要る
    const status = (e as { response?: { status?: unknown } }).response?.status;
    if (typeof status === 'number' && !('status' in out)) Object.defineProperty(out, 'status', { value: status, enumerable: true, configurable: true, writable: true });
  }
  Object.defineProperty(out, 'message', { value: message, writable: true, configurable: true, enumerable: false });
  if (stack !== undefined) Object.defineProperty(out, 'stack', { value: stack, writable: true, configurable: true, enumerable: false });
  if (cause !== undefined) Object.defineProperty(out, 'cause', { value: safeCause, writable: true, configurable: true, enumerable: false });
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** console に渡された 1 つの値を、ログに書いてよい形にする */
export function sanitizeLogArg(arg: unknown): unknown {
  if (typeof arg === 'string') return redactLogText(arg);
  if (arg instanceof Error) return sanitizeLogError(arg);
  // console.error({ err, userId }) のような形（1 段だけ見る）
  if (isPlainObject(arg)) {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(arg)) {
      const safe = typeof v === 'string' ? redactLogText(v) : v instanceof Error ? sanitizeLogError(v) : v;
      if (safe !== v) changed = true;
      out[k] = safe;
    }
    return changed ? out : arg;
  }
  return arg;
}

const INSTALLED = Symbol.for('realtime-grareco-search.safeConsole');
const METHODS = ['error', 'warn', 'log', 'info', 'debug', 'trace'] as const;

/** console の各関数を包む。何度呼んでも 1 回だけ包む */
export function installSafeConsole(target: Console = console): void {
  const t = target as Console & { [INSTALLED]?: boolean };
  if (t[INSTALLED]) return;
  for (const m of METHODS) {
    const original = t[m].bind(t) as (...args: unknown[]) => void;
    t[m] = ((...args: unknown[]) => {
      let safeArgs: unknown[] = args;
      try {
        safeArgs = args.map(sanitizeLogArg);
      } catch {
        // 置き換えに失敗してもログ自体は止めない（失敗の中身は出さず、そのことだけ書く）
        safeArgs = ['[safeConsole] ログの置き換えに失敗したため、中身を省きました'];
      }
      original(...safeArgs);
    }) as Console[typeof m];
  }
  t[INSTALLED] = true;
}

installSafeConsole();
