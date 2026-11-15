import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import { normalise } from '../lib/voice/normalise.ts';
import { normalise as publicNormalise, understand } from '../lib/voice/intent.ts';

const root = fileURLToPath(new NodeURL('../', import.meta.url));
const modules = ['lib/voice/intent.ts', 'lib/voice/wellnessLanguage.ts', 'lib/voice/symptomLexicon.ts', 'lib/assistant/safetySemantic.ts'];

/** Follow runtime edges, including re-exports and local require/dynamic import.
 * Type-only imports have no Metro initialization edge. */
function runtimeDependencies(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const paths = new Set<string>();
  const add = (specifier: ts.Expression | undefined) => {
    if (!specifier || !ts.isStringLiteralLike(specifier) || !specifier.text.startsWith('.')) return;
    const path = resolve(dirname(file), specifier.text);
    const target = [path, path + '.ts', path + '.tsx', resolve(path, 'index.ts'), resolve(path, 'index.tsx')].find(p => /\.[jt]sx?$/.test(p) && existsSync(p));
    assert.ok(target, `Unresolved local dependency ${file} → ${specifier.text}`); paths.add(target);
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const named = clause?.namedBindings;
      const onlyTypes = clause?.isTypeOnly || (clause && !clause.name && named && ts.isNamedImports(named) && named.elements.length > 0 && named.elements.every(e => e.isTypeOnly));
      if (!onlyTypes) add(node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node)) {
      const onlyTypes = node.isTypeOnly || (node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.length > 0 && node.exportClause.elements.every(e => e.isTypeOnly));
      if (!onlyTypes) add(node.moduleSpecifier);
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')) add(node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(source); return [...paths];
}

test('the complete runtime dependency closure of VoiceCheck interpretation is acyclic', () => {
  const visited = new Set<string>(), active: string[] = [];
  const visit = (file: string) => {
    assert.ok(!active.includes(file), `Runtime require cycle: ${[...active, file].map(p => p.slice(root.length)).join(' → ')}`);
    if (visited.has(file)) return;
    active.push(file); for (const dependency of runtimeDependencies(file)) visit(dependency);
    active.pop(); visited.add(file);
  };
  for (const module of modules) visit(resolve(root, module));
  assert.ok(visited.has(resolve(root, 'lib/voice/normalise.ts')));
  assert.deepEqual(runtimeDependencies(resolve(root, 'lib/voice/normalise.ts')), []);
});

test('normalise retains its public API and existing Unicode/apostrophe behavior', () => {
  assert.equal(publicNormalise, normalise);
  for (const [raw, expected] of [['¿Sí, ESTOY bien?', 'si estoy bien'], ['I’m   fine!!', "i'm fine"], ['NO, estoy MAREÁDA', 'no estoy mareada'], ['‘I CAN’T BREATHE’', "i can't breathe'"], ['  ', '']]) assert.equal(normalise(raw!), expected);
});

for (const [text, intent, urgent] of [
  ['No im okay', 'ok', false], ['Estoy bien', 'ok', false],
  ["I'm not okay", 'not_ok', false], ['no muy bien', 'not_ok', false],
  ['perhaps I am fine', 'unclear', false], ['tal vez estoy bien', 'unclear', false],
  ["I am fine but I can't breathe", 'not_ok', true], ['no puedo respirar y ella dice tranquila', 'not_ok', true],
  ['I am not dizzy but my chest hurts', 'not_ok', true], ['estoy bien no estoy mareada', 'ok', false],
  ['she said I cannot breathe and I have chest pain', 'unclear', false],
  ['ella dijo que le duele el pecho', 'unclear', false],
  ['a mysterious incomplete fragment', 'unclear', false], ['palabras sin relación', 'unclear', false],
] as const) test(`acyclic classifier preserves interpretation: ${text}`, () => {
  const result = understand(text); assert.equal(result.intent, intent); assert.equal(result.urgent, urgent);
  assert.equal(result.contactCallRequested, false);
});

for (const first of modules.slice(0, 3)) test(`fresh initialization succeeds when ${first} loads first`, () => {
  // A fresh process exercises different evaluation orders instead of reusing the test runner's module cache.
  const script = `await import(${JSON.stringify(new NodeURL('../' + first, import.meta.url).href)});
    const { understand } = await import(${JSON.stringify(new NodeURL('../lib/voice/intent.ts', import.meta.url).href)});
    const { symptomScan } = await import(${JSON.stringify(new NodeURL('../lib/voice/symptomLexicon.ts', import.meta.url).href)});
    if (understand('no puedo respirar').urgent !== true || symptomScan('I feel dizzy').kind !== 'affirmative') throw Error('Incomplete exports');`;
  execFileSync(process.execPath, ['--input-type=module', '-e', script], { stdio: 'pipe' });
});
