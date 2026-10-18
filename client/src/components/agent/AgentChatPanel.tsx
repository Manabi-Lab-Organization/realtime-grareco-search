import { useEffect, useRef, useState } from 'react';
import { Send, Sparkles, CheckCircle2, AlertCircle, Bot, User as UserIcon, Trash2, Loader2, Hourglass, Paperclip, Minus } from 'lucide-react';
import type { Socket } from 'socket.io-client';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useAgentChat, type ChatMessage } from '@/hooks/useAgentChat';

interface Props {
  meetingId: number;
  onShowGrareco?: (recordingId: number) => void;
  viewerSocketRef?: React.MutableRefObject<Socket | null>;
  onMinimize?: () => void;
}

const EXAMPLES = [
  '直近10分のサマリーを作って',
  '直近5分のサマリーからグラレコを作って',
  '直近5分の会話をもう一度リサーチして',
  '添付した画像とサマリーから論理整理して',
  'リアルタイム調査をオフにして',
  '自動グラレコをオフにして',
];

export function AgentChatPanel({ meetingId, viewerSocketRef, onMinimize, onShowGrareco }: Props) {
  const { messages, isSending, send, reset, attachImage } = useAgentChat(meetingId, viewerSocketRef, onShowGrareco);
  const [input, setInput] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, isSending]);

  const onSubmit = () => {
    if (!input.trim()) return;
    send(input);
    setInput('');
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onSubmit();
    }
  };

  const onPickFile = () => {
    if (isSending) return;
    fileInputRef.current?.click();
  };

  const handleImageFile = (file: File | null | undefined) => {
    if (!file) return false;
    if (!file.type.startsWith('image/')) {
      // eslint-disable-next-line no-alert
      alert('画像ファイルを選択してください');
      return false;
    }
    if (file.size > 20 * 1024 * 1024) {
      // eslint-disable-next-line no-alert
      alert('画像サイズが大きすぎます（20MB 以下にしてください）');
      return false;
    }
    attachImage(file);
    return true;
  };

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (e.target) e.target.value = '';
    handleImageFile(file);
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (isSending) return;
    const items = e.clipboardData?.items;
    if (!items || items.length === 0) return;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          handleImageFile(file);
          return;
        }
      }
    }
  };

  const onDragEnter = (e: React.DragEvent) => {
    if (isSending) return;
    if (Array.from(e.dataTransfer?.items ?? []).some((it) => it.kind === 'file')) {
      e.preventDefault();
      setIsDragging(true);
    }
  };
  const onDragOver = (e: React.DragEvent) => {
    if (isSending) return;
    if (Array.from(e.dataTransfer?.items ?? []).some((it) => it.kind === 'file')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  };
  const onDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget === e.target) setIsDragging(false);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (isSending) return;
    const file = e.dataTransfer?.files?.[0];
    handleImageFile(file);
  };

  return (
    <div
      className={`relative flex flex-col h-full min-h-0 ${isDragging ? 'ring-2 ring-purple-400 ring-offset-2 rounded-md' : ''}`}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-lg font-semibold flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-purple-500" />
          アシスタント
        </h3>
        <div className="flex items-center gap-1">
          {messages.length > 0 && (
            <Button variant="ghost" size="sm" onClick={reset} disabled={isSending}>
              <Trash2 className="w-4 h-4 mr-1.5" />
              クリア
            </Button>
          )}
          {onMinimize && (
            <Button
              variant="ghost"
              size="icon"
              onClick={onMinimize}
              title="最小化（あとで右下のボタンから戻せます）"
              aria-label="アシスタントを最小化"
            >
              <Minus className="w-4 h-4" />
            </Button>
          )}
        </div>
      </div>

      {isDragging && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-md bg-purple-50/90 dark:bg-purple-900/40 border-2 border-dashed border-purple-400">
          <div className="flex items-center gap-2 text-purple-700 dark:text-purple-200 font-medium">
            <Paperclip className="w-5 h-5" />
            ドロップして画像を添付
          </div>
        </div>
      )}

      {isSending && (
        <div className="mb-2 px-3 py-1.5 rounded-md bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300 text-xs flex items-center gap-2 border border-amber-200 dark:border-amber-800">
          <Hourglass className="w-3.5 h-3.5 animate-pulse" />
          <span className="font-medium">処理中…</span>
          <span className="text-amber-700/70 dark:text-amber-300/70">
            ツール呼び出し中です。完了まで自動更新されます
          </span>
        </div>
      )}

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto rounded-md border border-border bg-muted/30 p-4 space-y-4"
      >
        {messages.length === 0 ? (
          <EmptyState examples={EXAMPLES} onPick={(t) => setInput(t)} />
        ) : (
          messages.map((m) => <MessageRow key={m.id} message={m} />)
        )}
        {isSending && messages.length > 0 && (() => {
          const last = messages[messages.length - 1];
          const lastIsEmptyStreaming =
            last.role === 'assistant' &&
            last.isStreaming &&
            !last.content &&
            (!last.toolLog || last.toolLog.length === 0);
          if (!lastIsEmptyStreaming) return null;
          return (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Bot className="w-4 h-4" />
              考えています…
            </div>
          );
        })()}
      </div>

      <div className="mt-3 flex gap-2">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={onFileChange}
        />
        <Button
          variant="outline"
          size="icon"
          onClick={onPickFile}
          disabled={isSending}
          title="画像を添付して AI 分析"
          className="flex-shrink-0"
        >
          <Paperclip className="w-4 h-4" />
        </Button>
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
          onPaste={onPaste}
          placeholder="依頼を自然文で入力（画像は ⌘/Ctrl+V でペースト可。⌘/Ctrl+Enter で送信）"
          disabled={isSending}
          rows={2}
          className="flex-1 resize-none"
        />
        <Button onClick={onSubmit} disabled={isSending || !input.trim()}>
          <Send className="w-4 h-4 mr-1.5" />
          送信
        </Button>
      </div>
    </div>
  );
}

function EmptyState({ examples, onPick }: { examples: string[]; onPick: (text: string) => void }) {
  return (
    <div className="text-sm text-muted-foreground space-y-3">
      <p>会議の操作を自然文で依頼できます。例：</p>
      <ul className="space-y-1.5">
        {examples.map((ex) => (
          <li key={ex}>
            <button
              type="button"
              className="text-left hover:text-foreground hover:underline transition-colors"
              onClick={() => onPick(ex)}
            >
              ・{ex}
            </button>
          </li>
        ))}
      </ul>
      <p className="text-xs opacity-70">
        会議終了・削除などの破壊的操作には対応していません。曖昧な依頼は聞き返します。
      </p>
    </div>
  );
}

function MessageRow({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';

  if (message.isStatus) {
    return (
      <div className="flex justify-center my-1">
        <div
          className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full ${
            message.isError
              ? 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300'
              : message.isPending
                ? 'bg-muted text-muted-foreground'
                : 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300'
          }`}
        >
          {message.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          <span>{message.content}</span>
        </div>
      </div>
    );
  }

  return (
    <div className={`flex gap-3 ${isUser ? 'justify-end' : 'justify-start'}`}>
      {!isUser && (
        <div className="flex-shrink-0 w-7 h-7 rounded-full bg-purple-100 dark:bg-purple-900/50 flex items-center justify-center">
          <Bot className="w-4 h-4 text-purple-600 dark:text-purple-300" />
        </div>
      )}
      <div className={`max-w-[80%] ${isUser ? 'order-first' : ''}`}>
        <div
          className={`rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words ${
            isUser
              ? 'bg-primary text-primary-foreground'
              : message.isError
                ? 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300'
                : 'bg-background border border-border'
          }`}
        >
          {message.content}
        </div>
        {message.toolLog && message.toolLog.length > 0 && (
          <div className="mt-1.5 space-y-1">
            {message.toolLog.map((t, i) => (
              <div
                key={i}
                className={`flex items-center gap-1.5 text-xs ${
                  t.isError ? 'text-red-600 dark:text-red-400' : 'text-emerald-700 dark:text-emerald-400'
                }`}
              >
                {t.isError ? (
                  <AlertCircle className="w-3.5 h-3.5" />
                ) : (
                  <CheckCircle2 className="w-3.5 h-3.5" />
                )}
                <span>{t.displayLabel}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      {isUser && (
        <div className="flex-shrink-0 w-7 h-7 rounded-full bg-muted flex items-center justify-center">
          <UserIcon className="w-4 h-4" />
        </div>
      )}
    </div>
  );
}
