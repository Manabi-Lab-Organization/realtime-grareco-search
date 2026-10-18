import { useEffect, useRef } from 'react';
import { browserHeartbeatDeps, startSessionHeartbeat } from '@/lib/sessionHeartbeat';

export function useSessionHeartbeat(enabled: boolean, live = false): void {
  const liveRef = useRef(live);
  liveRef.current = live;
  useEffect(() => {
    if (!enabled) return;
    return startSessionHeartbeat(browserHeartbeatDeps(() => liveRef.current));
  }, [enabled]);
}
