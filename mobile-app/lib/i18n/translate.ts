import { spanish } from './catalog.ts';
import type { AppLanguage } from './preferences.ts';
const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
const reverse = new Map(Object.entries(spanish).map(([en, es]) => [normalize(es), en]));
const patterns = Object.entries(spanish).filter(([key]) => key.includes('{')).flatMap(([en, es]) => {
  return [[en, es, 'es'], [es, en, 'en']].map(([source, target, language]) => {
    const names: string[] = [];
    const expression = source!.split(/(\{\w+\})/).map(part => {
      if (/^\{\w+\}$/.test(part)) { names.push(part.slice(1, -1)); return '(.+?)'; }
      return [...part].map(character => '\\^$.*+?()[]{}|'.includes(character) ? '\\' + character : character).join('');
    }).join('');
    return { regex: new RegExp(`^${expression}$`), names, target: target!, language, specificity: source!.replace(/\{\w+\}/g, '').length };
  });
}).sort((a, b) => b.specificity - a.specificity);
/** Exact catalog lookup or explicit parameter template; unknown/user values remain untouched. */
export function translateText(source: string, language: AppLanguage): string {
  const decorated = source.match(/^([✓▶︎●]\s+)(.+)$/);
  if (decorated) return decorated[1] + translateText(decorated[2]!, language);
  for (const acknowledgment of ["I'm sorry to hear that.", 'I hear you.', 'Lamento que te sientas así.', 'Te escucho.']) {
    if (source.startsWith(acknowledgment + ' ')) return translateText(acknowledgment, language) + ' ' + translateText(source.slice(acknowledgment.length + 1), language);
    if (source.endsWith(' ' + acknowledgment)) return translateText(source.slice(0, -acknowledgment.length - 1), language) + ' ' + translateText(acknowledgment, language);
  }
  const key = normalize(source);
  const exact = language === 'es' ? spanish[key] : reverse.get(key);
  let value = exact;
  if (value === undefined) {
    for (const pattern of patterns) {
      if (pattern.language !== language) continue;
      const match = key.match(pattern.regex);
      if (!match) continue;
      value = pattern.target.replace(/\{(\w+)\}/g, (_token, name: string) => {
        const parameter = match[pattern.names.indexOf(name) + 1] ?? '';
        return ['title', 'status', 'details', 'label', 'operation'].includes(name) ? parameter.split(' · ').map(part => translateText(part, language)).join(' · ') : parameter;
      });
      break;
    }
  }
  if (value === undefined) return source;
  return `${source.match(/^\s*/)?.[0] ?? ''}${value}${source.match(/\s*$/)?.[0] ?? ''}`;
}
