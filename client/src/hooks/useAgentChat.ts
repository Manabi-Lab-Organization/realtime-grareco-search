import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Socket } from 'socket.io-client';
import { api } from '@/lib/api';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolLog?: Array<{ name: string; displayLabel: string; isError?: boolean }>;
  isError?: boolean;
  isStatus?: boolean;
  isPending?: boolean;
  isStreaming?: boolean;
}

const chatHistories = new Map<number, ChatMessage[]>();

export function hasChatHistory(meetingId: number): boolean {
  return (chatHistories.get(meetingId)?.length ?? 0) > 0;
}

interface SendingState {
  sending: boolean;
  subscribers: Set<() => void>;
}
const sendingStates = new Map<number, SendingState>();

function getSendingState(meetingId: number): SendingState {
  let s = sendingStates.get(meetingId);
  if (!s) {
    s = { sending: false, subscribers: new Set() };
    sendingStates.set(meetingId, s);
  }
  return s;
}

function setSending(meetingId: number, sending: boolean): void {
  const s = getSendingState(meetingId);
  if (s.sending === sending) return;
  s.sending = sending;
  for (const cb of s.subscribers) cb();
}

const TOOLS_REQUIRING_MEETING_REFETCH = new Set<string>([
  'generate_summary',
  'trigger_manual_grareco',
  'promote_grareco_draft',
  'trigger_manual_research',
  'update_meeting_title',
  'update_meeting_type',
  'add_participant',
  'update_participant',
  'add_memo',
  'update_memo',
  'trigger_ai_analysis',
]);

function genId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function useAgentChat(
  meetingId: number,
  socketRef?: React.MutableRefObject<Socket | null>,
  onShowGrareco?: (recordingId: number) => void
) {
  const [messages, setMessages] = useState<ChatMessage[]>(
    () => chatHistories.get(meetingId) ?? []
  );
  const [, forceTick] = useState(0);
  const isSending = getSendingState(meetingId).sending;
  useEffect(() => {
    const s = getSendingState(meetingId);
    const cb = () => forceTick((n) => n + 1);
    s.subscribers.add(cb);
    return () => {
      s.subscribers.delete(cb);
    };
  }, [meetingId]);

  useEffect(() => {
    const stored = chatHistories.get(meetingId);
    if (stored && stored !== messages) setMessages(stored);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meetingId]);

  const queryClient = useQueryClient();

  useEffect(() => {
    chatHistories.set(meetingId, messages);
  }, [meetingId, messages]);

  const pendingResearchIdRef = useRef<string | null>(null);
  useEffect(() => {
    const socket = socketRef?.current;
    if (!socket) return;

    type StartedPayload = { meetingId?: number };
    type DonePayload = { meetingId?: number; ok: boolean; cardCount?: number; error?: string };

    const onStarted = (data: StartedPayload) => {
      if (typeof data?.meetingId === 'number' && data.meetingId !== meetingId) return;
      const id = `research-pending-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      pendingResearchIdRef.current = id;
      const next: ChatMessage[] = [
        ...(chatHistories.get(meetingId) ?? []),
        {
          id,
          role: 'assistant',
          content: '🔍 リサーチ実行中…（完了まで 30〜90 秒）',
          isStatus: true,
          isPending: true,
        },
      ];
      chatHistories.set(meetingId, next);
      setMessages(next);
    };

    const onDone = (data: DonePayload) => {
      if (typeof data?.meetingId === 'number' && data.meetingId !== meetingId) return;
      const pendingId = pendingResearchIdRef.current;
      pendingResearchIdRef.current = null;
      let content: string;
      let isError = false;
      if (!data.ok) {
        const map: Record<string, string> = {
          busy: '別のリサーチが実行中です。少し待ってから再試行してください。',
        };
        content = `❌ リサーチに失敗しました: ${data.error ? map[data.error] ?? data.error : '原因不明'}`;
        isError = true;
      } else {
        const n = data.cardCount ?? 0;
        content = n > 0
          ? `✅ リサーチ完了：${n}件の調査カードを追加しました`
          : '⚠️ リサーチ完了：新しい調査結果はありませんでした';
      }
      const prev = chatHistories.get(meetingId) ?? [];
      const filtered = pendingId ? prev.filter((m) => m.id !== pendingId) : prev;
      const next: ChatMessage[] = [
        ...filtered,
        {
          id: genId(),
          role: 'assistant',
          content,
          isStatus: true,
          isError,
        },
      ];
      chatHistories.set(meetingId, next);
      setMessages(next);
    };

    socket.on('manual_research_started', onStarted);
    socket.on('manual_research_done', onDone);
    return () => {
      socket.off('manual_research_started', onStarted);
      socket.off('manual_research_done', onDone);
    };
  }, [meetingId, socketRef]);

  const appendMessage = useCallback(
    (m: ChatMessage) => {
      const next = [...(chatHistories.get(meetingId) ?? []), m];
      chatHistories.set(meetingId, next);
      setMessages(next);
    },
    [meetingId],
  );

  const patchMessage = useCallback(
    (id: string, patch: Partial<ChatMessage>) => {
      const cur = chatHistories.get(meetingId) ?? [];
      const next = cur.map((m) => (m.id === id ? { ...m, ...patch } : m));
      chatHistories.set(meetingId, next);
      setMessages(next);
    },
    [meetingId],
  );

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;

      if (getSendingState(meetingId).sending) {
        appendMessage({
          id: genId(),
          role: 'assistant',
          content: '⏳ 前の指示がまだ処理中です。完了をお待ちください。',
          isStatus: true,
        });
        return;
      }

      const userMsg: ChatMessage = { id: genId(), role: 'user', content: trimmed };
      const current = chatHistories.get(meetingId) ?? [];
      const optimistic = [...current, userMsg];
      chatHistories.set(meetingId, optimistic);
      setMessages(optimistic);
      setSending(meetingId, true);

      const assistantId = genId();
      const assistantBase: ChatMessage = {
        id: assistantId,
        role: 'assistant',
        content: '',
        toolLog: [],
        isStreaming: true,
      };
      const withAssistant = [...optimistic, assistantBase];
      chatHistories.set(meetingId, withAssistant);
      setMessages(withAssistant);

      let accumulatedText = '';
      const accumulatedTools: NonNullable<ChatMessage['toolLog']> = [];
      const completedToolEntries: Array<{
        name: string;
        isError?: boolean;
        clientAction?:
          | { type: 'copy_clipboard'; text: string; label: string }
          | { type: 'show_grareco'; recordingId: number };
      }> = [];

      try {
        const payload = optimistic.map((m) => ({ role: m.role, content: m.content }));
        for await (const event of api.agent.chatStream(meetingId, payload)) {
          if (event.type === 'text') {
            accumulatedText += event.text;
            patchMessage(assistantId, {
              content: accumulatedText,
              toolLog: [...accumulatedTools],
            });
          } else if (event.type === 'tool') {
            accumulatedTools.push({
              name: event.entry.name,
              displayLabel: event.entry.displayLabel,
              isError: event.entry.isError,
            });
            completedToolEntries.push({
              name: event.entry.name,
              isError: event.entry.isError,
              clientAction: event.entry.clientAction,
            });
            patchMessage(assistantId, {
              content: accumulatedText,
              toolLog: [...accumulatedTools],
            });

            if (
              !event.entry.isError &&
              TOOLS_REQUIRING_MEETING_REFETCH.has(event.entry.name)
            ) {
              queryClient.invalidateQueries({ queryKey: ['/api/meetings', meetingId] });
            }
          } else if (event.type === 'error') {
            appendMessage({
              id: genId(),
              role: 'assistant',
              content: `エラー: ${event.error}`,
              isError: true,
            });
          } else if (event.type === 'done') {
            if (!accumulatedText) {
              patchMessage(assistantId, {
                content: '（応答なし）',
                toolLog: [...accumulatedTools],
                isStreaming: false,
              });
            } else {
              patchMessage(assistantId, { isStreaming: false });
            }
          }
        }

        for (const entry of completedToolEntries) {
          if (entry.isError) continue;
          if (entry.clientAction?.type === 'show_grareco') {
            try {
              onShowGrareco?.(entry.clientAction.recordingId);
            } catch (err) {
              console.warn('[useAgentChat] show_grareco action failed:', err);
            }
            continue;
          }
          if (entry.clientAction?.type === 'copy_clipboard') {
            const { text: copyText, label } = entry.clientAction;
            try {
              await navigator.clipboard.writeText(copyText);
              appendMessage({
                id: genId(),
                role: 'assistant',
                content: `📋 「${label}」をクリップボードにコピーしました（${copyText.length} 文字）`,
                isStatus: true,
              });
            } catch (clipErr) {
              const msg = clipErr instanceof Error ? clipErr.message : String(clipErr);
              appendMessage({
                id: genId(),
                role: 'assistant',
                content: `❌ クリップボードへのコピーに失敗しました: ${msg}`,
                isStatus: true,
                isError: true,
              });
            }
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        patchMessage(assistantId, {
          content: `エラー: ${msg}`,
          isError: true,
          isStreaming: false,
        });
      } finally {
        patchMessage(assistantId, { isStreaming: false });
        setSending(meetingId, false);
      }
    },
    [meetingId, queryClient, appendMessage, patchMessage, onShowGrareco]
  );

  const reset = useCallback(() => {
    setMessages([]);
    chatHistories.delete(meetingId);
  }, [meetingId]);

  const attachImage = useCallback(
    async (file: File) => {
      if (getSendingState(meetingId).sending) {
        appendMessage({
          id: genId(),
          role: 'assistant',
          content: '⏳ 処理中のため、完了後に画像を再添付してください。',
          isStatus: true,
        });
        return;
      }

      const pendingId = `image-pending-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      appendMessage({
        id: pendingId,
        role: 'assistant',
        content: `📎 画像「${file.name}」をアップロード・AI 分析中…（10〜30 秒）`,
        isStatus: true,
        isPending: true,
      });

      setSending(meetingId, true);
      try {
        const base64 = await fileToBase64(file);
        const result = await api.agent.attachImage(meetingId, {
          data: base64,
          mimeType: file.type || 'image/jpeg',
          fileName: file.name,
        });

        const prev = chatHistories.get(meetingId) ?? [];
        const filtered = prev.filter((m) => m.id !== pendingId);

        const success = !!result.aiAnalysis && !result.analysisFailed;
        const content = success
          ? `📎 画像「${result.fileName ?? file.name}」を添付し、AI 分析が完了しました。続けて依頼を入力してください（例: 「添付した画像とサマリーから論理整理して」）。`
          : `📎 画像「${result.fileName ?? file.name}」を添付しました。${result.analysisFailed ? 'AI 分析に失敗したため、再度お試しください。' : 'AI 分析が完了していません。少し待ってから再依頼してください。'}`;
        const next: ChatMessage[] = [
          ...filtered,
          {
            id: genId(),
            role: 'assistant',
            content,
            isStatus: true,
            isError: !success,
          },
        ];
        chatHistories.set(meetingId, next);
        setMessages(next);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const prev = chatHistories.get(meetingId) ?? [];
        const filtered = prev.filter((m) => m.id !== pendingId);
        const next: ChatMessage[] = [
          ...filtered,
          {
            id: genId(),
            role: 'assistant',
            content: `❌ 画像の添付に失敗しました: ${msg}`,
            isStatus: true,
            isError: true,
          },
        ];
        chatHistories.set(meetingId, next);
        setMessages(next);
      } finally {
        setSending(meetingId, false);
      }
    },
    [meetingId, appendMessage],
  );

  return { messages, isSending, send, reset, attachImage };
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('FileReader returned non-string'));
        return;
      }
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('FileReader error'));
    reader.readAsDataURL(file);
  });
}
