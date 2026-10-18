import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type UserAnnouncement } from '../lib/api';

export function useMarkReadAnnouncement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.announcements.markRead(id),
    onMutate: async (id: number) => {
      await qc.cancelQueries({ queryKey: ['announcements'] });
      const prev = qc.getQueryData<UserAnnouncement[]>(['announcements']);
      const now = new Date().toISOString();
      qc.setQueryData<UserAnnouncement[]>(['announcements'], (old) =>
        (old ?? []).map((a) => (a.id === id ? { ...a, readAt: a.readAt ?? now } : a))
      );
      return { prev };
    },
    onError: (_err, _id, context) => {
      if (context?.prev) qc.setQueryData(['announcements'], context.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['announcements'] }),
  });
}
