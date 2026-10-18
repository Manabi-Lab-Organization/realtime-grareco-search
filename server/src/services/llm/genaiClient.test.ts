import { describe, it, expect, afterEach } from 'vitest';
import {
  buildClaudeRequest,
  extractJson,
  geminiSchemaToJsonSchema,
  normalizeContents,
  toClaudeMessages,
  GeminiUnavailableError,
} from './genaiClient.js';
import { serverFeatures } from '../features.js';

afterEach(() => {
  delete process.env.ANTHROPIC_TEXT_MODEL;
});

describe('buildClaudeRequest', () => {
  it('文字列の contents を user のメッセージ 1 件に変える', () => {
    const req = buildClaudeRequest({ model: 'gemini-3-flash-preview', contents: '新商品の案をまとめてください' });
    expect(req.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: '新商品の案をまとめてください' }] }]);
    expect(req.model).toBe('claude-sonnet-4-6');
  });

  it('環境変数で指定したモデルを使う', () => {
    process.env.ANTHROPIC_TEXT_MODEL = 'claude-sample-model';
    expect(buildClaudeRequest({ contents: 'x' }).model).toBe('claude-sample-model');
  });

  it('systemInstruction を system に、画像を image ブロックに変える', () => {
    const req = buildClaudeRequest({
      contents: [{ role: 'user', parts: [{ text: 'この写真を説明してください' }, { inlineData: { mimeType: 'image/png', data: 'AAAA' } }] }],
      config: { systemInstruction: 'あなたは会議の記録係です', maxOutputTokens: 4000 },
    });
    expect(req.system).toBe('あなたは会議の記録係です');
    expect(req.max_tokens).toBe(4000);
    expect(req.messages[0].content).toEqual([
      { type: 'text', text: 'この写真を説明してください' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ]);
  });

  it('JSON の出力を求めるときはスキーマを含む指示を system に加える', () => {
    const req = buildClaudeRequest({
      contents: 'x',
      config: {
        responseMimeType: 'application/json',
        responseSchema: { type: 'OBJECT', properties: { a: { type: 'STRING' } }, propertyOrdering: ['a'] },
      },
    });
    expect(req.system).toContain('JSON だけ');
    expect(req.system).toContain('{"type":"object","properties":{"a":{"type":"string"}}}');
  });

  it('検索のツールを Web 検索のツールに置き換える', () => {
    const req = buildClaudeRequest({ contents: 'x', config: { tools: [{ googleSearch: {} }] } });
    expect(req.tools).toEqual([{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }]);
  });

  it('出力の上限が小さすぎるときは 256 にする', () => {
    expect(buildClaudeRequest({ contents: 'x', config: { maxOutputTokens: 100 } }).max_tokens).toBe(256);
  });

  it('画像の生成を求めると GeminiUnavailableError を投げる', () => {
    expect(() => buildClaudeRequest({ model: 'gemini-3.1-flash-image', contents: 'x' })).toThrow(GeminiUnavailableError);
    expect(() => buildClaudeRequest({ contents: 'x', config: { responseModalities: ['TEXT', 'IMAGE'] } }))
      .toThrow(GeminiUnavailableError);
  });
});

describe('toClaudeMessages', () => {
  it('model を assistant に変え、同じ役割の連続をまとめ、先頭を user にする', () => {
    const msgs = toClaudeMessages(normalizeContents([
      { role: 'model', parts: [{ text: 'a' }] },
      { role: 'user', parts: [{ text: 'b' }] },
      { role: 'user', parts: [{ text: 'c' }] },
    ]));
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(msgs[2].content).toHaveLength(2);
  });

  it('扱えない形式の添付を形式名を含む文に置き換える', () => {
    const msgs = toClaudeMessages(normalizeContents([{ role: 'user', parts: [{ inlineData: { mimeType: 'image/heic', data: 'x' } }] }]));
    expect((msgs[0].content as any[])[0].text).toContain('image/heic');
  });
});

describe('JSON の取り出しとスキーマの変換', () => {
  it('囲みや前後の文を取り除いて JSON を取り出す', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJson('回答は次のとおり：[1,2]')).toBe('[1,2]');
    expect(extractJson('{"a":{"b":1}} 終わり')).toBe('{"a":{"b":1}}');
  });

  it('スキーマの type を小文字にし、propertyOrdering を取り除く', () => {
    expect(geminiSchemaToJsonSchema({ type: 'ARRAY', items: { type: 'INTEGER' }, propertyOrdering: [] }))
      .toEqual({ type: 'array', items: { type: 'integer' } });
  });
});

describe('serverFeatures', () => {
  it('必須のキーだけなら画像の機能は無効で、調査は有効', () => {
    const f = serverFeatures({ ELEVENLABS_API_KEY: 'x', ANTHROPIC_API_KEY: 'x' } as NodeJS.ProcessEnv);
    expect(f).toMatchObject({ grareco: false, autoGrareco: false, grarecoSearch: false, research: true, googleLogin: false, email: false });
  });

  it('OpenAI のキーを加えると手動の画像は有効、自動の画像は無効のまま', () => {
    const f = serverFeatures({ ANTHROPIC_API_KEY: 'x', OPENAI_API_KEY: 'x' } as NodeJS.ProcessEnv);
    expect(f.grareco).toBe(true);
    expect(f.autoGrareco).toBe(false);
  });

  it('Gemini のキーを加えると画像の機能がすべて有効になり、設定で調査を無効にできる', () => {
    const f = serverFeatures({ ANTHROPIC_API_KEY: 'x', GEMINI_API_KEY: 'x', RESEARCH_ENABLED: 'false' } as NodeJS.ProcessEnv);
    expect(f).toMatchObject({ grareco: true, autoGrareco: true, grarecoSearch: true, research: false });
  });
});
