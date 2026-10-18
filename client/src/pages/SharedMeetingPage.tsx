import { useParams } from 'wouter';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Copy, Radio, Link2Off, ChevronDown } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { MARKDOWN_CLASS } from '@/components/announcements/AnnouncementDrawer';
import ReactMarkdown from 'react-markdown';
import { parseSummarySections } from '@/lib/parseSummarySections';
import {
  fetchShareMeta,
  fetchShareTerms,
  fetchShareResearch,
  fetchShareGrarecos,
  fetchShareSummary,
  formatTermForCopy,
  formatResearchForCopy,
  researchCardLabel,
  TERM_CATEGORY_LABEL,
  ShareGoneError,
  ShareNotFoundError,
  type PublicGrareco,
} from '@/lib/publicShare';
import { grarecoThumbUrl } from '@/lib/grarecoThumb';
import { safeHref } from '@/lib/safeHref';
import { useSiteConfig } from '@/hooks/useSiteConfig';

const POLL_MS = 12000;

function useCopy() {
  const { toast } = useToast();
  return async (text: string, label: string) => {
    if (!text.trim()) {
      toast({ title: 'コピーする内容がありません', variant: 'destructive' });
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: `「${label}」をコピーしました`, description: `${text.length} 文字` });
    } catch (err) {
      toast({
        title: 'コピーに失敗',
        description: err instanceof Error ? err.message : '不明',
        variant: 'destructive',
      });
    }
  };
}

async function copyImage(
  item: PublicGrareco,
  toast: (a: { title: string; description?: string; variant?: 'destructive' }) => void,
) {
  const isIOS =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (isIOS) {
    toast({ title: '画像を長押ししてコピー/保存してください' });
    return;
  }
  try {
    const res = await fetch(item.imageUrl);
    const blob = await res.blob();
    const pngBlob = await new Promise<Blob>((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) return reject(new Error('canvas error'));
        ctx.drawImage(img, 0, 0);
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png');
      };
      img.onerror = () => reject(new Error('image load error'));
      img.src = URL.createObjectURL(blob);
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

function TypeSection({
  title,
  count,
  defaultOpen = false,
  children,
}: {
  title: string;
  count: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="mb-3 rounded-lg border bg-card/40 overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-muted/40 transition-colors"
      >
        <ChevronDown
          className={`h-4 w-4 text-muted-foreground transition-transform shrink-0 ${open ? '' : '-rotate-90'}`}
        />
        <h2 className="text-sm font-semibold flex-1 min-w-0">{title}</h2>
        <span className="text-xs text-muted-foreground shrink-0">{count}</span>
      </button>
      {open && (
        <div className="px-2 pb-2">
          <div className="max-h-[60vh] overflow-y-auto pr-1 space-y-2">{children}</div>
        </div>
      )}
    </section>
  );
}

function ItemCard({
  title,
  onCopy,
  copyLabel = 'コピー',
  defaultOpen = false,
  children,
}: {
  title: React.ReactNode;
  onCopy: () => void;
  copyLabel?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-lg border bg-card">
      <div className="flex items-center gap-1 px-2.5 py-2">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1.5 flex-1 min-w-0 text-left"
        >
          <ChevronDown
            className={`h-3.5 w-3.5 text-muted-foreground transition-transform shrink-0 ${open ? '' : '-rotate-90'}`}
          />
          <span className="text-sm font-medium truncate min-w-0">{title}</span>
        </button>
        <button
          onClick={onCopy}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors shrink-0 px-1"
          title={copyLabel}
        >
          <Copy className="h-3.5 w-3.5" />
        </button>
      </div>
      {open && <div className="px-3 pb-3 pt-0">{children}</div>}
    </div>
  );
}

function CenterMessage({
  icon,
  title,
  desc,
}: {
  icon: React.ReactNode;
  title: string;
  desc?: string;
}) {
  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="text-center max-w-sm">
        <div className="flex justify-center mb-3 text-muted-foreground">{icon}</div>
        <h1 className="text-lg font-semibold mb-1">{title}</h1>
        {desc && <p className="text-sm text-muted-foreground">{desc}</p>}
      </div>
    </div>
  );
}

export default function SharedMeetingPage() {
  const { appName } = useSiteConfig();
  const { token } = useParams<{ token: string }>();
  const { toast } = useToast();
  const copy = useCopy();

  const metaQuery = useQuery({
    queryKey: ['share', token, 'meta'],
    queryFn: () => fetchShareMeta(token),
    refetchInterval: POLL_MS,
    retry: false,
  });

  const live = metaQuery.data?.live === true;
  const contents = metaQuery.data?.contents ?? ['glossary', 'research', 'grareco', 'summary'];
  const show = (k: string) => contents.includes(k);

  const opts = (enabled: boolean) => ({
    enabled,
    refetchInterval: enabled ? POLL_MS : (false as const),
    retry: false,
  });

  const termsQuery = useQuery({
    queryKey: ['share', token, 'term-glossary'],
    queryFn: () => fetchShareTerms(token),
    ...opts(live && show('glossary')),
  });
  const researchQuery = useQuery({
    queryKey: ['share', token, 'research-insights'],
    queryFn: () => fetchShareResearch(token),
    ...opts(live && show('research')),
  });
  const grarecoQuery = useQuery({
    queryKey: ['share', token, 'graphic-recordings'],
    queryFn: () => fetchShareGrarecos(token),
    ...opts(live && show('grareco')),
  });
  const summaryQuery = useQuery({
    queryKey: ['share', token, 'structured-summary'],
    queryFn: () => fetchShareSummary(token),
    ...opts(live && show('summary')),
  });

  if (metaQuery.isLoading) {
    return (
      <CenterMessage
        icon={<div className="animate-spin rounded-full h-7 w-7 border-b-2 border-primary" />}
        title="読み込み中..."
      />
    );
  }
  if (metaQuery.error instanceof ShareNotFoundError) {
    return (
      <CenterMessage
        icon={<Link2Off className="h-8 w-8" />}
        title="リンクが無効です"
        desc="この共有リンクは存在しないか、無効になっています。"
      />
    );
  }
  if (metaQuery.data && !metaQuery.data.live) {
    return (
      <CenterMessage
        icon={<Link2Off className="h-8 w-8" />}
        title="この会議は終了しました"
        desc="共有リンクは会議の終了とともに無効になりました。"
      />
    );
  }
  if (metaQuery.error) {
    return (
      <CenterMessage
        icon={<Link2Off className="h-8 w-8" />}
        title="表示できませんでした"
        desc="しばらくしてから再度お試しください。"
      />
    );
  }

  const terms = [...(termsQuery.data ?? [])].reverse();
  const research = researchQuery.data ?? [];
  const grarecos = grarecoQuery.data ?? [];
  const summary = summaryQuery.data ?? null;
  const summarySections = summary?.content ? parseSummarySections(summary.content) : [];

  const isGone = (e: unknown) => e instanceof ShareGoneError;
  if (
    isGone(termsQuery.error) ||
    isGone(researchQuery.error) ||
    isGone(summaryQuery.error) ||
    isGone(grarecoQuery.error)
  ) {
    return (
      <CenterMessage
        icon={<Link2Off className="h-8 w-8" />}
        title="この会議は終了しました"
        desc="共有リンクは会議の終了とともに無効になりました。"
      />
    );
  }

  const emptyHint = (text: string) => (
    <p className="text-xs text-muted-foreground px-1 py-1">{text}</p>
  );

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b px-4 py-3">
        <div className="max-w-2xl mx-auto flex items-center gap-2">
          <span className="inline-flex items-center gap-1 text-xs font-medium text-red-600 dark:text-red-400 shrink-0">
            <Radio className="h-3.5 w-3.5 animate-pulse" />
            実施中
          </span>
          <h1 className="text-sm font-semibold truncate">{metaQuery.data?.title || '会議'}</h1>
        </div>
        <p className="max-w-2xl mx-auto text-[11px] text-muted-foreground mt-1">
          会議のライブ共有（閲覧専用）。会議が終了すると表示できなくなります。
        </p>
      </header>

      <main className="max-w-2xl mx-auto px-3 py-4">
        {show('summary') && (
          <TypeSection title="サマリー" count={summarySections.length}>
            {summarySections.length > 0
              ? summarySections.map((sec, i) => (
                  <ItemCard
                    key={i}
                    title={sec.heading || `セクション ${i + 1}`}
                    onCopy={() => copy(sec.fullText, sec.heading || 'サマリー')}
                  >
                    <div className={MARKDOWN_CLASS}>
                      <ReactMarkdown>{sec.content || sec.fullText}</ReactMarkdown>
                    </div>
                  </ItemCard>
                ))
              : emptyHint('サマリーはまだ生成されていません。')}
          </TypeSection>
        )}

        {show('research') && (
          <TypeSection title="リアルタイム調査" count={research.length}>
            {research.length > 0
              ? research.map((c) => (
                  <ItemCard
                    key={c.id}
                    title={
                      <span>
                        <span className="text-[10px] font-medium text-primary mr-1">
                          {researchCardLabel(c.cardType)}
                        </span>
                        {c.title}
                      </span>
                    }
                    onCopy={() => copy(formatResearchForCopy(c), c.title)}
                  >
                    {c.body && (
                      <p className="text-xs text-muted-foreground whitespace-pre-wrap">{c.body}</p>
                    )}
                    {c.sources?.length > 0 && (
                      <ul className="mt-2 space-y-0.5">
                        {c.sources.map((s, i) => (
                          <li key={i} className="text-[11px] truncate">
                            <a
                              href={safeHref(s.url)}
                              target="_blank"
                              rel="noreferrer noopener nofollow"
                              className="text-primary underline"
                            >
                              {s.title || s.url}
                            </a>
                          </li>
                        ))}
                      </ul>
                    )}
                  </ItemCard>
                ))
              : emptyHint('調査結果はまだありません。')}
          </TypeSection>
        )}

        {show('grareco') && (
          <TypeSection title="グラレコ" count={grarecos.length}>
            {grarecos.length > 0
              ? grarecos.map((g, i) => (
                  <ItemCard
                    key={g.id}
                    title={`グラレコ ${grarecos.length - i}`}
                    copyLabel="画像をコピー"
                    onCopy={() => copyImage(g, toast)}
                  >
                    <a href={g.imageUrl} target="_blank" rel="noopener noreferrer" title="タップで原寸を開く">
                      <img
                        src={grarecoThumbUrl(g.imageUrl)}
                        alt="グラフィックレコーディング"
                        className="w-full rounded"
                        loading="lazy"
                      />
                    </a>
                  </ItemCard>
                ))
              : emptyHint('グラレコはまだありません。')}
          </TypeSection>
        )}

        {show('glossary') && (
          <TypeSection title="用語解説" count={terms.length}>
            {terms.length > 0
              ? terms.map((t, i) => (
                  <ItemCard
                    key={`${t.term}-${i}`}
                    title={
                      <span>
                        <span className="text-[10px] font-medium text-muted-foreground mr-1">
                          {TERM_CATEGORY_LABEL[t.category]}
                        </span>
                        {t.term}
                        {t.reading && (
                          <span className="text-xs text-muted-foreground ml-1">（{t.reading}）</span>
                        )}
                      </span>
                    }
                    onCopy={() => copy(formatTermForCopy(t), t.term)}
                  >
                    <p className="text-xs text-muted-foreground whitespace-pre-wrap">
                      {t.explanation}
                    </p>
                  </ItemCard>
                ))
              : emptyHint('用語はまだ検出されていません。')}
          </TypeSection>
        )}

        <footer className="text-center text-[11px] text-muted-foreground py-6">
          {appName} ライブ共有
        </footer>
      </main>
    </div>
  );
}
