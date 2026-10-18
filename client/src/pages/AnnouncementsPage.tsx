import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'wouter';
import { useQuery } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import { ArrowLeft, CheckCheck, ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { Button } from '../components/ui/button';
import { api } from '../lib/api';
import { MARKDOWN_CLASS, isReleaseAnnouncement } from '../components/announcements/AnnouncementDrawer';
import { useMarkReadAnnouncement } from '../hooks/useDismissAnnouncement';

export default function AnnouncementsPage() {
  const [, navigate] = useLocation();
  const markRead = useMarkReadAnnouncement();
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const { data: items, isLoading } = useQuery({
    queryKey: ['announcements'],
    queryFn: () => api.announcements.list(),
  });

  const sorted = items
    ? [...items].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    : [];

  const unreadCount = (items ?? []).filter((a) => !a.readAt).length;

  const markAllRead = () => {
    for (const a of items ?? []) {
      if (!a.readAt) markRead.mutate(a.id);
    }
  };

  const hashId = Number(
    typeof window !== 'undefined' ? window.location.hash.replace(/^#ann-/, '') : ''
  );
  const hashApplied = useRef(false);
  useEffect(() => {
    if (hashApplied.current || !items || !hashId) return;
    const target = items.find((a) => a.id === hashId);
    if (!target) return;
    hashApplied.current = true;
    setExpandedId(hashId);
    if (!target.readAt) markRead.mutate(hashId);
    requestAnimationFrame(() => {
      document.getElementById(`ann-${hashId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, hashId]);

  const toggle = (id: number, unread: boolean) => {
    setExpandedId((cur) => (cur === id ? null : id));
    if (unread) markRead.mutate(id);
  };

  const goChangelog = (id: number, unread: boolean) => {
    if (unread) markRead.mutate(id);
    navigate('/changelog');
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 bg-background/80 backdrop-blur-xl border-b border-border">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate('/')}>
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <h1 className="text-lg font-semibold">お知らせ</h1>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-6 py-8">
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-12 justify-center">
            <Loader2 className="h-4 w-4 animate-spin" />
            読み込み中…
          </div>
        ) : sorted.length === 0 ? (
          <p className="text-sm text-muted-foreground py-12 text-center">お知らせはありません</p>
        ) : (
          <>
            {unreadCount > 0 && (
              <div className="flex justify-end mb-3">
                <Button variant="outline" size="sm" onClick={markAllRead}>
                  <CheckCheck className="h-4 w-4 mr-1" />
                  すべて既読にする
                </Button>
              </div>
            )}
            <div className="space-y-3">
            {sorted.map((a) => {
              const unread = !a.readAt;
              const isRelease = isReleaseAnnouncement(a.title);
              const expanded = expandedId === a.id;
              return (
                <div
                  key={a.id}
                  id={`ann-${a.id}`}
                  className={`border rounded-md overflow-hidden scroll-mt-24 ${unread ? 'bg-primary/5 border-primary/20' : ''}`}
                >
                  <div className="flex items-stretch">
                    <button
                      type="button"
                      onClick={() => toggle(a.id, unread)}
                      aria-expanded={expanded}
                      className="flex-1 min-w-0 text-left p-3 flex items-start gap-2 hover:bg-muted/40 transition-colors"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          {a.important && (
                            <span className="text-xs bg-destructive text-destructive-foreground px-1.5 py-0.5 rounded">
                              重要
                            </span>
                          )}
                          {unread && (
                            <span className="text-[10px] bg-primary text-primary-foreground px-1.5 py-0.5 rounded">
                              NEW
                            </span>
                          )}
                          <h3 className="font-medium text-sm">{a.title}</h3>
                        </div>
                        <div className="text-xs text-muted-foreground mt-1">
                          {new Date(a.createdAt).toLocaleDateString('ja-JP')}
                        </div>
                      </div>
                      <ChevronDown
                        className={`h-4 w-4 mt-0.5 shrink-0 text-muted-foreground transition-transform ${
                          expanded ? 'rotate-180' : ''
                        }`}
                      />
                    </button>
                    {isRelease && (
                      <button
                        type="button"
                        onClick={() => goChangelog(a.id, unread)}
                        className="shrink-0 px-3 flex items-center gap-1 text-xs text-primary hover:underline hover:bg-muted/40 border-l border-border transition-colors"
                        title="更新履歴ページを開く"
                      >
                        更新履歴
                        <ChevronRight className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                  {expanded && (
                    <div className={`px-3 pb-3 ${MARKDOWN_CLASS}`}>
                      <ReactMarkdown
                        components={{
                          a: ({ node: _node, ...props }) => (
                            <a {...props} target="_blank" rel="noopener noreferrer" />
                          ),
                        }}
                      >
                        {a.body}
                      </ReactMarkdown>
                    </div>
                  )}
                </div>
              );
            })}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
