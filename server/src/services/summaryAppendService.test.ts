
import {
  demoteHeadingsInSupplementary,
  splitIntoSections,
  insertSectionChronologically,
  wallToRecordingMs,
  toRecordingElapsedMs,
  type ClockPoint,
} from './summaryAppendService.js';

let pass = 0;
let fail = 0;

function expect(label: string, ok: boolean, detail?: string) {
  if (ok) {
    pass++;
    console.log(`  ✅ ${label}`);
  } else {
    fail++;
    console.log(`  ❌ ${label}${detail ? ` (${detail})` : ''}`);
  }
}

console.log('\n=== demoteHeadingsInSupplementary ===');
expect(
  '番号付きの ## 見出しを ### にする',
  demoteHeadingsInSupplementary('## 1. 新商品の特徴') === '### 1. 新商品の特徴',
);
expect(
  '# 見出しも ### にする',
  demoteHeadingsInSupplementary('# 資料: 月ごとの来店者数') === '### 資料: 月ごとの来店者数',
);
expect(
  '### 以下の見出しは変えない',
  demoteHeadingsInSupplementary('### 結論\n#### 理由') === '### 結論\n#### 理由',
);
expect(
  '# を含む本文の行や表の行は変えない',
  demoteHeadingsInSupplementary('・人気投票で #1 になった\n|項目|数|') === '・人気投票で #1 になった\n|項目|数|',
);
expect(
  '# の直後に空白が無い行は変えない',
  demoteHeadingsInSupplementary('##新商品') === '##新商品',
);

console.log('\n=== splitIntoSections ===');
const digest = ['## 1. 新商品の特徴（資料 3, 5/12ページ）', '・持ち運びやすい大きさ', '## 2. 発売までの予定', '・来月に試作品を確認'].join('\n');
const heading = '## 0. 共有画面の資料 [21:30] [補足資料]';
const marker = '<!-- supplementary:image:99 -->';

const brokenSection = [heading, ...digest.split('\n'), marker].join('\n');
expect(
  '見出しを下げないと資料の見出しで区切られて 3 つに分かれる',
  splitIntoSections(brokenSection).sections.length === 3,
  `${splitIntoSections(brokenSection).sections.length}`,
);

const fixedSection = [heading, ...demoteHeadingsInSupplementary(digest).split('\n'), marker].join('\n');
const fixed = splitIntoSections(fixedSection);
expect('見出しを下げると 1 つのまま', fixed.sections.length === 1, `${fixed.sections.length}`);
expect(
  '見出し・箇条書き・目印の行がすべて残る',
  fixed.sections[0].length === 6 && fixed.sections[0].includes('・来月に試作品を確認') && fixed.sections[0].includes(marker),
);

console.log('\n=== insertSectionChronologically ===');
const existing = [
  '## 1. 開会と出席の確認 [00:00-05:00]',
  '・全員がそろった',
  '',
  '## 2. 展示会の準備 [25:00-30:00]',
  '・ブースの担当を決めた',
].join('\n');
const inserted = insertSectionChronologically(
  existing,
  [heading, ...demoteHeadingsInSupplementary(digest).split('\n'), marker],
  21 * 60 + 30,
);
expect('時刻の順に合う 2 番目に入れる', inserted.sectionNumber === 2, `${inserted.sectionNumber}`);
expect(
  '入れた後も全体は 3 つのまま',
  splitIntoSections(inserted.content).sections.length === 3,
  `${splitIntoSections(inserted.content).sections.length}`,
);
expect(
  '番号を 1, 2, 3 に振り直す',
  /## 1\. 開会/.test(inserted.content) &&
    /## 2\. 共有画面の資料 \[21:30\] \[補足資料\]/.test(inserted.content) &&
    /## 3\. 展示会/.test(inserted.content),
);
expect('下げた見出しが本文の中に残る', inserted.content.includes('### 1. 新商品の特徴（資料 3, 5/12ページ）'));

console.log('\n=== wallToRecordingMs / toRecordingElapsedMs ===');
const MIN = 60_000;
const points: ClockPoint[] = [];
for (let m = 0; m <= 60; m += 1) points.push({ wallMs: m * MIN, recMs: m * MIN });
for (let m = 120; m <= 180; m += 1) points.push({ wallMs: m * MIN, recMs: (m - 60) * MIN });

expect('止める前の時刻はそのまま', wallToRecordingMs(points, 30 * MIN) === 30 * MIN);
expect('再開後の時刻からは止めていた時間を引く', wallToRecordingMs(points, 150 * MIN) === 90 * MIN);
expect('止めている間の時刻は止める直前の録音時間にする',
  wallToRecordingMs(points, 90 * MIN) === 60 * MIN);
expect('記録の点と点の間は進んだ分だけ足す', wallToRecordingMs(points, 30.5 * MIN) === 30.5 * MIN);
expect('録音の終わりより後の時刻は録音の終わりにする', wallToRecordingMs(points, 200 * MIN) === 120 * MIN);

const late: ClockPoint[] = [{ wallMs: 14 * MIN, recMs: 0 }, { wallMs: 20 * MIN, recMs: 6 * MIN }];
expect('最初の点より前の時刻は 0 を下回らない', wallToRecordingMs(late, 5 * MIN) === 0);
expect('録音の開始までの時間を差し引く', wallToRecordingMs(late, 17 * MIN) === 3 * MIN);

expect('対応表が空なら経過時間をそのまま返す', toRecordingElapsedMs([], 42 * MIN) === 42 * MIN);
expect('経過時間が null なら null を返す', toRecordingElapsedMs(points, null) === null);
expect('経過時間が負なら null を返す', toRecordingElapsedMs(points, -1) === null);

const summary = [
  '## 1. 予算の確認 [00:00-59:00]', '・今期の残りを確かめた',
  '## 2. 会場の下見 [60:00-89:00]', '・候補を二つに絞った',
  '## 3. 当日の役割分担 [90:00-119:00]', '・受付は佐藤さん',
].join('\n');
const wallLabelSec = 140 * 60;
const recSec = wallToRecordingMs(points, wallLabelSec * 1000) / 1000;
const placed = insertSectionChronologically(summary, ['## 0. 共有画面の資料 [1:20:00] [補足資料]', '・会場の見取り図'], recSec);
expect('録音時間に直すと 3 番目に入る', placed.sectionNumber === 3, `section=${placed.sectionNumber}`);
const naive = insertSectionChronologically(summary, ['## 0. 共有画面の資料 [2:20:00] [補足資料]', '・会場の見取り図'], wallLabelSec);
expect('録音時間に直さないと最後の 4 番目に入る', naive.sectionNumber === 4);

console.log(`\n=== 結果: ${pass} passed, ${fail} failed ===\n`);
process.exit(fail > 0 ? 1 : 0);
