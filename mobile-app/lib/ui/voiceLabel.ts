/** Formatting only; native voice identifiers and selection remain untouched. */
export function voiceDisplayLabel(name: string, tier: string): string {
  const base = name.replace(/\s*\((?:Premium|Enhanced|Standard)\)\s*$/i, '').trim();
  return `${base} (${tier})`;
}
