import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';

export function useViewerSocket(enabled: boolean): {
  socketRef: React.MutableRefObject<Socket | null>;
  ready: boolean;
} {
  const socketRef = useRef<Socket | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!enabled) {
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }
      setReady(false);
      return;
    }

    const s = io({
      transports: ['websocket'],
      withCredentials: true,
    });
    socketRef.current = s;

    const handleConnect = () => setReady(true);
    const handleDisconnect = () => setReady(false);
    s.on('connect', handleConnect);
    s.on('disconnect', handleDisconnect);

    return () => {
      s.off('connect', handleConnect);
      s.off('disconnect', handleDisconnect);
      s.disconnect();
      socketRef.current = null;
      setReady(false);
    };
  }, [enabled]);

  return { socketRef, ready };
}
