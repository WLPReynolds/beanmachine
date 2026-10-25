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
  assert.match(w.document.querySelector('#view').innerHTML, new RegExp('Oddly v' + app.get('APP_VERSION').replace(/\./g, '\\.')));
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

for (const id of ['lotto-lab', 'oddly']) {
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
  assert.match(a.window.document.querySelector('#toast').textContent, /isn't an Oddly backup/);
});

test('Back up writes an oddly backup with the dated file name', () => {
  const a = loadApp();
  let blob, name;
  a.window.URL.createObjectURL = b => { blob = b; return 'blob:x'; };
  a.window.URL.revokeObjectURL = () => {};
  a.window.HTMLAnchorElement.prototype.click = function () { name = this.download; };
  a.window.exportBackup();
  assert.match(name, /^oddly-backup-\d{4}-\d{2}-\d{2}\.json$/);
  assert.ok(blob);
});

test('user-facing name is Oddly, with the not-affiliated line', () => {
  const a = loadApp();
  const d = a.window.document;
  assert.equal(d.title, 'Oddly');
  a.get('render()');
  assert.match(d.querySelector('#hdr').textContent, /Oddly/);
  a.get("state.view='settings'; render();");
  const v = d.querySelector('#view').textContent;
  assert.match(v, /Not affiliated with the National Lottery or its operator/);
  assert.doesNotMatch(d.body.textContent, /Lotto Lab/);
});
