export interface PickerWindow {
  id: string
  name: string
}

const MEETING_PATTERNS: RegExp[] = [
  /zoom/i,
  /microsoft teams/i,
  /(^|[\s|｜-])teams($|[\s|｜-])/i,
  /google meet/i,
  /^meet\s*[-–—:]/i,
  /webex/i,
  /ミーティング/
]

export function isMeetingWindow(name: string): boolean {
  return MEETING_PATTERNS.some((re) => re.test(name))
}

export interface GroupedWindows<T> {
  meeting: T[]
  others: T[]
}

export function groupWindows<T extends PickerWindow>(windows: T[]): GroupedWindows<T> {
  const meeting: T[] = []
  const others: T[] = []
  for (const w of windows) (isMeetingWindow(w.name) ? meeting : others).push(w)
  return { meeting, others }
}

export function orderedWindows<T extends PickerWindow>(windows: T[]): T[] {
  const g = groupWindows(windows)
  return [...g.meeting, ...g.others]
}

export function moveSelection<T extends PickerWindow>(
  ordered: T[],
  currentId: string,
  delta: 1 | -1
): string {
  if (ordered.length === 0) return ''
  const i = ordered.findIndex((w) => w.id === currentId)
  if (i < 0) return delta > 0 ? ordered[0].id : ordered[ordered.length - 1].id
  const next = Math.min(ordered.length - 1, Math.max(0, i + delta))
  return ordered[next].id
}
