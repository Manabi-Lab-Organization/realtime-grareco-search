
import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { Link, useParams } from 'wouter';
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import {
  ArrowLeft,
  StopCircle,
  Sparkles,
  X,
  Copy,
  Share2,
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  ChevronRight,
  Users,
  Maximize2,
  CheckSquare,
  Square as SquareIcon,
  RefreshCw,
  Search,
  Download,
  Settings,
  Paintbrush,
  Sparkle,
  Pencil,
  Plus,
  Loader2,
  Clipboard,
  FileUp,
  Image as ImageIcon,
  Trash2,
  Save,
  Eye,
  MapPin,
  Clock,
  AlertTriangle,
} from 'lucide-react';
import { AnnouncementsBell } from '../components/announcements/AnnouncementsBell';
import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { ShareMeetingDialog } from '@/components/share/ShareMeetingDialog';
import { GuestShareToggle } from '@/components/share/GuestShareToggle';
import { isShareableResearch } from '@/components/share/ShareContentSettings';
import { useShareControls, type ShareControl } from '@/hooks/useShareControls';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { useViewerSocket } from '@/hooks/useViewerSocket';
import { useSessionHeartbeat } from '@/hooks/useSessionHeartbeat';
import { useResearchInsights, type ResearchCard } from '@/hooks/useResearchInsights';
import { useResearchSettings } from '@/hooks/useResearchSettings';
import { useTermGlossary } from '@/hooks/useTermGlossary';
import { useGrarecoFeed, type GrarecoFeedItem } from '@/hooks/useGrarecoFeed';
import { grarecoThumbUrl } from '@/lib/grarecoThumb';
import { useAgentAvailability } from '@/hooks/useAgentAvailability';
import { apiRequest } from '@/lib/queryClient';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { AgentChatPanel } from '@/components/agent/AgentChatPanel';
import { hasChatHistory } from '@/hooks/useAgentChat';
import { ParticipantsInlineEditor } from '@/components/meetings/ParticipantsInlineEditor';
import { StageDraftCard } from '@/components/grareco/StageDraftCard';
import { AutoGrarecoSettingsCard } from '@/components/grareco/AutoGrarecoSettingsCard';
import { useServerFeatures } from '@/hooks/useServerFeatures';
import { useSiteConfig } from '@/hooks/useSiteConfig';
import type { ResearchSettings } from '@/hooks/useResearchSettings';
import {
  parseSummarySections,
  type SummarySection,
} from '@/lib/parseSummarySections';
import type { Meeting, StructuredSummary, Participant, DetectedTerm, MeetingImage, MeetingMemo, MeetingObservation } from 'shared';
import type { Socket } from 'socket.io-client';
import { safeHref } from '@/lib/safeHref';

let evalAllowed: boolean | null = null;
function canUseEval(): boolean {
  if (evalAllowed === null) {
    try {
      // eslint-disable-next-line no-new-func, @typescript-eslint/no-implied-eval
      new Function('return 1')();
      evalAllowed = true;
    } catch {
      evalAllowed = false;
    }
  }
  return evalAllowed;
}

export default function MeetingDetailPageV2() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const roomObservationEnabled = Boolean((user as { roomObservationEnabled?: boolean } | null | undefined)?.roomObservationEnabled);
  const features = useServerFeatures();
  const { appName } = useSiteConfig();
  const { toast } = useToast();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const meetingId = parseInt(id || '0');

  const { data: meeting } = useQuery<Meeting>({
    queryKey: ['/api/meetings', meetingId],
    queryFn: () => apiRequest('GET', `/api/meetings/${meetingId}`).then((r) => r.json()),
    enabled: !!user && meetingId > 0,
    refetchInterval: (query) => {
      const data = query.state.data as Meeting | undefined;
      return data?.status === 'active' || data?.status === 'paused' ? 5000 : 30000;
    },
  });

  const isLive = meeting?.status === 'active';
  const { socketRef: viewerSocketRef, ready: viewerSocketReady } = useViewerSocket(
    !!user && meetingId > 0,
  );
  useSessionHeartbeat(
    !!user && meetingId > 0,
    meeting?.status === 'active' || meeting?.status === 'paused',
  );
  const { settings: researchSettings, update: updateResearchSettings } = useResearchSettings(
    viewerSocketRef,
    viewerSocketReady,
  );
  const { cards: researchCards } = useResearchInsights(
    meetingId,
    isLive,
    viewerSocketRef,
    meeting?.status,
    viewerSocketReady,
  );
  const termGlossary = useTermGlossary(
    meetingId,
    false,
    viewerSocketRef,
    isLive,
    viewerSocketReady,
  );
  const [bulkPromoting, setBulkPromoting] = useState(false);
  const handleBulkDone = useCallback((promoted: number, remaining: number) => {
    setBulkPromoting(false);
    if (promoted > 0) toast({ title: `${promoted}件を画像化しました` });
    if (remaining > 0) {
      toast({
        title: `${remaining}件は生成に失敗しました`,
        description: '時間をおいて、もう一度「まとめて画像化」をお試しください。',
        variant: 'destructive',
      });
    }
  }, [toast]);

  const {
    items: grarecoItemsAll,
    isLoading: grarecoLoading,
    dismissItem: dismissGrareco,
    markPromoting,
    clearAllPromoting,
    markPinned,
  } = useGrarecoFeed(
    meetingId,
    viewerSocketRef,
    viewerSocketReady,
    undefined,
    undefined,
    handleBulkDone,
  );
  const grarecoItems = useMemo(
    () => grarecoItemsAll.filter((i) => i.triggerType?.startsWith('auto_')),
    [grarecoItemsAll],
  );
  const grarecoPendingCount = useMemo(
    () => grarecoItemsAll.filter((i) => !i.imageUrl && !i.isPromoting).length,
    [grarecoItemsAll],
  );
  useEffect(() => {
    if (!bulkPromoting) clearAllPromoting();
  }, [bulkPromoting, clearAllPromoting]);
  const agentEnabled = useAgentAvailability();

  const { data: summary } = useQuery<StructuredSummary | null>({
    queryKey: ['/api/meetings', meetingId, 'structured-summary'],
    queryFn: () => apiRequest('GET', `/api/summaries/${meetingId}`).then((r) => r.json()),
    enabled: meetingId > 0,
    refetchInterval: isLive ? 10000 : false,
  });

  const summaryStats = useMemo(() => summarizeStats(summary?.content), [summary?.content]);

  const { data: transcripts = [] } = useQuery<
    Array<{ id: number; speaker: string | null; content: string; startTime: number; ngExcluded?: boolean }>
  >({
    queryKey: ['/api/meetings', meetingId, 'transcripts'],
    queryFn: () =>
      apiRequest('GET', `/api/meetings/${meetingId}/transcripts`).then((r) => r.json()),
    enabled: meetingId > 0,
    refetchInterval: isLive ? 10000 : false,
  });

  const visibleTranscripts = useMemo(
    () => transcripts.filter((t) => !t.ngExcluded),
    [transcripts],
  );

  const { data: meetingImages = [] } = useQuery<MeetingImage[]>({
    queryKey: ['/api/meetings', meetingId, 'images'],
    queryFn: () => apiRequest('GET', `/api/meetings/${meetingId}/images`).then((r) => r.json()),
    enabled: meetingId > 0,
    refetchInterval: (query) => {
      const images = query.state.data;
      if (images && images.some((img) => !img.aiAnalysis)) return 5000;
      return false;
    },
  });
  const { data: meetingMemos = [] } = useQuery<MeetingMemo[]>({
    queryKey: ['/api/meetings', meetingId, 'memos'],
    queryFn: () => apiRequest('GET', `/api/meetings/${meetingId}/memos`).then((r) => r.json()),
    enabled: meetingId > 0,
  });

  const { data: meetingObservations = [] } = useQuery<MeetingObservation[]>({
    queryKey: ['/api/meetings', meetingId, 'observations'],
    queryFn: () => apiRequest('GET', `/api/meetings/${meetingId}/observations`).then((r) => r.json()),
    enabled: meetingId > 0 && roomObservationEnabled,
    refetchInterval: () => (meeting?.status === 'active' || meeting?.status === 'paused' ? 20000 : false),
    placeholderData: keepPreviousData,
  });

  const [summaryDetailOpen, setSummaryDetailOpen] = useState(false);
  const [researchDialog, setResearchDialog] = useState<ResearchCard | null>(null);
  const [grarecoDialog, setGrarecoDialog] = useState<GrarecoFeedItem | null>(null);
  const [grarecoFullscreen, setGrarecoFullscreen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const shareControl = useShareControls(meetingId);

  const [liveStripExpanded, setLiveStripExpanded] = useState(true);

  const [supplementOpen, setSupplementOpen] = useState(false);
  const [observationOpen, setObservationOpen] = useState(false);
  const [uploadingCount, setUploadingCount] = useState(0);
  const [isDraggingImage, setIsDraggingImage] = useState(false);
  const [expandedImageId, setExpandedImageId] = useState<number | null>(null);
  const [newMemoText, setNewMemoText] = useState('');
  const [editingMemoId, setEditingMemoId] = useState<number | null>(null);
  const [editingMemoText, setEditingMemoText] = useState('');
  const supplementImageInputRef = useRef<HTMLInputElement>(null);

  const [participantText, setParticipantText] = useState('');
  const [isDraggingParticipantImage, setIsDraggingParticipantImage] = useState(false);
  const [participantImageUploadingCount, setParticipantImageUploadingCount] = useState(0);
  const participantImageInputRef = useRef<HTMLInputElement>(null);

  const [participantsOpen, setParticipantsOpen] = useState(false);
  const [grarecoOpen, setGrarecoOpen] = useState(false);
  const [researchOpen, setResearchOpen] = useState(false);
  const [termsVisible, setTermsVisible] = useState(false);

  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const titleInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleHash = () => {
      const hash = window.location.hash.replace(/^#/, '').toLowerCase();
      if (!hash) return;
      requestAnimationFrame(() => {
        switch (hash) {
          case 'assistant':
            setChatOpen(true);
            break;
          case 'supplementary':
            setSupplementOpen(true);
            setTimeout(() => {
              document
                .querySelector('[data-section="supplementary"]')
                ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }, 50);
            break;
          case 'research':
            setResearchOpen(true);
            setTimeout(() => {
              document
                .querySelector('[data-section="research"]')
                ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }, 50);
            break;
          case 'grareco':
            setGrarecoOpen(true);
            setTimeout(() => {
              document
                .querySelector('[data-section="grareco"]')
                ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }, 50);
            break;
          case 'summary':
            setSummaryDetailOpen(true);
            setTimeout(() => {
              document
                .querySelector('[data-section="summary"]')
                ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }, 50);
            break;
        }
      });
    };
    handleHash();
    window.addEventListener('hashchange', handleHash);
    return () => window.removeEventListener('hashchange', handleHash);
  }, []);
  const [termsCollapsed, setTermsCollapsed] = useState(false);

  const [selectedSections, setSelectedSections] = useState<Set<number>>(new Set());
  const summarySections = useMemo<SummarySection[]>(() => {
    if (!summary?.content) return [];
    return parseSummarySections(summary.content);
  }, [summary?.content]);

  const [researchSelectMode, setResearchSelectMode] = useState(false);
  const [selectedResearchIds, setSelectedResearchIds] = useState<Set<string>>(new Set());
  const toggleResearchSelected = useCallback((id: string) => {
    setSelectedResearchIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const [manualResearchSubmitting, setManualResearchSubmitting] = useState(false);
  const manualResearchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [summaryActionSubmitting, setSummaryActionSubmitting] = useState(false);
  const [summaryActionKind, setSummaryActionKind] = useState<'reflect' | 'discover' | 'rebuild' | null>(null);

  const toggleSection = useCallback((idx: number) => {
    setSelectedSections((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }, []);

  const handleCopyAll = useCallback(async () => {
    const summaryText = summary?.content ?? '';
    const transcriptText = visibleTranscripts
      .map((t) => `[${formatHrMinSec(t.startTime)}]${t.speaker ? ` ${t.speaker}:` : ''} ${t.content}`)
      .join('\n');
    const parts: string[] = [];
    if (summaryText) parts.push(`【サマリー】\n${summaryText}`);
    if (transcriptText) parts.push(`【文字起こし（全体）】\n${transcriptText}`);
    const combined = parts.join('\n\n');
    await copyTextToClipboard(combined, 'サマリー + 文字起こし全体', toast);
  }, [summary?.content, visibleTranscripts, toast]);

  const handleCopySelected = useCallback(async () => {
    if (selectedSections.size === 0) {
      toast({ title: 'セクションが選択されていません', variant: 'destructive' });
      return;
    }
    const items = Array.from(selectedSections)
      .sort((a, b) => a - b)
      .map((i) => summarySections[i])
      .filter(Boolean);
    const selectedSummaryTexts = items.map((s) => s.fullText).join('\n\n');

    const hasAnyTimeRange = items.some((s) => s.startMs !== null && s.endMs !== null);
    const relevantTranscripts = hasAnyTimeRange
      ? visibleTranscripts.filter((t) =>
          items.some(
            (s) =>
              s.startMs !== null &&
              s.endMs !== null &&
              t.startTime >= s.startMs &&
              t.startTime <= s.endMs,
          ),
        )
      : visibleTranscripts;
    const transcriptText = relevantTranscripts
      .map((t) => `[${formatHrMinSec(t.startTime)}]${t.speaker ? ` ${t.speaker}:` : ''} ${t.content}`)
      .join('\n');
    const transcriptLabel = relevantTranscripts.length < visibleTranscripts.length ? '該当部分' : '全体';
    const combined = `【サマリー（選択部分）】\n${selectedSummaryTexts}\n\n【文字起こし（${transcriptLabel}）】\n${transcriptText}`;
    await copyTextToClipboard(combined, `選択 ${items.length}件 + 文字起こし${transcriptLabel}`, toast);
  }, [selectedSections, summarySections, visibleTranscripts, toast]);

  const handleReflect = useCallback(async () => {
    if (summaryActionSubmitting) return;
    setSummaryActionSubmitting(true);
    setSummaryActionKind('reflect');
    try {
      await apiRequest('POST', `/api/meetings/${meetingId}/grareco/manual-trigger`, {
        type: 'reflect',
      });
      toast({ title: '🎨 リフレクト型グラレコを開始しました' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : '不明';
      toast({ title: 'リフレクト失敗', description: msg, variant: 'destructive' });
    } finally {
      setSummaryActionSubmitting(false);
      setSummaryActionKind(null);
    }
  }, [meetingId, toast, summaryActionSubmitting]);

  const handleDiscover = useCallback(async () => {
    if (summaryActionSubmitting) return;
    setSummaryActionSubmitting(true);
    setSummaryActionKind('discover');
    try {
      await apiRequest('POST', `/api/meetings/${meetingId}/grareco/manual-trigger`, {
        type: 'discover',
      });
      toast({ title: '🎨 ディスカバー型グラレコを開始しました' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : '不明';
      toast({ title: 'ディスカバー失敗', description: msg, variant: 'destructive' });
    } finally {
      setSummaryActionSubmitting(false);
      setSummaryActionKind(null);
    }
  }, [meetingId, toast, summaryActionSubmitting]);

  const handleRegenerateSummary = useCallback(async () => {
    if (summaryActionSubmitting) return;
    const ok = await confirm({
      title: 'サマリーを再構築しますか？',
      description:
        '現在のサマリーを破棄し、全文字起こし（NGワード該当行を除く）からゼロから作り直します。',
      confirmText: '再構築する',
      destructive: true,
    });
    if (!ok) return;
    setSummaryActionSubmitting(true);
    setSummaryActionKind('rebuild');
    try {
      await apiRequest('POST', `/api/meetings/${meetingId}/rebuild-summary`, {});
      toast({ title: '🔄 サマリーを再構築しました' });
      queryClient.invalidateQueries({ queryKey: ['/api/meetings', meetingId, 'structured-summary'] });
    } catch (err) {
      const msg = err instanceof Error ? err.message : '不明';
      toast({ title: 'サマリー再構築失敗', description: msg, variant: 'destructive' });
    } finally {
      setSummaryActionSubmitting(false);
      setSummaryActionKind(null);
    }
  }, [meetingId, queryClient, toast, confirm, summaryActionSubmitting]);

  const handleShowGrarecoFromAgent = useCallback(
    (recordingId: number) => {
      const found = grarecoItemsAll.find((i) => i.recordingId === recordingId);
      const item: GrarecoFeedItem =
        found ??
        ({
          recordingId,
          triggerType: 'auto_meeting_end',
          draft: null,
          receivedAt: Date.now(),
          willAutoPromote: false,
          cancelDeadlineMs: 0,
          imageUrl: `/api/meetings/${meetingId}/grareco/${recordingId}/image`,
          pinned: false,
          isPromoting: false,
        } as unknown as GrarecoFeedItem);
      setGrarecoOpen(true);
      setGrarecoFullscreen(false);
      setGrarecoDialog(item);
      document
        .querySelector('[data-section="grareco"]')
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
    [grarecoItemsAll, meetingId],
  );

  const handleManualResearch = useCallback(async () => {
    if (selectedSections.size === 0) {
      toast({ title: 'セクションを選択してください', variant: 'destructive' });
      return;
    }
    const items = Array.from(selectedSections)
      .sort((a, b) => a - b)
      .map((i) => summarySections[i])
      .filter(Boolean);
    if (items.length > 5) {
      toast({ title: 'セクションは最大 5 つまで', variant: 'destructive' });
      return;
    }
    if (!window.confirm(`選択中の ${items.length} セクションをリアルタイム調査で再分析します。実行しますか？`))
      return;
    setManualResearchSubmitting(true);
    if (manualResearchTimeoutRef.current) clearTimeout(manualResearchTimeoutRef.current);
    manualResearchTimeoutRef.current = setTimeout(() => {
      setManualResearchSubmitting(false);
      toast({
        title: 'リサーチの結果通知が届きませんでした',
        description: 'リアルタイム調査の欄をご確認ください',
        variant: 'destructive',
      });
    }, 30 * 60 * 1000);
    try {
      const res = await fetch(`/api/meetings/${meetingId}/manual-research`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          summarySections: items.map((s) => ({
            heading: s.heading,
            fullText: s.fullText,
            startMs: s.startMs,
            endMs: s.endMs,
          })),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setManualResearchSubmitting(false);
        if (manualResearchTimeoutRef.current) {
          clearTimeout(manualResearchTimeoutRef.current);
          manualResearchTimeoutRef.current = null;
        }
        toast({
          title: data?.message || 'リサーチの開始に失敗',
          variant: 'destructive',
        });
      }
    } catch (err) {
      setManualResearchSubmitting(false);
      if (manualResearchTimeoutRef.current) {
        clearTimeout(manualResearchTimeoutRef.current);
        manualResearchTimeoutRef.current = null;
      }
      toast({
        title: 'ネットワークエラー',
        description: err instanceof Error ? err.message : String(err),
        variant: 'destructive',
      });
    }
  }, [selectedSections, summarySections, meetingId, toast]);

  const [selectionGrarecoSubmitting, setSelectionGrarecoSubmitting] = useState(false);
  const handleGenerateGrarecoFromSelection = useCallback(async () => {
    if (selectedSections.size === 0) {
      toast({ title: 'セクションが選択されていません', variant: 'destructive' });
      return;
    }
    const items = Array.from(selectedSections)
      .sort((a, b) => a - b)
      .map((i) => summarySections[i])
      .filter(Boolean);
    const selectedSummaryTexts = items.map((s) => s.fullText).join('\n\n');
    const hasAnyTimeRange = items.some((s) => s.startMs !== null && s.endMs !== null);
    const relevantTranscripts = hasAnyTimeRange
      ? visibleTranscripts.filter((t) =>
          items.some(
            (s) =>
              s.startMs !== null &&
              s.endMs !== null &&
              t.startTime >= s.startMs &&
              t.startTime <= s.endMs,
          ),
        )
      : visibleTranscripts;
    const transcriptText = relevantTranscripts
      .map((t) => `[${formatHrMinSec(t.startTime)}]${t.speaker ? ` ${t.speaker}:` : ''} ${t.content}`)
      .join('\n');
    const transcriptLabel = relevantTranscripts.length < visibleTranscripts.length ? '該当部分' : '全体';
    const content = `【サマリー（選択部分）】\n${selectedSummaryTexts}\n\n【文字起こし（${transcriptLabel}）】\n${transcriptText}`;
    if (!window.confirm(`選択中の ${items.length} セクションからグラレコを生成します。実行しますか？`))
      return;
    setSelectionGrarecoSubmitting(true);
    try {
      await apiRequest('POST', `/api/meetings/${meetingId}/analyze`, {
        type: 'grareco',
        content,
      });
      toast({ title: 'グラレコ生成を開始しました' });
      queryClient.invalidateQueries({
        queryKey: ['/api/meetings', meetingId, 'graphic-recordings'],
      });
    } catch (err) {
      toast({
        title: 'グラレコ生成に失敗',
        description: err instanceof Error ? err.message : 'エラー',
        variant: 'destructive',
      });
    } finally {
      setSelectionGrarecoSubmitting(false);
    }
  }, [selectedSections, summarySections, visibleTranscripts, meetingId, queryClient, toast]);

  const handleGrarecoPromote = useCallback(
    async (recordingId: number) => {
      markPromoting(recordingId, true);
      try {
        await api.meetings.promoteGrarecoNow(meetingId, recordingId);
      } catch (err) {
        markPromoting(recordingId, false);
        toast({
          title: '画像化に失敗しました',
          description: err instanceof Error ? err.message : 'エラー',
          variant: 'destructive',
        });
      }
    },
    [meetingId, markPromoting, toast],
  );

  const startBulkPromote = useCallback(async () => {
    setBulkPromoting(true);
    grarecoItemsAll
      .filter((i) => !i.imageUrl)
      .forEach((i) => markPromoting(i.recordingId, true));
    try {
      await api.meetings.promoteGrarecoPending(meetingId);
      toast({ title: '画像化を開始しました', description: 'できたものから順に表示されます。' });
    } catch (err) {
      setBulkPromoting(false);
      toast({
        title: '一括画像化に失敗しました',
        description: err instanceof Error ? err.message : 'エラー',
        variant: 'destructive',
      });
    }
  }, [meetingId, grarecoItemsAll, markPromoting, toast]);

  const handleBulkPromote = useCallback(() => {
    if (grarecoPendingCount <= 0) return;
    void startBulkPromote();
  }, [grarecoPendingCount, startBulkPromote]);

  const handleGrarecoCancelPromote = useCallback(
    async (recordingId: number) => {
      try {
        await api.meetings.cancelGrarecoPromote(meetingId, recordingId);
        toast({ title: '画像化をキャンセルしました' });
      } catch (err) {
        toast({
          title: 'キャンセルに失敗しました',
          description: err instanceof Error ? err.message : 'エラー',
          variant: 'destructive',
        });
      }
    },
    [meetingId, toast],
  );

  const handleGrarecoPin = useCallback(
    async (recordingId: number) => {
      const item = grarecoItems.find((i) => i.recordingId === recordingId);
      const newPinned = !(item?.pinned ?? false);
      markPinned(recordingId, newPinned);
      try {
        await api.meetings.pinGrareco(meetingId, recordingId, newPinned);
      } catch (err) {
        markPinned(recordingId, !newPinned);
        toast({
          title: 'ピン留めに失敗しました',
          description: err instanceof Error ? err.message : 'エラー',
          variant: 'destructive',
        });
      }
    },
    [meetingId, grarecoItems, markPinned, toast],
  );

  const handleJumpToResearchInsight = useCallback(
    (insightId: number) => {
      const card = researchCards.find((c) => String(c.id) === String(insightId));
      if (card) {
        setGrarecoDialog(null);
        setResearchDialog(card);
      } else {
        toast({ title: '該当する調査カードが見つかりません', variant: 'destructive' });
      }
    },
    [researchCards, toast],
  );

  const ngKeywords = useMemo(
    () => (Array.isArray(meeting?.ngKeywords) ? meeting.ngKeywords : []),
    [meeting?.ngKeywords],
  );

  const handleSaveNgKeywords = useCallback(
    async (keywords: string[]) => {
      try {
        await apiRequest('PUT', `/api/meetings/${meetingId}/ng-keywords`, { keywords });
        toast({ title: 'NGワードを更新しました' });
        queryClient.invalidateQueries({ queryKey: ['/api/meetings', meetingId] });
        queryClient.invalidateQueries({ queryKey: ['/api/meetings', meetingId, 'transcripts'] });
      } catch (err) {
        const msg = err instanceof Error ? err.message : '不明';
        toast({ title: 'NGワード更新に失敗', description: msg, variant: 'destructive' });
        throw err;
      }
    },
    [meetingId, queryClient, toast],
  );

  const handleCopyTranscript = useCallback(async () => {
    const text = visibleTranscripts
      .map((t) => `[${formatHrMinSec(t.startTime)}]${t.speaker ? ` ${t.speaker}:` : ''} ${t.content}`)
      .join('\n');
    await copyTextToClipboard(text, '文字起こし全文', toast);
  }, [visibleTranscripts, toast]);

  const handleToggleResearchSubAgent = useCallback(
    async (key: 'main' | 'web' | 'fact' | 'gap' | 'tech') => {
      if (!researchSettings) return;
      const newValue = !researchSettings[key];
      try {
        await updateResearchSettings({ [key]: newValue });
      } catch (err) {
        toast({
          title: '設定更新に失敗',
          description: err instanceof Error ? err.message : 'エラー',
          variant: 'destructive',
        });
      }
    },
    [researchSettings, updateResearchSettings, toast],
  );

  const handleCopyAllResearch = useCallback(async () => {
    const targets = researchCards;
    if (targets.length === 0) {
      toast({ title: 'コピーする調査カードがありません', variant: 'destructive' });
      return;
    }
    const text = targets.map(formatResearchCardForCopy).join('\n\n---\n\n');
    await copyTextToClipboard(text, `調査カード 全 ${targets.length}件`, toast);
  }, [researchCards, toast]);

  const handleCopySelectedResearch = useCallback(async () => {
    const targets = researchCards.filter((c) => selectedResearchIds.has(c.id));
    if (targets.length === 0) {
      toast({ title: '調査カードが選択されていません', variant: 'destructive' });
      return;
    }
    const text = targets.map(formatResearchCardForCopy).join('\n\n---\n\n');
    await copyTextToClipboard(text, `調査カード 選択 ${targets.length}件`, toast);
  }, [researchCards, selectedResearchIds, toast]);

  const forceStopMutation = useMutation({
    mutationFn: async (mId: number) => {
      const res = await apiRequest('PATCH', `/api/meetings/${mId}/stop`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/meetings'] });
      queryClient.invalidateQueries({ queryKey: ['/api/meetings', meetingId] });
      toast({ title: '会議を終了しました' });
    },
    onError: (err) => {
      const msg = err instanceof Error ? err.message : '不明';
      toast({ title: '終了に失敗しました', description: msg, variant: 'destructive' });
    },
  });

  const convertHeicToJpeg = useCallback(async (file: File): Promise<File> => {
    const isHeic =
      file.type === 'image/heic' ||
      file.type === 'image/heif' ||
      /\.heic$/i.test(file.name) ||
      /\.heif$/i.test(file.name);
    if (!isHeic) return file;
    if (!canUseEval()) {
      console.warn('[HEIC変換] CSP で eval が止められているため、元ファイルのまま送信');
      return file;
    }
    try {
      const { default: heic2any } = await import('heic2any');
      const converted = heic2any({ blob: file, toType: 'image/jpeg', quality: 0.85 });
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('HEIC変換がタイムアウトしました（30秒）')), 30_000),
      );
      const blob = await Promise.race([converted, timeout]);
      const resultBlob = Array.isArray(blob) ? blob[0] : blob;
      const newName = file.name.replace(/\.heic$/i, '.jpg').replace(/\.heif$/i, '.jpg');
      return new File([resultBlob], newName, { type: 'image/jpeg' });
    } catch (err) {
      console.warn('[HEIC変換] 変換失敗、元ファイルのまま送信:', err);
      return file;
    }
  }, []);

  const fileToBase64 = useCallback((file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve((e.target?.result as string).split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }, []);

  const uploadSingleImage = useCallback(
    async (file: File) => {
      const processedFile = await convertHeicToJpeg(file);
      const wasConverted = processedFile !== file;
      const base64 = await fileToBase64(processedFile);
      let originalData: string | undefined;
      let originalMimeType: string | undefined;
      if (wasConverted) {
        originalData = await fileToBase64(file);
        originalMimeType = file.type || 'image/heic';
      }
      return apiRequest('POST', `/api/meetings/${meetingId}/images`, {
        data: base64,
        mimeType: processedFile.type,
        fileName: processedFile.name,
        originalData,
        originalMimeType,
      }).then((r) => r.json());
    },
    [meetingId, convertHeicToJpeg, fileToBase64],
  );

  const handleUploadImages = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      const hasHeic = files.some(
        (f) => f.type === 'image/heic' || f.type === 'image/heif' || /\.(heic|heif)$/i.test(f.name),
      );
      if (hasHeic) toast({ title: 'HEIC画像を変換中...' });
      setUploadingCount((c) => c + files.length);
      const results = await Promise.allSettled(files.map((f) => uploadSingleImage(f)));
      setUploadingCount((c) => c - files.length);
      const succeeded = results.filter((r) => r.status === 'fulfilled').length;
      const failed = results.filter((r) => r.status === 'rejected').length;
      queryClient.invalidateQueries({ queryKey: ['/api/meetings', meetingId, 'images'] });
      if (succeeded > 0) toast({ title: `${succeeded}枚の画像をアップロードしました` });
      if (failed > 0) toast({ title: `${failed}枚のアップロードに失敗しました`, variant: 'destructive' });
    },
    [uploadSingleImage, meetingId, toast, queryClient],
  );

  const handleSupplementImageDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDraggingImage(false);
      const files = Array.from(e.dataTransfer.files).filter(
        (f) => f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name),
      );
      if (files.length > 0) handleUploadImages(files);
    },
    [handleUploadImages],
  );

  const handleSupplementImagePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = Array.from(e.clipboardData.items);
      const imageFiles = items
        .filter((item) => item.type.startsWith('image/'))
        .map((item) => item.getAsFile())
        .filter((f): f is File => f !== null);
      if (imageFiles.length > 0) {
        e.preventDefault();
        handleUploadImages(imageFiles);
      }
    },
    [handleUploadImages],
  );

  const deleteImageMutation = useMutation({
    mutationFn: async ({ imgId, removeSummarySection }: { imgId: number; removeSummarySection: boolean }) =>
      apiRequest(
        'DELETE',
        `/api/meetings/${meetingId}/images/${imgId}?removeSummarySection=${removeSummarySection}`,
      ),
    onSuccess: (_data, { removeSummarySection }) => {
      queryClient.invalidateQueries({ queryKey: ['/api/meetings', meetingId, 'images'] });
      if (removeSummarySection) {
        queryClient.invalidateQueries({ queryKey: ['/api/meetings', meetingId, 'structured-summary'] });
      }
      toast({ title: '画像を削除しました' });
    },
  });

  const deleteObservationMutation = useMutation({
    mutationFn: async (obsId: number) =>
      apiRequest('DELETE', `/api/meetings/${meetingId}/observations/${obsId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/meetings', meetingId, 'observations'] });
      queryClient.invalidateQueries({ queryKey: ['/api/meetings', meetingId, 'images'] });
      queryClient.invalidateQueries({ queryKey: ['/api/meetings', meetingId, 'structured-summary'] });
      toast({ title: '環境観察を削除しました（紐づく補足資料・サマリー項目も削除）' });
    },
    onError: (err) => {
      toast({ title: '削除に失敗しました', description: err instanceof Error ? err.message : '不明', variant: 'destructive' });
    },
  });

  const { data: participantImagesData = [] } = useQuery<any[]>({
    queryKey: ['/api/meetings', meetingId, 'participant-images'],
    queryFn: () =>
      apiRequest('GET', `/api/meetings/${meetingId}/participant-images`).then((r) => r.json()),
    enabled: !!user && meetingId > 0,
    refetchInterval: (query) => {
      const data = query.state.data as any[] | undefined;
      return data?.some((img: any) => img.aiExtractedParticipants === null) ? 3000 : false;
    },
  });

  const { data: participantTextsData = [] } = useQuery<any[]>({
    queryKey: ['/api/meetings', meetingId, 'participant-texts'],
    queryFn: () =>
      apiRequest('GET', `/api/meetings/${meetingId}/participant-texts`).then((r) => r.json()),
    enabled: !!user && meetingId > 0,
    refetchInterval: (query) => {
      const data = query.state.data as any[] | undefined;
      return data?.some((t: any) => t.aiExtractedParticipants === null) ? 3000 : false;
    },
  });

  useEffect(() => {
    const allDone = [...participantImagesData, ...participantTextsData].every(
      (item: any) => item.aiExtractedParticipants !== null,
    );
    if (allDone && (participantImagesData.length > 0 || participantTextsData.length > 0)) {
      queryClient.invalidateQueries({ queryKey: ['/api/meetings', meetingId] });
    }
  }, [participantImagesData, participantTextsData, meetingId, queryClient]);

  const uploadParticipantImageMutation = useMutation({
    mutationFn: async (file: File) => {
      const processedFile = await convertHeicToJpeg(file);
      const base64 = await fileToBase64(processedFile);
      return apiRequest('POST', `/api/meetings/${meetingId}/participant-images`, {
        data: base64,
        mimeType: processedFile.type,
        fileName: processedFile.name,
      }).then((r) => r.json());
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['/api/meetings', meetingId, 'participant-images'],
      });
    },
  });

  const handleUploadParticipantImages = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      setParticipantImageUploadingCount((c) => c + files.length);
      const results = await Promise.allSettled(
        files.map((f) => uploadParticipantImageMutation.mutateAsync(f)),
      );
      setParticipantImageUploadingCount((c) => c - files.length);
      const succeeded = results.filter((r) => r.status === 'fulfilled').length;
      const failed = results.filter((r) => r.status === 'rejected').length;
      if (succeeded > 0) toast({ title: `${succeeded}枚の参加者画像をアップロードしました` });
      if (failed > 0)
        toast({
          title: `${failed}枚の画像のアップロードに失敗しました`,
          variant: 'destructive',
        });
    },
    [uploadParticipantImageMutation, toast],
  );

  const handleParticipantImageDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDraggingParticipantImage(false);
      const files = Array.from(e.dataTransfer.files).filter(
        (f) => f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name),
      );
      if (files.length > 0) handleUploadParticipantImages(files);
    },
    [handleUploadParticipantImages],
  );

  const handleParticipantImagePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = Array.from(e.clipboardData.items);
      const imageFiles = items
        .filter((item) => item.type.startsWith('image/'))
        .map((item) => item.getAsFile())
        .filter((f): f is File => f !== null);
      if (imageFiles.length > 0) {
        e.preventDefault();
        handleUploadParticipantImages(imageFiles);
      }
    },
    [handleUploadParticipantImages],
  );

  const deleteParticipantImageMutation = useMutation({
    mutationFn: async (imageId: number) =>
      apiRequest('DELETE', `/api/meetings/${meetingId}/participant-images/${imageId}`).then((r) =>
        r.json(),
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['/api/meetings', meetingId, 'participant-images'],
      });
      queryClient.invalidateQueries({ queryKey: ['/api/meetings', meetingId] });
    },
  });

  const addParticipantTextMutation = useMutation({
    mutationFn: async (content: string) =>
      apiRequest('POST', `/api/meetings/${meetingId}/participant-texts`, { content }).then((r) =>
        r.json(),
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['/api/meetings', meetingId, 'participant-texts'],
      });
      setParticipantText('');
      toast({ title: '参加者テキストを保存しました' });
    },
  });

  const deleteParticipantTextMutation = useMutation({
    mutationFn: async (textId: number) =>
      apiRequest('DELETE', `/api/meetings/${meetingId}/participant-texts/${textId}`).then((r) =>
        r.json(),
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['/api/meetings', meetingId, 'participant-texts'],
      });
      queryClient.invalidateQueries({ queryKey: ['/api/meetings', meetingId] });
    },
  });

  const titleMutation = useMutation({
    mutationFn: async (newTitle: string) =>
      apiRequest('PATCH', `/api/meetings/${meetingId}`, { title: newTitle }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/meetings', meetingId] });
      queryClient.invalidateQueries({ queryKey: ['/api/meetings'] });
      setIsEditingTitle(false);
      toast({ title: '会議名を更新しました' });
    },
    onError: (error) => {
      toast({
        title: '会議名の更新に失敗しました',
        description: error instanceof Error ? error.message : 'エラーが発生しました',
        variant: 'destructive',
      });
    },
  });

  const handleStartEditTitle = useCallback(() => {
    if (meeting) {
      setEditTitle(meeting.title ?? '');
      setIsEditingTitle(true);
      setTimeout(() => titleInputRef.current?.focus(), 50);
    }
  }, [meeting]);

  const handleSaveTitle = useCallback(() => {
    const trimmed = editTitle.trim();
    if (!trimmed) {
      toast({ title: '会議名を入力してください', variant: 'destructive' });
      return;
    }
    if (trimmed === meeting?.title) {
      setIsEditingTitle(false);
      return;
    }
    titleMutation.mutate(trimmed);
  }, [editTitle, meeting?.title, titleMutation, toast]);

  const handleCancelEditTitle = useCallback(() => {
    setIsEditingTitle(false);
    setEditTitle('');
  }, []);
  const addMemoMutation = useMutation({
    mutationFn: async (content: string) =>
      apiRequest('POST', `/api/meetings/${meetingId}/memos`, { content }).then((r) => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/meetings', meetingId, 'memos'] });
      setNewMemoText('');
      toast({ title: 'メモを追加しました' });
    },
  });
  const updateMemoMutation = useMutation({
    mutationFn: async ({ memoId, content }: { memoId: number; content: string }) =>
      apiRequest('PATCH', `/api/meetings/${meetingId}/memos/${memoId}`, { content }).then((r) =>
        r.json(),
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/meetings', meetingId, 'memos'] });
      setEditingMemoId(null);
      toast({ title: 'メモを更新しました' });
    },
  });
  const deleteMemoMutation = useMutation({
    mutationFn: async (memoId: number) =>
      apiRequest('DELETE', `/api/meetings/${meetingId}/memos/${memoId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/meetings', meetingId, 'memos'] });
      toast({ title: 'メモを削除しました' });
    },
  });

  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (meeting?.status !== 'active') return;
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [meeting?.status]);

  const elapsedText = useMemo(() => {
    if (!meeting || !meeting.transcriptionStartedAt) return '0:00';
    const startMs = new Date(meeting.transcriptionStartedAt).getTime();
    const refMs = meeting.status === 'completed' && meeting.endedAt
      ? new Date(meeting.endedAt).getTime()
      : nowTick;
    const grossSec = Math.max(0, Math.floor((refMs - startMs) / 1000));
    const pausedSec = meeting.pausedSeconds ?? 0;
    const openPauseSec = meeting.status === 'paused' && meeting.pausedSince
      ? Math.max(0, Math.floor((refMs - new Date(meeting.pausedSince).getTime()) / 1000))
      : 0;
    const recorded = Math.max(0, grossSec - pausedSec - openPauseSec);
    const m = Math.floor(recorded / 60);
    const s = recorded % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }, [meeting, nowTick]);

  const participants = useMemo<Participant[]>(() => {
    if (!meeting) return [];
    return Array.isArray(meeting.participants) ? (meeting.participants as Participant[]) : [];
  }, [meeting]);

  if (!meeting && meetingId > 0) {
    return (
      <div className="min-h-screen flex items-center justify-center text-muted-foreground">
        読み込み中…
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-white dark:bg-slate-950">
      <header className="sticky top-0 z-30 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800">
        <div className="max-w-7xl mx-auto px-3 sm:px-6 py-3 sm:py-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            <Link href="/">
              <Button variant="ghost" size="icon" aria-label="戻る" className="shrink-0">
                <ArrowLeft className="w-5 h-5" />
              </Button>
            </Link>
            <div className="min-w-0 flex-1">
              <div className="text-[10px] sm:text-xs text-muted-foreground">{appName} · 会議詳細</div>
              {isEditingTitle ? (
                <div className="flex items-center gap-1.5">
                  <input
                    ref={titleInputRef}
                    type="text"
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        handleSaveTitle();
                      } else if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
                        handleCancelEditTitle();
                      }
                    }}
                    onBlur={() => {
                      if (isEditingTitle) handleSaveTitle();
                    }}
                    disabled={titleMutation.isPending}
                    maxLength={200}
                    placeholder="会議名（Enter で保存・Esc でキャンセル）"
                    className="flex-1 min-w-0 text-base sm:text-lg font-semibold px-2 py-0.5 border border-slate-300 dark:border-slate-700 rounded bg-white dark:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-primary"
                  />
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={handleSaveTitle}
                    disabled={titleMutation.isPending}
                    className="h-7 w-7 shrink-0"
                    title="保存"
                  >
                    {titleMutation.isPending ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Save className="w-4 h-4" />
                    )}
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      handleCancelEditTitle();
                    }}
                    disabled={titleMutation.isPending}
                    className="h-7 w-7 shrink-0"
                    title="キャンセル"
                  >
                    <X className="w-4 h-4" />
                  </Button>
                </div>
              ) : (
                <div className="flex items-center gap-1.5 group">
                  <h1 className="text-base sm:text-lg font-semibold truncate">
                    {meeting?.title ?? '無題の会議'}
                  </h1>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={handleStartEditTitle}
                    className="h-6 w-6 shrink-0 opacity-50 group-hover:opacity-100 transition-opacity"
                    title="会議名を編集"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </Button>
                </div>
              )}
              <div className="text-[10px] sm:text-xs text-muted-foreground mt-0.5 flex items-center gap-1.5 flex-wrap">
                <span className="truncate">
                  参加者 {participants.length}名 · {meeting && formatDateTime(meeting.startedAt)} 開始
                </span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap shrink-0">
            {isLive ? (
              <span className="inline-flex items-center gap-1.5 text-xs sm:text-sm text-red-600 dark:text-red-400 font-medium">
                <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                {elapsedText}
                <span className="hidden sm:inline"> 文字起こし中</span>
              </span>
            ) : meeting && (
              <span className="text-xs sm:text-sm text-muted-foreground">
                {elapsedText} {meeting.status === 'completed' ? '完了' : meeting.status === 'paused' ? '一時停止' : '未開始'}
              </span>
            )}
            {isLive && (
              <Button
                onClick={async () => {
                  const ok = await confirm({
                    title: '会議を強制終了しますか？',
                    description:
                      '別のデバイスで文字起こし中の場合はその文字起こしも停止し、議事録メールの送信が行われます。',
                    confirmText: '強制終了する',
                    destructive: true,
                  });
                  if (ok) forceStopMutation.mutate(meetingId);
                }}
                variant="destructive"
                size="sm"
                disabled={forceStopMutation.isPending}
              >
                <StopCircle className="w-4 h-4 sm:mr-1.5" />
                <span className="hidden sm:inline">強制終了</span>
              </Button>
            )}
            {(meeting?.status === 'active' || meeting?.status === 'paused') && (
              <Button
                onClick={() => setShareOpen(true)}
                variant={shareControl.active ? 'default' : 'outline'}
                size="sm"
                title={shareControl.active ? '共有中（クリックで設定）' : 'ダッシュボードを共有'}
              >
                {shareControl.active && (
                  <span className="w-2 h-2 rounded-full bg-red-400 animate-pulse mr-1.5" />
                )}
                <Share2 className="w-4 h-4 sm:mr-1.5" />
                <span className="hidden sm:inline">{shareControl.active ? '共有中' : '共有'}</span>
              </Button>
            )}
            <AnnouncementsBell />
          </div>
        </div>
      </header>

      <ShareMeetingDialog
        meetingId={meetingId}
        isLive={meeting?.status === 'active' || meeting?.status === 'paused'}
        open={shareOpen}
        onOpenChange={setShareOpen}
      />

      {isLive && transcripts.length > 0 && (
        <LiveTranscriptStrip
          transcripts={transcripts}
          expanded={liveStripExpanded}
          onToggle={() => setLiveStripExpanded((v) => !v)}
        />
      )}

      <main className="max-w-7xl mx-auto px-3 sm:px-6 py-4 sm:py-6 space-y-4">
        <ParticipantsBlock
          open={participantsOpen}
          onToggle={() => setParticipantsOpen((v) => !v)}
          participants={participants}
          meetingId={meetingId}
          participantImages={participantImagesData}
          isDraggingParticipantImage={isDraggingParticipantImage}
          setIsDraggingParticipantImage={setIsDraggingParticipantImage}
          participantImageUploadingCount={participantImageUploadingCount}
          participantImageInputRef={participantImageInputRef}
          onUploadParticipantImages={handleUploadParticipantImages}
          onDropParticipantImage={handleParticipantImageDrop}
          onPasteParticipantImage={handleParticipantImagePaste}
          onDeleteParticipantImage={(id) => deleteParticipantImageMutation.mutate(id)}
          participantTexts={participantTextsData}
          participantText={participantText}
          setParticipantText={setParticipantText}
          onAddParticipantText={(content) => addParticipantTextMutation.mutate(content)}
          isAddingParticipantText={addParticipantTextMutation.isPending}
          onDeleteParticipantText={(id) => deleteParticipantTextMutation.mutate(id)}
        />

        <div data-section="supplementary">
        <SupplementarySection
          open={supplementOpen}
          onToggle={() => setSupplementOpen((v) => !v)}
          images={meetingImages}
          memos={meetingMemos}
          uploadingCount={uploadingCount}
          isDraggingImage={isDraggingImage}
          setIsDraggingImage={setIsDraggingImage}
          expandedImageId={expandedImageId}
          setExpandedImageId={setExpandedImageId}
          newMemoText={newMemoText}
          setNewMemoText={setNewMemoText}
          editingMemoId={editingMemoId}
          setEditingMemoId={setEditingMemoId}
          editingMemoText={editingMemoText}
          setEditingMemoText={setEditingMemoText}
          fileInputRef={supplementImageInputRef}
          onUploadFiles={handleUploadImages}
          onDrop={handleSupplementImageDrop}
          onPaste={handleSupplementImagePaste}
          onDeleteImage={(id, removeSummarySection) => deleteImageMutation.mutate({ imgId: id, removeSummarySection })}
          onAddMemo={(content) => addMemoMutation.mutate(content)}
          onUpdateMemo={(memoId, content) => updateMemoMutation.mutate({ memoId, content })}
          onDeleteMemo={(id) => deleteMemoMutation.mutate(id)}
          addingMemo={addMemoMutation.isPending}
          updatingMemo={updateMemoMutation.isPending}
        />
        </div>

        {roomObservationEnabled && (
          <div data-section="observations">
            <ObservationSection
              observations={meetingObservations}
              open={observationOpen}
              onToggle={() => setObservationOpen((v) => !v)}
              onDelete={(obsId) => deleteObservationMutation.mutate(obsId)}
            />
          </div>
        )}

        <div
          className={`grid grid-cols-1 gap-4 items-start ${
            termsCollapsed
              ? 'lg:grid-cols-[2fr_1fr]'
              : 'lg:grid-cols-[2fr_1fr_288px]'
          }`}
        >
          {features.autoGrareco && (
          <div data-section="grareco">
          <GrarecoSection
            items={grarecoItems}
            loading={grarecoLoading}
            meeting={meeting}
            isLive={isLive}
            open={grarecoOpen}
            onToggle={() => setGrarecoOpen((v) => !v)}
            onCardClick={(item) => {
              setGrarecoDialog(item);
              setGrarecoFullscreen(false);
            }}
            onCopyImage={(item) => copyGrarecoImage(item, toast)}
            autoEnabled={!!researchSettings?.autoGrareco?.enabled}
            pendingCount={grarecoPendingCount}
            onBulkPromote={handleBulkPromote}
            bulkPromoting={bulkPromoting}
            shareControl={shareControl}
          />
          </div>
          )}

          {features.research && (
          <div data-section="research">
          <ResearchSection
            cards={researchCards}
            open={researchOpen}
            onToggle={() => setResearchOpen((v) => !v)}
            selectMode={researchSelectMode}
            onToggleSelectMode={() => {
              setResearchSelectMode((v) => !v);
              if (researchSelectMode) setSelectedResearchIds(new Set());
            }}
            selectedIds={selectedResearchIds}
            onToggleSelected={toggleResearchSelected}
            onCopyAll={handleCopyAllResearch}
            onCopySelected={handleCopySelectedResearch}
            onCardClick={setResearchDialog}
            onCopyCard={(card) =>
              copyTextToClipboard(formatResearchCardForCopy(card), card.title, toast)
            }
            mainEnabled={!!researchSettings?.main}
            shareControl={shareControl}
          />
          </div>
          )}

          {!termsCollapsed && (
            <TermsSection
              terms={termGlossary.terms}
              onDismiss={termGlossary.dismissTerm}
              open={termsVisible}
              onToggle={() => setTermsVisible((v) => !v)}
              onCollapseHorizontal={() => setTermsCollapsed(true)}
              shareControl={shareControl}
            />
          )}
        </div>

        {termsCollapsed && termGlossary.terms.length > 0 && (
          <button
            type="button"
            onClick={() => setTermsCollapsed(false)}
            className="fixed right-3 top-1/3 z-40 flex flex-col items-center gap-1 px-2 py-3 rounded-l-lg shadow-md bg-purple-50 dark:bg-purple-900/40 border border-r-0 border-purple-200 dark:border-purple-800 text-purple-900 dark:text-purple-200 hover:bg-purple-100 dark:hover:bg-purple-900/60 transition-colors"
            title="用語解説を開く"
            aria-label="用語解説を開く"
          >
            <span className="text-base">📚</span>
            <span className="text-[10px] font-semibold tabular-nums">
              {termGlossary.terms.length}
            </span>
            <ChevronLeft className="w-3.5 h-3.5" />
          </button>
        )}

        <div data-section="summary">
        <SummaryBanner
          summary={summary}
          stats={summaryStats}
          sectionCount={summarySections.length}
          isLive={isLive}
          detailOpen={summaryDetailOpen}
          onToggleDetail={() => setSummaryDetailOpen((v) => !v)}
          onCopy={() => copyTextToClipboard(summary?.content ?? '', 'サマリー', toast)}
        />
        {summaryDetailOpen && summary?.content && (
          <SummaryDetailPanel
            sections={summarySections}
            selectedSections={selectedSections}
            onToggleSection={toggleSection}
            onClearSelection={() => setSelectedSections(new Set())}
            manualResearchSubmitting={manualResearchSubmitting}
            selectionGrarecoSubmitting={selectionGrarecoSubmitting}
            summaryActionSubmitting={summaryActionSubmitting}
            summaryActionKind={summaryActionKind}
            onCopyAll={handleCopyAll}
            onCopySelected={handleCopySelected}
            onManualResearch={handleManualResearch}
            onGenerateGrarecoFromSelection={handleGenerateGrarecoFromSelection}
            onReflect={handleReflect}
            onDiscover={handleDiscover}
            onRegenerate={handleRegenerateSummary}
            updatedAt={summary.updatedAt ? new Date(summary.updatedAt) : null}
            shareControl={shareControl}
          />
        )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
          {features.grareco && <ManualGrarecoSection meetingId={meetingId} shareControl={shareControl} />}
          <AnalysesSection meetingId={meetingId} />
        </div>

        <TranscriptSection
          transcripts={transcripts}
          onCopyAll={handleCopyTranscript}
          ngKeywords={ngKeywords}
          onSaveNgKeywords={handleSaveNgKeywords}
        />

        {(features.research || features.autoGrareco) && (
        <SettingsSection
          showResearch={features.research}
          showAutoGrareco={features.autoGrareco}
          researchSettings={researchSettings}
          updateResearchSettings={updateResearchSettings}
          onToggleSubAgent={handleToggleResearchSubAgent}
        />
        )}

        <StatusFooter isLive={isLive} grarecoItems={grarecoItems} grarecoLoading={grarecoLoading} researchCount={researchCards.length} showGrareco={features.grareco} showResearch={features.research} />
      </main>

      <Dialog open={!!researchDialog} onOpenChange={(o) => !o && setResearchDialog(null)}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          {researchDialog && (
            <ResearchCardDetailView card={researchDialog} onClose={() => setResearchDialog(null)} />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!grarecoDialog} onOpenChange={(o) => !o && setGrarecoDialog(null)}>
        <DialogContent
          className={
            grarecoFullscreen
              ? 'max-w-[98vw] w-[98vw] h-[95vh] max-h-[95vh] overflow-y-auto'
              : 'max-w-4xl max-h-[90vh] overflow-y-auto'
          }
        >
          {grarecoDialog && (
            <GrarecoDetailView
              item={grarecoDialog}
              fullscreen={grarecoFullscreen}
              onToggleFullscreen={() => setGrarecoFullscreen((v) => !v)}
              onClose={() => setGrarecoDialog(null)}
              onPromote={() => handleGrarecoPromote(grarecoDialog.recordingId)}
              onCancelPromote={() => handleGrarecoCancelPromote(grarecoDialog.recordingId)}
              onPin={() => handleGrarecoPin(grarecoDialog.recordingId)}
              onJumpToResearchInsight={handleJumpToResearchInsight}
            />
          )}
        </DialogContent>
      </Dialog>

      {agentEnabled && meeting && (
        <ChatFab
          open={chatOpen}
          onOpenChange={setChatOpen}
          meetingId={meeting.id}
          viewerSocketRef={viewerSocketRef}
          onShowGrareco={handleShowGrarecoFromAgent}
        />
      )}
    </div>
  );
}

function ParticipantsBlock({
  open,
  onToggle,
  participants,
  meetingId,
  participantImages,
  isDraggingParticipantImage,
  setIsDraggingParticipantImage,
  participantImageUploadingCount,
  participantImageInputRef,
  onUploadParticipantImages,
  onDropParticipantImage,
  onPasteParticipantImage,
  onDeleteParticipantImage,
  participantTexts,
  participantText,
  setParticipantText,
  onAddParticipantText,
  isAddingParticipantText,
  onDeleteParticipantText,
}: {
  open: boolean;
  onToggle: () => void;
  participants: Participant[];
  meetingId: number;
  participantImages: any[];
  isDraggingParticipantImage: boolean;
  setIsDraggingParticipantImage: (v: boolean) => void;
  participantImageUploadingCount: number;
  participantImageInputRef: React.RefObject<HTMLInputElement>;
  onUploadParticipantImages: (files: File[]) => void;
  onDropParticipantImage: (e: React.DragEvent) => void;
  onPasteParticipantImage: (e: React.ClipboardEvent) => void;
  onDeleteParticipantImage: (imageId: number) => void;
  participantTexts: any[];
  participantText: string;
  setParticipantText: (v: string) => void;
  onAddParticipantText: (content: string) => void;
  isAddingParticipantText: boolean;
  onDeleteParticipantText: (textId: number) => void;
}) {
  return (
    <section className="bg-slate-50 dark:bg-slate-900/50 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
      <header className="px-5 py-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Users className="w-4 h-4 text-slate-500" />
          <h2 className="text-sm font-semibold">
            {participants.length > 0 ? `参加者: ${participants.length}名` : '参加者を入力してください'}
          </h2>
          {!open && participants.length > 0 && (
            <span className="text-xs text-muted-foreground truncate">
              {participants
                .slice(0, 6)
                .map((p) => `${p.name}${p.other ? `(${p.other})` : ''}`)
                .join(', ')}
              {participants.length > 6 && ` 他${participants.length - 6}名`}
            </span>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={onToggle}>
          {open ? (
            <>
              <ChevronUp className="w-3.5 h-3.5 mr-1" />
              折りたたむ
            </>
          ) : (
            <>
              <ChevronDown className="w-3.5 h-3.5 mr-1" />
              展開
            </>
          )}
        </Button>
      </header>
      {open && (
        <div className="px-5 pb-5 pt-1 space-y-4" onPaste={onPasteParticipantImage}>
          <p className="text-xs text-muted-foreground">
            出席者名簿の<strong>画像</strong>や<strong>テキスト</strong>をアップロードすると、AI
            が自動で参加者情報を抽出します。サマリー生成時に「誰が何を発言したか」を反映します。
          </p>

          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-sm font-medium">画像</span>
              {participantImageUploadingCount > 0 && (
                <Badge variant="outline" className="text-xs gap-1">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  {participantImageUploadingCount}枚アップロード中...
                </Badge>
              )}
            </div>
            <div
              className={`relative border-2 border-dashed rounded-lg p-4 text-center transition-colors cursor-pointer ${
                isDraggingParticipantImage
                  ? 'border-primary bg-primary/10'
                  : 'border-muted-foreground/25 hover:border-primary/50'
              }`}
              onDragOver={(e) => {
                e.preventDefault();
                setIsDraggingParticipantImage(true);
              }}
              onDragLeave={() => setIsDraggingParticipantImage(false)}
              onDrop={onDropParticipantImage}
              onClick={() => participantImageInputRef.current?.click()}
            >
              <div className="flex flex-col items-center gap-1 text-muted-foreground">
                <ImageIcon className="w-6 h-6" />
                <p className="text-xs">
                  クリック・ドラッグ＆ドロップ・ペースト(Ctrl+V)で出席者名簿の画像を追加
                </p>
              </div>
              <input
                ref={participantImageInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => {
                  const files = Array.from(e.target.files || []);
                  onUploadParticipantImages(files);
                  e.target.value = '';
                }}
              />
            </div>
            {participantImages.length > 0 && (
              <div className="grid grid-cols-4 gap-2 mt-2">
                {participantImages.map((img: any) => (
                  <div key={img.id} className="relative group rounded-md">
                    <img
                      src={img.imageUrl}
                      alt={img.fileName || '参加者画像'}
                      loading="lazy"
                      className="w-full h-20 object-cover rounded-md border"
                    />
                    <div className="absolute top-1 right-1 flex gap-1">
                      <Button
                        variant="destructive"
                        size="icon"
                        className="w-5 h-5 opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={() => onDeleteParticipantImage(img.id)}
                        title="この画像を削除"
                      >
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    </div>
                    <div className="absolute bottom-1 left-1">
                      {img.aiExtractedParticipants === null ? (
                        <Badge variant="outline" className="text-[10px] bg-background/80 gap-1">
                          <Loader2 className="w-2.5 h-2.5 animate-spin" />
                          AI抽出中
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="text-[10px] bg-background/80">
                          {(img.aiExtractedParticipants as any[])?.length || 0}名抽出
                        </Badge>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <span className="text-sm font-medium mb-2 block">テキスト</span>
            <div className="flex gap-2">
              <textarea
                value={participantText}
                onChange={(e) => setParticipantText(e.target.value)}
                placeholder="参加者リストをテキストで入力またはペースト（例: 山田太郎（部長）、佐藤花子（課長）...）"
                className="flex-1 min-h-[60px] rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-y"
              />
              <Button
                size="sm"
                onClick={() => {
                  if (participantText.trim()) onAddParticipantText(participantText.trim());
                }}
                disabled={!participantText.trim() || isAddingParticipantText}
                className="self-end"
              >
                {isAddingParticipantText ? (
                  <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                ) : (
                  <Plus className="w-3.5 h-3.5 mr-1.5" />
                )}
                追加
              </Button>
            </div>
            {participantTexts.length > 0 && (
              <div className="space-y-2 mt-2">
                {participantTexts.map((t: any) => (
                  <div
                    key={t.id}
                    className="flex items-start gap-2 p-2 rounded-md border bg-muted/30"
                  >
                    <p className="flex-1 text-xs whitespace-pre-wrap">{t.content}</p>
                    <div className="flex items-center gap-1 shrink-0">
                      {t.aiExtractedParticipants === null ? (
                        <Badge variant="outline" className="text-[10px] gap-1">
                          <Loader2 className="w-2.5 h-2.5 animate-spin" />
                          AI抽出中
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="text-[10px]">
                          {(t.aiExtractedParticipants as any[])?.length || 0}名抽出
                        </Badge>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="w-6 h-6"
                        onClick={() => onDeleteParticipantText(t.id)}
                        title="このテキストを削除"
                      >
                        <Trash2 className="w-3 h-3 text-muted-foreground" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="pt-2 border-t border-slate-200 dark:border-slate-800">
            <span className="text-sm font-medium mb-1 block">抽出済み参加者</span>
            <p className="text-xs text-muted-foreground mb-2">
              画像・テキスト・会話から抽出した参加者情報です。各セルを編集して保存できます。
            </p>
            <ParticipantsInlineEditor participants={participants} meetingId={meetingId} />
          </div>
        </div>
      )}
    </section>
  );
}

function LiveTranscriptStrip({
  transcripts,
  expanded,
  onToggle,
}: {
  transcripts: Array<{ id: number; speaker: string | null; content: string; startTime: number }>;
  expanded: boolean;
  onToggle: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const tail = expanded ? transcripts.slice(-5) : transcripts.slice(-1);

  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [transcripts.length, expanded]);

  return (
    <div className="sticky top-0 z-30 bg-slate-50/95 dark:bg-slate-900/95 backdrop-blur border-b border-slate-200 dark:border-slate-800">
      <div className="max-w-7xl mx-auto px-3 sm:px-6 py-2 flex items-start gap-3">
        <div className="flex items-center gap-1.5 shrink-0 mt-0.5">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75 animate-ping" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
          </span>
          <span className="text-[10px] font-semibold text-red-600 dark:text-red-400 tabular-nums">
            文字起こし中
          </span>
        </div>
        <div
          ref={scrollRef}
          className={`flex-1 min-w-0 text-xs text-slate-700 dark:text-slate-300 overflow-y-auto ${
            expanded ? 'max-h-24' : 'max-h-5'
          } leading-5 transition-all`}
          aria-live="polite"
        >
          {tail.map((t) => (
            <div key={t.id} className="truncate sm:whitespace-normal sm:break-words">
              {t.speaker && (
                <span className="font-medium text-slate-900 dark:text-slate-100 mr-1.5">
                  {t.speaker}:
                </span>
              )}
              <span>{t.content}</span>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={onToggle}
          className="shrink-0 p-1 rounded hover:bg-slate-200/60 dark:hover:bg-slate-700/60 text-slate-500 dark:text-slate-400"
          title={expanded ? '1 行に折りたたむ' : '直近 5 行を表示'}
          aria-label={expanded ? '1 行に折りたたむ' : '直近 5 行を表示'}
        >
          {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>
      </div>
    </div>
  );
}

function OnOffBadge({ on }: { on: boolean }) {
  if (on) {
    return (
      <span
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold tabular-nums bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
        title="現在 ON"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
        ON
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold tabular-nums bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300"
      title="現在 OFF（設定パネルで切り替え可）"
    >
      OFF
    </span>
  );
}

function ObservationSection({
  observations,
  open,
  onToggle,
  onDelete,
}: {
  observations: MeetingObservation[];
  open: boolean;
  onToggle: () => void;
  onDelete: (obsId: number) => void;
}) {
  const { toast } = useToast();
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const [scrollMode, setScrollMode] = useState(true);
  const displayObservations = useMemo(() => [...observations].reverse(), [observations]);
  const allExpanded = observations.length > 0 && observations.every((o) => expandedIds.has(o.id));
  const toggleExpanded = (id: number) =>
    setExpandedIds((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  const toggleAllExpanded = () =>
    setExpandedIds(allExpanded ? new Set() : new Set(observations.map((o) => o.id)));
  const fmtTime = (iso: string) => {
    try {
      return new Date(iso).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
    } catch {
      return '';
    }
  };

  const toggleSelected = (id: number) =>
    setSelectedIds((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  const handleCopyAll = async () => {
    const text = observations.map((o, i) => formatObservationForCopy(o, i)).join('\n\n---\n\n');
    await copyTextToClipboard(text, `環境観察 全 ${observations.length}件`, toast);
  };

  const handleCopySelected = async () => {
    const targets = observations
      .map((o, i) => ({ o, i }))
      .filter(({ o }) => selectedIds.has(o.id));
    if (targets.length === 0) {
      toast({ title: '観察が選択されていません', variant: 'destructive' });
      return;
    }
    const text = targets.map(({ o, i }) => formatObservationForCopy(o, i)).join('\n\n---\n\n');
    await copyTextToClipboard(text, `環境観察 選択 ${targets.length}件`, toast);
  };

  const handleDelete = (obsId: number) => {
    if (window.confirm('この環境観察を削除します。紐づく補足資料とサマリー項目も削除されます。よろしいですか？')) {
      onDelete(obsId);
    }
  };
  const handleDeleteSelected = () => {
    const ids = observations.filter((o) => selectedIds.has(o.id)).map((o) => o.id);
    if (ids.length === 0) {
      toast({ title: '観察が選択されていません', variant: 'destructive' });
      return;
    }
    if (window.confirm(`${ids.length}件の環境観察を削除します。紐づく補足資料とサマリー項目も削除されます。よろしいですか？`)) {
      ids.forEach(onDelete);
      setSelectedIds(new Set());
    }
  };

  return (
    <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl">
      <button
        type="button"
        onClick={onToggle}
        className="w-full px-4 py-3 flex items-center justify-between gap-3 text-left"
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-9 h-9 rounded-lg bg-emerald-100 dark:bg-emerald-900/40 flex items-center justify-center shrink-0">
            <Eye className="w-4 h-4 text-emerald-600 dark:text-emerald-300" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold">環境観察（カメラ）</div>
            <div className="text-xs text-slate-500 dark:text-slate-400">
              {`${observations.length}件の観察 — その場の様子を1分ごとに解析（画像は保存していません）`}
            </div>
          </div>
        </div>
        {open ? (
          <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0" />
        ) : (
          <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
        )}
      </button>
      {open && observations.length === 0 && (
        <div className="px-4 pb-4 text-xs text-slate-400">
          まだ環境観察データがありません。デスクトップアプリで「環境観察」をONにすると、会議中に記録されます。
        </div>
      )}
      {open && observations.length > 0 && (
        <div className="px-4 pb-4 space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <Button variant="outline" size="sm" onClick={handleCopyAll}>
              <Copy className="w-3.5 h-3.5 mr-1" />
              全文コピー
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setSelectMode((v) => !v);
                if (selectMode) setSelectedIds(new Set());
              }}
            >
              {selectMode ? '選択をやめる' : '個別選択コピー'}
            </Button>
            {selectMode && (
              <>
                <Button
                  variant="default"
                  size="sm"
                  onClick={handleCopySelected}
                  disabled={selectedIds.size === 0}
                >
                  <Copy className="w-3.5 h-3.5 mr-1" />
                  選択({selectedIds.size})をコピー
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleDeleteSelected}
                  disabled={selectedIds.size === 0}
                  className="text-red-600 border-red-200 hover:bg-red-50"
                >
                  <Trash2 className="w-3.5 h-3.5 mr-1" />
                  選択({selectedIds.size})を削除
                </Button>
              </>
            )}
            <div className="ml-auto flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={toggleAllExpanded}>
                {allExpanded ? (
                  <>
                    <ChevronUp className="w-3.5 h-3.5 mr-1" />
                    すべて折りたたむ
                  </>
                ) : (
                  <>
                    <ChevronDown className="w-3.5 h-3.5 mr-1" />
                    すべて展開
                  </>
                )}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setScrollMode((v) => !v)}>
                {scrollMode ? '全表示' : '高さ固定'}
              </Button>
            </div>
          </div>

          <div className={scrollMode ? 'max-h-[480px] overflow-y-auto pr-1 space-y-3' : 'space-y-3'}>
          {displayObservations.map((o, revIdx) => {
            const idx = observations.length - 1 - revIdx;
            const w = o.fiveW1h;
            const isExpanded = expandedIds.has(o.id);
            return (
              <div
                key={o.id}
                className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 space-y-2"
              >
                <div className="flex items-center gap-3 text-xs text-slate-500 dark:text-slate-400 flex-wrap">
                  {selectMode && (
                    <input
                      type="checkbox"
                      checked={selectedIds.has(o.id)}
                      onChange={() => toggleSelected(o.id)}
                      className="rounded border-slate-300"
                      aria-label="この観察を選択"
                    />
                  )}
                  <span className="inline-flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {fmtTime(o.capturedAt)}
                  </span>
                  <Badge variant="outline" className="text-[10px]">
                    {o.sourceType === 'window' ? '画面（ウィンドウ）' : o.sourceType === 'display' ? '画面（ディスプレイ）' : 'カメラ'}
                  </Badge>
                  {typeof o.peopleCount === 'number' && o.peopleCount > 0 && (
                    <span className="inline-flex items-center gap-1">
                      <Users className="w-3 h-3" />
                      推定 {o.peopleCount} 名
                    </span>
                  )}
                  {o.location && (
                    <span className="inline-flex items-center gap-1" title="許可された場合のみ記録">
                      <MapPin className="w-3 h-3" />
                      {o.location.lat.toFixed(4)}, {o.location.lng.toFixed(4)}
                    </span>
                  )}
                  {o.linkedImageId != null && (
                    <Badge variant="outline" className="text-[10px]">
                      資料を補足資料に保存
                    </Badge>
                  )}
                  <button
                    type="button"
                    onClick={() =>
                      copyTextToClipboard(formatObservationForCopy(o, idx), `環境観察 #${idx + 1}`, toast)
                    }
                    className="ml-auto inline-flex items-center gap-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                    title="この観察をコピー"
                    aria-label="この観察をコピー"
                  >
                    <Copy className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(o.id)}
                    className="inline-flex items-center gap-1 text-slate-400 hover:text-red-600"
                    title="この観察を削除（紐づく補足資料・サマリー項目も削除）"
                    aria-label="この観察を削除"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => toggleExpanded(o.id)}
                    className="inline-flex items-center text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                    title={isExpanded ? '折りたたむ' : '詳細を見る'}
                    aria-label={isExpanded ? '折りたたむ' : '詳細を見る'}
                  >
                    {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                  </button>
                </div>

                {o.rawSummary && (
                  <button
                    type="button"
                    onClick={() => toggleExpanded(o.id)}
                    className="text-left w-full text-sm text-slate-700 dark:text-slate-200 hover:text-slate-900 dark:hover:text-white"
                    title={isExpanded ? '折りたたむ' : '詳細を見る'}
                  >
                    {o.rawSummary}
                  </button>
                )}

                {isExpanded && (
                <>
                {w && (
                  <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-xs">
                    {([
                      ['いつ (When)', w.when],
                      ['どこで (Where)', w.where],
                      ['誰が (Who)', w.who],
                      ['何を (What)', w.what],
                      ['なぜ (Why・推定)', w.why],
                      ['どのように (How)', w.how],
                    ] as const).map(([label, val]) =>
                      val ? (
                        <div key={label} className="flex gap-1.5">
                          <dt className="text-slate-400 dark:text-slate-500 shrink-0">{label}:</dt>
                          <dd className="text-slate-700 dark:text-slate-200">{val}</dd>
                        </div>
                      ) : null,
                    )}
                  </dl>
                )}

                {o.people && o.people.length > 0 && (
                  <div className="space-y-1">
                    <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                      人物の様子（すべて推定）
                    </div>
                    <ul className="space-y-1">
                      {o.people.map((p, i) => (
                        <li
                          key={i}
                          className="text-xs text-slate-600 dark:text-slate-300 flex flex-wrap gap-x-2"
                        >
                          {[p.position, p.posture, p.activity, p.inferredEmotion, p.inferredThought]
                            .filter(Boolean)
                            .join(' / ')}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {o.materialsText && (
                  <div className="space-y-1 rounded-md bg-slate-50 dark:bg-slate-800/60 p-2 border border-slate-200 dark:border-slate-700">
                    <div className="text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
                      写っていた資料（テキスト抽出・画像は保存していません）
                    </div>
                    <div className="text-xs text-slate-700 dark:text-slate-200 whitespace-pre-wrap leading-relaxed">
                      {o.materialsText}
                    </div>
                  </div>
                )}
                </>
                )}
              </div>
            );
          })}
          </div>
        </div>
      )}
    </section>
  );
}

function formatObservationForCopy(o: MeetingObservation, index: number): string {
  const when = (() => {
    try {
      return new Date(o.capturedAt).toLocaleString('ja-JP');
    } catch {
      return o.capturedAt;
    }
  })();
  const lines: string[] = [];
  const srcLabel = o.sourceType === 'window' ? '画面・ウィンドウ' : o.sourceType === 'display' ? '画面・ディスプレイ' : 'カメラ';
  lines.push(`■ 環境観察 #${index + 1}（${srcLabel}）　[${when}]`);
  if (typeof o.peopleCount === 'number' && o.peopleCount > 0) lines.push(`推定人数: ${o.peopleCount}名`);
  if (o.location) lines.push(`位置: ${o.location.lat}, ${o.location.lng}`);
  if (o.rawSummary) lines.push('', o.rawSummary);
  const w = o.fiveW1h;
  if (w) {
    lines.push('', '【5W1H】');
    if (w.when) lines.push(`- いつ: ${w.when}`);
    if (w.where) lines.push(`- どこで: ${w.where}`);
    if (w.who) lines.push(`- 誰が: ${w.who}`);
    if (w.what) lines.push(`- 何を: ${w.what}`);
    if (w.why) lines.push(`- なぜ(推定): ${w.why}`);
    if (w.how) lines.push(`- どのように: ${w.how}`);
  }
  if (o.people && o.people.length > 0) {
    lines.push('', '【人物の様子（推定）】');
    for (const p of o.people) {
      const parts = [p.position, p.posture, p.activity, p.inferredEmotion, p.inferredThought].filter(Boolean);
      if (parts.length) lines.push(`- ${parts.join(' / ')}`);
    }
  }
  if (o.materialsText) {
    lines.push('', '【写っていた資料（テキスト抽出・画像は保存していません）】', o.materialsText);
  }
  return lines.join('\n');
}

function SupplementarySection({
  open,
  onToggle,
  images,
  memos,
  uploadingCount,
  isDraggingImage,
  setIsDraggingImage,
  expandedImageId,
  setExpandedImageId,
  newMemoText,
  setNewMemoText,
  editingMemoId,
  setEditingMemoId,
  editingMemoText,
  setEditingMemoText,
  fileInputRef,
  onUploadFiles,
  onDrop,
  onPaste,
  onDeleteImage,
  onAddMemo,
  onUpdateMemo,
  onDeleteMemo,
  addingMemo,
  updatingMemo,
}: {
  open: boolean;
  onToggle: () => void;
  images: MeetingImage[];
  memos: MeetingMemo[];
  uploadingCount: number;
  isDraggingImage: boolean;
  setIsDraggingImage: (v: boolean) => void;
  expandedImageId: number | null;
  setExpandedImageId: (id: number | null) => void;
  newMemoText: string;
  setNewMemoText: (s: string) => void;
  editingMemoId: number | null;
  setEditingMemoId: (id: number | null) => void;
  editingMemoText: string;
  setEditingMemoText: (s: string) => void;
  fileInputRef: React.RefObject<HTMLInputElement>;
  onUploadFiles: (files: File[]) => void;
  onDrop: (e: React.DragEvent) => void;
  onPaste: (e: React.ClipboardEvent) => void;
  onDeleteImage: (id: number, removeSummarySection: boolean) => void;
  onAddMemo: (content: string) => void;
  onUpdateMemo: (id: number, content: string) => void;
  onDeleteMemo: (id: number) => void;
  addingMemo: boolean;
  updatingMemo: boolean;
}) {
  const totalCount = images.length + memos.length;
  const [deleteTargetId, setDeleteTargetId] = useState<number | null>(null);
  return (
    <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl">
      <button
        type="button"
        onClick={onToggle}
        className="w-full px-4 py-3 flex items-center justify-between gap-3 text-left"
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-9 h-9 rounded-lg bg-blue-100 dark:bg-blue-900/40 flex items-center justify-center shrink-0">
            <FileUp className="w-4 h-4 text-blue-600 dark:text-blue-300" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold">補足資料（画像・メモ）</div>
            <div className="text-xs text-slate-500 dark:text-slate-400">
              {totalCount === 0
                ? 'クリック・D&D・ペーストで画像を、メモは下のテキスト欄から追加'
                : `画像 ${images.length}件・メモ ${memos.length}件 — サマリー再生成 / リアルタイム調査 / 自動グラレコ の参考資料に組み込まれます`}
            </div>
          </div>
        </div>
        {open ? (
          <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0" />
        ) : (
          <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
        )}
      </button>
      {open && (
        <div className="px-4 pb-4 space-y-4" onPaste={onPaste}>
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-sm font-medium">画像</span>
              {uploadingCount > 0 && (
                <Badge variant="outline" className="text-xs gap-1">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  {uploadingCount}枚アップロード中...
                </Badge>
              )}
            </div>
            <div
              className={`relative border-2 border-dashed rounded-lg p-4 text-center transition-colors cursor-pointer ${
                isDraggingImage
                  ? 'border-primary bg-primary/10'
                  : 'border-muted-foreground/25 hover:border-primary/50'
              }`}
              onDragOver={(e) => {
                e.preventDefault();
                setIsDraggingImage(true);
              }}
              onDragLeave={() => setIsDraggingImage(false)}
              onDrop={onDrop}
              onClick={() => fileInputRef.current?.click()}
            >
              <div className="flex flex-col items-center gap-1 text-muted-foreground">
                <ImageIcon className="w-6 h-6" />
                <p className="text-xs">クリック・ドラッグ＆ドロップ・ペースト(Ctrl+V)で画像を追加</p>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => {
                  const files = Array.from(e.target.files || []);
                  onUploadFiles(files);
                  e.target.value = '';
                }}
              />
            </div>
            {images.length > 0 && (
              <div className="grid grid-cols-4 sm:grid-cols-6 gap-2 mt-2">
                {images.map((img) => {
                  const isUnsupported = img.mimeType === 'image/heic' || img.mimeType === 'image/heif';
                  const isTextOnly = !img.imageData || img.mimeType === 'text/plain';
                  return (
                    <div key={img.id} className="relative group rounded-md">
                      {isTextOnly ? (
                        <div
                          className="w-full h-20 rounded-md border cursor-pointer bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-800 flex flex-col items-center justify-center gap-0.5 px-1"
                          onClick={() =>
                            setExpandedImageId(expandedImageId === img.id ? null : img.id)
                          }
                        >
                          <FileUp className="w-5 h-5 text-emerald-600 dark:text-emerald-300" />
                          <span className="text-[8px] text-emerald-700 dark:text-emerald-300 text-center leading-tight">
                            資料テキスト<br />（画像なし）
                          </span>
                        </div>
                      ) : isUnsupported ? (
                        <div
                          className="w-full h-20 rounded-md border cursor-pointer bg-muted flex flex-col items-center justify-center gap-0.5"
                          onClick={() =>
                            setExpandedImageId(expandedImageId === img.id ? null : img.id)
                          }
                        >
                          <ImageIcon className="w-5 h-5 text-muted-foreground" />
                          <span className="text-[8px] text-muted-foreground">HEIC（要再アップロード）</span>
                        </div>
                      ) : (
                        <img
                          src={`data:${img.mimeType};base64,${img.imageData}`}
                          alt={img.fileName || 'uploaded image'}
                          className="w-full h-20 object-cover rounded-md border cursor-pointer"
                          onClick={() =>
                            setExpandedImageId(expandedImageId === img.id ? null : img.id)
                          }
                        />
                      )}
                      <button
                        type="button"
                        className="absolute top-0.5 right-0.5 bg-black/60 text-white rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteTargetId(img.id);
                        }}
                        aria-label="画像を削除"
                      >
                        <X className="w-3 h-3" />
                      </button>
                      {img.aiAnalysis ? (
                        <span className="absolute bottom-6 left-0.5 bg-primary/80 text-primary-foreground text-[8px] px-1 rounded">
                          AI済
                        </span>
                      ) : (
                        <span className="absolute bottom-6 left-0.5 bg-muted-foreground/80 text-white text-[8px] px-1 rounded flex items-center gap-0.5">
                          <Loader2 className="w-2 h-2 animate-spin" />
                          分析中
                        </span>
                      )}
                      {expandedImageId === img.id && (
                        <Dialog open onOpenChange={() => setExpandedImageId(null)}>
                          <DialogContent className="max-w-3xl">
                            <DialogHeader>
                              <DialogTitle>{img.fileName || '画像'}</DialogTitle>
                              <DialogDescription>
                                {img.uploadedAt
                                  ? new Date(img.uploadedAt).toLocaleString('ja-JP')
                                  : ''}
                              </DialogDescription>
                            </DialogHeader>
                            {isTextOnly ? (
                              <div className="w-full bg-emerald-50 dark:bg-emerald-900/20 rounded p-3 flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-300">
                                <FileUp className="w-5 h-5" />
                                環境観察で抽出した資料テキストです（画像は保存していません）。
                              </div>
                            ) : isUnsupported ? (
                              <div className="w-full h-40 bg-muted rounded flex flex-col items-center justify-center gap-2">
                                <ImageIcon className="w-10 h-10 text-muted-foreground" />
                                <p className="text-sm text-muted-foreground">
                                  HEIC形式のため表示できません。削除して再アップロードしてください。
                                </p>
                              </div>
                            ) : (
                              <img
                                src={`data:${img.mimeType};base64,${img.imageData}`}
                                alt={img.fileName || ''}
                                className="w-full rounded"
                              />
                            )}
                            {img.aiAnalysis && (
                              <div className="mt-2">
                                <h4 className="text-sm font-medium mb-1">AI分析結果</h4>
                                <pre className="whitespace-pre-wrap text-xs bg-muted p-2 rounded max-h-60 overflow-y-auto">
                                  {img.aiAnalysis}
                                </pre>
                              </div>
                            )}
                          </DialogContent>
                        </Dialog>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-sm font-medium">メモ</span>
            </div>
            <div className="flex gap-2 mb-2">
              <Textarea
                value={newMemoText}
                onChange={(e) => setNewMemoText(e.target.value)}
                placeholder="メモを入力..."
                className="text-sm min-h-[60px]"
                rows={2}
              />
              <Button
                variant="outline"
                size="sm"
                className="shrink-0 self-end"
                disabled={!newMemoText.trim() || addingMemo}
                onClick={() => onAddMemo(newMemoText.trim())}
              >
                {addingMemo ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <Plus className="w-3 h-3" />
                )}
              </Button>
            </div>
            {memos.length > 0 && (
              <div className="space-y-2">
                {memos.map((memo) => (
                  <div
                    key={memo.id}
                    className="border rounded-md p-2 text-sm group relative"
                  >
                    {editingMemoId === memo.id ? (
                      <div className="flex gap-2">
                        <Textarea
                          value={editingMemoText}
                          onChange={(e) => setEditingMemoText(e.target.value)}
                          className="text-sm min-h-[40px]"
                          rows={2}
                        />
                        <div className="flex flex-col gap-1 shrink-0">
                          <Button
                            variant="outline"
                            size="icon"
                            className="h-7 w-7"
                            onClick={() => onUpdateMemo(memo.id, editingMemoText)}
                            disabled={updatingMemo}
                            aria-label="保存"
                          >
                            <Save className="w-3 h-3" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={() => setEditingMemoId(null)}
                            aria-label="キャンセル"
                          >
                            <X className="w-3 h-3" />
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <p className="whitespace-pre-wrap pr-14">{memo.content}</p>
                        <p className="text-[10px] text-muted-foreground mt-1">
                          {memo.createdAt
                            ? new Date(memo.createdAt).toLocaleString('ja-JP')
                            : ''}
                          {memo.updatedAt &&
                            memo.createdAt &&
                            new Date(memo.updatedAt).getTime() !==
                              new Date(memo.createdAt).getTime() &&
                            ' (編集済み)'}
                        </p>
                        <div className="absolute top-1 right-1 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            type="button"
                            className="p-1 hover:bg-muted rounded"
                            onClick={() => {
                              setEditingMemoId(memo.id);
                              setEditingMemoText(memo.content);
                            }}
                            aria-label="メモを編集"
                          >
                            <Pencil className="w-3 h-3" />
                          </button>
                          <button
                            type="button"
                            className="p-1 hover:bg-muted rounded text-destructive"
                            onClick={() => {
                              if (window.confirm('このメモを削除しますか？')) onDeleteMemo(memo.id);
                            }}
                            aria-label="メモを削除"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <Dialog open={deleteTargetId !== null} onOpenChange={(o) => { if (!o) setDeleteTargetId(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>この画像を削除します</DialogTitle>
            <DialogDescription>
              この画像の分析は、すでにサマリーへ取り込まれている場合があります。サマリー内の該当部分も一緒に削除しますか？
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2 mt-2">
            <Button
              variant="destructive"
              onClick={() => {
                if (deleteTargetId !== null) onDeleteImage(deleteTargetId, true);
                setDeleteTargetId(null);
              }}
            >
              分析も一緒に削除
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                if (deleteTargetId !== null) onDeleteImage(deleteTargetId, false);
                setDeleteTargetId(null);
              }}
            >
              画像だけ削除（サマリーは残す）
            </Button>
            <Button variant="ghost" onClick={() => setDeleteTargetId(null)}>
              キャンセル
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}

interface SummaryStats {
  topics: number;
  decisions: number;
  todos: number;
}
function SummaryBanner({
  summary,
  stats,
  sectionCount,
  isLive,
  detailOpen,
  onToggleDetail,
  onCopy,
}: {
  summary: StructuredSummary | null | undefined;
  stats: SummaryStats;
  sectionCount: number;
  isLive: boolean;
  detailOpen: boolean;
  onToggleDetail: () => void;
  onCopy: () => void;
}) {
  const hasContent = !!summary?.content?.trim();
  const hasStats = stats.topics > 0 || stats.decisions > 0 || stats.todos > 0;
  return (
    <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 flex items-center justify-between gap-4 flex-wrap">
      <div className="flex items-start gap-3 min-w-0 flex-1">
        <div className="w-9 h-9 rounded-lg bg-slate-100 dark:bg-slate-800 flex items-center justify-center shrink-0 text-base">
          📊
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <h2 className="text-sm font-semibold">サマリー</h2>
            {isLive && hasContent && (
              <Badge variant="outline" className="text-[10px] gap-1 h-5">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                更新中
              </Badge>
            )}
          </div>
          <p className="text-sm text-slate-700 dark:text-slate-300">
            {hasContent ? (
              hasStats ? (
                <>
                  会議の主要論点が <strong>{stats.topics}件</strong>、決定事項が{' '}
                  <strong>{stats.decisions}件</strong>、ToDo が <strong>{stats.todos}件</strong>{' '}
                  まとまっています
                </>
              ) : sectionCount > 0 ? (
                <span className="text-muted-foreground">
                  <strong className="text-foreground">{sectionCount}個</strong>のサマリーが生成されています
                </span>
              ) : (
                <span className="text-muted-foreground">サマリーが生成されています</span>
              )
            ) : (
              <span className="text-muted-foreground">会議中・終了後に自動生成されます</span>
            )}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Button variant="outline" size="sm" onClick={onCopy} disabled={!hasContent}>
          <Copy className="w-3.5 h-3.5 mr-1.5" />
          コピー
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={onToggleDetail}
          disabled={!hasContent}
          aria-label={detailOpen ? '閉じる' : '展開'}
          title={detailOpen ? '閉じる' : '展開して詳細操作'}
        >
          {detailOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </Button>
      </div>
    </section>
  );
}

function SummaryDetailPanel({
  sections,
  selectedSections,
  onToggleSection,
  onClearSelection,
  manualResearchSubmitting,
  selectionGrarecoSubmitting,
  summaryActionSubmitting,
  summaryActionKind,
  onCopyAll,
  onCopySelected,
  onManualResearch,
  onGenerateGrarecoFromSelection,
  onReflect,
  onDiscover,
  onRegenerate,
  updatedAt,
  shareControl,
}: {
  sections: SummarySection[];
  selectedSections: Set<number>;
  onToggleSection: (i: number) => void;
  onClearSelection: () => void;
  manualResearchSubmitting: boolean;
  selectionGrarecoSubmitting: boolean;
  summaryActionSubmitting: boolean;
  summaryActionKind: 'reflect' | 'discover' | 'rebuild' | null;
  onCopyAll: () => void;
  onCopySelected: () => void;
  onManualResearch: () => void;
  onGenerateGrarecoFromSelection: () => void;
  onReflect: () => void;
  onDiscover: () => void;
  onRegenerate: () => void;
  updatedAt: Date | null;
  shareControl?: ShareControl;
}) {
  const selectedCount = selectedSections.size;
  return (
    <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
      <header className="px-5 py-3 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between gap-3 flex-wrap">
        <div className="text-xs text-muted-foreground">
          構造化サマリー · {sections.length} セクション
          {updatedAt && ` · 最終更新: ${formatDateTime(updatedAt)}`}
        </div>
        {selectedCount > 0 && (
          <Button variant="ghost" size="sm" onClick={onClearSelection} className="text-xs h-7">
            選択を解除 ({selectedCount})
          </Button>
        )}
      </header>

      <div className="px-5 py-3 border-b border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/30 flex items-center gap-2 flex-wrap">
        <Button variant="outline" size="sm" onClick={onCopyAll} className="h-8 text-xs">
          <Copy className="w-3.5 h-3.5 mr-1" />
          全文コピー
        </Button>
        <Button
          variant="default"
          size="sm"
          onClick={onCopySelected}
          disabled={selectedCount === 0}
          className="h-8 text-xs"
        >
          <Copy className="w-3.5 h-3.5 mr-1" />
          選択項目({selectedCount})をコピー
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={onManualResearch}
          disabled={selectedCount === 0 || manualResearchSubmitting}
          className="h-8 text-xs"
          title="選択したサマリーセクションの該当発言をリアルタイム調査で再分析する"
        >
          {manualResearchSubmitting ? (
            <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
          ) : (
            <Search className="w-3.5 h-3.5 mr-1" />
          )}
          {manualResearchSubmitting
            ? 'リサーチ中…'
            : `選択範囲をリサーチ(${selectedCount})`}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={onGenerateGrarecoFromSelection}
          disabled={selectedCount === 0 || selectionGrarecoSubmitting}
          className="h-8 text-xs"
          title="選択したサマリーセクション + 該当文字起こしからグラレコを生成"
        >
          {selectionGrarecoSubmitting ? (
            <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
          ) : (
            <Paintbrush className="w-3.5 h-3.5 mr-1" />
          )}
          {selectionGrarecoSubmitting
            ? 'グラレコ生成中…'
            : `選択範囲をグラレコ(${selectedCount})`}
        </Button>
        <div className="h-5 border-l border-slate-300 dark:border-slate-700 mx-1" />
        <Button variant="outline" size="sm" onClick={onReflect} disabled={summaryActionSubmitting} className="h-8 text-xs">
          {summaryActionKind === 'reflect' ? (
            <>
              <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
              リフレクト中…
            </>
          ) : (
            '🔄 リフレクト'
          )}
        </Button>
        <Button variant="outline" size="sm" onClick={onDiscover} disabled={summaryActionSubmitting} className="h-8 text-xs">
          {summaryActionKind === 'discover' ? (
            <>
              <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
              ディスカバー中…
            </>
          ) : (
            '🌱 ディスカバー'
          )}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={onRegenerate}
          disabled={summaryActionSubmitting}
          className="h-8 text-xs"
          title="NGワード該当行を除いた全文字起こしからサマリーをゼロから作り直す"
        >
          {summaryActionKind === 'rebuild' ? (
            <>
              <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
              再構築中…
            </>
          ) : (
            <>
              <RefreshCw className="w-3.5 h-3.5 mr-1" />
              サマリーを再構築
            </>
          )}
        </Button>
      </div>

      <div className="p-3 space-y-2 max-h-[600px] overflow-y-auto">
        {sections.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-6">
            セクションが解析できませんでした
          </p>
        ) : (
          sections.map((sec, i) => (
            <SummarySectionRow
              key={i}
              index={i}
              section={sec}
              selected={selectedSections.has(i)}
              onToggle={() => onToggleSection(i)}
              shareControl={shareControl}
            />
          ))
        )}
      </div>
    </section>
  );
}

function SummarySectionRow({
  index,
  section,
  selected,
  onToggle,
  shareControl,
}: {
  index: number;
  section: SummarySection;
  selected: boolean;
  onToggle: () => void;
  shareControl?: ShareControl;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div
      className={`border rounded-lg transition-colors ${
        selected
          ? 'border-primary bg-primary/5 dark:bg-primary/10'
          : 'border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/30'
      }`}
    >
      <div className="flex items-start gap-2 p-3">
        <button
          type="button"
          onClick={onToggle}
          className="shrink-0 mt-0.5 text-muted-foreground hover:text-foreground"
          aria-label={selected ? '選択解除' : '選択'}
        >
          {selected ? (
            <CheckSquare className="w-4 h-4 text-primary" />
          ) : (
            <SquareIcon className="w-4 h-4" />
          )}
        </button>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-left flex-1 min-w-0"
        >
          <div className="flex items-center gap-2">
            {expanded ? (
              <ChevronUp className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            ) : (
              <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            )}
            <span className="text-sm font-medium">{section.heading || `セクション ${index + 1}`}</span>
          </div>
          {expanded && section.content && (
            <div className="mt-2 ml-5 text-xs text-slate-700 dark:text-slate-300 whitespace-pre-wrap">
              {section.content}
            </div>
          )}
        </button>
        {shareControl?.active && (
          <GuestShareToggle
            shared={!shareControl.isSummaryExcluded(section)}
            onToggle={() => shareControl.toggleSummary(section)}
            className="mt-0.5"
          />
        )}
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(section.fullText);
            } catch {
            }
          }}
          className="shrink-0 text-muted-foreground hover:text-foreground p-1"
          aria-label="このセクションをコピー"
          title="このセクションをコピー"
        >
          <Copy className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

function GrarecoSection({
  items,
  loading,
  meeting,
  isLive,
  open,
  onToggle,
  onCardClick,
  onCopyImage,
  autoEnabled,
  pendingCount,
  onBulkPromote,
  bulkPromoting,
  shareControl,
}: {
  items: GrarecoFeedItem[];
  loading?: boolean;
  meeting: Meeting | undefined;
  isLive: boolean;
  open: boolean;
  onToggle: () => void;
  onCardClick: (item: GrarecoFeedItem) => void;
  onCopyImage: (item: GrarecoFeedItem) => void;
  autoEnabled: boolean;
  pendingCount: number;
  onBulkPromote: () => void;
  bulkPromoting: boolean;
  shareControl?: ShareControl;
}) {
  const drawingCount = items.filter(
    (i) => !i.imageUrl && !i.skippedReason && (i.isPromoting || i.willAutoPromote),
  ).length;

  interface PanelSearchHit {
    recordingId: number;
    score: number;
    snippet: string;
    matchedElapsedLabel: string | null;
    matchedTerms?: string[];
  }
  const [searchQuery, setSearchQuery] = useState('');
  const [searchHits, setSearchHits] = useState<PanelSearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [executedQuery, setExecutedQuery] = useState('');

  const handleSearch = async () => {
    const q = searchQuery.trim();
    if (!q || searching || !meeting) return;
    setSearching(true);
    setSearchError(null);
    setExecutedQuery(q);
    try {
      const res = await apiRequest(
        'GET',
        `/api/grareco/search?q=${encodeURIComponent(q)}&meeting_id=${meeting.id}`,
      );
      const data = (await res.json()) as { results: PanelSearchHit[] };
      setSearchHits(data.results);
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : '検索に失敗しました');
      setSearchHits(null);
    } finally {
      setSearching(false);
    }
  };
  const clearSearch = () => {
    setSearchQuery('');
    setSearchHits(null);
    setSearchError(null);
    setExecutedQuery('');
  };

  const hitCards =
    searchHits === null
      ? null
      : searchHits
          .map((hit) => ({ hit, item: items.find((i) => i.recordingId === hit.recordingId) }))
          .filter((x): x is { hit: PanelSearchHit; item: GrarecoFeedItem } => !!x.item);

  return (
    <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
      <header className="px-5 py-3 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-rose-50 dark:bg-rose-900/30 flex items-center justify-center text-base">
            🎨
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold">自動グラレコ</h2>
              <OnOffBadge on={autoEnabled} />
            </div>
            <p className="text-xs text-muted-foreground">
              {loading ? '読み込み中…' : `${items.length}枚生成済み`}{isLive ? ' · 会議中も自由に閲覧/コピー可' : ''}
            </p>
          </div>
          {drawingCount > 0 && (
            <Badge variant="outline" className="text-[10px] gap-1 h-5 ml-1">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
              描画中
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {!isLive && pendingCount > 0 && (
            <Button variant="default" size="sm" onClick={onBulkPromote} disabled={bulkPromoting}>
              {bulkPromoting ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                  画像化中…
                </>
              ) : (
                <>
                  <ImageIcon className="w-3.5 h-3.5 mr-1.5" />
                  まとめて画像化（{pendingCount}件）
                </>
              )}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onToggle}>
            {open ? (
              <ChevronUp className="w-4 h-4" />
            ) : (
              <ChevronDown className="w-4 h-4" />
            )}
          </Button>
        </div>
      </header>
      {open && (
        <div className="p-4 max-h-[640px] overflow-y-auto">
          {items.length > 0 && (
            <div className="mb-3">
              <div className="flex items-center gap-2">
                <div className="relative flex-1 min-w-0">
                  <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    placeholder="さっき話した内容で検索（例: 予算の話）…"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.nativeEvent.isComposing) handleSearch();
                    }}
                    className="pl-8 h-8 text-sm"
                  />
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleSearch}
                  disabled={searching || !searchQuery.trim()}
                >
                  {searching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : '検索'}
                </Button>
                {searchHits !== null && (
                  <Button size="sm" variant="ghost" onClick={clearSearch}>
                    <X className="w-3.5 h-3.5" />
                  </Button>
                )}
              </div>
              {searching ? (
                <p className="text-xs text-muted-foreground mt-1.5 flex items-center gap-1.5">
                  <Loader2 className="w-3 h-3 animate-spin shrink-0" />
                  「{executedQuery}」を意味検索中…（数秒かかります）
                </p>
              ) : searchError ? (
                <p className="text-xs text-destructive mt-1.5">{searchError}</p>
              ) : searchHits !== null ? (
                <p className="text-xs text-muted-foreground mt-1.5">
                  ✓ 「{executedQuery}」の検索結果: {hitCards?.length ?? 0} 件
                  {(hitCards?.length ?? 0) > 0 && '（関連が高い順・× で全件表示に戻る）'}
                </p>
              ) : null}
            </div>
          )}
          {items.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              会議中の話題の切り替わりで自動生成されます
            </p>
          ) : hitCards !== null ? (
            hitCards.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-6">
                該当するグラレコが見つかりませんでした
              </p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {hitCards.map(({ hit, item }) => (
                  <div key={item.recordingId}>
                    <GrarecoCard
                      item={item}
                      meeting={meeting}
                      onClick={() => onCardClick(item)}
                      onCopy={() => onCopyImage(item)}
                      shareControl={shareControl}
                    />
                    <p className="text-[11px] text-muted-foreground mt-1 px-0.5">
                      類似 {Math.round(hit.score * 100)}%
                      {hit.matchedElapsedLabel && ` ・開始から ${hit.matchedElapsedLabel} 頃の会話`}
                      {(hit.matchedTerms?.length ?? 0) > 0 &&
                        ` ・一致語: ${hit.matchedTerms!.join('、')}`}
                      {hit.snippet && (
                        <span className="line-clamp-1">「…{hit.snippet}…」</span>
                      )}
                    </p>
                  </div>
                ))}
              </div>
            )
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {items.map((item) => (
                <GrarecoCard
                  key={item.recordingId}
                  item={item}
                  meeting={meeting}
                  onClick={() => onCardClick(item)}
                  onCopy={() => onCopyImage(item)}
                  shareControl={shareControl}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function GrarecoCard({
  item,
  meeting,
  onClick,
  onCopy,
  shareControl,
}: {
  item: GrarecoFeedItem;
  meeting: Meeting | undefined;
  onClick: () => void;
  onCopy: () => void;
  shareControl?: ShareControl;
}) {
  const title = item.draft?.title ?? '無題のグラレコ';
  const timecode = formatTimecodeFromMeeting(item.receivedAt, meeting);
  const hasImage = !!item.imageUrl;
  return (
    <div className="group relative bg-slate-50 dark:bg-slate-800/30 rounded-lg overflow-hidden border border-slate-200 dark:border-slate-800 hover:shadow-md transition-shadow">
      <button type="button" onClick={onClick} className="w-full text-left block">
        <div className="relative aspect-video bg-white dark:bg-slate-900">
          {hasImage ? (
            <img
              src={grarecoThumbUrl(item.imageUrl!)}
              alt={title}
              loading="lazy"
              className="w-full h-full object-cover group-hover:scale-[1.02] transition-transform"
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
              {item.isPromoting ? '描画中…' : 'ドラフト'}
            </div>
          )}
          {timecode && (
            <span className="absolute top-2 left-2 text-[11px] tabular-nums bg-black/60 text-white px-1.5 py-0.5 rounded">
              {timecode}
            </span>
          )}
        </div>
        <div className="p-3">
          <div className="text-sm font-medium line-clamp-2">{title}</div>
        </div>
      </button>
      {shareControl?.active && hasImage && (
        <div className="px-3 pb-1">
          <GuestShareToggle
            shared={!shareControl.isExcluded('grareco', String(item.recordingId))}
            onToggle={() => shareControl.toggle('grareco', String(item.recordingId))}
          />
        </div>
      )}
      <div className="px-3 pb-3 flex items-center gap-1.5">
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs flex-1"
          onClick={onCopy}
          disabled={!hasImage}
        >
          <Copy className="w-3 h-3 mr-1" />
          コピー
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs flex-1"
          onClick={onClick}
        >
          <Share2 className="w-3 h-3 mr-1" />
          共有
        </Button>
      </div>
    </div>
  );
}

function ResearchSection({
  cards,
  open,
  onToggle,
  selectMode,
  onToggleSelectMode,
  selectedIds,
  onToggleSelected,
  onCopyAll,
  onCopySelected,
  onCardClick,
  onCopyCard,
  mainEnabled,
  shareControl,
}: {
  cards: ResearchCard[];
  open: boolean;
  onToggle: () => void;
  selectMode: boolean;
  onToggleSelectMode: () => void;
  selectedIds: Set<string>;
  onToggleSelected: (id: string) => void;
  onCopyAll: () => void;
  onCopySelected: () => void;
  onCardClick: (c: ResearchCard) => void;
  onCopyCard: (c: ResearchCard) => void;
  mainEnabled: boolean;
  shareControl?: ShareControl;
}) {
  const total = cards.length;
  const selectedCount = selectedIds.size;
  return (
    <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
      <header className="px-5 py-3 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-purple-50 dark:bg-purple-900/30 flex items-center justify-center text-base">
            🔍
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold">リアルタイム調査</h2>
              <OnOffBadge on={mainEnabled} />
            </div>
            <p className="text-xs text-muted-foreground">
              {total}件 · 補足/事実確認/論理課題
            </p>
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={onToggle}>
          {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </Button>
      </header>

      {open && (
        <>
          <div className="px-3 py-2 border-b border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/30 flex items-center gap-1.5 flex-wrap text-xs">
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={onCopyAll}
              disabled={total === 0}
            >
              <Copy className="w-3 h-3 mr-1" />
              全件コピー({total})
            </Button>
            <Button
              variant={selectMode ? 'default' : 'outline'}
              size="sm"
              className="h-7 text-xs"
              onClick={onToggleSelectMode}
              disabled={total === 0}
            >
              {selectMode ? (
                <CheckSquare className="w-3 h-3 mr-1" />
              ) : (
                <SquareIcon className="w-3 h-3 mr-1" />
              )}
              選択モード
            </Button>
            {selectMode && (
              <Button
                variant="default"
                size="sm"
                className="h-7 text-xs"
                onClick={onCopySelected}
                disabled={selectedCount === 0}
              >
                <Copy className="w-3 h-3 mr-1" />
                選択({selectedCount})をコピー
              </Button>
            )}
          </div>

          <div className="p-3 space-y-2 max-h-[640px] overflow-y-auto">
            {total === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-6">
                会議中の発言から自動で調査されます
              </p>
            ) : (
              cards.map((c) => {
                return (
                  <ResearchCardRow
                    key={c.id}
                    card={c}
                    selectMode={selectMode}
                    selected={selectedIds.has(c.id)}
                    onToggleSelected={() => onToggleSelected(c.id)}
                    onClick={() => onCardClick(c)}
                    onCopy={() => onCopyCard(c)}
                    shareControl={shareControl}
                  />
                );
              })
            )}
          </div>
        </>
      )}
    </section>
  );
}

function TermsSection({
  terms,
  onDismiss,
  open,
  onToggle,
  onCollapseHorizontal,
  shareControl,
}: {
  terms: DetectedTerm[];
  onDismiss: (term: string) => void;
  open: boolean;
  onToggle: () => void;
  onCollapseHorizontal?: () => void;
  shareControl?: ShareControl;
}) {
  return (
    <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
      <header className="px-5 py-3 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-purple-50 dark:bg-purple-900/30 flex items-center justify-center text-base">
            📚
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">用語解説</h2>
            <p className="text-xs text-muted-foreground">{terms.length}件</p>
          </div>
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          {onCollapseHorizontal && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onCollapseHorizontal}
              aria-label="右側に格納（横折りたたみ）"
              title="横折りたたみ（リアルタイム調査を広く表示）"
            >
              <ChevronRight className="w-4 h-4" />
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onToggle} aria-label={open ? '閉じる' : '展開'}>
            {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </Button>
        </div>
      </header>
      {open && (
        <div className="p-3 space-y-2 max-h-[640px] overflow-y-auto">
          {terms.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              会議中の発言から自動で用語が検出されます
            </p>
          ) : (
            terms.map((t) => (
              <div
                key={t.term}
                className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-3 flex items-start justify-between gap-2"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <span className="inline-flex shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-purple-50 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300">
                      用語
                    </span>
                    <span className="font-medium text-sm">{t.term}</span>
                  </div>
                  {t.explanation && (
                    <div className="text-xs text-muted-foreground mt-1">
                      {t.explanation}
                    </div>
                  )}
                  {shareControl?.active && (
                    <div className="mt-1.5">
                      <GuestShareToggle
                        shared={!shareControl.isExcluded('glossary', t.term)}
                        onToggle={() => shareControl.toggle('glossary', t.term)}
                      />
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => onDismiss(t.term)}
                  className="text-muted-foreground hover:text-foreground shrink-0"
                  aria-label="閉じる"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ))
          )}
        </div>
      )}
    </section>
  );
}

function researchPillStyle(cardType: string): { bg: string; text: string; label: string } {
  switch (cardType) {
    case 'info':
      return {
        bg: 'bg-emerald-50 dark:bg-emerald-900/30',
        text: 'text-emerald-700 dark:text-emerald-300',
        label: '補足情報',
      };
    case 'fact-check':
      return {
        bg: 'bg-blue-50 dark:bg-blue-900/30',
        text: 'text-blue-700 dark:text-blue-300',
        label: '事実確認',
      };
    case 'gap-alert':
      return {
        bg: 'bg-amber-50 dark:bg-amber-900/30',
        text: 'text-amber-700 dark:text-amber-300',
        label: '論理課題',
      };
    case 'minutes-todo':
      return {
        bg: 'bg-slate-100 dark:bg-slate-800',
        text: 'text-slate-700 dark:text-slate-300',
        label: 'ToDo',
      };
    default:
      return {
        bg: 'bg-slate-100 dark:bg-slate-800',
        text: 'text-slate-700 dark:text-slate-300',
        label: cardType,
      };
  }
}

function ResearchCardRow({
  card,
  selectMode,
  selected,
  onToggleSelected,
  onClick,
  onCopy,
  shareControl,
}: {
  card: ResearchCard;
  selectMode: boolean;
  selected: boolean;
  onToggleSelected: () => void;
  onClick: () => void;
  onCopy: () => void;
  shareControl?: ShareControl;
}) {
  const pill = researchPillStyle(card.cardType);
  const showShareToggle = !!shareControl?.active && isShareableResearch(card);
  return (
    <div
      className={`border rounded-lg p-3 transition-colors ${
        selected
          ? 'border-primary bg-primary/5 dark:bg-primary/10'
          : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 hover:shadow-sm'
      }`}
    >
      <div className="flex items-start gap-2">
        {selectMode && (
          <button
            type="button"
            onClick={onToggleSelected}
            className="shrink-0 mt-0.5 text-muted-foreground hover:text-foreground"
            aria-label={selected ? '選択解除' : '選択'}
          >
            {selected ? (
              <CheckSquare className="w-4 h-4 text-primary" />
            ) : (
              <SquareIcon className="w-4 h-4" />
            )}
          </button>
        )}
        <button type="button" onClick={selectMode ? onToggleSelected : onClick} className="flex-1 text-left">
          <div className="flex items-start gap-2 mb-1.5">
            <span
              className={`inline-flex shrink-0 text-[11px] font-medium px-2 py-0.5 rounded-full ${pill.bg} ${pill.text}`}
            >
              {pill.label}
            </span>
            <div className="font-medium text-sm leading-snug">{card.title || card.keyword}</div>
          </div>
          {card.body && (
            <div className="text-xs text-slate-600 dark:text-slate-400 line-clamp-3 mb-1.5 pl-1">
              {card.body}
            </div>
          )}
          {card.keyword && card.title && card.keyword !== card.title && (
            <div className="text-[10px] text-muted-foreground pl-1">KW: {card.keyword}</div>
          )}
        </button>
      </div>
      {!selectMode && (
        <div className="flex items-center justify-end gap-1 mt-1">
          <div className="mr-auto flex items-center gap-1.5">
            {showShareToggle && shareControl && (
              <GuestShareToggle
                shared={!shareControl.isExcluded('research', card.id)}
                onToggle={() => shareControl.toggle('research', card.id)}
              />
            )}
          </div>
          <button
            type="button"
            onClick={onCopy}
            className="text-muted-foreground hover:text-foreground text-[11px] inline-flex items-center gap-0.5 px-1.5 py-0.5 hover:bg-slate-50 dark:hover:bg-slate-800 rounded"
          >
            <Copy className="w-3 h-3" />
            コピー
          </button>
          <button
            type="button"
            onClick={onClick}
            className="text-muted-foreground hover:text-foreground text-[11px] inline-flex items-center gap-0.5 px-1.5 py-0.5 hover:bg-slate-50 dark:hover:bg-slate-800 rounded"
          >
            <Share2 className="w-3 h-3" />
            詳細
          </button>
        </div>
      )}
    </div>
  );
}

interface GraphicRecordingRow {
  id: number;
  sourceText: string;
  imageUrl: string | null;
  triggerType: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

function ManualGrarecoSection({
  meetingId,
  shareControl,
}: {
  meetingId: number;
  shareControl?: ShareControl;
}) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<GraphicRecordingRow | null>(null);
  const [revisionTarget, setRevisionTarget] = useState<GraphicRecordingRow | null>(null);
  const [clipboardDialogOpen, setClipboardDialogOpen] = useState(false);
  const { toast } = useToast();
  const { data: all = [], isPending } = useQuery<GraphicRecordingRow[]>({
    queryKey: ['/api/meetings', meetingId, 'graphic-recordings'],
    queryFn: () =>
      apiRequest('GET', `/api/meetings/${meetingId}/graphic-recordings`).then((r) => r.json()),
    enabled: meetingId > 0,
    refetchInterval: 30000,
  });
  const manualItems = useMemo(
    () =>
      all.filter(
        (gr) =>
          (!gr.triggerType ||
            gr.triggerType === 'manual' ||
            gr.triggerType.startsWith('user_')) &&
          !!gr.imageUrl,
      ),
    [all],
  );
  return (
    <>
      <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <header className="px-5 py-3 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-amber-50 dark:bg-amber-900/30 flex items-center justify-center text-base">
              <Paintbrush className="w-4 h-4 text-amber-600 dark:text-amber-400" />
            </div>
            <div className="min-w-0">
              <h2 className="text-sm font-semibold">手動グラレコ</h2>
              <p className="text-xs text-muted-foreground">{isPending ? '読み込み中…' : `${manualItems.length}枚`}</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={() => setClipboardDialogOpen(true)}
              title="クリップボードのテキストからグラレコを生成"
            >
              <Plus className="w-3 h-3 mr-1" />
              クリップボードから生成
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setOpen((v) => !v)}>
              {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </Button>
          </div>
        </header>
        {open && (
          <div className="p-4 max-h-[640px] overflow-y-auto">
            {manualItems.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-6">
                手動グラレコはまだありません。右上「クリップボードから生成」または、
                サマリーの「選択範囲をグラレコ」から作成できます。
              </p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {manualItems.map((gr) => (
                  <div
                    key={gr.id}
                    className="group bg-slate-50 dark:bg-slate-800/30 rounded-lg overflow-hidden border border-slate-200 dark:border-slate-800 hover:shadow-md transition-shadow"
                  >
                    <button
                      type="button"
                      onClick={() => setDetail(gr)}
                      className="text-left block w-full"
                    >
                      <div className="aspect-video bg-white dark:bg-slate-900 overflow-hidden">
                        {gr.imageUrl && (
                          <img
                            src={grarecoThumbUrl(gr.imageUrl)}
                            alt="手動グラレコ"
                            loading="lazy"
                            className="w-full h-full object-cover group-hover:scale-[1.02] transition-transform"
                          />
                        )}
                      </div>
                      <div className="px-3 py-2 text-xs text-muted-foreground">
                        {new Date(gr.createdAt).toLocaleString('ja-JP', {
                          month: '2-digit',
                          day: '2-digit',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </div>
                    </button>
                    {shareControl?.active && gr.imageUrl && (
                      <div className="px-3 pb-2">
                        <GuestShareToggle
                          shared={!shareControl.isExcluded('grareco', String(gr.id))}
                          onToggle={() => shareControl.toggle('grareco', String(gr.id))}
                        />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </section>

      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          {detail && (
            <ManualGrarecoDetail
              gr={detail}
              onClose={() => setDetail(null)}
              onRevise={() => setRevisionTarget(detail)}
            />
          )}
        </DialogContent>
      </Dialog>

      <RevisionDialog
        target={revisionTarget}
        meetingId={meetingId}
        onClose={() => setRevisionTarget(null)}
      />

      <ClipboardAnalyzeDialog
        open={clipboardDialogOpen}
        onOpenChange={setClipboardDialogOpen}
        meetingId={meetingId}
        mode="grareco"
        title="クリップボードからグラレコ生成"
        onDone={() => toast({ title: 'グラレコ生成を開始しました' })}
      />
    </>
  );
}

function ManualGrarecoDetail({
  gr,
  onClose,
  onRevise,
}: {
  gr: GraphicRecordingRow;
  onClose: () => void;
  onRevise: () => void;
}) {
  const { toast } = useToast();
  const imageUrl = gr.imageUrl ?? '';
  const isMeetingEnd = gr.metadata?.source === 'auto_meeting_end';
  const detailTitle = isMeetingEnd ? '会議終了時のグラレコ' : '手動グラレコ';
  const sourceChars = gr.sourceText?.length ?? 0;
  const isLegacyTruncated = isMeetingEnd && gr.metadata?.sourceTextChars == null && sourceChars === 10000;
  const sourceLabel = isLegacyTruncated
    ? `📄 元にしたテキスト（保存は先頭 ${sourceChars.toLocaleString('ja-JP')}字のみ・グラレコ自体は全文から作成）を表示`
    : `📄 元にしたテキスト（全文 ${sourceChars.toLocaleString('ja-JP')}字）を表示`;
  const handleCopyImage = async () => {
    const isIOS =
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (isIOS) {
      toast({
        title: '画像を長押ししてコピーしてください',
        description: 'iOS では画像長押しで保存・コピーメニューが出ます',
      });
      return;
    }
    try {
      const res = await fetch(imageUrl);
      const originalBlob = await res.blob();
      const pngBlob = await new Promise<Blob>((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            reject(new Error('canvas error'));
            return;
          }
          ctx.drawImage(img, 0, 0);
          canvas.toBlob((b) => {
            if (b) resolve(b);
            else reject(new Error('toBlob failed'));
          }, 'image/png');
        };
        img.onerror = () => reject(new Error('image load error'));
        img.src = URL.createObjectURL(originalBlob);
      });
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
      toast({ title: '画像をコピーしました' });
    } catch {
      try {
        await navigator.clipboard.writeText(imageUrl);
        toast({ title: '画像URLをコピーしました' });
      } catch {
        toast({ title: 'コピーに失敗', variant: 'destructive' });
      }
    }
  };
  const handleDownload = () => {
    const a = document.createElement('a');
    a.href = imageUrl;
    a.download = `grareco-${gr.id}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };
  return (
    <>
      <DialogHeader>
        <DialogTitle>{detailTitle}</DialogTitle>
        <DialogDescription>{new Date(gr.createdAt).toLocaleString('ja-JP')}</DialogDescription>
      </DialogHeader>
      <div className="space-y-4 mt-4">
        {imageUrl && <img src={imageUrl} alt={detailTitle} className="w-full rounded-md border" />}
        {gr.sourceText && (
          <details className="text-xs" open={false}>
            <summary className="cursor-pointer text-sm font-medium mb-1">
              {sourceLabel}
            </summary>
            <div className="mt-2 p-3 bg-slate-50 dark:bg-slate-800/50 rounded-md whitespace-pre-wrap">
              {gr.sourceText}
            </div>
          </details>
        )}
        <div className="flex justify-end gap-2 pt-2 border-t">
          <Button variant="outline" size="sm" onClick={onRevise}>
            <Pencil className="w-4 h-4 mr-1.5" />
            修正
          </Button>
          <Button variant="outline" size="sm" onClick={handleCopyImage}>
            <Copy className="w-4 h-4 mr-1.5" />
            画像をコピー
          </Button>
          <Button variant="outline" size="sm" onClick={handleDownload}>
            <Download className="w-4 h-4 mr-1.5" />
            ダウンロード
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose}>
            閉じる
          </Button>
        </div>
      </div>
    </>
  );
}

function RevisionDialog({
  target,
  meetingId,
  onClose,
}: {
  target: GraphicRecordingRow | null;
  meetingId: number;
  onClose: () => void;
}) {
  const [instruction, setInstruction] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const isOpen = !!target;
  useEffect(() => {
    if (isOpen) setInstruction('');
  }, [isOpen]);

  const handleSubmit = async () => {
    if (!target || !instruction.trim() || submitting) return;
    setSubmitting(true);
    try {
      await apiRequest(
        'POST',
        `/api/meetings/${meetingId}/graphic-recording/${target.id}/revise`,
        { instruction: instruction.trim() },
      );
      toast({ title: 'グラレコを修正しました' });
      queryClient.invalidateQueries({
        queryKey: ['/api/meetings', meetingId, 'graphic-recordings'],
      });
      onClose();
    } catch (err) {
      toast({
        title: '修正に失敗',
        description: err instanceof Error ? err.message : 'エラー',
        variant: 'destructive',
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>グラレコを修正</DialogTitle>
          <DialogDescription>
            どのように直したいか、指示を自然文で入力してください
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 mt-3">
          <Textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder="例: タイトルを「Q3 進捗まとめ」に変更し、リスク欄を追加してください"
            rows={4}
            disabled={submitting}
          />
          <div className="flex justify-end gap-2 pt-2 border-t">
            <Button variant="ghost" size="sm" onClick={onClose} disabled={submitting}>
              キャンセル
            </Button>
            <Button size="sm" onClick={handleSubmit} disabled={!instruction.trim() || submitting}>
              {submitting ? (
                <>
                  <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
                  修正中…
                </>
              ) : (
                '修正を実行'
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const ANALYSIS_TYPES: Array<{ value: string; label: string }> = [
  { value: 'minutes', label: '議事録' },
  { value: 'research', label: 'リサーチ' },
  { value: 'summary', label: '要約' },
  { value: 'logic', label: 'ロジック分析' },
];

const HIDDEN_ANALYSIS_TYPES = new Set(['expert', 'user', 'creator']);

function ClipboardAnalyzeDialog({
  open,
  onOpenChange,
  meetingId,
  mode,
  title,
  onDone,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  meetingId: number;
  mode: 'grareco' | 'analyze';
  title: string;
  onDone?: () => void;
}) {
  const [clip, setClip] = useState('');
  const [clipError, setClipError] = useState(false);
  const [analysisType, setAnalysisType] = useState('minutes');
  const [additionalContext, setAdditionalContext] = useState('');
  const [additionalPrompt, setAdditionalPrompt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!open) return;
    setClip('');
    setClipError(false);
    setAdditionalContext('');
    setAdditionalPrompt('');
    navigator.clipboard
      .readText()
      .then((text) => {
        if (text && text.trim()) setClip(text.trim());
      })
      .catch(() => setClipError(true));
  }, [open]);

  const handleSubmit = async () => {
    if (!clip.trim() || submitting) return;
    setSubmitting(true);
    try {
      const type = mode === 'grareco' ? 'grareco' : analysisType;
      await apiRequest('POST', `/api/meetings/${meetingId}/analyze`, {
        type,
        content: clip.trim(),
        additionalContext: additionalContext.trim() || undefined,
        additionalPrompt: additionalPrompt.trim() || undefined,
      });
      toast({
        title: mode === 'grareco' ? 'グラレコ生成を開始しました' : 'AI 分析を開始しました',
      });
      queryClient.invalidateQueries({
        queryKey: [
          '/api/meetings',
          meetingId,
          mode === 'grareco' ? 'graphic-recordings' : 'analyses',
        ],
      });
      onDone?.();
      onOpenChange(false);
    } catch (err) {
      toast({
        title: '失敗',
        description: err instanceof Error ? err.message : 'エラー',
        variant: 'destructive',
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Clipboard className="w-4 h-4" />
            {title}
          </DialogTitle>
          <DialogDescription>
            クリップボードのテキストを入力ソースに{mode === 'grareco' ? 'グラレコを生成' : 'AI分析を実行'}します
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 mt-3">
          {mode === 'analyze' && (
            <div>
              <label className="text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5 block">
                分析タイプ
              </label>
              <div className="flex flex-wrap gap-1.5">
                {ANALYSIS_TYPES.map((t) => (
                  <button
                    key={t.value}
                    type="button"
                    onClick={() => setAnalysisType(t.value)}
                    className={`px-2.5 py-1 rounded-full text-xs border transition-colors ${
                      analysisType === t.value
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-background border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800'
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div>
            <label className="text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5 block">
              入力テキスト（クリップボードから自動読込・編集可）
            </label>
            {clipError && (
              <p className="text-xs text-amber-600 mb-1">
                クリップボードの自動読込に失敗。下に直接ペーストしてください。
              </p>
            )}
            <Textarea
              value={clip}
              onChange={(e) => setClip(e.target.value)}
              placeholder="ここにテキストを貼り付け…"
              rows={8}
              disabled={submitting}
            />
            <p className="text-[11px] text-muted-foreground mt-1">{clip.length} 文字</p>
          </div>

          <details>
            <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
              追加の文脈・指示（任意）
            </summary>
            <div className="mt-2 space-y-2">
              <Textarea
                value={additionalContext}
                onChange={(e) => setAdditionalContext(e.target.value)}
                placeholder="補足の文脈（例: 「これは Q3 振り返りミーティング」）"
                rows={2}
                disabled={submitting}
              />
              <Textarea
                value={additionalPrompt}
                onChange={(e) => setAdditionalPrompt(e.target.value)}
                placeholder="追加の指示（例: 「英語で出力」「箇条書きで」）"
                rows={2}
                disabled={submitting}
              />
            </div>
          </details>

          <div className="flex justify-end gap-2 pt-2 border-t">
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={submitting}>
              キャンセル
            </Button>
            <Button size="sm" onClick={handleSubmit} disabled={!clip.trim() || submitting}>
              {submitting ? (
                <>
                  <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
                  生成中…
                </>
              ) : (
                '生成'
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface AnalysisRow {
  id: number;
  type: string;
  content: string;
  createdAt: string;
}

function AnalysesSection({ meetingId }: { meetingId: number }) {
  const [open, setOpen] = useState(false);
  const [clipboardDialogOpen, setClipboardDialogOpen] = useState(false);
  const { toast } = useToast();
  const { data: rawAnalyses = [] } = useQuery<AnalysisRow[]>({
    queryKey: ['/api/meetings', meetingId, 'analyses'],
    queryFn: () =>
      apiRequest('GET', `/api/meetings/${meetingId}/analyses`).then((r) => r.json()),
    enabled: meetingId > 0,
    refetchInterval: 30000,
  });
  const analyses = useMemo(
    () => rawAnalyses.filter((a) => !HIDDEN_ANALYSIS_TYPES.has(a.type)),
    [rawAnalyses],
  );
  return (
    <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
      <header className="px-5 py-3 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-sky-50 dark:bg-sky-900/30 flex items-center justify-center text-base">
            <Sparkle className="w-4 h-4 text-sky-600 dark:text-sky-400" />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">AI 分析</h2>
            <p className="text-xs text-muted-foreground">{analyses.length}件</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => setClipboardDialogOpen(true)}
            title="クリップボードのテキストから AI 分析を実行"
          >
            <Plus className="w-3 h-3 mr-1" />
            クリップボードから分析
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setOpen((v) => !v)}>
            {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </Button>
        </div>
      </header>
      {open && (
        <div className="p-3 space-y-2 max-h-[640px] overflow-y-auto">
          {analyses.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              AI 分析はまだありません。右上「クリップボードから分析」または、
              アシスタントに「議事録を生成して」と頼んで生成できます。
            </p>
          ) : (
            analyses.map((a) => (
              <AnalysisCard
                key={a.id}
                analysis={a}
                onCopy={() => copyTextToClipboard(a.content, analysisTypeLabel(a.type), toast)}
              />
            ))
          )}
        </div>
      )}

      <ClipboardAnalyzeDialog
        open={clipboardDialogOpen}
        onOpenChange={setClipboardDialogOpen}
        meetingId={meetingId}
        mode="analyze"
        title="クリップボードから AI 分析"
      />
    </section>
  );
}

function AnalysisCard({
  analysis,
  onCopy,
}: {
  analysis: AnalysisRow;
  onCopy: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const label = analysisTypeLabel(analysis.type);
  return (
    <div className="border border-slate-200 dark:border-slate-800 rounded-lg p-3">
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-2 min-w-0">
          <span className="inline-flex shrink-0 text-[11px] font-medium px-2 py-0.5 rounded-full bg-sky-50 dark:bg-sky-900/30 text-sky-700 dark:text-sky-300">
            {label}
          </span>
          <span className="text-xs text-muted-foreground">
            {new Date(analysis.createdAt).toLocaleString('ja-JP', {
              month: '2-digit',
              day: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={onCopy}
            className="text-muted-foreground hover:text-foreground text-[11px] inline-flex items-center gap-0.5 px-1.5 py-0.5 hover:bg-slate-50 dark:hover:bg-slate-800 rounded"
          >
            <Copy className="w-3 h-3" />
            コピー
          </button>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="text-muted-foreground hover:text-foreground"
            aria-label={expanded ? '閉じる' : '展開'}
          >
            {expanded ? (
              <ChevronUp className="w-3.5 h-3.5" />
            ) : (
              <ChevronDown className="w-3.5 h-3.5" />
            )}
          </button>
        </div>
      </div>
      <div className={`text-xs text-slate-700 dark:text-slate-300 whitespace-pre-wrap ${expanded ? '' : 'line-clamp-3'}`}>
        {analysis.content}
      </div>
    </div>
  );
}

function analysisTypeLabel(t: string): string {
  switch (t) {
    case 'minutes':
      return '議事録';
    case 'research':
      return 'リサーチ';
    case 'summary':
      return '要約';
    case 'logic':
      return 'ロジック分析';
    case 'expert':
      return '専門家視点';
    case 'user':
      return 'ユーザー視点';
    case 'creator':
      return 'クリエイター視点';
    case 'graphic':
      return 'グラフィック';
    case 'grareco':
      return 'グラレコ';
    default:
      return t;
  }
}

function TranscriptSection({
  transcripts,
  onCopyAll,
  ngKeywords,
  onSaveNgKeywords,
}: {
  transcripts: Array<{ id: number; speaker: string | null; content: string; startTime: number; ngExcluded?: boolean }>;
  onCopyAll: () => void;
  ngKeywords: string[];
  onSaveNgKeywords: (keywords: string[]) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [ngInput, setNgInput] = useState('');
  const [ngSaving, setNgSaving] = useState(false);
  const visible = showAll ? transcripts : transcripts.slice(-15);
  const excludedCount = transcripts.filter((t) => t.ngExcluded).length;

  const addNgKeyword = async () => {
    const kw = ngInput.trim();
    if (!kw || ngSaving) return;
    if (ngKeywords.includes(kw)) {
      setNgInput('');
      return;
    }
    setNgSaving(true);
    try {
      await onSaveNgKeywords([...ngKeywords, kw]);
      setNgInput('');
    } finally {
      setNgSaving(false);
    }
  };

  const removeNgKeyword = async (kw: string) => {
    if (ngSaving) return;
    setNgSaving(true);
    try {
      await onSaveNgKeywords(ngKeywords.filter((k) => k !== kw));
    } finally {
      setNgSaving(false);
    }
  };

  return (
    <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
      <header className="px-5 py-3 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-base">
            📝
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">文字起こし</h2>
            <p className="text-xs text-muted-foreground">
              {transcripts.length} 発言
              {excludedCount > 0 && `（うち NG 除外 ${excludedCount} 件）`}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={onCopyAll}
            disabled={transcripts.length === 0}
          >
            <Copy className="w-3.5 h-3.5 mr-1" />
            全文をコピー
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setOpen((v) => !v)}>
            {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </Button>
        </div>
      </header>
      {open && (
        <div className="p-4">
          <div className="mb-4 p-3 rounded-lg bg-slate-50 dark:bg-slate-800/50 border border-slate-100 dark:border-slate-800">
            <p className="text-xs font-medium text-slate-700 dark:text-slate-300 mb-2">
              NGワード（誤認識・幻聴の除外）
            </p>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {ngKeywords.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  未登録。実際には発言していない単語が混入した場合に登録すると、該当行が出力から除外されます。
                </p>
              ) : (
                ngKeywords.map((kw) => (
                  <Badge key={kw} variant="secondary" className="text-xs gap-1 pr-1">
                    {kw}
                    <button
                      type="button"
                      onClick={() => removeNgKeyword(kw)}
                      disabled={ngSaving}
                      className="rounded-full hover:bg-slate-300 dark:hover:bg-slate-600 p-0.5"
                      aria-label={`NGワード「${kw}」を削除`}
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </Badge>
                ))
              )}
            </div>
            <div className="flex gap-1.5">
              <input
                type="text"
                value={ngInput}
                onChange={(e) => setNgInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void addNgKeyword();
                  }
                }}
                placeholder="除外したい単語を入力"
                maxLength={100}
                className="h-7 flex-1 min-w-0 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 text-xs"
              />
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={() => void addNgKeyword()}
                disabled={ngSaving || !ngInput.trim()}
              >
                <Plus className="w-3.5 h-3.5 mr-0.5" />
                追加
              </Button>
            </div>
          </div>

          {transcripts.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              発言はまだありません
            </p>
          ) : (
            <>
              <div className="space-y-1.5 text-sm max-h-[500px] overflow-y-auto pr-1">
                {visible.map((t) => (
                  <div key={t.id} className={`flex gap-3 ${t.ngExcluded ? 'opacity-40' : ''}`}>
                    <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums w-16 mt-0.5">
                      {formatHrMinSec(t.startTime)}
                    </span>
                    <div className="min-w-0">
                      {t.ngExcluded && (
                        <Badge variant="outline" className="text-[10px] mr-1.5 px-1 py-0 align-middle">
                          NG
                        </Badge>
                      )}
                      {t.speaker && (
                        <span className="text-xs font-medium text-slate-700 dark:text-slate-300 mr-2">
                          {t.speaker}:
                        </span>
                      )}
                      <span className={t.ngExcluded ? 'line-through' : ''}>{t.content}</span>
                    </div>
                  </div>
                ))}
              </div>
              {transcripts.length > 15 && (
                <div className="mt-3 pt-3 border-t border-slate-100 dark:border-slate-800 text-center">
                  <Button variant="ghost" size="sm" onClick={() => setShowAll((v) => !v)}>
                    {showAll ? '直近15件のみ表示' : `全 ${transcripts.length} 件を表示`}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

function SettingsSection({
  showResearch,
  showAutoGrareco,
  researchSettings,
  updateResearchSettings,
  onToggleSubAgent,
}: {
  showResearch: boolean;
  showAutoGrareco: boolean;
  researchSettings: ResearchSettings;
  updateResearchSettings: (patch: Partial<ResearchSettings>) => Promise<void>;
  onToggleSubAgent: (key: 'main') => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
      <header className="px-5 py-3 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-slate-100 dark:bg-slate-800 flex items-center justify-center">
            <Settings className="w-4 h-4 text-slate-500" />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">自動処理の調整</h2>
            <p className="text-xs text-muted-foreground">
              {[showResearch && 'リアルタイム調査', showAutoGrareco && '自動グラレコ'].filter(Boolean).join(' / ')}
            </p>
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={() => setOpen((v) => !v)}>
          {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </Button>
      </header>
      {open && (
        <div className="p-4 space-y-4">
          {showResearch && (
          <div>
            <div className="text-xs font-medium text-slate-700 dark:text-slate-300 mb-2">
              リアルタイム調査
            </div>
            <button
              type="button"
              onClick={() => onToggleSubAgent('main')}
              className={`w-full flex items-center justify-between gap-2 px-3 py-2.5 rounded-md border text-sm transition-colors ${
                researchSettings.main
                  ? 'border-emerald-300 dark:border-emerald-700 bg-emerald-50 dark:bg-emerald-900/20'
                  : 'border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/30'
              }`}
            >
              <span className="flex items-center gap-2 min-w-0">
                <span>🧠</span>
                <span className="font-medium">リアルタイム調査</span>
                <span className="text-xs text-muted-foreground">
                  発言から自動で補足情報・事実確認・論理課題・技術情報を調査
                </span>
              </span>
              <span
                className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border ${
                  researchSettings.main
                    ? 'bg-emerald-500 border-emerald-500'
                    : 'bg-slate-200 dark:bg-slate-700 border-slate-300 dark:border-slate-600'
                }`}
              >
                <span
                  className={`inline-block w-3.5 h-3.5 rounded-full bg-white shadow transition-transform ${
                    researchSettings.main ? 'translate-x-4' : 'translate-x-0.5'
                  } translate-y-0.5`}
                />
              </span>
            </button>
          </div>
          )}

          {showAutoGrareco && (
          <div>
            <div className="text-xs font-medium text-slate-700 dark:text-slate-300 mb-2">
              自動グラレコ
            </div>
            <AutoGrarecoSettingsCard settings={researchSettings} onUpdate={updateResearchSettings} />
          </div>
          )}
        </div>
      )}
    </section>
  );
}

function StatusFooter({
  isLive,
  grarecoItems,
  grarecoLoading,
  researchCount,
  showGrareco,
  showResearch,
}: {
  isLive: boolean;
  showGrareco: boolean;
  showResearch: boolean;
  grarecoItems: GrarecoFeedItem[];
  grarecoLoading?: boolean;
  researchCount: number;
}) {
  const drawing = grarecoItems.some((i) => i.isPromoting);
  const recorded = ['文字起こし', ...(showGrareco ? ['グラレコ'] : []), ...(showResearch ? ['補足情報'] : [])].join('・');
  return (
    <footer className="mt-2 pt-4 border-t border-slate-200 dark:border-slate-800 text-center text-xs text-muted-foreground space-y-1.5">
      <p>AI が{recorded}を{isLive ? '記録しています' : '記録しました'}。</p>
      {isLive && (
        <p>この会議は現在文字起こし中です（デスクトップ / iPhone アプリで進行中）。文字起こしの終了はアプリ側で行えます。</p>
      )}
      <div className="flex items-center justify-center flex-wrap gap-x-3 gap-y-1 pt-1">
        <StatusBullet
          active={isLive}
          label={isLive ? '📝 文字起こし 記録中' : '📝 文字起こし 完了'}
        />
        {showGrareco && (
          <>
            <Sep />
            <StatusBullet
              active={drawing}
              label={drawing ? '🎨 グラレコ 描画中' : grarecoLoading ? '🎨 グラレコ …' : `🎨 グラレコ ${grarecoItems.length}枚`}
            />
          </>
        )}
        {showResearch && (
          <>
            <Sep />
            <StatusBullet active={isLive} label={`🔍 リサーチ ${researchCount}件`} />
          </>
        )}
      </div>
    </footer>
  );
}

function StatusBullet({ active, label }: { active: boolean; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={`w-1.5 h-1.5 rounded-full ${active ? 'bg-emerald-500 animate-pulse' : 'bg-slate-300 dark:bg-slate-600'}`}
      />
      <span>{label}</span>
    </span>
  );
}

function Sep() {
  return <span className="text-slate-300 dark:text-slate-700">·</span>;
}

function ResearchCardDetailView({ card, onClose }: { card: ResearchCard; onClose: () => void }) {
  const { toast } = useToast();
  const pill = researchPillStyle(card.cardType);
  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <span className={`inline-flex text-xs font-medium px-2 py-0.5 rounded-full ${pill.bg} ${pill.text}`}>
            {pill.label}
          </span>
          <span className="text-sm text-muted-foreground">{card.keyword}</span>
        </DialogTitle>
        <DialogDescription className="text-base font-semibold text-foreground mt-2">
          {card.title}
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-4 mt-4">
        {card.body && (
          <div className="prose prose-sm dark:prose-invert max-w-none whitespace-pre-wrap">
            {card.body}
          </div>
        )}
        {card.sources && card.sources.length > 0 && (
          <div className="space-y-2">
            <div className="text-sm font-medium">出典</div>
            <ul className="space-y-1 text-sm">
              {card.sources.map((s, i) => (
                <li key={i}>
                  <a
                    href={safeHref(s.url)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:underline break-all"
                  >
                    {s.title || s.url}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="flex justify-end gap-2 pt-2 border-t">
          <Button
            variant="outline"
            size="sm"
            onClick={() => copyTextToClipboard(formatResearchCardForCopy(card), card.title, toast)}
          >
            <Copy className="w-4 h-4 mr-1.5" />
            コピー
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose}>
            閉じる
          </Button>
        </div>
      </div>
    </>
  );
}

function GrarecoDetailView({
  item,
  fullscreen,
  onToggleFullscreen,
  onClose,
  onPromote,
  onCancelPromote,
  onPin,
  onJumpToResearchInsight,
}: {
  item: GrarecoFeedItem;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  onClose: () => void;
  onPromote: () => void;
  onCancelPromote: () => void;
  onPin: () => void;
  onJumpToResearchInsight: (insightId: number) => void;
}) {
  const { toast } = useToast();
  const title = item.draft?.title ?? '無題のグラレコ';
  const handleCopyImage = () => copyGrarecoImage(item, toast);
  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center justify-between gap-2 pr-8">
          <span className="truncate">{title}</span>
          <Button variant="ghost" size="sm" onClick={onToggleFullscreen} className="shrink-0">
            <Maximize2 className="w-4 h-4 mr-1.5" />
            {fullscreen ? '通常サイズ' : '最大化'}
          </Button>
        </DialogTitle>
        <DialogDescription>
          {new Date(item.receivedAt).toLocaleString('ja-JP')}
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4 mt-4">
        <StageDraftCard
          recordingId={item.recordingId}
          triggerType={item.triggerType}
          draft={item.draft}
          receivedAt={item.receivedAt}
          isPromoting={item.isPromoting}
          hasImage={!!item.imageUrl}
          willAutoPromote={item.willAutoPromote}
          cancelDeadlineMs={item.cancelDeadlineMs}
          isPinned={item.pinned}
          skippedReason={item.skippedReason}
          onPromoteToImage={onPromote}
          onCancelPromote={onCancelPromote}
          onPin={onPin}
          onJumpToResearchInsight={onJumpToResearchInsight}
        />

        {item.imageUrl && (
          <div className="pt-2">
            <img
              src={item.imageUrl}
              alt={title}
              className={`w-full rounded-md border ${fullscreen ? 'max-h-[60vh] object-contain' : ''}`}
            />
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2 border-t">
          {item.imageUrl && (
            <Button variant="outline" size="sm" onClick={handleCopyImage}>
              <Copy className="w-4 h-4 mr-1.5" />
              画像をコピー
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onClose}>
            閉じる
          </Button>
        </div>
      </div>
    </>
  );
}

const ASSISTANT_SIZE_KEY = 'assistant-panel-size';
const ASSISTANT_MIN_W = 320;
const ASSISTANT_MIN_H = 360;

function clampAssistantSize(w: number, h: number): { width: number; height: number } {
  const maxW = Math.max(ASSISTANT_MIN_W, window.innerWidth - 48);
  const maxH = Math.max(ASSISTANT_MIN_H, window.innerHeight - 160);
  return {
    width: Math.min(Math.max(w, ASSISTANT_MIN_W), maxW),
    height: Math.min(Math.max(h, ASSISTANT_MIN_H), maxH),
  };
}

function loadAssistantSize(): { width: number; height: number } {
  try {
    const raw = localStorage.getItem(ASSISTANT_SIZE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (typeof parsed?.width === 'number' && typeof parsed?.height === 'number') {
        return clampAssistantSize(parsed.width, parsed.height);
      }
    }
  } catch {
  }
  return clampAssistantSize(420, Math.round(window.innerHeight * 0.6));
}

function ChatFab({
  open,
  onOpenChange,
  meetingId,
  viewerSocketRef,
  onShowGrareco,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  meetingId: number;
  viewerSocketRef: React.MutableRefObject<Socket | null>;
  onShowGrareco?: (recordingId: number) => void;
}) {
  const [size, setSize] = useState(() => loadAssistantSize());
  const dragRef = useRef<{ axis: 'x' | 'y' | 'both'; startX: number; startY: number; startW: number; startH: number } | null>(null);

  useEffect(() => {
    const onWindowResize = () => setSize((s) => clampAssistantSize(s.width, s.height));
    window.addEventListener('resize', onWindowResize);
    return () => window.removeEventListener('resize', onWindowResize);
  }, []);

  const onResizePointerDown = (axis: 'x' | 'y' | 'both') => (e: React.PointerEvent) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { axis, startX: e.clientX, startY: e.clientY, startW: size.width, startH: size.height };
    document.body.style.userSelect = 'none';
  };

  const onResizePointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = d.startX - e.clientX;
    const dy = d.startY - e.clientY;
    const nextW = d.axis === 'y' ? d.startW : d.startW + dx;
    const nextH = d.axis === 'x' ? d.startH : d.startH + dy;
    setSize(clampAssistantSize(nextW, nextH));
  };

  const onResizePointerUp = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    document.body.style.userSelect = '';
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
    }
    try {
      localStorage.setItem(ASSISTANT_SIZE_KEY, JSON.stringify(size));
    } catch {
    }
  };

  const handleProps = (axis: 'x' | 'y' | 'both') => ({
    onPointerDown: onResizePointerDown(axis),
    onPointerMove: onResizePointerMove,
    onPointerUp: onResizePointerUp,
  });

  const showHistoryBadge = !open && hasChatHistory(meetingId);

  return (
    <>
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        className={`fixed bottom-6 right-6 z-40 w-14 h-14 rounded-full shadow-lg flex items-center justify-center transition-all ${
          open ? 'bg-slate-200 text-slate-600' : 'bg-purple-600 hover:bg-purple-700 text-white hover:scale-110'
        }`}
        aria-label={open ? 'アシスタントを最小化' : 'アシスタントを開く'}
      >
        {open ? <X className="w-6 h-6" /> : <Sparkles className="w-6 h-6" />}
        {showHistoryBadge && (
          <span
            className="absolute -top-0.5 -right-0.5 w-3.5 h-3.5 rounded-full bg-emerald-500 border-2 border-white dark:border-slate-900"
            aria-hidden="true"
          />
        )}
      </button>
      {open && (
        <div
          className="fixed bottom-24 right-6 z-40 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg shadow-2xl flex flex-col"
          style={{ width: size.width, height: size.height }}
        >
          <div
            {...handleProps('x')}
            className="absolute top-2 left-0 bottom-2 w-1.5 -ml-px cursor-ew-resize rounded-full hover:bg-purple-300/60 transition-colors"
            aria-label="幅を変更"
            role="separator"
          />
          <div
            {...handleProps('y')}
            className="absolute left-2 right-2 top-0 h-1.5 -mt-px cursor-ns-resize rounded-full hover:bg-purple-300/60 transition-colors"
            aria-label="高さを変更"
            role="separator"
          />
          <div
            {...handleProps('both')}
            className="absolute top-0 left-0 w-4 h-4 cursor-nwse-resize z-10"
            aria-label="サイズを変更"
            role="separator"
          >
            <span className="absolute top-1 left-1 w-2.5 h-2.5 border-l-2 border-t-2 border-slate-300 dark:border-slate-600 rounded-tl-sm" />
          </div>
          <div className="p-4 overflow-hidden flex-1 min-h-0">
            <AgentChatPanel
              meetingId={meetingId}
              viewerSocketRef={viewerSocketRef}
              onMinimize={() => onOpenChange(false)}
              onShowGrareco={onShowGrareco}
            />
          </div>
        </div>
      )}
    </>
  );
}

function formatResearchCardForCopy(card: ResearchCard): string {
  const pill = researchPillStyle(card.cardType);
  const lines: string[] = [];
  lines.push(`【${pill.label}】 ${card.keyword}`);
  lines.push(`■ ${card.title}`);
  if (card.body) lines.push('', card.body);
  if (card.sources && card.sources.length > 0) {
    lines.push('', '出典:');
    for (const s of card.sources) {
      lines.push(`- ${s.title || s.url} (${s.url})`);
    }
  }
  return lines.join('\n');
}

async function copyTextToClipboard(
  text: string,
  label: string,
  toast: (args: { title: string; description?: string; variant?: 'destructive' }) => void,
) {
  if (!text.trim()) {
    toast({ title: 'コピーする内容がありません', variant: 'destructive' });
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    toast({ title: `「${label}」をコピーしました`, description: `${text.length} 文字` });
  } catch (err) {
    const msg = err instanceof Error ? err.message : '不明';
    toast({ title: 'コピーに失敗', description: msg, variant: 'destructive' });
  }
}

async function copyGrarecoImage(
  item: GrarecoFeedItem,
  toast: (args: { title: string; description?: string; variant?: 'destructive' }) => void,
) {
  if (!item.imageUrl) {
    toast({ title: '画像はまだ生成されていません', variant: 'destructive' });
    return;
  }
  const isIOS =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (isIOS) {
    toast({
      title: '画像を長押ししてコピーしてください',
      description: 'iOS では画像長押しで保存・コピーメニューが出ます',
    });
    return;
  }
  try {
    const res = await fetch(item.imageUrl);
    const originalBlob = await res.blob();
    const pngBlob = await new Promise<Blob>((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('canvas error'));
          return;
        }
        ctx.drawImage(img, 0, 0);
        canvas.toBlob((b) => {
          if (b) resolve(b);
          else reject(new Error('toBlob failed'));
        }, 'image/png');
      };
      img.onerror = () => reject(new Error('image load error'));
      img.src = URL.createObjectURL(originalBlob);
    });
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
    toast({ title: '画像をコピーしました' });
  } catch {
    try {
      await navigator.clipboard.writeText(item.imageUrl);
      toast({ title: '画像URLをコピーしました（画像本体のコピーに失敗）' });
    } catch {
      toast({ title: 'コピーに失敗しました', variant: 'destructive' });
    }
  }
}

function formatDateTime(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function formatMsToClock(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatHrMinSec(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatTimecodeFromMeeting(receivedAt: number, meeting: Meeting | undefined): string {
  if (!meeting) return '';
  const start = new Date(meeting.startedAt).getTime();
  const elapsed = Math.max(0, receivedAt - start);
  return formatMsToClock(elapsed);
}

function summarizeStats(content: string | null | undefined): SummaryStats {
  if (!content) return { topics: 0, decisions: 0, todos: 0 };
  const topicRe = /(?:^|\n)(?:#+\s*|【)?(?:論点|議題|テーマ|トピック)/g;
  const decisionRe = /(?:^|\n)(?:#+\s*|【)?(?:決定事項|合意|決まった|決議)/g;
  const todoRe = /(?:^|\n)(?:[-*]\s*\[\s\]|【)?(?:ToDo|TODO|宿題|アクション)/gi;
  return {
    topics: (content.match(topicRe) ?? []).length,
    decisions: (content.match(decisionRe) ?? []).length,
    todos: (content.match(todoRe) ?? []).length,
  };
}
