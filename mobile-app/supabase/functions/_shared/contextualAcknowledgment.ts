import { boundedFeeling, groundedCandidates } from './sensiAcknowledgment.ts';
export const MAX_UTTERANCE_CHARS = 240;
export const MAX_ACK_CHARS = 220;
export const MAX_ACK_WORDS = 40;
type Language = 'en' | 'es';
type Feature = 'dizzy' | 'lightheaded' | 'shaky' | 'tired' | 'sleepy' | 'weak' | 'nauseous' | 'unwell' | 'sick' | 'worried' | 'nervous';
/** Presentation-only grounding. Never imported by the wellness/safety interpreter.
 * Whole supported first-person clauses only; unknown ownership/negation/context
 * rejects the ENTIRE utterance. This is not general NLP or reliable PII redaction. */
const labels: Record<Language, Record<Feature, string>> = {
  en: { dizzy: 'dizzy', lightheaded: 'lightheaded', shaky: 'shaky', tired: 'tired', sleepy: 'sleepy', weak: 'weak', nauseous: 'nauseous', unwell: 'unwell', sick: 'sick', worried: 'worried', nervous: 'nervous' },
  es: { dizzy: 'mareo', lightheaded: 'mareo', shaky: 'temblores', tired: 'cansancio', sleepy: 'sueño', weak: 'debilidad', nauseous: 'náuseas', unwell: 'malestar', sick: 'malestar', worried: 'preocupación', nervous: 'nerviosismo' },
};
const aliases: Record<Language, [Feature, RegExp][]> = {
  en: [['dizzy', /^dizzy$/], ['lightheaded', /^lightheaded$/], ['shaky', /^shaky$/], ['tired', /^(?:tired|exhausted)$/], ['sleepy', /^sleepy$/], ['weak', /^weak$/], ['nauseous', /^(?:nauseous|nauseated)$/], ['unwell', /^(?:unwell|not okay|not ok|not well|not feeling well)$/], ['sick', /^sick$/], ['worried', /^(?:worried|concerned)$/], ['nervous', /^(?:nervous|anxious)$/]],
  es: [['dizzy', /^(?:maread[oa]|con mareo)$/], ['shaky', /^(?:tembloros[oa]|con temblores)$/], ['tired', /^(?:cansad[oa]|agotad[oa])$/], ['sleepy', /^(?:somnolient[oa]|con sueno)$/], ['weak', /^debil$/], ['nauseous', /^con nauseas$/], ['unwell', /^mal$/], ['sick', /^enferm[oa]$/], ['worried', /^preocupad[oa]$/], ['nervous', /^(?:nervios[oa]|ansios[oa])$/]],
};
const normalize = (text: string) => text.toLowerCase().replace(/’/g, "'").normalize('NFD').replace(/[\u0300-\u036f]/g, '');
export function utteranceFeatures(language: Language, value: unknown): Feature[] | null {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_UTTERANCE_CHARS || value.trim().split(/\s+/).length > 48
    || /[\p{N}\p{C}<>@"“”‘]/u.test(value) || /(^|[^\p{L}])'|'($|[^\p{L}])/u.test(value)) return null;
  let text = normalize(value.trim()).replace(/^(?:um|uh|well|pues|bueno)[, ]+/, '');
  if (language === 'en') text = text.replace(/^no[, ]+(?=i(?:'m| am| feel)|im\b)/, '');
  else text = text.replace(/^no,\s*(?=estoy|me siento)/, '');
  const clauses = text.split(/\s*(?:[,;.!]+(?:\s*(?:and|y)\b)?|\band\b|\by\b)\s*/).filter(Boolean);
  if (!clauses.length || clauses.length > 3) return null;
  const found: Feature[] = [];
  for (const [index, original] of clauses.entries()) {
    let clause = original.replace(language === 'en' ? / (?:right now|today|this morning|since this morning|since yesterday)$/ : / (?:ahora|hoy|esta manana|desde esta manana|desde ayer)$/, '');
    const special: Feature | null = language === 'en'
      ? /^my head(?: is|'s) (?:(?:really|very) ){0,2}spinning$/.test(clause) ? 'dizzy' : /^my hands are shaking$/.test(clause) ? 'shaky' : null
      : /^(?:me da vueltas la cabeza|me esta dando vueltas la cabeza)$/.test(clause) ? 'dizzy' : /^me tiemblan las manos$/.test(clause) ? 'shaky' : /^no me siento (?:muy )?bien$/.test(clause) ? 'unwell' : null;
    if (special) { found.push(special); continue; }
    // Reviewed whole first-person constructions only, never keyword extraction.
    const reviewed: Feature | null = language === 'en'
      ? /^i (?:don't|do not) feel good$/.test(clause) ? 'unwell' : null
      : /^tengo nauseas$/.test(clause) ? 'nauseous' : /^tengo sueno$/.test(clause) ? 'sleepy' : /^me mareo$/.test(clause) ? 'dizzy' : null;
    if (reviewed) { found.push(reviewed); continue; }
    if (language === 'en' && /(?:tired|exhausted) after work$/.test(clause)) clause = clause.replace(/ after work$/, '');
    const prefix = language === 'en' ? /^(?:i am|i'm|im|i feel)(?: feeling)? / : /^(?:estoy|me siento) /;
    const owned = prefix.test(clause);
    if (!owned && index === 0) return null;
    clause = clause.replace(prefix, '').replace(language === 'en' ? /^(?:(?:really|very|so|a little|a bit|slightly|quite) ){1,4}/ : /^(?:(?:muy|un poco|un poquito|tan|realmente) ){1,4}/, '');
    const feature = aliases[language].find(([, pattern]) => pattern.test(clause))?.[0];
    if (!feature) return null;
    found.push(feature);
  }
  return [...new Set(found)];
}
export function permittedUtterance(language: Language, value: unknown): string | null {
  return utteranceFeatures(language, value) ? (value as string).trim() : null;
}
function feelingFeature(language: Language, feeling: string): Feature | undefined {
  return aliases[language].find(([, pattern]) => pattern.test(normalize(feeling)))?.[0];
}
function join(items: string[], language: Language): string {
  if (items.length === 1) return items[0]!;
  return items.slice(0, -1).join(', ') + (items.length > 2 && language === 'en' ? ',' : '') + (language === 'en' ? ' and ' : ' y ') + items.at(-1);
}
function permutations(items: string[]): string[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, i) => permutations(items.filter((_, j) => j !== i)).map(rest => [item, ...rest]));
}
/** Bounded compositional empathy, not a denylist pretending to validate arbitrary
 * prose. Every named symptom is independently grounded; no model-added context.
 * All supported reported features must be retained, in any order. */
export function contextualCandidates(language: Language, feeling: string | null, utterance: string | null): string[] {
  if (utterance === null) return feeling && boundedFeeling(language, feeling) ? groundedCandidates(language, feeling) : [];
  const features = utteranceFeatures(language, utterance);
  if (!features || (feeling !== null && (!boundedFeeling(language, feeling) || !features.includes(feelingFeature(language, feeling)!)))) return [];
  const words = [...new Set(features.map(feature => labels[language][feature]))];
  const candidates: string[] = [];
  for (const order of permutations(words)) {
    const description = join(order, language);
    const heads = language === 'en'
      ? [`I'm sorry you're feeling ${description}.`, `I hear that you're feeling ${description}.`, `Thank you for telling me you're feeling ${description}.`]
      : [`Lamento que estés pasando por ${description}.`, `Siento que estés pasando por ${description}.`, `Gracias por contarme que estás sintiendo ${description}.`];
    const tails = language === 'en' ? ['', ' That sounds unsettling.', ' That sounds uncomfortable.'] : ['', ' Suena inquietante.', ' Eso suena incómodo.'];
    for (const head of heads) for (const tail of tails) candidates.push(head + tail);
  }
  const description = join(words, language);
  candidates.push(...(language === 'en'
    ? [`Feeling ${description} sounds uncomfortable.`, `It sounds unsettling to feel ${description}.`]
    : [`Siento que tengas ${description}.`, `Gracias por explicarme que sientes ${description}.`]));
  // Direct head references require the actual head-spinning clause, not merely
  // a dizziness category. No new symptom equivalence is inferred here.
  const source = normalize(utterance);
  const headReported = language === 'en' ? /\bmy head(?: is|'s) (?:(?:really|very) ){0,2}spinning\b/.test(source)
    : /\bme (?:da vueltas la cabeza|esta dando vueltas la cabeza)\b/.test(source);
  if (headReported && features.includes('dizzy')) {
    const others = [...new Set(features.filter(feature => feature !== 'dizzy').map(feature => labels[language][feature]))];
    for (const order of permutations(others)) {
      const rest = order.length ? join(order, language) : '';
      candidates.push(...(language === 'en'
        ? [`I'm sorry your head is spinning${rest ? ` and you're feeling ${rest}` : ''}.`, `I hear that your head is spinning${rest ? ` and you're feeling ${rest}` : ''}.`]
        : [`Siento que te dé vueltas la cabeza${rest ? ` y que sientas ${rest}` : ''}.`, `Lamento que te dé vueltas la cabeza${rest ? ` y que sientas ${rest}` : ''}.`]));
    }
  }
  // Preserve previously accepted single-feeling phrasings, including Spanish gender.
  if (feeling && features.length === 1) candidates.push(...groundedCandidates(language, feeling));
  return [...new Set(candidates)].filter(text => text.length <= MAX_ACK_CHARS && text.split(/\s+/).length <= MAX_ACK_WORDS);
}
export function validateContextualAcknowledgment(value: unknown, language: Language, feeling: string | null, utterance: string | null): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > MAX_ACK_CHARS || text.split(/\s+/).length > MAX_ACK_WORDS || /[\r\n?¿<>\[\]{}]/.test(text)
    || text.split(/[.!]/).filter(part => part.trim()).length > 2) return null;
  return contextualCandidates(language, feeling, utterance).includes(text) ? text : null;
}
