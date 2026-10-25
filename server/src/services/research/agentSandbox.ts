import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { AgentDefinition, EffortLevel, HookCallback, Options, McpServerConfig, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { assertPublicUrl, type LookupFn } from '../net/publicUrl.js';

export const RESEARCH_BUILTIN_TOOLS = ['WebSearch', 'WebFetch', 'Agent'] as const;

export const RESEARCH_DISALLOWED_TOOLS = [
  'Bash', 'BashOutput', 'KillShell', 'KillBash', 'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep',
  'NotebookEdit', 'NotebookRead', 'LS', 'EnterWorktree', 'ExitWorktree', 'PowerShell', 'LSP',
  'TodoWrite', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode',
  'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup', 'Monitor', 'RemoteTrigger', 'Skill',
  'ListMcpResources', 'ReadMcpResource', 'TaskOutput', 'TaskStop', 'SlashCommand',
];

const PASSTHROUGH_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'PATH', 'LANG', 'NODE_EXTRA_CA_CERTS'] as const;

export function buildResearchAgentEnv(runDir: string, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of PASSTHROUGH_ENV) {
    const v = source[key];
    if (typeof v === 'string' && v !== '') env[key] = v;
  }
  env.HOME = runDir;
  env.TMPDIR = runDir;
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  env.CLAUDE_AGENT_SDK_CLIENT_APP = 'realtime-grareco-search-research';
  return env;
}

export function hardenSubAgents(agents: Record<string, AgentDefinition>): Record<string, AgentDefinition> {
  const out: Record<string, AgentDefinition> = {};
  for (const [name, def] of Object.entries(agents)) {
    out[name] = {
      ...def,
      tools: def.tools ?? [],
      disallowedTools: [...new Set([...(def.disallowedTools ?? []), ...RESEARCH_DISALLOWED_TOOLS])],
      permissionMode: 'dontAsk',
    };
  }
  return out;
}

export const ORCHESTRATOR_AGENT_NAME = '司令塔';

export function orchestratorTools(web: boolean): string[] {
  return web ? ['Agent', 'WebSearch', 'WebFetch'] : ['Agent'];
}

export interface ResearchQueryParams {
  agents: Record<string, AgentDefinition>;
  systemPrompt: string;
  model: string;
  runDir: string;
  effort?: EffortLevel;
  orchestratorWeb?: boolean;
  mcpServers?: Record<string, McpServerConfig>;
  extraAllowedTools?: string[];
}

export const INTERNAL_WEBFETCH_DENY_REASON = '内部ネットワーク・予約アドレスの URL は取得できません。公開されている Web ページの URL を使ってください。';

export function makeDenyInternalWebFetch(lookupFn?: LookupFn): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse' || input.tool_name !== 'WebFetch') return {};
    const url = (input.tool_input as { url?: unknown } | null)?.url;
    try {
      if (typeof url !== 'string') throw new Error('URL がありません');
      await assertPublicUrl(url, lookupFn);
      return {};
    } catch {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: INTERNAL_WEBFETCH_DENY_REASON,
        },
      };
    }
  };
}

export const denyInternalWebFetch: HookCallback = makeDenyInternalWebFetch();

export const WEBFETCH_NOT_IN_SEARCH_RESULTS_DENY_REASON = 'この調査で検索結果に出たページの URL だけを開けます。検索結果の URL を、書き換えずにそのまま使ってください。';

export function normalizeFetchUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    return u.href;
  } catch {
    return null;
  }
}

export function urlsFromWebSearchOutput(output: unknown): string[] {
  const results = (output as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return [];
  const urls: string[] = [];
  for (const r of results) {
    const content = (r as { content?: unknown } | null)?.content;
    if (!Array.isArray(content)) continue;
    for (const hit of content) {
      const url = (hit as { url?: unknown } | null)?.url;
      if (typeof url === 'string') urls.push(url);
    }
  }
  return urls;
}

export class SearchResultUrls {
  private readonly urls = new Set<string>();

  add(urls: Iterable<string>): void {
    for (const raw of urls) {
      const n = normalizeFetchUrl(raw);
      if (n) this.urls.add(n);
    }
  }

  addFromMessage(message: SDKMessage): void {
    if (message.type !== 'user') return;
    this.add(urlsFromWebSearchOutput((message as { tool_use_result?: unknown }).tool_use_result));
  }

  has(raw: string): boolean {
    const n = normalizeFetchUrl(raw);
    return n !== null && this.urls.has(n);
  }

  get size(): number {
    return this.urls.size;
  }
}

export function makeCollectSearchResultUrls(allowed: SearchResultUrls): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PostToolUse' || input.tool_name !== 'WebSearch') return {};
    allowed.add(urlsFromWebSearchOutput(input.tool_response));
    return {};
  };
}

export function makeSearchResultOnlyWebFetch(allowed: SearchResultUrls, lookupFn?: LookupFn): HookCallback {
  const denyInternal = makeDenyInternalWebFetch(lookupFn);
  return async (input, toolUseId, opts) => {
    if (input.hook_event_name !== 'PreToolUse' || input.tool_name !== 'WebFetch') return {};
    const url = (input.tool_input as { url?: unknown } | null)?.url;
    if (typeof url !== 'string' || !allowed.has(url)) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: WEBFETCH_NOT_IN_SEARCH_RESULTS_DENY_REASON,
        },
      };
    }
    return denyInternal(input, toolUseId, opts);
  };
}

export const ORCHESTRATOR_WEBFETCH_DENY_REASON = '統括役は自分でページを開きません。調べたいことは調査役に任せてください。';

export function makeDenyOrchestratorWebFetch(): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse' || input.tool_name !== 'WebFetch') return {};
    if (input.agent_id) return {};
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: ORCHESTRATOR_WEBFETCH_DENY_REASON,
      },
    };
  };
}

export function buildOrchestratorAgent(p: Pick<ResearchQueryParams, 'systemPrompt' | 'model' | 'effort' | 'orchestratorWeb'>): AgentDefinition {
  const def: AgentDefinition = {
    description: 'この調査を統括する役。調査の依頼先にはしない。',
    prompt: p.systemPrompt,
    tools: orchestratorTools(p.orchestratorWeb === true),
    model: p.model,
  };
  if (p.effort) def.effort = p.effort;
  return def;
}

export function buildResearchQueryOptions(p: ResearchQueryParams, allowedFetchUrls: SearchResultUrls = new SearchResultUrls()): Options {
  const options: Options = {
    tools: [...RESEARCH_BUILTIN_TOOLS],
    allowedTools: [...RESEARCH_BUILTIN_TOOLS, ...(p.extraAllowedTools ?? [])],
    disallowedTools: [...RESEARCH_DISALLOWED_TOOLS],
    permissionMode: 'dontAsk',
    agents: hardenSubAgents({ ...p.agents, [ORCHESTRATOR_AGENT_NAME]: buildOrchestratorAgent(p) }),
    agent: ORCHESTRATOR_AGENT_NAME,
    systemPrompt: p.systemPrompt,
    model: p.model,
    cwd: p.runDir,
    env: buildResearchAgentEnv(p.runDir),
    settingSources: [],
    strictMcpConfig: true,
    hooks: {
      PreToolUse: [{
        matcher: 'WebFetch',
        hooks: p.orchestratorWeb
          ? [makeSearchResultOnlyWebFetch(allowedFetchUrls)]
          : [makeSearchResultOnlyWebFetch(allowedFetchUrls), makeDenyOrchestratorWebFetch()],
      }],
      PostToolUse: [{ matcher: 'WebSearch', hooks: [makeCollectSearchResultUrls(allowedFetchUrls)] }],
    },
  };
  if (p.effort) options.effort = p.effort;
  if (p.mcpServers) options.mcpServers = p.mcpServers;
  return options;
}

export async function* runResearchQuery(
  prompt: string,
  params: Omit<ResearchQueryParams, 'runDir'>,
): AsyncGenerator<SDKMessage, void, undefined> {
  const runDir = await mkdtemp(path.join(os.tmpdir(), 'research-run-'));
  const allowedFetchUrls = new SearchResultUrls();
  try {
    for await (const message of query({ prompt, options: buildResearchQueryOptions({ ...params, runDir }, allowedFetchUrls) })) {
      allowedFetchUrls.addFromMessage(message);
      yield message;
    }
  } finally {
    await rm(runDir, { recursive: true, force: true }).catch((err) =>
      console.error('[research] 一時ディレクトリの削除に失敗:', err instanceof Error ? err.message : String(err)),
    );
  }
}
