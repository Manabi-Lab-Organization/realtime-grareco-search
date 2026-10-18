import { hasGeminiKey } from './llm/genaiClient.js';

export interface ServerFeatures {
  grareco: boolean;
  autoGrareco: boolean;
  grarecoSearch: boolean;
  research: boolean;
  roomObservation: boolean;
  googleLogin: boolean;
  email: boolean;
}

export function hasOpenAIKey(): boolean {
  return !!process.env.OPENAI_API_KEY;
}

export function hasAnthropicKey(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

export function serverFeatures(env: NodeJS.ProcessEnv = process.env): ServerFeatures {
  const gemini = !!env.GEMINI_API_KEY;
  const openai = !!env.OPENAI_API_KEY;
  const anthropic = !!env.ANTHROPIC_API_KEY;
  return {
    grareco: gemini || openai,
    autoGrareco: gemini,
    grarecoSearch: gemini,
    research: anthropic && env.RESEARCH_ENABLED !== 'false',
    roomObservation: env.ROOM_OBSERVATION_ENABLED === 'true',
    googleLogin: !!env.GOOGLE_CLIENT_ID,
    email: !!env.RESEND_API_KEY,
  };
}

export function logFeatureSummary(): void {
  if (!process.env.INITIAL_ADMIN_EMAIL) {
    console.warn('[Features] INITIAL_ADMIN_EMAIL が未設定：最初に登録した人が誰でも管理者になります。立ち上げたらすぐに管理者を登録してください');
  }
  const f = serverFeatures();
  const missing: string[] = [];
  if (!process.env.ELEVENLABS_API_KEY) missing.push('ELEVENLABS_API_KEY が未設定：文字起こしができません（必須）');
  if (!hasAnthropicKey()) missing.push('ANTHROPIC_API_KEY が未設定：要約・調査ができません（必須）');
  if (!hasGeminiKey()) {
    missing.push('GEMINI_API_KEY が未設定：要約などは Claude で代わりに行います。自動グラレコとグラレコ検索は使えません');
  }
  if (!f.grareco) missing.push('GEMINI_API_KEY も OPENAI_API_KEY も未設定：グラレコ（画像）は使えません');
  if (!f.email) missing.push('RESEND_API_KEY が未設定：メールは送りません（パスワードの再設定は管理者が行います）');
  for (const m of missing) console.warn(`[Features] ${m}`);
  console.log(`[Features] ${JSON.stringify(f)}`);
}
