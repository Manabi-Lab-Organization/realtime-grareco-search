import ReactMarkdown from 'react-markdown';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../ui/dialog';
import { Button } from '../ui/button';
import { type UserAnnouncement } from '../../lib/api';
import { useMarkReadAnnouncement } from '../../hooks/useDismissAnnouncement';
import { MARKDOWN_CLASS } from './AnnouncementDrawer';

export function AnnouncementModal({ items }: { items: UserAnnouncement[] }) {
  const markRead = useMarkReadAnnouncement();

  const unreadImportant = items.filter((a) => a.important && !a.readAt);
  const current = unreadImportant[0];

  if (!current) return null;

  const hasMore = unreadImportant.length > 1;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) markRead.mutate(current.id); }}>
      <DialogContent
        className="max-h-[80vh] overflow-y-auto"
        onEscapeKeyDown={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="text-xs bg-destructive text-destructive-foreground px-1.5 py-0.5 rounded">
              重要
            </span>
            {current.title}
          </DialogTitle>
        </DialogHeader>
        <div className={MARKDOWN_CLASS}>
          <ReactMarkdown
            components={{
              a: ({ node: _node, ...props }) => (
                <a {...props} target="_blank" rel="noopener noreferrer" />
              ),
            }}
          >
            {current.body}
          </ReactMarkdown>
        </div>
        <DialogFooter>
          <Button onClick={() => markRead.mutate(current.id)} disabled={markRead.isPending}>
            {hasMore ? '次へ' : '閉じる'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
