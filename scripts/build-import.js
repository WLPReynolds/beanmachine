#!/usr/bin/env node
// Builds the imported-history values for the Worker's KV store (keys `imported:lotto`, `imported:euromillions`).
// The source files are not kept in this repo (they're third-party data); pass their paths in.
//
//   node scripts/build-import.js --out <dir> \
//     --lottometrics-lotto uknationallottery_1994-2025.json \
//     --lottometrics-em euromillions_2004-2025.json \
//     --nl-lotto lotto-draw-history.csv \
//     --nl-em euromillions-draw-history.csv \
//     --emapi-em em2026.json \
//     --lottonet-lotto lottonet-lotto.json
//
// Every option is optional; give whichever files you have. Where sources overlap, the higher-priority one
// is kept (national-lottery > euromillions-api, lotto-net > lottometrics) and the numbers are checked against each other.
// Only current-format draws are kept (Lotto from 10 Oct 2015, EuroMillions from 27 Sep 2016).
'use strict';
const fs = require('fs');
const path = require('path');

const GAMES = {
  lotto: { main: 6, mainMax: 59, extra: 1, extraMax: 59, days: [3, 6], since: '2015-10-10', roundsSince: '2026-06-10' },
  euromillions: { main: 5, mainMax: 50, extra: 2, extraMax: 12, days: [2, 5], since: '2016-09-27' },
};
const SOURCES = {
  'national-lottery': { name: 'The National Lottery draw history download (CSV, last ~180 days)', priority: 3 },
  'euromillions-api': { name: 'euromillions.api.pedromealha.dev (JSON; prize tables are Europe-wide, in euros)', priority: 2 },
  'lotto-net': { name: 'lotto.net results archive (read from its yearly pages; JSON [{date, main, bonus}])', priority: 2 },
  lottometrics: { name: 'lottometrics.app (JSON; its dates are one day early and are corrected here)', priority: 1 },
};

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const out = args.out || '.';

const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const weekday = iso => new Date(iso + 'T12:00:00Z').getUTCDay();
const MON = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
const fromDMY = s => { const [d, m, y] = s.split('-'); return `${y}-${String(MON[m]).padStart(2, '0')}-${d.padStart(2, '0')}`; };
const ints = s => String(s).split(',').map(x => x.trim()).filter(Boolean).map(Number);
const sorted = a => [...a].sort((x, y) => x - y);
const tidy = v => (v == null || String(v).trim() === '' ? null : String(v).replace(/\s+/g, ''));

// Minimal CSV parser: handles quoted fields containing commas
function csv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const f = []; let cur = '', q = false;
    for (const c of line) {
      if (c === '"') q = !q; else if (c === ',' && !q) { f.push(cur); cur = ''; } else cur += c;
    }
    f.push(cur); rows.push(f);
  }
  const [head, ...body] = rows;
  return body.map(r => Object.fromEntries(head.map((h, i) => [h.trim(), r[i]])));
}

function base(date, round, main, extra, src) {
  return { date, round, main: sorted(main), extra: sorted(extra), jackpot: null, prizes: null, machine: null, ballSet: null, src };
}

const readers = {
  lottometrics(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8')).map(r =>
      base(addDays(r.draw_date, 1), null, ints(r.main_numbers), ints(r.extra_numbers), 'lottometrics'));
  },
  nlLotto(file) {
    return csv(fs.readFileSync(file, 'utf8')).map(r => {
      const date = fromDMY(r.DrawDate);
      const round = date >= GAMES.lotto.roundsSince ? `Round ${r.Round}` : null;
      const d = base(date, round, [1, 2, 3, 4, 5, 6].map(i => Number(r[`Ball ${i}`])), [Number(r['Bonus Ball'])], 'national-lottery');
      const mm = String(r['Guaranteed Millionaire Maker'] || '').split(',').map(s => s.trim()).filter(Boolean);
      return Object.assign(d, { machine: tidy(r.Machine), ballSet: tidy(r['Ball Set']), drawNo: Number(r.DrawNumber) || null, ...(mm.length ? { mm } : {}) });
    });
  },
  nlEm(file) {
    return csv(fs.readFileSync(file, 'utf8')).map(r => {
      const d = base(fromDMY(r.DrawDate), null, [1, 2, 3, 4, 5].map(i => Number(r[`Ball ${i}`])), [Number(r['Lucky Star 1']), Number(r['Lucky Star 2'])], 'national-lottery');
      const mm = String(r['UK Millionaire Maker'] || '').split(',').map(s => s.trim()).filter(Boolean);
      return Object.assign(d, { machine: tidy(r.Machine), ballSet: tidy(r['Ball Set']), drawNo: Number(r.DrawNumber) || null, ...(mm.length ? { mm } : {}) });
    });
  },
  lottoNet(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8')).map(r => {
      // Pre-rounds draws only: lotto.net lists one line per date
      if (r.date >= GAMES.lotto.roundsSince) throw new Error(`lotto.net ${r.date}: Lotto has two rounds from ${GAMES.lotto.roundsSince}; add a round to this reader first`);
      return base(r.date, null, r.main.map(Number), [Number(r.bonus)], 'lotto-net');
    });
  },
  emApi(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8')).map(r => {
      const d = base(r.date, null, r.numbers.map(Number), r.stars.map(Number), 'euromillions-api');
      // Europe-wide winners and euro amounts: kept apart from `prizes`, which the app reads as UK figures
      if (Array.isArray(r.prizes)) d.euPrizes = r.prizes.map(x => ({ t: `${x.matched_numbers}+${x.matched_stars}`, w: x.winners, p: x.prize }));
      return d;
    });
  },
};

function check(g, d) {
  const G = GAMES[g];
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(d.date) && G.days.includes(weekday(d.date))
    && new Set(d.main).size === G.main && d.main.every(n => n >= 1 && n <= G.mainMax)
    && new Set(d.extra).size === G.extra && d.extra.every(n => n >= 1 && n <= G.extraMax);
  return ok;
}

const key = d => d.date + '|' + (d.round || '');
const plan = {
  lotto: [['lottometrics-lotto', 'lottometrics'], ['lottonet-lotto', 'lottoNet'], ['nl-lotto', 'nlLotto']],
  euromillions: [['lottometrics-em', 'lottometrics'], ['emapi-em', 'emApi'], ['nl-em', 'nlEm']],
};

for (const [g, inputs] of Object.entries(plan)) {
  const map = new Map(), sources = {}, rejected = [], checks = { overlap: 0, mismatches: [] };
  for (const [opt, reader] of inputs) {
    if (!args[opt]) continue;
    const rows = readers[reader](args[opt]).filter(d => d.date >= GAMES[g].since);
    for (const d of rows) {
      if (!check(g, d)) { rejected.push(d); continue; }
      const k = key(d), old = map.get(k);
      if (old) {
        checks.overlap++;
        if (JSON.stringify([old.main, old.extra]) !== JSON.stringify([d.main, d.extra])) checks.mismatches.push({ date: d.date, round: d.round, [old.src]: [old.main, old.extra], [d.src]: [d.main, d.extra] });
        // Keep the higher-priority source's record, but carry over fields it lacks (e.g. euPrizes)
        const [win, lose] = SOURCES[d.src].priority >= SOURCES[old.src].priority ? [d, old] : [old, d];
        for (const f of ['euPrizes', 'drawNo', 'mm']) if (win[f] == null && lose[f] != null) win[f] = lose[f];
        for (const f of ['machine', 'ballSet']) if (win[f] == null && lose[f] != null) win[f] = lose[f];
        map.set(k, win);
      } else map.set(k, d);
      const s = sources[d.src] || (sources[d.src] = { name: SOURCES[d.src].name, file: path.basename(args[opt]), rows: 0 });
      s.rows++;
    }
  }
  if (!map.size) continue;
  const draws = [...map.values()].sort((a, b) => b.date.localeCompare(a.date) || String(b.round || '').localeCompare(String(a.round || '')));
  for (const s of Object.keys(sources)) {
    const mine = draws.filter(d => d.src === s).map(d => d.date).sort();
    Object.assign(sources[s], { kept: mine.length, from: mine[0] ?? null, to: mine[mine.length - 1] ?? null });
  }
  // Calendar gaps: draw days in the covered range with no draw
  const dates = new Set(draws.map(d => d.date)), gaps = [];
  for (let d = GAMES[g].since; d <= draws[0].date; d = addDays(d, 1)) if (GAMES[g].days.includes(weekday(d)) && !dates.has(d)) gaps.push(d);
  const value = { version: 1, game: g, built: new Date().toISOString(), sources, checks, gaps, draws };
  const file = path.join(out, `imported-${g}.json`);
  fs.writeFileSync(file, JSON.stringify(value));
  console.log(`${g}: ${draws.length} draws (${draws[draws.length - 1].date} → ${draws[0].date}), ` +
    `${checks.overlap} overlaps, ${checks.mismatches.length} mismatches, ${rejected.length} rejected, ${gaps.length} missing draw dates → ${file}`);
  for (const [s, v] of Object.entries(sources)) console.log(`  ${s}: ${v.kept} kept of ${v.rows} (${v.from} → ${v.to})`);
  if (gaps.length) console.log(`  gaps: ${gaps.length <= 12 ? gaps.join(', ') : gaps.slice(0, 6).join(', ') + ' … ' + gaps.slice(-3).join(', ')}`);
  for (const m of checks.mismatches) console.log('  MISMATCH', JSON.stringify(m));
}
