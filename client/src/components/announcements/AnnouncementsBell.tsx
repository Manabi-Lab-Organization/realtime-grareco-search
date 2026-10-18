import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import { Button } from '../ui/button';
import { useAuth } from '../../hooks/useAuth';
import { api } from '../../lib/api';
import { AnnouncementDrawer } from './AnnouncementDrawer';

export function AnnouncementsBell({
  variant = 'default',
  className = '',
}: {
  variant?: 'default' | 'light';
  className?: string;
}) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);

  const { data: items = [] } = useQuery({
    queryKey: ['announcements'],
    queryFn: () => api.announcements.list(),
    enabled: !!user,
  });

  if (!user) return null;

  const unread = items.filter((a) => !a.readAt).length;
  const lightClass = variant === 'light'
    ? 'text-primary-foreground/80 hover:text-primary-foreground hover:bg-white/10'
    : '';

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className={`relative ${lightClass} ${className}`}
        onClick={() => setOpen(true)}
        title="お知らせ"
        aria-label={`お知らせ${unread > 0 ? `（未読 ${unread} 件）` : ''}`}
      >
        <Bell className="h-4 w-4" />
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 bg-destructive text-destructive-foreground text-[10px] leading-none min-w-[1rem] h-4 px-1 rounded-full flex items-center justify-center">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </Button>
      <AnnouncementDrawer open={open} onOpenChange={setOpen} items={items} />
    </>
  );
}
