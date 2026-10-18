
import Anthropic from '@anthropic-ai/sdk';
import { auditLlmCall } from '../audit/audit.js';
import { estimateCostUsd } from '../llmCost.js';
import {
  AGENT_TOOLS,
  TOOL_MAP,
  toolsForAnthropic,
  type AgentContext,
  type ClientAction,
} from './tools.js';
import { buildSystemPrompt } from './systemPrompt.js';

const MODEL = process.env.NL_AGENT_MODEL || 'claude-haiku-4-5-20251001';
const MAX_ITERATIONS = 8;
const MAX_OUTPUT_TOKENS = 2048;

export interface IncomingMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ToolLogEntry {
  name: string;
  displayLabel: string;
  isError?: boolean;
  clientAction?: ClientAction;
}

export interface AgentTurnResult {
  assistantText: string;
  toolLog: ToolLogEntry[];
  iterations: number;
  stopReason: string | null;
}

export type AgentStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; entry: ToolLogEntry }
  | { type: 'done'; iterations: number; stopReason: string | null }
  | { type: 'error'; error: string };

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
    client = new Anthropic({ apiKey });
  }
  return client;
}

function buildSystemBlocks(parts: {
  staticPart: string;
  dynamicPart: string;
}): Anthropic.Messages.TextBlockParam[] {
  const blocks: Anthropic.Messages.TextBlockParam[] = [
    { type: 'text', text: parts.staticPart, cache_control: { type: 'ephemeral' } },
  ];
  if (parts.dynamicPart) {
    blocks.push({ type: 'text', text: parts.dynamicPart });
  }
  return blocks;
}

function buildToolsForRequest(): Anthropic.Messages.Tool[] {
  const tools = toolsForAnthropic() as Anthropic.Messages.Tool[];
  if (tools.length === 0) return tools;
  const last = tools[tools.length - 1];
  tools[tools.length - 1] = {
    ...last,
    cache_control: { type: 'ephemeral' },
  } as Anthropic.Messages.Tool;
  return tools;
}

export async function runAgentTurnStreaming(params: {
  userId: number;
  meetingId: number;
  messages: IncomingMessage[];
  onEvent: (event: AgentStreamEvent) => void;
}): Promise<AgentTurnResult> {
  const ctx: AgentContext = { userId: params.userId, meetingId: params.meetingId };
  const promptParts = await buildSystemPrompt(ctx);
  const systemBlocks = buildSystemBlocks(promptParts);
  const tools = buildToolsForRequest();
  const anthropic = getClient();

  type AnthropicMessage = Anthropic.Messages.MessageParam;
  const messages: AnthropicMessage[] = params.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const toolLog: ToolLogEntry[] = [];
  const turnUsage = { input: 0, output: 0, cache_read: 0, cache_create: 0, calls: 0 };
  let iterations = 0;
  let finalText = '';
  let lastStop: string | null = null;

  while (iterations < MAX_ITERATIONS) {
    iterations += 1;

    const stream = anthropic.messages.stream({
      model: MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: systemBlocks,
      tools,
      messages,
    });

    stream.on('text', (delta: string) => {
      if (delta) params.onEvent({ type: 'text', text: delta });
    });

    const response = await stream.finalMessage();
    lastStop = response.stop_reason ?? null;
    turnUsage.input += response.usage?.input_tokens ?? 0;
    turnUsage.output += response.usage?.output_tokens ?? 0;
    turnUsage.cache_read += response.usage?.cache_read_input_tokens ?? 0;
    turnUsage.cache_create += response.usage?.cache_creation_input_tokens ?? 0;
    turnUsage.calls += 1;

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') {
      finalText = response.content
        .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      break;
    }

    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use'
    );
    const toolResultBlocks: Anthropic.Messages.ToolResultBlockParam[] = [];

    for (const block of toolUseBlocks) {
      const tool = TOOL_MAP[block.name];
      if (!tool) {
        const entry: ToolLogEntry = {
          name: block.name,
          displayLabel: `不明なツール: ${block.name}`,
          isError: true,
        };
        toolResultBlocks.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: `unknown_tool: ${block.name}`,
          is_error: true,
        });
        toolLog.push(entry);
        params.onEvent({ type: 'tool', entry });
        continue;
      }
      try {
        const result = await tool.handler(
          (block.input as Record<string, unknown>) ?? {},
          ctx
        );
        const entry: ToolLogEntry = {
          name: tool.name,
          displayLabel: result.displayLabel,
          isError: result.isError,
          clientAction: result.clientAction,
        };
        toolResultBlocks.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: result.content,
          is_error: result.isError,
        });
        toolLog.push(entry);
        params.onEvent({ type: 'tool', entry });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const entry: ToolLogEntry = {
          name: tool.name,
          displayLabel: `${tool.name} 失敗`,
          isError: true,
        };
        toolResultBlocks.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: `tool_error: ${msg}`,
          is_error: true,
        });
        toolLog.push(entry);
        params.onEvent({ type: 'tool', entry });
        console.error(`[agent:${tool.name}] handler threw:`, err);
      }
    }

    messages.push({ role: 'user', content: toolResultBlocks });
  }

  if (!finalText) {
    finalText =
      iterations >= MAX_ITERATIONS
        ? '（処理が長くなりすぎたため打ち切りました。もう一度シンプルな指示で試してください）'
        : '（応答を生成できませんでした）';
  }

  console.log(`[agent:usage] ${JSON.stringify({ meetingId: params.meetingId, model: MODEL, tools: toolLog.map((t) => t.name), ...turnUsage })}`);
  auditLlmCall({
    feature: 'agent',
    model: MODEL,
    inputTokens: turnUsage.input,
    outputTokens: turnUsage.output,
    cacheReadTokens: turnUsage.cache_read,
    cacheCreationTokens: turnUsage.cache_create,
    costUsd: estimateCostUsd(MODEL, turnUsage.input, turnUsage.output, { creationInputTokens: turnUsage.cache_create, readInputTokens: turnUsage.cache_read }),
    userId: params.userId,
    meetingId: params.meetingId,
    extra: { apiCalls: turnUsage.calls, iterations },
  });
  params.onEvent({ type: 'done', iterations, stopReason: lastStop });

  return { assistantText: finalText, toolLog, iterations, stopReason: lastStop };
}

export async function runAgentTurn(params: {
  userId: number;
  meetingId: number;
  messages: IncomingMessage[];
}): Promise<AgentTurnResult> {
  return runAgentTurnStreaming({
    ...params,
    onEvent: () => {
    },
  });
}

export function isAgentEnabled(): boolean {
  return process.env.ENABLE_NL_AGENT === 'true';
}

export function getRegisteredToolNames(): string[] {
  return AGENT_TOOLS.map((t) => t.name);
}
