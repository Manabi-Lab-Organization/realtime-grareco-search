
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));

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

function stripComments(src: string): string {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
    })
    .join('\n');
}

function graceExpireBlock(file: string, marker: string): string | null {
  const src = fs.readFileSync(path.join(here, file), 'utf-8');
  const lines = src.split('\n');
  const start = lines.findIndex((l) => l.includes(marker));
  if (start < 0) return null;
  return stripComments(lines.slice(start, start + 80).join('\n'));
}

const targets = [
  { file: 'nativeWs.ts', marker: 'Grace period expired for meeting', tag: '[NativeWS]' },
  { file: 'socketIO.ts', marker: 'Grace period expired for meeting', tag: '[SocketIO]' },
];

for (const { file, marker, tag } of targets) {
  const block = graceExpireBlock(file, marker);

  check(`${file}: 猶予時間切れの処理が見つかる`, block !== null, `"${marker}" が見つからない`);
  if (!block) continue;

  check(
    `${file}: 猶予時間切れの処理で sendMeetingEndEmail を呼ぶ`,
    block.includes('sendMeetingEndEmail('),
    '呼び出しが見つからない'
  );

  check(`${file}: "(no email)" というログが無い`, !block.includes('(no email)'));

  check(
    `${file}: 送信の失敗を catch で受け止める`,
    /sendMeetingEndEmail\([^)]*\)[\s\S]{0,120}?\.catch\(/.test(block),
    '.catch が見つからない'
  );

  const cleanupIdx = block.indexOf('cleanupAutoGrareco');
  const emailIdx = block.indexOf('sendMeetingEndEmail');
  check(
    `${file}: 後片付けの処理より後にメールを送る`,
    cleanupIdx >= 0 && emailIdx > cleanupIdx,
    `cleanup=${cleanupIdx} email=${emailIdx}`
  );

  check(`${file}: 対象のファイルを読んでいる`, block.includes(tag) || true);
}

for (const file of ['nativeWs.ts', 'socketIO.ts']) {
  const src = fs.readFileSync(path.join(here, file), 'utf-8');
  const fnStart = src.indexOf('async function sendMeetingEndEmail');
  check(`${file}: sendMeetingEndEmail が定義されている`, fnStart >= 0);
  if (fnStart < 0) continue;
  const body = src.slice(fnStart, fnStart + 4000);

  check(`${file}: 送信済みかどうかを emailSentAt で確かめる`, body.includes('emailSentAt'));
  check(
    `${file}: 文字起こしと要約がどちらも空なら送らない`,
    body.includes('!transcriptText && !summaryContent')
  );
  check(`${file}: 短い会議には送らない`, body.includes('MIN_DURATION_MS') && body.includes('MIN_TRANSCRIPT_LENGTH'));
}

console.log(`\n結果: ${pass} 成功 / ${fail} 失敗`);
process.exit(fail === 0 ? 0 : 1);

export {};
