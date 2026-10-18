
const partialTranscripts = new Map<number, string>();

export function setPartialTranscript(meetingId: number, text: string): void {
  partialTranscripts.set(meetingId, text);
}

export function clearPartialTranscript(meetingId: number): void {
  partialTranscripts.delete(meetingId);
}

export function getPartialTranscript(meetingId: number): string | null {
  return partialTranscripts.get(meetingId) ?? null;
}
