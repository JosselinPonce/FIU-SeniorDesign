import assert from 'node:assert/strict';
import { test } from 'node:test';
import { URL as NodeURL } from 'node:url';
import { askInlineParts, parseAskMarkdown } from '../lib/assistant/askSensiMarkdown.ts';
import { appendAskTurn, newAskConversation } from '../lib/assistant/askSensiConversation.ts';
import { parseAskProviderResponse } from '../supabase/functions/ask-sensi/provider.ts';

test('assistant markup separates paragraphs, headings, and consecutive or nested list items', () => {
  assert.deepEqual(parseAskMarkdown('## Review\n\nThis is **recorded**.\n\nMore detail.\n- Heart rate\n  - Average\n2. Review History'), [
    { kind: 'heading', text: 'Review' },
    { kind: 'paragraph', text: 'This is **recorded**.' },
    { kind: 'paragraph', text: 'More detail.' },
    { kind: 'item', depth: 0, marker: '•', text: 'Heart rate' },
    { kind: 'item', depth: 1, marker: '•', text: 'Average' },
    { kind: 'item', depth: 0, marker: '2.', text: 'Review History' },
  ]);
  assert.deepEqual(askInlineParts('A **reading**.'), [
    { text: 'A ', bold: false }, { text: 'reading', bold: true }, { text: '.', bold: false },
  ]);
});

test('tables retain long cells and malformed or unsafe syntax remains inert text', () => {
  const long = 'A long description of recorded data '.repeat(6).trim();
  assert.deepEqual(parseAskMarkdown('| Metric | Recorded |\n| --- | :---: |\n| Heart rate | ' + long + ' |'), [
    { kind: 'table', rows: [['Metric', 'Recorded'], ['Heart rate', long]] },
  ]);
  assert.deepEqual(parseAskMarkdown(''), []);
  const malformed = '| Missing separator | **unfinished\n<a onclick="run()">literal</a>';
  assert.deepEqual(parseAskMarkdown(malformed), [
    { kind: 'paragraph', text: '| Missing separator | **unfinished <a onclick="run()">literal</a>' },
  ]);
  assert.deepEqual(askInlineParts('[Link](https://example.com) **broken'), [
    { text: '[Link](https://example.com) **broken', bold: false },
  ]);
});

test('Ask Sensi accepts multiline Markdown and rejects unsafe markup', () => {
  const provider = (message: string) => ({ status: 'completed', output: [
    { type: 'message', role: 'assistant', status: 'completed', content: [
      { type: 'output_text', text: JSON.stringify({ message }) },
    ] },
  ] });
  const markdown = '# Summary\n\n- A recorded reading\n- A second reading';
  assert.equal(parseAskProviderResponse(provider(markdown)).message, markdown);
  for (const unsafe of ['Hi\u0000there', 'Offer to call someone', 'Open https://example.com', '']) {
    assert.throws(() => parseAskProviderResponse(provider(unsafe)));
  }
});

test('a conversation title and immutable drive are retained when a submitted turn gets an answer', () => {
  const chat = newAskConversation('chat', 'drive-a', 'Explain   my drive', 'start');
  const submitted = appendAskTurn(chat, { id: 'turn', question: 'Explain my drive', answer: null }, 'sent');
  const answered = appendAskTurn(submitted, { id: 'turn', question: 'Explain my drive', answer: 'An answer' }, 'answered');
  assert.deepEqual(answered, { id: 'chat', driveId: 'drive-a', title: 'Explain my drive', createdAt: 'start',
    updatedAt: 'answered', turns: [{ id: 'turn', question: 'Explain my drive', answer: 'An answer' }] });
  assert.equal(newAskConversation('new', null, 'x'.repeat(60), 'now').title.length, 48);
});

test('native table view uses theme colors, wrapping cells, and horizontal scrolling', async () => {
  const [{ readFileSync }, { createRequire }, { default: ts }, { light, dark }] = await Promise.all([
    import('node:fs'), import('node:module'), import('typescript'), import('../lib/theme/tokens.ts'),
  ]);
  const require = createRequire(import.meta.url);
  let tokens = light;
  const mocks: Record<string, unknown> = {
    'react/jsx-runtime': require('react/jsx-runtime'),
    'react-native': { ScrollView: 'ScrollView', View: 'View' },
    '../lib/i18n/native': { LocalizedText: 'Text' },
    '../lib/theme/ThemeProvider': { useTheme: () => ({ tokens }) },
    '../lib/assistant/askSensiMarkdown': { askInlineParts, parseAskMarkdown },
  };
  const source = readFileSync(new NodeURL('../components/AskSensiResponse.tsx', import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  });
  const exports: any = {};
  new Function('require', 'exports', outputText)((name: string) => mocks[name], exports);
  for (const palette of [light, dark]) {
    tokens = palette;
    const content = exports.AskSensiResponse({ message: '| One | Two | Three |\n| --- | --- | --- |\n| Heart rate | Long content | Recorded |' });
    const table = content.props.children[0];
    assert.equal(table.type, 'ScrollView');
    assert.equal(table.props.horizontal, true);
    const firstRow = table.props.children.props.children[0];
    assert.equal(firstRow.props.style.backgroundColor, palette.surfaceMuted);
    const columns = firstRow.props.children;
    assert.equal(columns.length, 3);
    assert.equal(columns[0].props.style.color, palette.text);
    assert.equal(columns[0].props.numberOfLines, undefined);
  }
});
