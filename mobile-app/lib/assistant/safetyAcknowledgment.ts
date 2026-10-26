/** Presentation vocabulary only. No measurements, transcripts, profiles or actions. */
export const CONCERN_ACKNOWLEDGMENTS = ["I'm sorry to hear that.", 'I hear you.'] as const;
export const CONCERN_ACK_PROMPT = `Task: concern_acknowledgment. Select one empathetic acknowledgment. Reply with exactly one of these strings and nothing else: ${CONCERN_ACKNOWLEDGMENTS.join(' | ')}`;
export function approvedAcknowledgment(value: unknown, lang: 'en' | 'es'): string {
  if (lang === 'es') return 'Lamento que te sientas así.';
  return typeof value === 'string' && CONCERN_ACKNOWLEDGMENTS.includes(value.trim() as typeof CONCERN_ACKNOWLEDGMENTS[number])
    ? value.trim() : CONCERN_ACKNOWLEDGMENTS[0];
}
export type SafetyAcknowledgment = { get(lang: 'en' | 'es'): string; cancel(): void; readonly source: 'gemma' | 'fallback' };

/** Begin during the wellness question. Reading never waits and freezes a single
 * answer; a late model completion cannot add speech or influence safety state. */
export function startSafetyAcknowledgment(generate: (signal: AbortSignal) => Promise<string>, ms = 5000): SafetyAcknowledgment {
  const abort = new AbortController();
  let ready: string | null = null;
  let consumed = false;
  let source: 'gemma' | 'fallback' = 'fallback';
  const timer = setTimeout(() => abort.abort(), ms);
  void Promise.resolve().then(() => {
    if (abort.signal.aborted) return '';
    return generate(abort.signal);
  }).then(text => {
    if (!abort.signal.aborted && !consumed && CONCERN_ACKNOWLEDGMENTS.includes(text.trim() as typeof CONCERN_ACKNOWLEDGMENTS[number])) ready = text.trim();
  }).catch(() => {}).finally(() => clearTimeout(timer));
  return {
    get(lang) {
      const text = !abort.signal.aborted ? ready : null;
      source = lang === 'en' && text ? 'gemma' : 'fallback';
      consumed = true; clearTimeout(timer); abort.abort();
      return approvedAcknowledgment(text, lang);
    },
    cancel() { consumed = true; ready = null; clearTimeout(timer); abort.abort(); },
    get source() { return source; },
  };
}
