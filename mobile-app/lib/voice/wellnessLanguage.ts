/**
 * Event-scoped wellness meaning only. Never call consent or a medical diagnosis.
 *
 * A current symptom vetoes OK, including mild fatigue. A hedge also blocks
 * OK. Current physical concerns retain conservative handling even when the
 * driver qualifies them with "maybe".
 */
import { HEDGES, SPANISH_LONG_DAY, symptomScan, withoutSpanishLongDayAuxiliary } from './symptomLexicon.ts';

export type WellnessCategory = 'fatigue' | 'dizziness' | 'discomfort' | 'other' | 'none';
const REASSURANCE = /^(?:no )?(?:nothing(?:'s| is) wrong|nada (?:anda|esta) mal)(?: (?:thank you|thanks|gracias)(?: sensi)?)?$/;
const IMPROVEMENT = "(?:(?:i'm|im|i am) feeling better(?: now)?|i feel better(?: now)?|(?:ya )?me siento mejor(?: ahora)?)";
const ONLY_IMPROVEMENT = new RegExp(`^(?:${IMPROVEMENT}|could be better|podria estar mejor)$`);
const IMPROVEMENT_FIRST = new RegExp(`^${IMPROVEMENT} (?:and|y) `);
const IMPROVEMENT_LAST = new RegExp(` (?:and|y) ${IMPROVEMENT}$`);

/** Positive evidence is bounded to a complete wellness answer. An arbitrary
 * trailing clause must not be cleared just because it starts with "I'm fine".
 * Unknown wording still has the ordinary clarification/manual-answer route. */
export function clearWellnessAffirmation(t: string, original = t): boolean {
  // A punctuated first-person/Spanish discourse answer is distinct from unpunctuated no bien.
  if (/^no,\s*(?:estoy|me siento|me encuentro|todo|muy|bien|i'm|i am|i feel)\b/i.test(original)) t = t.replace(/^no /, '');
  // Conversational no may precede a complete English first-person affirmation.
  // The whole-answer grammar below and the final symptom veto still apply.
  t = t.replace(/^(?:no|nah) (?=(?:i'm|im|i am|i feel) )/, '');
  if (REASSURANCE.test(t)) return true;
  if (/^(?:yes|yeah|yep|yup|sure|si|claro)(?: please| thanks| gracias)?$/.test(t)) return true;
  // Improvement can accompany a complete affirmative clause, never a bare yes.
  t = IMPROVEMENT_FIRST.test(t) ? t.replace(IMPROVEMENT_FIRST, '') : t.replace(IMPROVEMENT_LAST, '');
  const prefix = "(?:(?:yes|yeah|yep|yup|sure|absolutely|mm hmm|of course|si|claro) )*";
  const englishSubject = "(?:i'm|im|i am|i feel|i'm feeling|i am feeling|i'm doing|i am doing)";
  const englishState = "(?:(?:really|very|totally|perfectly|absolutely) )?(?:okay|ok|fine|good|well|great|alright|all right)";
  const spanishSubject = "(?:estoy|me siento|me encuentro)";
  const spanishState = "(?:muy |perfectamente )?bien";
  const positive = `(?:(?:${englishSubject} )?${englishState}|all good|everything(?:'s| is) (?:okay|ok|fine|all right)|(?:${spanishSubject} )?${spanishState}|todo (?:esta )?bien|not bad|fine fine|(?:no )?(?:i )?(?:don't|dont|do not) need (?:any )?(?:help|anything)|no necesito (?:ayuda|nada))`;
  const repeatedAffirmation = `(?:(?:and|y) )?(?:${englishSubject} ${englishState}|${spanishSubject} ${spanishState})`;
  const benign = "(?:(?:thank you|thanks|gracias)(?: sensi)?|sensi|man|bro|why|at all|it was nothing|just hit a bump|(?:i )?(?:don't|dont|do not) need (?:any )?(?:help|anything|an ambulance|a doctor)|(?:i )?just had a (?:long|rough) day|" + SPANISH_LONG_DAY + ")";
  const negated = "(?:(?:and|but) )?(?:(?:(?:i'm|im|i am|i feel) )?(?:not|no longer|without|don't feel|dont feel)|(?:i )?(?:have no|do not have|don't have|dont have)) (?:a |any |really |very )?(?:headache|dizzy|tired|sleepy|pain|weak|sick|nauseous)|(?:(?:y|pero) )?(?:no estoy|no me siento|no tengo|sin) (?:un |una |muy )?(?:dolor de cabeza|dolor|maread[oa]|cansad[oa])";
  return new RegExp(`^${prefix}${positive}(?: (?:${benign}|${negated}|${repeatedAffirmation}))*$`).test(t);
}
export function wellnessLanguage(t: string, original = t): { intent: 'ok' | 'not_ok' | 'unclear'; context: WellnessCategory } | null {
  if (/^no,\s*(?:estoy|me siento)\b/i.test(original)) t = t.replace(/^no /, '');
  if (/\b(she|he|they|my friend|mi amig[oa])\b/.test(withoutSpanishLongDayAuxiliary(t))
      || /\b(yesterday|ayer|last year|used to)\b/.test(t) && !/\b(now|ahora|today|hoy)\b/.test(t)) return { intent: 'unclear', context: 'other' };
  if (ONLY_IMPROVEMENT.test(t)) return { intent: 'unclear', context: 'other' };
  const uncertain = /\b(i don't know|i dont know|not sure|unsure|something feels off|no se|no estoy segur[oa]|me siento rar[oa]|tal vez|quizas|perhaps|maybe)\b/.test(t);
  const fatigue = /\b(tired|sleepy|exhausted|worn out|long day|rough day|cansad[oa]|agotad[oa]|sueno|dia largo|dia dificil)\b/.test(t);
  const unsafe = /\b(dizzy|lightheaded|faint|pass out|mare[oa]|maread[oa]|desmay\w*)\b/;
  // Negation is local to the symptom phrase, never an entire mixed statement.
  const affirmed = t.replace(/\b(?:not|no longer|don't feel|dont feel) (?:(?:really|very) )?(?:dizzy|lightheaded|tired|sleepy|weak|sick|nauseous)\b/g, '')
    .replace(/\b(?:no estoy|no me siento) (?:(?:muy|tan) ){0,3}(?:maread[oa]|cansad[oa])\b/g, '');
  // Scan the raw answer: removing normalized negation first loses corrections
  // such as "estoy bien, no, estoy mareada".
  const scan = symptomScan(original);
  // HEDGES is written for normalised text; "not feeling myself" is both a
  // hedge and an 'other' token, so a hedge match wins over any symptom branch.
  const hedged = HEDGES.test(t);
  const okAllowed = !hedged && scan.kind === 'none';
  if (!hedged && scan.kind === 'none' && REASSURANCE.test(t)) return { intent: 'ok', context: 'none' };
  if (scan.kind === 'negated_only' || scan.kind === 'historical_only') return { intent: 'unclear', context: 'none' };
  // Restore the checkpoint's cautious handling of a named current concern,
  // including "maybe I feel dizzy". A hedge blocks OK; it does not erase a
  // reported physical symptom or delay its deterministic guidance.
  {
    if (unsafe.test(affirmed)) return { intent: 'not_ok', context: /dizzy|lightheaded|mare/.test(affirmed) ? 'dizziness' : 'fatigue' };
    if (/\b(weak|sick|nauseous|pain|numb|blurry|shaking|sweating|racing|pounding|mal|dolor|debil)\b/.test(affirmed)) return { intent: 'not_ok', context: 'discomfort' };
    if (scan.kind === 'affirmative') return { intent: 'not_ok', context: scan.categories[0] === 'fatigue' ? 'fatigue' : scan.categories[0] === 'dizziness' ? 'dizziness' : 'discomfort' };
  }
  if (affirmed !== t) return { intent: okAllowed && /\b(?:i'm|i am|im|i feel) (?:okay|ok|fine|good|well)\b|\bestoy bien\b/.test(affirmed) ? 'ok' : 'unclear', context: 'none' };
  if (/\b(not feeling (?:\w+ )?well|no me siento (?:muy )?bien|no estoy (?:muy )?bien)\b/.test(t)) return { intent: 'not_ok', context: 'discomfort' };
  if (uncertain) return { intent: 'unclear', context: fatigue ? 'fatigue' : 'other' };
  if (hedged) return { intent: 'unclear', context: 'other' };
  if (scan.kind === 'none' && clearWellnessAffirmation(t, original)) return { intent: 'ok', context: 'none' };
  const positive = /\b(?:i'm|im|i am|i feel|i am feeling|i'm feeling) (?:really |very )?(?:ok|okay|fine|good|well)\b|\b(?:estoy|me siento) (?:muy )?bien\b/.test(t);
  const negative = /\b(not|don't|dont|never|no estoy|no me siento)\b/.test(t);
  if (positive && !negative && okAllowed && !fatigue && !/\b(sick|pain|weak|nause\w*|unwell|mal|dolor|debil)\b/.test(affirmed)) return { intent: 'ok', context: fatigue ? 'fatigue' : 'none' };
  if (fatigue && /\b(i'm|im|i am|i feel|feeling|estoy|me siento)\b/.test(t) && !/\b(?:not|no longer) (?:\w+ )?(?:tired|sleepy)|\bno (?:estoy|me siento) (?:\w+ )?cansad[oa]/.test(t)) return { intent: 'not_ok', context: 'fatigue' };
  return null;
}
