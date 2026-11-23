import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('../../db/index.js', () => ({ db: {}, pool: {} }));

import { ThinkingLevel } from '@google/genai';
import {
  extractRequestConfig,
  parseMeetingImageResponse,
  parseParticipantListResponse,
  readParticipantListResponse,
  PARTICIPANT_LIST_MAX_OUTPUT_TOKENS,
  PARTICIPANT_LIST_SCHEMA,
} from '../geminiService.js';

describe('名簿の読み取りと会議画像の解析の頼み方', () => {
  it('考える量を最小にし、形を渡したときだけ答えの形を強制する', () => {
    expect(extractRequestConfig(8000, null)).toEqual({
      maxOutputTokens: 8000,
      thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
    });
    const withSchema = extractRequestConfig(PARTICIPANT_LIST_MAX_OUTPUT_TOKENS, PARTICIPANT_LIST_SCHEMA);
    expect(withSchema.maxOutputTokens).toBe(12000);
    expect(withSchema.responseMimeType).toBe('application/json');
    expect(withSchema.responseSchema).toBe(PARTICIPANT_LIST_SCHEMA);
  });

  it('名簿（画像・テキスト）は形を強制し、会議画像の解析は強制しない', () => {
    const src = readFileSync(new URL('../geminiService.ts', import.meta.url), 'utf-8');
    const body = (name: string) => {
      const start = src.indexOf(`export async function ${name}(`);
      expect(start).toBeGreaterThan(-1);
      const next = src.indexOf('\nexport ', start + 1);
      return src.slice(start, next === -1 ? undefined : next);
    };
    for (const name of ['extractParticipantsFromImage', 'extractParticipantsFromText']) {
      expect(body(name)).toContain('extractRequestConfig(PARTICIPANT_LIST_MAX_OUTPUT_TOKENS, PARTICIPANT_LIST_SCHEMA)');
      expect(body(name)).toContain('extractRequestConfig(PARTICIPANT_LIST_MAX_OUTPUT_TOKENS, null)');
    }
    expect(body('analyzeMeetingImage')).toContain('extractRequestConfig(8000, null)');
  });
});

describe('名簿の答えの読み取り', () => {
  const list = JSON.stringify([
    { name: ' 山田一郎 ', gender: '男', age: '50代', other: '課長' },
    { name: '', gender: '女', age: '20代', other: '' },
    { name: '川口さくら', gender: '？', age: '若い', other: null },
  ]);

  it('全文が JSON ならそのまま読み、値をそろえる', () => {
    const r = parseParticipantListResponse(list);
    expect(r.parsed).toBe('json');
    expect(r.participants).toEqual([
      { name: '山田一郎', gender: '男', age: '50代', other: '課長' },
      { name: '川口さくら', gender: '分からない', age: '分からない', other: '' },
    ]);
  });

  it('前後に文章があっても配列を探して読む', () => {
    const r = parseParticipantListResponse('結果です。\n```json\n' + list + '\n```');
    expect(r.parsed).toBe('extracted');
    expect(r.participants).toHaveLength(2);
  });

  it('0 人と、読めなかったことを区別する', () => {
    expect(parseParticipantListResponse('[]')).toEqual({ participants: [], parsed: 'json' });
    expect(parseParticipantListResponse('[{"name":"山田').parsed).toBe('failed');
    expect(parseParticipantListResponse('').parsed).toBe('failed');
  });

  it('読めない・途中で切れた答えは 1 回だけやり直す', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cut = { text: '[{"name":"山田', candidates: [{ finishReason: 'MAX_TOKENS' }] };
    expect(readParticipantListResponse('t', cut, { isRetry: false }).retryWithoutSchema).toBe(true);
    expect(readParticipantListResponse('t', cut, { isRetry: true }).retryWithoutSchema).toBe(false);
    const cutButReadable = { text: list, candidates: [{ finishReason: 'MAX_TOKENS' }] };
    expect(readParticipantListResponse('t', cutButReadable, { isRetry: false }).retryWithoutSchema).toBe(true);
    const ok = { text: list, candidates: [{ finishReason: 'STOP' }] };
    const read = readParticipantListResponse('t', ok, { isRetry: false });
    expect(read.retryWithoutSchema).toBe(false);
    expect(read.participants).toHaveLength(2);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('山田');
    warn.mockRestore();
  });
});

describe('会議画像の解析の答えの読み取り', () => {
  it('JSON を読み、"null" や空文字は null にそろえる', () => {
    const r = parseMeetingImageResponse('{"analysis":"## 結果","diagram":"null","extractedTime":""}');
    expect(r).toEqual({ analysis: '## 結果', diagram: null, extractedTime: null, parsed: 'json' });
  });

  it('コードブロックの中の JSON も読む', () => {
    const r = parseMeetingImageResponse('```json\n{"analysis":"A","diagram":"graph TD","extractedTime":"2030-04-01 10:00"}\n```');
    expect(r).toEqual({ analysis: 'A', diagram: 'graph TD', extractedTime: '2030-04-01 10:00', parsed: 'extracted' });
  });

  it('JSON として読めなければ、全文を解析結果にする', () => {
    expect(parseMeetingImageResponse('読み取った文字です')).toEqual({
      analysis: '読み取った文字です', diagram: null, extractedTime: null, parsed: 'raw',
    });
  });
});
