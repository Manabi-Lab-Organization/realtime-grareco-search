
import { analyzeWithClaude } from '../anthropicService.js';

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const HAIKU_CONFIDENCE_THRESHOLD = 0.7;
const COOLDOWN_MS = 5 * 60 * 1000;

const TRANSITION_PATTERNS: Array<{ category: string; pattern: RegExp }> = [
  {
    category: 'agenda',
    pattern: /(次の議題|議題を変え|議題に移り|別件|話題を(?:変え|移)|ちょっと脱線|余談ですが|本題に戻|本題に入)/,
  },
  {
    category: 'chapter',
    pattern: /(次の章|次のテーマ|次のパート|次のセクション|次のトピック|次に行きま|次に進み|続いて|では次|次は|続いては|続いてのコーナー|お次は|次のニュース|特集です)/,
  },
  {
    category: 'break',
    pattern: /(以上で|ここまで|いったん|では(?:、|\s)|まずは|それでは|では[、]|そうしましたら|では始め|改めて|気を取り直して)/,
  },
  {
    category: 'switch',
    pattern: /(ところで|そういえば|話を変え|話変わ|ちなみに|あ、そういえば|あの、ちょっと|えっと、今度は|あ、その前に)/,
  },
  {
    category: 'recess',
    pattern: /(休憩|少し休み|一休み|ブレイク|休もう|休みましょう|一旦止め|一回切り)/,
  },
  {
    category: 'wrapup',
    pattern: /(まとめると|要するに|結論として|振り返ると|ここまでをまとめ|まとめましょう|総括する|締めくくり|最後に|ということで)/,
  },
];

interface DetectorState {
  lastFireAt: number;
}
const state = new Map<number, DetectorState>();

function ensureState(meetingId: number): DetectorState {
  let s = state.get(meetingId);
  if (!s) {
    s = { lastFireAt: 0 };
    state.set(meetingId, s);
  }
  return s;
}

function findCandidate(text: string): { matched: boolean; category: string; phrase: string } {
  for (const p of TRANSITION_PATTERNS) {
    const m = text.match(p.pattern);
    if (m) {
      return { matched: true, category: p.category, phrase: m[0] };
    }
  }
  return { matched: false, category: '', phrase: '' };
}

async function confirmWithHaiku(
  prevContext: string,
  currentText: string,
  hitPhrase: string,
  category: string,
): Promise<{ confirmed: boolean; confidence: number; sectionTitle: string }> {
  const systemPrompt =
    'あなたは会議・講義・研修の進行を観察するアシスタント。ある発話が、'
    + '「話のまとまりが次に切り替わる節目」かどうかを判定する。\n\n'
    + '判定基準:\n'
    + '- 真の節目: 議題・章・テーマが切り替わる、休憩や区切りが入る、まとめに入る\n'
    + '- 節目ではない: 単なる接続詞、相づち、確認、ちょっとした言い直し\n\n'
    + '出力は JSON のみ。スキーマ:\n'
    + '{ "confirmed": boolean, "confidence": number(0..1), "sectionTitle": string }\n\n'
    + 'sectionTitle は「次に何が始まりそうか」を 6〜18字で表現。confirmed=false なら空文字でよい。';

  const userMessage =
    `[直前の文脈]\n${prevContext.slice(-1500)}\n\n`
    + `[ヒットしたフレーズ] "${hitPhrase}" (category=${category})\n\n`
    + `[ヒット周辺の発話]\n${currentText.slice(-800)}`;

  let raw: string;
  try {
    raw = await analyzeWithClaude(systemPrompt, userMessage, {
      model: HAIKU_MODEL,
      maxTokens: 256,
      temperature: 0.2,
      feature: 'anthropic:grareco.sectionTransition',
    });
  } catch (err) {
    console.error('[sectionTransition] Haiku call failed:', err instanceof Error ? err.message : err);
    return { confirmed: false, confidence: 0, sectionTitle: '' };
  }

  const fenceStripped = raw
    .replace(/```(?:json)?\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();
  const firstBrace = fenceStripped.indexOf('{');
  const lastBrace = fenceStripped.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace <= firstBrace) {
    console.warn(`[sectionTransition] JSON not found in response. raw=${raw.length} chars`);
    return { confirmed: false, confidence: 0, sectionTitle: '' };
  }
  const candidateJson = fenceStripped.slice(firstBrace, lastBrace + 1);
  try {
    const parsed = JSON.parse(candidateJson) as {
      confirmed?: unknown;
      confidence?: unknown;
      sectionTitle?: unknown;
    };
    return {
      confirmed: parsed.confirmed === true,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
      sectionTitle: typeof parsed.sectionTitle === 'string' ? parsed.sectionTitle : '',
    };
  } catch {
    console.warn(`[sectionTransition] JSON parse failed. raw=${raw.length} chars`);
    return { confirmed: false, confidence: 0, sectionTitle: '' };
  }
}

export interface SectionTransitionResult {
  shifted: boolean;
  sectionTitle: string | null;
  category: string | null;
  reason: 'cooldown' | 'no_match' | 'rejected' | 'confirmed';
}

export async function detectSectionTransition(
  meetingId: number,
  recentText: string,
  prevContext: string,
): Promise<SectionTransitionResult> {
  const s = ensureState(meetingId);
  const now = Date.now();

  if (now - s.lastFireAt < COOLDOWN_MS) {
    return { shifted: false, sectionTitle: null, category: null, reason: 'cooldown' };
  }

  const candidate = findCandidate(recentText);
  if (!candidate.matched) {
    return { shifted: false, sectionTitle: null, category: null, reason: 'no_match' };
  }

  console.log(`[sectionTransition] candidate meeting=${meetingId} category=${candidate.category} phrase="${candidate.phrase}"`);

  const result = await confirmWithHaiku(prevContext, recentText, candidate.phrase, candidate.category);

  if (result.confirmed && result.confidence >= HAIKU_CONFIDENCE_THRESHOLD) {
    s.lastFireAt = now;
    console.log(`[sectionTransition] CONFIRMED meeting=${meetingId} confidence=${result.confidence.toFixed(2)} title="${result.sectionTitle}"`);
    return {
      shifted: true,
      sectionTitle: result.sectionTitle || null,
      category: candidate.category,
      reason: 'confirmed',
    };
  }
  console.log(`[sectionTransition] rejected meeting=${meetingId} confidence=${result.confidence.toFixed(2)}`);
  return { shifted: false, sectionTitle: null, category: candidate.category, reason: 'rejected' };
}

export function cleanupSectionTransitionDetector(meetingId: number): void {
  state.delete(meetingId);
}

export const __test__ = {
  findCandidate,
  TRANSITION_PATTERNS,
};
