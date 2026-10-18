import { useState, useEffect, useCallback, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';

export interface ResearchSource {
  url: string;
  title: string;
  author?: string;
  publishedAt?: string;
  trustScore: number;
}

export interface ResearchCard {
  id: string;
  cardType: 'info' | 'fact-check' | 'gap-alert' | 'minutes-todo';
  agentType: string;
  keyword: string;
  title: string;
  body: string;
  importance: number;
  sources: ResearchSource[];
  timestamp: number;
  metadata?: Record<string, unknown>;
  meetingId?: number;
}

export function useResearchInsights(
  meetingId: number | undefined,
  isLive: boolean,
  socketRef?: React.MutableRefObject<any>,
  meetingStatus?: string,
  socketReady: boolean = false,
) {
  const shouldPoll = isLive || meetingStatus === 'active' || meetingStatus === 'paused';
  const [liveCards, setLiveCards] = useState<ResearchCard[]>([]);
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    setLiveCards([]);
    setDismissedIds(new Set());
  }, [meetingId]);

  useEffect(() => {
    if (!meetingId || !socketRef) return;

    const socket = socketRef.current;
    if (!socket) return;

    const handler = (card: ResearchCard) => {
      if (typeof card.meetingId === 'number' && card.meetingId !== meetingId) return;
      setLiveCards(prev => {
        if (prev.some(c => c.id === card.id)) return prev;
        return [card, ...prev];
      });
    };

    socket.on('research_insight', handler);

    return () => {
      socket.off('research_insight', handler);
    };
  }, [meetingId, socketRef, socketReady]);

  const { data: savedCards } = useQuery<ResearchCard[]>({
    queryKey: ['/api/meetings', meetingId, 'research-insights'],
    queryFn: async () => {
      const res = await apiRequest('GET', `/api/meetings/${meetingId}/research-insights`);
      return res.json();
    },
    enabled: !!meetingId && meetingId > 0,
    refetchInterval: shouldPoll ? 5000 : false,
  });

  const cards = useMemo(() => {
    const merged: ResearchCard[] = [];
    const seenIds = new Set<string>();
    const seenContentKeys = new Set<string>();
    const contentKeyOf = (c: ResearchCard) => `${c.keyword}|${c.title}`;

    for (const card of liveCards) {
      if (seenIds.has(card.id)) continue;
      const contentKey = contentKeyOf(card);
      if (seenContentKeys.has(contentKey)) continue;
      seenIds.add(card.id);
      seenContentKeys.add(contentKey);
      merged.push(card);
    }
    if (savedCards) {
      for (const saved of savedCards) {
        if (seenIds.has(saved.id)) continue;
        const contentKey = contentKeyOf(saved);
        if (seenContentKeys.has(contentKey)) continue;
        seenIds.add(saved.id);
        seenContentKeys.add(contentKey);
        merged.push(saved);
      }
    }
    merged.sort((a, b) => b.timestamp - a.timestamp);
    return merged.filter(c => !dismissedIds.has(c.id));
  }, [liveCards, savedCards, dismissedIds]);

  const dismissCard = useCallback((cardId: string) => {
    setDismissedIds(prev => new Set(prev).add(cardId));
  }, []);

  const clearCards = useCallback(() => {
    setLiveCards([]);
    setDismissedIds(new Set());
  }, []);

  return { cards, dismissCard, clearCards };
}
