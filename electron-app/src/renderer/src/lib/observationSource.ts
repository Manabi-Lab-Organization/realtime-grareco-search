export type ObservationSource = 'camera' | 'window' | 'display'

export function parseObservationSource(raw: string | null): ObservationSource {
  return raw === 'window' || raw === 'display' ? raw : 'camera'
}
