import { WebSocketClient } from '@ein/ui/lib';
import { useEffect, useMemo } from 'react';

export function useWebSocket(path: string) {
  const wsClient = useMemo<WebSocketClient>(() => {
    return new WebSocketClient(path);
  }, [path]);

  useEffect(() => {
    wsClient.connect();

    return () => {
      wsClient.close();
    };
  }, [wsClient]);

  return wsClient;
}
