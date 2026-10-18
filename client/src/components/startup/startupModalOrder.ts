
export const STARTUP_MODAL_ORDER = [
  'announcement',
] as const;

export type StartupModalId = (typeof STARTUP_MODAL_ORDER)[number];

export interface SlotState {
  ready: boolean;
  wants: boolean;
}

export type Slots = Partial<Record<StartupModalId, SlotState>>;

export function pickActiveStartupModal(prev: StartupModalId | null, slots: Slots): StartupModalId | null {
  if (prev && slots[prev]?.wants) return prev;
  for (const id of STARTUP_MODAL_ORDER) {
    const slot = slots[id];
    if (!slot) continue;
    if (!slot.ready) return null;
    if (slot.wants) return id;
  }
  return null;
}
