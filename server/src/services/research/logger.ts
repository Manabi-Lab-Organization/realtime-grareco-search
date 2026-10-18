
export function logOrchestrator(
  action: string,
  meetingId: number,
  details?: Record<string, unknown>
): void {
  console.log(`[research:Orchestrator] ${JSON.stringify({
    timestamp: new Date().toISOString(),
    action,
    meeting_id: meetingId,
    ...details,
  })}`);
}
