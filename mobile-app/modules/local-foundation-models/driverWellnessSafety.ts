import { normalise } from '../../lib/voice/intent.ts';

/** Advisory dialogue cues only: never thresholds, emergency detection, or call consent. */
export function reportedDrivingConcern(raw: string): { symptoms: string[]; worsening: boolean } {
  if (/["“”]|(?:^|\s)['‘].*['’](?:$|\s|[.,!?])/.test(raw)) return { symptoms: [], worsening: false };
  const text = normalise(raw);
  if (/\b(?:if|what if|hypothetically|suppose)\b/.test(text)) return { symptoms: [], worsening: false };
  const patterns = [
    ['dizziness', 'dizzy|lightheaded|light headed|dizziness'],
    ['faintness', 'faint|faintness|fainting|passing out|about to pass out|going to pass out'],
    ['unwell', 'unwell|sick|ill|not okay|not ok|not well|not feeling okay|not feeling ok|not feeling well|not feeling good|nauseous|nauseated|nausea|weak'],
    ['breathing', "can't breathe|cannot breathe|can not breathe"],
    ['chest', 'chest pain'],
    ['alertness', 'sleepy|drowsy'],
  ];
  const symptoms: string[] = [];
  for (const [key, words] of patterns) {
    const cleaned = text.replace(new RegExp(`\\b(?:not|never|no longer|no|don't feel|dont feel|do not feel)(?: feeling| very| really| any)? (?:${words})\\b`, 'g'), '');
    const self = new RegExp(`\\b(?:i'm|im|i am|i feel|i have|i feel like i'm|i feel like i am)(?: feeling| getting| still)?(?: a little| a bit| slightly| really| very)? (?:${words})\\b`);
    const fragment = new RegExp(`^(?:no )?(?:feeling |a little |a bit |still )?(?:${words})\\b`);
    if (self.test(cleaned) || fragment.test(cleaned)
      || key === 'breathing' && /\bi (?:can't|cannot|can not) breathe\b/.test(cleaned)
      || key === 'faintness' && /\bi (?:might faint|might pass out|am about to faint|am going to faint)\b/.test(cleaned)) symptoms.push(key);
  }
  if (/\bi (?:don't|dont|do not) feel (?:well|okay|ok)\b/.test(text)) symptoms.push('unwell');
  return { symptoms, worsening: symptoms.length > 0 && /\b(?:worse|worsening|about to|going to|might pass out|might faint)\b/.test(text) || /^(?:it's |it is |i'm |i am )?(?:getting |feeling )?worse$/.test(text) };
}
export const PULL_OVER_GUIDANCE = "Please pull over when it's safe.";
