import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { createRequire } from 'node:module';
import ts from 'typescript';
const { resolve } = createRequire(import.meta.url)('metro-resolver');
const dir = fileURLToPath(new NodeURL('../components/', import.meta.url));
function literalErrors(source: string) {
  const tree = ts.createSourceFile('ui.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const errors: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
      const tag = ts.isJsxElement(node) ? node.openingElement.tagName.getText(tree) : 'fragment';
      if (!['Text', 'SectionTitle', 'Pill'].includes(tag)) for (const child of node.children) {
        let text = '';
        if (ts.isJsxText(child)) {
          const lines = child.text.split(/\r\n|\n|\r/);
          text = lines.map((line, index) => {
            let value = line.replace(/\t/g, ' ');
            if (index > 0) value = value.replace(/^ +/, '');
            if (index < lines.length - 1) value = value.replace(/ +$/, '');
            return value;
          }).join('');
        }
        const expression = ts.isJsxExpression(child) ? child.expression : undefined;
        if (text || (expression && (ts.isStringLiteral(expression) || ts.isNumericLiteral(expression))))
          errors.push(`${tag}:${tree.getLineAndCharacterOfPosition(child.pos).line + 1}`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree); return errors;
}
test('JSX text check catches same-line fragment spaces without flagging indentation or Text', () => {
  assert.equal(literalErrors('<View><> <Text>Details</Text> </></View>').length, 2);
  assert.equal(literalErrors('<View>{" "}</View>').length, 1);
  assert.deepEqual(literalErrors('<View>\n  <Text>Hello world</Text>\n</View>'), []);
});
test('recent dashboard components contain no literal children outside text primitives', () => {
  for (const filename of ['DriveView.tsx', 'SmartWheelScreen.tsx', 'VitalsDetailView.tsx', 'DashboardAssistantEntry.tsx', 'CompactVitalCard.tsx', 'BrandMark.tsx', 'SensiSafetyConversation.tsx'])
    assert.deepEqual(literalErrors(readFileSync(dir + filename, 'utf8')), [], filename);
});
test('detailed vitals import casing matches a present component and Metro resolves it on iOS', () => {
  assert.ok(readdirSync(dir).includes('VitalsDetailView.tsx'));
  assert.match(readFileSync(dir + 'SmartWheelScreen.tsx', 'utf8'), /import \{ VitalsDetailView \} from '\.\/VitalsDetailView'/);
  const result = resolve({
    originModulePath: dir + 'SmartWheelScreen.tsx', sourceExts: ['js', 'jsx', 'json', 'ts', 'tsx'],
    assetExts: new Set(), preferNativePlatform: true, redirectModulePath: (path: string) => path,
    getPackageForModule: () => null,
    fileSystemLookup(path: string) {
      try { return { exists: true, type: statSync(path).isDirectory() ? 'd' : 'f', realPath: realpathSync(path) }; }
      catch { return { exists: false }; }
    },
  }, './VitalsDetailView', 'ios');
  assert.equal(result.type, 'sourceFile');
  assert.equal(result.filePath, realpathSync(dir + 'VitalsDetailView.tsx'));
  assert.match(readFileSync(result.filePath, 'utf8'), /export function VitalsDetailView/);
});
