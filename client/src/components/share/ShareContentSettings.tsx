import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import { parseSummarySections, type SummarySection } from '@/lib/parseSummarySections';
import { grarecoThumbUrl } from '@/lib/grarecoThumb';

export type SummaryExclusion = { startMs: number; endMs: number } | { heading: string };
export interface ExcludedItems {
  research?: string[];
  grareco?: string[];
  glossary?: string[];
  summary?: SummaryExclusion[];
}

const TYPES: { key: string; label: string }[] = [
  { key: 'summary', label: 'サマリー' },
  { key: 'research', label: 'リアルタイム調査' },
  { key: 'grareco', label: 'グラレコ' },
  { key: 'glossary', label: '用語解説' },
];

export function isShareableResearch(c: any): boolean {
  const m = c?.metadata ?? {};
  if (m.ephemeral === true) return false;
  if (m.kind === 'acknowledgment' || m.kind === 'system_notice') return false;
  if (c.cardType === 'info') return true;
  if (c.cardType === 'fact-check') return m.verdict === 'confirmed';
  return false;
}

function sectionExcluded(sec: SummarySection, list: SummaryExclusion[]): boolean {
  return list.some((ex) =>
    'startMs' in ex
      ? sec.startMs != null && sec.endMs != null && sec.startMs <= ex.endMs && sec.endMs >= ex.startMs
      : ex.heading.trim() === sec.heading.trim(),
  );
}

interface Props {
  meetingId: number;
  sharedContents: string[];
  excludedItems: ExcludedItems;
  busy?: boolean;
  onPatch: (patch: { sharedContents?: string[]; excludedItems?: ExcludedItems }) => void;
}

export function ShareContentSettings({
  meetingId,
  sharedContents,
  excludedItems,
  busy,
  onPatch,
}: Props) {
  const [expanded, setExpanded] = useState<string | null>(null);

  const toggleType = (key: string) => {
    const next = sharedContents.includes(key)
      ? sharedContents.filter((k) => k !== key)
      : [...sharedContents, key];
    onPatch({ sharedContents: next });
  };

  const toggleStr = (type: 'research' | 'grareco' | 'glossary', id: string) => {
    const arr = excludedItems[type] ?? [];
    const next = arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id];
    onPatch({ excludedItems: { ...excludedItems, [type]: next } });
  };

  const toggleSummary = (sec: SummarySection) => {
    const arr = excludedItems.summary ?? [];
    let next: SummaryExclusion[];
    if (sectionExcluded(sec, arr)) {
      next = arr.filter((e) =>
        'startMs' in e
          ? !(sec.startMs != null && sec.endMs != null && sec.startMs <= e.endMs && sec.endMs >= e.startMs)
          : e.heading.trim() !== sec.heading.trim(),
      );
    } else {
      const key: SummaryExclusion =
        sec.startMs != null && sec.endMs != null
          ? { startMs: sec.startMs, endMs: sec.endMs }
          : { heading: sec.heading };
      next = [...arr, key];
    }
    onPatch({ excludedItems: { ...excludedItems, summary: next } });
  };

  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-foreground">共有する内容</p>
      <p className="text-[11px] text-muted-foreground">
        種類のチェックを外すとその種類ごと、各項目のチェックを外すとその項目だけゲストに表示されません。
      </p>
      {TYPES.map((t) => {
        const typeOn = sharedContents.includes(t.key);
        const open = expanded === t.key;
        return (
          <div key={t.key} className="rounded border">
            <div className="flex items-center gap-2 px-2 py-1.5">
              <input
                type="checkbox"
                checked={typeOn}
                disabled={busy}
                onChange={() => toggleType(t.key)}
                className="h-4 w-4 accent-primary shrink-0"
              />
              <span className="text-sm flex-1 min-w-0">{t.label}</span>
              {typeOn && (
                <button
                  onClick={() => setExpanded(open ? null : t.key)}
                  className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-0.5 shrink-0"
                >
                  個別
                  <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? '' : '-rotate-90'}`} />
                </button>
              )}
            </div>
            {typeOn && open && (
              <div className="border-t px-2 py-1.5 max-h-48 overflow-y-auto">
                <ItemList
                  type={t.key}
                  meetingId={meetingId}
                  excludedItems={excludedItems}
                  busy={busy}
                  toggleStr={toggleStr}
                  toggleSummary={toggleSummary}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ItemList({
  type,
  meetingId,
  excludedItems,
  busy,
  toggleStr,
  toggleSummary,
}: {
  type: string;
  meetingId: number;
  excludedItems: ExcludedItems;
  busy?: boolean;
  toggleStr: (type: 'research' | 'grareco' | 'glossary', id: string) => void;
  toggleSummary: (sec: SummarySection) => void;
}) {
  const endpoint =
    type === 'summary'
      ? 'structured-summary'
      : type === 'research'
        ? 'research-insights'
        : type === 'grareco'
          ? 'graphic-recordings'
          : 'term-glossary';
  const q = useQuery<any>({ queryKey: ['/api/meetings', meetingId, endpoint] });

  if (q.isLoading) return <p className="text-[11px] text-muted-foreground py-1">読み込み中…</p>;

  const row = (key: string, checked: boolean, label: React.ReactNode, onChange: () => void) => (
    <label key={key} className="flex items-center gap-2 py-1 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        disabled={busy}
        onChange={onChange}
        className="h-3.5 w-3.5 accent-primary shrink-0"
      />
      <span className="text-xs min-w-0 truncate">{label}</span>
    </label>
  );

  if (type === 'summary') {
    const content: string = q.data?.content ?? '';
    const secs = content ? parseSummarySections(content) : [];
    if (secs.length === 0) return <p className="text-[11px] text-muted-foreground py-1">まだありません</p>;
    const exList = excludedItems.summary ?? [];
    return (
      <>
        {secs.map((sec, i) =>
          row(
            String(i),
            !sectionExcluded(sec, exList),
            sec.heading || `セクション ${i + 1}`,
            () => toggleSummary(sec),
          ),
        )}
      </>
    );
  }

  if (type === 'research') {
    const cards = (Array.isArray(q.data) ? q.data : []).filter(isShareableResearch);
    if (cards.length === 0) return <p className="text-[11px] text-muted-foreground py-1">まだありません</p>;
    const ex = excludedItems.research ?? [];
    return (
      <>
        {cards.map((c: any) =>
          row(c.id, !ex.includes(String(c.id)), c.title || c.keyword || '(無題)', () =>
            toggleStr('research', String(c.id)),
          ),
        )}
      </>
    );
  }

  if (type === 'grareco') {
    const items = (Array.isArray(q.data) ? q.data : []).filter((g: any) => !!g.imageUrl);
    if (items.length === 0) return <p className="text-[11px] text-muted-foreground py-1">まだありません</p>;
    const ex = excludedItems.grareco ?? [];
    return (
      <>
        {items.map((g: any, i: number) => (
          <label key={g.id} className="flex items-center gap-2 py-1 cursor-pointer">
            <input
              type="checkbox"
              checked={!ex.includes(String(g.id))}
              disabled={busy}
              onChange={() => toggleStr('grareco', String(g.id))}
              className="h-3.5 w-3.5 accent-primary shrink-0"
            />
            <img src={grarecoThumbUrl(g.imageUrl)} alt="" loading="lazy" className="h-8 w-12 object-cover rounded border shrink-0" />
            <span className="text-xs text-muted-foreground">グラレコ {items.length - i}</span>
          </label>
        ))}
      </>
    );
  }

  const terms = Array.isArray(q.data) ? q.data : [];
  if (terms.length === 0) return <p className="text-[11px] text-muted-foreground py-1">まだありません</p>;
  const ex = excludedItems.glossary ?? [];
  return (
    <>
      {[...terms].reverse().map((t: any) =>
        row(t.term, !ex.includes(t.term), t.term, () => toggleStr('glossary', t.term)),
      )}
    </>
  );
}
