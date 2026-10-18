import { useState, useEffect, useCallback, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import type { DetectedTerm } from 'shared';
import type { Socket } from 'socket.io-client';

export function useTermGlossary(
  meetingId: number,
  isRecording: boolean,
  socketRef: React.RefObject<Socket | null>,
  isLive: boolean = false,
  socketReady: boolean = false,
) {
  const [realtimeTerms, setRealtimeTerms] = useState<DetectedTerm[]>([]);
  const [dismissedTerms, setDismissedTerms] = useState<Set<string>>(new Set());
  const initializedRef = useRef(false);

  const { data: savedTerms, refetch } = useQuery<DetectedTerm[]>({
    queryKey: ['/api/meetings', meetingId, 'term-glossary'],
    queryFn: async () => {
      const res = await apiRequest('GET', `/api/meetings/${meetingId}/term-glossary`);
      return res.json();
    },
  });

  const isLiveOrRecording = isLive || isRecording;
  useEffect(() => {
    if (isLiveOrRecording && savedTerms && !initializedRef.current) {
      initializedRef.current = true;
      setRealtimeTerms(savedTerms);
    }
    if (!isLiveOrRecording) {
      initializedRef.current = false;
    }
  }, [isLiveOrRecording, savedTerms]);

  const prevRecordingRef = useRef(isRecording);
  useEffect(() => {
    if (prevRecordingRef.current && !isRecording) {
      refetch();
    }
    prevRecordingRef.current = isRecording;
  }, [isRecording, refetch]);

  useEffect(() => {
    const socket = socketRef.current;
    if (!socket || !(isLive || isRecording)) return;

    const handler = (term: DetectedTerm) => {
      setRealtimeTerms(prev => {
        const without = prev.filter(t => t.term !== term.term);
        return [...without, term];
      });
    };

    socket.on('term_detected', handler);
    return () => {
      socket.off('term_detected', handler);
    };
  }, [isLive, isRecording, socketRef, socketReady]);

  const dismissTerm = useCallback(async (term: string) => {
    setRealtimeTerms(prev => prev.filter(t => t.term !== term));
    setDismissedTerms(prev => new Set(prev).add(term));

    const socket = socketRef.current;
    if (socket && isRecording) {
      socket.emit('dismiss_term', { term });
    }

    await apiRequest('POST', '/api/meetings/term-exclusions', { term }).catch(() => {});
  }, [isRecording, socketRef]);

  const terms = isLiveOrRecording
    ? realtimeTerms
    : (savedTerms || []).filter(t => !dismissedTerms.has(t.term));

  return { terms, dismissTerm };
}
