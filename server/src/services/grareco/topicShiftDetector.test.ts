
import { __test__ } from './topicShiftDetector.js';

const { cosineSimilarity } = __test__;

let pass = 0;
let fail = 0;

function approx(a: number, b: number, tol = 1e-6): boolean {
  return Math.abs(a - b) < tol;
}

function expect(label: string, ok: boolean, detail?: string) {
  if (ok) {
    pass++;
    console.log(`  ✅ ${label}`);
  } else {
    fail++;
    console.log(`  ❌ ${label}${detail ? ` (${detail})` : ''}`);
  }
}

console.log('\n=== cosineSimilarity ===');

const v1 = [1, 0, 0];
const v2 = [0, 1, 0];
expect(
  '直交する 2 つのベクトルでは 0 を返す',
  approx(cosineSimilarity(v1, v2), 0),
  String(cosineSimilarity(v1, v2)),
);

expect(
  '同じベクトルどうしでは 1 を返す',
  approx(cosineSimilarity(v1, v1), 1),
);

const v3 = [1, 1, 0];
const v4 = [1, 0, 0];
expect(
  '45 度離れたベクトルでは cos45° を返す',
  approx(cosineSimilarity(v3, v4), Math.cos(Math.PI / 4), 1e-4),
  String(cosineSimilarity(v3, v4)),
);

expect(
  '逆向きのベクトルでは -1 を返す',
  approx(cosineSimilarity([1, 2, 3], [-1, -2, -3]), -1, 1e-6),
  String(cosineSimilarity([1, 2, 3], [-1, -2, -3])),
);

expect(
  '長さ 0 のベクトルを含むときは 0 を返す',
  cosineSimilarity([0, 0, 0], [1, 1, 1]) === 0,
);

expect(
  '次元の異なるベクトルでは 0 を返す',
  cosineSimilarity([1, 2], [1, 2, 3]) === 0,
);

expect(
  '空の配列どうしでは 0 を返す',
  cosineSimilarity([], []) === 0,
);

console.log(`\n結果: ${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
