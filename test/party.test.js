const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers');

const app = loadApp();
const on = (ymd, hols = '[]') => app.get(`partyFor(new Date('${ymd}T12:00:00'), ${hols})`);

test('fixed party dates', () => {
  assert.equal(on('2026-10-31'), 'halloween');
  assert.equal(on('2026-11-05'), 'bonfire');
  assert.equal(on('2027-02-14'), 'valentine');
  assert.equal(on('2026-11-19'), 'firstdraw');
  assert.equal(on('2026-12-25'), 'xmas');
  assert.equal(on('2026-12-26'), 'xmas');
  assert.equal(on('2027-01-01'), 'newyear');
  assert.equal(on('2026-11-04'), null);
});

test("gov.uk bunting days pick the matching party, and Good Friday's false flag is ignored", () => {
  const hols = JSON.stringify([
    { date: '2027-03-26', title: 'Good Friday', bunting: false },
    { date: '2027-03-29', title: 'Easter Monday', bunting: true },
    { date: '2027-05-03', title: 'Early May bank holiday', bunting: true },
    { date: '2027-12-27', title: 'Christmas Day', bunting: true },
    { date: '2027-12-28', title: 'Boxing Day', bunting: true },
    { date: '2028-01-03', title: 'New Year’s Day', bunting: true },
  ]);
  assert.equal(on('2027-03-26', hols), null);
  assert.equal(on('2027-03-29', hols), 'easter');
  assert.equal(on('2027-05-03', hols), 'bunting');
  assert.equal(on('2027-12-27', hols), 'xmas'); // substitute day still gets Christmas
  assert.equal(on('2027-12-28', hols), 'xmas');
  assert.equal(on('2028-01-03', hols), 'newyear');
});

test('the header shows bunting or Christmas lights on those days only', () => {
  const doc = app.window.document;
  app.get('var _ph=partyHeaderHTML');
  for (const [k, sel] of [['bunting', '.bunting'], ['easter', '.bunting'], ['newyear', '.bunting'], ['xmas', '.xlights']]) {
    app.get(`partyHeaderHTML=()=>_ph(${JSON.stringify(k)}); renderHeader();`);
    assert.ok(doc.querySelector('#hdr ' + sel), `${k} shows ${sel}`);
    assert.ok(doc.querySelector('#hdr').classList.contains('party-hdr'));
  }
  app.get('partyHeaderHTML=()=>_ph("halloween"); renderHeader();');
  assert.ok(!doc.querySelector('#hdr .bunting, #hdr .xlights'));
  assert.ok(!doc.querySelector('#hdr').classList.contains('party-hdr'));
  app.get('partyHeaderHTML=_ph; renderHeader();');
  assert.equal(app.errors.length, 0, app.errors.map(e => e.message).join('\n'));
});

test('?party= previews a party, and ?party=none turns them off', () => {
  assert.equal(app.get('partyToday()'), null);
  const a = loadApp({ url: 'https://lottolab.test/?party=easter' });
  assert.equal(a.get('partyToday()'), 'easter');
  const b = loadApp({ url: 'https://lottolab.test/?party=nonsense' });
  assert.notEqual(b.get('partyToday()'), 'nonsense');
});

test('every party runs without errors where animation is unavailable, and shows its message', () => {
  for (const k of app.get('PARTIES')) {
    if (k === 'record') continue;
    app.get(`partyRan=false; runParty(${JSON.stringify(k)})`);
    assert.ok(app.window.document.querySelector('#toast').textContent.length > 0, k);
  }
  app.get('partyRan=false; runParty("halloween")');
  app.get('runParty("bonfire")'); // only once per open
  assert.match(app.window.document.querySelector('#toast').textContent, /Halloween/);
  assert.equal(app.errors.length, 0, app.errors.map(e => e.message).join('\n'));
});

test('every party animates without errors when animation is available', () => {
  const w = app.window;
  w.Element.prototype.animate = function () { return { onfinish: null, cancel() {} }; };
  try {
    for (const k of app.get('PARTIES')) {
      app.get(`partyRan=false; runParty(${JSON.stringify(k)})`);
      assert.ok(w.document.querySelector('.party'), `${k} adds its layer`);
      for (const el of w.document.querySelectorAll('.party')) el.remove();
    }
  } finally { delete w.Element.prototype.animate; }
  assert.equal(app.errors.length, 0, app.errors.map(e => e.message).join('\n'));
});

test('a record jackpot needs a recent draw beating 100+ earlier jackpots', () => {
  const a = loadApp({ settings: { demo: false, workerUrl: '' } });
  const set = (n, top, ageDays) => a.get(`(()=>{const now=Date.now(),ds=[];
    for(let i=1;i<=${n};i++)ds.push({date:iso(new Date(now-(i*3+${ageDays})*864e5)),main:[1,2,3,4,5,6],extra:[7],jackpot:2e6+i*1e3});
    ds.unshift({date:iso(new Date(now-${ageDays}*864e5)),main:[1,2,3,4,5,6],extra:[7],jackpot:${top}});
    state.live.lotto=ds;state.live.euromillions=[];})()`);
  set(120, 9e6, 1);
  assert.equal(a.get('recordJackpot()?.jackpot'), 9e6);
  set(120, 2e6, 1);
  assert.equal(a.get('recordJackpot()'), null, 'not bigger than before');
  set(120, 9e6, 5);
  assert.equal(a.get('recordJackpot()'), null, 'too old');
  set(40, 9e6, 1);
  assert.equal(a.get('recordJackpot()'), null, 'not enough history with jackpots');
});

test('the gov.uk feed is stored (England and Wales, recent dates only) and fetched at most daily', async () => {
  const a = loadApp({ url: 'https://lottolab.test/' });
  await new Promise(r => setTimeout(r, 100)); // let the app's own start-up sync settle first
  const calls = [];
  a.window.fetch = async u => { calls.push(u); return { ok: true, json: async () => ({
    'england-and-wales': { events: [
      { title: 'Old one', date: '2018-05-07', notes: '', bunting: true },
      { title: 'Christmas Day', date: '2099-12-25', notes: '', bunting: true },
      { title: 'Good Friday', date: '2099-04-10', notes: '', bunting: false },
    ] },
    scotland: { events: [{ title: '2nd January', date: '2099-01-02', bunting: true }] },
  }) }; };
  a.window.localStorage.removeItem('ll_hols'); a.window.localStorage.removeItem('ll_holsAt');
  assert.equal(await a.get('syncHolidays()'), true);
  assert.deepEqual(JSON.parse(JSON.stringify(a.get("LS.get('hols')"))), [
    { date: '2099-12-25', title: 'Christmas Day', bunting: true },
    { date: '2099-04-10', title: 'Good Friday', bunting: false },
  ]);
  assert.equal(await a.get('syncHolidays()'), false);
  assert.equal(calls.filter(u => /gov\.uk/.test(u)).length, 1);
});
