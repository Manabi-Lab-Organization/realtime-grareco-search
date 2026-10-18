import { Eye, EyeOff } from 'lucide-react';

export function GuestShareToggle({
  shared,
  onToggle,
  className = '',
}: {
  shared: boolean;
  onToggle: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      title={shared ? 'ゲストに表示中（クリックで非表示）' : 'ゲストに非表示（クリックで表示）'}
      className={`inline-flex items-center gap-1 text-[11px] rounded px-1.5 py-0.5 border transition-colors shrink-0 ${
        shared
          ? 'text-muted-foreground border-transparent hover:bg-muted'
          : 'text-amber-600 dark:text-amber-400 border-amber-300 dark:border-amber-700/60 bg-amber-50 dark:bg-amber-900/20'
      } ${className}`}
    >
      {shared ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
      {shared ? 'ゲスト表示' : 'ゲスト非表示'}
    </button>
  );
}
