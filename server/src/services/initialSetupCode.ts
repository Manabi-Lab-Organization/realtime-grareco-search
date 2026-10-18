import crypto from 'crypto';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 24;

let current: string | null = null;

function generate(): string {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  const chars = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
  return chars.match(/.{1,4}/g)!.join('-');
}

function normalize(code: string): string {
  return code.replace(/[\s-]/g, '').toUpperCase();
}

export function issueInitialSetupCode(): string {
  if (!current) {
    current = generate();
    console.log('[Setup] まだ管理者がいません。最初の管理者の登録には、次の初期設定コードを入力してください。');
    console.log(`[Setup] 初期設定コード: ${current}`);
    console.log('[Setup] このコードは一度だけ使えます。サーバを立ち上げ直すと新しいコードに変わります。');
  }
  return current;
}

export function hasInitialSetupCode(): boolean {
  return current !== null;
}

export function matchesInitialSetupCode(input: string | undefined): boolean {
  if (!current || !input) return false;
  const a = Buffer.from(normalize(input));
  const b = Buffer.from(normalize(current));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function clearInitialSetupCode(): void {
  current = null;
}
