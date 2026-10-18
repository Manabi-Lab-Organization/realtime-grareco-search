import dotenv from 'dotenv';
import { randomBytes } from 'node:crypto';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));

const root = resolve(__dir, '../..');
dotenv.config({ path: resolve(root, '.env.local') });
dotenv.config({ path: resolve(root, '.env') });

const isProd = process.env.NODE_ENV === 'production';

if (isProd) {
  const missing: string[] = [];

  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === 'dev-secret-change-in-production') {
    missing.push('SESSION_SECRET (でたらめな長い文字列。例: openssl rand -hex 32 の結果)');
  }

  if (!process.env.DATABASE_URL) {
    missing.push('DATABASE_URL (データベースの接続先。Docker では docker-compose.yml が自動で入れる)');
  }

  if (!process.env.INITIAL_ADMIN_EMAIL) {
    missing.push('INITIAL_ADMIN_EMAIL (最初の管理者になる人のメールアドレス)');
  }

  if (!process.env.APP_URL) {
    missing.push('APP_URL (このサーバの公開アドレス。例: https://grareco.example.co.jp)');
  }

  if (!process.env.ELEVENLABS_API_KEY) {
    missing.push('ELEVENLABS_API_KEY (文字起こしに必要)');
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    missing.push('ANTHROPIC_API_KEY (要約・調査に必要)');
  }

  if (missing.length > 0) {
    console.error('[Startup] 必須の設定が足りないため、起動を止めます。足りない項目:');
    for (const m of missing) {
      console.error(`  - ${m}`);
    }
    console.error('[Startup] .env に上の項目を書いてから、docker compose up -d で立ち上げ直してください。');
    process.exit(1);
  }

  console.log('[Startup] 必須の設定はそろっています。');
} else {
  if (!process.env.SESSION_SECRET) {
    process.env.SESSION_SECRET = randomBytes(32).toString('hex');
    console.warn('[Startup] SESSION_SECRET not set, using a random per-boot value (dev only). Set SESSION_SECRET for stable sessions.');
  }
}
