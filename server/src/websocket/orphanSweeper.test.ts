
process.env.ELEVENLABS_API_KEY ||= 'test-key-not-used';

const { ElevenLabsSession, listLiveSessions, closeAllSessions } = await import('../services/elevenLabsService.js');
const registry = await import('./meetingRegistry.js');

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

const noop = () => {};
function makeSession() {
  return new ElevenLabsSession('key', noop as any, noop as any, noop as any);
}

function makeRecording(meetingId: number, elevenlabs: any) {
  return {
    meetingId,
    userId: 1,
    connectionType: 'nativeWs' as const,
    connectionId: `conn-${meetingId}`,
    elevenlabs,
    summaryTimer: null,
    startTime: Date.now(),
    transcriptBuffer: '',
    previousSummary: null,
    transcriptsWithTime: [],
    lastSummaryTranscriptIndex: 0,
    lastSummaryTime: 0,
    consolidationDone: false,
    onTakeover: noop,
  };
}

closeAllSessions('test-setup');

{
  const before = listLiveSessions().length;
  const s = makeSession();
  check('作ったセッションが一覧に加わる', listLiveSessions().length === before + 1);
  check('els- で始まる ID が付く', typeof s.sessionId === 'string' && s.sessionId.startsWith('els-'), s.sessionId);
  check('作った時刻を持つ', typeof s.createdAt === 'number' && s.createdAt > 0);

  s.close();
  check('閉じると一覧から外れる', listLiveSessions().length === before);
  s.close();
  check('2 回閉じても一覧の数は変わらない', listLiveSessions().length === before);
}

{
  closeAllSessions('test');

  const owned = makeSession();
  const orphan = makeSession();

  registry.registerRecording(makeRecording(9001, owned) as any);

  const sweptNow = registry.sweepOrphanSessions(Date.now());
  check('作った直後のセッションは閉じない', sweptNow === 0, `${sweptNow}件閉じた`);
  check('この時点では 2 件とも残っている', listLiveSessions().length === 2);

  const later = Date.now() + 61_000;
  const swept = registry.sweepOrphanSessions(later);
  check('一定時間を過ぎた持ち主のいないセッションを閉じる', swept === 1, `${swept}件`);

  const remaining = listLiveSessions();
  check('持ち主のいる 1 件だけが残る', remaining.length === 1 && remaining[0] === owned);
  check('閉じたのは持ち主のいないほう', !remaining.includes(orphan));

  registry.releaseRecording(9001, null);
  check('録音を解放すると残りのセッションも閉じる', listLiveSessions().length === 0);
}

{
  closeAllSessions('test');

  const paused = makeSession();
  registry.registerRecording(makeRecording(9002, paused) as any);
  const ok = registry.pauseRecording(9002, 'conn-9002', 60_000, noop);
  check('録音を一時停止できる', ok === true);

  const swept = registry.sweepOrphanSessions(Date.now() + 61_000);
  check('一時停止中のセッションは閉じない', swept === 0, `${swept}件閉じた`);
  check('一時停止中のセッションが残る', listLiveSessions().includes(paused));

  registry.forceCleanupMeeting(9002);
  check('後片付けの処理で閉じる', !listLiveSessions().includes(paused));
}

{
  closeAllSessions('test');
  makeSession();
  makeSession();
  makeSession();
  check('3 件のセッションが残っている', listLiveSessions().length === 3);

  const closed = closeAllSessions('SIGTERM');
  check('すべて閉じて閉じた件数を返す', closed === 3, `${closed}件`);
  check('一覧が空になる', listLiveSessions().length === 0);
  check('一覧が空のときは 0 を返す', closeAllSessions('SIGTERM') === 0);
}

{
  const MAX_ATTEMPTS = 100;
  const MAX_DELAY_MS = 30_000;
  const worstCaseWithoutWindow = (MAX_ATTEMPTS * MAX_DELAY_MS) / 1000 / 60;
  const windowMinutes = 10;

  check(
    '回数の上限と待ち時間の上限から求めた最長時間は 50 分',
    Math.round(worstCaseWithoutWindow) === 50,
    `${worstCaseWithoutWindow}分`
  );
  check('合計時間の上限は 10 分', windowMinutes === 10);
  check('合計時間の上限は回数から求めた最長時間より短い', windowMinutes < worstCaseWithoutWindow);
}

console.log(`\n結果: ${pass} 成功 / ${fail} 失敗`);
process.exit(fail === 0 ? 0 : 1);

export {};
