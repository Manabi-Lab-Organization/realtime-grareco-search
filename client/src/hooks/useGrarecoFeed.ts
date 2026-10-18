import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import type {
  GrarecoDraftEvent,
  GrarecoImageReadyEvent,
  GrarecoSkippedEvent,
  GraphicRecording,
  TopicShiftCandidateEvent,
  TopicShiftCandidateClearedEvent,
} from 'shared';

export interface GrarecoFeedItem {
  recordingId: number;
  triggerType: GrarecoDraftEvent['triggerType'];
  draft: GrarecoDraftEvent['draft'];
  receivedAt: number;
  willAutoPromote: boolean;
  cancelDeadlineMs: number;
  imageUrl: string | null;
  pinned: boolean;
  isPromoting: boolean;
  skippedReason?: GrarecoSkippedEvent['reason'];
}

export interface TopicShiftCandidate {
  meetingId: number;
  similarity: number;
  detectedAt: number;
}

const AUTO_TRIGGER_TYPES = new Set([
  'auto_reflect',
  'auto_discover',
  'auto_milestone',
  'auto_fallback',
  'auto_meeting_end',
  'user_reflect',
  'user_discover',
]);

function isAutoGrareco(gr: GraphicRecording): boolean {
  return !!gr.triggerType && AUTO_TRIGGER_TYPES.has(gr.triggerType);
}

export function useGrarecoFeed(
  meetingId: number | undefined,
  socketRef?: React.MutableRefObject<any>,
  socketReady: boolean = false,
  onLiveAdd?: (item: GrarecoFeedItem) => void,
  onLiveSkipped?: (recordingId: number, reason: GrarecoSkippedEvent['reason']) => void,
  onBulkDone?: (promoted: number, remaining: number) => void,
) {
  const queryClient = useQueryClient();

  const [liveItems, setLiveItems] = useState<GrarecoFeedItem[]>([]);
  const [dismissedIds, setDismissedIds] = useState<Set<number>>(new Set());
  const [promotingIds, setPromotingIds] = useState<Set<number>>(new Set());
  const [topicShiftCandidate, setTopicShiftCandidate] =
    useState<TopicShiftCandidate | null>(null);

  useEffect(() => {
    setLiveItems([]);
    setDismissedIds(new Set());
    setPromotingIds(new Set());
    setTopicShiftCandidate(null);
  }, [meetingId]);

  useEffect(() => {
    if (!meetingId || !socketRef) return;
    const socket = socketRef.current;
    if (!socket) return;

    const onDraft = (ev: GrarecoDraftEvent) => {
      if (ev.meetingId !== meetingId) return;
      setLiveItems((prev) => {
        if (prev.some((i) => i.recordingId === ev.recordingId)) return prev;
        const item: GrarecoFeedItem = {
          recordingId: ev.recordingId,
          triggerType: ev.triggerType,
          draft: ev.draft,
          receivedAt: Date.now(),
          willAutoPromote: ev.willAutoPromote,
          cancelDeadlineMs: ev.cancelDeadlineMs,
          imageUrl: null,
          pinned: false,
          isPromoting: false,
        };
        try { onLiveAdd?.(item); } catch {  }
        return [item, ...prev];
      });
    };

    const clearPromoting = (recordingId: number) =>
      setPromotingIds((prev) => {
        if (!prev.has(recordingId)) return prev;
        const n = new Set(prev);
        n.delete(recordingId);
        return n;
      });

    const onImageReady = (ev: GrarecoImageReadyEvent) => {
      if (ev.meetingId !== meetingId) return;
      clearPromoting(ev.recordingId);
      setLiveItems((prev) =>
        prev.map((i) =>
          i.recordingId === ev.recordingId
            ? { ...i, imageUrl: ev.imageUrl, isPromoting: false, skippedReason: undefined }
            : i,
        ),
      );
      queryClient.invalidateQueries({ queryKey: ['/api/meetings', meetingId, 'graphic-recordings'] });
    };

    const onSkipped = (ev: GrarecoSkippedEvent) => {
      if (ev.meetingId !== meetingId) return;
      clearPromoting(ev.recordingId);
      setLiveItems((prev) =>
        prev.map((i) => {
          if (i.recordingId !== ev.recordingId) return i;
          return {
            ...i,
            isPromoting: false,
            willAutoPromote: false,
            cancelDeadlineMs: 0,
            skippedReason: ev.reason,
          };
        }),
      );
      if (ev.reason !== 'cancelled' && ev.reason !== 'manual_mode') {
        try { onLiveSkipped?.(ev.recordingId, ev.reason); } catch {  }
      }
      console.warn(`[grareco feed] skipped: ${ev.reason} (rec=${ev.recordingId})`);
    };

    const onCandidate = (ev: TopicShiftCandidateEvent) => {
      if (ev.meetingId !== meetingId) return;
      setTopicShiftCandidate({
        meetingId: ev.meetingId,
        similarity: ev.similarity,
        detectedAt: ev.detectedAt,
      });
    };

    const onCandidateCleared = (ev: TopicShiftCandidateClearedEvent) => {
      if (ev.meetingId !== meetingId) return;
      setTopicShiftCandidate(null);
    };

    const onBulkDoneEv = (ev: { meetingId: number; promoted: number; remaining: number }) => {
      if (ev.meetingId !== meetingId) return;
      try { onBulkDone?.(ev.promoted, ev.remaining); } catch {  }
    };

    socket.on('grareco_draft', onDraft);
    socket.on('grareco_image_ready', onImageReady);
    socket.on('grareco_skipped', onSkipped);
    socket.on('grareco_bulk_done', onBulkDoneEv);
    socket.on('topic_shift_candidate', onCandidate);
    socket.on('topic_shift_candidate_cleared', onCandidateCleared);

    return () => {
      socket.off('grareco_draft', onDraft);
      socket.off('grareco_image_ready', onImageReady);
      socket.off('grareco_skipped', onSkipped);
      socket.off('grareco_bulk_done', onBulkDoneEv);
      socket.off('topic_shift_candidate', onCandidate);
      socket.off('topic_shift_candidate_cleared', onCandidateCleared);
    };
  }, [meetingId, socketRef, socketReady, queryClient]);

  const { data: savedRecords = [], isPending: savedPending } = useQuery<GraphicRecording[]>({
    queryKey: ['/api/meetings', meetingId, 'graphic-recordings'],
    queryFn: async () => {
      const res = await apiRequest('GET', `/api/meetings/${meetingId}/graphic-recordings`);
      return res.json();
    },
    enabled: !!meetingId && meetingId > 0,
    refetchInterval: 30_000,
  });

  const mergedItems = useMemo<GrarecoFeedItem[]>(() => {
    const applyPromoting = (item: GrarecoFeedItem): GrarecoFeedItem =>
      promotingIds.has(item.recordingId)
        ? { ...item, isPromoting: true, skippedReason: undefined }
        : item;

    const result: GrarecoFeedItem[] = liveItems.map(applyPromoting);
    const seenIds = new Set(liveItems.map((i) => i.recordingId));

    for (const r of savedRecords) {
      if (!isAutoGrareco(r)) continue;
      if (seenIds.has(r.id)) continue;
      seenIds.add(r.id);
      const draft = (r.draftJson as GrarecoDraftEvent['draft']) ?? null;
      if (!draft) continue;
      result.push(applyPromoting({
        recordingId: r.id,
        triggerType: r.triggerType as GrarecoFeedItem['triggerType'],
        draft,
        receivedAt: new Date(r.createdAt).getTime(),
        willAutoPromote: false,
        cancelDeadlineMs: 0,
        imageUrl: r.imageUrl,
        pinned: !!r.pinnedAt,
        isPromoting: false,
      }));
    }
    result.sort((a, b) => b.receivedAt - a.receivedAt);
    return result;
  }, [liveItems, savedRecords, promotingIds]);

  const dismissItem = useCallback((recordingId: number) => {
    setDismissedIds((prev) => {
      const n = new Set(prev);
      n.add(recordingId);
      return n;
    });
  }, []);

  const markPromoting = useCallback((recordingId: number, on: boolean) => {
    setLiveItems((prev) =>
      prev.map((i) => (i.recordingId === recordingId ? { ...i, isPromoting: on } : i)),
    );
    setPromotingIds((prev) => {
      if (on === prev.has(recordingId)) return prev;
      const n = new Set(prev);
      if (on) n.add(recordingId);
      else n.delete(recordingId);
      return n;
    });
  }, []);

  const clearAllPromoting = useCallback(() => {
    setPromotingIds((prev) => (prev.size === 0 ? prev : new Set()));
    setLiveItems((prev) =>
      prev.some((i) => i.isPromoting)
        ? prev.map((i) => (i.isPromoting ? { ...i, isPromoting: false } : i))
        : prev,
    );
  }, []);

  const markPinned = useCallback((recordingId: number, on: boolean) => {
    setLiveItems((prev) =>
      prev.map((i) => (i.recordingId === recordingId ? { ...i, pinned: on } : i)),
    );
  }, []);

  const visibleItems = mergedItems.filter((i) => !dismissedIds.has(i.recordingId));

  const dismissTopicShiftCandidate = useCallback(async () => {
    setTopicShiftCandidate(null);
    if (!meetingId) return;
    try {
      const res = await apiRequest(
        'POST',
        `/api/meetings/${meetingId}/grareco/dismiss-topic-shift-candidate`,
      );
      await res.json().catch(() => undefined);
    } catch (err) {
      console.warn('[useGrarecoFeed] dismiss candidate failed:', err);
    }
  }, [meetingId]);

  const confirmTopicShiftCandidate = useCallback(async () => {
    setTopicShiftCandidate(null);
    if (!meetingId) return;
    try {
      const res = await apiRequest(
        'POST',
        `/api/meetings/${meetingId}/grareco/confirm-topic-shift-candidate`,
      );
      await res.json().catch(() => undefined);
    } catch (err) {
      console.warn('[useGrarecoFeed] confirm candidate failed:', err);
    }
  }, [meetingId]);

  return {
    items: visibleItems,
    isLoading: savedPending,
    dismissItem,
    markPromoting,
    clearAllPromoting,
    markPinned,
    topicShiftCandidate,
    dismissTopicShiftCandidate,
    confirmTopicShiftCandidate,
  };
}
