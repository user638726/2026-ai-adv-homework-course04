const fs = require('fs');
const path = require('path');

// A skipped, focused or todo test silently removes coverage. The free-shipping boundary
// test was once left disabled, which hid a pricing bug while every run stayed green.
const DISABLED_TEST_PATTERN = new RegExp([
  String.raw`\b(?:it|test|describe|suite)\.(?:skip|only|todo)\b`,
  String.raw`\b(?:xit|xtest|xdescribe|fit|fdescribe)\s*\(`
].join('|'));

function listScriptFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listScriptFiles(fullPath);
    return /\.(?:js|mjs|cjs)$/.test(entry.name) ? [fullPath] : [];
  });
}

describe('test suite hygiene', () => {
  it('contains no skipped, focused or todo tests', () => {
    const offenders = [];

    for (const file of listScriptFiles(__dirname)) {
      if (file === __filename) continue;

      fs.readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
        if (DISABLED_TEST_PATTERN.test(line)) {
          offenders.push(`${path.relative(__dirname, file)}:${index + 1}  ${line.trim()}`);
        }
      });
    }

    expect(offenders).toEqual([]);
  });
});
