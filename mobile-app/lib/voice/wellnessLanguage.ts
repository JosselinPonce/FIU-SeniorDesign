/**
 * Event-scoped wellness meaning only. Never call consent or a medical diagnosis.
 *
 * Invariant: a named symptom vetoes OK. Every OK return requires
 * `symptomScan` to find no affirmative symptom, except a single affirmative
 * fatigue token under a mild hedge ("just a bit tired", "solo cansada");
 * a hedge blocks OK. Current physical concerns retain the checkpoint's
 * conservative handling even when the driver qualifies them with "maybe".
 */
import { HEDGES, symptomScan } from './symptomLexicon.ts';

export type WellnessCategory = 'fatigue' | 'dizziness' | 'discomfort' | 'other' | 'none';
/** Positive evidence is bounded to a complete wellness answer. An arbitrary
 * trailing clause must not be cleared just because it starts with "I'm fine".
 * Unknown wording still has the ordinary clarification/manual-answer route. */
export function clearWellnessAffirmation(t: string, original = t): boolean {
  // A punctuated first-person/Spanish discourse answer is distinct from unpunctuated no bien.
  if (/^no,\s*(?:estoy|me siento|me encuentro|todo|muy|bien|i'm|i am|i feel)\b/i.test(original)) t = t.replace(/^no /, '');
  if (/^(?:yes|yeah|yep|yup|sure|si|claro)(?: please| thanks| gracias)?$/.test(t)) return true;
  const prefix = "(?:(?:yes|yeah|yep|yup|sure|absolutely|mm hmm|of course|si|claro) )*";
  const positive = "(?:(?:(?:i'm|im|i am|i feel|i'm feeling|i am feeling|i'm doing|i am doing) )?(?:(?:really|very|totally|perfectly|absolutely) )?(?:okay|ok|fine|good|well|great|alright|all right)|all good|everything(?:'s| is) (?:okay|ok|fine|all right)|(?:(?:estoy|me siento|me encuentro) )?(?:muy |perfectamente )?bien|todo (?:esta )?bien|not bad|fine fine|(?:no )?(?:i )?(?:don't|dont|do not) need (?:any )?(?:help|anything)|no necesito (?:ayuda|nada))";
  const benign = "(?:thank you|thanks|gracias|man|bro|why|at all|it was nothing|just hit a bump|(?:i )?(?:don't|dont|do not) need (?:any )?(?:help|anything|an ambulance|a doctor)|(?:i )?just had a (?:long|rough) day|(?:i'm |i am )?just a (?:bit|little) (?:tired|sleepy)|solo (?:un poco )?cansad[oa])";
  const negated = "(?:(?:and|but) )?(?:(?:(?:i'm|im|i am|i feel) )?(?:not|no longer|without|don't feel|dont feel)|(?:i )?(?:have no|do not have|don't have|dont have)) (?:a |any |really |very )?(?:headache|dizzy|tired|sleepy|pain|weak|sick|nauseous)|(?:(?:y|pero) )?(?:no estoy|no me siento|no tengo|sin) (?:un |una |muy )?(?:dolor de cabeza|dolor|maread[oa]|cansad[oa])";
  return new RegExp(`^${prefix}${positive}(?: (?:${benign}|${negated}))*$`).test(t);
}
export function wellnessLanguage(t: string, original = t): { intent: 'ok' | 'not_ok' | 'unclear'; context: WellnessCategory } | null {
  if (/^no,\s*(?:estoy|me siento)\b/i.test(original)) t = t.replace(/^no /, '');
  if (/\b(she|he|they|my friend|mi amig[oa])\b/.test(t)
      || /\b(yesterday|ayer|last year|used to)\b/.test(t) && !/\b(now|ahora|today|hoy)\b/.test(t)) return { intent: 'unclear', context: 'other' };
  const uncertain = /\b(i don't know|i dont know|not sure|unsure|something feels off|no se|no estoy segur[oa]|me siento rar[oa]|tal vez|quizas|perhaps|maybe)\b/.test(t);
  const fatigue = /\b(tired|sleepy|exhausted|worn out|long day|rough day|cansad[oa]|agotad[oa]|sueno|dia largo|dia dificil)\b/.test(t);
  const unsafe = /\b(dizzy|lightheaded|faint|pass out|barely stay awake|cannot stay awake|can't stay awake|cant stay awake|struggling to stay awake|mare[oa]|maread[oa]|desmay\w*|no puedo mantenerme despiert[oa])\b/;
  // Negation is local to the symptom phrase, never an entire mixed statement.
  const affirmed = t.replace(/\b(?:not|no longer|don't feel|dont feel) (?:(?:really|very) )?(?:dizzy|lightheaded|tired|sleepy|weak|sick|nauseous)\b/g, '')
    .replace(/\b(?:no estoy|no me siento) (?:(?:muy|tan) ){0,3}(?:maread[oa]|cansad[oa])\b/g, '');
  // Scan the raw answer: removing normalized negation first loses corrections
  // such as "estoy bien, no, estoy mareada".
  const scan = symptomScan(original);
  // HEDGES is written for normalised text; "not feeling myself" is both a
  // hedge and an 'other' token, so a hedge match wins over any symptom branch.
  const hedged = HEDGES.test(t);
  const mildFatigue = !hedged && scan.kind === 'affirmative' && scan.categories.length === 1
    && scan.categories[0] === 'fatigue' && /\b(?:just a little|just a bit|only a little|solo|solamente)\b/.test(affirmed);
  const okAllowed = !hedged && (scan.kind === 'none' || mildFatigue);
  if (scan.kind === 'negated_only' || scan.kind === 'historical_only') return { intent: 'unclear', context: 'none' };
  // Restore the checkpoint's cautious handling of a named current concern,
  // including "maybe I feel dizzy". A hedge blocks OK; it does not erase a
  // reported physical symptom or delay its deterministic guidance.
  {
    if (unsafe.test(affirmed)) return { intent: 'not_ok', context: /dizzy|lightheaded|mare/.test(affirmed) ? 'dizziness' : 'fatigue' };
    if (/\b(weak|sick|nauseous|pain|numb|blurry|shaking|sweating|racing|pounding|mal|dolor|debil)\b/.test(affirmed)) return { intent: 'not_ok', context: 'discomfort' };
    if (scan.kind === 'affirmative' && !mildFatigue) return { intent: 'not_ok', context: scan.categories[0] === 'fatigue' ? 'fatigue' : scan.categories[0] === 'dizziness' ? 'dizziness' : 'discomfort' };
  }
  if (affirmed !== t) return { intent: okAllowed && /\b(?:i'm|i am|im|i feel) (?:okay|ok|fine|good|well)\b|\bestoy bien\b/.test(affirmed) ? 'ok' : 'unclear', context: 'none' };
  if (/\b(not feeling (?:\w+ )?well|no me siento (?:muy )?bien|no estoy (?:muy )?bien)\b/.test(t)) return { intent: 'not_ok', context: 'discomfort' };
  if (uncertain) return { intent: 'unclear', context: fatigue ? 'fatigue' : 'other' };
  if (hedged) return { intent: 'unclear', context: 'other' };
  if (scan.kind === 'none' && clearWellnessAffirmation(t, original)) return { intent: 'ok', context: 'none' };
  const positive = /\b(?:i'm|im|i am|i feel|i am feeling|i'm feeling) (?:really |very )?(?:ok|okay|fine|good|well)\b|\b(?:estoy|me siento) (?:muy )?bien\b/.test(t);
  const mildContext = /\b(?:just|only|solo|solamente)\b/.test(t) && fatigue && !/\b(exhausted|agotad[oa]|barely|cannot|can't|cant)\b/.test(t);
  const negative = /\b(not|don't|dont|never|no estoy|no me siento)\b/.test(t);
  if (positive && !negative && okAllowed && (!fatigue || mildContext) && !/\b(sick|pain|weak|nause\w*|unwell|mal|dolor|debil)\b/.test(affirmed)) return { intent: 'ok', context: fatigue ? 'fatigue' : 'none' };
  if (fatigue && /\b(i'm|im|i am|i feel|feeling|estoy|me siento)\b/.test(t) && !/\b(?:not|no longer) (?:\w+ )?(?:tired|sleepy)|\bno (?:estoy|me siento) (?:\w+ )?cansad[oa]/.test(t)) return { intent: 'not_ok', context: 'fatigue' };
  return null;
}
