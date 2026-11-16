export interface WindowSourceLike {
  id: string
  name: string
}

export function findWindowSource<T extends WindowSourceLike>(
  sources: T[],
  windowId: string,
  windowName?: string
): T | undefined {
  const byId = sources.find((s) => s.id === windowId)
  if (byId) return byId
  if (!windowName) return undefined
  const byName = sources.filter((s) => s.name === windowName)
  return byName.length === 1 ? byName[0] : undefined
}

export function withTimeout<T>(p: Promise<T>, ms: number, label = 'timeout'): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(label)), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      }
    )
  })
}

export function excludeOwnWindows<T extends WindowSourceLike>(sources: T[], ownIds: string[]): T[] {
  const key = (id: string): string => id.split(':').slice(0, 2).join(':')
  const own = new Set(ownIds.filter(Boolean).map(key))
  if (own.size === 0) return sources
  return sources.filter((s) => !own.has(key(s.id)))
}
