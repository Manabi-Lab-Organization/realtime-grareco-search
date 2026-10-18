
import { GoogleGenAI } from '@google/genai';
import Anthropic from '@anthropic-ai/sdk';

export class GeminiUnavailableError extends Error {
  constructor(what: string) {
    super(`${what}には GEMINI_API_KEY の設定が必要です`);
    this.name = 'GeminiUnavailableError';
  }
}

export function hasGeminiKey(): boolean {
  return !!process.env.GEMINI_API_KEY;
}

export function fallbackModel(): string {
  return process.env.ANTHROPIC_TEXT_MODEL || 'claude-sonnet-4-6';
}

type GenAIOptions = { httpOptions?: { timeout?: number } };

export function createGenAI(options: GenAIOptions = {}): GoogleGenAI {
  if (hasGeminiKey()) {
    return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY!, ...options });
  }
  return createAnthropicBackedGenAI(options) as unknown as GoogleGenAI;
}

type Part = {
  text?: string;
  inlineData?: { mimeType?: string; data?: string };
};
type Content = { role?: string; parts?: Part[] };

const CLAUDE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

export function normalizeContents(contents: unknown): Content[] {
  if (contents == null) return [];
  if (typeof contents === 'string') return [{ role: 'user', parts: [{ text: contents }] }];
  if (!Array.isArray(contents)) return normalizeContents([contents]);
  if (contents.length === 0) return [];
  const isContent = (c: unknown) => typeof c === 'object' && c !== null && 'parts' in c;
  if (!contents.some(isContent)) {
    const parts = contents.map((p) => (typeof p === 'string' ? { text: p } : (p as Part)));
    return [{ role: 'user', parts }];
  }
  return contents.map((c) => (typeof c === 'string' ? { role: 'user', parts: [{ text: c }] } : (c as Content)));
}

function toClaudeBlocks(parts: Part[]): Anthropic.ContentBlockParam[] {
  const blocks: Anthropic.ContentBlockParam[] = [];
  for (const p of parts) {
    if (typeof p.text === 'string' && p.text.length > 0) {
      blocks.push({ type: 'text', text: p.text });
    } else if (p.inlineData?.data) {
      const mime = (p.inlineData.mimeType || '').toLowerCase();
      if (CLAUDE_IMAGE_TYPES.has(mime)) {
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: mime as 'image/png', data: p.inlineData.data },
        });
      } else if (mime === 'application/pdf') {
        blocks.push({
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: p.inlineData.data },
        });
      } else {
        blocks.push({ type: 'text', text: `（${mime || '不明な形式'}の添付は読み取れないため省略しました）` });
      }
    }
  }
  return blocks;
}

export function toClaudeMessages(contents: Content[]): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = [];
  for (const c of contents) {
    const role: 'user' | 'assistant' = c.role === 'model' || c.role === 'assistant' ? 'assistant' : 'user';
    const blocks = toClaudeBlocks(c.parts ?? []);
    if (blocks.length === 0) continue;
    const last = messages[messages.length - 1];
    if (last && last.role === role) {
      (last.content as Anthropic.ContentBlockParam[]).push(...blocks);
    } else {
      messages.push({ role, content: blocks });
    }
  }
  if (messages.length === 0 || messages[0].role !== 'user') {
    messages.unshift({ role: 'user', content: [{ type: 'text', text: '以下の指示に従ってください。' }] });
  }
  return messages;
}

export function geminiSchemaToJsonSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(geminiSchemaToJsonSchema);
  if (schema === null || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (k === 'propertyOrdering') continue;
    if (k === 'type' && typeof v === 'string') out.type = v.toLowerCase();
    else out[k] = geminiSchemaToJsonSchema(v);
  }
  return out;
}

function systemText(systemInstruction: unknown): string {
  if (!systemInstruction) return '';
  if (typeof systemInstruction === 'string') return systemInstruction;
  const parts = (systemInstruction as Content).parts ?? [];
  return parts.map((p) => p.text ?? '').join('\n');
}

export function extractJson(text: string): string {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const start = trimmed.search(/[[{]/);
  if (start < 0) return trimmed;
  const open = trimmed[start];
  const end = trimmed.lastIndexOf(open === '{' ? '}' : ']');
  return end > start ? trimmed.slice(start, end + 1) : trimmed.slice(start);
}

let anthropic: Anthropic | null = null;
function anthropicClient(timeout?: number): Anthropic {
  if (!anthropic) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
    anthropic = new Anthropic({ apiKey, ...(timeout ? { timeout } : {}) });
  }
  return anthropic;
}

export function buildClaudeRequest(req: any): Anthropic.MessageCreateParamsNonStreaming {
  const config = req?.config ?? {};
  const modalities: string[] = config.responseModalities ?? [];
  if (modalities.some((m) => String(m).toUpperCase() === 'IMAGE') || /image/i.test(String(req?.model ?? ''))) {
    throw new GeminiUnavailableError('画像の生成');
  }

  let system = systemText(config.systemInstruction);
  const wantsJson = config.responseMimeType === 'application/json';
  if (wantsJson) {
    const schema = config.responseSchema ?? config.responseJsonSchema;
    system += `${system ? '\n\n' : ''}出力は JSON だけにしてください。説明文やコードフェンスは付けないでください。`;
    if (schema) {
      system += `\n次の JSON Schema に従ってください:\n${JSON.stringify(geminiSchemaToJsonSchema(schema))}`;
    }
  }

  const wantsSearch = Array.isArray(config.tools) && config.tools.some((t: any) => t && 'googleSearch' in t);
  const tools = wantsSearch
    ? [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 } as unknown as Anthropic.ToolUnion]
    : undefined;

  const maxTokens = Math.max(Number(config.maxOutputTokens) || 8192, 256);

  return {
    model: fallbackModel(),
    max_tokens: maxTokens,
    ...(system ? { system } : {}),
    messages: toClaudeMessages(normalizeContents(req?.contents)),
    ...(tools ? { tools } : {}),
  };
}

function createAnthropicBackedGenAI(options: GenAIOptions) {
  return {
    models: {
      async generateContent(req: any) {
        const params = buildClaudeRequest(req);
        const res = await anthropicClient(options.httpOptions?.timeout).messages.stream(params).finalMessage();
        let text = res.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('');
        if (req?.config?.responseMimeType === 'application/json') text = extractJson(text);
        const input = res.usage?.input_tokens ?? 0;
        const output = res.usage?.output_tokens ?? 0;
        return {
          text,
          candidates: [{
            content: { role: 'model', parts: [{ text }] },
            finishReason: res.stop_reason === 'max_tokens' ? 'MAX_TOKENS' : 'STOP',
          }],
          usageMetadata: { promptTokenCount: input, candidatesTokenCount: output, totalTokenCount: input + output },
          modelVersion: res.model,
        };
      },
      async embedContent() {
        throw new GeminiUnavailableError('埋め込み（話題の切り替わり検知・意味検索）');
      },
    },
  };
}
