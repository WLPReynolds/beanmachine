const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers');

const app = loadApp();
const fn = name => app.get(name);
const L = () => app.get('GAMES.lotto');
const EM = () => app.get('GAMES.euromillions');

test('app boots in demo mode and renders every screen without errors', () => {
  const w = app.window;
  assert.equal(app.errors.length, 0, app.errors.map(e => e.message).join('\n'));
  for (const view of ['latest', 'check', 'gen', 'stats', 'settings']) {
    app.get(`state.view='${view}'; render();`);
    assert.ok(w.document.querySelector('#view').innerHTML.length > 0, `view ${view} rendered`);
  }
  assert.equal(app.errors.length, 0, app.errors.map(e => e.message).join('\n'));
  assert.match(w.document.querySelector('#view').innerHTML, new RegExp('Bean Machine v' + app.get('APP_VERSION').replace(/\./g, '\\.')));
});

/* ---------- Crowd score constants match the combinatorics in the brief ---------- */
test('crowd chance ratios come from the combinations', () => {
  const comb = fn('comb'), C = app.get('CROWD');
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} vs ${b}`);
  // Lotto: P(match k of 6 from 59) ∝ C(6,k)·C(53,6−k)
  near(C.lotto.m3, comb(6, 3) * comb(53, 3) / (comb(6, 2) * comb(53, 4)));
  near(C.lotto.m4, comb(6, 4) * comb(53, 2) / (comb(6, 2) * comb(53, 4)));
  // EuroMillions mains: 5 from 50; no-star tiers share the same star factor, so it cancels
  near(C.euromillions.m3, comb(5, 3) * comb(45, 2) / (comb(5, 2) * comb(45, 3)));
  // Stars: 2 from 12, P(2★)/P(0★) = 1/C(10,2)
  near(C.euromillions.st, comb(2, 2) / comb(10, 2));
});

test('tierMap reads Lotto and EuroMillions tier names', () => {
  const m = fn('tierMap')([
    { t: 'Match 6', w: 0, p: 0 }, { t: 'Match 5 plus Bonus', w: 2, p: 1e6 },
    { t: 'Match 3', w: 1000, p: 30 }, { t: 'Match 2', w: 9000, p: 0 },
    { t: 'Match 2 plus 2 Bonus Balls', w: 50, p: 10 },
  ]);
  assert.deepEqual({ ...m }, { '5+1': 2, '3+0': 1000, '2+0': 9000, '2+2': 50 }); // zero-winner tiers skipped
});

test('ratioScore: score, noise and significance', () => {
  const rs = fn('ratioScore');
  const exact = rs(1066.6666666666667, 10000, 0.10666666666666666);
  assert.ok(Math.abs(exact.pct) < 1e-12);
  assert.equal(exact.sig, false);
  const hi = rs(1200, 10000, 0.10666666666666666);
  assert.ok(Math.abs(hi.pct - 0.125) < 1e-9);
  assert.ok(Math.abs(hi.noise - 2 * Math.sqrt(1 / 1200 + 1 / 10000)) < 1e-12);
  assert.equal(hi.sig, true);
  assert.equal(rs(0, 100, 0.1), null);
});

test('crowd() needs a breakdown and scores the main numbers', () => {
  const crowd = fn('crowd');
  assert.equal(crowd(L(), { prizes: null }), null);
  const c = crowd(L(), { prizes: [{ t: 'Match 3', w: 1100, p: 30 }, { t: 'Match 2', w: 10000, p: 0 }, { t: 'Match 4', w: 50, p: 140 }] });
  assert.ok(Math.abs(c.main.pct - (0.11 / 0.10666666666666666 - 1)) < 1e-9);
  assert.ok(c.m4);
  assert.equal(c.stars, null);
});

/* ---------- Popularity heuristic ---------- */
test('popularity: birthday-range run scores high, a spread line scores low', () => {
  const pop = fn('popularity');
  const hi = pop(L(), [1, 2, 3, 4, 5, 6], []);
  assert.equal(hi.band, 'high');
  const lo = pop(L(), [7, 19, 33, 41, 48, 56], []);
  assert.equal(lo.band, 'low');
  assert.ok(lo.score < hi.score);
});

/* ---------- Random picks ---------- */
test('pickDistinct returns sorted, distinct numbers in range and respects exclusions', () => {
  const pick = fn('pickDistinct'), rng = fn('mulberry32')(42);
  for (let i = 0; i < 200; i++) {
    const excl = new Set([1, 2, 3, 59]);
    const a = pick(rng, 6, 59, excl);
    assert.equal(a.length, 6);
    assert.equal(new Set(a).size, 6);
    assert.deepEqual([...a], [...a].sort((x, y) => x - y));
    assert.ok(a.every(n => n >= 1 && n <= 59 && !excl.has(n)));
  }
});

/* ---------- Wayne's rule ---------- */
const lottoDraws = () => [
  { date: '2026-10-24', round: 'Round 2', main: [4, 9, 15, 32, 38, 42], extra: [7] },
  { date: '2026-10-24', round: 'Round 1', main: [1, 11, 21, 31, 41, 51], extra: [2] },
  { date: '2026-10-21', round: 'Round 1', main: [5, 6, 8, 10, 12, 13], extra: [14] },
];

test('lastDrawn covers both Lotto rounds, with the bonus following the setting', () => {
  const ds = lottoDraws();
  app.get('settings.bonusCounts=true');
  let { m } = fn('lastDrawn')(L(), ds);
  assert.ok([4, 42, 1, 51, 7, 2].every(n => m.has(n)));
  assert.ok(!m.has(5)); // older draw not included
  app.get('settings.bonusCounts=false');
  ({ m } = fn('lastDrawn')(L(), ds));
  assert.ok(!m.has(7) && !m.has(2));
  app.get('settings.bonusCounts=true');
});

test('leastPool keeps ties with the 5th-lowest count and drops exclusions', () => {
  const g = { mainMax: 8, extraMax: 0 };
  const ds = [{ main: [1, 2, 3], extra: [] }, { main: [1, 2], extra: [] }, { main: [1], extra: [] }];
  // counts: 1→3, 2→2, 3→1, 4..8→0. Five lowest: 4,5,6,7,8 (all 0) — 3 is not tied
  assert.deepEqual([...fn('leastPool')(g, ds, false, new Set())].sort((a, b) => a - b), [4, 5, 6, 7, 8]);
  // Excluding 4 and 5: 5th-lowest is 2 (count 2), so 3 (count 1) and 2 come in
  assert.deepEqual([...fn('leastPool')(g, ds, false, new Set([4, 5]))].sort((a, b) => a - b), [2, 3, 6, 7, 8]);
});

test("suggestFor swaps only last-draw numbers, never back into last-draw numbers", () => {
  const ds = lottoDraws(), suggest = fn('suggestFor');
  const last = new Set([4, 9, 15, 32, 38, 42, 7, 1, 11, 21, 31, 41, 51, 2]);
  for (let i = 0; i < 100; i++) {
    const line = { main: [4, 9, 20, 30, 40, 50], extra: [] };
    const s = suggest(L(), ds, line);
    assert.deepEqual([...s.hitM], [4, 9]);
    assert.equal(s.main.length, 6);
    assert.equal(new Set(s.main).size, 6);
    assert.ok([20, 30, 40, 50].every(n => s.main.includes(n)), 'kept numbers stay');
    assert.ok(s.main.every(n => !last.has(n)), 'no last-draw numbers');
  }
  assert.equal(suggest(L(), ds, { main: [3, 20, 30, 40, 50, 59], extra: [] }).none, true);
});

test('suggestFor treats EuroMillions stars separately', () => {
  const ds = [{ date: '2026-10-23', round: null, main: [1, 2, 3, 4, 5], extra: [1, 2] }];
  const s = fn('suggestFor')(EM(), ds, { main: [1, 10, 20, 30, 40], extra: [2, 9] });
  assert.deepEqual([...s.hitM], [1]);
  assert.deepEqual([...s.hitX], [2]);
  assert.ok(!s.main.some(n => n <= 5));
  assert.ok(s.extra.includes(9) && !s.extra.some(n => n === 1 || n === 2));
});

/* ---------- Back up / Restore across the rename ---------- */
const backupFile = app => ({ text: async () => JSON.stringify({
  app, version: 1, exported: '2026-10-25T14:00:00Z',
  draws: { lotto: [{ date: '2026-10-24', round: 'Round 1', main: [1, 11, 21, 31, 41, 51], extra: [2], jackpot: null, prizes: null }], euromillions: [] },
  lines: { lotto: [{ main: [3, 14, 25, 36, 47, 58], extra: [] }], euromillions: [] },
  tickets: { lotto: [{ id: 't-' + app, lines: [{ main: [3, 14, 25, 36, 47, 58], extra: [] }], dates: ['2026-10-28'], at: '2026-10-25T13:00:00Z' }], euromillions: [] },
  seen: [], settings: { workerUrl: 'https://proxy.example.workers.dev', worthIt: 100000000 },
}) });

for (const id of ['lotto-lab', 'oddly', 'beanmachine']) {
  test(`Restore accepts a "${id}" backup, including locked entries`, async () => {
    const a = loadApp();
    await a.window.importBackup(backupFile(id));
    const t = a.get('tickets.lotto');
    assert.equal(t.length, 1);
    assert.deepEqual([...t[0].dates], ['2026-10-28']);
    assert.deepEqual([...a.get('myLines.lotto')[0].main], [3, 14, 25, 36, 47, 58]);
    assert.equal(a.get('settings.workerUrl'), 'https://proxy.example.workers.dev');
    assert.equal(a.get('state.live.lotto').length, 1);
    // Restoring the same file again adds nothing twice
    await a.window.importBackup(backupFile(id));
    assert.equal(a.get('tickets.lotto').length, 1);
    assert.equal(a.get('myLines.lotto').length, 1);
  });
}

test('Restore rejects files from other apps', async () => {
  const a = loadApp();
  await a.window.importBackup(backupFile('something-else'));
  assert.equal(a.get('tickets.lotto').length, 0);
  assert.match(a.window.document.querySelector('#toast').textContent, /isn't a Bean Machine backup/);
});

test('Back up writes a beanmachine backup with the dated file name', () => {
  const a = loadApp();
  let blob, name;
  a.window.URL.createObjectURL = b => { blob = b; return 'blob:x'; };
  a.window.URL.revokeObjectURL = () => {};
  a.window.HTMLAnchorElement.prototype.click = function () { name = this.download; };
  a.window.exportBackup();
  assert.match(name, /^beanmachine-backup-\d{4}-\d{2}-\d{2}\.json$/);
  assert.ok(blob);
});

test('user-facing name is Bean Machine, with the not-affiliated line', () => {
  const a = loadApp();
  const d = a.window.document;
  assert.equal(d.title, 'Bean Machine');
  a.get('render()');
  assert.match(d.querySelector('#hdr').textContent, /Bean Machine/);
  a.get("state.view='settings'; render();");
  const v = d.querySelector('#view').textContent;
  assert.match(v, /Not affiliated with the National Lottery or its operator/);
  assert.doesNotMatch(d.body.textContent, /Lotto Lab/);
});

/* ---------- Story page and bean machine ---------- */
test('Story page renders the bean machine with every peg and bin', () => {
  const a = loadApp();
  a.get("state.view='story'; render();");
  const d = a.window.document;
  const svg = d.querySelector('#beanm');
  assert.ok(svg, 'bean machine drawn');
  const rows = a.get('BM.rows');
  assert.equal(svg.querySelectorAll('.bm-peg').length, rows * (rows + 1) / 2);
  assert.equal(svg.querySelectorAll('.bm-wall').length, rows + 3); // rows+2 dividers plus the floor
  assert.match(d.querySelector('#view').textContent, /Galton/);
  assert.match(d.querySelector('#view').textContent, /Not affiliated with the National Lottery/);
  assert.ok(d.querySelector('#hdr [data-view="story"].on'), 'header Story button is highlighted');
  assert.equal(a.errors.length, 0, a.errors.map(e => e.message).join('\n'));
});

test('Story is reachable from the header and from About', () => {
  const a = loadApp();
  a.get("state.view='settings'; render();");
  const d = a.window.document;
  assert.ok(d.querySelector('#hdr [data-view="story"]'));
  assert.ok(d.querySelector('#view [data-view="story"]'));
  d.querySelector('#view [data-view="story"]').click();
  assert.equal(a.get('state.view'), 'story');
  assert.ok(d.querySelector('#beanm'));
});

test('galtonBin lands in 0..rows and averages to the middle (binomial)', () => {
  const a = loadApp();
  const bin = a.get('galtonBin'), rng = a.get('mulberry32')(7), rows = 9, n = 20000;
  const counts = Array(rows + 1).fill(0);
  for (let i = 0; i < n; i++) { const k = bin(rows, rng); assert.ok(k >= 0 && k <= rows); counts[k]++; }
  const mean = counts.reduce((s, c, k) => s + c * k, 0) / n;
  assert.ok(Math.abs(mean - rows / 2) < 0.06, `mean ${mean}`);
  // middle bins beat the edges, as the bell curve says
  assert.ok(counts[4] > counts[1] * 5 && counts[5] > counts[8] * 5);
});

test('animation drops balls, lands them in bins and resets when a bin fills', () => {
  const a = loadApp();
  a.get("state.view='story'; render(); bm.run++;"); // stop the real loop; drive it by hand
  const tick = a.get('bmTick');
  const max = a.get('BM.max');
  let t = 1000, sawSettled = 0, resets = 0, wasFading = false, tallest = 0;
  for (let i = 0; i < 4000; i++) {
    assert.equal(tick(t), true); t += 16;
    const s = a.get('bm');
    sawSettled = Math.max(sawSettled, s.settled.length);
    if (s.fade && !wasFading) resets++;
    wasFading = !!s.fade;
    for (const b of s.settled) tallest = Math.max(tallest, b.h);
  }
  assert.ok(a.get('bm.n') > 100, 'many balls dropped');
  assert.ok(sawSettled > 20, `balls piled up (${sawSettled})`);
  assert.ok(resets >= 1, 'the pile reset at least once');
  // A reset starts when a bin reaches max; balls already falling can top it up a little, never far
  assert.ok(tallest < max + 9, `stacks stay bounded (${tallest})`);
  // leaving the page stops the loop
  a.get("state.view='latest'; render();");
  assert.equal(tick(t), false);
});

test('reduced motion draws a finished pile instead of animating', () => {
  const a = loadApp();
  a.window.matchMedia = q => ({ matches: /reduce/.test(q) });
  a.get("bm.settled=[]; state.view='story'; render();");
  const n = a.window.document.querySelectorAll('#bm-settled circle, #bm-settled path').length;
  assert.ok(n > 20, `static pile drawn (${n})`);
  assert.equal(a.get('bm.live.length'), 0);
});

/* ---------- Most/least drawn with ties, and the draw-day card ---------- */
test('rankTies keeps one line\'s worth and returns the numbers level at the cut-off', () => {
  const rankTies = fn('rankTies');
  const cnt = [0, 5, 4, 4, 4, 1, 0]; // numbers 1..6
  const nums = [1, 2, 3, 4, 5, 6];
  const hot = rankTies(nums, cnt, 2, 1);
  assert.deepEqual([...hot.shown], [1, 2]);
  assert.deepEqual([...hot.tied], [3, 4]); // level with 2 on 4 draws
  assert.equal(hot.cut, 4);
  const cold = rankTies(nums, cnt, 2, -1);
  assert.deepEqual([...cold.shown], [6, 5]);
  assert.deepEqual([...cold.tied], []);
});

test('dayChi is zero for identical days and grows when they differ', () => {
  const dayChi = fn('dayChi');
  const a = [0, 10, 10, 10, 10], b = [0, 10, 10, 10, 10];
  assert.equal(dayChi(a, b, 4, 1).x2, 0);
  const c = [0, 20, 0, 20, 0], d = [0, 0, 20, 0, 20];
  assert.ok(dayChi(c, d, 4, 1).p < 0.001);
  assert.equal(dayChi([0, 0, 0], [0, 1, 1], 2, 1), null); // a day with no draws
});

test('stats page shows the draw-day card, a line\'s worth of balls and a working tie expander', () => {
  const w = app.window, doc = w.document;
  for (const [game, days, size] of [['lotto', ['Saturday', 'Wednesday'], 6], ['euromillions', ['Tuesday', 'Friday'], 5]]) {
    app.get(`state.game='${game}'; state.view='stats'; state.statPool='main'; state.open.clear(); render();`);
    const html = doc.querySelector('#view').innerHTML;
    assert.match(html, /By draw day/);
    for (const d of days) assert.match(html, new RegExp(`<h3 class="dayh">${d}</h3>`));
    // First "Most drawn" block is Hot & cold: exactly one line's worth of balls
    const first = [...doc.querySelectorAll('#view .card h3')].find(h => /Most drawn/.test(h.textContent));
    assert.equal(first.nextElementSibling.querySelectorAll('.ball').length, size);
    if (game === 'euromillions') assert.match(html, /Lucky Stars/);
    const tie = doc.querySelector('#view .tie');
    if (tie) {
      tie.click();
      assert.ok(doc.querySelector('#view .tied'), 'tied balls shown after tapping');
      doc.querySelector('#view .tie').click();
      assert.equal(doc.querySelector('#view .tied'), null, 'and hidden again');
    }
  }
  assert.equal(app.errors.length, 0, app.errors.map(e => e.message).join('\n'));
});

/* ---------- Imported history ---------- */
test('drawMeta labels imported draws by source and leaves API draws alone', () => {
  const drawMeta = fn('drawMeta');
  assert.equal(drawMeta({ src: 'api' }), '');
  assert.equal(drawMeta({}), '');
  assert.match(drawMeta({ src: 'lottometrics' }), /Imported from lottometrics\.app/);
  assert.match(drawMeta({ src: 'national-lottery', machine: 'Lotto5', ballSet: 'L1', drawNo: 3219 }), /Machine Lotto5 · Ball set L1 · Draw 3219 · Imported from the official results download/);
});

test('missingRuns finds draw days with no draw, grouped into runs', () => {
  const missingRuns = fn('missingRuns');
  // Lotto: Wed/Sat. 3 Jan 2026 (Sat) and 7 Jan (Wed) missing between 31 Dec 2025 and 10 Jan 2026
  const ds = [{ date: '2026-01-10' }, { date: '2025-12-31' }];
  const m = missingRuns(L(), ds);
  assert.equal(m.n, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(m.runs)), [{ from: '2026-01-03', to: '2026-01-07', n: 2 }]);
  assert.equal(missingRuns(L(), [{ date: '2026-01-07' }, { date: '2026-01-03' }]).n, 0);
});

test('importNote reports sources, agreement and disagreement with the API', () => {
  const importNote = fn('importNote');
  assert.equal(importNote(null), '');
  const ok = importNote({ count: 1158, overlap: 4, mismatches: [], sources: { lottometrics: { kept: 1065, from: '2015-10-10', to: '2025-12-31' } } });
  assert.match(ok, /1,158 imported: lottometrics\.app 1065 \(2015–2025\)\. 4 overlap with the API and agree\./);
  const bad = importNote({ count: 10, overlap: 2, mismatches: [{ date: '2026-10-24', round: 'Round 1' }], sources: {} });
  assert.match(bad, /1 disagree with the API \(2026-10-24 R1\) — the API's numbers are used\./);
});

/* ---------- scripts/build-import.js ---------- */
test('build-import fixes lottometrics dates, keeps the current format, prefers official data and flags mismatches', () => {
  const fs = require('fs'), os = require('os'), path = require('path'), { execFileSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-import-'));
  const w = (f, s) => { fs.writeFileSync(path.join(dir, f), s); return path.join(dir, f); };
  const lm = w('lm.json', JSON.stringify([
    { draw_date: '2014-01-03', main_numbers: '1,2,3,4,5,6', extra_numbers: '7', draw_session: null }, // old 49-ball era: dropped
    { draw_date: '2025-12-30', main_numbers: '20,3,27,29,38,46', extra_numbers: '14', draw_session: null }, // really Wed 31 Dec
  ]));
  const em = w('em.json', JSON.stringify([
    { draw_date: '2025-12-29', main_numbers: '11,26,29,34,44', extra_numbers: '1,10', draw_session: null }, // really Tue 30 Dec
  ]));
  const api = w('api.json', JSON.stringify([
    { date: '2026-05-05', numbers: ['3', '4', '8', '20', '31'], stars: ['6', '8'], prizes: [{ matched_numbers: 2, matched_stars: 0, prize: 4, winners: 9 }] },
    { date: '2026-05-08', numbers: ['1', '2', '3', '4', '5'], stars: ['1', '2'], prizes: [] },
  ]));
  const nl = w('nl.csv', 'DrawDate,Ball 1,Ball 2,Ball 3,Ball 4,Ball 5,Lucky Star 1,Lucky Star 2,UK Millionaire Maker,European Millionaire Maker,Ball Set,Machine,DrawNumber\n' +
    '05-May-2026,3,4,8,20,31,6,8,"XFMK92312",,21,13,1943\n08-May-2026,2,17,19,34,37,8,11,"XGMH78937",,21,13,1944\n');
  execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'build-import.js'), '--out', dir,
    '--lottometrics-lotto', lm, '--lottometrics-em', em, '--emapi-em', api, '--nl-em', nl], { stdio: 'pipe' });
  const lotto = JSON.parse(fs.readFileSync(path.join(dir, 'imported-lotto.json'), 'utf8'));
  assert.deepEqual(lotto.draws.map(d => d.date), ['2025-12-31']);
  assert.deepEqual(lotto.draws[0].main, [3, 20, 27, 29, 38, 46]);
  assert.equal(lotto.draws[0].src, 'lottometrics');
  const e = JSON.parse(fs.readFileSync(path.join(dir, 'imported-euromillions.json'), 'utf8'));
  assert.deepEqual(e.draws.map(d => [d.date, d.src]), [['2026-05-08', 'national-lottery'], ['2026-05-05', 'national-lottery'], ['2025-12-30', 'lottometrics']]);
  assert.deepEqual(e.draws[1].euPrizes, [{ t: '2+0', w: 9, p: 4 }]); // carried over from the lower-priority source
  assert.deepEqual(e.draws[1].mm, ['XFMK92312']);
  assert.equal(e.checks.overlap, 2);
  assert.deepEqual(e.checks.mismatches.map(m => m.date), ['2026-05-08']);
  assert.ok(e.gaps.includes('2026-01-02'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('build-import reads lotto.net draws and tags them by source', () => {
  const fs = require('fs'), os = require('os'), path = require('path'), { execFileSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-import-'));
  const f = path.join(dir, 'ln.json');
  fs.writeFileSync(f, JSON.stringify([{ date: '2026-01-03', main: [6, 20, 34, 38, 47, 48], bonus: 4 }]));
  execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'build-import.js'), '--out', dir, '--lottonet-lotto', f], { stdio: 'pipe' });
  const v = JSON.parse(fs.readFileSync(path.join(dir, 'imported-lotto.json'), 'utf8'));
  assert.deepEqual(v.draws.map(d => [d.date, d.round, d.extra[0], d.src]), [['2026-01-03', null, 4, 'lotto-net']]);
  assert.match(fn('drawMeta')({ src: 'lotto-net' }), /Imported from lotto\.net/);
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ---------- Delta sync with the Worker ---------- */
test('sync asks for the full history first, then only recent draws, and keeps what it already has', async () => {
  const a = loadApp({ settings: { demo: false, workerUrl: 'https://w.test' } });
  const urls = [];
  const d = (date, main) => ({ date, round: null, main, extra: [1, 2], prizes: null });
  const full = [d('2026-10-27', [1, 2, 3, 4, 5]), d('2016-09-27', [6, 7, 8, 9, 10])];
  let reply = { draws: full, full: true, rev: 'r1', apiCount: 1 };
  a.window.fetch = async u => { urls.push(String(u)); return { ok: true, json: async () => JSON.parse(JSON.stringify(reply)) }; };
  const em = a.get('GAMES.euromillions');
  await new Promise(r => setTimeout(r, 50)); // let the app's own sync on start-up finish
  a.get("state.live.euromillions=[]; state.meta={}");
  urls.length = 0;
  const last = async (...args) => { const n = urls.length; await a.window.syncGame(em, ...args); return urls.slice(n).filter(u => /euromillions/.test(u)).pop(); };
  assert.equal(await last(), 'https://w.test/history?game=euromillions');
  assert.equal(a.get('state.live.euromillions.length'), 2);
  // Second sync: only draws from 40 days before the newest one held, with the import revision
  reply = { draws: [d('2026-10-30', [11, 12, 13, 14, 15])], full: false, rev: 'r1', apiCount: 2 };
  assert.equal(await last(), 'https://w.test/history?game=euromillions&since=2026-09-17&rev=r1');
  assert.deepEqual([...a.get('state.live.euromillions.map(d=>d.date)')], ['2026-10-30', '2026-10-27', '2016-09-27']);
  // "Sync all history" (full) ignores the delta
  assert.equal(await last(true), 'https://w.test/history?game=euromillions');
});

test('historyQuery stays full for an older Worker that sends no import revision', () => {
  const a = loadApp({ settings: { demo: false, workerUrl: 'https://w.test' } });
  a.get("state.live.lotto=[{date:'2026-10-28',main:[1,2,3,4,5,6],extra:[7]}]; state.meta={lotto:{store:{count:1}}}");
  assert.equal(a.get('historyQuery(GAMES.lotto)'), '/history?game=lotto');
  a.get("state.meta.lotto.store.rev=''");
  assert.equal(a.get('historyQuery(GAMES.lotto)'), '/history?game=lotto&since=2026-09-18&rev=');
});

/* ---------- Droughts, consecutive numbers and line totals ---------- */
test('consecutiveDist is a full distribution and matches the known chance of a pair', () => {
  const near = (a, b, t = 1e-9) => assert.ok(Math.abs(a - b) < t, `${a} vs ${b}`);
  for (const [N, k, anyPair] of [[59, 6, 0.42679], [50, 5, 0.35304]]) {
    const d = [...fn('consecutiveDist')(N, k)];
    near(d.reduce((a, b) => a + b, 0), 1);
    near(1 - d[0], anyPair, 1e-5);
    near(d[0], fn('comb')(N - k + 1, k) / fn('comb')(N, k)); // no-neighbour lines: C(N−k+1, k)
  }
  assert.equal(fn('pairsIn')([3, 4, 5, 20, 40, 41]), 3);
  assert.equal(fn('pairsIn')([1, 3, 5, 7, 9, 11]), 0);
});

test('sumDist covers every total with the right mean', () => {
  const d = [...fn('sumDist')(59, 6)];
  assert.ok(Math.abs(d.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  const mean = d.reduce((a, p, s) => a + p * s, 0);
  assert.ok(Math.abs(mean - 180) < 1e-6, String(mean));
  assert.ok(Math.abs(d[21] - 1 / fn('comb')(59, 6)) < 1e-15); // only 1-2-3-4-5-6 adds up to 21
});

test('droughts measures the gaps between appearances, newest draw first', () => {
  // Oldest → newest (draws 0–6): 1 is in draws 1, 4, 6 (gaps 3, 2); 3 is in 0, 2, 3 (gaps 2, 1); 2 only in 5
  const ds = [[3], [1], [3], [3], [1], [2], [1]].reverse().map(m => ({ main: m }));
  const r = fn('droughts')(ds, 3, d => d.main);
  assert.deepEqual([...r.gaps].sort((a, b) => a - b), [1, 2, 2, 3]);
  // Draws since each last appeared: 1 in the newest draw, 2 one draw ago, 3 three draws ago
  assert.deepEqual([...r.current].map(c => [c.x, c.g]), [[1, 0], [2, 1], [3, 3]]);
});

test('stats shows the new chance cards for main balls, and only the drought card for stars', () => {
  const doc = app.window.document;
  app.get("state.game='lotto'; state.view='stats'; state.statPool='main'; state.statWin='all'; render();");
  let h = doc.querySelector('#view').innerHTML;
  for (const t of ['Is “overdue” real?', 'Consecutive numbers', 'Line totals']) assert.ok(h.includes(t), t);
  app.get("state.game='euromillions'; state.statPool='extra'; render();");
  h = doc.querySelector('#view').innerHTML;
  assert.ok(h.includes('Is “overdue” real?'));
  assert.ok(!h.includes('Consecutive numbers') && !h.includes('Line totals'));
  app.get("state.statPool='main'; render();");
  assert.equal(app.errors.length, 0, app.errors.map(e => e.message).join('\n'));
});

/* ---------- First run and installing ---------- */
test('a fresh install uses the built-in Worker, shows "Fetching" and then the real results', async () => {
  const a = loadApp({ settings: {} });
  const urls = [];
  let release;
  const gate = new Promise(r => { release = r; });
  const d = { date: '2026-10-28', round: 'Round 1', main: [2, 4, 21, 26, 30, 38], extra: [51], prizes: null };
  a.window.fetch = async u => { urls.push(String(u)); await gate; return { ok: true, json: async () => ({ draws: /lotto/.test(u) ? [d] : [], full: true, rev: 'r' }) }; };
  await new Promise(r => setTimeout(r, 20));
  assert.equal(a.get('settings.demo'), false);
  assert.match(urls[0], /^https:\/\/lotto-lab-proxy\.wayne-lee-paul-reynolds\.workers\.dev\/history\?game=lotto$/);
  assert.match(a.window.document.querySelector('#view').textContent, /Fetching results/);
  release();
  await new Promise(r => setTimeout(r, 50));
  assert.equal(a.get('state.live.lotto.length'), 1);
  assert.doesNotMatch(a.window.document.querySelector('#view').textContent, /Fetching results/);
});

test('an existing phone keeps its own settings', () => {
  const a = loadApp({ settings: { demo: true, workerUrl: 'https://mine.example.workers.dev' } });
  assert.equal(a.get('settings.workerUrl'), 'https://mine.example.workers.dev');
  assert.equal(a.get('settings.demo'), true);
});

test('iosInstallState spots iPhones and iPads, and knows when the app is already installed', () => {
  const s = fn('iosInstallState');
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1';
  const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15';
  const pixel = 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36';
  assert.equal(s({ userAgent: iphone }), 'needs-install');
  assert.equal(s({ userAgent: iphone, standalone: true }), 'installed');
  assert.equal(s({ userAgent: iphone, displayModeStandalone: true }), 'installed');
  assert.equal(s({ userAgent: mac, maxTouchPoints: 5 }), 'needs-install'); // iPad asking for the desktop site
  assert.equal(s({ userAgent: mac, maxTouchPoints: 0 }), 'not-ios');
  assert.equal(s({ userAgent: pixel }), 'not-ios');
});

test('on Android the Install button uses the browser prompt, and Not now hides it for a week', async () => {
  const a = loadApp();
  const w = a.window, doc = w.document;
  let prompted = 0;
  const e = new w.Event('beforeinstallprompt');
  e.prompt = () => { prompted++; };
  e.userChoice = Promise.resolve({ outcome: 'accepted' });
  w.dispatchEvent(e);
  a.get("state.view='latest'; render();");
  const btn = doc.querySelector('[data-act="install"]');
  assert.ok(btn, 'Install button shown');
  btn.click();
  await new Promise(r => setTimeout(r, 10));
  assert.equal(prompted, 1);
  assert.equal(doc.querySelector('[data-act="install"]'), null, 'gone once used');
  w.dispatchEvent(Object.assign(new w.Event('beforeinstallprompt'), { prompt() {}, userChoice: Promise.resolve({}) }));
  doc.querySelector('[data-act="installlater"]').click();
  await new Promise(r => setTimeout(r, 10));
  assert.equal(doc.querySelector('.card.install'), null, 'snoozed');
  assert.equal(a.errors.length, 0, a.errors.map(x => x.message).join('\n'));
});

/* ---------- Stats access codes ---------- */
test('Stats are locked without a code, and a good code unlocks them on this phone', async () => {
  const a = loadApp({ stats: false });
  const w = a.window, doc = w.document;
  const urls = [];
  let answer = { ok: false, reason: 'full' };
  w.fetch = async u => { urls.push(String(u)); return { ok: true, json: async () => answer }; };
  await new Promise(r => setTimeout(r, 50)); // let the app finish starting up (it renders once its storage opens)
  a.get("settings.workerUrl='https://w.test'; state.view='stats'; render();");
  assert.match(doc.querySelector('#view').textContent, /invited testers/);
  assert.equal(doc.querySelector('#view').textContent.includes('Is it random?'), false);
  doc.querySelector('#statscode').value = 'abcd-efgh';
  doc.querySelector('[data-act="unlockstats"]').click();
  await new Promise(r => setTimeout(r, 10));
  assert.match(urls[0], /\/unlock\?code=ABCD-EFGH&device=[0-9a-f]{32}$/);
  assert.match(doc.querySelector('#toast').textContent, /already in use/);
  assert.match(doc.querySelector('#view').textContent, /invited testers/); // still locked
  answer = { ok: true };
  doc.querySelector('[data-act="unlockstats"]').click();
  await new Promise(r => setTimeout(r, 10));
  assert.equal(urls[1].split('device=')[1], urls[0].split('device=')[1], 'same phone ID each time');
  assert.doesNotMatch(doc.querySelector('#view').textContent, /invited testers/);
  assert.deepEqual(JSON.parse(w.localStorage.getItem('ll_statsAccess')), { code: 'ABCD-EFGH', ok: true });
  assert.equal(a.errors.length, 0, a.errors.map(x => x.message).join('\n'));
});

test('a sync that says the code was removed locks Stats again; Latest and Check stay free', async () => {
  const a = loadApp({ settings: { demo: false, workerUrl: 'https://w.test' }, stats: false });
  const w = a.window, doc = w.document;
  w.localStorage.setItem('ll_statsAccess', JSON.stringify({ code: 'ABCD-EFGH', ok: true }));
  a.get("statsAccess.code='ABCD-EFGH'; statsAccess.ok=true");
  const urls = [];
  const d = { date: '2026-10-28', round: 'Round 1', main: [2, 4, 21, 26, 30, 38], extra: [51], prizes: null };
  w.fetch = async u => { urls.push(String(u)); return { ok: true, json: async () => ({ draws: [d], full: true, rev: 'r', stats: false }) }; };
  await w.syncGame(a.get('GAMES.lotto'));
  assert.match(urls.pop(), /&code=ABCD-EFGH&device=[0-9a-f]{32}$/);
  assert.equal(a.get('statsAccess.ok'), false);
  a.get("state.game='lotto'; state.view='stats'; render();");
  assert.match(doc.querySelector('#view').textContent, /invited testers/);
  for (const v of ['latest', 'check', 'gen']) {
    a.get(`state.view='${v}'; render();`);
    assert.doesNotMatch(doc.querySelector('#view').textContent, /invited testers/, v);
  }
});

/* ---------- Weak signal ---------- */
test('a failed background update says so in the header, and clears once it works', async () => {
  const a = loadApp({ settings: { demo: false, workerUrl: 'https://w.example.workers.dev' } });
  const d = { date: '2026-10-28', round: 'Round 1', main: [2, 4, 21, 26, 30, 38], extra: [51], prizes: null };
  let ok = false;
  a.window.fetch = async u => { if (!ok) throw new TypeError('Failed to fetch'); return { ok: true, json: async () => ({ draws: /lotto/.test(u) ? [d] : [], full: true, rev: 'r' }) }; };
  await new Promise(r => setTimeout(r, 30));
  a.get(`state.live.lotto=[${JSON.stringify(d)}]`);
  await a.get('syncAll(false,true)');
  const hdr = () => a.window.document.querySelector('#hdr').textContent;
  assert.match(hdr(), /Couldn't update · showing results/);
  ok = true;
  await a.get('syncAll(false,true)');
  assert.doesNotMatch(hdr(), /Couldn't update/);
  assert.match(hdr(), /Live · 1 draws · updated/);
  assert.equal(a.errors.length, 0, a.errors.map(e => e.message).join('\n'));
});

test('a stalled request to the Worker gives up instead of waiting for ever', async () => {
  const a = loadApp({ settings: { demo: true, workerUrl: 'https://w.example.workers.dev' } });
  const real = a.window.setTimeout.bind(a.window);
  a.window.setTimeout = (f, ms, ...x) => real(f, ms === 20e3 ? 5 : ms, ...x); // the 20-second limit, sped up
  a.window.fetch = (u, o) => new Promise((_, rej) => o.signal.addEventListener('abort', () => rej(new Error('aborted'))));
  const msg = await a.get(`api('/history?game=lotto')`).catch(e => e.message);
  assert.match(msg, /No answer/);
});

/* ---------- Due on paper ---------- */
test('onPaperRank ranks balls by draws since last seen ÷ average gap, furthest first', () => {
  // Newest first: 1 in the latest draw, 2 one draw ago, 3 never seen (counts as the whole history, 3 draws)
  const ds = [{ main: [1] }, { main: [2] }, { main: [1] }];
  const r = fn('onPaperRank')(ds, 3, 1, d => d.main);
  assert.deepEqual([...r].map(b => [b.x, b.g, b.never]), [[3, 3, true], [2, 1, false], [1, 0, false]]);
  assert.ok(Math.abs(r[0].r - 1) < 1e-9); // average gap 3/1 = 3, so 3 draws is 1.0×
});

test('due on paper: Lotto counts the bonus and gives 6 balls; EuroMillions gives 5 numbers and 2 stars', () => {
  const lotto = app.get("onPaperLine(GAMES.lotto, draws(GAMES.lotto))");
  assert.equal(lotto.mains.length, 6);
  assert.equal(lotto.stars.length, 0);
  assert.ok(Math.abs(lotto.avgM - 59 / 7) < 1e-9);
  // A ball that came out as the latest bonus has gap 0, so it can't top the list
  const last = app.get("draws(GAMES.lotto)[0]");
  assert.ok(!lotto.mains.some(b => last.extra.includes(b.x)));
  const em = app.get("onPaperLine(GAMES.euromillions, draws(GAMES.euromillions))");
  assert.equal(em.mains.length, 5);
  assert.equal(em.stars.length, 2);
  assert.ok(Math.abs(em.avgM - 10) < 1e-9 && Math.abs(em.avgS - 6) < 1e-9);
});

test('due on paper shows in the overdue card (main balls only) and saves to My lines', () => {
  const doc = app.window.document;
  app.get("state.game='lotto'; state.view='stats'; state.statPool='main'; state.statWin='all'; myLines.lotto=[]; render();");
  assert.ok(doc.querySelector('#view').innerHTML.includes('Due on paper'));
  doc.querySelector('[data-act="keeppaper"]').click();
  const saved = app.get("JSON.stringify(myLines.lotto)");
  const want = app.get("JSON.stringify([{main:onPaperLine(GAMES.lotto,draws(GAMES.lotto)).mains.map(b=>b.x).sort((a,b)=>a-b),extra:[]}])");
  assert.equal(saved, want);
  app.get("state.game='euromillions'; state.statPool='extra'; render();");
  assert.ok(!doc.querySelector('#view').innerHTML.includes('Due on paper'));
  app.get("state.statPool='main'; render();");
  assert.ok(doc.querySelector('#view').innerHTML.includes('Due on paper'));
  assert.equal(app.errors.length, 0, app.errors.map(e => e.message).join('\n'));
});

/* ---------- Play it for years ---------- */
test('simulator draws fairly: Lotto Match 2 and Match 3 rates per round match the real odds', () => {
  const s = app.get("sim=simNew(GAMES.lotto,[1,2,3,4,5,6],[],[]); state.simYi=18; simStep(sim,100000); sim");
  assert.equal(s.n, 100000);
  assert.equal(s.rounds, 200000); // a Lotto line enters both rounds
  const C = fn('comb'), all = C(59, 6);
  for (const [k, m] of [['2+0', 2], ['3+0', 3]]) {
    const p = C(6, m) * C(53, 6 - m) / all, exp = p * s.rounds, sd = Math.sqrt(exp * (1 - p));
    assert.ok(Math.abs((s.counts[k] || 0) - exp) < 5 * sd, `${k}: ${s.counts[k]} vs ${exp.toFixed(0)}`);
  }
  // Every simulated draw is 6 different balls from 1–59 plus a different bonus
  const l = s.last, b = new Set([...l.main, ...l.extra]);
  assert.equal(b.size, 7);
  assert.ok([...b].every(x => x >= 1 && x <= 59));
});

test('simulator stops at the chosen number of years, and money adds up', () => {
  const s = app.get("state.simYi=0; sim=simNew(GAMES.euromillions,[1,2,3,4,5],[1,2],draws(GAMES.euromillions)); simStep(sim,1e6); sim");
  if (!s.hit) {
    assert.equal(s.n, 104); // 1 year = 104 draws
    assert.ok(s.done);
  }
  const won = Object.entries(s.counts).reduce((a, [k, c]) => a + c * s.prizes[k], 0);
  assert.ok(Math.abs(won - s.won) < 1e-6);
});

test('simulator stops on a jackpot and says how long it took', () => {
  const doc = app.window.document;
  app.get("state.game='lotto'; state.view='check'; state.editing=null; state.pick={main:new Set([7,8,9,10,11,12]),extra:new Set()}; sim=null; render();");
  assert.ok(doc.querySelector('#simcard'), 'card shows once a full line is picked');
  // Force a jackpot on the next draw by making the line every number (so all 6 drawn balls match)
  app.get("sim.line.fill(1); state.simYi=18; simStep(sim,10); simPaint(sim);");
  assert.ok(app.get('sim.hit') && app.get('sim.hit.n') === 1);
  assert.ok(doc.querySelector('#simstat').textContent.includes('Jackpot after'));
  app.get("state.pick={main:new Set(),extra:new Set()}; render();");
  assert.ok(!doc.querySelector('#simcard'), 'no card without a full line');
  assert.equal(app.errors.length, 0, app.errors.map(e => e.message).join('\n'));
});
