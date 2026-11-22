/** Event-owned presentation memory only. Stores opening tags and small hashes,
 * never transcripts or durable history. Validation must precede selection. */
export type AcknowledgmentPhrasing = ReturnType<typeof createAcknowledgmentPhrasing>;
function opening(text: string): string {
  return text.match(/^(?:I'm sorry|I hear|Thank you|Feeling|It sounds|Lamento|Siento|Gracias|Suena)/)?.[0] ?? 'other';
}
function hash(text: string): number {
  let value = 2166136261;
  for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619);
  return value >>> 0;
}
export function createAcknowledgmentPhrasing(seed = 0) {
  const used: { opening: string; hash: number }[] = [];
  function example(candidates: string[]) {
    const groups = [...new Set(candidates.map(opening))];
    const preferred = groups[Math.abs(Math.trunc(seed)) % Math.max(1, groups.length)];
    return candidates.find(text => opening(text) === preferred) ?? candidates[0] ?? '';
  }
  return {
    example,
    select(validated: string, candidates: string[]) {
      if (!candidates.includes(validated)) return ''; // Never repair unsafe prose.
      const duplicate = used.some(item => item.hash === hash(validated) || item.opening === opening(validated));
      const selected = duplicate ? candidates.find(text => !used.some(item => item.opening === opening(text)))
        ?? candidates.find(text => !used.some(item => item.hash === hash(text))) ?? validated : validated;
      used.push({ opening: opening(selected), hash: hash(selected) });
      if (used.length > 8) used.shift();
      return selected;
    },
    clear() { used.length = 0; },
  };
}
