
import {
  buildGrarecoInput,
  buildGrarecoPrompt,
  buildParticipantsSection,
  buildRevisePrompt,
  loadGrarecoReferenceImages,
} from './grarecoPrompt.js';
import {
  DEFAULT_GRARECO_MODEL,
  GEMINI_IMAGE_COST_USD,
  buildAttemptLadder,
  decideAspectRatio,
  readImageDimensions,
} from './imageOutput.js';

let pass = 0;
let fail = 0;

function check(label: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`✅ ${label}`);
    pass++;
  } else {
    console.log(`❌ ${label}${detail ? ` — ${detail}` : ''}`);
    fail++;
  }
}

{
  const text = [
    '【サマリー】',
    '## 1. 新商品の企画',
    '・来月の展示会に試作品を出すことにした。',
    '【全文書き起こし】',
    '[00:00:42] では、新商品の企画会議を始めます……',
  ].join('\n');

  const input = buildGrarecoInput(text);
  const summaryIdx = input.indexOf('## 1. 新商品の企画');
  const transcriptIdx = input.indexOf('【全文書き起こし】');
  check('全文書き起こしを要約より後ろに置く', summaryIdx !== -1 && transcriptIdx > summaryIdx, `summary=${summaryIdx} transcript=${transcriptIdx}`);

  const withPrompt = buildGrarecoInput(text, { additionalPrompt: 'イラストを多めに' });
  check('追加の指示を末尾に加える', withPrompt.includes('【追加の指示】\nイラストを多めに'));

  const withImage = buildGrarecoInput(text, { imageAnalysisText: 'ホワイトボードの写真' });
  check('画像の説明を先頭に加える', withImage.startsWith('【添付画像の解析結果】\nホワイトボードの写真'));
}

{
  const anonymized = buildGrarecoInput('山田市長が発言した。山田は続けて述べた。佐藤さんも同意した。');
  check('役職の付いた人名を仮の名前に置き換える', anonymized.includes('人物A市長') && !anonymized.includes('山田'));
  check('さん付けの人名は置き換えない', anonymized.includes('佐藤さん'));
}

{
  const input = buildGrarecoInput('【サマリー】\n・新商品の名前を決める');

  const withRefs = buildGrarecoPrompt(input, 4);
  check('参照画像があるときは参照スタイルの節を入れる', withRefs.includes('**参照スタイル:**') && !withRefs.includes('**スタイル指定:**'));
  check('参照画像のファイル名を順に並べる', withRefs.includes('`image_0.png`、`image_1.png`、`image_2.png`、`image_3.png`'));

  const noRefs = buildGrarecoPrompt(input, 0);
  check('参照画像が無いときはスタイル指定の節を入れる', noRefs.includes('**スタイル指定:**') && !noRefs.includes('**参照スタイル:**'));
  check('参照画像が無いときも色の指定を入れる', noRefs.includes('明るいパステルカラーを基調に'));
  check('参照画像が無いときは参照画像に触れない', !noRefs.includes('参照画像') && !noRefs.includes('image_0.png'));
  check('参照画像があるときは配置の指示でも参照画像を示す', withRefs.includes('参照画像のように、画面全体を使って'));
  check('共通の指示はどちらにも入る', noRefs.includes('★最重要: 入力データに含まれるすべてのセクション') && withRefs.includes('★最重要: 入力データに含まれるすべてのセクション'));

  const withParticipants = buildGrarecoPrompt(buildGrarecoInput('【参加者情報】\n・小林'), 0);
  check('参加者情報があるときは登場人物の指示を変える', withParticipants.includes('参加者情報に登録されたメンバーを主要な登場人物として'));

  const revise = buildRevisePrompt('展示会の準備のまとめ', '文字を大きく');
  check('修正の指示文に指示と元の文を入れる', revise.includes('文字を大きく') && revise.includes('展示会の準備のまとめ'));

  const twoRefs = buildGrarecoPrompt(input, 2);
  check('参照画像が 2 枚なら 2 つのファイル名だけを示す', twoRefs.includes('`image_0.png`、`image_1.png`') && !twoRefs.includes('image_2.png'));
}

{
  const refs = loadGrarecoReferenceImages();
  check('参考画像を読み込むと 0 枚になる', refs.length === 0, `枚数=${refs.length}`);
  const ladder = buildAttemptLadder(refs.length, decideAspectRatio(100));
  check('参考画像が無ければすべての試行で添付は 0 枚', ladder.every((a) => a.refCount === 0));
  const prompt = buildGrarecoPrompt(buildGrarecoInput('【サマリー】\n・新商品の名前を決める'), refs.length);
  check('参考画像が無いときはスタイル指定の節を入れる', prompt.includes('**スタイル指定:**') && !prompt.includes('参照画像'));
}

{
  const input = buildGrarecoInput('【サマリー】\n・新商品の名前を決める');
  const ladder = buildAttemptLadder(4, '4:3');

  check('1 回目は参照画像をすべて使い、縦横比も指定する', ladder[0].refCount === 4 && ladder[0].aspectRatio === '4:3');
  check('2 回目は参照画像を外し、縦横比は指定したまま', ladder[1].refCount === 0 && ladder[1].aspectRatio === '4:3');
  check('3 回目以降は縦横比の指定も外す', ladder.slice(2).every((a) => a.refCount === 0 && a.aspectRatio === undefined));
  check('後の試行ほど待ち時間を長くする', ladder[2].delayMs === 2000 && ladder[3].delayMs === 3000 && ladder[4].delayMs === 5000);
  check('1 回目と 2 回目は待たない', ladder[0].delayMs === undefined && ladder[1].delayMs === undefined);
  check('試行は 5 回', ladder.length === 5);
  check('どの試行も添付の枚数を超えない', ladder.every((a) => a.refCount <= 4));

  for (const [i, attempt] of ladder.entries()) {
    const prompt = buildGrarecoPrompt(input, attempt.refCount);
    const mentionsRefFiles = prompt.includes('image_0.png');
    check(
      `試行${i + 1}（添付${attempt.refCount}枚）の指示文が添付の有無と合う`,
      mentionsRefFiles === attempt.refCount > 0,
      `refCount=${attempt.refCount} だが参照ファイル名の言及=${mentionsRefFiles}`
    );
  }

  const noRefLadder = buildAttemptLadder(0, '16:9');
  check('参照画像が無ければすべての試行で 0 枚', noRefLadder.every((a) => a.refCount === 0));
  check('参照画像が無くても 1 回目は縦横比を指定する', noRefLadder[0].aspectRatio === '16:9');
  check('参照画像が無くても試行は 5 回', noRefLadder.length === 5);
}

{
  check('短い内容では 16:9 を選ぶ', decideAspectRatio(1_000) === '16:9');
  check('中くらいの内容では 4:3 を選ぶ', decideAspectRatio(5_000) === '4:3');
  check('長い内容では 1:1 を選ぶ', decideAspectRatio(50_000) === '1:1');
  check('3000 文字ちょうどでは 4:3 を選ぶ', decideAspectRatio(3_000) === '4:3');
  check('10000 文字ちょうどでは 1:1 を選ぶ', decideAspectRatio(10_000) === '1:1');
  check('0 文字では 16:9 を選ぶ', decideAspectRatio(0) === '16:9');

  const ratioOf = (s: string) => {
    const [w, h] = s.split(':').map(Number);
    return w / h;
  };
  const lens = [500, 2_999, 3_000, 9_999, 10_000, 200_000];
  const ratios = lens.map((n) => ratioOf(decideAspectRatio(n)));
  check('内容が長いほど横長の度合いが小さくなる', ratios.every((r, i) => i === 0 || r <= ratios[i - 1]), ratios.join(','));
  check('縦長の比率は選ばない', ratios.every((r) => r >= 1));
}

{
  const png = Buffer.alloc(32);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(png, 0);
  png.writeUInt32BE(1200, 16);
  png.writeUInt32BE(896, 20);
  check('PNG の幅と高さを読み取る', readImageDimensions(png) === '1200x896', readImageDimensions(png));

  const jpeg = Buffer.alloc(20);
  jpeg[0] = 0xff;
  jpeg[1] = 0xd8;
  jpeg[2] = 0xff;
  jpeg[3] = 0xc0;
  jpeg.writeUInt16BE(11, 4);
  jpeg[6] = 8;
  jpeg.writeUInt16BE(768, 7);
  jpeg.writeUInt16BE(1376, 9);
  check('JPEG の幅と高さを読み取る', readImageDimensions(jpeg) === '1376x768', readImageDimensions(jpeg));

  check('画像でなければ undefined を返す', readImageDimensions(Buffer.from('not an image')) === undefined);
  check('空のデータでは undefined を返す', readImageDimensions(Buffer.alloc(0)) === undefined);
}

{
  check('既定のモデル名', DEFAULT_GRARECO_MODEL === 'gemini-3.1-flash-image');
  check('1 枚あたりの料金の既定値', GEMINI_IMAGE_COST_USD === 0.067);
}

{
  const section = buildParticipantsSection([
    { name: 'kato', gender: '男', age: '30代' },
    { name: '山田 一郎', gender: '男', age: '50代' },
    { name: 'mori', gender: '分からない', age: '分からない' },
  ]);

  check('年代の数字をそのまま入れない', !/\d+代/.test(section), section.match(/\d+代/)?.[0]);
  check('年代を数字を使わない言葉に置き換える', section.includes('男性・三十代くらいの大人') && section.includes('男性・五十代くらいの大人'));
  const memoLines = buildParticipantsSection([
    { name: 'a', age: '60代' }, { name: 'b', age: '70代' }, { name: 'c', age: '80才以上' }, { name: 'd', age: '50代' },
  ]).split('\n').filter((l) => l.includes('外見メモ:'));
  check('年代を白髪などの見た目の特徴に置き換えない', memoLines.length === 4 && memoLines.every((l) => !/白髪|ベテラン|年配|高齢/.test(l)), memoLines.join(' | '));
  check('分からない性別と年代は書かない', section.includes('- 名前: mori') && !section.includes('mori ／'));
  check('日本語の名前は姓だけを使う', section.includes('- 名前: 山田 ') && !section.includes('山田 一郎'));
  check('人物に添える文字は登録された名前か役割だけと指示する', section.includes('★人物に添える文字は登録された名前か役割だけ'));
  check('参加者がいなければ空文字を返す', buildParticipantsSection([]) === '' && buildParticipantsSection([{ name: '  ' }]) === '');

  const unknownAge = buildParticipantsSection([{ name: 'x', gender: '女', age: '90代' }]);
  check('想定外の年代は書かない', unknownAge.includes('外見メモ: 女性') && !unknownAge.includes('90代'));

  const prompt = buildGrarecoPrompt(buildGrarecoInput(section), 4);
  check('指示文に人物に添える文字の決まりを入れる', prompt.includes('* **人物に添える文字:**'));
  check('参加者がいなくても同じ決まりを入れる', buildGrarecoPrompt(buildGrarecoInput('【サマリー】\n・新商品の名前を決める'), 4).includes('* **人物に添える文字:**'));

  check('指示文全体に年代の数字が無い', !/\d+代/.test(prompt), prompt.match(/\d+代/)?.[0]);
}

console.log(`\n結果: ${pass} 成功 / ${fail} 失敗`);
process.exit(fail === 0 ? 0 : 1);
