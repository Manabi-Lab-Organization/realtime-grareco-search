
interface ParticipantWithSpeakerIds {
  name?: string;
  speakerIds?: unknown;
}

export type SpeakerMapping = Map<number, string>;

export function buildSpeakerMapping(
  participants: ParticipantWithSpeakerIds[] | unknown
): SpeakerMapping {
  const map: SpeakerMapping = new Map();
  if (!Array.isArray(participants)) return map;
  for (const p of participants) {
    if (!p || typeof p !== 'object') continue;
    const name = (p as ParticipantWithSpeakerIds).name;
    const ids = (p as ParticipantWithSpeakerIds).speakerIds;
    if (!name || typeof name !== 'string' || !Array.isArray(ids)) continue;
    for (const sid of ids) {
      if (typeof sid === 'number' && Number.isFinite(sid)) {
        map.set(sid, name);
      }
    }
  }
  return map;
}

export function applySpeakerMapping<T extends { speaker: string | null; speakerId: number | null }>(
  rows: T[],
  mapping: SpeakerMapping
): T[] {
  if (mapping.size === 0) return rows;
  return rows.map((row) => {
    if (row.speakerId == null) return row;
    const mapped = mapping.get(row.speakerId);
    if (!mapped) return row;
    return { ...row, speaker: mapped };
  });
}
