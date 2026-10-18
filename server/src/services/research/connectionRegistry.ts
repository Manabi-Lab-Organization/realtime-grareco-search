
export interface Subscriber {
  id: string;
  userId: number;
  emit: (event: string, data: unknown) => void;
  isAlive: () => boolean;
  tokenId?: number | null;
  sessionId?: string | null;
}

const userConnections = new Map<number, Map<string, Subscriber>>();

export function registerConnection(sub: Subscriber): void {
  let inner = userConnections.get(sub.userId);
  if (!inner) {
    inner = new Map();
    userConnections.set(sub.userId, inner);
  }
  inner.set(sub.id, sub);
}

export function unregisterConnection(userId: number, connId: string): void {
  const inner = userConnections.get(userId);
  if (!inner) return;
  inner.delete(connId);
  if (inner.size === 0) userConnections.delete(userId);
}

export function broadcastToUser(
  userId: number,
  event: string,
  data: unknown,
  excludeConnId?: string,
): { sent: number; pruned: number } {
  const inner = userConnections.get(userId);
  if (!inner) return { sent: 0, pruned: 0 };

  let sent = 0;
  let pruned = 0;
  const dead: string[] = [];

  for (const [connId, sub] of inner) {
    if (excludeConnId && connId === excludeConnId) continue;
    if (!sub.isAlive()) {
      dead.push(connId);
      continue;
    }
    try {
      sub.emit(event, data);
      sent++;
    } catch (e) {
      console.warn(`[research:Registry] emit failed for conn ${connId}:`, e instanceof Error ? e.message : String(e));
      dead.push(connId);
    }
  }

  for (const id of dead) {
    inner.delete(id);
    pruned++;
  }
  if (inner.size === 0) userConnections.delete(userId);

  return { sent, pruned };
}

export function connectionCount(userId: number): number {
  return userConnections.get(userId)?.size ?? 0;
}

export function broadcastToUserWhere(
  userId: number,
  event: string,
  data: unknown,
  predicate: (sub: Subscriber) => boolean,
): number {
  const inner = userConnections.get(userId);
  if (!inner) return 0;
  let sent = 0;
  for (const sub of inner.values()) {
    if (!predicate(sub) || !sub.isAlive()) continue;
    try {
      sub.emit(event, data);
      sent++;
    } catch {
    }
  }
  return sent;
}
