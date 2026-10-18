import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '@/lib/queryClient';
import type { SummarySection } from '@/lib/parseSummarySections';
import type { ExcludedItems, SummaryExclusion } from '@/components/share/ShareContentSettings';

interface ShareState {
  active: boolean;
  sharedContents?: string[];
  excludedItems?: ExcludedItems;
}

const DEFAULT_SHARED = ['glossary', 'research', 'grareco', 'summary'];

function summaryExcluded(sec: SummarySection, list: SummaryExclusion[]): boolean {
  return list.some((ex) =>
    'startMs' in ex
      ? sec.startMs != null && sec.endMs != null && sec.startMs <= ex.endMs && sec.endMs >= ex.startMs
      : ex.heading.trim() === sec.heading.trim(),
  );
}

export interface ShareControl {
  active: boolean;
  typeShared: (key: string) => boolean;
  isExcluded: (type: 'research' | 'grareco' | 'glossary', id: string) => boolean;
  toggle: (type: 'research' | 'grareco' | 'glossary', id: string) => void;
  isSummaryExcluded: (sec: SummarySection) => boolean;
  toggleSummary: (sec: SummarySection) => void;
}

export function useShareControls(meetingId: number): ShareControl {
  const qc = useQueryClient();
  const key = ['/api/meetings', meetingId, 'share'];
  const q = useQuery<ShareState>({ queryKey: key, enabled: !!meetingId });
  const share = q.data;
  const active = !!share?.active;
  const excluded: ExcludedItems = share?.excludedItems ?? {};

  const patch = useMutation({
    mutationFn: async (p: { excludedItems?: ExcludedItems }) =>
      (await apiRequest('PATCH', `/api/meetings/${meetingId}/share`, p)).json(),
    onMutate: async (p) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<ShareState>(key);
      if (prev && p.excludedItems) {
        qc.setQueryData<ShareState>(key, {
          ...prev,
          excludedItems: { ...prev.excludedItems, ...p.excludedItems },
        });
      }
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
  });

  const typeShared = (k: string) => (share?.sharedContents ?? DEFAULT_SHARED).includes(k);

  const isExcluded = (type: 'research' | 'grareco' | 'glossary', id: string) =>
    (excluded[type] ?? []).includes(id);

  const toggle = (type: 'research' | 'grareco' | 'glossary', id: string) => {
    const arr = excluded[type] ?? [];
    const next = arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id];
    patch.mutate({ excludedItems: { ...excluded, [type]: next } });
  };

  const isSummaryExcluded = (sec: SummarySection) => summaryExcluded(sec, excluded.summary ?? []);

  const toggleSummary = (sec: SummarySection) => {
    const arr = excluded.summary ?? [];
    let next: SummaryExclusion[];
    if (summaryExcluded(sec, arr)) {
      next = arr.filter((e) =>
        'startMs' in e
          ? !(sec.startMs != null && sec.endMs != null && sec.startMs <= e.endMs && sec.endMs >= e.startMs)
          : e.heading.trim() !== sec.heading.trim(),
      );
    } else {
      next = [
        ...arr,
        sec.startMs != null && sec.endMs != null
          ? { startMs: sec.startMs, endMs: sec.endMs }
          : { heading: sec.heading },
      ];
    }
    patch.mutate({ excludedItems: { ...excluded, summary: next } });
  };

  return { active, typeShared, isExcluded, toggle, isSummaryExcluded, toggleSummary };
}
