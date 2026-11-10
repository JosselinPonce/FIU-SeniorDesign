import type { Lang, RecognitionPhase } from './voiceCheck';

/** Written guidance stays numeric; only the speech adapter expands the pronunciation. */
export function voiceCheckSpokenText(text: string, language: Lang): string {
  return text.replace(/\b911\b/g, language === 'es' ? 'nueve uno uno' : 'nine one one');
}

export function listeningPresentation(active: boolean, phase: RecognitionPhase | string | undefined, language: Lang) {
  return { visible: active && phase === 'listening',
    label: language === 'es' ? 'Escuchando…' : 'Listening…' };
}
