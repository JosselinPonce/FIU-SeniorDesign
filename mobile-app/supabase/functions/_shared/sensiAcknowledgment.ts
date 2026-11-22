/** Closed presentation grammar shared by mobile and server. No safety/action fields. */
export const FEELINGS = {
  en: ['dizzy', 'lightheaded', 'tired', 'sleepy', 'weak', 'nauseous', 'unwell', 'sick'],
  es: ['mareado', 'mareada', 'cansado', 'cansada', 'débil', 'mal', 'con náuseas'],
} as const;
export type AcknowledgmentRequest = { version: 3; requestId: string; language: 'en' | 'es'; feeling: string | null; utterance: string | null };
export function boundedFeeling(language: unknown, feeling: unknown): boolean {
  return (language === 'en' || language === 'es') && typeof feeling === 'string' && (FEELINGS[language] as readonly string[]).includes(feeling);
}
export function groundedCandidates(language: 'en' | 'es', feeling: string): string[] {
  if (!boundedFeeling(language, feeling)) return [];
  return language === 'en'
    ? [`I'm sorry you're feeling ${feeling}.`, `I hear that you're feeling ${feeling}.`, `Thank you for telling me you're feeling ${feeling}.`]
    : [`Lamento que te sientas ${feeling}.`, `Entiendo que te sientes ${feeling}.`, `Gracias por decirme que te sientes ${feeling}.`];
}
