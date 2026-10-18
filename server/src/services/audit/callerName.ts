export function callerName(framesUp: number): string {
  const line = new Error().stack?.split('\n')[framesUp + 1]?.trim();
  if (!line) return '?';
  const name = line.replace(/^at\s+/, '').replace(/^async\s+/, '').split(' ')[0];
  if (!name || name.startsWith('file:') || name.startsWith('node:') || name.startsWith('/')) return '?';
  return name;
}
