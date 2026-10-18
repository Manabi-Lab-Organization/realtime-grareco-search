import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { pickActiveStartupModal, type Slots, type SlotState, type StartupModalId } from './startupModalOrder';

interface QueueContext {
  activeId: StartupModalId | null;
  report: (id: StartupModalId, state: SlotState) => void;
  remove: (id: StartupModalId) => void;
}

const Ctx = createContext<QueueContext | null>(null);

export function StartupModalQueue({ children }: { children: ReactNode }) {
  const [slots, setSlots] = useState<Slots>({});
  const [activeId, setActiveId] = useState<StartupModalId | null>(null);

  const report = useCallback((id: StartupModalId, state: SlotState) => {
    setSlots((prev) => {
      const cur = prev[id];
      if (cur && cur.ready === state.ready && cur.wants === state.wants) return prev;
      return { ...prev, [id]: state };
    });
  }, []);

  const remove = useCallback((id: StartupModalId) => {
    setSlots((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  useEffect(() => {
    setActiveId((prev) => pickActiveStartupModal(prev, slots));
  }, [slots]);

  const value = useMemo(() => ({ activeId, report, remove }), [activeId, report, remove]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStartupModalSlot(id: StartupModalId, { ready, wants }: SlotState): boolean {
  const ctx = useContext(Ctx);
  const report = ctx?.report;
  const remove = ctx?.remove;

  useEffect(() => {
    report?.(id, { ready, wants });
  }, [report, id, ready, wants]);

  useEffect(() => () => remove?.(id), [remove, id]);

  if (!ctx) return wants;
  return ctx.activeId === id && wants;
}
