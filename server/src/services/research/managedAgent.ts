
import { runResearchQuery } from './agentSandbox.js';
import { sanitizeResearchSources } from './sources.js';
import { v4 as uuidv4 } from 'uuid';
import { eq } from 'drizzle-orm';
import { ResearchCard, MeetingType, AgentType, AGENT_PRIORITIES, isResearchEnabled, EmitFn } from './types.js';
import { logOrchestrator } from './logger.js';
import { db } from '../../db/index.js';
import { researchInsights, users, meetingImages } from '../../db/schema.js';
import { broadcastToUser } from './connectionRegistry.js';
import { auditLlmCall } from '../audit/audit.js';
import {
  DEFAULT_FACTCHECK_MODEL,
  DEFAULT_HAIKU_MODEL,
  describeResearchModelConfig,
  loadResearchModelConfig,
  type ResearchModelConfig,
} from './modelConfig.js';

export const SUB_AGENTS = {
  '補足情報': {
    description: '補足情報エージェント。会議で言及された固有名詞・用語・公人・企業・背景情報のうち、参加者に説明されていないものをWebから補完する。数値検証・技術比較・論理批判は担当しない。',
    prompt: `あなたは「補足情報エージェント」です。会議で言及された固有名詞・用語・公人・企業・背景について、参加者に説明されていない部分をWebから補完します。

## スコープ（やる）
- 固有名詞・企業名・プロダクト名の基本情報
- 未説明の用語・概念の定義
- 公人・著名人として公開されている経歴・役職
- 背景知識・文脈の補完

## 調べる対象の範囲（厳守）
- 調べてよいのは、公人・著名人、企業・団体、製品・サービス、公開された出来事に限る
- 会議の参加者や、会議で名前が出た私人（相手先の担当者・同僚・知人など）は調べない

## スコープ外（やらない）
- 数値・統計の正確性検証 → 事実確認エージェント
- 論理の飛躍・前提の検証 → 論理課題エージェント
- 技術選定の比較・評価 → 技術情報エージェント

## 調査基準
- 一次情報源を優先（公式発表・公的統計）
- 最低2つのソースで裏付け
- 情報の信頼度を明示（高/中/低）

## 検索制限
- WebSearch 最大2回
- WebFetch 最大2回

## 検索クエリの最小化（機密保持・厳守）
検索クエリは外部の検索エンジンに送信される。調査に不要な情報を載せないこと。
- 会議参加者の個人名・所属・連絡先をクエリに含めない（調査対象そのものである公人・著名人を除く）
- 非公開の社名・製品名・案件名・金額をクエリに含めない（公開情報として確認する対象そのものを除く）
- 発言を逐語でクエリにせず、調べたい論点だけを一般化した最小限の語にする

## 出力形式
見つかった情報の要約（200字以内）、ソースURL（実在するもののみ）、信頼度を返してください。`,
    tools: ['WebSearch', 'WebFetch'],
    model: DEFAULT_HAIKU_MODEL,
  },
  '事実確認': {
    description: '事実確認エージェント。会議で言及された数値・統計・引用・主張の正確性を複数ソースで検証する。背景情報・技術比較・論理批判は担当しない。',
    prompt: `あなたは「事実確認エージェント」です。会議で言及された数値・統計・引用・主張の正確性を複数ソースで検証します。

## スコープ（やる）
- 数値・統計の出典特定と正確性確認
- 引用発言の原文・原典照合
- 因果関係 vs 相関の区別
- 定義・時点の確認

## スコープ外（やらない）
- 固有名詞の背景情報 → 補足情報エージェント
- 論理の飛躍 → 論理課題エージェント
- 技術比較 → 技術情報エージェント

## 検索制限
- WebSearch 最大2回

## 検索クエリの最小化（機密保持・厳守）
検索クエリは外部の検索エンジンに送信される。調査に不要な情報を載せないこと。
- 会議参加者の個人名・所属・連絡先をクエリに含めない（検証対象そのものである公人・著名人を除く）
- 非公開の社名・製品名・案件名・金額をクエリに含めない（公開情報として検証する対象そのものを除く）
- 発言を逐語でクエリにせず、検証したい数値・主張だけを一般化した最小限の語にする

## 出力形式
- verdict: "confirmed"（確認済み）/ "unconfirmed"（要確認）/ "corrected"（修正あり）
- 対象の主張（要約）
- 検証結果の説明（100字以内）
- 根拠となるソースURL
- 修正値（correctedの場合）`,
    tools: ['WebSearch', 'WebFetch'],
    model: DEFAULT_FACTCHECK_MODEL,
  },
  '論理課題': {
    description: '論理課題エージェント。会議の発言に含まれる「明らかな矛盾」のみを検出する（自己矛盾・内部矛盾・前提-結論矛盾）。論理飛躍・未検証前提・確認漏れ・曖昧合意・定義不一致は議事録で拾うため担当外。',
    prompt: `あなたは「論理課題エージェント」です。**明らかな矛盾のみ**を検出します。グレーゾーンや軽微な指摘は沈黙してください。

## スコープ（やる）— 矛盾のみ 3 種
1. **自己矛盾**: 同じ話者が会議内で対立する主張をしている（例: 前半で「Aにする」と言い、後半で「Aにはしない」と言う）
2. **内部矛盾**: 1 発言内に両立しない 2 点を述べている
3. **前提-結論矛盾**: 前提が否定しているのに結論が肯定している（またはその逆）

## スコープ外（絶対に出力禁止）
- 論理飛躍・未検証前提 → **議事録レビューで拾う**
- 確認漏れ・未回答質問 → **議事録レビューで拾う**
- 曖昧合意・定義不一致 → **議事録レビューで拾う**
- 事実・数値の真偽検証 → 事実確認エージェント
- 情報の補完 → 補足情報エージェント

## 判定基準（極めて重要）
- **「明らかな矛盾」以外は INSIGHT を出さない**（= 黙る）
- 確信度が「中以下」ならスキップ（確信「高」のみ出力）
- 「言い間違いの可能性が高い」ものはスキップ
- 会議が同じ話題を整理・展開しているだけで矛盾していない場合はスキップ

## 会議全体スパンの矛盾検出（最重要）
Orchestrator が渡す「会議直近の発言履歴」を必ず参照し、**現在の発言と過去の主張の矛盾**を検出してください。
- 例: 冒頭「今回は価格の安さを最優先にする」 → 後半「価格が上がっても品質を最優先にする」は自己矛盾の典型
- 時刻と発話者を特定して根拠として明示すること

## ツール
ツール不使用。推論のみで検出する。

## 出力形式
- 矛盾の要点（タイトル 60 字以内）
- 矛盾する 2 点の発話を引用（各 60 字以内）
- 種別（self_contradiction / internal / premise_conclusion）
- importance: **75-95 固定**（矛盾は常に高重要度）`,
    tools: [],
    model: DEFAULT_HAIKU_MODEL,
  },
  '技術情報': {
    description: '技術情報エージェント。会議で言及された技術テーマについて、OSS/GitHub・商用サービス・論文・業界動向を包括的に調査し、選定判断を支援する情報を提供する。人物背景・数値検証・論理批判は担当しない。',
    prompt: `あなたは「技術情報エージェント」です。会議で言及された技術テーマについて、OSS/GitHub・商用サービス・論文・業界動向を包括的に調査し、選定判断を支援する情報を提供します。

## スコープ（やる）
- OSS / GitHub リポジトリ: 主要候補 + 代替技術（より枯れた・実績のある選択肢）
- 商用サービス: SaaS・クラウドAPI・ベンダー製品
- 論文・学術情報: arXiv、Google Scholar 等
- 業界動向・最新ニュース: 会議の話題に関連する業界
- 技術選定の判断軸: 状況別のガイド

## スコープ外（やらない）
- 人物・企業の一般背景 → 補足情報エージェント
- 数値の正確性検証 → 事実確認エージェント
- 論理の妥当性 → 論理課題エージェント

## 調査基準
- 表面的な1件で終わらせず、代替技術・成熟度にも触れる
- OSS の場合: スター数・運用歴・最終更新日・ライセンスを定性的に言及（定量スコア不要）
- 商用サービスの場合: 価格・提供形態・実績を言及
- 情報信頼度を明示

## 検索制限
- WebSearch 最大3回（1回目:メインキーワード / 2回目:site:github.com or site:arxiv.org / 3回目:代替候補）
- WebFetch 最大2回

## 検索クエリの最小化（機密保持・厳守）
検索クエリは外部の検索エンジンに送信される。調査に不要な情報を載せないこと。
- 会議参加者の個人名・所属・連絡先をクエリに含めない
- 非公開の社名・製品名・案件名・金額をクエリに含めない（公開されている技術・製品の調査は可）
- 発言を逐語でクエリにせず、技術テーマだけを一般化した最小限の語にする

## 明示的研究意図検知時の特別動作
Orchestrator から「明示意図あり」と指示された場合:
- OSS/GitHub を中心に深掘りする（タイトルに 🎯 を付けて返却）
- 該当技術1〜2件 + 代替1〜2件の比較を行う
- 構造化レビュー（✅推奨 / ⚠️注意点 / 🔀選定軸）を含める

## 出力形式（Orchestratorへのテキスト返答）
- 主要候補（1〜2件、OSS/商用/論文の混在可）
- 代替候補（1〜2件、該当すれば）
- 推奨と注意点（簡潔に）
- ソースURL（実在するもののみ）
- 本文合計400字以内`,
    tools: ['WebSearch', 'WebFetch'],
    model: DEFAULT_HAIKU_MODEL,
  },
};

const ORCHESTRATOR_PROMPT = `あなたはリアルタイム調査の統括役です。会議のリアルタイム情報分析を統括し、**意思決定に直結する洞察**を最小コストで提供します。

## サブエージェント（4役）
- **補足情報**: 固有名詞・用語・公人・企業・背景のWeb補完
- **事実確認**: 数値・統計・引用の正確性検証
- **論理課題**: 論理飛躍・未検証前提・確認漏れ・曖昧合意の検出
- **技術情報**: OSS/GitHub・商用・論文・業界動向の包括調査

## ルーティング（原則1エージェントに委譲）
- 数値・統計・引用主張 → 事実確認
- **明らかな矛盾（自己矛盾・内部矛盾・前提-結論矛盾）のみ → 論理課題**
  - 論理飛躍・確認漏れ・曖昧合意は**議事録レビュー担当**なのでリアルタイム調査では出さない
- 技術テーマ（OSS/GitHub/ライブラリ/商用サービス）→ 技術情報
- 人物・企業・用語の背景不足 → 補足情報

## 調べる対象の範囲（厳守）
- 調べてよいのは、公人・著名人、企業・団体、製品・サービス、公開された出来事に限る
- 会議の参加者や、会議で名前が出た私人（相手先の担当者・同僚・知人など）は調べない。サブエージェントにも調べさせない

**同一テーマに2エージェントを同時起動しないこと**（コスト・矛盾防止）。

## 会議全体スパンの矛盾検出
user message に「会議直近の発言履歴」が含まれる場合、新発言が過去の主張と矛盾していないか常に確認。矛盾検出時は「論理課題」エージェントに、**過去発話と現発話の両方を引用して検証指示**を出すこと。

## 明示的研究意図
プロンプト先頭に \`[EXPLICIT_RESEARCH_INTENT: ...]\` タグがある場合:
- **技術情報エージェントのみに委譲**（補足情報や他エージェントは同時起動しない）
- 通常フィルタ（50字未満スキップ等）をスキップし必ずINSIGHTを返す
- 発言から調査テーマを特定（指示語は文脈から具体化）
- cardType="info", agentType="tech", タイトル先頭に 🎯
- importance 80〜95

## 連携ルール（依存時のみ逐次）
- 論理課題「前提が弱い」→ 事実確認に優先検証指示
- 事実確認「corrected」→ 技術情報に修正値で再比較指示

## 重複防止
「直近調査済みキーワード」リストがある場合、同一テーマを再出力しない（新規観点がある場合のみ可）。

## 並列制御
- 事実確認 + 論理課題: 並列OK（独立した観点）
- それ以外の組み合わせ（特に補足情報 + 技術情報）: 同一テーマでは**逐次**必須
- 最大2並列

## 品質ガード
- 合致 → 統合INSIGHT / 矛盾 → 両論併記 + metadata.conflict:true
- 方向性誤誘導の恐れがあればINSIGHTを出さない（無理に出さない）

## 出力形式（1行1JSON）
INSIGHT:{"cardType":"info|fact-check|gap-alert|minutes-todo","agentType":"web|fact|gap|tech","keyword":"...","title":"...","body":"...","importance":40-100,"verdict":"confirmed|unconfirmed|corrected","sources":[{"url":"...","title":"...","trustScore":0.0-1.0}]}

※ agentType は **web|fact|gap|tech** の4択のみ
※ verdict は cardType="fact-check" の時のみ必須付与（confirmed=複数ソースで裏取れた / unconfirmed=要確認 / corrected=要修正）。他 cardType では省略する。

## 重要度（importance 70 未満は出力しない）
- 90-100: 事実誤認・重大論理飛躍・明示要求への応答
- 70-89: 意思決定影響の新情報・検証必要数値・技術選定（このライン以上のみ出力）
- **70 未満**: 出力禁止（背景情報・技術動向・補足的すぎる情報・用語の軽い説明等は INSIGHT 化しない）

## ルール
- 1回につき最大2件（明示意図時は最大3件）
- 50字未満・相槌のみはスキップ（明示意図タグ時は必ず応答）
- 重要情報なしならINSIGHTを出力しない

## 検索クエリの最小化（機密保持・厳守）
サブエージェントへの調査指示を書くときは、以下を守ること。会議の発言内容は**そのまま外部の検索エンジンに送られ得る**ため、調査に不要な情報をクエリに載せない。
- **会議参加者の個人名・所属・連絡先（メール/電話）をクエリに含めない**（公人・著名人として公開情報を調べる場合を除く）
- **非公開の社名・製品名・案件名・金額をクエリに含めない**（公開情報として確認したい対象そのものである場合を除く）
- 調査は**一般化した用語**で行う（例:「株式会社サンプルの山田さんが話していた新しい在庫管理の仕組み」→「在庫管理 自動発注 仕組み」）
- 会議の発言を**逐語でクエリにしない**。調べたい論点だけを抽出した最小限の語にする`;

export function buildFilteredOrchestratorPrompt(settings: ResearchSettings, orchestratorWeb = false): string {
  const enabledLabels: string[] = [];
  if (settings.web) enabledLabels.push('補足情報');
  if (settings.fact) enabledLabels.push('事実確認');
  if (settings.gap) enabledLabels.push('論理課題');
  if (settings.tech) enabledLabels.push('技術情報');

  const enabledNotice = `\n\n## 【重要】現在有効なサブエージェント\nユーザー設定により、以下のサブエージェントのみが使用可能です:\n${enabledLabels.map(l => `- ${l}`).join('\n')}\n\n**上記以外のサブエージェント（OFFにされたもの）は絶対に呼び出さないでください**。呼び出し不可能です。\n`;

  const webNotice = orchestratorWeb
    ? `\n## 自分で調べるか\n必要なら自分でも WebSearch・WebFetch を使えます。ただし、まず調査役に任せることを考えてください。\n`
    : `\n## 自分で調べるか\nあなたは自分では検索もページの取得もしません。調べることは、すべて調査役に任せてください。\n`;

  return ORCHESTRATOR_PROMPT + enabledNotice + webNotice;
}

type ResearchIntentCategory =
  | 'github_explicit'
  | 'oss_lookup'
  | 'implementation_existence'
  | 'library_lookup'
  | 'reference_implementation';

interface ResearchIntent {
  category: ResearchIntentCategory;
  matchedPhrase: string;
  confidence: 'high' | 'medium' | 'low';
}

const INQUIRY = '(?:ある|探|調べ|公開|出てる|出ている|転がって|落ちて|あれば|ありそう|ありますか)';
const NEGATIVE_INQUIRY = '(?:ないか(?:な|しら)?|ないだろうか|ないでしょうか)';
const INQUIRY_ANY = `(?:${INQUIRY}|${NEGATIVE_INQUIRY})`;

const RESEARCH_INTENT_PATTERNS: Record<ResearchIntentCategory, RegExp[]> = {
  github_explicit: [
    /GitHub.{0,10}(で|上で?|から|に|を).{0,25}(調べ|探|見|チェック|調査|確認|漁)/i,
    /GitHub.{0,10}(見|覗|当たって)/,
  ],
  oss_lookup: [
    new RegExp(`(オープンソース|OSS|FOSS|オープンな実装).{0,25}${INQUIRY_ANY}`),
    /(オープンソース|OSS).{0,15}(で|の|に)(解決|実現|やれ|済ま)/,
  ],
  implementation_existence: [
    new RegExp(`(実装|実装例|ソースコード|リポジトリ|レポジトリ|OSS実装|公開コード).{0,25}${INQUIRY_ANY}`),
    /(既に|誰か|世の中に|先人が).{0,25}(作って|実装|公開|出して)/,
  ],
  library_lookup: [
    new RegExp(`(ライブラリ|パッケージ|モジュール|SDK|フレームワーク).{0,25}${INQUIRY_ANY}`),
    /\b(npm|pip|cargo|crate|gem|maven)\b.{0,25}(ある|探|調べ)/i,
  ],
  reference_implementation: [
    new RegExp(`(参考|お手本|先行事例|先行実装|リファレンス).{0,25}(?:ある|探|見|欲し|あれば|ありそう|${NEGATIVE_INQUIRY})`),
    new RegExp(`(?:参考|リファレンス)サンプル.{0,25}(?:ある|探|見|欲し|あれば|ありそう|${NEGATIVE_INQUIRY})`),
    new RegExp(`サンプル(?:コード|実装|プロジェクト|アプリ).{0,25}(?:ある|探|見|欲し|あれば|ありそう|${NEGATIVE_INQUIRY})`),
  ],
};

const NEGATION_GUARDS: RegExp[] = [
  /(調べ|探|見)(ない|ず|なくて|たくない|なくていい)/,
  /(使わ|導入し)ない/,
  /(不要|要らない|いらない|やめ|見送)/,
  /(有料|無料|有償|無償)(だけ|のみ|しか)/,
  /(しか|だけ)(使え|利用できる|利用可能)/,
];

const IMPORTANCE_MIN = 70;

const INVESTIGATION_SIGNALS: RegExp[] = [
  /[\u30A1-\u30FA\u30FC]{3,}/,
  /\d+\s*(?:年|月|日|時|%|パーセント|円|ドル|兆|億|万|件|人|台|位|度|世紀|ヶ月|年度|倍)/,
  /\b[A-Za-z]{3,}\b/,
  /(?:日本|米国|アメリカ|中国|韓国|北朝鮮|欧州|欧米|ロシア|インド|台湾|東アジア|EU|NATO|国連)/,
  /(?:内閣|政府|大臣|協定|条約|合意|法案|委員会|衆議院|参議院|省庁|議会|政党|首相|総理|大統領)/,
  /(?:と[言述]った|によると|と[報告主張]|と発表|と決定|と明言|と表明)/,
];

function hasInvestigationSignal(text: string): boolean {
  return INVESTIGATION_SIGNALS.some(re => re.test(text));
}

function detectResearchIntent(text: string): ResearchIntent | null {
  for (const guard of NEGATION_GUARDS) {
    if (guard.test(text)) return null;
  }

  const hits: { category: ResearchIntentCategory; phrase: string }[] = [];
  for (const [category, patterns] of Object.entries(RESEARCH_INTENT_PATTERNS) as [ResearchIntentCategory, RegExp[]][]) {
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        hits.push({ category, phrase: match[0] });
        break;
      }
    }
  }

  if (hits.length === 0) return null;

  const confidence: 'high' | 'medium' | 'low' =
    hits.length >= 2 ? 'high' : text.length < 20 ? 'low' : 'medium';

  return {
    category: hits[0].category,
    matchedPhrase: hits[0].phrase,
    confidence,
  };
}

export async function initializeResearchAgent(): Promise<void> {
  if (!isResearchEnabled()) {
    console.log('[research] Disabled (RESEARCH_ENABLED != true)');
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('[research] ANTHROPIC_API_KEY not set');
    return;
  }
  const config = loadResearchModelConfig();
  for (const w of config.warnings) console.warn(`[research] ${w}`);
  console.log(describeResearchModelConfig(config));
}

export function applyConfiguredModels<T extends { model?: string }>(
  agents: Record<string, T>,
  config: ResearchModelConfig,
): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [label, def] of Object.entries(agents)) {
    out[label] = { ...def, model: label === '事実確認' ? config.factCheckModel : config.haikuModel };
  }
  return out;
}

export interface ResearchSettings {
  main: boolean;
  web: boolean;
  fact: boolean;
  gap: boolean;
  tech: boolean;
}

export const DEFAULT_RESEARCH_SETTINGS: ResearchSettings = {
  main: true,
  web: true,
  fact: true,
  gap: true,
  tech: true,
};

const AGENT_KEY_BY_LABEL: Record<string, keyof ResearchSettings> = {
  '補足情報': 'web',
  '事実確認': 'fact',
  '論理課題': 'gap',
  '技術情報': 'tech',
};

class MeetingSession {
  private meetingId: number;
  private meetingType: MeetingType;
  private emitFn: EmitFn;
  public readonly userId: number;
  private transcriptBuffer: string[] = [];
  private bufferStartMs: number | null = null;
  private bufferEndMs: number | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private isProcessing = false;
  private pendingFlush = false;
  private sessionId: string | undefined;
  private aborted = false;
  private conversationHistory: string[] = [];
  private pendingExplicitIntent: ResearchIntent | null = null;

  private investigatedKeywords: Map<string, { timestamp: number; summary: string }> = new Map();

  private recentTranscripts: Array<{ timestamp: number; text: string }> = [];
  private readonly MAX_RECENT_TRANSCRIPTS = 5;
  private readonly RECENT_TRANSCRIPT_WINDOW_MS = 15 * 60 * 1000;
  private readonly RECENT_TRANSCRIPT_MAX_CHARS = 400;

  private settings: ResearchSettings;

  private researchActiveStartedAt: number | null = null;
  private researchActiveMs: number = 0;

  private lastSeenImageId: number = 0;
  private readonly MAX_NEW_IMAGES_PER_FLUSH = 3;

  constructor(
    meetingId: number,
    meetingType: MeetingType,
    emitFn: EmitFn,
    userId: number,
    settings: ResearchSettings = DEFAULT_RESEARCH_SETTINGS,
  ) {
    this.meetingId = meetingId;
    this.meetingType = meetingType;
    this.emitFn = emitFn;
    this.userId = userId;
    this.settings = settings;
    if (settings.main) {
      this.researchActiveStartedAt = Date.now();
    }
  }

  updateSettings(settings: ResearchSettings): void {
    const prevMain = this.settings.main;
    this.settings = settings;

    if (prevMain && !settings.main) {
      if (this.researchActiveStartedAt !== null) {
        this.researchActiveMs += Date.now() - this.researchActiveStartedAt;
        this.researchActiveStartedAt = null;
      }
    } else if (!prevMain && settings.main) {
      this.researchActiveStartedAt = Date.now();
    }

    logOrchestrator('settings_updated', this.meetingId, {
      main: settings.main,
      web: settings.web,
      fact: settings.fact,
      gap: settings.gap,
      tech: settings.tech,
      researchActiveMs: this.researchActiveMs,
    });
  }

  private effectiveSettings(): ResearchSettings {
    return { ...this.settings };
  }

  getResearchActiveMs(): number {
    const ongoing = this.researchActiveStartedAt !== null
      ? Date.now() - this.researchActiveStartedAt
      : 0;
    return this.researchActiveMs + ongoing;
  }

  private normalizeKeyword(kw: string): string {
    return kw.toLowerCase().trim().replace(/\s+/g, ' ');
  }

  private getRecentlyInvestigated(windowMs = 10 * 60 * 1000): Array<{ keyword: string; minutesAgo: number; summary: string }> {
    const now = Date.now();
    const result: Array<{ keyword: string; minutesAgo: number; summary: string }> = [];
    for (const [kw, entry] of this.investigatedKeywords) {
      const elapsed = now - entry.timestamp;
      if (elapsed < windowMs) {
        result.push({ keyword: kw, minutesAgo: Math.round(elapsed / 60000), summary: entry.summary });
      } else {
        this.investigatedKeywords.delete(kw);
      }
    }
    return result;
  }

  private makeInvestigatedSummary(title: string, body: string): string {
    const t = (title ?? '').trim().slice(0, 60);
    const b = (body ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
    return `${t}｜${b}`;
  }

  private appendToRecentTranscripts(text: string): void {
    const now = Date.now();
    const trimmed = text.length > this.RECENT_TRANSCRIPT_MAX_CHARS
      ? text.slice(0, this.RECENT_TRANSCRIPT_MAX_CHARS) + '…'
      : text;
    this.recentTranscripts.push({ timestamp: now, text: trimmed });
    this.recentTranscripts = this.recentTranscripts.filter(
      e => now - e.timestamp < this.RECENT_TRANSCRIPT_WINDOW_MS
    );
    if (this.recentTranscripts.length > this.MAX_RECENT_TRANSCRIPTS) {
      this.recentTranscripts = this.recentTranscripts.slice(-this.MAX_RECENT_TRANSCRIPTS);
    }
  }

  private getRecentTranscriptsBlock(): string {
    if (this.recentTranscripts.length === 0) return '';
    const now = Date.now();
    const body = this.recentTranscripts.map(entry => {
      const minutesAgo = Math.max(1, Math.round((now - entry.timestamp) / 60000));
      return `[約${minutesAgo}分前]\n${entry.text}`;
    }).join('\n---\n');
    return `\n\n## 会議直近の発言履歴（矛盾検出用・直近 15 分）\n**現在の発言がこれら過去の主張と矛盾していないか必ず確認してください**。矛盾があれば論理課題エージェントに検証させること。\n\n${body}`;
  }

  private async buildNewImageSupplementary(): Promise<string> {
    try {
      const rows = await db
        .select({
          id: meetingImages.id,
          fileName: meetingImages.fileName,
          aiAnalysis: meetingImages.aiAnalysis,
        })
        .from(meetingImages)
        .where(eq(meetingImages.meetingId, this.meetingId))
        .orderBy(meetingImages.id);

      const eligible = rows.filter(
        (r) => r.id > this.lastSeenImageId && r.aiAnalysis,
      );
      if (eligible.length === 0) return '';

      const toUse = eligible.slice(0, this.MAX_NEW_IMAGES_PER_FLUSH);
      const maxIdConsumed = toUse[toUse.length - 1].id;
      this.lastSeenImageId = maxIdConsumed;

      const parts = toUse.map(
        (r, i) =>
          `【新規画像${i + 1}: ${r.fileName ?? '無題'}】\n${r.aiAnalysis}`,
      );
      const body = `\n\n## 直前に追加された参考画像（AI 分析テキスト）\n** これらは初出の補足資料です。文字起こしと突き合わせ INSIGHT の文脈として参照してください。**\n\n${parts.join('\n\n')}`;

      logOrchestrator('supplementary_built', this.meetingId, {
        scope: 'incremental_new_images',
        images: toUse.length,
        chars: body.length,
        lastSeenImageId: this.lastSeenImageId,
        deferred: eligible.length - toUse.length,
      });
      return body;
    } catch (err) {
      logOrchestrator('supplementary_fetch_failed', this.meetingId, {
        error: err instanceof Error ? err.message : String(err),
      });
      return '';
    }
  }

  sendTranscript(text: string, transcriptStartMs?: number, transcriptEndMs?: number): void {
    this.transcriptBuffer.push(text);
    if (typeof transcriptStartMs === 'number') {
      if (this.bufferStartMs === null || transcriptStartMs < this.bufferStartMs) {
        this.bufferStartMs = transcriptStartMs;
      }
    }
    if (typeof transcriptEndMs === 'number') {
      if (this.bufferEndMs === null || transcriptEndMs > this.bufferEndMs) {
        this.bufferEndMs = transcriptEndMs;
      }
    }

    let intent = detectResearchIntent(text);
    if (!intent && this.transcriptBuffer.length >= 2) {
      const recent = this.transcriptBuffer.slice(-3).join(' ');
      intent = detectResearchIntent(recent);
    }
    if (intent && !this.pendingExplicitIntent) {
      this.pendingExplicitIntent = intent;
      logOrchestrator('explicit_intent_detected', this.meetingId, {
        category: intent.category,
        phraseLen: intent.matchedPhrase.length,
        confidence: intent.confidence,
      });

      this.emitAckCard(intent);

    }

    if (!this.debounceTimer) {
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null;
        this.tryFlushBuffer();
      }, 180000);
    }
  }

  private emitAckCard(intent: ResearchIntent): void {
    const card: ResearchCard = {
      id: uuidv4(),
      cardType: 'info',
      agentType: 'tech',
      keyword: 'research-intent-ack',
      title: '🔍 GitHub/OSS調査を開始します',
      body: `話者のリクエスト「${intent.matchedPhrase}」を検知しました。候補リポジトリの調査と技術選定レビューを準備中です...`,
      importance: 95,
      sources: [],
      timestamp: Date.now(),
      metadata: {
        kind: 'acknowledgment',
        trigger: 'explicit-intent',
        triggerCategory: intent.category,
        triggerPhrase: intent.matchedPhrase,
        confidence: intent.confidence,
        ephemeral: true,
      },
      meetingId: this.meetingId,
    };
    this.emitFn('research_insight', card);

    db.insert(researchInsights).values({
      meetingId: this.meetingId,
      agentType: card.agentType,
      cardType: card.cardType,
      keyword: card.keyword,
      content: JSON.stringify({ title: card.title, body: card.body, sources: card.sources }),
      importance: card.importance,
      status: 'active',
      metadata: card.metadata ?? {},
    }).catch(err => console.error('[research] ACK DB save error:', err));

    logOrchestrator('ack_emitted', this.meetingId, {
      intent: intent.category,
      confidence: intent.confidence,
    });
  }

  private async tryFlushBuffer(): Promise<void> {
    if (this.isProcessing) {
      this.pendingFlush = true;
      logOrchestrator('flush_deferred', this.meetingId, { reason: 'processing' });
      return;
    }
    await this.doFlushBuffer();
  }

  private async doFlushBuffer(): Promise<void> {
    if (this.transcriptBuffer.length === 0 || this.aborted) return;

    if (!this.settings.main) {
      this.transcriptBuffer = [];
      this.bufferStartMs = null;
      this.bufferEndMs = null;
      this.pendingFlush = false;
      logOrchestrator('skip_research_disabled', this.meetingId, { reason: 'main_off' });
      return;
    }

    const effSettings = this.effectiveSettings();
    const enabledSubagents = Object.entries(AGENT_KEY_BY_LABEL)
      .filter(([_, key]) => effSettings[key])
      .map(([label]) => label);
    if (enabledSubagents.length === 0) {
      this.transcriptBuffer = [];
      this.bufferStartMs = null;
      this.bufferEndMs = null;
      this.pendingFlush = false;
      logOrchestrator('skip_research_disabled', this.meetingId, { reason: 'all_subagents_off' });
      return;
    }

    const combined = this.transcriptBuffer.join('\n');
    const flushTranscriptStartMs = this.bufferStartMs;
    const flushTranscriptEndMs = this.bufferEndMs;
    this.transcriptBuffer = [];
    this.bufferStartMs = null;
    this.bufferEndMs = null;
    this.pendingFlush = false;

    const intent = this.pendingExplicitIntent;
    this.pendingExplicitIntent = null;

    const meaningful = combined.replace(/[\s。、！？…]+/g, '');
    if (!intent && meaningful.length < 50) {
      logOrchestrator('transcript_skipped', this.meetingId, { reason: 'too_short', length: meaningful.length });
      return;
    }

    const fillerPatterns = /^(はい|うん|ええ|そうですね|なるほど|ありがとう|お疲れ様|よろしく|失礼します|。|、)+$/;
    if (!intent && fillerPatterns.test(meaningful)) {
      logOrchestrator('transcript_skipped', this.meetingId, { reason: 'filler_only' });
      return;
    }

    if (!intent && meaningful.length < 200 && !hasInvestigationSignal(combined)) {
      logOrchestrator('transcript_skipped', this.meetingId, {
        reason: 'no_investigation_signal',
        length: meaningful.length,
      });
      return;
    }

    this.isProcessing = true;
    logOrchestrator('transcript_sent', this.meetingId, { length: combined.length, intent: intent?.category, enabledAgents: enabledSubagents });

    let subagentsThisFlush = 0;
    const pendingResearchIds = new Set<string>();

    try {
      const basePriorities = AGENT_PRIORITIES[this.meetingType] ?? AGENT_PRIORITIES.general;
      const priorities = intent
        ? Array.from(new Set<AgentType>(['tech', ...basePriorities]))
        : basePriorities;

      const intentTag = intent
        ? `[EXPLICIT_RESEARCH_INTENT: category=${intent.category}, phrase="${intent.matchedPhrase}", confidence=${intent.confidence}]\n\n`
        : '';

      const recentlyInvestigated = this.getRecentlyInvestigated();
      const dedupeContext = recentlyInvestigated.length > 0
        ? `\n\n## 直近10分で調査済みのエンティティ（再調査禁止）\n${recentlyInvestigated.map(({ keyword, minutesAgo, summary }) => `- **${keyword}**（${minutesAgo}分前）: ${summary}`).join('\n')}\n\n**重要ルール**:\n1. 上記エンティティは **subagent に投げ直さない**（再調査コストの無駄）\n2. transcript で同じ話題が繰り返されているだけなら INSIGHT を出さず次へ\n3. ただし「新しい数値・異なる側面・新たな主張」が transcript に含まれる場合のみ再調査可`
        : '';

      const historyBlock = this.getRecentTranscriptsBlock();

      const newImageBlock = await this.buildNewImageSupplementary();

      const prompt = `${intentTag}【文字起こし】\n${combined}${newImageBlock}\n\n会議タイプ: ${this.meetingType}、優先エージェント: ${priorities.join(', ')}${dedupeContext}${historyBlock}`;

      this.appendToRecentTranscripts(combined);

      const modelConfig = loadResearchModelConfig();
      const activeAgents: Record<string, typeof SUB_AGENTS[keyof typeof SUB_AGENTS]> = {};
      for (const [label, def] of Object.entries(SUB_AGENTS)) {
        const key = AGENT_KEY_BY_LABEL[label];
        if (key && effSettings[key]) {
          activeAgents[label] = def;
        }
      }

      const researchQueryParams: Parameters<typeof runResearchQuery>[1] = {
        agents: applyConfiguredModels(activeAgents, modelConfig),
        systemPrompt: buildFilteredOrchestratorPrompt(effSettings, modelConfig.orchestratorWeb),
        model: modelConfig.orchestratorModel,
        effort: modelConfig.orchestratorEffort,
        orchestratorWeb: modelConfig.orchestratorWeb,
      };

      for await (const message of runResearchQuery(prompt, researchQueryParams)) {
        if (this.aborted) break;

        if ((message as any).type === 'system' && (message as any).subtype === 'init') {
          this.sessionId = (message as any).session_id;
          logOrchestrator('session_created', this.meetingId, { sessionId: this.sessionId });
        }

        if ((message as any).message?.content) {
          for (const block of (message as any).message.content) {
            if (block.type === 'tool_use' && (block.name === 'Agent' || block.name === 'Task')) {
              const subagentType = block.input?.subagent_type || block.input?.description?.substring(0, 50);
              logOrchestrator('subagent_invoked', this.meetingId, { subagentType });
              subagentsThisFlush++;
              if (block.id) pendingResearchIds.add(block.id as string);
            }
          }
        }

        if ((message as any).message?.content) {
          for (const block of (message as any).message.content) {
            if (block.type !== 'tool_result' || !pendingResearchIds.has(block.tool_use_id)) continue;
            pendingResearchIds.delete(block.tool_use_id);
            if (block.is_error) {
              logOrchestrator('research_failed', this.meetingId, { toolUseId: block.tool_use_id });
            }
          }
        }

        if ((message as any).parent_tool_use_id) {
          logOrchestrator('subagent_message', this.meetingId, {
            parentId: (message as any).parent_tool_use_id,
          });
        }

        const msgType = (message as any).type;
        if (msgType && msgType !== 'assistant') {
          logOrchestrator('message_type', this.meetingId, { type: msgType, subtype: (message as any).subtype });
        }

        if ((message as any).message?.content) {
          for (const block of (message as any).message.content) {
            if (block.type === 'text' && block.text) {
              const text = block.text as string;
              if (text.includes('INSIGHT:') || text.length > 50) {
                logOrchestrator('agent_text', this.meetingId, { textLen: text.length });
              }
              this.extractAndSaveInsights(
                text,
                {
                  transcriptStartMs: flushTranscriptStartMs,
                  transcriptEndMs: flushTranscriptEndMs,
                },
                !intent,
              );
            }
          }
        }

        const flushCost = summarizeResultCost(message);
        if (flushCost) {
          logOrchestrator('flush_cost', this.meetingId, { subagents: subagentsThisFlush, ...flushCost });
          auditResearchCost('research.flush', this.userId, this.meetingId, flushCost, { subagents: subagentsThisFlush });
        }

        if ('result' in message) {
          const resultText = (message as any).result;
          logOrchestrator('result_received', this.meetingId, {
            length: resultText?.length ?? 0,
          });

          const usage = (message as any).usage ?? (message as any).apiUsage ?? null;
          if (usage) {
            const input = usage.input_tokens ?? usage.inputTokens ?? 0;
            const output = usage.output_tokens ?? usage.outputTokens ?? 0;
            const cacheRead = usage.cache_read_input_tokens ?? usage.cacheReadInputTokens ?? 0;
            const cacheCreate = usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens ?? 0;
            const totalInput = input + cacheRead + cacheCreate;
            const cacheHitRate = totalInput > 0 ? Math.round((cacheRead / totalInput) * 100) : 0;
            logOrchestrator('api_usage', this.meetingId, {
              input_tokens: input,
              output_tokens: output,
              cache_read: cacheRead,
              cache_create: cacheCreate,
              total_input: totalInput,
              cache_hit_pct: cacheHitRate,
            });
          }
        }
      }
    } catch (error) {
      if (!this.aborted) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[research] Agent query error: ${msg}`);
      }
    } finally {
      this.isProcessing = false;
      if (this.pendingFlush || this.transcriptBuffer.length > 0) {
        if (!this.debounceTimer && !this.aborted) {
          this.debounceTimer = setTimeout(() => {
            this.debounceTimer = null;
            this.tryFlushBuffer();
          }, 180000);
        }
      }
    }
  }

  private extractAndSaveInsights(
    resultText: string,
    extraMetadata: Record<string, unknown> = {},
    enforceImportanceFloor = true,
  ): number {
    let saved = 0;
    const lines = resultText.split('\n');
    for (const line of lines) {
      const match = line.match(/INSIGHT:\s*(\{.*\})/);
      if (!match) continue;

      try {
        const input = JSON.parse(match[1]);

        const importance = Math.min(100, Math.max(0, input.importance ?? 50));
        if (enforceImportanceFloor && importance < IMPORTANCE_MIN) {
          logOrchestrator('insight_dropped_low_importance', this.meetingId, {
            importance,
            threshold: IMPORTANCE_MIN,
            cardType: input.cardType ?? 'info',
            agentType: input.agentType ?? 'web',
          });
          continue;
        }

        const card: ResearchCard = {
          id: uuidv4(),
          cardType: input.cardType ?? 'info',
          agentType: input.agentType ?? 'web',
          keyword: input.keyword ?? '',
          title: input.title ?? '',
          body: input.body ?? '',
          importance,
          sources: sanitizeResearchSources(input.sources),
          timestamp: Date.now(),
          metadata: {
            agentSdk: true,
            multiAgent: true,
            ...(input.cardType === 'fact-check' && typeof input.verdict === 'string'
              ? { verdict: input.verdict }
              : {}),
            ...extraMetadata,
          },
          meetingId: this.meetingId,
        };

        this.emitFn('research_insight', card);

        db.insert(researchInsights).values({
          meetingId: this.meetingId,
          agentType: card.agentType,
          cardType: card.cardType,
          keyword: card.keyword,
          content: JSON.stringify({ title: card.title, body: card.body, sources: card.sources }),
          importance: card.importance,
          status: 'active',
          metadata: card.metadata ?? {},
        }).catch(err => console.error('[research] DB save error:', err));

        logOrchestrator('insight_saved', this.meetingId, {
          cardType: card.cardType,
          agentType: card.agentType,
          keyword: card.keyword,
          importance: card.importance,
        });

        if (card.keyword && card.keyword !== 'research-intent-ack') {
          this.investigatedKeywords.set(this.normalizeKeyword(card.keyword), {
            timestamp: Date.now(),
            summary: this.makeInvestigatedSummary(card.title, card.body),
          });
        }
        saved++;
      } catch (e) {
      }
    }
    return saved;
  }

  async close(): Promise<void> {
    logOrchestrator('session_closing', this.meetingId, { researchActiveMs: this.getResearchActiveMs() });
    this.aborted = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.researchActiveStartedAt !== null) {
      this.researchActiveMs += Date.now() - this.researchActiveStartedAt;
      this.researchActiveStartedAt = null;
    }
    logOrchestrator('session_closed', this.meetingId);
  }

  async runManualResearch(combinedText: string, headings: string[]): Promise<{ ok: boolean; error?: string; cardCount?: number }> {
    if (this.isProcessing) {
      this.emitFn('manual_research_done', { ok: false, error: 'busy', meetingId: this.meetingId });
      return { ok: false, error: 'busy' };
    }

    this.isProcessing = true;
    this.emitFn('manual_research_started', { meetingId: this.meetingId });
    logOrchestrator('manual_research_start', this.meetingId, {
      length: combinedText.length,
      headingCount: headings.length,
    });

    let totalSaved = 0;

    try {
      const manualSettings: ResearchSettings = {
        main: true, web: true, fact: true, gap: true, tech: true,
      };

      const basePriorities = AGENT_PRIORITIES[this.meetingType] ?? AGENT_PRIORITIES.general;
      const priorities = basePriorities;

      const recentlyInvestigated = this.getRecentlyInvestigated();
      const dedupeContext = recentlyInvestigated.length > 0
        ? `\n\n## 直近10分で調査済みのエンティティ（再調査禁止）\n${recentlyInvestigated.map(({ keyword, minutesAgo, summary }) => `- **${keyword}**（${minutesAgo}分前）: ${summary}`).join('\n')}\n\n**重要ルール**: 上記エンティティは subagent に投げ直さないでください。`
        : '';

      const headingsBlock = headings.length > 0
        ? `\n\n## 調査対象セクション（ユーザーが選択）\n${headings.map(h => `- ${h}`).join('\n')}`
        : '';

      const manualTag = '[MANUAL_RESEARCH: ユーザー指定の過去発言を分析してください]\n\n';
      const prompt = `${manualTag}【文字起こし（選択範囲）】\n${combinedText}\n\n会議タイプ: ${this.meetingType}、優先エージェント: ${priorities.join(', ')}${dedupeContext}${headingsBlock}`;

      const modelConfig = loadResearchModelConfig();
      const activeAgents: Record<string, typeof SUB_AGENTS[keyof typeof SUB_AGENTS]> = {};
      for (const [label, def] of Object.entries(SUB_AGENTS)) {
        const key = AGENT_KEY_BY_LABEL[label];
        if (key && !manualSettings[key]) continue;
        activeAgents[label] = def;
      }

      const researchQueryParams: Parameters<typeof runResearchQuery>[1] = {
        agents: applyConfiguredModels(activeAgents, modelConfig),
        systemPrompt: buildFilteredOrchestratorPrompt(manualSettings, modelConfig.orchestratorWeb),
        model: modelConfig.orchestratorModel,
        effort: modelConfig.orchestratorEffort,
        orchestratorWeb: modelConfig.orchestratorWeb,
      };

      let manualSubagents = 0;
      for await (const message of runResearchQuery(prompt, researchQueryParams)) {
        if (this.aborted) break;

        if ((message as any).message?.content) {
          for (const block of (message as any).message.content) {
            if (block.type === 'text' && block.text) {
              totalSaved += this.extractAndSaveInsights(block.text as string, { origin: 'manual' }, false);
            }
            if (block.type === 'tool_use' && (block.name === 'Agent' || block.name === 'Task')) {
              manualSubagents++;
            }
          }
        }

        const manualCost = summarizeResultCost(message);
        if (manualCost) {
          logOrchestrator('manual_research_cost', this.meetingId, {
            input_chars: combinedText.length, sections: headings.length, subagents: manualSubagents, ...manualCost,
          });
          auditResearchCost('research.manual_research', this.userId, this.meetingId, manualCost, { subagents: manualSubagents });
        }

        if ('result' in message) {
          const usage = (message as any).usage ?? (message as any).apiUsage ?? null;
          if (usage) {
            const input = usage.input_tokens ?? usage.inputTokens ?? 0;
            const output = usage.output_tokens ?? usage.outputTokens ?? 0;
            const cacheRead = usage.cache_read_input_tokens ?? usage.cacheReadInputTokens ?? 0;
            const cacheCreate = usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens ?? 0;
            logOrchestrator('manual_research_usage', this.meetingId, {
              input_tokens: input, output_tokens: output, cache_read: cacheRead, cache_create: cacheCreate,
            });
          }
        }
      }

      logOrchestrator('manual_research_done', this.meetingId, { cardCount: totalSaved });
      this.emitFn('manual_research_done', { ok: true, cardCount: totalSaved, meetingId: this.meetingId });
      return { ok: true, cardCount: totalSaved };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[research] Manual research error: ${msg}`);
      logOrchestrator('manual_research_error', this.meetingId, { error: msg });
      this.emitFn('manual_research_done', { ok: false, error: msg, meetingId: this.meetingId });
      return { ok: false, error: msg };
    } finally {
      this.isProcessing = false;
    }
  }
}

const activeSessions = new Map<number, MeetingSession>();

export async function fetchUserResearchSettings(userId: number): Promise<ResearchSettings> {
  try {
    const [row] = await db
      .select({ researchSettings: users.researchSettings })
      .from(users)
      .where(eq(users.id, userId));
    if (!row) return DEFAULT_RESEARCH_SETTINGS;
    return { ...DEFAULT_RESEARCH_SETTINGS, ...((row.researchSettings as Partial<ResearchSettings>) ?? {}) };
  } catch (e) {
    console.error('[research] fetchUserResearchSettings failed:', e instanceof Error ? e.message : String(e));
    return DEFAULT_RESEARCH_SETTINGS;
  }
}

function auditResearchCost(feature: string, userId: number, meetingId: number, cost: Record<string, unknown>, extra: Record<string, unknown>): void {
  const models = (cost.models ?? {}) as Record<string, { input?: number; output?: number; cache_read?: number; cache_create?: number }>;
  const sum = (k: 'input' | 'output' | 'cache_read' | 'cache_create') =>
    Object.values(models).reduce((a, m) => a + (m?.[k] ?? 0), 0);
  auditLlmCall({
    feature,
    model: Object.keys(models).join(',') || null,
    inputTokens: sum('input'),
    outputTokens: sum('output'),
    cacheReadTokens: sum('cache_read'),
    cacheCreationTokens: sum('cache_create'),
    costUsd: typeof cost.total_cost_usd === 'number' ? cost.total_cost_usd : null,
    userId,
    meetingId,
    ok: cost.subtype === 'success',
    extra: { ...extra, webSearchRequests: cost.web_search_requests ?? 0, numTurns: cost.num_turns ?? null },
  });
}

function summarizeResultCost(message: any): Record<string, unknown> | null {
  if (!message || message.type !== 'result') return null;
  const models: Record<string, unknown> = {};
  let webSearch = 0;
  for (const [model, u] of Object.entries((message.modelUsage ?? {}) as Record<string, any>)) {
    webSearch += u.webSearchRequests ?? 0;
    models[model] = {
      cost_usd: u.costUSD ?? 0,
      input: u.inputTokens ?? 0,
      output: u.outputTokens ?? 0,
      cache_read: u.cacheReadInputTokens ?? 0,
      cache_create: u.cacheCreationInputTokens ?? 0,
      web_search: u.webSearchRequests ?? 0,
    };
  }
  return {
    subtype: message.subtype,
    total_cost_usd: message.total_cost_usd ?? null,
    web_search_requests: webSearch,
    num_turns: message.num_turns ?? null,
    models,
  };
}

async function getOrCreateSession(
  meetingId: number,
  meetingType: MeetingType,
  emitFn: EmitFn,
  userId: number
): Promise<MeetingSession> {
  let session = activeSessions.get(meetingId);
  if (session) return session;

  const settings = await fetchUserResearchSettings(userId);
  session = new MeetingSession(meetingId, meetingType, emitFn, userId, settings);
  activeSessions.set(meetingId, session);
  return session;
}

export async function onFinalTranscript(
  text: string,
  meetingId: number,
  userId: number,
  _meetingStartTime: number,
  meetingType: MeetingType,
  emitFn: EmitFn,
  transcriptStartMs?: number,
  transcriptEndMs?: number,
): Promise<void> {
  if (!isResearchEnabled() || !process.env.ANTHROPIC_API_KEY) return;
  try {
    const session = await getOrCreateSession(meetingId, meetingType, emitFn, userId);
    session.sendTranscript(text, transcriptStartMs, transcriptEndMs);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[research] onFinalTranscript error: ${msg}`);
  }
}

export function updateResearchSettingsForUser(userId: number, settings: ResearchSettings): number {
  let count = 0;
  for (const session of activeSessions.values()) {
    if (session.userId === userId) {
      session.updateSettings(settings);
      count++;
    }
  }
  if (count > 0) {
    logOrchestrator('settings_live_updated', 0, { userId, sessionsUpdated: count, ...settings });
  }
  return count;
}

export async function cleanupResearch(meetingId: number): Promise<void> {
  const session = activeSessions.get(meetingId);
  if (session) {
    await session.close();
    activeSessions.delete(meetingId);
  }
  logOrchestrator('cleanup', meetingId);
}

export async function runManualResearch(
  meetingId: number,
  userId: number,
  meetingType: MeetingType,
  combinedText: string,
  headings: string[],
  emitFn: EmitFn,
  options?: { forceTempSession?: boolean },
): Promise<{ ok: boolean; error?: string; cardCount?: number }> {
  if (!isResearchEnabled() || !process.env.ANTHROPIC_API_KEY) {
    return { ok: false, error: 'research_disabled_on_server' };
  }

  if (!options?.forceTempSession) {
    const existing = activeSessions.get(meetingId);
    if (existing) {
      return await existing.runManualResearch(combinedText, headings);
    }
  }

  const settings = await fetchUserResearchSettings(userId);
  const session = new MeetingSession(meetingId, meetingType, emitFn, userId, settings);
  try {
    return await session.runManualResearch(combinedText, headings);
  } finally {
    await session.close().catch(() => undefined);
  }
}
