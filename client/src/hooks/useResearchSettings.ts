import { useCallback, useEffect, useState } from 'react';
import type { AutoGrarecoSettings } from 'shared';
import { DEFAULT_AUTO_GRARECO_SETTINGS } from 'shared';

export interface ResearchSettings {
  main: boolean;
  web: boolean;
  fact: boolean;
  gap: boolean;
  tech: boolean;
  autoGrareco: AutoGrarecoSettings;
}

export const DEFAULT_RESEARCH_SETTINGS: ResearchSettings = {
  main: false,
  web: true,
  fact: true,
  gap: true,
  tech: true,
  autoGrareco: DEFAULT_AUTO_GRARECO_SETTINGS,
};

export function useResearchSettings(
  socketRef?: React.MutableRefObject<any>,
  socketReady: boolean = false,
): {
  settings: ResearchSettings;
  loading: boolean;
  error: string | null;
  update: (patch: Partial<ResearchSettings>) => Promise<void>;
} {
  const [settings, setSettings] = useState<ResearchSettings>(DEFAULT_RESEARCH_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/user/research-settings', { credentials: 'include' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) {
          setSettings({ ...DEFAULT_RESEARCH_SETTINGS, ...data });
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!socketRef?.current) return;
    const socket = socketRef.current;
    const handler = (next: Partial<ResearchSettings>) => {
      setSettings(prev => ({ ...prev, ...next }));
    };
    socket.on('research_settings_updated', handler);
    return () => {
      socket.off('research_settings_updated', handler);
    };
  }, [socketRef, socketReady]);

  const update = useCallback(async (patch: Partial<ResearchSettings>) => {
    setSettings(prev => ({ ...prev, ...patch }));
    try {
      const res = await fetch('/api/user/research-settings', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setSettings({ ...DEFAULT_RESEARCH_SETTINGS, ...data });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      try {
        const refetch = await fetch('/api/user/research-settings', { credentials: 'include' });
        if (refetch.ok) {
          const fresh = await refetch.json();
          setSettings({ ...DEFAULT_RESEARCH_SETTINGS, ...fresh });
        }
      } catch {
      }
    }
  }, []);

  return { settings, loading, error, update };
}
