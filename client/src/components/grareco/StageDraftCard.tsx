import { useEffect, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { X, Pin, ImageIcon, Timer } from 'lucide-react';
import type { GrarecoDraft, GrarecoTriggerType } from 'shared';

const TRIGGER_LABEL: Record<GrarecoTriggerType, { icon: string; label: string }> = {
  manual: { icon: '🎨', label: 'マニュアル' },
  auto_reflect: { icon: '🔁', label: 'リフレクト・話題転換' },
  auto_discover: { icon: '🌱', label: 'ディスカバー・停滞' },
  auto_milestone: { icon: '🔁', label: 'リフレクト・節目' },
  auto_fallback: { icon: '🔁', label: 'リフレクト・定期' },
  auto_meeting_end: { icon: '🏁', label: 'リフレクト・終了時' },
  user_reflect: { icon: '🔁', label: 'リフレクト' },
  user_discover: { icon: '🌱', label: 'ディスカバー' },
};

const HIGHLIGHT_STYLES: Record<string, { border: string; bg: string; label: string }> = {
  decision: {
    border: 'border-emerald-300 dark:border-emerald-700',
    bg: 'bg-emerald-50 dark:bg-emerald-950/30',
    label: '✅ 決定',
  },
  question: {
    border: 'border-sky-300 dark:border-sky-700',
    bg: 'bg-sky-50 dark:bg-sky-950/30',
    label: '❓ 問い',
  },
  risk: {
    border: 'border-amber-300 dark:border-amber-700',
    bg: 'bg-amber-50 dark:bg-amber-950/30',
    label: '⚠️ リスク',
  },
  insight: {
    border: 'border-violet-300 dark:border-violet-700',
    bg: 'bg-violet-50 dark:bg-violet-950/30',
    label: '💡 気付き',
  },
};

const VISUAL_STYLE_LABEL: Record<string, string> = {
  reflect_map: 'リフレクトマップ',
  tree: '議論ツリー',
  fishbone: 'フィッシュボーン',
  '2x2': '2×2 マトリクス',
  blank_quadrant: '空白象限',
};

export interface StageDraftCardProps {
  recordingId: number;
  triggerType: GrarecoTriggerType;
  draft: GrarecoDraft;
  receivedAt: number;
  isPromoting?: boolean;
  hasImage?: boolean;
  willAutoPromote?: boolean;
  cancelDeadlineMs?: number;
  isPinned?: boolean;
  skippedReason?: 'limit_reached' | 'manual_mode' | 'cancelled' | 'generation_failed';
  onPromoteToImage?: () => void;
  onCancelPromote?: () => void;
  onPin?: () => void;
  onDismiss?: () => void;
  onJumpToResearchInsight?: (insightId: number) => void;
}

function formatTime(epochMs: number): string {
  const d = new Date(epochMs);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function StageDraftCard({
  triggerType,
  draft,
  receivedAt,
  isPromoting,
  hasImage,
  willAutoPromote,
  cancelDeadlineMs,
  isPinned,
  skippedReason,
  onPromoteToImage,
  onCancelPromote,
  onPin,
  onDismiss,
  onJumpToResearchInsight,
}: StageDraftCardProps) {
  const trigger = TRIGGER_LABEL[triggerType] ?? TRIGGER_LABEL.manual;

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!willAutoPromote || !cancelDeadlineMs || hasImage || isPromoting) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [willAutoPromote, cancelDeadlineMs, hasImage, isPromoting]);

  const remainSec =
    willAutoPromote && cancelDeadlineMs && !hasImage && !isPromoting
      ? Math.max(0, Math.ceil((cancelDeadlineMs - now) / 1000))
      : null;
  const isCountdownActive = remainSec !== null && remainSec > 0;
  const autoFireInProgress =
    !!willAutoPromote &&
    !!cancelDeadlineMs &&
    now > cancelDeadlineMs &&
    !hasImage &&
    !isPromoting;
  const isGenerating = autoFireInProgress || !!isPromoting;
  const isReflectFamily =
    triggerType === 'auto_reflect' ||
    triggerType === 'auto_milestone' ||
    triggerType === 'auto_fallback' ||
    triggerType === 'auto_meeting_end' ||
    triggerType === 'user_reflect';

  const accentBorder = isReflectFamily
    ? 'border-rose-200 dark:border-rose-900/50'
    : 'border-teal-200 dark:border-teal-900/50';
  const accentBg = isReflectFamily
    ? 'bg-rose-50/50 dark:bg-rose-950/10'
    : 'bg-teal-50/50 dark:bg-teal-950/10';

  return (
    <Card className={`${accentBorder} ${accentBg} border-l-4`}>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-lg" aria-hidden>{trigger.icon}</span>
            <Badge variant="outline" className="text-xs">{trigger.label}</Badge>
            <span className="text-xs text-muted-foreground">{formatTime(receivedAt)}</span>
            <Badge variant="secondary" className="text-[10px]">
              {VISUAL_STYLE_LABEL[draft.visualStyle] ?? draft.visualStyle}
            </Badge>
          </div>
          {onDismiss && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={onDismiss}
              title="閉じる"
            >
              <X className="w-3.5 h-3.5" />
            </Button>
          )}
        </div>

        <div>
          <h3 className="text-base font-semibold leading-tight">{draft.title}</h3>
          {draft.subtitle && (
            <p className="text-xs text-muted-foreground mt-0.5">{draft.subtitle}</p>
          )}
        </div>

        {draft.sections.length > 0 && (
          <div className="space-y-2.5">
            {draft.sections.map((sec, i) => (
              <div key={i} className="space-y-1">
                <div className="text-sm font-medium flex items-center gap-1.5">
                  <span aria-hidden>{sec.icon}</span>
                  <span>{sec.heading}</span>
                </div>
                {sec.bullets.length > 0 && (
                  <ul className="text-sm space-y-0.5 pl-6 list-disc marker:text-muted-foreground">
                    {sec.bullets.map((b, j) => (
                      <li key={j}>{b}</li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        )}

        {draft.highlights.length > 0 && (
          <div className="space-y-1.5">
            {draft.highlights.map((h, i) => {
              const s = HIGHLIGHT_STYLES[h.kind] ?? HIGHLIGHT_STYLES.insight;
              return (
                <div
                  key={i}
                  className={`${s.border} ${s.bg} text-sm border rounded-md px-3 py-1.5`}
                >
                  <span className="text-xs font-medium opacity-80 mr-2">{s.label}</span>
                  {h.text}
                </div>
              );
            })}
          </div>
        )}

        {draft.researchRefs.length > 0 && (
          <div className="border-t pt-2 space-y-1">
            <div className="text-xs text-muted-foreground">この区間で出ていた調査カード</div>
            {draft.researchRefs.map((r) => (
              <button
                key={r.insightId}
                type="button"
                className="block w-full text-left text-xs text-blue-700 dark:text-blue-400 hover:underline"
                onClick={() => onJumpToResearchInsight?.(r.insightId)}
              >
                💡 {new Date(r.createdAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })} {r.headline}
              </button>
            ))}
          </div>
        )}

        {draft.mermaid && (
          <pre className="text-[11px] bg-muted/40 rounded p-2 overflow-x-auto whitespace-pre">
            {draft.mermaid}
          </pre>
        )}

        <div className="flex items-center gap-2 pt-1 flex-wrap">
          {isCountdownActive && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground bg-muted/50 px-2 py-1 rounded">
              <Timer className="w-3.5 h-3.5" />
              <span>{remainSec}秒後に画像化…</span>
            </div>
          )}
          {isGenerating && !hasImage && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground bg-muted/50 px-2 py-1 rounded">
              <Timer className="w-3.5 h-3.5 animate-pulse" />
              <span>描画中…</span>
            </div>
          )}
          {skippedReason === 'limit_reached' && !hasImage && !isGenerating && (
            <div className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-300 bg-amber-100/70 dark:bg-amber-900/30 px-2 py-1 rounded">
              <span>⚠️ 上限到達で画像化スキップ</span>
            </div>
          )}
          {skippedReason === 'generation_failed' && !hasImage && !isGenerating && (
            <div className="flex items-center gap-1.5 text-xs text-rose-700 dark:text-rose-300 bg-rose-100/70 dark:bg-rose-900/30 px-2 py-1 rounded">
              <span>⚠️ 画像生成失敗</span>
            </div>
          )}
          {onPromoteToImage && !hasImage && !isGenerating && (
            <Button variant="default" size="sm" onClick={onPromoteToImage}>
              <ImageIcon className="w-3.5 h-3.5 mr-1.5" />
              画像化する
            </Button>
          )}
          {onCancelPromote && isCountdownActive && (
            <Button
              variant="outline"
              size="sm"
              onClick={onCancelPromote}
              title="画像化せずドラフトのまま保持"
            >
              <X className="w-3.5 h-3.5 mr-1.5" />
              画像化しない
            </Button>
          )}
          {onPin && (
            <Button
              variant={isPinned ? 'default' : 'outline'}
              size="sm"
              onClick={onPin}
              title={isPinned ? 'ピン留め解除' : 'ピン留めしてメールに含める'}
            >
              <Pin className="w-3.5 h-3.5 mr-1.5" />
              {isPinned ? 'ピン留め中' : 'ピン留め'}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
