import { ThinkingLevel } from '@google/genai';
import { createGenAI } from './llm/genaiClient.js';
import { AppError, BadRequestError } from '../errors/AppError.js';
import {
  buildGrarecoInput,
  buildGrarecoPrompt,
  buildRevisePrompt,
  loadGrarecoReferenceImages,
  type GrarecoReferenceImage,
} from './grareco/grarecoPrompt.js';
import {
  DEFAULT_GRARECO_MODEL,
  GEMINI_IMAGE_COST_USD,
  buildAttemptLadder,
  decideAspectRatio,
  geminiImageCostUsd,
  grarecoRefImageCount,
  readImageDimensions,
  readImageTokenCount,
  type GrarecoImageResult,
} from './grareco/imageOutput.js';
import {
  applyThemeGroups,
  assembleSummaryMarkdown,
  findLostLines,
  formatThemeHeading,
  isSupplementaryTheme,
  lastRegularThemeIndex,
  mergeSummaryParts,
  parseSummaryIntoThemes,
  renumberThemes,
  separateSupplementary,
  type SummaryTheme,
  type ThemeGroup,
} from './summaryThemes.js';
import { headingStartSec, insertSectionChronologically } from './summaryAppendService.js';
import { auditGeminiCall } from './audit/audit.js';
import { callerName } from './audit/callerName.js';

const ai = createGenAI({
  httpOptions: { timeout: 120_000 },
});

{
  const rawGenerateContent = ai.models.generateContent.bind(ai.models);
  (ai.models as unknown as { generateContent: (req: unknown) => Promise<unknown> }).generateContent =
    async (req: any) => {
      const caller = callerName(2);
      const res: any = await rawGenerateContent(req);
      try {
        const u = res?.usageMetadata ?? {};
        console.log(`[gemini:usage] ${JSON.stringify({
          op: caller,
          model: req?.model,
          input: u.promptTokenCount ?? 0,
          output: u.candidatesTokenCount ?? 0,
          thoughts: u.thoughtsTokenCount ?? 0,
          cached: u.cachedContentTokenCount ?? 0,
          total: u.totalTokenCount ?? 0,
        })}`);
        auditGeminiCall(`gemini:${caller}`, req?.model, res);
      } catch {
      }
      return res;
    };
}

const MODEL_FLASH = 'gemini-3-flash-preview';
const MODEL_IMAGE = DEFAULT_GRARECO_MODEL;

export type AnalysisType =
  | 'minutes'
  | 'research'
  | 'summary'
  | 'logic'
  | 'expert'
  | 'user'
  | 'creator'
  | 'graphic'
  | 'grareco';

export interface AnalysisImage {
  data: string;
  mimeType: string;
}

const MAX_IMAGES = 3;
const MAX_TOTAL_IMAGE_SIZE = 20 * 1024 * 1024;

export function validateImages(images: AnalysisImage[]): { valid: boolean; error?: string } {
  if (images.length > MAX_IMAGES) {
    return { valid: false, error: `画像は最大${MAX_IMAGES}枚まで添付できます（${images.length}枚が選択されています）` };
  }
  let totalSize = 0;
  for (const img of images) {
    if (!img.mimeType || !img.mimeType.startsWith('image/')) {
      return { valid: false, error: `無効な画像形式です: ${img.mimeType || '不明'}` };
    }
    if (!img.data || img.data.length === 0) {
      return { valid: false, error: '画像データが空です' };
    }
    const sizeBytes = Math.ceil((img.data.length * 3) / 4);
    totalSize += sizeBytes;
  }
  if (totalSize > MAX_TOTAL_IMAGE_SIZE) {
    const sizeMB = (totalSize / (1024 * 1024)).toFixed(1);
    return { valid: false, error: `画像の合計サイズが上限を超えています（${sizeMB}MB / 上限20MB）。画像を圧縮するか枚数を減らしてください` };
  }
  return { valid: true };
}

export async function generateMeetingTitle(summaryContent: string): Promise<string> {
  try {
    const prompt = `以下は会議の構造化サマリーです。この会議の内容を最も的確に表す短い会議タイトルを1つだけ生成してください。

ルール:
- サマリー本文と同じ言語の簡潔なタイトル（日本語なら15文字以内）。翻訳や言語の変更はしない
- 会議の主要テーマや目的を反映
- 「会議」「ミーティング」などの一般的な語は不要
- タイトルのみを出力（説明や引用符は不要）

サマリー:
${summaryContent.substring(0, 2000)}`;

    const response = await ai.models.generateContent({
      model: MODEL_FLASH,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        maxOutputTokens: 100,
        thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
      },
    });

    const title = (response.text || '').trim().replace(/^[「『"']|[」』"']$/g, '');
    return title || '';
  } catch (error) {
    console.error('Auto title generation error:', error);
    return '';
  }
}

export async function generateMeetingMinutes(
  summaryContent: string,
  transcriptText: string,
  participants?: Array<{ name: string; gender?: string; age?: string; other?: string }> | null,
  supplementaryContext?: string | null
): Promise<string> {
  const validParticipants = (participants || []).filter(
    (p) => p && p.name && String(p.name).trim()
  );
  const participantInfo =
    validParticipants.length > 0
      ? `\n【参加者】\n${validParticipants.map((p) => `- ${String(p.name).trim()}`).join('\n')}\n`
      : '';

  const supplementarySection = supplementaryContext
    ? `\n【補足資料（参加者メモ・画像分析）】\n${supplementaryContext}\n`
    : '';

  const prompt = `あなたは会議の議事録を作成する専門家です。以下の情報源すべてを統合して、メールで送信するための正式な議事録を作成してください。

★重要ルール:
- 【構造化サマリー】と【全文書き起こし】が議事録の主軸です。これらの内容を必ず反映してください。
- 【補足資料】は参加者が会議中にアップロードした画像やメモです。議事録の補足情報として活用してください。
- すべての情報源の内容を漏れなく統合してください。一部の情報源だけに偏らないでください。
- 議事録は【全文書き起こし】の発話と同じ言語で書いてください（日本語の会議なら日本語）。翻訳や言語の変更はしないでください。

${participantInfo}
【構造化サマリー（主軸）】
${summaryContent}

【全文書き起こし（主軸）】
${transcriptText}
${supplementarySection}
以下の形式で議事録を作成してください（プレーンテキストで、Markdownの装飾は最小限に）:

# 議事録

## 決定事項
・（会議で決まったこと）

## アクションアイテム（宿題）
・（誰が・何を・いつまでに）

## 議論の概要
・（テーマごとに要点を整理）

## 次のステップ
・（今後の予定やフォローアップ事項）

※ 簡潔かつ正確に、要点を押さえた議事録にしてください。`;

  try {
    const response = await ai.models.generateContent({
      model: MODEL_FLASH,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: { maxOutputTokens: 4000 },
    });
    return response.text || '議事録を生成できませんでした。';
  } catch (error) {
    console.error('Meeting minutes generation error:', error);
    throw new AppError(500, '議事録の生成に失敗しました。');
  }
}

interface AnalysisConfig {
  systemPrompt?: string;
  userPrompt: string;
  maxOutputTokens: number;
}

export function buildAnalysisRequest(
  config: AnalysisConfig,
  userPrompt: string,
  images?: AnalysisImage[]
): {
  model: string;
  contents: Array<{ role: string; parts: any[] }>;
  config: {
    maxOutputTokens: number;
    systemInstruction?: string;
  };
} {
  const parts: any[] = [{ text: userPrompt }];
  for (const img of images ?? []) {
    parts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
  }
  return {
    model: MODEL_FLASH,
    contents: [{ role: 'user', parts }],
    config: {
      maxOutputTokens: config.maxOutputTokens,
      ...(config.systemPrompt ? { systemInstruction: config.systemPrompt } : {}),
    },
  };
}

export function getAnalysisConfigForTest(type: string): AnalysisConfig | undefined {
  return analysisConfigs[type];
}

const analysisConfigs: Record<string, AnalysisConfig> = {
  minutes: {
    systemPrompt: 'あなたは会議の議事録を作成する専門家です。与えられたデータから、重要な情報を構造化して整理します。',
    userPrompt: `以下は会議の関連データです。提供されたすべての情報源（サマリー、文字起こし、画像分析結果、メモ等）の内容を漏れなく統合して、以下の項目にまとめてください。

（重要：出力はプレーンテキストとして読みやすくするため、Markdown の装飾（「**」による太字、ネストされた箇条書き「* 」など）は一切使用しないでください。単純な箇条書き（「・」）で記述してください。項目は目立つように表記して下さい。）

# 決定事項
・（会議で決まったこと）

# アクションアイテム（宿題）
・（誰が・何を・いつまでに）

# 議論の概要
・（テーマごとに要点を整理）

# 次のステップ
・（今後の予定やフォローアップ事項）

※ 簡潔かつ正確に、要点を押さえた議事録にしてください。

---
【会議データ】
`,
    maxOutputTokens: 8000,
  },

  research: {
    systemPrompt:
      'あなたは効率的な情報調査の専門家です。提供されたテキストについて詳細に調査し、主要キーワード、要約、深掘り情報のすべてのセクションを必ず含めて回答してください。プレースホルダー（[最重要キーワード]等）は具体的な内容に置き換え、空白セクションは絶対に作らないでください。',
    userPrompt: `提供されたテキストについて、重要なキーワードを深く調査してください。

以下の形式で詳細に回答してください：

# 🔍 リサーチ結果

## 主要キーワード
- **[最重要キーワード]**: [詳細な説明と背景情報]
- **[第二キーワード]**: [詳細な説明と背景情報]
- **[第三キーワード]**: [関連する追加情報]

## 要約
[テキストの内容を4-5行で詳しくまとめる]

## 深掘り情報
[専門的な視点や関連する知識、応用例などを2-3行で追加]

---
【分析対象テキスト】
`,
    maxOutputTokens: 8000,
  },

  summary: {
    userPrompt: `以下の内容を分析してください:

**構造化まとめ**

以下の観点から内容を整理・構造化してください：
• 主要なポイントと要約
• 重要な情報の階層化と分類
• 関連項目のグループ分け
• アクションアイテムや次のステップ
• 重要度や優先度の整理

読みやすく構造化された形で、マークダウン形式で整理してください。(400文字程度)

---
【分析対象テキスト】
`,
    maxOutputTokens: 8000,
  },

  logic: {
    userPrompt: `以下の内容を分析してください:

**論理構造の詳細分析**

論理的思考の専門家として以下を厳密に分析してください：
• 議論の論理的な流れと構造
• 因果関係の妥当性
• 前提条件と結論の整合性
• 論理の飛躍や矛盾点
• 根拠が不十分な主張
• 検証が必要な仮定

論理的な欠陥を具体的に指摘し、より堅牢な論理構造を提案してください。(400文字程度)

---
【分析対象テキスト】
`,
    maxOutputTokens: 8000,
  },

  expert: {
    userPrompt: `以下の内容を専門家の視点から分析してください:

専門的観点から見た情報ギャップ、改善提案、リスク、見落とされている重要事項を指摘してください。
マークダウン形式で、箇条書きを使って整理してください。

---
【分析対象テキスト】
`,
    maxOutputTokens: 8000,
  },

  user: {
    userPrompt: `以下の内容をユーザー・現場担当者の視点から分析してください:

実際のユーザーや現場担当者の立場から、実用的な実装課題、使いやすさ、現実的な懸念点を分析してください。
マークダウン形式で、箇条書きを使って整理してください。

---
【分析対象テキスト】
`,
    maxOutputTokens: 8000,
  },

  creator: {
    userPrompt: `以下の内容をクリエイターの視点から分析してください:

革新的なアイデア、代替アプローチ、創造的な解決策、新しい可能性を提案してください。
マークダウン形式で、箇条書きを使って整理してください。

---
【分析対象テキスト】
`,
    maxOutputTokens: 8000,
  },

  graphic: {
    userPrompt: '',
    maxOutputTokens: 2000,
  },

  grareco: {
    userPrompt: '',
    maxOutputTokens: 2000,
  },
};

export async function analyzeTranscript(
  transcriptText: string,
  analysisType: AnalysisType,
  options?: {
    additionalContext?: string;
    additionalPrompt?: string;
    images?: AnalysisImage[];
    participants?: Array<{ name: string; gender?: string; age?: string; other?: string }> | null;
  }
): Promise<string> {
  const config = analysisConfigs[analysisType];
  if (!config || !config.userPrompt) {
    throw new Error(`Unknown analysis type: ${analysisType}`);
  }

  if (options?.images && options.images.length > 0) {
    const validation = validateImages(options.images);
    if (!validation.valid) {
      throw new BadRequestError(validation.error || '画像の検証に失敗しました');
    }
  }

  let fullText = '';

  const validParticipants = (options?.participants || []).filter(
    (p: any) => p && p.name && String(p.name).trim()
  );
  if (validParticipants.length > 0) {
    fullText += `【参加者情報（正式な情報）】\n${validParticipants
      .map((p: any) => {
        const parts = [String(p.name).trim()];
        if (p.gender && p.gender !== '分からない') parts.push(`性別: ${p.gender}`);
        if (p.age && p.age !== '分からない') parts.push(`年代: ${p.age}`);
        if (p.other) parts.push(`その他: ${p.other}`);
        return `- ${parts.join(' / ')}`;
      })
      .join('\n')}

★最重要ルール（参加者情報の優先）:
1. 上記の参加者情報が最も正確な情報源です。文字起こしの誤変換より常に優先してください。
2. 発言内容から発言者を推定し、参加者名を使って「誰が何を言ったか」を明確にしてください。

---\n`;
  }

  fullText += transcriptText;
  if (options?.additionalContext) {
    fullText += `\n\n---\n【補足資料（参考情報）】\n※以下は補足的な参考情報です。上記の主テキストの内容を主軸として分析してください。\n${options.additionalContext}`;
  }

  let userPrompt = config.userPrompt + fullText;
  userPrompt += '\n\n---\n※ 出力は、分析対象テキストの発話・本文と同じ言語で書いてください（日本語の会議なら日本語）。翻訳や言語の変更はしないでください。';
  if (options?.additionalPrompt) {
    userPrompt += `\n\n---\n【追加の指示】\n${options.additionalPrompt}`;
  }
  if (options?.images && options.images.length > 0) {
    userPrompt += `\n\n---\n【添付画像について】\n以下に${options.images.length}枚の画像が添付されています。画像の内容を読み取り、分析に活用してください。`;
  }

  const request = buildAnalysisRequest(config, userPrompt, options?.images);

  try {
    const response = await ai.models.generateContent(request as any);

    return response.text || '分析結果を取得できませんでした。';
  } catch (error: any) {
    console.error('Analysis error:', error);
    const errorMsg = error?.message || error?.toString() || '';
    const lc = errorMsg.toLowerCase();
    const status = error?.status ?? error?.code;
    if (
      status === 429 ||
      status === 'RESOURCE_EXHAUSTED' ||
      lc.includes('429') ||
      lc.includes('resource_exhausted') ||
      lc.includes('quota') ||
      lc.includes('rate limit')
    ) {
      throw new AppError(503, '現在AI（Gemini）が混雑しています。しばらく経ってから再度お試しください。');
    }
    if (
      errorMsg.includes('request payload size') ||
      errorMsg.includes('too large') ||
      errorMsg.includes('413') ||
      errorMsg.includes('INVALID_ARGUMENT')
    ) {
      throw new BadRequestError('リクエストサイズが上限を超えています。画像を圧縮するか枚数を減らしてください（上限: 約20MB）');
    }
    throw new AppError(500, '分析に失敗しました。');
  }
}

interface SummaryDelta {
  action: 'update_last' | 'new_theme' | 'update_and_new';
  lastThemeUpdate?: { addBullets?: string[]; newTimeEnd?: string };
  newTheme?: { title: string; timeStart: string; timeEnd: string; bullets: string[] };
}

function buildParticipantInfo(
  participants?: Array<{ name: string; gender?: string; age?: string; other?: string }> | null
): string {
  const validParticipants = (participants || []).slice(0, 30);
  return validParticipants.length > 0
    ? `\n【参加者情報（正式な情報）】\n${validParticipants
        .map((p) => {
          const parts = [String(p.name || '').slice(0, 100)];
          if (p.gender && p.gender !== '分からない') parts.push(`性別: ${String(p.gender).slice(0, 20)}`);
          if (p.age && p.age !== '分からない') parts.push(`年代: ${String(p.age).slice(0, 20)}`);
          if (p.other) parts.push(`その他: ${String(p.other).slice(0, 200)}`);
          return `- ${parts.join(' / ')}`;
        })
        .join('\n')}\n\n★最重要ルール（参加者情報の優先）:\n- 上記の参加者情報が最も正確な情報源です。文字起こしの誤変換より常に優先してください。\n- 誰がどの立場で発言したかを明確にしてください（例：「山田さんが試作品の改良案を示した」）。\n- 年代・年齢の情報は文脈理解の参考にのみ使用し、出力文面には絶対に記載しないでください。\n`
    : '';
}

function buildSupplementarySection(supplementaryContext?: string | null): string {
  return supplementaryContext
    ? `\n【補足資料（参加者メモ・画像分析）】\n${supplementaryContext}\n※ 上記の補足資料も参考にしてサマリーに反映してください。各項目の [MM:SS] は会議開始からの経過時刻です。その時刻に該当する時間帯のテーマに反映してください。\n`
    : '';
}

function buildThemeTOC(themes: SummaryTheme[]): string {
  return themes
    .map((t) =>
      t.hasTimeRange
        ? `${t.index}. ${t.title} [${t.timeStart}-${t.timeEnd}]`
        : `${t.index}. ${t.title}`,
    )
    .join('\n');
}

function formatLastTheme(theme: SummaryTheme): string {
  return `${formatThemeHeading(theme)}\n${theme.bullets.join('\n')}`;
}

function applyDeltaToThemes(themes: SummaryTheme[], delta: SummaryDelta): SummaryTheme[] {
  const updated = themes.map((t) => ({ ...t, bullets: [...t.bullets] }));
  const targetIndex = lastRegularThemeIndex(updated);
  const last = targetIndex >= 0 ? updated[targetIndex] : undefined;

  if (
    (delta.action === 'update_last' || delta.action === 'update_and_new') &&
    delta.lastThemeUpdate &&
    last
  ) {
    if (delta.lastThemeUpdate.addBullets) {
      const newBullets = delta.lastThemeUpdate.addBullets.map((b) =>
        b.startsWith('・') ? b : `・${b}`
      );
      last.bullets.push(...newBullets);
    }
    if (delta.lastThemeUpdate.newTimeEnd) {
      last.timeEnd = delta.lastThemeUpdate.newTimeEnd;
    }
  }

  if (
    (delta.action === 'new_theme' || delta.action === 'update_and_new') &&
    delta.newTheme
  ) {
    const nt = delta.newTheme;
    updated.push({
      index: updated.length + 1,
      title: nt.title,
      timeStart: nt.timeStart || '00:00',
      timeEnd: nt.timeEnd || nt.timeStart || '00:00',
      bullets: (nt.bullets || []).map((b) => (b.startsWith('・') ? b : `・${b}`)),
      hasTimeRange: true,
    });
  }

  return updated;
}

function parseDeltaResponse(text: string): SummaryDelta | null {
  try {
    let json = text.trim();

    let fenceMatch = json.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (!fenceMatch) {
      fenceMatch = json.match(/```(?:json)?\s*\n?([\s\S]*)$/);
    }
    if (fenceMatch) {
      json = fenceMatch[1].trim();
    }

    const parsed = JSON.parse(json);
    if (!parsed || !parsed.action) return null;

    const validActions = ['update_last', 'new_theme', 'update_and_new'];
    if (!validActions.includes(parsed.action)) return null;

    return parsed as SummaryDelta;
  } catch {
    return null;
  }
}

async function generateInitialSummary(
  newTranscripts: string,
  participantInfo: string,
  supplementarySection: string
): Promise<string> {
  const prompt = `以下の会議の文字起こしから構造化サマリーを作成してください。
${participantInfo}${supplementarySection}
文字起こし:
${newTranscripts}

ルール:
1. 各テーマの見出しには、そのテーマが議論された時間範囲を含めてください
2. 発言には[MM:SS]形式のタイムスタンプが付いています。テーマの時間範囲は、そのテーマに含まれる発言の最初と最後のタイムスタンプを使用してください
3. サマリーは文字起こしの発話と同じ言語で書いてください（日本語の会議なら日本語）。翻訳や言語の変更はしないでください
4. 以下のフォーマットで出力してください:

## 1. テーマ名 [開始時間-終了時間]
・ポイント1
・ポイント2

構造化サマリーを出力してください:`;

  const response = await ai.models.generateContent({
    model: MODEL_FLASH,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
  });
  return response.text || 'サマリーを生成できませんでした。';
}

async function generateFullSummaryFallback(
  newTranscripts: string,
  previousSummaryWithSupplementary: string,
  participantInfo: string,
  supplementarySection: string
): Promise<string> {
  const { regular: previousSummary, supplementary } = separateSupplementary(previousSummaryWithSupplementary);
  const updated = await generateFullSummaryFallbackRegular(newTranscripts, previousSummary, participantInfo, supplementarySection);
  let content = updated;
  for (const block of supplementary) {
    content = insertSectionChronologically(content, block, headingStartSec(block[0])).content;
  }
  return content;
}

async function generateFullSummaryFallbackRegular(
  newTranscripts: string,
  previousSummary: string,
  participantInfo: string,
  supplementarySection: string
): Promise<string> {
  const prompt = `あなたは会議の構造化サマリーを更新するAIです。
${participantInfo}${supplementarySection}
前回のサマリー:
${previousSummary}

新しい発言（前回以降に追加されたもの）:
${newTranscripts}

ルール:
1. 前回のサマリーの内容は絶対に削除しないでください。既存のテーマとポイントはすべて保持してください
2. 新しい発言が既存テーマに関連する場合は、そのテーマにポイントを追記してください。その際、テーマの時間範囲の終了時間を更新してください
3. 新しい話題が出てきた場合のみ、新しいテーマを追加してください
4. 各テーマの見出しには、そのテーマが議論された時間範囲を含めてください
5. 発言には[MM:SS]形式のタイムスタンプが付いています。テーマの時間範囲は、そのテーマに含まれる発言の最初と最後のタイムスタンプを使用してください
6. サマリーは発話と同じ言語で書いてください（日本語の会議なら日本語）。翻訳や言語の変更はしないでください
7. 以下のフォーマットで出力してください:

## 1. テーマ名 [開始時間-終了時間]
・ポイント1
・ポイント2

更新されたサマリーを出力してください:`;

  const response = await ai.models.generateContent({
    model: MODEL_FLASH,
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
  });
  return response.text || 'サマリーを生成できませんでした。';
}

function buildDeltaPrompt(
  toc: string,
  lastThemeFormatted: string,
  newTranscripts: string,
  participantInfo: string,
  supplementarySection: string
): string {
  return `あなたは会議のリアルタイムサマリーを更新するAIです。
${participantInfo}${supplementarySection}
【既存テーマ一覧（見出しのみ）】
${toc}

【現在のテーマ（最新・詳細）】
${lastThemeFormatted}

【新しい発言】
${newTranscripts}

あなたのタスク:
新しい発言を分析し、以下のいずれかのアクションをJSON形式で返してください。

1. "update_last" — 新しい発言が現在のテーマの続きである場合
2. "new_theme" — 新しい発言が完全に新しい話題の場合
3. "update_and_new" — 現在のテーマに少し追記しつつ、新しいテーマも始まった場合

ルール:
- 既存テーマ一覧にある過去のテーマの内容は変更しないでください（見出しだけ参考にしてください）
- 出力する文章（テーマ名・ポイント）は【新しい発言】と同じ言語で書いてください（日本語の会議なら日本語）。翻訳や言語の変更はしないでください
- 各ポイントは「・」で始めてください
- タイムスタンプは発言の[MM:SS]を参照してください
- newTimeEndは現在のテーマに含まれる最後の関連発言のタイムスタンプにしてください
- 新テーマのtimeStartは最初の関連発言のタイムスタンプ、timeEndは最後のタイムスタンプにしてください
- 発言者名を明記してください（例：「鈴木さんが配布資料の修正を提案した」）

以下のJSON形式で出力してください（JSON以外は出力しないでください）:

{
  "action": "update_last" | "new_theme" | "update_and_new",
  "lastThemeUpdate": {
    "addBullets": ["・追加する要点", "・追加する要点"],
    "newTimeEnd": "07:40"
  },
  "newTheme": {
    "title": "新しく始まったテーマの名前",
    "timeStart": "07:40",
    "timeEnd": "09:05",
    "bullets": ["・要点", "・要点"]
  }
}

注意:
- actionが"update_last"の場合、newThemeは不要です
- actionが"new_theme"の場合、lastThemeUpdateは不要です
- actionが"update_and_new"の場合、両方必要です`;
}

export async function generateStructuredSummary(
  newTranscripts: string,
  previousSummary?: string | null,
  participants?: Array<{ name: string; gender?: string; age?: string; other?: string }> | null,
  supplementaryContext?: string | null
): Promise<string> {
  const participantInfo = buildParticipantInfo(participants);
  const supplementarySection = buildSupplementarySection(supplementaryContext);

  if (!previousSummary) {
    try {
      return await generateInitialSummary(newTranscripts, participantInfo, supplementarySection);
    } catch (error) {
      console.error('Structured summary error:', error);
      throw new AppError(500, '構造化サマリーの生成に失敗しました。');
    }
  }

  const themes = parseSummaryIntoThemes(previousSummary);

  if (themes.length === 0) {
    console.warn('[Summary] Theme parsing failed, falling back to full summary');
    try {
      return await generateFullSummaryFallback(newTranscripts, previousSummary, participantInfo, supplementarySection);
    } catch (error) {
      console.error('Structured summary error:', error);
      throw new AppError(500, '構造化サマリーの生成に失敗しました。');
    }
  }

  const toc = buildThemeTOC(themes);
  const lastRegular = lastRegularThemeIndex(themes);
  const lastThemeFormatted = lastRegular >= 0 ? formatLastTheme(themes[lastRegular]) : '（まだ話題はありません）';
  const prompt = buildDeltaPrompt(toc, lastThemeFormatted, newTranscripts, participantInfo, supplementarySection);

  try {
    const response = await ai.models.generateContent({
      model: MODEL_FLASH,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        maxOutputTokens: 4000,
        thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            action: { type: 'STRING', enum: ['update_last', 'new_theme', 'update_and_new'] },
            lastThemeUpdate: {
              type: 'OBJECT',
              properties: {
                addBullets: { type: 'ARRAY', items: { type: 'STRING' } },
                newTimeEnd: { type: 'STRING' },
              },
              required: ['addBullets', 'newTimeEnd'],
            },
            newTheme: {
              type: 'OBJECT',
              properties: {
                title: { type: 'STRING' },
                timeStart: { type: 'STRING' },
                timeEnd: { type: 'STRING' },
                bullets: { type: 'ARRAY', items: { type: 'STRING' } },
              },
              required: ['title', 'timeStart', 'timeEnd', 'bullets'],
            },
          },
          required: ['action'],
          propertyOrdering: ['action', 'lastThemeUpdate', 'newTheme'],
        },
      },
    });

    const deltaText = response.text || '';
    const delta = parseDeltaResponse(deltaText);

    if (!delta) {
      const usage = (response as any).usageMetadata ?? {};
      console.warn(
        `[Summary] Delta parse failed, falling back to full summary. ` +
          `len=${deltaText.length} ` +
          `tokens(in/out/think/total)=${usage.promptTokenCount ?? '?'}/${usage.candidatesTokenCount ?? '?'}/${usage.thoughtsTokenCount ?? '?'}/${usage.totalTokenCount ?? '?'} ` +
          `head=${JSON.stringify(deltaText.slice(0, 200))} ` +
          `tail=${JSON.stringify(deltaText.slice(-100))}`,
      );
      return await generateFullSummaryFallback(newTranscripts, previousSummary, participantInfo, supplementarySection);
    }

    const updatedThemes = applyDeltaToThemes(themes, delta);
    return assembleSummaryMarkdown(updatedThemes);
  } catch (error) {
    console.error('Structured summary error:', error);
    throw new AppError(500, '構造化サマリーの生成に失敗しました。');
  }
}

export async function rebuildStructuredSummary(
  windows: Array<{ transcript: string; supplementaryContext?: string | null }>,
  participants?: Array<{ name: string; gender?: string; age?: string; other?: string }> | null,
  concurrency = 4,
): Promise<string> {
  const parts: string[] = new Array(windows.length);
  let next = 0;
  const worker = async () => {
    while (next < windows.length) {
      const i = next++;
      const { transcript, supplementaryContext } = windows[i];
      try {
        parts[i] = await generateStructuredSummary(transcript, null, participants, supplementaryContext);
      } catch {
        console.warn(`[Summary] Rebuild window ${i + 1}/${windows.length} failed, retrying once`);
        parts[i] = await generateStructuredSummary(transcript, null, participants, supplementaryContext);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, windows.length) }, worker));
  return mergeSummaryParts(parts);
}

export async function consolidateSummaryThemes(
  currentSummary: string,
  participants?: Array<{ name: string; gender?: string; age?: string; other?: string }> | null
): Promise<string> {
  const themes = renumberThemes(parseSummaryIntoThemes(currentSummary));

  if (themes.length <= 3) {
    console.log(`[Summary] Consolidation skipped: only ${themes.length} themes`);
    return currentSummary;
  }

  const participantInfo = buildParticipantInfo(participants);
  const fixedNumbers = themes.filter(isSupplementaryTheme).map((t) => t.index);

  const prompt = `あなたは会議サマリーの編集者です。以下のサマリーのテーマを、同じ議題どうしで束ねる案を作ってください。
${participantInfo}
【現在のサマリー】
${assembleSummaryMarkdown(themes)}

【束ね方のルール】
1. 同じ議題について時間帯が連続しているテーマは1つのグループに束ねてください
   例: "試作品の第一印象" + "試作品の気になる点" + "試作品の直す順番" → "試作品の評価と改善"
2. 明確に異なる議題は束ねないでください
   例: "試作品の評価" と "社内イベントの準備" は別グループのまま
3. グループ数に上限はありません（結果として2個でも5個でもよい）
4. 束ねてよいのは番号が連続するテーマだけです。1番から${themes.length}番までのすべての番号を、ちょうど1回ずつ、小さい順にいずれかのグループへ入れてください
5. 見出しに「[補足資料]」を含むテーマ${fixedNumbers.length > 0 ? `（${fixedNumbers.join('、')}番）` : ''}は束ねず、単独のグループにしてください
6. 各グループの title には束ねた内容を表すテーマ名だけを書いてください（番号や時間範囲は不要。単独のグループは元の見出しが使われます）
7. title は【現在のサマリー】と同じ言語で書いてください。翻訳や言語の変更は禁止です
8. 箇条書きの内容は出力しないでください（移し替えはシステムが行います）

JSON で出力してください。例: {"groups":[{"title":"試作品の評価と改善","themes":[1,2,3]},{"title":"社内イベントの準備","themes":[4]}]}`;

  try {
    const response = await ai.models.generateContent({
      model: MODEL_FLASH,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        maxOutputTokens: 32000,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            groups: {
              type: 'ARRAY',
              items: {
                type: 'OBJECT',
                properties: {
                  title: { type: 'STRING' },
                  themes: { type: 'ARRAY', items: { type: 'INTEGER' } },
                },
                required: ['title', 'themes'],
                propertyOrdering: ['title', 'themes'],
              },
            },
          },
          required: ['groups'],
        },
      },
    });

    let groups: ThemeGroup[];
    try {
      const parsed = JSON.parse(response.text || '');
      groups = Array.isArray(parsed?.groups) ? parsed.groups : [];
    } catch {
      const usage = (response as any).usageMetadata ?? {};
      console.warn(
        `[Summary] Consolidation response was not valid JSON (len=${(response.text || '').length} ` +
          `finish=${response.candidates?.[0]?.finishReason ?? '?'} ` +
          `tokens(out/think)=${usage.candidatesTokenCount ?? '?'}/${usage.thoughtsTokenCount ?? '?'} ` +
          `tail=${JSON.stringify((response.text || '').slice(-80))}), keeping original`,
      );
      return currentSummary;
    }

    const newThemes = applyThemeGroups(themes, groups);
    if (!newThemes) {
      console.warn(
        `[Summary] Consolidation grouping invalid (${themes.length} themes, groups=${JSON.stringify(groups.map((g) => g.themes))}), keeping original`,
      );
      return currentSummary;
    }

    const result = assembleSummaryMarkdown(newThemes);

    const lost = findLostLines(currentSummary, result);
    if (lost.length > 0) {
      console.warn(`[Summary] Consolidation lost ${lost.length} line(s), keeping original`);
      return currentSummary;
    }

    console.log(`[Summary] Consolidated ${themes.length} themes → ${newThemes.length} themes`);
    return result;
  } catch (error) {
    console.error('[Summary] Consolidation error:', error);
    return currentSummary;
  }
}

export const CONSOLIDATED_MARKER = '<!-- consolidated -->';

export function hasConsolidatedMarker(content: string | null | undefined): boolean {
  return !!content && content.includes(CONSOLIDATED_MARKER);
}

export function withConsolidatedMarker(content: string): string {
  if (hasConsolidatedMarker(content)) return content;
  return `${content.trimEnd()}\n${CONSOLIDATED_MARKER}`;
}

export async function analyzeImagesForGrareco(images: AnalysisImage[]): Promise<string> {
  const prompt = `あなたは画像分析の専門家です。添付された画像を詳細に分析し、以下の情報を構造化テキストとして出力してください。

**分析項目:**
1. **人物情報**: 画像に写っている人物の名前（表示されている場合）、属性（役職、肩書きなど）、外見的特徴
2. **テキスト情報**: 画像内に表示されているすべてのテキスト（スライド内容、チャット、名前表示、UI要素のテキストなど）
3. **資料内容**: プレゼンテーション資料、ドキュメント、図表がある場合はその内容を文字起こし
4. **図・グラフ**: 図やグラフがある場合は、その意図・データ・結論を説明
5. **状況説明**: 全体的なシーン（会議の様子、画面共有の内容など）

**出力形式:**
- 各画像ごとに【画像N】として区切る
- 箇条書きで見やすく整理
- 推測が入る場合は「（推測）」と明記
- 確認できない項目は省略してよい

**重要:** 画像から読み取れる情報をできるだけ詳細に、正確に書き起こしてください。`;

  try {
    const userParts: any[] = [{ text: prompt }];
    for (const img of images) {
      userParts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
    }

    const response = await ai.models.generateContent({
      model: MODEL_FLASH,
      contents: [{ role: 'user', parts: userParts }],
      config: { maxOutputTokens: 8000 },
    });

    return response.text || '画像の解析結果を取得できませんでした。';
  } catch (error: any) {
    console.error('Image analysis for grareco error:', error);
    const errorMsg = error?.message || '';
    if (
      errorMsg.includes('request payload size') ||
      errorMsg.includes('too large') ||
      errorMsg.includes('413')
    ) {
      throw new BadRequestError('画像サイズが上限を超えています。画像を圧縮するか枚数を減らしてください。');
    }
    throw new AppError(500, '画像の解析に失敗しました。');
  }
}

export async function analyzeMeetingImage(imageData: string, mimeType: string, exifText?: string | null): Promise<{ analysis: string; diagram: string | null; extractedTime: string | null }> {
  const exifSection = exifText
    ? `\n\n**事前抽出済みEXIFメタデータ（この情報は正確です。必ず分析結果に含めてください）:**\n${exifText}`
    : '';

  const prompt = `あなたは画像分析の専門家です。会議中にアップロードされた画像を分析してください。
${exifSection}

**タスク:**
1. **メタデータ**: ${exifText ? '上記のEXIFメタデータを「メタデータ」セクションにそのまま含めてください。日時情報があればextractedTimeにも設定してください。' : '画像内に日時情報（時計、タイムスタンプ等）が表示されていれば読み取ってextractedTimeに設定してください。なければnullとしてください。'}
2. **内容分析（マークダウン形式）**: 画像内のすべての情報を構造化してマークダウンで出力してください：
   - テキスト/文字の書き起こし
   - 図表・グラフの説明と数値
   - スライド/プレゼンの内容
   - ホワイトボード/手書きメモの内容
   - 概念図・フローチャートの構造と関係性
3. **ダイアグラム生成**: 画像内に概念図、フロー、関係性、プロセスがあれば、Mermaid記法でダイアグラムを生成してください。なければnullとしてください。

**出力は必ず以下のJSON形式で返してください（他のテキストは不要）:**
{
  "extractedTime": "2030-04-01 10:00" または null,
  "analysis": "## 画像分析結果\\n\\n### テキスト内容\\n- （読み取った文字）\\n\\n### メタデータ\\n- 撮影日時: （日時）\\n- GPS: （位置）",
  "diagram": "graph TD\\n  A[受付] --> B[確認]\\n  B --> C[完了]" または null
}`;

  try {
    const response = await ai.models.generateContent({
      model: MODEL_FLASH,
      contents: [{
        role: 'user',
        parts: [
          { text: prompt },
          { inlineData: { mimeType, data: imageData } },
        ],
      }],
      config: { maxOutputTokens: 8000 },
    });

    const text = response.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          analysis: parsed.analysis || text,
          diagram: parsed.diagram || null,
          extractedTime: parsed.extractedTime || null,
        };
      } catch {
      }
    }
    return { analysis: text, diagram: null, extractedTime: null };
  } catch (error: any) {
    console.error('[ImageAnalysis] Error:', error);
    throw new AppError(500, '画像の分析に失敗しました。');
  }
}

export interface RoomObservationResult {
  peopleCount: number | null;
  fiveW1H: {
    when: string | null;
    where: string | null;
    who: string | null;
    what: string | null;
    why: string | null;
    how: string | null;
  };
  people: Array<{
    position: string | null;
    posture: string | null;
    activity: string | null;
    inferredEmotion: string | null;
    inferredThought: string | null;
  }>;
  rawSummary: string;
  materials: {
    hasMeaningfulStructure: boolean;
    analysis: string;
    diagram: string | null;
  } | null;
}

const SENSITIVE_ATTRIBUTE_GUARD = `**【厳守】推定・記述してはいけない事項**
people（inferredEmotion / inferredThought / posture / activity）・fiveW1H・rawSummary の
いずれにおいても、次に関する記述・示唆・推測を**一切行わない**（写っていても言及しない）:
- 健康状態・体調・疲労・病歴・怪我・妊娠・服薬・通院（「具合が悪そう」「眠そう」のような書き方もしない）
- 心身の機能の障害、およびそれを示唆する器具・所作
- 人種・民族・国籍に基づく特徴、信条・宗教・政治的立場
- 社会的身分、犯罪歴、犯罪被害の事実
- 性的指向・性自認
- 年齢・性別の断定（「若い女性」のような書き方もしない。位置や服装の色で区別する）

記述してよいのは、**会議の進行に関係する観察可能な行動**（発話／傾聴／画面注視／メモ／
挙手／離席など）と、そこから読み取れる**議題への関与の度合い**（「身を乗り出して聞いている
ように見える」「資料に目を通しているように見える」等）に限る。
判断に迷ったら、その記述は**書かない**（null または省略する）。`;

const CAMERA_TASKS_AND_FORMAT = `**タスク:**
1. **人物の俯瞰観察**: 画面内に何人いて、どこに（左/中央/右・前/後）、どんな姿勢で、何をしているように見えるかを推定。
   さらに各人の「推定感情」「推定思考」を記述する。これらは断定せず**あくまで推定**として表現すること
   推定には、根拠になる見えている動きを添える（例: 「話し手の方を向いてうなずいている」「資料を見ながら首をかしげている」）。
   人を評価する言い方（やる気がない・退屈そう・不真面目など）はしない。個人を特定する固有情報（実名等）は推測しない。
2. **5W1H**: 場面全体を when（時刻）/ where（場所の性質）/ who（人数と構成）/ what（何が起きているか）/
   why（推定される目的・場の意図）/ how（進め方・様子）で要約する。
3. **資料の抽出（厳格）**: 画面内にスライド・ホワイトボード・配布資料・図表など「読み取れる資料」が写っていれば、
   **補足資料の画像解析と同じ深さ**で全文抽出・構造化する（テキスト書き起こし・表・数値・スライド/ホワイトボードの内容・
   概念図やフローの関係性）。可能なら Mermaid 記法の図も生成。
   ただし **materials.hasMeaningfulStructure は厳しく判定**する：
   - true にするのは「**意味のある構造・因果・論点が読み取れる**」場合のみ
     （例: 新商品の企画会議で示された案ごとの長所と短所の表、作業の手順を矢印でつないだ図）。
   - 背景に写り込んだだけのノートPC画面・紙・スマホ・装飾、文字が断片的で羅列にしかならないもの、
     ほぼ判読不能なものは **hasMeaningfulStructure=false**。
   - 資料が無い／意味のある構造が取れない場合は **materials を null** にする。

${SENSITIVE_ATTRIBUTE_GUARD}

**出力は必ず以下のJSON形式のみ（他のテキストは不要）:**
{
  "peopleCount": 4,
  "fiveW1H": { "when": "...", "where": "...", "who": "...", "what": "...", "why": "...", "how": "..." },
  "people": [
    { "position": "右奥", "posture": "立っている", "activity": "説明中", "inferredEmotion": "落ち着いているように見える", "inferredThought": "案の利点を伝えようとしていると推定" }
  ],
  "rawSummary": "右奥の1名が立って説明し、残りの3名が手元の資料を見ながら聞いている様子。",
  "materials": null
}

// 資料に意味のある構造がある場合の materials の例:
// "materials": { "hasMeaningfulStructure": true, "analysis": "## スライド: 新商品の企画案\\n- 案A: 価格を抑える / 案B: 機能を増やす...\\n### 主張\\n...", "diagram": "graph LR; 案A-->比較; 案B-->比較" }`;

function buildCameraSinglePrompt(contextSection: string): string {
  return `あなたは対面会議の「環境観察」を行うアナリストです。会議室を広角カメラで捉えた1フレームを解析します。
人を一人ずつ特定・追跡するのではなく、その場（環境）にいる人々の様子を俯瞰的に推定して記録します。
${contextSection ? `\n**事前情報（この情報は正確です。who/when/where に反映してください）:**\n${contextSection}\n` : ''}
${CAMERA_TASKS_AND_FORMAT}`;
}

function buildCameraMultiViewPrompt(contextSection: string): string {
  return `あなたは対面会議の「環境観察」を行うアナリストです。360度カメラを部屋の中央に設置し、全周を4方向に分割した「重なりのあるパース画像」4枚（前方/右側/後方/左側）を解析します。
4枚は同一の部屋を異なる方向から見たものです。隣り合うビューには重なりがあり、同一人物が2枚に写ることがあります。**重複して数えず、同一人物は1人として**部屋全体を統合的に観察してください。
各人の position は「左側(view4)の奥のほう」のように『どのビューか＋画面内の位置』で表現します。
${contextSection ? `\n**事前情報（この情報は正確です。who/when/where に反映してください）:**\n${contextSection}\n` : ''}
${CAMERA_TASKS_AND_FORMAT}`;
}

function parseRoomObservation(text: string): RoomObservationResult {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const p = JSON.parse(jsonMatch[0]);
      const fw = p.fiveW1H || {};
      const mat = p.materials;
      const analysisText = (mat?.analysis || '').trim();
      const materials =
        mat && mat.hasMeaningfulStructure === true && analysisText.length >= 30
          ? { hasMeaningfulStructure: true, analysis: analysisText, diagram: mat.diagram || null }
          : null;
      return {
        peopleCount: typeof p.peopleCount === 'number' ? p.peopleCount : (Array.isArray(p.people) ? p.people.length : null),
        fiveW1H: {
          when: fw.when ?? null, where: fw.where ?? null, who: fw.who ?? null,
          what: fw.what ?? null, why: fw.why ?? null, how: fw.how ?? null,
        },
        people: Array.isArray(p.people) ? p.people : [],
        rawSummary: p.rawSummary || '',
        materials,
      };
    } catch {
    }
  }
  return {
    peopleCount: null,
    fiveW1H: { when: null, where: null, who: null, what: null, why: null, how: null },
    people: [],
    rawSummary: text.slice(0, 500),
    materials: null,
  };
}

export async function analyzeRoomObservation(
  imageData: string,
  mimeType: string,
  context?: { capturedAtText?: string | null; locationText?: string | null; mode?: 'camera' | 'screen' },
): Promise<RoomObservationResult> {
  const mode = context?.mode ?? 'camera';
  const capturedLine = context?.capturedAtText ? `取得時刻（正確）: ${context.capturedAtText}` : '';
  const locationLine = context?.locationText ? `撮影端末の位置（正確）: ${context.locationText}` : '';
  const contextSection = [capturedLine, locationLine].filter(Boolean).join('\n');

  const screenPrompt = `あなたは会議で共有された「画面」を解析するアナリストです。1フレームを解析します。
画面には (a) 共有された資料 と (b) オンライン会議の参加者の映像（顔のタイル）の両方が写りうる。両方を扱う。
${contextSection ? `\n**事前情報（正確）:**\n${contextSection}\n` : ''}
**タスク1: 共有資料の抽出**
対象＝プレゼンのスライド、共有資料・ドキュメント、図表・グラフ、表計算、ホワイトボード、ダイアグラム、コード/設計図など
「会議で共有・提示されている構造的な情報」。
- 抽出してはいけない（写っていても無視し、これが主なら materials=null）: メール・受信箱、チャット/DM/SNS、通知、
  パスワード/認証情報、会議と無関係なデスクトップ/ブラウザのタブ/私的な閲覧内容。
- 「意味のある構造・因果・論点」が読み取れる時だけ materials.hasMeaningfulStructure=true とし、
  画像解析レベルで全文抽出・構造化（テキスト・表・数値・関係性、可能なら Mermaid 図）。それ以外は materials=null。

**タスク2: 人物観察（オンライン会議の参加者の顔が写っている場合のみ）**
画面にビデオ会議の参加者タイル（顔）が写っていれば、その様子を推定して people に記録する:
- peopleCount＝映っている参加者数。各人 position（タイルの位置/名前ラベルがあれば手掛かりに）、activity（発話中/傾聴/カメラオフ等）、
  inferredEmotion・inferredThought（必ず「推定」として表現）。fiveW1H の who/what/how も埋める。
- 個人を特定する固有情報（実名の断定）はしない。顔が写っていなければ people は [] 、peopleCount は 0。

${SENSITIVE_ATTRIBUTE_GUARD}

**出力は必ず以下のJSON形式のみ:**
{
  "peopleCount": 0,
  "fiveW1H": { "when": null, "where": null, "who": null, "what": "共有された資料の主題", "why": null, "how": null },
  "people": [],
  "rawSummary": "共有画面に映っている内容を1行でまとめた文。",
  "materials": null
}
// 資料がある場合: "materials": { "hasMeaningfulStructure": true, "analysis": "## 資料: ...\\n- ...", "diagram": null }
// 参加者の顔が写っている場合: "peopleCount": 2, "people": [{ "position": "右下のタイル", "posture": null, "activity": "うなずいて聞いている", "inferredEmotion": "納得しているように見える", "inferredThought": "説明の内容を確かめていると推定" }]`;

  const prompt = mode === 'screen' ? screenPrompt : buildCameraSinglePrompt(contextSection);

  try {
    const response = await ai.models.generateContent({
      model: MODEL_FLASH,
      contents: [{
        role: 'user',
        parts: [
          { text: prompt },
          { inlineData: { mimeType, data: imageData } },
        ],
      }],
      config: { maxOutputTokens: 8000 },
    });

    return parseRoomObservation(response.text || '');
  } catch (error: any) {
    console.error('[RoomObservation] Error:', error);
    throw new AppError(500, '環境観察の解析に失敗しました。');
  }
}

export async function analyzeRoomObservationMultiView(
  views: Array<{ data: string; mimeType: string; label: string }>,
  context?: { capturedAtText?: string | null; locationText?: string | null },
): Promise<RoomObservationResult> {
  const capturedLine = context?.capturedAtText ? `取得時刻（正確）: ${context.capturedAtText}` : '';
  const locationLine = context?.locationText ? `撮影端末の位置（正確）: ${context.locationText}` : '';
  const contextSection = [capturedLine, locationLine].filter(Boolean).join('\n');
  const prompt = buildCameraMultiViewPrompt(contextSection);

  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
    { text: prompt },
  ];
  for (const v of views) {
    parts.push({ text: `\n【${v.label}】` });
    parts.push({ inlineData: { mimeType: v.mimeType, data: v.data } });
  }

  try {
    const response = await ai.models.generateContent({
      model: MODEL_FLASH,
      contents: [{ role: 'user', parts }],
      config: { maxOutputTokens: 8000 },
    });
    return parseRoomObservation(response.text || '');
  } catch (error: any) {
    console.error('[RoomObservation/MultiView] Error:', error);
    throw new AppError(500, '環境観察（360度）の解析に失敗しました。');
  }
}

export async function consolidateMaterials(
  texts: string[],
  previousDigest?: string | null,
): Promise<string> {
  const joined = texts.map((t, i) => `--- 資料${i + 1} ---\n${t}`).join('\n\n');
  const prevSection = previousDigest
    ? `\n\n**【既出のダイジェスト（これと重複する内容は出力しない）】**\n${previousDigest}`
    : '';
  const prompt = `あなたは会議で共有された資料の記録を整理する編集者です。
以下は、ある時間帯に画面から抽出した複数の資料テキストです。同じ資料が時間をおいて複数回抽出され、
重複が多く含まれます。これらを **1つの整理された Markdown** に統合してください。

**ルール（厳守）:**
- **要約しすぎない**。表・数値・固有名・価格・日付などの具体情報は**そのまま保持**する。
- **重複は1つにまとめる**（同じ表やスライドが何度も出てきたら1回だけ）。
- 文章を勝手に脚色・推測で補わない。抽出された事実のみ。
- 時系列で内容が更新されている場合は、最新かつ最も情報量の多い版に統合する。
- **既出のダイジェストに含まれる内容は出力しない**（新規・更新分のみ）。
- 新規に追加すべき情報が無い場合は、**空（何も出力しない）**。
${prevSection}

**【今回の資料テキスト群】**
${joined}

統合後の Markdown のみを出力（前置き・後書きは不要）。新規が無ければ空。`;

  try {
    const response = await ai.models.generateContent({
      model: MODEL_FLASH,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: { maxOutputTokens: 8000 },
    });
    return (response.text || '').trim();
  } catch (error: any) {
    console.error('[ConsolidateMaterials] Error:', error);
    return texts.join('\n\n---\n\n');
  }
}

function toGeminiImageParts(images: GrarecoReferenceImage[]): any[] {
  return images.map((img) => ({ inlineData: { mimeType: img.mimeType, data: img.data } }));
}

export async function generateGraphicRecording(
  text: string,
  options?: {
    additionalContext?: string;
    additionalPrompt?: string;
    imageAnalysisText?: string;
  }
): Promise<GrarecoImageResult> {
  const inputData = buildGrarecoInput(text, options);
  return generateGrarecoGemini(MODEL_IMAGE, inputData);
}

async function generateGrarecoGemini(model: string, inputData: string): Promise<GrarecoImageResult> {
  const refImages = loadGrarecoReferenceImages().slice(0, grarecoRefImageCount());
  const aspectRatio = decideAspectRatio(inputData.length);
  console.log(`[Grareco] 参照画像: ${refImages.length}枚, 画角: ${aspectRatio}（入力 ${inputData.length}文字）`);

  const refImageParts = toGeminiImageParts(refImages);

  const safetySettings = [
    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
  ];

  const attempts = buildAttemptLadder(refImages.length, aspectRatio);

  for (const [i, attemptConfig] of attempts.entries()) {
    if (attemptConfig.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, attemptConfig.delayMs));
    }
    const currentRefImages = refImageParts.slice(0, attemptConfig.refCount);
    const prompt = buildGrarecoPrompt(inputData, currentRefImages.length);
    const contentParts = [...currentRefImages, { text: prompt }];

    try {
      console.log(
        `[Grareco] 生成中: model=${model}, refImages=${currentRefImages.length}, aspectRatio=${attemptConfig.aspectRatio ?? '指定なし'}, inputLen=${inputData.length}, attempt=${i + 1}/${attempts.length}`
      );
      const response = await ai.models.generateContent({
        model,
        contents: [{ role: 'user', parts: contentParts }],
        config: {
          responseModalities: ['TEXT', 'IMAGE'],
          toolConfig: {
            functionCallingConfig: {
              mode: 'NONE',
            },
          },
          automaticFunctionCalling: { disable: true },
          ...(attemptConfig.aspectRatio ? { imageConfig: { aspectRatio: attemptConfig.aspectRatio } } : {}),
        } as any,
      });

      const candidate = response.candidates?.[0];
      const parts = candidate?.content?.parts || [];
      const partTypes = parts.map((p: any) => p.inlineData ? `image(${p.inlineData.mimeType})` : p.text ? `text(${p.text.length}chars)` : 'unknown');
      const finishReason = candidate?.finishReason || 'N/A';
      console.log(`[Grareco] レスポンス: candidates=${response.candidates?.length || 0}, parts=[${partTypes.join(', ')}], finishReason=${finishReason}`);

      const imagePart = parts.find((part: any) => part.inlineData);

      if (!imagePart?.inlineData?.data) {
        const textPart = parts.find((p: any) => p.text);
        if (textPart?.text) console.log(`[Grareco] テキストのみ返却（${textPart.text.length}文字）`);
        throw new Error(`画像データを取得できませんでした (finishReason=${finishReason})`);
      }

      const mimeType = imagePart.inlineData.mimeType || 'image/png';
      const dimensions = readImageDimensions(Buffer.from(imagePart.inlineData.data, 'base64'));
      const usageMetadata = (response as any).usageMetadata;
      const costUsd =
        geminiImageCostUsd({
          promptTokenCount: usageMetadata?.promptTokenCount,
          candidatesTokenCount: usageMetadata?.candidatesTokenCount,
          imageTokenCount: readImageTokenCount(usageMetadata),
        }) ?? GEMINI_IMAGE_COST_USD;
      console.log(
        `[Grareco] 生成成功: model=${model}, refImages=${currentRefImages.length}, aspectRatio=${attemptConfig.aspectRatio ?? '指定なし'}, 寸法=${dimensions ?? '不明'}, attempt=${i + 1}, costUsd=${costUsd.toFixed(4)}`
      );
      return {
        imageUrl: `data:${mimeType};base64,${imagePart.inlineData.data}`,
        modelUsed: model,
        costUsd,
        aspectRatio: attemptConfig.aspectRatio,
        imageDimensions: dimensions,
        refImagesUsed: currentRefImages.length,
        attempt: i + 1,
      };
    } catch (error) {
      console.error(`[Grareco] エラー (model=${model}, refImages=${currentRefImages.length}, attempt=${i + 1}):`, error);
    }
  }
  throw new AppError(500, 'グラフィックレコーディングの生成に失敗しました（手動で再試行してください）');
}

export async function reviseGraphicRecording(
  originalImageUrl: string,
  originalText: string,
  revisionInstruction: string,
): Promise<GrarecoImageResult> {
  const model = MODEL_IMAGE;
  const prompt = buildRevisePrompt(originalText, revisionInstruction);

  const imageParts: any[] = [];

  if (originalImageUrl.startsWith('data:')) {
    const match = originalImageUrl.match(/^data:(image\/\w+);base64,(.+)$/);
    if (match) {
      imageParts.push({ inlineData: { mimeType: match[1], data: match[2] } });
    }
  }

  const refImages = toGeminiImageParts(loadGrarecoReferenceImages().slice(0, 2));
  imageParts.push(...refImages);

  const contentParts = [...imageParts, { text: prompt }];

  try {
    const response = await ai.models.generateContent({
      model,
      contents: [{ role: 'user', parts: contentParts }],
      config: {
        responseModalities: ['TEXT', 'IMAGE'],
        toolConfig: {
          functionCallingConfig: {
            mode: 'NONE',
          },
        },
        automaticFunctionCalling: { disable: true },
      } as any,
    });

    const candidate = response.candidates?.[0];
    const imagePart = candidate?.content?.parts?.find((part: any) => part.inlineData);

    if (!imagePart?.inlineData?.data) {
      throw new AppError(500, '修正画像データを取得できませんでした');
    }

    const mimeType = imagePart.inlineData.mimeType || 'image/png';
    return {
      imageUrl: `data:${mimeType};base64,${imagePart.inlineData.data}`,
      modelUsed: model,
      costUsd: GEMINI_IMAGE_COST_USD,
    };
  } catch (error) {
    console.error('Graphic recording revision error:', error);
    throw new AppError(500, 'グラフィックレコーディングの修正に失敗しました。');
  }
}

export async function extractParticipantsFromImage(
  imageData: string,
  mimeType: string
): Promise<Array<{ name: string; gender: string; age: string; other: string }>> {
  const prompt = `あなたは画像から参加者・出席者情報を抽出する専門家です。
画像に写っている人名リスト、名簿、名札、出席表、参加者一覧などから、参加者情報を読み取ってください。

**タスク:**
- 画像内のすべての人名を抽出してください
- 性別が判別できる場合は「男」「女」、不明な場合は「分からない」としてください
- 年代が判別できる場合は「10代」「20代」「30代」「40代」「50代」「60代」「70代」「80才以上」のいずれか、不明な場合は「分からない」としてください
- 役職・所属・肩書きなどの追加情報があれば「other」に含めてください
- 人名が見つからない場合は空配列を返してください

**出力は必ず以下のJSON形式で返してください（他のテキストは不要）:**
[
  { "name": "山田一郎", "gender": "男", "age": "50代", "other": "課長" },
  { "name": "川口さくら", "gender": "女", "age": "20代", "other": "" }
]`;

  try {
    const response = await ai.models.generateContent({
      model: MODEL_FLASH,
      contents: [{
        role: 'user',
        parts: [
          { text: prompt },
          { inlineData: { mimeType, data: imageData } },
        ],
      }],
      config: { maxOutputTokens: 4000 },
    });

    const text = response.text || '';
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        return (Array.isArray(parsed) ? parsed : [])
          .filter((p: any) => p.name && String(p.name).trim())
          .map((p: any) => ({
            name: String(p.name).trim().slice(0, 100),
            gender: ['男', '女'].includes(p.gender) ? p.gender : '分からない',
            age: ['10才未満', '10代', '20代', '30代', '40代', '50代', '60代', '70代', '80才以上'].includes(p.age) ? p.age : '分からない',
            other: p.other ? String(p.other).trim().slice(0, 200) : '',
          }));
      } catch {  }
    }
    return [];
  } catch (error) {
    console.error('[ExtractParticipantsFromImage] Error:', error);
    return [];
  }
}

export async function extractParticipantsFromText(
  text: string
): Promise<Array<{ name: string; gender: string; age: string; other: string }>> {
  const prompt = `あなたはテキストから参加者・出席者情報を抽出する専門家です。
以下のテキストから、参加者・出席者の情報を読み取ってください。

**テキスト:**
${text.slice(0, 5000)}

**タスク:**
- テキスト内のすべての人名を抽出してください
- 性別が判別できる場合は「男」「女」、不明な場合は「分からない」としてください
- 年代が判別できる場合は「10代」「20代」「30代」「40代」「50代」「60代」「70代」「80才以上」のいずれか、不明な場合は「分からない」としてください
- 役職・所属・肩書きなどの追加情報があれば「other」に含めてください
- 人名が見つからない場合は空配列を返してください

**出力は必ず以下のJSON形式で返してください（他のテキストは不要）:**
[
  { "name": "山田一郎", "gender": "男", "age": "50代", "other": "課長" },
  { "name": "川口さくら", "gender": "女", "age": "20代", "other": "" }
]`;

  try {
    const response = await ai.models.generateContent({
      model: MODEL_FLASH,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: { maxOutputTokens: 4000 },
    });

    const responseText = response.text || '';
    const jsonMatch = responseText.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        return (Array.isArray(parsed) ? parsed : [])
          .filter((p: any) => p.name && String(p.name).trim())
          .map((p: any) => ({
            name: String(p.name).trim().slice(0, 100),
            gender: ['男', '女'].includes(p.gender) ? p.gender : '分からない',
            age: ['10才未満', '10代', '20代', '30代', '40代', '50代', '60代', '70代', '80才以上'].includes(p.age) ? p.age : '分からない',
            other: p.other ? String(p.other).trim().slice(0, 200) : '',
          }));
      } catch {  }
    }
    return [];
  } catch (error) {
    console.error('[ExtractParticipantsFromText] Error:', error);
    return [];
  }
}

export async function extractParticipantsFromConversation(
  transcriptText: string,
  knownNames: string[]
): Promise<Array<{ name: string; gender: string; age: string; other: string }>> {
  if (!transcriptText.trim()) {
    console.log('[ExtractParticipantsFromConversation] empty transcript, skip');
    return [];
  }

  const knownSummary = knownNames.filter((n) => n).map((n) => `- ${n}`).join('\n') || '（既知の参加者なし）';

  const prompt = `あなたは会議の文字起こしから参加者の氏名を抽出する専門家です。

**会話ログ（時刻順）:**
${transcriptText.slice(0, 12000)}

**既知の参加者（このリストは「正」。同一人物と思われる候補は既知名の表記をそのまま使うこと）:**
${knownSummary}

**抽出ルール:**
1. 発言中で本人/他者が明示的に名乗った／呼ばれた箇所のみを根拠にする
2. 年齢・性別・所属の推測は禁止（age/gender は常に "分からない"、所属が明示されていない場合 other は ""）
3. 敬称（さん／様／さま／氏／殿／君／ちゃん）は除去して name に格納する
4. 同一人物と思われる候補が既知参加者にいる場合は、既知名の表記をそのまま使う
5. 文脈上「呼びかけ」と「自己紹介」を区別し、呼ばれた側の氏名のみ採用する。第三者言及（その場にいない人）は出力しない
6. 確証が無い場合は出力しない（空配列で構わない）

**抽出例:**
- 「ヤマダです、いま入りました」 → name: "ヤマダ"
- 「鈴木さん、資料の説明をお願いします」（同席者への呼びかけ） → name: "鈴木"
- 「前に田中さんが言っていた件ですが」（第三者言及） → 出力しない
- 既知に「小林」がある状態で「こばやしさん、次どうぞ」 → name: "小林"（既知表記）`;

  try {
    const response = await ai.models.generateContent({
      model: MODEL_FLASH,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: {
        maxOutputTokens: 12000,
        thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              name: { type: 'STRING' },
              gender: { type: 'STRING', enum: ['男', '女', '分からない'] },
              age: {
                type: 'STRING',
                enum: ['10才未満', '10代', '20代', '30代', '40代', '50代', '60代', '70代', '80才以上', '分からない'],
              },
              other: { type: 'STRING' },
            },
            required: ['name', 'gender', 'age', 'other'],
            propertyOrdering: ['name', 'gender', 'age', 'other'],
          },
        },
      },
    });

    const responseText = response.text || '';
    const usage = (response as any).usageMetadata ?? {};
    console.log(
      `[ExtractParticipantsFromConversation] transcript=${transcriptText.length}ch, response=${responseText.length}ch, ` +
      `tokens(in/out/think/total)=${usage.promptTokenCount ?? '?'}/${usage.candidatesTokenCount ?? '?'}/${usage.thoughtsTokenCount ?? '?'}/${usage.totalTokenCount ?? '?'}, ` +
      `head: ${responseText.slice(0, 300)}`
    );

    let parsed: unknown;
    try {
      parsed = JSON.parse(responseText);
    } catch (e) {
      const jsonMatch = responseText.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        console.error('[ExtractParticipantsFromConversation] JSON parse failed and no array found:', e);
        return [];
      }
      try {
        parsed = JSON.parse(jsonMatch[0]);
      } catch (e2) {
        console.error('[ExtractParticipantsFromConversation] JSON parse failed (both attempts):', e2);
        return [];
      }
    }

    if (!Array.isArray(parsed)) {
      console.log('[ExtractParticipantsFromConversation] Parsed value is not an array');
      return [];
    }

    const normalized = parsed
      .map((p: any) => ({
        name: p?.name ? String(p.name).trim().slice(0, 100) : '',
        gender: ['男', '女'].includes(p?.gender) ? p.gender : '分からない',
        age: ['10才未満', '10代', '20代', '30代', '40代', '50代', '60代', '70代', '80才以上'].includes(p?.age)
          ? p.age
          : '分からない',
        other: p?.other ? String(p.other).trim().slice(0, 200) : '',
      }))
      .filter((p) => p.name.length > 0);

    console.log(
      `[ExtractParticipantsFromConversation] parsed ${parsed.length} → after filter ${normalized.length}`
    );
    return normalized;
  } catch (error) {
    console.error('[ExtractParticipantsFromConversation] Error:', error);
    return [];
  }
}
