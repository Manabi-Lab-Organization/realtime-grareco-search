export const HEADER_INTERACTIVE_SELECTOR =
  'button, a, input, select, textarea, label, summary, [role="button"], [role="link"], [role="menuitem"], [data-no-header-toggle]';

interface ClosestCapable {
  closest(selector: string): unknown;
}

interface ContainsCapable {
  contains(node: unknown): boolean;
}

interface SelectionLike {
  isCollapsed: boolean;
  anchorNode: unknown;
  focusNode: unknown;
  toString(): string;
}

export function shouldToggleFromHeaderClick(
  target: ClosestCapable | null,
  header: ContainsCapable,
  selection: SelectionLike | null,
): boolean {
  if (!target || typeof target.closest !== 'function') return false;

  if (!header.contains(target)) return false;

  const interactive = target.closest(HEADER_INTERACTIVE_SELECTOR);
  if (interactive && interactive !== header && header.contains(interactive)) return false;

  if (selection && !selection.isCollapsed && selection.toString().trim() !== '') {
    if (header.contains(selection.anchorNode) || header.contains(selection.focusNode)) return false;
  }

  return true;
}

export function headerToggleClick(onToggle: () => void, enabled = true) {
  return (e: { target: EventTarget | null; currentTarget: EventTarget | null }): void => {
    if (!enabled) return;
    const header = e.currentTarget as unknown as ContainsCapable | null;
    if (!header) return;
    const selection = typeof window !== 'undefined' ? window.getSelection() : null;
    if (shouldToggleFromHeaderClick(e.target as unknown as ClosestCapable | null, header, selection)) onToggle();
  };
}

export const HEADER_TOGGLE_CLASS = 'cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors';
