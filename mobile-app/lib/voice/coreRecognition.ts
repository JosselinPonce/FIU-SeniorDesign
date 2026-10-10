/** In-memory recognition evidence. Text alone is never contact consent. */
export type CoreRecognition = {
  captureId: string;
  status: 'success' | 'incomplete' | 'timeout' | 'cancelled' | 'error' | 'stale';
  transcript: string;
  finalTranscript: string;
  isFinal: boolean;
  finalResultReceived: boolean;
  cancelled: boolean;
};
export function successfulFinal(result: CoreRecognition, captureId: string): boolean {
  return result.captureId === captureId && result.status === 'success' && !result.cancelled
    && result.isFinal === true && result.finalResultReceived === true && !!result.finalTranscript.trim()
    && result.transcript.trim() === result.finalTranscript.trim();
}
export function recognitionEvidence(captureId: string, result: {
  status: CoreRecognition['status']; transcript: string; finalTranscript?: string;
  isFinal: boolean; finalResultReceived?: boolean;
}, current = true): CoreRecognition {
  return { ...result, captureId, status: current ? result.status : 'stale',
    finalTranscript: result.finalTranscript ?? '', finalResultReceived: result.finalResultReceived === true,
    cancelled: result.status === 'cancelled' };
}
