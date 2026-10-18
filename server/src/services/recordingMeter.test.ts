
import { recordedSecondsAt } from './recordingMeter.js';

let failed = 0;
function eq(actual: number, expected: number, label: string): void {
  const ok = actual === expected;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${label} → got ${actual}, want ${expected}`);
}

const T0 = new Date('2001-01-10T10:00:00Z');
const at = (sec: number) => T0.getTime() + sec * 1000;

eq(recordedSecondsAt(null, at(3600), 0, null), 0, '開始時刻が無ければ 0');
eq(recordedSecondsAt(T0, at(600), 0, null), 600, '一時停止が無ければ経過秒数をそのまま返す');
eq(recordedSecondsAt(T0, at(3600), 3000, null), 600, '経過秒数から一時停止の合計を引く');
eq(recordedSecondsAt(T0, at(600), 700, null), 0, '一時停止の合計が経過を超えたら 0');
eq(recordedSecondsAt(T0, at(600), null, null), 600, '一時停止の合計が null なら 0 として扱う');
eq(recordedSecondsAt(T0, at(600), 0, new Date(at(420))), 420, '一時停止中は停止した時点までの秒数を返す');
eq(recordedSecondsAt(T0.toISOString(), at(900), 0, null), 900, '開始時刻が ISO 文字列でも計算できる');

import { parsePgTimestampUTC } from '../db/index.js';
{
  const got = parsePgTimestampUTC('2001-03-20 01:30:00').getTime();
  eq(got, Date.UTC(2001, 2, 20, 1, 30, 0), 'タイムゾーンの無い日時を UTC として読む');
  eq(parsePgTimestampUTC('2001-03-20 01:30:00.5').getTime(), Date.UTC(2001, 2, 20, 1, 30, 0, 500), 'ミリ秒付きの日時も UTC として読む');
}

{
  const { displayRecordingMs } = await import('./recordingClock.js');
  const t0 = new Date('2001-02-01T00:00:00Z');
  const at = (sec: number) => t0.getTime() + sec * 1000;
  eq(displayRecordingMs(0, t0, at(600), 0, null)!, 600_000, '以前の録音時間が無ければ今回の録音時間を返す');
  eq(displayRecordingMs(128 * 60_000, t0, at(300), 0, null)!, 133 * 60_000, '以前の録音時間に今回の録音時間を足す');
  eq(displayRecordingMs(128 * 60_000, t0, at(600), 120, null)!, 136 * 60_000, '今回の一時停止の時間は足さない');
  eq(displayRecordingMs(0, null, at(10), 0, null) ?? -1, -1, '開始時刻が無ければ null を返す');
}

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
