import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Plus, Trash2, Loader2, Save } from 'lucide-react';
import { apiRequest } from '@/lib/queryClient';
import type { Participant } from 'shared';

const GENDERS: Participant['gender'][] = ['男', '女', '分からない'];
const AGES: Participant['age'][] = [
  '10才未満',
  '10代',
  '20代',
  '30代',
  '40代',
  '50代',
  '60代',
  '70代',
  '80才以上',
  '分からない',
];

interface Props {
  participants: Participant[];
  meetingId: number;
}

export function ParticipantsInlineEditor({ participants, meetingId }: Props) {
  const [draft, setDraft] = useState<Participant[]>(participants);
  const [dirty, setDirty] = useState(false);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!dirty) setDraft(participants);
  }, [participants, dirty]);

  const saveMutation = useMutation({
    mutationFn: async (next: Participant[]) => {
      const res = await apiRequest('PUT', `/api/meetings/${meetingId}/participants`, {
        participants: next,
      });
      return res.json();
    },
    onSuccess: () => {
      setDirty(false);
      queryClient.invalidateQueries({ queryKey: ['/api/meetings', meetingId, 'participants'] });
    },
  });

  const updateRow = (idx: number, patch: Partial<Participant>) => {
    setDraft((prev) => prev.map((p, i) => (i === idx ? { ...p, ...patch } : p)));
    setDirty(true);
  };

  const removeRow = (idx: number) => {
    setDraft((prev) => prev.filter((_, i) => i !== idx));
    setDirty(true);
  };

  const addRow = () => {
    setDraft((prev) => [
      ...prev,
      { name: '', gender: '分からない', age: '分からない', other: '', source: 'manual' },
    ]);
    setDirty(true);
  };

  const handleSave = () => {
    const cleaned = draft
      .map((p) => ({ ...p, name: p.name.trim() }))
      .filter((p) => p.name.length > 0);
    saveMutation.mutate(cleaned);
  };

  const handleCancel = () => {
    setDraft(participants);
    setDirty(false);
  };

  if (draft.length === 0) {
    return (
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground italic">参加者はまだ登録されていません</p>
        <Button size="sm" variant="outline" onClick={addRow}>
          <Plus className="w-3.5 h-3.5 mr-1.5" />
          手動で参加者を追加
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="rounded border overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-muted/40">
            <tr>
              <th className="text-left px-2 py-1.5 font-medium">氏名</th>
              <th className="text-left px-2 py-1.5 font-medium w-20">性別</th>
              <th className="text-left px-2 py-1.5 font-medium w-24">年代</th>
              <th className="text-left px-2 py-1.5 font-medium">所属・備考</th>
              <th className="text-left px-2 py-1.5 font-medium w-24">話者ID</th>
              <th className="w-8"></th>
            </tr>
          </thead>
          <tbody>
            {draft.map((p, i) => (
              <tr key={i} className="border-t">
                <td className="px-2 py-1">
                  <Input
                    value={p.name}
                    onChange={(e) => updateRow(i, { name: e.target.value })}
                    className="h-7 text-xs"
                    placeholder="氏名"
                  />
                </td>
                <td className="px-2 py-1">
                  <select
                    value={p.gender}
                    onChange={(e) => updateRow(i, { gender: e.target.value as Participant['gender'] })}
                    className="h-7 w-full rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    {GENDERS.map((g) => (
                      <option key={g} value={g}>
                        {g}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-2 py-1">
                  <select
                    value={p.age}
                    onChange={(e) => updateRow(i, { age: e.target.value as Participant['age'] })}
                    className="h-7 w-full rounded-md border border-input bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    {AGES.map((a) => (
                      <option key={a} value={a}>
                        {a}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-2 py-1">
                  <Input
                    value={p.other ?? ''}
                    onChange={(e) => updateRow(i, { other: e.target.value })}
                    className="h-7 text-xs"
                    placeholder="所属・肩書き"
                  />
                </td>
                <td className="px-2 py-1">
                  <SpeakerIdsEditor
                    value={Array.isArray(p.speakerIds) ? p.speakerIds : []}
                    onChange={(next) => updateRow(i, { speakerIds: next.length > 0 ? next : undefined })}
                  />
                </td>
                <td className="px-2 py-1">
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6 text-muted-foreground hover:text-destructive"
                    onClick={() => removeRow(i)}
                    title="この参加者を削除"
                  >
                    <Trash2 className="w-3 h-3" />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={addRow}>
          <Plus className="w-3.5 h-3.5 mr-1.5" />
          行を追加
        </Button>
        <div className="flex-1" />
        {dirty && (
          <>
            <Button size="sm" variant="ghost" onClick={handleCancel} disabled={saveMutation.isPending}>
              キャンセル
            </Button>
            <Button size="sm" onClick={handleSave} disabled={saveMutation.isPending}>
              {saveMutation.isPending ? (
                <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
              ) : (
                <Save className="w-3.5 h-3.5 mr-1.5" />
              )}
              保存
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function SpeakerIdsEditor({
  value,
  onChange,
}: {
  value: number[];
  onChange: (next: number[]) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [draftId, setDraftId] = useState('');

  return (
    <div className="flex flex-wrap items-center gap-1">
      {value.map((id) => (
        <Badge key={id} variant="secondary" className="text-[10px] gap-0.5 pl-1.5 pr-1" title={`speaker_id=${id}`}>
          話者{id + 1}
          <button
            type="button"
            className="hover:text-destructive"
            onClick={() => onChange(value.filter((v) => v !== id))}
          >
            ×
          </button>
        </Badge>
      ))}
      {adding ? (
        <Input
          autoFocus
          value={draftId}
          onChange={(e) => setDraftId(e.target.value.replace(/[^0-9]/g, ''))}
          onBlur={() => {
            const display = parseInt(draftId, 10);
            const stored = display - 1;
            if (!Number.isNaN(stored) && stored >= 0 && !value.includes(stored)) {
              onChange([...value, stored].sort((a, b) => a - b));
            }
            setDraftId('');
            setAdding(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              const display = parseInt(draftId, 10);
              const stored = display - 1;
              if (!Number.isNaN(stored) && stored >= 0 && !value.includes(stored)) {
                onChange([...value, stored].sort((a, b) => a - b));
              }
              setDraftId('');
              setAdding(false);
            }
            if (e.key === 'Escape') {
              setDraftId('');
              setAdding(false);
            }
          }}
          className="h-6 w-14 px-1 text-[10px]"
          placeholder="話者#"
        />
      ) : (
        <button
          type="button"
          className="text-[10px] text-muted-foreground hover:text-foreground rounded border border-dashed px-1.5 h-5"
          onClick={() => setAdding(true)}
          title="話者番号を追加（例: 話者1 と紐付けるなら 1 と入力）"
        >
          +
        </button>
      )}
    </div>
  );
}
