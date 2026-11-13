// 日付と曜日の食い違いを、プログラムで見つけて「要確認」と書き残す（2026-11-13）。
//
// AI（文章を書くモデル）は暦を計算せず、曜日を「もっともらしい文字」として推測で書く。今日が何年かも知らない。
// 2026-11-13 の会議では「次週の土曜日 14時」（正しくは 11/21（土））がサマリーで「11/23（土）」になった。
// 2024 年の暦（16日・23日が土曜）で数えたとみられる。議事録・グラレコはこのサマリーから作るので誤りが広がった。
//
// 防ぎ方は 2 段：
//   1. AI への指示に「開催日」と「前後の暦（日付と曜日の一覧）」を入れる（dateContextBlock）。今回の根本原因への対策
//   2. AI が書いた「月日（曜）」の曜日を暦で検算し、食い違えば **どちらかに決めつけず「要確認」と書き残す**（markWeekdayMismatches）
//      日付と曜日のどちらが誤りかはプログラムでは決められない。最初の版は「日付を正として曜日を直す」作りだったが、
//      それでは「11/23（土）」が「11/23（月）」になり、正しい「11/21（土）」から遠ざかるうえ、誤りの手がかりを消してしまう
//
// 年が書かれていない日付は、基準日（開催日）に最も近い年として扱う（12月の会議で「1月8日」→翌年）。
// ただし基準日から NEAR_DAYS 日より離れた年なしの日付は、どの年のことか決めきれない。書かれた曜日が
// 前年・同年・翌年のどれかで合っていれば、正しい可能性があるので印を付けない。

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'] as const;
const DAY_MS = 24 * 60 * 60 * 1000;
/** 年なしの日付を「基準日の近く」とみなす幅（日）。これより離れると年を決め打ちしない */
const NEAR_DAYS = 60;

/** 日本時間での年・月・日 */
export function jstYmd(d: Date): { y: number; m: number; d: number } {
  const j = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return { y: j.getUTCFullYear(), m: j.getUTCMonth() + 1, d: j.getUTCDate() };
}

/** 実在する日付なら曜日の字（日〜土）。2月30日のような日付は null */
export function weekdayOf(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return WEEKDAYS[t.getUTCDay()];
}

/** 年の無い「m月d日」を、基準日に最も近い年に当てる */
export function inferYear(m: number, d: number, base: Date): number {
  const b = jstYmd(base);
  const baseUtc = Date.UTC(b.y, b.m - 1, b.d);
  let best = b.y;
  let bestDiff = Infinity;
  for (const y of [b.y - 1, b.y, b.y + 1]) {
    if (!weekdayOf(y, m, d)) continue;
    const diff = Math.abs(Date.UTC(y, m - 1, d) - baseUtc);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = y;
    }
  }
  return best;
}

// 「2026年11月23日（土）」「11月23日(土曜日)」「11/23（土）」「2026/11/23 (土曜)」「11月23日 土曜日」などを拾う。
const PATTERNS: RegExp[] = [
  // 年月日 / 月日 ＋ 括弧つき曜日
  /(?<!\d)(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*([（(]\s*)([日月火水木金土])(曜日?|曜)?(\s*[）)])/g,
  // 年/月/日 / 月/日 ＋ 括弧つき曜日。前に数字・英字・「/」「.」「_」が付くもの（URL・版番号・「1/2/3」）は日付とみなさない
  /(?<![0-9A-Za-z/／._])(?:(\d{4})\s*[/／]\s*)?(\d{1,2})\s*[/／]\s*(\d{1,2})\s*([（(]\s*)([日月火水木金土])(曜日?|曜)?(\s*[）)])/g,
  // 月日 ＋ 括弧なしの「◯曜日」「◯曜」（「日」だけの字は曜日と区別できないので「曜」を必須にする）
  /(?<!\d)(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*()([日月火水木金土])(曜日?|曜)()/g,
];

/** 印の文言。議事録・サマリーは理由まで書く。グラレコ（画像の文字）は短く */
// 印は【】で囲み、前後の文と区切る（文の途中に入っても読めるように）
const SHORT_NOTE = '【日付要確認】';
function noteFor(correct: string, mode: MarkMode): string {
  return mode === 'short' ? SHORT_NOTE : `【※日付と曜日が合いません（この日付は${correct}曜日）。日付をご確認ください】`;
}
/**
 * すでに印が付いているか。AI が後の工程で文言を少し言い換えても重ねないよう、書き出しだけで見る
 * （「【※日付と曜日が」「※日付と曜日が」「【日付要確認】」）
 */
const EXISTING_NOTE = /^\s*(?:【\s*※?\s*日付と曜日が|※\s*日付と曜日が|【\s*日付要確認\s*】)/;

export type MarkMode = 'note' | 'short';

export interface WeekdayMismatch {
  /** 食い違っていた箇所（例: 11/23（土）） */
  text: string;
  /** その日付の正しい曜日（例: 月） */
  correctWeekday: string;
}

/**
 * 文章中の「月日（曜）」の曜日を暦で検算し、食い違う箇所の直後に「要確認」の印を付ける。
 * **日付も曜日も書き換えない**（どちらが誤りかは決められないので、人に確かめてもらう）。
 * 実在しない日付（2月30日など）・曜日の無い日付は触らない。すでに印が付いている箇所には重ねて付けない
 * （サマリーは更新のたびに通すため）。
 */
export function markWeekdayMismatches(
  text: string,
  base: Date,
  mode: MarkMode = 'note',
): { text: string; mismatches: WeekdayMismatch[] } {
  if (!text) return { text, mismatches: [] };
  const mismatches: WeekdayMismatch[] = [];
  let out = text;
  for (const re of PATTERNS) {
    out = out.replace(re, (...args: unknown[]) => {
      const [whole, yStr, mStr, dStr, , wd] = args as string[];
      const offset = args[args.length - 2] as number;
      const src = args[args.length - 1] as string;
      const after = src.slice(offset + whole.length);
      if (EXISTING_NOTE.test(after)) return whole;
      const m = Number(mStr);
      const d = Number(dStr);
      const y = yStr ? Number(yStr) : inferYear(m, d, base);
      if (!yStr && !isNearBase(y, m, d, base) && matchesAnyNearbyYear(m, d, wd, base)) return whole;
      const correct = weekdayOf(y, m, d);
      if (!correct || correct === wd) return whole;
      mismatches.push({ text: whole, correctWeekday: correct });
      return whole + noteFor(correct, mode);
    });
  }
  return { text: out, mismatches };
}

function isNearBase(y: number, m: number, d: number, base: Date): boolean {
  const b = jstYmd(base);
  return Math.abs(Date.UTC(y, m - 1, d) - Date.UTC(b.y, b.m - 1, b.d)) <= NEAR_DAYS * DAY_MS;
}

/** 書かれた曜日が、前年・同年・翌年のどれかの暦で合っているか */
function matchesAnyNearbyYear(m: number, d: number, wd: string, base: Date): boolean {
  const { y } = jstYmd(base);
  return [y - 1, y, y + 1].some((yy) => weekdayOf(yy, m, d) === wd);
}

/** オブジェクト（グラレコの下書き JSON など）の中の文字列すべてに markWeekdayMismatches をかける */
export function markWeekdayMismatchesDeep<T>(
  value: T,
  base: Date,
  mode: MarkMode = 'note',
  found: WeekdayMismatch[] = [],
): T {
  if (typeof value === 'string') {
    const r = markWeekdayMismatches(value, base, mode);
    found.push(...r.mismatches);
    return r.text as unknown as T;
  }
  if (Array.isArray(value)) return value.map((v) => markWeekdayMismatchesDeep(v, base, mode, found)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = markWeekdayMismatchesDeep(v, base, mode, found);
    return out as T;
  }
  return value;
}

/** 「2026年11月13日（金）」 */
export function formatJstDateWithWeekday(d: Date): string {
  const { y, m, d: day } = jstYmd(d);
  return `${y}年${m}月${day}日（${weekdayOf(y, m, day)}）`;
}

/**
 * AI への指示に入れる「開催日」と「暦」。開催日の 7 日前から 62 日後まで、週ごとに 1 行。
 * 「来週の月曜」「23日」を日付に直すときに、曜日をこの表から写させる。
 */
export function dateContextBlock(base: Date, daysBefore = 7, daysAfter = 62): string {
  const b = jstYmd(base);
  const start = Date.UTC(b.y, b.m - 1, b.d) - daysBefore * DAY_MS;
  const lines: string[] = [];
  let line: string[] = [];
  for (let i = 0; i <= daysBefore + daysAfter; i++) {
    const t = new Date(start + i * DAY_MS);
    // 開催日と年が違う日（年末年始）は年も書く
    const ymd = t.getUTCFullYear() === b.y ? `${t.getUTCMonth() + 1}/${t.getUTCDate()}` : `${t.getUTCFullYear()}/${t.getUTCMonth() + 1}/${t.getUTCDate()}`;
    const label = `${ymd}(${WEEKDAYS[t.getUTCDay()]})`;
    line.push(label);
    if (t.getUTCDay() === 0) {
      lines.push(line.join(' '));
      line = [];
    }
  }
  if (line.length) lines.push(line.join(' '));
  return [
    `【開催日】${formatJstDateWithWeekday(base)}（日本時間）。今年は ${b.y} 年`,
    '【日付の決まり】「来週」「次の土曜日」「20日」のような言い方は、開催日を起点に下の暦で日付に直す。年は開催日の年として扱う。' +
      '素材にある「【※日付と曜日が合いません…】」「【日付要確認】」の印は、文言を変えずにその日付の直後に残す',
    `【暦（${b.y}年。曜日は必ずこの表から写す。自分で数えない。表に無い日付には曜日を書かない）】`,
    ...lines,
  ].join('\n');
}

/** 食い違いをログに残す（どれだけ AI が曜日を誤っているかを後から数えられるように） */
export function logWeekdayMismatches(where: string, mismatches: WeekdayMismatch[], meetingId?: number): void {
  if (mismatches.length === 0) return;
  console.log(
    `[weekday-mismatch] ${where}${meetingId ? ` meeting=${meetingId}` : ''} ${mismatches.length}件: ${mismatches
      .slice(0, 5)
      .map((f) => `${f.text}（正しくは${f.correctWeekday}）`)
      .join(' / ')}`,
  );
}
