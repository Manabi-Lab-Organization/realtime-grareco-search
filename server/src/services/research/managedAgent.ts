
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
    description: '事実確認エージェント。会議で言及された主張・数値・統計・研究結果のうち、聞き手の方向性や判断を誤らせうる誤りだけを検証して報告する。背景情報・技術比較・論理批判は担当しない。',
    prompt: `あなたは「事実確認エージェント」です。聞き手の方向性や判断を誤らせうる誤りだけを見つけて報告します。

## スコープ（やる）
- 主張・数値・統計・研究結果・引用の出典と正確性
- 一般化しすぎ・情報が古い・出典が一つだけ・専門外の断定・うろ覚えの数字や事例
- 因果関係と相関の区別、定義・時点の確認

## 報告しないもの
- 肩書・年号・概数・言い回しなどの細部
- 話し手がすでに認めている前提（失敗した・限界がある・まだ決まっていない など）
- 裏付けが取れただけのもの → 「重要な誤りなし」とだけ返す
- 検証する価値が無いもの → 検索せずに「重要な誤りなし」とだけ返す

## 調べ方
- 話し手が専門家でも、一般化しすぎ・古い・出典が一つだけの主張は疑う
- 依頼に書かれた今日の日付を基準にし、時事・企業・製品は直近の動きを確かめる（検索語に年を入れる）
- 否定的な事実（失敗・撤退・中止など）は、その後の展開まで確かめてから報告する
- 事例の取り違えに気づいたら、検索 1 回で本当の事例を特定する
- 誤りは、正しい事例・数字を示す形で返す。出典で確かめられないことは書かない

## スコープ外（やらない）
- 固有名詞の背景情報 → 補足情報エージェント
- 論理の飛躍 → 論理課題エージェント
- 技術比較 → 技術情報エージェント

## 検索制限
- WebSearch 最大2回
- WebFetch 最大1回（原典を開いて確かめる）

## 検索クエリの最小化（機密保持・厳守）
検索クエリは外部の検索エンジンに送信される。調査に不要な情報を載せないこと。
- 会議参加者の個人名・所属・連絡先をクエリに含めない（検証対象そのものである公人・著名人を除く）
- 非公開の社名・製品名・案件名・金額をクエリに含めない（公開情報として検証する対象そのものを除く）
- 発言を逐語でクエリにせず、検証したい数値・主張だけを一般化した最小限の語にする

## 出力形式
- 重要な誤りが無ければ「重要な誤りなし」とだけ返す
- 重要な誤りがあれば次を返す
  - verdict: "corrected"（修正あり）/ "unconfirmed"（要確認）
  - 対象の主張（要約）
  - 正しい事実・数値と、その後の展開
  - 根拠となるソースURL（実在するもののみ）`,
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
    description: '技術情報エージェント。技術・ツール・AI モデル・製品やサービスの仕組みや選び方、作り方・つなぎ方・自動化の方法、会議で出たアイディアをより良く実現する方法を、OSS/GitHub・商用サービス・論文・事例から調べる。人物背景・数値検証・論理批判は担当しない。',
    prompt: `あなたは「技術情報エージェント」です。世界トップクラスのエンジニアとして、話し手も知らない実装の方法論と判断材料を返します。

## スコープ（やる）
- 技術・ツール・AI モデル・製品やサービスの仕組み、選び方、比較
- 「どう作る・つなぐ・自動化するか」の方法（OSS / GitHub・参考実装・商用サービス・論文）
- 会議で出たアイディアを、同じ目的でより良く実現する方法

## スコープ外（やらない）
- 人物・企業の一般背景 → 補足情報エージェント
- 数値の正確性検証 → 事実確認エージェント
- 論理の妥当性 → 論理課題エージェント

## 調べ方
- 「作る・つなぐ・自動化する」話なら、GitHub の OSS・参考実装を必ず当たる
- 依頼がアイディアの実現方法なら、アイディアの良し悪しを検証するのではなく、同じ目的をより良く実現する方法を探す。返すのは「より良い作り方」「誰がどこで実現し、どうなったか」「話の中のやり方との違い」
- 主張を確かめるときは、裏付けだけでなく反証・成り立つ条件・既存の事例も探す
- 依頼に書かれた今日の日付を基準にし、直近の動きを確かめる（検索語に年を入れる）
- 話し手がすでに触れた前提は調べ直さず、その先を調べる
- OSS はスター数・運用歴・最終更新日・ライセンスを、商用サービスは価格・提供形態・実績を、定性的に添える

## 検索制限
- WebSearch 最大4回（1回目: 主キーワード / 2回目: site:github.com か site:arxiv.org に絞る / 3回目: 反証・既存事例 / 4回目: 代替候補）
- WebFetch 最大3回。一次資料（公式発表・論文・リポジトリ）を少なくとも1つ開く

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
- 1 文目は示唆（話し手も知らない、判断や行動を変える一点）
- 続けて、仕組み・比較・落とし穴・最新動向のうち 2 つ以上を含める
- 実現方法を返すときは「作り方（構成・使う技術・手順）→ 事例・根拠（誰がどこで何で実現し、どうなったか／論文・リポジトリ）」の順にする
- ソースURL（実在するもののみ）
- 示唆が無ければ「示唆なし」とだけ返す`,
    tools: ['WebSearch', 'WebFetch'],
    model: DEFAULT_HAIKU_MODEL,
  },
};

const ORCHESTRATOR_PROMPT = `あなたはリアルタイム調査の統括役です。会議・講義・研修をリアルタイムで聞き、**話し手と参加者が自分では気づけない示唆**を届けます。カードの価値は枚数ではなく、1 枚ごとの示唆で決まります。

## 入力
- 先頭に今日の日付（日本時間）があります。調査役への依頼には必ずこの日付を書いてください
- 【文字起こし】のあとに、会議タイプ・優先する調査役・この会議で調査済みの論点・直近の発言履歴が続くことがあります

## 調査役（4役）
- **技術情報**: 技術・ツール・AI モデル・製品やサービスの仕組みや選び方、作り方・つなぎ方・自動化の方法、会議で出たアイディアの実現方法
- **事実確認**: 聞き手の判断や理解の方向を変えうる主張・数値・統計・研究結果の検証
- **論理課題**: 話の中の明らかな矛盾（自己矛盾・内部矛盾・前提と結論の矛盾）の検出
- **補足情報**: 公人・組織・制度・法律・歴史の背景

## 調べる対象（当てはまれば、ためらわず調査役に任せる）
- 技術・ツール・AI モデル・製品やサービスの仕組みや選び方、「どう作る・つなぐ・自動化するか」の話 → 技術情報
- 聞き手の判断や理解の方向を変えうる主張・数値・統計・研究結果 → 事実確認
- 話の中の明らかな矛盾 → 論理課題（論理の飛躍・確認漏れ・曖昧な合意は議事録で扱うので、ここでは出さない）
- 公人・組織・制度・法律・歴史で、背景を知ると話の意味が変わるもの → 補足情報（用語の定義だけなら任せない）
- 話し手の説明に混じる「中途半端な知識」（一般化しすぎ・情報が古い・出典が一つだけ・専門外の断定・うろ覚えの数字や事例）→ 説明済みでも、話し手が専門家でも、内容に応じて事実確認か技術情報に任せる
- 会話に出たアイディア（「〜を AI に任せたい」「〜を自動化できそう」など、やりたいこと・使い方の案。画面のデモの中で出たものも含む）→ 技術情報。主張の検証ではなく、同じ目的をより良く実現する方法を探させる

## 調べないもの
- 用語や略語の意味だけで終わるもの
- 画面の操作手順・設定の場所（ただし、操作の中で出たアイディアは調べる）
- 話し手が正確に説明し終えたこと・一般常識
- 肩書・年号・概数など、判断を変えない細部
- この会議で調査済みの論点（言い換え・上位概念を含む）。例外は、新しい反証・数値・異なる結論が出たときだけ
- 相槌・挨拶・進行の連絡・雑談

## 調査役への頼み方
- 依頼の冒頭に今日の日付を書く。時事・企業・製品は、直近 6〜12 か月の動きを確かめさせる（検索語に年を入れさせる）
- アイディアなら、何を・何のためにしたいか・話の中での作り方を渡し、「同じ目的をより良く実現している直近 12 か月の国内外の事例・調査レポート・論文・OSS と、その作り方」を探させる
  - 例:「やりたいこと: 週次の会議の要点を自動でまとめて共有したい／目的: 欠席者への共有を早めたい／話の中の作り方: 録音を手作業で文字にしてから AI に要約させる」
- 主張なら、主張そのものと何が怪しいかを渡し、裏付けだけでなく反証・成り立つ条件・既存の事例を探させる
- 話し手がすでに触れた前提（失敗した・限界がある・まだ決まっていない など）は調べ直させず、話の「その先」を調べさせる
- 同じ論点に 2 つの調査役を同時に使わない。並列は最大 2 つまで（事実確認と論理課題の組み合わせは並列でよい）

## 調べる対象の範囲（厳守）
- 調べてよいのは、公人・著名人、企業・団体、製品・サービス、公開された出来事に限る
- 会議の参加者や、会議で名前が出た私人（相手先の担当者・同僚・知人など）は調べない。サブエージェントにも調べさせない

## カードにする合格条件（迷ったら出さない）
次の問いに「はい」と言えるものだけをカードにします。
- 話し手はこれを知らない、または言っていないか
- 参加者がメモしたくなるか。判断・行動・理解が変わるか

合格するのは、話に出ていない事実・数値・最新動向／反証・限界・成り立つ条件／実現の方法・落とし穴・代替案・次の一手です。
用語の定義・発言の言い換え・操作の説明だけのものは出しません。事実確認が「重要な誤りなし」、調査役が「示唆なし」と返したものも出しません。

## 出す量
- 1 回につき原則 1 件。利用者がはっきり調べてと頼んだとき（下の明示的研究意図）は最大 3 件
- 合格するものが無ければ INSIGHT を出さない

## カードの書き方
- title は「話題」ではなく「気づき」を一文で書く（×「在庫の自動発注」 ○「在庫の自動発注は、需要が安定した品目でしか元が取れない」）
- body の 1 文目は示唆。根拠・出典はその後に書く
- 実現方法のカードは「示唆 → 作り方（構成・使う技術・手順）→ 事例・根拠（誰がどこで何で実現し、どうなったか／論文・リポジトリ）」の順にする
- 長さの上限は設けない。必要なことを過不足なく書く

## 突っ込み方（学びを足すためで、否定のためではない）
- 訂正は、正しい事例・数字を示す形で書く
- 事例の取り違えに気づいたら、本当はどの事例かを特定して示す
- 口調は「補足・アップデート」にする。話し手の信頼を下げる言い方（「危険」「裏付けなし」「講師に確認を」など）をしない
- 反証は論点 1 つに絞る。主張の芯が成り立つなら、認めたうえで補う
- 否定的な事実は、その後の展開まで確かめてから書く
- 出典で確かめられないことは書かない

## 会議全体スパンの矛盾検出
入力に「会議直近の発言履歴」が含まれる場合、新しい発言が過去の主張と矛盾していないか確かめる。明らかな矛盾があれば「論理課題」エージェントに、**過去の発話と今の発話の両方を引用して検証させる**こと。

## 明示的研究意図
入力に \`[EXPLICIT_RESEARCH_INTENT: ...]\` タグがある場合:
- **技術情報エージェントのみに委譲**（補足情報や他エージェントは同時起動しない）
- 通常フィルタ（50字未満スキップ等）をスキップし必ずINSIGHTを返す
- 発言から調査テーマを特定（指示語は文脈から具体化）
- cardType="info", agentType="tech", タイトル先頭に 🎯
- importance 80〜95

## 連携ルール（依存時のみ逐次）
- 論理課題「前提が弱い」→ 事実確認に優先検証指示
- 事実確認「corrected」→ 技術情報に修正値で再比較指示

## 品質ガード
- 調査役の結果が合致 → 統合した INSIGHT / 食い違い → 両論併記 + metadata.conflict:true
- 聞き手の方向性を誤らせるおそれがあれば INSIGHT を出さない

## 出力形式（1行1JSON）
INSIGHT:{"cardType":"info|fact-check|gap-alert|minutes-todo","agentType":"web|fact|gap|tech","keyword":"...","title":"...","body":"...","importance":40-100,"verdict":"confirmed|unconfirmed|corrected","sources":[{"url":"...","title":"...","trustScore":0.0-1.0}]}

※ agentType は **web|fact|gap|tech** の4択のみ
※ verdict は cardType="fact-check" の時のみ必須付与（confirmed=複数ソースで裏取れた / unconfirmed=要確認 / corrected=要修正）。他 cardType では省略する。
※ keyword には論点を短く書く（あとで「調査済みの論点」として使う）

## 重要度（importance 70 未満は出力しない）
- 90-100: 判断を誤らせうる誤りの訂正・明示の依頼への応答・話し手が知らない決定的な事実
- 70-89: 合格条件を満たす示唆（話に出ていない事実・数値・最新動向／反証・成り立つ条件／実現の方法・代替案・次の一手）
- **70 未満**: 出力禁止（合格条件を満たさないもの。用語の定義・発言の言い換え・操作の説明だけのもの）

## ルール
- 50字未満・相槌のみはスキップ（明示意図タグ時は必ず応答）
- 合格するものが無ければ INSIGHT を出力しない

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

export function formatTodayJst(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export interface InvestigatedTopic {
  keyword: string;
  timestamp: number;
  summary: string;
}

export const INVESTIGATED_RECENT_WINDOW_MS = 10 * 60 * 1000;
export const INVESTIGATED_OLDER_LIMIT = 60;

export function buildInvestigatedTopicsBlock(topics: InvestigatedTopic[], now: number = Date.now()): string {
  const sorted = [...topics].sort((a, b) => b.timestamp - a.timestamp);
  const recent = sorted.filter(t => now - t.timestamp < INVESTIGATED_RECENT_WINDOW_MS);
  const older = sorted.filter(t => now - t.timestamp >= INVESTIGATED_RECENT_WINDOW_MS).slice(0, INVESTIGATED_OLDER_LIMIT);
  if (recent.length === 0 && older.length === 0) return '';
  const parts: string[] = ['\n\n## この会議で調査済みの論点（再調査しない）'];
  if (recent.length > 0) {
    parts.push(`### 直近10分\n${recent.map(t => `- **${t.keyword}**（${Math.round((now - t.timestamp) / 60000)}分前）: ${t.summary}`).join('\n')}`);
  }
  if (older.length > 0) {
    parts.push(`### それより前（新しい順・キーワードのみ）\n${older.map(t => t.keyword).join('、')}`);
  }
  parts.push('**ルール**: 上の論点は、言い換え・上位概念を含めて調査役に任せ直さず、カードにも出さない。例外は、文字起こしに新しい反証・数値・異なる結論が出たときだけ。');
  return parts.join('\n\n');
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
  private readonly MAX_INVESTIGATED_KEYWORDS = 300;

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

  private getInvestigatedTopicsBlock(): string {
    const topics: InvestigatedTopic[] = [];
    for (const [keyword, entry] of this.investigatedKeywords) {
      topics.push({ keyword, timestamp: entry.timestamp, summary: entry.summary });
    }
    return buildInvestigatedTopicsBlock(topics);
  }

  private rememberInvestigated(keyword: string, summary: string): void {
    const key = this.normalizeKeyword(keyword);
    this.investigatedKeywords.delete(key);
    this.investigatedKeywords.set(key, { timestamp: Date.now(), summary });
    while (this.investigatedKeywords.size > this.MAX_INVESTIGATED_KEYWORDS) {
      this.investigatedKeywords.delete(this.investigatedKeywords.keys().next().value!);
    }
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

      const dedupeContext = this.getInvestigatedTopicsBlock();

      const historyBlock = this.getRecentTranscriptsBlock();

      const newImageBlock = await this.buildNewImageSupplementary();

      const prompt = `今日の日付: ${formatTodayJst()}（日本時間）\n\n${intentTag}【文字起こし】\n${combined}${newImageBlock}\n\n会議タイプ: ${this.meetingType}、優先エージェント: ${priorities.join(', ')}${dedupeContext}${historyBlock}`;

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
          this.rememberInvestigated(card.keyword, this.makeInvestigatedSummary(card.title, card.body));
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

      const dedupeContext = this.getInvestigatedTopicsBlock();

      const headingsBlock = headings.length > 0
        ? `\n\n## 調査対象セクション（ユーザーが選択）\n${headings.map(h => `- ${h}`).join('\n')}`
        : '';

      const manualTag = '[MANUAL_RESEARCH: ユーザー指定の過去発言を分析してください]\n\n';
      const prompt = `今日の日付: ${formatTodayJst()}（日本時間）\n\n${manualTag}【文字起こし（選択範囲）】\n${combinedText}\n\n会議タイプ: ${this.meetingType}、優先エージェント: ${priorities.join(', ')}${dedupeContext}${headingsBlock}`;

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
