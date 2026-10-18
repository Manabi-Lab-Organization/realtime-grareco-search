
export {};

process.env.TERM_HASH_SECRET = 'test-secret-for-term-hash';
process.env.GEMINI_API_KEY ||= 'dummy-key-for-unit-test';
process.env.DATABASE_URL ||= 'postgresql://postgres:password@localhost:5432/grareco';

const {
  normalizeTerm,
  termHash,
  analyzeText,
  findPrivacyViolation,
  initializeTokenizer,
} = await import('./termGlossaryService.js');

let failed = 0;
function eq(actual: unknown, expected: unknown, label: string): void {
  const ok = actual === expected;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${label} → got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}
function assert(cond: boolean, label: string): void {
  if (!cond) failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${label}`);
}

eq(normalizeTerm('ＡＰＩ '), 'api', '全角英字を半角の小文字にそろえる');
eq(normalizeTerm('ｶﾀｶﾅ'), 'カタカナ', '半角カナを全角カナにそろえる');
eq(normalizeTerm('  KPI  '), 'kpi', '前後の空白を除き小文字にする');
eq(normalizeTerm('API'), normalizeTerm('api'), '大文字と小文字の違いは同じ結果になる');

eq(termHash(1, '山田'), termHash(1, '山田'), '同じ利用者と語なら同じハッシュになる');
assert(termHash(1, '山田') !== termHash(2, '山田'), '利用者が違えば同じ語でも別のハッシュになる');
assert(termHash(1, '山田') !== termHash(1, '鈴木'), '語が違えば別のハッシュになる');
eq(termHash(1, 'API'), termHash(1, 'ａｐｉ'), '表記の違いはそろえてからハッシュにする');
eq(termHash(1, '山田').length, 64, 'ハッシュは 64 文字の16進数');
{
  const before = termHash(1, '山田');
  process.env.TERM_HASH_SECRET = 'another-secret';
  const after = termHash(1, '山田');
  process.env.TERM_HASH_SECRET = 'test-secret-for-term-hash';
  assert(before !== after, '秘密の値を変えるとハッシュも変わる');
}

const personNames = new Set<string>(['山田', '健太']);
const participants = ['鈴木'];
const rawContext = '山田さん、株式会社サンプルとの打ち合わせの件で、KPIの資料を月末までにまとめます。';

assert(
  findPrivacyViolation('重要業績評価指標のこと。目標にどれだけ近づいたかを測る数値。', 'KPI', personNames, participants, rawContext) === null,
  '一般的な説明文は問題なしと判定する',
);
assert(
  findPrivacyViolation('複数の人で書き換えられるウェブページの仕組み。', 'ウィキ', personNames, participants, rawContext) === null,
  '道具の名前の一般的な説明文も問題なしと判定する',
);
assert(
  findPrivacyViolation('山田さんが話した目標の数値のこと。', 'KPI', personNames, participants, rawContext) !== null,
  '説明文に人名が含まれると問題ありと判定する',
);
assert(
  findPrivacyViolation('健太が受け持つ範囲を指す。', 'スコープ', personNames, participants, rawContext) !== null,
  '説明文に名前だけの人名が含まれても問題ありと判定する',
);
assert(
  findPrivacyViolation('鈴木が担当する数値。', 'KPI', personNames, participants, rawContext) !== null,
  '説明文に参加者の名前が含まれると問題ありと判定する',
);
assert(
  findPrivacyViolation('株式会社サンプルとの打ち合わせの件で、という場面で使われる語。', 'KPI', personNames, participants, rawContext) !== null,
  '発言と 15 文字以上一致する説明文は問題ありと判定する',
);
{
  const names = new Set<string>(['青葉']);
  assert(
    findPrivacyViolation('青葉は架空の町の名前。', '青葉', names, [], '青葉の新しい駅について') === null,
    '説明する語そのものは人名として扱わない',
  );
}

await initializeTokenizer();
{
  const { candidates, personNames: names } = analyzeText(
    '山田さん、KPIのダッシュボードをKubernetes上に用意してPoCを来週お見せします'
  );
  assert(names.has('山田'), '人名を人名として取り出す');
  assert(!names.has('KPI'), '英字の略語は人名として扱わない');
  assert(!names.has('Kubernetes'), '英字の製品名は人名として扱わない');
  assert(candidates.includes('KPI'), '英字の略語を用語の候補にする');
  assert(candidates.includes('Kubernetes'), '英字の製品名を用語の候補にする');
  assert(candidates.includes('ダッシュボード'), 'カタカナ語を用語の候補にする');
  console.log(`  candidates=${JSON.stringify(candidates)} personNames=${JSON.stringify([...names])}`);
}
{
  const { personNames: names } = analyzeText('鈴木さんと高橋さんが出席します');
  assert(names.has('鈴木') && names.has('高橋'), '複数の人名を取り出す');
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
