/**
 * Shared symptom and hedge vocabulary for the emergency voice check.
 *
 * Single source of truth for which spoken words name a symptom (and in which
 * category) and which phrases mark an uncommitted answer ("maybe", "no sé").
 * The wellness-language, Gemma-grounding and verdict-combining layers read
 * from here instead of keeping their own word lists.
 *
 * Invariants: pure and deterministic (no state, no I/O); a symptom token is
 * negated only when a negation cue lands within the two words immediately
 * before it, so a distant negative never flips an affirmative report. Text is
 * re-normalised defensively, so callers may pass raw or already-normalised
 * transcripts.
 */
import { normalise } from './intent.ts';

export type SymptomCategory =
  | 'fatigue' | 'dizziness' | 'cardiovascular' | 'respiratory'
  | 'neural' | 'pain' | 'nausea' | 'other'; // 'other' = lexicon token with no finer category
export type SymptomScan = {
  kind: 'affirmative' | 'negated_only' | 'none';
  hedged: boolean;
  categories: SymptomCategory[]; // categories of this statement's symptom tokens, empty when kind==='none'
};

// "i guess" / "i think" are deliberately NOT hedges: weak wellness phrasing
// must stay Gemma-clearable.
export const HEDGES: RegExp =
  /\b(?:maybe|perhaps|not sure|i don't know|i dont know|no sé|no se|tal vez|quiza|quizas|not feeling myself)\b/i;

// Lexicon as data: accent-stripped forms only (matching happens after
// normalise), single words match on word boundaries, multi-word tokens match
// as substrings of the normalised text. Spanish feminine/masculine endings
// are listed out because word-boundary matching cannot truncate them.
const LEXICON: Readonly<Record<SymptomCategory, readonly string[]>> = {
  fatigue: ['tired', 'sleepy', 'exhausted', 'worn out', 'cansada', 'cansado', 'agotada', 'agotado', 'sueno', 'fatigue', 'fatiga', 'cansancio'],
  dizziness: ['dizzy', 'lightheaded', 'mareada', 'mareado', 'mareo'],
  cardiovascular: ['chest pain', 'chest hurts', 'heart racing', 'heart pounding', 'taquicardia', 'dolor en el pecho', 'me duele el pecho'],
  respiratory: ["can't breathe", 'cant breathe', 'short of breath', 'hard to breathe', 'no puedo respirar', 'me falta el aire'],
  neural: ['headache', 'head hurts', 'numb', 'blurry vision', "can't see well", 'cant see well', 'dolor de cabeza', 'me duele la cabeza', 'entumecida', 'entumecido', 'vision borrosa'],
  pain: ['pain', 'hurts', 'ache', 'my arm hurts', 'dolor', 'duele', 'dolor de'],
  nausea: ['nauseous', 'sick to my stomach', 'throw up', 'nauseas', 'vomitar'],
  other: ['weak', 'unwell', 'under the weather', 'not feeling myself', 'weird', 'debil', 'enferma', 'enfermo', 'me siento mal'],
};

// Negation cue phrases; one negates a symptom token only when its last word
// falls within the two words immediately before the token.
const NEGATION_CUES: readonly string[] = ['not', 'no longer', "don't feel", 'dont feel', 'not really', 'no estoy', 'no me siento', 'sin'];

function tokenPattern(token: string): RegExp {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(token.includes(' ') ? escaped : `\\b${escaped}\\b`, 'g');
}

/** Char offset where each word of the normalised text begins. */
function wordStarts(words: readonly string[]): number[] {
  const starts: number[] = [];
  let at = 0;
  for (const word of words) { starts.push(at); at += word.length + 1; }
  return starts;
}

function wordIndexAt(starts: readonly number[], charAt: number): number {
  let index = 0;
  while (index + 1 < starts.length && starts[index + 1]! <= charAt) index += 1;
  return index;
}

/** True iff a cue's last word sits one or two words before the token. */
function isNegated(words: readonly string[], tokenWord: number): boolean {
  for (const cue of NEGATION_CUES) {
    const parts = cue.split(' ');
    for (let p = 0; p + parts.length <= words.length; p += 1) {
      const last = p + parts.length - 1;
      if (tokenWord > last && tokenWord - last <= 2 && parts.every((w, k) => words[p + k] === w)) return true;
    }
  }
  return false;
}

export function symptomScan(normalised: string): SymptomScan {
  const t = normalise(normalised);
  const hedged = HEDGES.test(t);
  const affirmative = new Set<SymptomCategory>();
  const negated = new Set<SymptomCategory>();
  if (t) {
    const words = t.split(' ');
    const starts = wordStarts(words);
    for (const [category, tokens] of Object.entries(LEXICON) as [SymptomCategory, readonly string[]][]) {
      for (const token of tokens) {
        const pattern = tokenPattern(token);
        for (let m = pattern.exec(t); m; m = pattern.exec(t)) {
          if (isNegated(words, wordIndexAt(starts, m.index))) negated.add(category);
          else affirmative.add(category);
        }
      }
    }
  }
  for (const category of affirmative) negated.delete(category);
  const categories = affirmative.size ? [...affirmative] : [...negated];
  const kind: SymptomScan['kind'] = affirmative.size ? 'affirmative' : negated.size ? 'negated_only' : 'none';
  return { kind, hedged, categories };
}
