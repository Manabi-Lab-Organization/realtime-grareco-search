import { describe, it, expect } from 'vitest';
import {
  SUB_AGENTS,
  DEFAULT_RESEARCH_SETTINGS,
  applyConfiguredModels,
  buildFilteredOrchestratorPrompt,
  buildInvestigatedTopicsBlock,
  formatTodayJst,
  INVESTIGATED_OLDER_LIMIT,
} from '../managedAgent.js';
import { loadResearchModelConfig } from '../modelConfig.js';

describe('司令塔の指示', () => {
  const prompt = buildFilteredOrchestratorPrompt(DEFAULT_RESEARCH_SETTINGS);

  it('示唆を最優先にし、合格条件と出す量を示す', () => {
    expect(prompt).toContain('話し手と参加者が自分では気づけない示唆');
    expect(prompt).toContain('カードにする合格条件（迷ったら出さない）');
    expect(prompt).toContain('1 回につき原則 1 件');
    expect(prompt).toContain('最大 3 件');
    expect(prompt).toContain('長さの上限は設けない');
  });

  it('会話に出たアイディアは技術情報に、より良い実現方法を探させる', () => {
    expect(prompt).toContain('会話に出たアイディア');
    expect(prompt).toContain('同じ目的をより良く実現している直近 12 か月の国内外の事例・調査レポート・論文・OSS と、その作り方');
  });

  it('調べないものと、話し手の信頼を下げる言い方をしないことを示す', () => {
    expect(prompt).toContain('## 調べないもの');
    expect(prompt).toContain('補足・アップデート');
  });

  it('私人を調べない決まりを残す', () => {
    expect(prompt).toContain('会議の参加者や、会議で名前が出た私人');
  });

  it('既定では司令塔は自分で検索せず、許したときだけ検索できると伝える', () => {
    expect(prompt).toContain('あなたは自分では検索もページの取得もしません');
    expect(buildFilteredOrchestratorPrompt(DEFAULT_RESEARCH_SETTINGS, true)).toContain('自分でも WebSearch・WebFetch を使えます');
  });
});

describe('調査役の指示', () => {
  const agents = SUB_AGENTS as Record<string, { prompt: string; model?: string }>;

  it('技術情報は GitHub を当たり、示唆が無ければ「示唆なし」と返す', () => {
    const p = agents['技術情報'].prompt;
    expect(p).toContain('GitHub の OSS・参考実装を必ず当たる');
    expect(p).toContain('WebSearch 最大4回');
    expect(p).toContain('WebFetch 最大3回');
    expect(p).toContain('「示唆なし」とだけ返す');
  });

  it('事実確認は重要な誤りだけを報告し、検索は 2 回・取得は 1 回まで', () => {
    const p = agents['事実確認'].prompt;
    expect(p).toContain('「重要な誤りなし」');
    expect(p).toContain('WebSearch 最大2回');
    expect(p).toContain('WebFetch 最大1回');
  });

  it('事実確認には事実確認のモデル、ほかの調査役には軽いモデルを当てる', () => {
    const config = loadResearchModelConfig({ RESEARCH_FACTCHECK_MODEL: 'claude-opus-5-5', RESEARCH_HAIKU_MODEL: 'claude-haiku-4-5-20251001' });
    const applied = applyConfiguredModels(agents, config);
    expect(applied['事実確認'].model).toBe('claude-opus-5-5');
    for (const label of ['補足情報', '論理課題', '技術情報']) expect(applied[label].model).toBe('claude-haiku-4-5-20251001');
  });

  it('既定のモデルは ID で指定する', () => {
    expect(agents['事実確認'].model).toBe('claude-sonnet-5-5');
    for (const label of ['補足情報', '論理課題', '技術情報']) expect(agents[label].model).toBe('claude-haiku-5-5');
  });
});

describe('今日の日付と調査済みの論点', () => {
  it('今日の日付を日本時間の YYYY-MM-DD で作る', () => {
    expect(formatTodayJst(new Date('2030-01-31T15:30:00Z'))).toBe('2030-02-01');
    expect(formatTodayJst(new Date('2030-01-31T14:59:00Z'))).toBe('2030-01-31');
  });

  it('論点が無ければ何も足さない', () => {
    expect(buildInvestigatedTopicsBlock([], 0)).toBe('');
  });

  it('直近 10 分は要約付き、それより前はキーワードだけを新しい順に渡す', () => {
    const now = 100 * 60 * 1000;
    const block = buildInvestigatedTopicsBlock([
      { keyword: '古い論点', timestamp: now - 50 * 60 * 1000, summary: '古い要約' },
      { keyword: '新しい論点', timestamp: now - 2 * 60 * 1000, summary: '新しい要約' },
      { keyword: '中ほどの論点', timestamp: now - 20 * 60 * 1000, summary: '中ほどの要約' },
    ], now);
    expect(block).toContain('- **新しい論点**（2分前）: 新しい要約');
    expect(block).toContain('中ほどの論点、古い論点');
    expect(block).not.toContain('古い要約');
    expect(block).toContain('言い換え・上位概念');
  });

  it('それより前の論点は上限までにする', () => {
    const now = 1000 * 60 * 60 * 1000;
    const topics = Array.from({ length: INVESTIGATED_OLDER_LIMIT + 10 }, (_, i) => ({
      keyword: `論点${i}`,
      timestamp: now - (11 + i) * 60 * 1000,
      summary: '',
    }));
    const block = buildInvestigatedTopicsBlock(topics, now);
    expect(block).toContain(`論点${INVESTIGATED_OLDER_LIMIT - 1}`);
    expect(block).not.toContain(`論点${INVESTIGATED_OLDER_LIMIT}、`);
    expect(block).not.toContain(`論点${INVESTIGATED_OLDER_LIMIT + 9}`);
  });
});
