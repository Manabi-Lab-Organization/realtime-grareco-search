import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

let cached: boolean | null = null;
let inflight: Promise<boolean> | null = null;

async function fetchAvailability(): Promise<boolean> {
  if (cached !== null) return cached;
  if (inflight) return inflight;
  inflight = api.agent
    .availability()
    .then((r) => {
      cached = !!r.enabled;
      return cached;
    })
    .catch(() => {
      cached = false;
      return false;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function useAgentAvailability(): boolean {
  const [enabled, setEnabled] = useState<boolean>(cached ?? false);
  useEffect(() => {
    let mounted = true;
    fetchAvailability().then((v) => {
      if (mounted) setEnabled(v);
    });
    return () => {
      mounted = false;
    };
  }, []);
  return enabled;
}
