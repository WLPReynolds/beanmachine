// Every place the version appears must agree, or the service worker and the About screen drift apart.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('version matches in package.json, src/app.js, sw.js and index.html', () => {
  const pkg = JSON.parse(read('package.json')).version;
  assert.match(pkg, /^\d+\.\d+\.\d+$/);
  assert.equal(/const APP_VERSION='([^']+)';/.exec(read('src/app.js'))?.[1], pkg, 'src/app.js APP_VERSION');
  assert.equal(/const CACHE = 'oddly-v([^']+)';/.exec(read('sw.js'))?.[1], pkg, 'sw.js CACHE');
  assert.equal(/src="src\/app\.js\?v=([^"]+)"/.exec(read('index.html'))?.[1], pkg, 'index.html script tag');
});

test('service worker precaches the app script', () => {
  assert.match(read('sw.js'), /'src\/app\.js'/);
});

test('every file the service worker precaches exists', () => {
  const list = /const SHELL = \[([^\]]+)\]/.exec(read('sw.js'))[1].match(/'([^']+)'/g).map(s => s.slice(1, -1));
  for (const f of list) if (f !== './') assert.ok(fs.existsSync(path.join(__dirname, '..', f)), `missing ${f}`);
});

test('manifest icons and page icon links point at real files', () => {
  for (const i of JSON.parse(read('manifest.json')).icons) assert.ok(fs.existsSync(path.join(__dirname, '..', i.src)), `missing ${i.src}`);
  for (const [, f] of read('index.html').matchAll(/<link rel="(?:icon|apple-touch-icon|manifest)" href="([^"]+)"/g))
    assert.ok(fs.existsSync(path.join(__dirname, '..', f)), `missing ${f}`);
});

test('manifest is Oddly with its own install id, and CNAME is the Oddly domain', () => {
  const m = JSON.parse(read('manifest.json'));
  assert.equal(m.name, 'Oddly');
  assert.equal(m.short_name, 'Oddly');
  assert.equal(m.id, './index.html?app=oddly');
  assert.equal(m.start_url, './index.html');
  assert.equal(m.scope, './');
  assert.equal(read('CNAME').trim(), 'oddly.slightlygood.app');
});
