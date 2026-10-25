#!/usr/bin/env node
// Bumps the app version everywhere it appears, so they never drift apart.
//   npm run bump            → patch (1.0.0 → 1.0.1)
//   npm run bump -- minor   → 1.0.1 → 1.1.0
//   npm run bump -- major   → 1.1.0 → 2.0.0
//   npm run bump -- 1.4.2   → set an exact version
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const file = f => path.join(root, f);

const pkg = JSON.parse(fs.readFileSync(file('package.json'), 'utf8'));
const cur = pkg.version;
const arg = process.argv[2] || 'patch';
let next;
if (/^\d+\.\d+\.\d+$/.test(arg)) next = arg;
else {
  const [ma, mi, pa] = cur.split('.').map(Number);
  next = { major: `${ma + 1}.0.0`, minor: `${ma}.${mi + 1}.0`, patch: `${ma}.${mi}.${pa + 1}` }[arg];
  if (!next) { console.error(`Unknown bump "${arg}" (use patch, minor, major or x.y.z)`); process.exit(1); }
}

const edits = [
  ['package.json', /"version":\s*"[^"]+"/, `"version": "${next}"`],
  ['src/app.js', /const APP_VERSION='[^']+';/, `const APP_VERSION='${next}';`],
  ['sw.js', /const CACHE = 'oddly-v[^']+';/, `const CACHE = 'oddly-v${next}';`],
  ['index.html', /src="src\/app\.js\?v=[^"]+"/, `src="src/app.js?v=${next}"`],
];
for (const [f, re, rep] of edits) {
  const s = fs.readFileSync(file(f), 'utf8');
  if (!re.test(s)) { console.error(`Version not found in ${f}`); process.exit(1); }
  fs.writeFileSync(file(f), s.replace(re, rep));
}
console.log(`${cur} → ${next}`);
