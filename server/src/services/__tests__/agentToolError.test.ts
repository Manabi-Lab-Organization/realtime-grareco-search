import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { DB_FAILURE_MESSAGE } from '../../db/queryError.js';

const stream = vi.fn();
const handler = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { stream: (params: unknown) => stream(params) };
  },
}));
vi.mock('../agent/tools.js', () => ({
  AGENT_TOOLS: [],
  TOOL_MAP: { sample_tool: { name: 'sample_tool', handler: (...args: unknown[]) => handler(...args) } },
  toolsForAnthropic: () => [],
}));
vi.mock('../agent/systemPrompt.js', () => ({
  buildSystemPrompt: async () => ({ staticPart: 'static', dynamicPart: '' }),
}));
vi.mock('../audit/audit.js', () => ({ auditLlmCall: vi.fn() }));

import { runAgentTurnStreaming } from '../agent/index.js';

const savedKey = process.env.ANTHROPIC_API_KEY;
process.env.ANTHROPIC_API_KEY = 'test-key';

function finished(content: unknown[], stopReason: string) {
  return {
    on: vi.fn(),
    finalMessage: async () => ({ content, stop_reason: stopReason, usage: {} }),
  };
}

async function toolResultFor(failure: Error) {
  handler.mockRejectedValue(failure);
  let sent: Array<{ content: unknown }> = [];
  stream
    .mockImplementationOnce(() =>
      finished([{ type: 'tool_use', id: 'tool-1', name: 'sample_tool', input: {} }], 'tool_use'),
    )
    .mockImplementationOnce((params: { messages: Array<{ content: unknown }> }) => {
      sent = [...params.messages];
      return finished([{ type: 'text', text: 'done' }], 'end_turn');
    });

  const events: unknown[] = [];
  await runAgentTurnStreaming({
    userId: 1,
    meetingId: 2,
    messages: [{ role: 'user', content: 'hello' }],
    onEvent: (event) => events.push(event),
  });

  const blocks = sent.at(-1)!.content as Array<{ content: string; is_error: boolean }>;
  return { block: blocks[0], events };
}

describe('ツールの失敗をモデルへ渡す文', () => {
  beforeEach(() => {
    stream.mockReset();
    handler.mockReset();
  });

  afterAll(() => {
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
  });

  it('データベースの失敗は固定の文にする', async () => {
    const failure = new DrizzleQueryError(
      'select "secret_column" from "users"',
      ['secret-value'],
      new Error('cause-value'),
    );
    const { block, events } = await toolResultFor(failure);
    expect(block.is_error).toBe(true);
    expect(block.content).toBe(`tool_error: ${DB_FAILURE_MESSAGE}`);
    const everything = JSON.stringify([block, events]);
    expect(everything).not.toContain('secret_column');
    expect(everything).not.toContain('secret-value');
    expect(everything).not.toContain('cause-value');
  });

  it('ほかの失敗は判断に必要な文を残す', async () => {
    const { block } = await toolResultFor(new Error('recording_not_ready'));
    expect(block.is_error).toBe(true);
    expect(block.content).toBe('tool_error: recording_not_ready');
  });
});
