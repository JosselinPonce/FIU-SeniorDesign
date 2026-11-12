import { responsivenessProbe } from '../voice/responsivenessDiagnostics.ts';
/** Event-scoped presentation only. Never interpretation, severity or consent. */
export type AcknowledgmentContext = Readonly<{
  event: 'bpm_high' | 'bpm_low' | 'spo2_low';
  outcome: 'not_ok';
  language: 'en' | 'es';
  statement: string | null;
}>;

const GENERIC = {
  en: ["I'm sorry to hear that.", 'I hear you.', 'Thank you for telling me.', 'That sounds uncomfortable.'],
  es: ['Lamento que te sientas así.', 'Te escucho.', 'Gracias por decírmelo.', 'Eso suena incómodo.'],
} as const;
// Whole first-person reports only. Unknown, negated, quoted, action-bearing,
// identifying or instruction-like text is omitted rather than sent to the model.
const REPORT = {
  en: /^(?:i(?: am|'m| feel)|im)(?: feeling)? (dizzy|lightheaded|tired|sleepy|weak|nauseous|unwell|sick|not okay|not ok|not well)[.!]?$/i,
  es: /^(?:estoy|me siento) (mareado|mareada|cansado|cansada|débil|debil|mal|con náuseas|con nauseas)[.!]?$/i,
};
export function acknowledgmentContext(event: AcknowledgmentContext['event'], language: AcknowledgmentContext['language'], statement?: string | null): AcknowledgmentContext {
  if (!['bpm_high', 'bpm_low', 'spo2_low'].includes(event) || !['en', 'es'].includes(language)) throw new Error('Invalid acknowledgment context');
  let text = typeof statement === 'string' ? statement.trim().replace(/’/g, "'") : '';
  text = text.replace(/^(?:um|uh|well|pues|bueno)[, ]+/i, '').replace(/\b(really|very|muy|tan),\s*/gi, '$1 ');
  // Canonicalize only complete, explicit first-person reports. The model still
  // receives the bounded feeling, never arbitrary trailing clauses or instructions.
  if (!REPORT[language].test(text)) {
  const natural = language === 'en'
    ? text.match(/^(?:no[, ]+)?(?:i(?: am|'m| feel)|im)(?: feeling)? (?:(?:really|very|a little|so|quite) ){0,4}(dizzy|lightheaded|tired|sleepy|weak|nauseous|unwell|sick|exhausted)[.!]?$/i)
    : text.match(/^(?:no,\s*)?(?:estoy|me siento) (?:(?:muy|un poco|tan|realmente) ){0,4}(mareado|mareada|cansado|cansada|débil|debil|mal|con náuseas|con nauseas)[.!]?$/i);
  if (natural) text = language === 'en' ? `I'm feeling ${natural[1]!.toLowerCase().replace('exhausted', 'tired')}` : `Me siento ${natural[1]!.toLowerCase()}`;
  if (language === 'es' && /^no me siento (?:muy )?bien[.!]?$/i.test(text)) text = 'Me siento mal';
  if (language === 'en' && /^(?:no[, ]+)?i(?:'m| am) not feeling (?:very )?well[.!]?$/i.test(text)) text = "I'm feeling unwell";
  }
  return Object.freeze({ event, outcome: 'not_ok', language,
    statement: text.length <= 160 && REPORT[language].test(text) ? text : null });
}
function reflection(context: AcknowledgmentContext): string | null {
  const match = context.statement?.match(REPORT[context.language]);
  if (!match) return null;
  return match[1]!.toLowerCase().replace(/not okay|not ok|not well/, 'unwell')
    .replace('debil', 'débil').replace('con nauseas', 'con náuseas');
}
/** Compositional, closed grammar: only empathy and explicitly reported feelings.
 * This intentionally rejects fluent but unprovable free-form model prose. */
export function acknowledgmentCandidates(context: AcknowledgmentContext): string[] {
  const feeling = reflection(context);
  const values: string[] = feeling ? [] : [...GENERIC[context.language]];
  if (feeling) {
    const heads = context.language === 'en'
      ? [`I'm sorry you're feeling ${feeling}.`, `I hear that you're feeling ${feeling}.`, `Thank you for telling me you're feeling ${feeling}.`]
      : [`Lamento que te sientas ${feeling}.`, `Entiendo que te sientes ${feeling}.`, `Gracias por decirme que te sientes ${feeling}.`];
    values.push(...heads);
  }
  return [...new Set(values)];
}
/** Eligibility never infers meaning from excluded text. */
export function canGenerateAcknowledgment(context: AcknowledgmentContext): boolean {
  return context.outcome === 'not_ok'
    && reflection(acknowledgmentContext(context.event, context.language, context.statement)) !== null;
}
export function acknowledgmentPrompt(context: AcknowledgmentContext): string {
  const safe = acknowledgmentContext(context.event, context.language, context.statement);
  if (!canGenerateAcknowledgment(context)) throw new Error('No eligible driver feeling for acknowledgment inference.');
  const feeling = reflection(safe)!;
  // One form, no candidate array or first-person driver quotation to imitate.
  // The existing exact-match validator remains authoritative, regardless of prose.
  if (safe.language === 'es') {
    // This example comes from the existing grounded allowlist, not model text.
    // Keep the reported gender/feeling; never repair or substitute into output.
    const example = acknowledgmentCandidates(safe)[0]!;
    return `Eres Sensi y respondes al conductor.
Evento: ${safe.event}. Resultado fijo: not_ok.
El conductor se siente: ${feeling}.
Escribe UNA sola oración en español dirigida al conductor con te o tú. No hables como si fueras el conductor.
Esta es una respuesta completa y apropiada para este caso:
${example}
Devuelve solo una oración completa que reconozca ese estado. Sin comillas, listas, alternativas, explicaciones, preguntas, instrucciones, diagnósticos, consejos médicos, promesas, nombres ni otras sensaciones.`;
  }
  return `You are Sensi, replying to a driver.
Safety event: ${safe.event}. Fixed outcome: not_ok.
The driver reports feeling: ${feeling}.
Write ONE English sentence addressed to the driver as you. Do not speak as the driver.
Complete this form by replacing FEELING with the reported feeling:
I'm sorry you're feeling FEELING.
Return only the completed sentence. No quotes, lists, alternatives, explanations, questions, instructions, diagnoses, medical advice, action promises, names or other symptoms.`;
}
export function validateAcknowledgment(value: unknown, context: AcknowledgmentContext): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text.length > 180 || text.split(/\s+/).length > 24 || /[\r\n]/.test(text)) return null;
  return acknowledgmentCandidates(context).includes(text) ? text : null;
}
export function approvedAcknowledgment(value: unknown, lang: 'en' | 'es', context?: AcknowledgmentContext): string {
  const safe = context && context.language === lang ? context : acknowledgmentContext('bpm_high', lang);
  return validateAcknowledgment(value, safe) ?? GENERIC[lang][0];
}
export type SafetyAcknowledgment = { get(lang: 'en' | 'es'): string; cancel(): void; readonly source: 'gemma' | 'fallback' };

/** Runs during mandatory guidance, never awaited by the safety workflow. get()
 * consumes once and aborts; late completion has no publication authority. */
export function startSafetyAcknowledgment(generate: (signal: AbortSignal) => Promise<string>, context: AcknowledgmentContext, ms = 5000): SafetyAcknowledgment {
  const trace = typeof __DEV__ !== 'undefined' && __DEV__ ? responsivenessProbe('warning', 'Gemma contextual acknowledgment') : () => {};
  const safe = acknowledgmentContext(context.event, context.language, context.statement);
  if (typeof __DEV__ !== 'undefined' && __DEV__) trace('eligibility', { locale: safe.language, usable: canGenerateAcknowledgment(safe) });
  if (!canGenerateAcknowledgment(context)) {
    if (typeof __DEV__ !== 'undefined' && __DEV__) trace('inference skipped', { reason: 'ineligible_statement', fallbackText: true });
    return { get: lang => approvedAcknowledgment(null, lang), cancel() {}, source: 'fallback' };
  }
  const abort = new AbortController();
  let attempted = false;
  let ready: string | null = null;
  let consumed = false;
  let source: 'gemma' | 'fallback' = 'fallback';
  const timer = setTimeout(() => { if (typeof __DEV__ !== 'undefined' && __DEV__) trace('fallback', { reason: 'timeout', fallbackText: true }); ready = null; abort.abort(); }, ms);
  void Promise.resolve().then(() => {
    if (abort.signal.aborted) { if (typeof __DEV__ !== 'undefined' && __DEV__) trace('inference skipped', { reason: 'consumed_before_start' }); return ''; }
    attempted = true; if (typeof __DEV__ !== 'undefined' && __DEV__) trace('inference attempted'); return generate(abort.signal);
  }).then(text => {
    if (attempted) if (typeof __DEV__ !== 'undefined' && __DEV__) trace('inference completed', { cancelled: abort.signal.aborted, usable: !!validateAcknowledgment(text, safe), reason: validateAcknowledgment(text, safe) ? 'accepted' : 'output_contract_rejected' });
    if (!abort.signal.aborted && !consumed) ready = validateAcknowledgment(text, safe);
  }).catch(() => { if (typeof __DEV__ !== 'undefined' && __DEV__) trace('inference failed', { reason: 'unavailable_or_lifecycle_failure' }); }).finally(() => clearTimeout(timer));
  return {
    get(lang) {
      const text = !consumed && !abort.signal.aborted && lang === safe.language ? ready : null;
      source = text ? 'gemma' : 'fallback';
      if (typeof __DEV__ !== 'undefined' && __DEV__) trace('acknowledgment selected', { source, fallbackText: !text, reason: text ? 'accepted' : consumed ? 'already_consumed' : abort.signal.aborted ? 'cancelled_or_timeout' : 'not_ready_or_rejected' });
      consumed = true; ready = null; clearTimeout(timer); abort.abort();
      return approvedAcknowledgment(text, lang, safe);
    },
    cancel() {
      if (typeof __DEV__ !== 'undefined' && __DEV__) trace('cancelled', { cancelled: true });
      consumed = true; ready = null; clearTimeout(timer); abort.abort(); },
    get source() { return source; },
  };
}
