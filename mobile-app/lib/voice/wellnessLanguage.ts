/**
 * Event-scoped wellness meaning only. Never call consent or a medical diagnosis.
 *
 * Invariant: a named symptom vetoes OK. Every OK return requires
 * `symptomScan` to find no affirmative symptom, except a single affirmative
 * fatigue token under a mild hedge ("just a bit tired", "solo cansada");
 * a HEDGES match outranks every symptom branch here, so hedged symptom
 * statements fall through to unclear, never ok and never not_ok.
 */
import { HEDGES, symptomScan } from './symptomLexicon.ts';

export type WellnessCategory = 'fatigue' | 'dizziness' | 'discomfort' | 'other' | 'none';
export function wellnessLanguage(t: string, original = t): { intent: 'ok' | 'not_ok' | 'unclear'; context: WellnessCategory } | null {
  if (/^no,\s*(?:estoy|me siento)\b/i.test(original)) t = t.replace(/^no /, '');
  if (/\b(she|he|they|my friend|mi amig[oa]|yesterday|ayer|last year|used to)\b/.test(t)) return { intent: 'unclear', context: 'other' };
  const uncertain = /\b(i don't know|i dont know|not sure|unsure|something feels off|no se|no estoy segur[oa]|me siento rar[oa]|tal vez|quizas|perhaps|maybe)\b/.test(t);
  const fatigue = /\b(tired|sleepy|exhausted|worn out|long day|rough day|cansad[oa]|agotad[oa]|sueno|dia largo|dia dificil)\b/.test(t);
  const unsafe = /\b(dizzy|lightheaded|faint|pass out|barely stay awake|cannot stay awake|can't stay awake|cant stay awake|struggling to stay awake|mare[oa]|maread[oa]|desmay\w*|no puedo mantenerme despiert[oa])\b/;
  // Negation is local to the symptom phrase, never an entire mixed statement.
  const affirmed = t.replace(/\b(?:not|no longer|don't feel|dont feel) (?:(?:really|very) )?(?:dizzy|lightheaded|tired|sleepy|weak|sick|nauseous)\b/g, '')
    .replace(/\b(?:no estoy|no me siento) (?:(?:muy|tan) ){0,3}(?:maread[oa]|cansad[oa])\b/g, '');
  const scan = symptomScan(affirmed);
  // HEDGES is written for normalised text; "not feeling myself" is both a
  // hedge and an 'other' token, so a hedge match wins over any symptom branch.
  const hedged = HEDGES.test(t);
  const mildFatigue = !hedged && scan.kind === 'affirmative' && scan.categories.length === 1
    && scan.categories[0] === 'fatigue' && /\b(?:just a little|just a bit|only a little|solo|solamente)\b/.test(affirmed);
  const okAllowed = scan.kind === 'none' || mildFatigue;
  if (!hedged) {
    if (unsafe.test(affirmed)) return { intent: 'not_ok', context: /dizzy|lightheaded|mare/.test(affirmed) ? 'dizziness' : 'fatigue' };
    if (/\b(weak|sick|nauseous|pain|numb|blurry|shaking|sweating|racing|pounding|mal|dolor|debil)\b/.test(affirmed)) return { intent: 'not_ok', context: 'discomfort' };
    if (scan.kind === 'affirmative' && !mildFatigue) return { intent: 'not_ok', context: scan.categories[0] === 'fatigue' ? 'fatigue' : scan.categories[0] === 'dizziness' ? 'dizziness' : 'discomfort' };
  }
  if (affirmed !== t) return { intent: okAllowed && /\b(?:i'm|i am|im|i feel) (?:okay|ok|fine|good|well)\b|\bestoy bien\b/.test(affirmed) ? 'ok' : 'unclear', context: 'none' };
  if (/\b(not feeling (?:\w+ )?well|no me siento (?:muy )?bien|no estoy (?:muy )?bien)\b/.test(t)) return { intent: 'not_ok', context: 'discomfort' };
  if (uncertain) return { intent: 'unclear', context: fatigue ? 'fatigue' : 'other' };
  const positive = /\b(?:i'm|im|i am|i feel|i am feeling|i'm feeling) (?:really |very )?(?:ok|okay|fine|good|well)\b|\b(?:estoy|me siento) (?:muy )?bien\b/.test(t);
  const mildContext = /\b(?:just|only|solo|solamente)\b/.test(t) && fatigue && !/\b(exhausted|agotad[oa]|barely|cannot|can't|cant)\b/.test(t);
  const negative = /\b(not|don't|dont|never|no estoy|no me siento)\b/.test(t);
  if (positive && !negative && okAllowed && (!fatigue || mildContext) && !/\b(sick|pain|weak|nause\w*|unwell|mal|dolor|debil)\b/.test(affirmed)) return { intent: 'ok', context: fatigue ? 'fatigue' : 'none' };
  if (fatigue && /\b(i'm|im|i am|i feel|feeling|estoy|me siento)\b/.test(t) && !/\b(?:not|no longer) (?:\w+ )?(?:tired|sleepy)|\bno (?:estoy|me siento) (?:\w+ )?cansad[oa]/.test(t)) return { intent: 'not_ok', context: 'fatigue' };
  return null;
}
