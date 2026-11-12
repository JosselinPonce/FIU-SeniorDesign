export type ResponseRole = 'acknowledgment' | 'guidance' | 'emergency_guidance' | 'contact_offer';
export type ResponseSegment = Readonly<{ role: ResponseRole; text: string }>;
/** Only deterministic sentence boundaries, never model prose or contact names. */
export function safetyGuidancePlan(language: 'en' | 'es', urgent = false): ResponseSegment[] {
  return urgent
    ? [{ role: 'guidance', text: language === 'es' ? 'Detente en cuanto sea seguro y llama al 911 ahora.' : 'Pull over as soon as it is safe and call 911 now.' }]
    : [{ role: 'guidance', text: language === 'es' ? 'Por favor detente cuando sea seguro.' : 'Please pull over as soon as it is safe.' },
      { role: 'emergency_guidance', text: language === 'es' ? 'Si necesitas ayuda de emergencia, llama al 911.' : 'If you need emergency help, call 911.' }];
}
export function promptSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+(?=[A-ZÁÉÍÓÚ¿¡])/u).filter(Boolean);
}
/** Complete the mandatory prefix with only the ready, validated acknowledgment.
 * The prefix has already played; callers play only the appended segments. */
export function completeSafetyResponsePlan(prefix: readonly ResponseSegment[], acknowledgment: string, offer: string): readonly ResponseSegment[] {
  return Object.freeze([...prefix, ...(acknowledgment ? [{ role: 'acknowledgment' as const, text: acknowledgment }] : []), { role: 'contact_offer' as const, text: offer }]);
}
