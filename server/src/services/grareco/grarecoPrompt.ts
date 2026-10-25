
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface GrarecoReferenceImage {
  mimeType: string;
  data: string;
}

export function loadGrarecoReferenceImages(): GrarecoReferenceImage[] {
  const images: GrarecoReferenceImage[] = [];
  const assetsDir = path.join(__dirname, '..', '..', '..', 'assets', 'grareco');
  for (let i = 1; i <= 4; i++) {
    const imgPath = path.join(assetsDir, `image_${i}.png`);
    if (fs.existsSync(imgPath)) {
      const imageData = fs.readFileSync(imgPath);
      images.push({ mimeType: 'image/png', data: imageData.toString('base64') });
    }
  }
  return images;
}

export function reorderSectionsForGrareco(text: string): string {
  const sectionRegex = /^(##\s+\d+\.\s+.+|【[^】]+】)/gm;
  const matches = [...text.matchAll(sectionRegex)];

  if (matches.length === 0) {
    return text;
  }

  const sections: { header: string; content: string; isTranscript: boolean }[] = [];
  const preamble = text.substring(0, matches[0].index!).trim();

  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index!;
    const end = i + 1 < matches.length ? matches[i + 1].index! : text.length;
    const sectionText = text.substring(start, end).trim();
    const header = matches[i][0];

    const isTranscript =
      /文字起こし|トランスクリプト|書き起こし|全文/.test(header) ||
      (sectionText.length > 3000 && /\[\d{1,2}:\d{2}\]/.test(sectionText));

    sections.push({ header, content: sectionText, isTranscript });
  }

  const prioritySections = sections.filter((s) => !s.isTranscript);
  const transcriptSections = sections.filter((s) => s.isTranscript);

  const reorderedParts: string[] = [];

  if (preamble) {
    reorderedParts.push(preamble);
  }

  for (const s of prioritySections) {
    reorderedParts.push(s.content);
  }

  for (const s of transcriptSections) {
    reorderedParts.push(s.content);
  }

  return reorderedParts.join('\n\n');
}

export function anonymizeForImageGeneration(text: string): string {
  const publicOfficeTitles = /(\S{1,6})(大統領|副大統領|首相|総理|大臣|副大臣|長官|副長官|知事|副知事|市長|町長|村長|議長|副議長|委員長|総裁|党首|幹事長|官房長官|書記長|国務長官|国防長官|司令官)/g;
  let result = text;
  const nameMap = new Map<string, string>();
  let counter = 1;

  result = result.replace(publicOfficeTitles, (_match, name, title) => {
    if (!nameMap.has(name)) {
      nameMap.set(name, `人物${String.fromCharCode(64 + counter)}`);
      counter++;
    }
    return nameMap.get(name)! + title;
  });

  for (const [original, replacement] of nameMap) {
    if (original.length >= 2) {
      result = result.split(original).join(replacement);
    }
  }

  if (nameMap.size > 0) {
    console.log(`[Grareco] 匿名化: ${nameMap.size}件の公人名を置換 (${Array.from(nameMap.keys()).join(', ')})`);
  }
  return result;
}

const AGE_APPEARANCE: Record<string, string> = {
  '10才未満': '子ども',
  '10代': '十代くらい',
  '20代': '二十代くらいの大人',
  '30代': '三十代くらいの大人',
  '40代': '四十代くらいの大人',
  '50代': '五十代くらいの大人',
  '60代': '六十代くらいの大人',
  '70代': '七十代くらいの大人',
  '80才以上': '八十歳以上くらいの大人',
};

function extractLastName(fullName: string): string {
  const parts = fullName.split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return fullName;
  const isJapanese = /^[\u3000-\u9FFF\uF900-\uFAFF]/.test(parts[0]);
  return isJapanese ? parts[0] : parts[parts.length - 1];
}

function describeAppearance(gender?: string, age?: string): string {
  const traits: string[] = [];
  if (gender && gender !== '分からない') {
    traits.push(gender === '男' ? '男性' : gender === '女' ? '女性' : gender);
  }
  if (age && age !== '分からない') {
    const appearance = AGE_APPEARANCE[age];
    if (appearance) traits.push(appearance);
  }
  return traits.join('・');
}

export function buildParticipantsSection(
  participants: Array<{ name: string; gender?: string; age?: string; other?: string }>
): string {
  const valid = participants.filter((p) => p.name && String(p.name).trim());
  if (valid.length === 0) return '';

  const lines = valid
    .map((p) => {
      const name = extractLastName(String(p.name).trim());
      const appearance = describeAppearance(p.gender, p.age);
      return appearance ? `- 名前: ${name} ／ 外見メモ: ${appearance}` : `- 名前: ${name}`;
    })
    .join('\n');

  return `【参加者情報】
※ この節は「誰をどう描くか」の指示です。画像に文字として書いてよいのは名前だけで、
　 外見メモは絵姿を決めるためだけに使い、文字としては描かないでください。
${lines}

★最重要ルール（登場人物の描き分け）:
- 登録済み参加者は主要な登場人物として必ず描いてください（最優先）
- 未登録でも発言している人物は補助的に描いて構いませんが、登録済み参加者より目立たせないでください。名前は考えず、ラベルが要るときは入力データにある呼び方で役割（講師・受講者・上司・担当者など）だけを添えてください
- 話題として言及されるだけの人物は登場人物として描かないでください

★名前と外見の厳守ルール:
- テキスト中に表記揺れ（ひらがな・カタカナ・略称・音声認識の誤変換等）がある場合でも、上記の「名前」の表記のみを使用してください
- 「外見メモ」の性別・年齢感に従って人物を描いてください。テキスト内容から推測して変えないでください
- 年代は大まかな雰囲気で表し、白髪やしわなどの決まった特徴を当てはめて描かないでください
- 同一人物を複数回描く場合も、名前の表記と外見を一貫させてください

★人物に添える文字は登録された名前か役割だけ:
- 人名を書いてよいのは、上の「名前」に登録された人だけです。登録されていない人物に名前を考えて書き添えないでください
- 名前の下やカッコ内に、年齢・年代・性別・肩書などのプロフィールを書き添えないでください
- 「外見メモ」の語句をそのまま画像内の文字として描かないでください`;
}

export interface GrarecoInputOptions {
  additionalContext?: string;
  additionalPrompt?: string;
  imageAnalysisText?: string;
}

export function buildGrarecoInput(text: string, options?: GrarecoInputOptions): string {
  let inputData = '';

  if (options?.imageAnalysisText) {
    inputData += `【添付画像の解析結果】\n${options.imageAnalysisText}\n\n---\n`;
  }

  const reorderedText = reorderSectionsForGrareco(text);

  const textHasSupplementary = text.includes('【画像分析結果') || text.includes('【メモ（');
  if (options?.additionalContext && !textHasSupplementary) {
    inputData += `【追加コンテキスト・参考情報】\n${options.additionalContext}\n\n---\n`;
  } else if (options?.additionalContext && textHasSupplementary) {
    const userContext = options.additionalContext.split('\n\n---\n')[0];
    if (userContext && !userContext.includes('【参加者メモ】') && !userContext.includes('【画像分析結果】')) {
      inputData += `【追加コンテキスト・参考情報】\n${userContext}\n\n---\n`;
    }
  }
  inputData += reorderedText;
  if (options?.additionalPrompt) {
    inputData += `\n\n---\n【追加の指示】\n${options.additionalPrompt}`;
  }

  return anonymizeForImageGeneration(inputData);
}

export function buildGrarecoPrompt(inputData: string, refImageCount: number): string {
  const hasRefImages = refImageCount > 0;

  const refImageNames = Array.from({ length: refImageCount }, (_, i) => `image_${i}.png`);
  const styleSection = hasRefImages
    ? `**参照スタイル:**
添付された画像 ${refImageNames.map((n: string) => `\`${n}\``).join('、')} のスタイルを完全に模倣してください。
* **タッチ:** 温かみのある手書きの線、色鉛筆やマーカーで着色したような質感。デジタルでありながらアナログ感のある仕上げ。
* **雰囲気:** 親しみやすく、ポジティブで、少しコミカルなイラスト（人物、ロボット、アイコン）。
* **構成要素:** フキダシ、矢印、囲み枠、強調マーク（！、二重丸）、番号付きリスト、フローチャート。`
    : `**スタイル指定:**
以下のスタイルで描いてください。
* **タッチ:** 温かみのある手書きの線、色鉛筆やマーカーで着色したような質感。デジタルでありながらアナログ感のある仕上げ。
* **雰囲気:** 親しみやすく、ポジティブで、少しコミカルなイラスト（人物、ロボット、アイコン）。
* **構成要素:** フキダシ、矢印、囲み枠、強調マーク（！、二重丸）、番号付きリスト、フローチャート。
* **色使い:** 明るいパステルカラーを基調に、重要な部分は赤やオレンジで強調。背景は白またはクリーム色。`;

  const hasParticipants = inputData.includes('【参加者情報');
  const characterInstruction = hasParticipants
    ? `* **キャラクターの配置:** 参加者情報に登録されたメンバーを主要な登場人物として必ず描いてください。フキダシで補足説明やコメントをさせることで、親近感を高めてください。`
    : `* **キャラクターの配置:** メインの解説者（人物やロボット）を配置し、フキダシで補足説明やコメントをさせることで、親近感を高めてください。`;

  const characterLabelRule = hasParticipants
    ? `* **人物に添える文字:** 人名を書いてよいのは、参加者情報に登録された名前だけです。登録されていない人物には名前を考えて書き添えず、ラベルが要るときは入力データにある呼び方で役割（講師・受講者・上司・担当者など）だけを書いてください。年齢・年代・性別・肩書などのプロフィールを、人物のラベルとして描き込まないでください。`
    : `* **人物に添える文字:** 参加者情報が無いので、人名を考えて書き添えないでください。ラベルが要るときは、入力データにある呼び方で役割（講師・受講者・上司・担当者など）だけを書いてください。年齢・年代・性別・肩書などのプロフィールを、人物のラベルとして描き込まないでください。`;

  return `**役割設定:**

あなたは、複雑な情報（動画の書き起こし、議論の記録、難解な学術文章など）を、誰にでも直感的に理解できる親しみやすい「手書き風グラフィックレコーディング（グラレコ）」に変換するプロのイラストレーター兼情報デザイナーです。あなたの目標は、情報を正確に伝えつつ、見る人が楽しく学べるような魅力的なビジュアルを作成することです。

${styleSection}

**タスク指示:**
以下の「入力データ」を元に、以下の要件に従って一枚のグラフィックレコーディングを作成してください。

1. **全体の構造とレイアウト:**
* **タイトル:** 最上部に、内容を端的に表す大きくキャッチーな手書きタイトルを配置してください。（例：「新商品の企画会議 3つの論点」「社内イベント準備の進め方」）
* **セクション分割:** 情報を論理的な塊（章やステップ）に分割し、それぞれに番号（1, 2, 3...）とサブタイトルを付けてください。${hasRefImages ? '参照画像のように、' : ''}画面全体を使って情報を配置し、視線の流れ（左から右、上から下、または中央から放射状）を作ってください。
* **まとめエリア:** 最後に必ず「まとめ」や「重要なポイント」「アクションアイテム」のセクションを設け、核心となるメッセージを強調してください。

2. **ビジュアル表現と情報デザイン:**
* **キーワードの強調:** テキストから重要なキーワードやフレーズを抽出し、太字、色文字、または囲み枠で強調してください。
* **イラスト化:** 抽象的な概念を具体的なイラストに変換してください。（例：アイデア→ひらめきの星、比較→天びん、締め切り→砂時計、意見の対立→向かい合う二人と稲妻、合意→握手）。
* **フローの可視化:** 手順、因果関係、時間の流れなどを、太い手書きの矢印を使って明確に示してください。
* **アイコンの活用:** 書類、パソコン、虫眼鏡、カレンダーなどのアイコンを多用し、テキストの内容を直感的に補足してください。
${characterInstruction}
${characterLabelRule}

3. **テキストの扱い:**
* 長い文章は避け、箇条書きや短いフレーズに要約してください。
* 専門用語や難しい言葉には、簡単な説明や「（ひとことで言うと、手順を減らすこと）」のような補足をフキダシで追加してください。

**制約事項:**
* 出力は一枚の画像として完結させること。
* すべての要素（テキスト含む）を手書き風のスタイルで統一すること。
* 画像内のテキストは、入力データの発話・本文と同じ言語で書くこと（日本語の会議なら日本語）。翻訳や言語の変更はしないこと。
* 情報の正確性を維持し、元のテキストの意味を歪めないこと。
* ★最重要: 入力データに含まれるすべてのセクションの内容をバランスよく反映すること。特に【サマリー】は会議の全体像を凝縮した最重要情報源であるため、最優先で反映すること。【全文書き起こし】は抜粋である場合があるため、サマリーの内容と矛盾しない範囲で補足的に活用すること。入力データに存在するセクションのみを対象とし、すべての情報源を統合してグラレコに描いてください。

**入力データ:**

${inputData}`;
}

export function buildRevisePrompt(originalText: string, revisionInstruction: string): string {
  return `**役割設定:**

あなたは、グラフィックレコーディング（グラレコ）を修正するプロのイラストレーター兼情報デザイナーです。

**タスク:**

添付された元のグラフィックレコーディング画像を修正してください。

**最重要ルール: 以下の修正指示を必ず守ってください。**

**修正指示:**
${revisionInstruction.slice(0, 2000)}

**元のテキストデータ（参考）:**
${originalText.slice(0, 5000)}

**制約事項:**
* 修正指示で指定された部分のみ変更し、それ以外は元の画像のスタイル・レイアウトを維持すること。
* 出力は一枚の画像として完結させること。
* すべての要素を手書き風のスタイルで統一すること。`;
}

export const __test__ = {
  reorderSectionsForGrareco,
  anonymizeForImageGeneration,
  buildGrarecoInput,
  buildGrarecoPrompt,
};
