import { useLocation } from 'wouter';
import { ChevronRight, ExternalLink } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog';
import { type UserAnnouncement } from '../../lib/api';
import { useMarkReadAnnouncement } from '../../hooks/useDismissAnnouncement';

export const MARKDOWN_CLASS =
  'text-sm mt-2 [&_p]:my-1 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 ' +
  '[&_h1]:font-bold [&_h1]:text-base [&_h1]:mt-3 [&_h1]:mb-1 ' +
  '[&_h2]:font-bold [&_h2]:text-[0.95rem] [&_h2]:mt-3 [&_h2]:mb-1 ' +
  '[&_h3]:font-semibold [&_h3]:mt-2 [&_h3]:mb-0.5 ' +
  '[&_a]:text-primary [&_a]:underline [&_strong]:font-semibold [&_code]:bg-muted [&_code]:px-1 [&_code]:rounded';

export function isReleaseAnnouncement(title: string): boolean {
  return /^v\d/.test(title.trim());
}

export function AnnouncementDrawer({
  open,
  onOpenChange,
  items,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: UserAnnouncement[];
}) {
  const markRead = useMarkReadAnnouncement();
  const [, navigate] = useLocation();

  const visible = items.filter((a) => !a.readAt);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>お知らせ</DialogTitle>
        </DialogHeader>
        {visible.length === 0 ? (
          <p className="text-sm text-muted-foreground py-8 text-center">未読のお知らせはありません</p>
        ) : (
          <div className="space-y-3">
            {visible.map((a) => {
              const needsRedownload =
                isReleaseAnnouncement(a.title) || (a.body ?? '').includes('再ダウンロードが必要');

              const handleClick = () => {
                onOpenChange(false);
                markRead.mutate(a.id);
                window.open(`/announcements#ann-${a.id}`, '_blank', 'noopener');
              };

              return (
                <button
                  key={a.id}
                  type="button"
                  onClick={handleClick}
                  className="w-full text-left border rounded-md bg-primary/5 border-primary/20 p-3 flex items-start gap-2 hover:bg-primary/10 transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      {a.important && (
                        <span className="text-xs bg-destructive text-destructive-foreground px-1.5 py-0.5 rounded">
                          重要
                        </span>
                      )}
                      {needsRedownload && (
                        <span className="text-xs bg-amber-500 text-white px-1.5 py-0.5 rounded whitespace-nowrap">
                          要再ダウンロード
                        </span>
                      )}
                      <h3 className="font-medium text-sm">{a.title}</h3>
                    </div>
                    <div className="text-xs text-muted-foreground mt-1">
                      {new Date(a.createdAt).toLocaleDateString('ja-JP')}
                    </div>
                  </div>
                  <ExternalLink className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
                </button>
              );
            })}
          </div>
        )}
        <button
          type="button"
          onClick={() => {
            onOpenChange(false);
            navigate('/announcements');
          }}
          className="mt-1 w-full flex items-center justify-center gap-1 text-sm text-primary hover:underline py-2"
        >
          お知らせ一覧を見る
          <ChevronRight className="h-4 w-4" />
        </button>
      </DialogContent>
    </Dialog>
  );
}
