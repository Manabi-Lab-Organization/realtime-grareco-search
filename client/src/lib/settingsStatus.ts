export function settingsStatusText(loaded: boolean, loading: boolean): string | null {
  if (loaded) return null;
  return loading ? '読み込み中…' : '設定を読み込めませんでした';
}

export function knownOnOff(loaded: boolean, on: boolean): boolean | null {
  return loaded ? on : null;
}
