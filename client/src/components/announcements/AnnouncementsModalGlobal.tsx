import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../../hooks/useAuth';
import { api } from '../../lib/api';
import { AnnouncementModal } from './AnnouncementModal';
import { useStartupModalSlot } from '../startup/StartupModalQueue';

export function AnnouncementsModalGlobal() {
  const { user } = useAuth();
  const { data: items = [], status } = useQuery({
    queryKey: ['announcements'],
    queryFn: () => api.announcements.list(),
    enabled: !!user,
  });
  const wants = items.some((a) => a.important && !a.readAt);
  const active = useStartupModalSlot('announcement', { ready: !!user && status !== 'pending', wants });
  if (!user || !active) return null;
  return <AnnouncementModal items={items} />;
}
