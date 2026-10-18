
import { __test__ } from './autoGrarecoService.js';

const { safeParseDraft, stripJsonFence, formatTranscripts, formatResearchRefs } = __test__;

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

console.log('\n=== stripJsonFence ===');
expect(
  '囲みの無い JSON は変えずに返す',
  stripJsonFence('{"a":1}') === '{"a":1}',
);
expect(
  'json 付きの囲みを取り除く',
  stripJsonFence('```json\n{"a":1}\n```') === '{"a":1}',
);
expect(
  '言語名の無い囲みを取り除く',
  stripJsonFence('```\n{"a":1}\n```') === '{"a":1}',
);
expect(
  '前後の空白を取り除く',
  stripJsonFence('   {"a":1}   ') === '{"a":1}',
);

console.log('\n=== safeParseDraft ===');
const validJson = JSON.stringify({
  title: '新商品の企画会議',
  sections: [{ icon: '🎯', heading: '来月の展示会の準備', bullets: ['ブースの配置を決める'] }],
  highlights: [],
  researchRefs: [],
  visualStyle: 'reflect_map',
});
expect('必要な項目がそろった JSON を読み取れる', safeParseDraft(validJson) !== null);

expect(
  '囲み付きの JSON も読み取れる',
  safeParseDraft('```json\n' + validJson + '\n```') !== null,
);

expect(
  'title が無いと null を返す',
  safeParseDraft(JSON.stringify({ sections: [], highlights: [], researchRefs: [], visualStyle: 'tree' })) === null,
);

expect(
  'sections が配列でないと null を返す',
  safeParseDraft(JSON.stringify({ title: 't', sections: {}, highlights: [], researchRefs: [], visualStyle: 'tree' })) === null,
);

expect(
  'JSON として読めない文字列は null を返す',
  safeParseDraft('not json') === null,
);

expect(
  '空文字は null を返す',
  safeParseDraft('') === null,
);

console.log('\n=== formatTranscripts ===');
expect(
  '発言が無いときは決まった文を返す',
  formatTranscripts([]) === '(発言なし)',
);

const shortTr = formatTranscripts([
  { speaker: '山田', content: 'それでは始めましょう', startTime: 0 },
  { speaker: null, content: 'よろしくお願いします', startTime: 1 },
]);
expect(
  '話者名と発言を 1 行ずつ並べ、話者が無ければ ? にする',
  shortTr === '山田: それでは始めましょう\n?: よろしくお願いします',
  shortTr,
);

const longContent = 'あ'.repeat(8000);
const longTr = formatTranscripts([{ speaker: 'X', content: longContent, startTime: 0 }]);
expect(
  '6000 文字を超える分は末尾を残し、先頭に … を付ける',
  longTr.length <= 6001 && longTr.startsWith('…'),
  `len=${longTr.length}`,
);

console.log('\n=== formatResearchRefs ===');
expect(
  '参照が無いときは決まった文を返す',
  formatResearchRefs([]) === '(調査カードなし)',
);

const refsText = formatResearchRefs([
  { insightId: 42, headline: '展示会の出展料の目安', createdAt: '2001-01-15T01:00:00.000Z' },
  { insightId: 43, headline: '新商品の価格の決め方', createdAt: '2001-01-15T01:01:00.000Z' },
]);
expect(
  '参照の ID と見出しを含める',
  refsText.includes('insightId=42') && refsText.includes('展示会の出展料') && refsText.includes('insightId=43'),
  refsText,
);

console.log(`\n結果: ${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
