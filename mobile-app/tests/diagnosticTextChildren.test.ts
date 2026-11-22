import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import ts from 'typescript';

test('DiagnosticDetails callers never pass React Native raw text children', () => {
  const files = [
    ...readdirSync(new NodeURL('../components/', import.meta.url))
      .filter(name => name.endsWith('.tsx')).map(name => `components/${name}`),
    'modules/gemma-poc/GemmaDiagnostic.tsx',
  ];
  for (const file of files) {
    const source = ts.createSourceFile(file, readFileSync(new NodeURL(`../${file}`, import.meta.url), 'utf8'),
      ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    function visit(node: ts.Node) {
      if (ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === 'DiagnosticDetails') {
        for (const child of node.children) {
          if (ts.isJsxText(child)) {
            // JSX drops newline indentation but retains spaces between tags on one line.
            const text = child.getFullText(source);
            assert.ok(text.trim() === '' && /[\r\n]/.test(text), `${file} passes raw JSX text to DiagnosticDetails`);
          }
          if (ts.isJsxExpression(child) && child.expression) {
            assert.equal(ts.isStringLiteralLike(child.expression), false, `${file} passes a bare string to DiagnosticDetails`);
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
});
