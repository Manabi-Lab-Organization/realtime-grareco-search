export type ResearchTagTone = 'info' | 'fact' | 'gap' | 'todo';

export interface ResearchTag {
  icon: string;
  label: string;
  tone: ResearchTagTone;
}

const AGENT_TAGS: Record<string, { icon: string; label: string }> = {
  web: { icon: '🌐', label: '補足情報' },
  fact: { icon: '🔍', label: '事実確認' },
  gap: { icon: '⚠️', label: '論理課題' },
  tech: { icon: '🔧', label: '技術情報' },
};

export function researchCardTag(card: { cardType: string; agentType?: string | null }): ResearchTag {
  switch (card.cardType) {
    case 'fact-check':
      return { icon: '🔍', label: '事実確認', tone: 'fact' };
    case 'gap-alert':
      return { icon: '⚠️', label: '論理課題', tone: 'gap' };
    case 'minutes-todo':
      return { icon: '📝', label: 'ToDo', tone: 'todo' };
    default: {
      const agent = card.agentType ? AGENT_TAGS[card.agentType] : undefined;
      return agent ? { ...agent, tone: 'info' } : { icon: '💡', label: '参考情報', tone: 'info' };
    }
  }
}

export function researchCardTagText(card: { cardType: string; agentType?: string | null }): string {
  const t = researchCardTag(card);
  return `${t.icon}${t.label}`;
}
