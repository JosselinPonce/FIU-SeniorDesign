export type AskBlock =
  | { kind: 'paragraph' | 'heading'; text: string }
  | { kind: 'item'; text: string; depth: number; marker: string }
  | { kind: 'table'; rows: string[][] };

const cells = (line: string) => line.replace(/^\s*\||\|\s*$/g, '').split('|').map(cell => cell.trim());

export function parseAskMarkdown(message: string): AskBlock[] {
  const lines = message.trim().split(/\r\n?|\n/);
  const blocks: AskBlock[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: 'paragraph', text: paragraph.join(' ') });
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) { flush(); continue; }
    const heading = /^\s{0,3}#{1,6}\s+(.+)$/.exec(line);
    const item = /^(\s*)([-+*]|\d{1,3}[.)])\s+(.+)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: 'heading', text: heading[1] });
    } else if (item) {
      flush();
      blocks.push({ kind: 'item', depth: Math.min(3, Math.floor(item[1].length / 2)),
        marker: /^\d/.test(item[2]) ? item[2] : '•', text: item[3] });
    } else if (line.includes('|') && lines[i + 1]?.includes('|')) {
      const header = cells(line), divider = cells(lines[i + 1]);
      if (header.length >= 2 && header.length <= 6 && divider.length === header.length
        && divider.every(cell => /^:?-{3,}:?$/.test(cell))) {
        flush();
        const rows = [header];
        i++;
        while (lines[i + 1]?.includes('|')) {
          const row = cells(lines[i + 1]);
          if (row.length !== header.length) break;
          rows.push(row);
          i++;
        }
        blocks.push({ kind: 'table', rows });
      } else paragraph.push(line.trim());
    } else paragraph.push(line.trim());
  }
  flush();
  return blocks;
}

export function askInlineParts(text: string): { text: string; bold: boolean }[] {
  return text.split(/(\*\*[^*\n]+\*\*|__[^_\n]+__)/).filter(Boolean).map(value => {
    const bold = /^(?:\*\*[^*\n]+\*\*|__[^_\n]+__)$/.test(value);
    return { bold, text: bold ? value.slice(2, -2) : value };
  });
}
