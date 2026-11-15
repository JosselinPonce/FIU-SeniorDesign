/** Shared transcript normalization; independent of classifiers and symptom rules. */
// Accents removed so "sí"/"si" and "está"/"esta" match (as Python's NFD + Mn strip).
const ACCENTS: Record<string, string> = {
  á: 'a', à: 'a', â: 'a', ä: 'a', ã: 'a', é: 'e', è: 'e', ê: 'e', ë: 'e', í: 'i', ì: 'i', î: 'i', ï: 'i',
  ó: 'o', ò: 'o', ô: 'o', ö: 'o', õ: 'o', ú: 'u', ù: 'u', û: 'u', ü: 'u', ñ: 'n', ç: 'c',
};

export function normalise(text: string): string {
  let out = '';
  for (const ch0 of text.toLowerCase().replace(/’/g, "'")) {
    const ch = ACCENTS[ch0] ?? ch0;
    const isAlnum = /[a-z0-9]/.test(ch) || (ch.length === 1 && ch.charCodeAt(0) > 127 && ch.toLowerCase() !== ch.toUpperCase());
    out += isAlnum || ch === "'" ? ch : ' ';
  }
  return out.split(' ').filter(Boolean).join(' ');
}
