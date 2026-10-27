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
