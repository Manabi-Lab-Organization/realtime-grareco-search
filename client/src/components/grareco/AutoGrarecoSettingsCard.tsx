
import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Settings, ChevronDown, ChevronRight } from 'lucide-react';
import type { ResearchSettings } from '@/hooks/useResearchSettings';

export interface AutoGrarecoSettingsCardProps {
  settings: ResearchSettings | null;
  onUpdate: (patch: Partial<ResearchSettings>) => Promise<void>;
}

export function AutoGrarecoSettingsCard({
  settings,
  onUpdate,
}: AutoGrarecoSettingsCardProps) {
  const [open, setOpen] = useState(false);
  if (!settings) return null;
  const ag = settings.autoGrareco;
  const update = (patch: Partial<typeof ag>) => {
    void onUpdate({ autoGrareco: { ...ag, ...patch } } as Partial<ResearchSettings>);
  };

  const summary = ag.enabled
    ? `ON · ${ag.reflect ? '🔁' : '✕'} ${ag.discover ? '🌱' : '✕'} · ${ag.autoPromoteMode === 'auto' ? '30秒後に自動画像化' : '確認後画像化'} · 1時間 ${ag.maxImagesPerHour} 枚まで`
    : 'OFF';

  return (
    <Card className="border-rose-200 dark:border-rose-900/50">
      <CardContent className="p-3">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="w-full flex items-center justify-between gap-2 text-left"
        >
          <div className="flex items-center gap-2 min-w-0">
            <Settings className="w-4 h-4 text-muted-foreground flex-shrink-0" />
            <span className="text-sm font-medium">自動グラレコ 設定</span>
            <span className="text-xs text-muted-foreground truncate">{summary}</span>
          </div>
          {open ? (
            <ChevronDown className="w-4 h-4 text-muted-foreground flex-shrink-0" />
          ) : (
            <ChevronRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />
          )}
        </button>

        {open && (
          <div className="mt-3 space-y-2.5 text-sm pl-1">
            <label className="flex items-center justify-between gap-2 cursor-pointer">
              <span className="font-medium">全体 ON/OFF</span>
              <input
                type="checkbox"
                checked={ag.enabled}
                onChange={(e) => update({ enabled: e.target.checked })}
                className="h-4 w-4"
              />
            </label>
            <div className={`space-y-2.5 pl-3 ${ag.enabled ? '' : 'opacity-50 pointer-events-none'}`}>
              <label className="flex items-center justify-between gap-2 cursor-pointer">
                <span>🔁 リフレクト型 自動発火</span>
                <input
                  type="checkbox"
                  checked={ag.reflect}
                  onChange={(e) => update({ reflect: e.target.checked })}
                  className="h-4 w-4"
                />
              </label>
              <label className="flex items-center justify-between gap-2 cursor-pointer">
                <span>🌱 ディスカバー型 自動発火</span>
                <input
                  type="checkbox"
                  checked={ag.discover}
                  onChange={(e) => update({ discover: e.target.checked })}
                  className="h-4 w-4"
                />
              </label>
              <div>
                <div className="text-xs text-muted-foreground mb-1">画像化モード</div>
                <div className="flex gap-3 text-sm">
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="radio"
                      name="autoPromoteMode"
                      checked={ag.autoPromoteMode === 'auto'}
                      onChange={() => update({ autoPromoteMode: 'auto' })}
                    />
                    <span>30秒後に自動</span>
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="radio"
                      name="autoPromoteMode"
                      checked={ag.autoPromoteMode === 'manual'}
                      onChange={() => update({ autoPromoteMode: 'manual' })}
                    />
                    <span>確認後</span>
                  </label>
                </div>
              </div>
              <div>
                <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
                  <span>1時間あたり画像化上限</span>
                  <span className="font-medium text-foreground">{ag.maxImagesPerHour} 枚</span>
                </div>
                <input
                  type="range"
                  min={1}
                  max={30}
                  step={1}
                  value={ag.maxImagesPerHour}
                  onChange={(e) => update({ maxImagesPerHour: Number(e.target.value) })}
                  className="w-full"
                />
                <p className="text-[11px] text-muted-foreground mt-1">
                  上限到達後の自動グラレコは画像化されず、ドラフトカードのまま保持されます（手動で「画像化する」を押せば画像化できます）。
                </p>
              </div>
              <label className="flex items-center justify-between gap-2 cursor-pointer">
                <span className="text-xs">調査カードを参照に含める</span>
                <input
                  type="checkbox"
                  checked={ag.includeResearchRefs}
                  onChange={(e) => update({ includeResearchRefs: e.target.checked })}
                  className="h-4 w-4"
                />
              </label>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
