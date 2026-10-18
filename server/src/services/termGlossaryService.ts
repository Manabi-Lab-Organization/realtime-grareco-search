
import kuromoji from 'kuromoji';
import * as path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { ThinkingLevel } from '@google/genai';
import { createGenAI } from './llm/genaiClient.js';
import { auditGeminiCall } from './audit/audit.js';
import { db } from '../db/index.js';
import { userTermDictionary, meetingTermHits, userTermExclusions, meetings } from '../db/schema.js';
import { eq, and, inArray, desc, sql } from 'drizzle-orm';

interface DetectedTerm {
  term: string;
  reading: string | null;
  explanation: string;
  category: 'technical' | 'business' | 'industry' | 'acronym' | 'other';
}

export type { DetectedTerm };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ai = createGenAI();

const MODEL_FLASH = 'gemini-3.1-flash-lite';

export function normalizeTerm(s: string): string {
  return s.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function termHash(userId: number, term: string): string {
  const key = process.env.TERM_HASH_SECRET || process.env.SESSION_SECRET || '';
  return crypto.createHmac('sha256', key).update(`${userId}:${normalizeTerm(term)}`).digest('hex');
}

let tokenizer: kuromoji.Tokenizer<kuromoji.IpadicFeatures> | null = null;
let tokenizerReady = false;

export async function initializeTokenizer(): Promise<void> {
  if (tokenizerReady) return;

  const { existsSync } = await import('fs');

  const candidates = [
    (() => {
      try {
        const kuromojiPkg = import.meta.resolve('kuromoji/package.json');
        return path.resolve(fileURLToPath(kuromojiPkg), '../dict/');
      } catch { return null; }
    })(),
    path.resolve(process.cwd(), 'node_modules/kuromoji/dict/'),
    path.resolve(process.cwd(), 'server/node_modules/kuromoji/dict/'),
    path.resolve(__dirname, '../../node_modules/kuromoji/dict/'),
    path.resolve(__dirname, '../../../node_modules/kuromoji/dict/'),
  ].filter((p): p is string => p !== null);

  let dictPath: string | null = null;
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      dictPath = candidate;
      break;
    }
    console.log(`[TermGlossary] Dict path not found: ${candidate}`);
  }

  if (!dictPath) {
    console.error('[TermGlossary] No valid kuromoji dict path found.');
    console.error('[TermGlossary] cwd:', process.cwd(), '__dirname:', __dirname);
    console.error('[TermGlossary] Tried:', candidates);
    return;
  }
  console.log(`[TermGlossary] Using dict path: ${dictPath}`);

  return new Promise((resolve, reject) => {
    kuromoji.builder({ dicPath: dictPath! }).build((err, t) => {
      if (err) {
        console.error('[TermGlossary] Failed to build kuromoji tokenizer:', err);
        reject(err);
        return;
      }
      tokenizer = t;
      tokenizerReady = true;
      console.log('[TermGlossary] kuromoji tokenizer ready');
      resolve();
    });
  });
}

export function tokenizeIfReady(text: string): kuromoji.IpadicFeatures[] | null {
  if (!tokenizerReady || !tokenizer) return null;
  return tokenizer.tokenize(text);
}

const meetingProcessedTermsCache = new Map<number, Set<string>>();
const meetingParticipantNamesCache = new Map<number, string[]>();

export function clearMeetingCache(meetingId: number): void {
  meetingProcessedTermsCache.delete(meetingId);
  meetingParticipantNamesCache.delete(meetingId);
}

const HONORIFIC_SUFFIX = /(さん|さま|様|氏|殿|君|くん|ちゃん)\s*$/u;

interface ParticipantEntry {
  name?: string | null;
  [key: string]: unknown;
}

async function getMeetingParticipantNames(meetingId: number): Promise<string[]> {
  const cached = meetingParticipantNamesCache.get(meetingId);
  if (cached) return cached;

  let names: string[] = [];
  try {
    const rows = await db.select({ participants: meetings.participants })
      .from(meetings)
      .where(eq(meetings.id, meetingId))
      .limit(1);
    const participants = (rows[0]?.participants ?? []) as ParticipantEntry[];
    names = participants
      .map(p => (typeof p?.name === 'string' ? p.name : ''))
      .map(n => n.replace(/　/g, ' ').replace(HONORIFIC_SUFFIX, '').trim())
      .filter(n => n.length >= 2);
  } catch (err) {
    console.warn('[TermGlossary] failed to load participants for privacy guard', err);
  }
  meetingParticipantNamesCache.set(meetingId, names);
  return names;
}

const KATAKANA_REGEX = /^[゠-ヿㇰ-ㇿ]+$/;
const ALPHA_REGEX = /^[A-Za-z][A-Za-z0-9./-]*$/;

interface TextAnalysis {
  candidates: string[];
  personNames: Set<string>;
}

export function analyzeText(text: string): TextAnalysis {
  if (!tokenizer) return { candidates: [], personNames: new Set() };

  const tokens = tokenizer.tokenize(text);
  const candidates: string[] = [];
  const personNames = new Set<string>();
  const seen = new Set<string>();

  for (const token of tokens) {
    const surface = token.surface_form;
    const pos = token.pos;
    const posDetail1 = token.pos_detail_1;
    const posDetail2 = token.pos_detail_2;

    if (pos !== '名詞') continue;

    if (posDetail1 === '固有名詞' && posDetail2 === '人名' && surface.length >= 2) {
      personNames.add(surface);
    }

    if (['非自立', '接尾', '代名詞', '数'].includes(posDetail1)) continue;

    if (seen.has(surface)) continue;

    if (posDetail1 === '固有名詞' && surface.length >= 2) {
      seen.add(surface);
      candidates.push(surface);
      continue;
    }

    if (KATAKANA_REGEX.test(surface) && surface.length >= 3) {
      seen.add(surface);
      candidates.push(surface);
      continue;
    }

    if (ALPHA_REGEX.test(surface) && surface.length >= 2) {
      seen.add(surface);
      candidates.push(surface);
      continue;
    }

    if (token.word_type === 'UNKNOWN' && surface.length >= 2) {
      seen.add(surface);
      candidates.push(surface);
      continue;
    }
  }

  return { candidates, personNames };
}

const VERBATIM_MATCH_CHARS = 15;

export function findPrivacyViolation(
  explanation: string,
  term: string,
  personNames: Set<string>,
  participantNames: string[],
  rawContext: string
): string | null {
  const normalizedTerm = normalizeTerm(term);

  for (const name of [...personNames, ...participantNames]) {
    if (!name || normalizeTerm(name) === normalizedTerm) continue;
    if (explanation.includes(name)) return `person_name:${name.length}ch`;
  }

  for (let i = 0; i + VERBATIM_MATCH_CHARS <= rawContext.length; i++) {
    const slice = rawContext.slice(i, i + VERBATIM_MATCH_CHARS);
    if (explanation.includes(slice)) return 'verbatim_quote';
  }

  return null;
}

interface FilterResult {
  newTerms: string[];
  repeatTerms: string[];
}

async function filterCandidates(
  candidates: string[],
  meetingId: number,
  userId: number
): Promise<FilterResult> {
  if (candidates.length === 0) return { newTerms: [], repeatTerms: [] };

  let processed = meetingProcessedTermsCache.get(meetingId);
  if (!processed) {
    processed = new Set<string>();
    meetingProcessedTermsCache.set(meetingId, processed);
  }

  const exclusionRows = await db.select({ termHash: userTermExclusions.termHash })
    .from(userTermExclusions)
    .where(eq(userTermExclusions.userId, userId));
  const excludedHashes = new Set(exclusionRows.map(e => e.termHash));

  const newTerms: string[] = [];
  const repeatTerms: string[] = [];
  for (const t of candidates) {
    if (excludedHashes.has(termHash(userId, t))) continue;
    if (processed.has(normalizeTerm(t))) repeatTerms.push(t);
    else newTerms.push(t);
  }

  return { newTerms, repeatTerms };
}

interface DictionaryHit {
  term: string;
  reading: string | null;
  explanation: string;
  category: string;
  termId: number;
}

interface DictionaryLookupResult {
  hits: DictionaryHit[];
  notFound: string[];
  skipped: number;
}

async function lookupDictionary(userId: number, terms: string[]): Promise<DictionaryLookupResult> {
  if (terms.length === 0) return { hits: [], notFound: [], skipped: 0 };

  const hashes = terms.map(t => termHash(userId, t));
  const rows = await db.select()
    .from(userTermDictionary)
    .where(and(
      eq(userTermDictionary.userId, userId),
      inArray(userTermDictionary.termHash, hashes),
    ));

  const byHash = new Map(rows.map(r => [r.termHash, r]));
  const hits: DictionaryHit[] = [];
  const notFound: string[] = [];
  let skipped = 0;

  for (const term of terms) {
    const entry = byHash.get(termHash(userId, term));
    if (!entry) {
      notFound.push(term);
      continue;
    }

    db.update(userTermDictionary)
      .set({ usageCount: sql`${userTermDictionary.usageCount} + 1`, updatedAt: new Date() })
      .where(eq(userTermDictionary.id, entry.id))
      .catch(() => {});

    if (entry.isSkip || !entry.explanation || !entry.term) {
      skipped++;
      continue;
    }

    hits.push({
      term: entry.term,
      reading: entry.reading,
      explanation: entry.explanation,
      category: entry.category || 'other',
      termId: entry.id,
    });
  }

  return { hits, notFound, skipped };
}

async function saveSensitive(userId: number, term: string): Promise<void> {
  await db.insert(userTermDictionary).values({
    userId,
    termHash: termHash(userId, term),
    term: null,
    isSkip: true,
    skipReason: 'sensitive',
    source: 'ai',
  }).onConflictDoNothing().catch(() => {});
}

const PROMPT_CONTEXT_CHARS = 300;

interface AIExplainResult {
  term: string;
  decision?: 'explain' | 'common' | 'sensitive';
  reading?: string;
  explanation?: string;
  category?: string;
}

interface GuardContext {
  personNames: Set<string>;
  participantNames: string[];
  rawContext: string;
}

function buildPrompt(terms: string[], redactedContext: string): string {
  return `あなたは中立的な用語辞典の編集者です。与えられた用語を、一般の辞書に載る形で定義してください。

【最重要・絶対厳守】
解説文は「その用語だけを見て書いた汎用的な定義」でなければなりません。
- 会議の発言内容・議題・数値・日付・決定事項を解説文に書いてはいけません。
- 人名・企業名・組織名・部署名・製品の社内呼称を解説文に書いてはいけません。
- 「この会議では」「〜さんが述べた」「今回の案件では」等、文脈を参照する表現は禁止です。
- 文脈は「多義語がどちらの意味か」を判別するためだけに使います（例:「リリース」がソフトウェアの公開か、釣った魚を放すことか）。
  判別した結果の"意味"だけを一般論として書き、文脈そのものは書かないこと。

【decision の判定】
- "sensitive": 人名、企業名、法人名、組織名、団体名、学校名、部署名。個人や特定の組織を指す固有名詞。
  → explanation は書かないこと。
  ただし「広く一般に知られた技術・製品・サービスの名前」は sensitive ではなく explain です。
  explain の例: Python, Linux, PostgreSQL, HTTP, JSON, HTML
  sensitive の例: 山田, 鈴木さん, 株式会社サンプル, サンプル商事, 総務一課, サンプル大学
- "common": 専門用語ではない日常語・挨拶・一般名詞・地名・数量表現。→ explanation は書かないこと。
- "explain": 上記以外の専門用語・略語・技術用語。→ 1〜2文の汎用的な定義を書く。

用語リスト: ${JSON.stringify(terms)}
文脈（語義判別にのみ使用。出力に含めるな）: ${redactedContext}`;
}

async function explainWithAI(
  userId: number,
  terms: string[],
  redactedContext: string,
  guard: GuardContext
): Promise<DetectedTerm[]> {
  if (terms.length === 0) return [];

  try {
    const response = await ai.models.generateContent({
      model: MODEL_FLASH,
      contents: buildPrompt(terms, redactedContext),
      config: {
        maxOutputTokens: 2048,
        thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              term: { type: 'STRING' },
              decision: { type: 'STRING', enum: ['explain', 'common', 'sensitive'] },
              reading: { type: 'STRING' },
              explanation: { type: 'STRING' },
              category: { type: 'STRING', enum: ['technical', 'business', 'industry', 'acronym', 'other'] },
            },
            required: ['term', 'decision'],
            propertyOrdering: ['term', 'decision', 'reading', 'explanation', 'category'],
          },
        },
      },
    });
    auditGeminiCall('gemini:termGlossary', MODEL_FLASH, response);

    const text = response.text?.trim() || '';
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        console.error(`[TermGlossary] JSON parse failed (len=${text.length})`);
        return [];
      }
      try {
        parsed = JSON.parse(jsonMatch[0]);
      } catch {
        console.error('[TermGlossary] JSON parse failed (both attempts)');
        return [];
      }
    }
    if (!Array.isArray(parsed)) return [];

    const results = parsed as AIExplainResult[];
    const detected: DetectedTerm[] = [];
    let dropped = 0;

    for (const result of results) {
      const term = typeof result?.term === 'string' ? result.term.trim() : '';
      if (!term) continue;

      if (result.decision === 'sensitive') {
        await saveSensitive(userId, term);
        continue;
      }

      if (result.decision !== 'explain' || !result.explanation) {
        await db.insert(userTermDictionary).values({
          userId,
          termHash: termHash(userId, term),
          term,
          isSkip: true,
          skipReason: 'common',
          source: 'ai',
        }).onConflictDoNothing().catch(() => {});
        continue;
      }

      const explanation = result.explanation.trim();

      const violation = findPrivacyViolation(
        explanation, term, guard.personNames, guard.participantNames, guard.rawContext
      );
      if (violation) {
        console.warn(`[TermGlossary] privacy guard dropped an explanation (reason=${violation})`);
        dropped++;
        continue;
      }

      const category = (result.category as DetectedTerm['category']) || 'other';
      await db.insert(userTermDictionary).values({
        userId,
        termHash: termHash(userId, term),
        term,
        reading: result.reading || null,
        explanation,
        category,
        isSkip: false,
        skipReason: null,
        source: 'ai',
      }).onConflictDoNothing().catch(() => {});

      detected.push({ term, reading: result.reading || null, explanation, category });
    }

    if (dropped > 0) {
      console.warn(`[TermGlossary] privacy guard dropped ${dropped}/${results.length} explanations`);
    }
    return detected;
  } catch (err) {
    console.error('[TermGlossary] Gemini API error:', err);
    return [];
  }
}

const AI_TIMEOUT_MS = 3000;

export async function detectAndExplainTerms(
  text: string,
  meetingId: number,
  userId: number,
  meetingStartTime: number
): Promise<DetectedTerm[]> {
  if (!tokenizerReady) {
    console.log('[TermGlossary] Skipped: tokenizer not ready');
    return [];
  }

  const { candidates, personNames } = analyzeText(text);
  if (candidates.length === 0) return [];

  const { newTerms, repeatTerms } = await filterCandidates(candidates, meetingId, userId);
  if (newTerms.length === 0 && repeatTerms.length === 0) return [];

  const processed = meetingProcessedTermsCache.get(meetingId);
  if (processed) for (const t of newTerms) processed.add(normalizeTerm(t));

  const localSensitive = newTerms.filter(t => personNames.has(t));
  const askable = newTerms.filter(t => !personNames.has(t));
  for (const t of localSensitive) await saveSensitive(userId, t);

  let hits: DictionaryHit[] = [];
  let aiResults: DetectedTerm[] = [];
  let aiAsked = 0;

  if (askable.length > 0) {
    const lookup = await lookupDictionary(userId, askable);
    hits = lookup.hits;

    if (lookup.notFound.length > 0) {
      aiAsked = lookup.notFound.length;

      let redacted = text;
      for (const name of personNames) redacted = redacted.split(name).join('〇〇');
      redacted = redacted.slice(0, PROMPT_CONTEXT_CHARS);

      const guard: GuardContext = {
        personNames,
        participantNames: await getMeetingParticipantNames(meetingId),
        rawContext: text,
      };

      const aiPromise = explainWithAI(userId, lookup.notFound, redacted, guard);
      const timeoutPromise = new Promise<DetectedTerm[]>(resolve => setTimeout(() => resolve([]), AI_TIMEOUT_MS));
      aiResults = await Promise.race([aiPromise, timeoutPromise]);
    }
  }

  let repeatHits: DictionaryHit[] = [];
  if (repeatTerms.length > 0) {
    repeatHits = (await lookupDictionary(userId, repeatTerms)).hits;
  }

  const toDetected = (h: DictionaryHit): DetectedTerm => ({
    term: h.term,
    reading: h.reading,
    explanation: h.explanation,
    category: h.category as DetectedTerm['category'],
  });
  const allDetected: DetectedTerm[] = [...hits.map(toDetected), ...aiResults, ...repeatHits.map(toDetected)];

  console.log(
    `[TermGlossary] candidates=${candidates.length} dictHit=${hits.length + repeatHits.length} ` +
    `aiAsked=${aiAsked} aiExplained=${aiResults.length} localSensitive=${localSensitive.length}`
  );

  await recordMeetingHits(meetingId, userId, allDetected, Date.now() - meetingStartTime);

  return allDetected;
}

async function recordMeetingHits(
  meetingId: number,
  userId: number,
  terms: DetectedTerm[],
  elapsedMs: number
): Promise<void> {
  if (terms.length === 0) return;
  try {
    const hashes = terms.map(t => termHash(userId, t.term));
    const rows = await db.select({ id: userTermDictionary.id, termHash: userTermDictionary.termHash })
      .from(userTermDictionary)
      .where(and(
        eq(userTermDictionary.userId, userId),
        inArray(userTermDictionary.termHash, hashes),
      ));
    const idByHash = new Map(rows.map(r => [r.termHash, r.id]));

    for (const t of terms) {
      const termId = idByHash.get(termHash(userId, t.term));
      if (!termId) continue;
      await db.insert(meetingTermHits).values({
        meetingId,
        termId,
        firstDetectedAt: elapsedMs,
      }).onConflictDoNothing();
    }
  } catch {
  }
}

export async function excludeTerm(userId: number, term: string): Promise<void> {
  await db.insert(userTermExclusions).values({
    userId,
    termHash: termHash(userId, term),
  }).onConflictDoNothing();
}

export async function getTopTermsByMeeting(meetingId: number, limit: number): Promise<string[]> {
  if (limit <= 0) return [];
  const rows = await db.select({ term: userTermDictionary.term })
    .from(meetingTermHits)
    .innerJoin(meetings, eq(meetingTermHits.meetingId, meetings.id))
    .innerJoin(userTermDictionary, and(
      eq(meetingTermHits.termId, userTermDictionary.id),
      eq(userTermDictionary.userId, meetings.userId),
    ))
    .where(and(
      eq(meetingTermHits.meetingId, meetingId),
      eq(userTermDictionary.isSkip, false),
    ))
    .orderBy(desc(userTermDictionary.usageCount))
    .limit(limit);
  return rows.map(r => r.term).filter((t): t is string => Boolean(t));
}

export async function getDetectedTermsByMeeting(meetingId: number): Promise<DetectedTerm[]> {
  const rows = await db.select({
    term: userTermDictionary.term,
    reading: userTermDictionary.reading,
    explanation: userTermDictionary.explanation,
    category: userTermDictionary.category,
    firstDetectedAt: meetingTermHits.firstDetectedAt,
  })
    .from(meetingTermHits)
    .innerJoin(meetings, eq(meetingTermHits.meetingId, meetings.id))
    .innerJoin(userTermDictionary, and(
      eq(meetingTermHits.termId, userTermDictionary.id),
      eq(userTermDictionary.userId, meetings.userId),
    ))
    .where(and(
      eq(meetingTermHits.meetingId, meetingId),
      eq(userTermDictionary.isSkip, false),
    ))
    .orderBy(meetingTermHits.firstDetectedAt);

  return rows
    .filter(r => r.term && r.explanation)
    .map(r => ({
      term: r.term!,
      reading: r.reading,
      explanation: r.explanation!,
      category: (r.category as DetectedTerm['category']) || 'other',
    }));
}
