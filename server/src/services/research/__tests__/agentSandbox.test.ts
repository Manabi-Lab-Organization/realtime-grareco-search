import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';

const extraMessages: unknown[] = [];
const captured: Array<{ prompt: string; options: Record<string, any>; cwdExistedDuringRun: boolean; cwdEmpty: boolean }> = [];
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(({ prompt, options }: { prompt: string; options: Record<string, any> }) => {
    captured.push({
      prompt,
      options,
      cwdExistedDuringRun: existsSync(options.cwd),
      cwdEmpty: existsSync(options.cwd) && readdirSync(options.cwd).length === 0,
    });
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's1' };
      for (const m of extraMessages) yield m;
      yield { type: 'result', subtype: 'success' };
    })();
  }),
  createSdkMcpServer: vi.fn(() => ({ type: 'sdk', name: 'example' })),
  tool: vi.fn(),
}));

import {
  buildResearchAgentEnv,
  buildResearchQueryOptions,
  hardenSubAgents,
  runResearchQuery,
  denyInternalWebFetch,
  makeDenyInternalWebFetch,
  INTERNAL_WEBFETCH_DENY_REASON,
  WEBFETCH_NOT_IN_SEARCH_RESULTS_DENY_REASON,
  SearchResultUrls,
  makeCollectSearchResultUrls,
  makeSearchResultOnlyWebFetch,
  urlsFromWebSearchOutput,
  RESEARCH_BUILTIN_TOOLS,
  RESEARCH_DISALLOWED_TOOLS,
  ORCHESTRATOR_AGENT_NAME,
  ORCHESTRATOR_WEBFETCH_DENY_REASON,
  makeDenyOrchestratorWebFetch,
} from '../agentSandbox.js';
import { SUB_AGENTS } from '../managedAgent.js';

const FILE_AND_SHELL_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'NotebookEdit'];

describe('調査エージェントの実行の制限', () => {
  const savedEnv = { ...process.env };
  beforeEach(() => {
    captured.length = 0;
    extraMessages.length = 0;
    process.env.ANTHROPIC_API_KEY = 'sk-test-key';
    process.env.DATABASE_URL = 'postgres://user:dummy@db/sample';
    process.env.GEMINI_API_KEY = 'dummy-gemini-key';
    process.env.SESSION_SECRET = 'dummy-session-secret';
  });
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('使えるツールと許可するツールを WebSearch・WebFetch・Agent の 3 つにする', () => {
    const o = buildResearchQueryOptions({ agents: {}, systemPrompt: 'x', model: 'sonnet', runDir: '/tmp/x' });
    expect(o.tools).toEqual(['WebSearch', 'WebFetch', 'Agent']);
    expect(o.allowedTools).toEqual(['WebSearch', 'WebFetch', 'Agent']);
  });

  it('ファイルとシェルのツールを拒否し、確認を求めない設定にする', () => {
    const o = buildResearchQueryOptions({ agents: {}, systemPrompt: 'x', model: 'sonnet', runDir: '/tmp/x' });
    for (const t of FILE_AND_SHELL_TOOLS) expect(o.disallowedTools).toContain(t);
    expect(o.permissionMode).toBe('dontAsk');
    expect(o.settingSources).toEqual([]);
    expect(o.strictMcpConfig).toBe(true);
    for (const t of RESEARCH_BUILTIN_TOOLS) expect(RESEARCH_DISALLOWED_TOOLS).not.toContain(t);
  });

  it('決められた環境変数だけを渡す', () => {
    const env = buildResearchAgentEnv('/tmp/run');
    expect(env.ANTHROPIC_API_KEY).toBe('sk-test-key');
    expect(env.HOME).toBe('/tmp/run');
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.SESSION_SECRET).toBeUndefined();
    const allowed = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'PATH', 'LANG', 'NODE_EXTRA_CA_CERTS', 'HOME', 'TMPDIR', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'CLAUDE_AGENT_SDK_CLIENT_APP']);
    for (const k of Object.keys(env)) expect(allowed.has(k)).toBe(true);
  });

  it('サブエージェントにも同じ制限をかけ、ツールの指定が無ければ空にする', () => {
    const hardened = hardenSubAgents({
      a: { description: 'a', prompt: 'p', tools: ['WebSearch'] },
      b: { description: 'b', prompt: 'p' },
    });
    expect(hardened.b.tools).toEqual([]);
    for (const def of Object.values(hardened)) {
      expect(def.permissionMode).toBe('dontAsk');
      for (const t of FILE_AND_SHELL_TOOLS) expect(def.disallowedTools).toContain(t);
    }
  });

  it('用意されたサブエージェントは許可したツールだけを持つ', () => {
    const allowed = new Set<string>([...RESEARCH_BUILTIN_TOOLS]);
    const hardened = hardenSubAgents(SUB_AGENTS as Record<string, any>);
    expect(Object.keys(hardened).length).toBeGreaterThan(0);
    for (const [name, def] of Object.entries(hardened)) {
      expect(Array.isArray(def.tools), name).toBe(true);
      for (const t of def.tools!) expect(allowed.has(t), `${name}: ${t}`).toBe(true);
      expect(def.permissionMode).toBe('dontAsk');
    }
  });

  it('runResearchQuery は制限付きの設定で実行し、空の作業フォルダを終了後に消す', async () => {
    const msgs: unknown[] = [];
    for await (const m of runResearchQuery('prompt', {
      agents: { '補足情報': { description: 'd', prompt: 'p', tools: ['WebSearch', 'WebFetch'] } },
      systemPrompt: 'sys',
      model: 'sonnet',
      mcpServers: { example: { type: 'sdk', name: 'example' } as any },
      extraAllowedTools: ['mcp__example__lookup'],
    })) msgs.push(m);

    expect(msgs).toHaveLength(2);
    expect(captured).toHaveLength(1);
    const { options, cwdExistedDuringRun, cwdEmpty } = captured[0];
    expect(options.tools).toEqual(['WebSearch', 'WebFetch', 'Agent']);
    expect(options.allowedTools).toEqual(['WebSearch', 'WebFetch', 'Agent', 'mcp__example__lookup']);
    expect(options.permissionMode).toBe('dontAsk');
    expect(options.env.DATABASE_URL).toBeUndefined();
    expect(options.env.HOME).toBe(options.cwd);
    expect(options.agents['補足情報'].permissionMode).toBe('dontAsk');
    expect(options.agents['補足情報'].disallowedTools).toContain('Bash');
    expect(cwdExistedDuringRun).toBe(true);
    expect(cwdEmpty).toBe(true);
    expect(existsSync(options.cwd)).toBe(false);
  });

  it('途中で抜けても作業フォルダを消す', async () => {
    for await (const _m of runResearchQuery('prompt', { agents: {}, systemPrompt: 's', model: 'sonnet' })) break;
    expect(existsSync(captured[0].options.cwd)).toBe(false);
  });
});

describe('WebFetch の宛先の検査', () => {
  const signal = new AbortController().signal;
  const webFetch = (url: unknown, agent_id?: string) => ({
    hook_event_name: 'PreToolUse' as const, tool_name: 'WebFetch', tool_input: { url, prompt: '内容をまとめてください' }, tool_use_id: 't1',
    session_id: 's', transcript_path: '', cwd: '/tmp/x', ...(agent_id ? { agent_id } : {}),
  });
  const hook = makeDenyInternalWebFetch(async (host) => (host.startsWith('intranet.') ? ['10.0.0.5'] : ['93.184.216.34']));
  const decision = async (url: unknown, agent_id?: string) =>
    ((await hook(webFetch(url, agent_id) as any, 't1', { signal })) as any).hookSpecificOutput;

  it('実行の設定に、WebFetch の検査と WebSearch の結果の記録を加える', () => {
    const o = buildResearchQueryOptions({ agents: {}, systemPrompt: 'x', model: 'sonnet', runDir: '/tmp/x' });
    expect(o.hooks?.PreToolUse).toHaveLength(1);
    expect(o.hooks?.PreToolUse?.[0].matcher).toBe('WebFetch');
    expect(o.hooks?.PostToolUse).toHaveLength(1);
    expect(o.hooks?.PostToolUse?.[0].matcher).toBe('WebSearch');
    expect(typeof denyInternalWebFetch).toBe('function');
  });

  it.each([
    'http://169.254.169.254/latest/meta-data/',
    'http://192.168.1.10/admin',
    'http://app.service.internal/',
    'http://localhost:3000/api/admin',
    'http://127.0.0.1/',
    'http://[::1]/',
    'http://[fd00:ec2::254]/',
    'http://[64:ff9b:1::a00:5]/',
    'http://intranet.example.com/',
    'file:///etc/passwd',
    'not a url',
  ])('%s を決まった理由で拒否する', async (url) => {
    const d = await decision(url, 'agent-1');
    expect(d.permissionDecision).toBe('deny');
    expect(d.permissionDecisionReason).toBe(INTERNAL_WEBFETCH_DENY_REASON);
  });

  it('URL が無いときや文字列でないときも拒否する', async () => {
    expect((await decision(undefined)).permissionDecision).toBe('deny');
    expect((await decision(123)).permissionDecision).toBe('deny');
  });

  it('公開された宛先の URL には判定を返さない', async () => {
    expect(await hook(webFetch('https://www.example.org/press/') as any, 't1', { signal })).toEqual({});
    expect(await hook(webFetch('https://news.example.com/a', 'agent-1') as any, 't1', { signal })).toEqual({});
  });

  it('WebFetch 以外のツールには判定を返さない', async () => {
    const other = { ...webFetch('http://169.254.169.254/'), tool_name: 'WebSearch' };
    expect(await hook(other as any, 't1', { signal })).toEqual({});
  });
});

describe('WebFetch で開ける URL を、その回の検索結果に出たものに限る', () => {
  const signal = new AbortController().signal;
  const lookup = async (host: string) => (host.startsWith('intranet.') ? ['10.0.0.5'] : ['93.184.216.34']);
  const searchOutput = (urls: string[]) => ({
    query: '新商品 企画 事例',
    results: [{ tool_use_id: 'srv1', content: urls.map((url) => ({ title: 't', url })) }, '検索結果の説明の文'],
    durationSeconds: 1,
  });
  const webFetch = (url: unknown) => ({
    hook_event_name: 'PreToolUse' as const, tool_name: 'WebFetch', tool_input: { url, prompt: '要点をまとめてください' }, tool_use_id: 't1',
    session_id: 's', transcript_path: '', cwd: '/tmp/x',
  });
  const webSearchDone = (urls: string[]) => ({
    hook_event_name: 'PostToolUse' as const, tool_name: 'WebSearch', tool_input: { query: 'q' }, tool_response: searchOutput(urls),
    tool_use_id: 't0', session_id: 's', transcript_path: '', cwd: '/tmp/x', agent_id: 'agent-1',
  });

  it('検索の結果から URL を取り出す', () => {
    expect(urlsFromWebSearchOutput(searchOutput(['https://news.example.com/a', 'https://www.example.org/b']))).toEqual([
      'https://news.example.com/a',
      'https://www.example.org/b',
    ]);
    expect(urlsFromWebSearchOutput(null)).toEqual([]);
    expect(urlsFromWebSearchOutput({ results: 'x' })).toEqual([]);
  });

  it('検索の前や、検索結果に無い URL は開かせない', async () => {
    const allowed = new SearchResultUrls();
    const guard = makeSearchResultOnlyWebFetch(allowed, lookup);
    const d = ((await guard(webFetch('https://news.example.com/a') as any, 't1', { signal })) as any).hookSpecificOutput;
    expect(d.permissionDecision).toBe('deny');
    expect(d.permissionDecisionReason).toBe(WEBFETCH_NOT_IN_SEARCH_RESULTS_DENY_REASON);
  });

  it('検索結果に出た URL は開けるが、問い合わせの文字列を足したり書き換えたりした URL は開かせない', async () => {
    const allowed = new SearchResultUrls();
    const collect = makeCollectSearchResultUrls(allowed);
    const guard = makeSearchResultOnlyWebFetch(allowed, lookup);
    await collect(webSearchDone(['https://news.example.com/a?id=1', 'https://www.example.org/b']) as any, 't0', { signal });

    expect(await guard(webFetch('https://news.example.com/a?id=1') as any, 't1', { signal })).toEqual({});
    expect(await guard(webFetch('https://www.example.org/b#section') as any, 't1', { signal })).toEqual({});
    for (const url of [
      'https://news.example.com/a?id=1&q=会議の要点',
      'https://www.example.org/b?leak=1',
      'https://www.example.org/b/会議の要点',
      'https://attacker.example.net/?q=会議の要点',
      123,
    ]) {
      const d = ((await guard(webFetch(url) as any, 't1', { signal })) as any).hookSpecificOutput;
      expect(d.permissionDecision, String(url)).toBe('deny');
      expect(d.permissionDecisionReason).toBe(WEBFETCH_NOT_IN_SEARCH_RESULTS_DENY_REASON);
    }
  });

  it('検索結果に出ても、内部のアドレスは開かせない', async () => {
    const allowed = new SearchResultUrls();
    allowed.add(['http://169.254.169.254/latest/meta-data/', 'http://intranet.example.com/']);
    const guard = makeSearchResultOnlyWebFetch(allowed, lookup);
    for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://intranet.example.com/']) {
      const d = ((await guard(webFetch(url) as any, 't1', { signal })) as any).hookSpecificOutput;
      expect(d.permissionDecision).toBe('deny');
      expect(d.permissionDecisionReason).toBe(INTERNAL_WEBFETCH_DENY_REASON);
    }
  });

  it('runResearchQuery は流れてきたメッセージの検索結果も記録し、回ごとに別々に持つ', async () => {
    extraMessages.length = 0;
    captured.length = 0;
    extraMessages.push({
      type: 'user',
      parent_tool_use_id: 'agent-call-1',
      message: { role: 'user', content: [] },
      tool_use_result: searchOutput(['http://93.184.216.34/press/1']),
    });
    for await (const _m of runResearchQuery('prompt', { agents: {}, systemPrompt: 's', model: 'sonnet' })) { }
    const guard1 = captured[0].options.hooks.PreToolUse[0].hooks[0];
    expect(await guard1(webFetch('http://93.184.216.34/press/1') as any, 't1', { signal })).toEqual({});

    extraMessages.length = 0;
    for await (const _m of runResearchQuery('prompt', { agents: {}, systemPrompt: 's', model: 'sonnet' })) { }
    const guard2 = captured[1].options.hooks.PreToolUse[0].hooks[0];
    const d = ((await guard2(webFetch('http://93.184.216.34/press/1') as any, 't1', { signal })) as any).hookSpecificOutput;
    expect(d.permissionDecisionReason).toBe(WEBFETCH_NOT_IN_SEARCH_RESULTS_DENY_REASON);
    extraMessages.length = 0;
  });
});

describe('調べる対象の範囲', () => {
  it('補足情報の担当は、会議の参加者や私人を調べず、公人・企業・団体・製品・公開された出来事に限る', () => {
    const prompt = (SUB_AGENTS as Record<string, { prompt: string }>)['補足情報'].prompt;
    expect(prompt).toContain('公人・著名人、企業・団体、製品・サービス、公開された出来事に限る');
    expect(prompt).toContain('会議の参加者や、会議で名前が出た私人');
    expect(prompt).not.toContain('人物のプロフィール');
  });
});

describe('司令塔のツールと考える深さ', () => {
  const base = { agents: { '補足情報': { description: 'd', prompt: 'p', tools: ['WebSearch', 'WebFetch'] } }, systemPrompt: 'sys', model: 'claude-sonnet-5-5', runDir: '/tmp/x' };
  const signal = new AbortController().signal;
  const fetchInput = (agent_id?: string) => ({
    hook_event_name: 'PreToolUse',
    tool_name: 'WebFetch',
    tool_input: { url: 'https://example.com/' },
    session_id: 's', transcript_path: '', cwd: '/tmp',
    ...(agent_id ? { agent_id } : {}),
  });

  it('メインの会話に司令塔の定義を当て、既定では調査役を呼ぶツールだけを持たせる', () => {
    const o = buildResearchQueryOptions(base);
    expect(o.agent).toBe(ORCHESTRATOR_AGENT_NAME);
    const def = o.agents![ORCHESTRATOR_AGENT_NAME];
    expect(def.tools).toEqual(['Agent']);
    expect(def.prompt).toBe('sys');
    expect(def.model).toBe('claude-sonnet-5-5');
    expect(def.permissionMode).toBe('dontAsk');
    expect(o.agents!['補足情報'].tools).toEqual(['WebSearch', 'WebFetch']);
  });

  it('司令塔の検索を許したときだけ、司令塔にも WebSearch と WebFetch を持たせる', () => {
    const o = buildResearchQueryOptions({ ...base, orchestratorWeb: true });
    expect(o.agents![ORCHESTRATOR_AGENT_NAME].tools).toEqual(['Agent', 'WebSearch', 'WebFetch']);
    expect(o.hooks?.PreToolUse?.[0].hooks).toHaveLength(1);
  });

  it('既定では、司令塔の WebFetch をフックでも止める', () => {
    const o = buildResearchQueryOptions(base);
    expect(o.hooks?.PreToolUse?.[0].hooks).toHaveLength(2);
  });

  it('effort を指定したときだけ送る', () => {
    expect(buildResearchQueryOptions(base).effort).toBeUndefined();
    expect(buildResearchQueryOptions(base).agents![ORCHESTRATOR_AGENT_NAME].effort).toBeUndefined();
    const o = buildResearchQueryOptions({ ...base, effort: 'medium' });
    expect(o.effort).toBe('medium');
    expect(o.agents![ORCHESTRATOR_AGENT_NAME].effort).toBe('medium');
  });

  it('メインの会話の WebFetch は拒否し、調査役の WebFetch には判定を返さない', async () => {
    const hook = makeDenyOrchestratorWebFetch();
    const main = ((await hook(fetchInput() as any, 't1', { signal })) as any).hookSpecificOutput;
    expect(main.permissionDecision).toBe('deny');
    expect(main.permissionDecisionReason).toBe(ORCHESTRATOR_WEBFETCH_DENY_REASON);
    expect(await hook(fetchInput('agent-1') as any, 't2', { signal })).toEqual({});
  });
});
