'use strict';
const APP_VERSION='1.1.0';

/* ---------- Game definitions ---------- */
// "since" = first draw of the current format: Lotto went to 59 balls in Oct 2015; EuroMillions to 12 Lucky Stars in Sep 2016.
const GAMES={
  lotto:{key:'lotto',name:'Lotto',main:6,mainMax:59,extra:1,extraMax:59,extraName:'Bonus',sepPool:false,since:'2015-10-10',days:[3,6],roundsSince:'2026-06-10'},
  euromillions:{key:'euromillions',name:'EuroMillions',main:5,mainMax:50,extra:2,extraMax:12,extraName:'Lucky Stars',sepPool:true,since:'2016-09-27',days:[2,5]}
};

/* ---------- Storage ---------- */
const LS={get(k,d){try{const v=localStorage.getItem('ll_'+k);return v==null?d:JSON.parse(v)}catch(e){return d}},set(k,v){try{localStorage.setItem('ll_'+k,JSON.stringify(v))}catch(e){}}};
const DB={db:null,mem:{},
  async open(){try{this.db=await new Promise((res,rej)=>{const r=indexedDB.open('lottolab',1);r.onupgradeneeded=()=>r.result.createObjectStore('kv');r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)})}catch(e){this.db=null}},
  get(k){if(!this.db)return Promise.resolve(this.mem[k]);return new Promise(res=>{try{const q=this.db.transaction('kv').objectStore('kv').get(k);q.onsuccess=()=>res(q.result);q.onerror=()=>res(undefined)}catch(e){res(undefined)}})},
  set(k,v){this.mem[k]=v;if(!this.db)return Promise.resolve();return new Promise(res=>{try{const t=this.db.transaction('kv','readwrite');t.objectStore('kv').put(v,k);t.oncomplete=()=>res();t.onerror=()=>res()}catch(e){res()}})}
};

const settings=Object.assign({workerUrl:'',demo:true,avoidLast:true,worthIt:50000000,genLines:3,freePlan:true,bonusCounts:true},LS.get('settings',{}));
const myLines=Object.assign({lotto:[],euromillions:[]},LS.get('lines',{}));
const saveLines=()=>LS.set('lines',myLines);
const MAX_LINES=10;
// Locked-in entries: {id, lines:[{main,extra}], dates:['YYYY-MM-DD'], at}. Results only use live draws.
const tickets=Object.assign({lotto:[],euromillions:[]},LS.get('tickets',{}));
const saveTickets=()=>LS.set('tickets',tickets);
const seen=new Set(LS.get('seen',[]));const saveSeen=()=>LS.set('seen',[...seen]);
const saveSettings=()=>LS.set('settings',settings);
settings.freePlan=true; // fallback only fetches this year's results; the Worker's store holds the history
const state={game:LS.get('game','lotto'),view:'latest',live:{lotto:[],euromillions:[]},meta:LS.get('meta',{}),
  pick:{main:new Set(),extra:new Set()},editing:null,open:new Set(),lock:null,animKey:'',gen:[],statWin:'all',statPool:'main',statSort:'num'};
const demoCache={};

/* ---------- Helpers ---------- */
const $=s=>document.querySelector(s);
const pad=n=>String(n).padStart(2,'0');
const iso=d=>`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const fmtDate=s=>new Date(s+'T12:00:00').toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short',year:'numeric'});
const money=j=>j==null?'':(j>=1e6?'£'+(+(j/1e6).toFixed(1))+'m':'£'+Math.round(j).toLocaleString('en-GB'));
const rand=()=>crypto.getRandomValues(new Uint32Array(1))[0]/4294967296;
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
function pickDistinct(rng,n,max,exclude=new Set()){const s=new Set();let guard=0;while(s.size<n&&guard++<10000){const x=1+Math.floor(rng()*max);if(!exclude.has(x))s.add(x)}return[...s].sort((a,b)=>a-b)}
function toast(msg){const t=$('#toast');t.textContent=msg;t.classList.add('show');clearTimeout(t._h);t._h=setTimeout(()=>t.classList.remove('show'),2600)}
const G=()=>GAMES[state.game];
const dKey=d=>d.date+'|'+(d.round||'');
const sortDraws=a=>a.sort((x,y)=>y.date.localeCompare(x.date)||String(y.round||'').localeCompare(String(x.round||'')));
const rTag=d=>d.round?` <span class="pill" style="background:rgba(255,255,255,.12);color:var(--muted)">${String(d.round).replace('Round ','R')}</span>`:'';
// Every round on the most recent draw date (Lotto has two rounds per draw since June 2026)
const lastSet=ds=>ds.length?ds.filter(d=>d.date===ds[0].date):[];
const unionMain=set=>[...new Set(set.flatMap(d=>d.main))];

function ball(n,g,o={}){
  if(o.star)return `<span class="starw ${o.cls||''}" ${o.attr||''}><span class="star ${o.sm?'sm':''}"><b>${n}</b></span></span>`;
  const c=g.key==='lotto'?'c'+Math.floor(n/10):'em';
  return `<span class="ball ${c} ${o.sm?'sm':''} ${o.lg?'lg':''} ${o.bonus?'bonus':''} ${o.cls||''}" ${o.attr||''}><b>${n}</b></span>`;
}
function lineBalls(g,main,extra,o={}){
  let h=main.map((n,i)=>ball(n,g,{...o,cls:(o.cls||'')+(o.anim?' drop':''),attr:o.anim?`style="animation-delay:${i*90}ms"`:''})).join('');
  if(extra&&extra.length){h+=`<span class="plus">+</span>`+extra.map((n,i)=>g.sepPool?ball(n,g,{star:true,sm:o.sm,cls:o.anim?'drop':'',attr:o.anim?`style="animation-delay:${(main.length+i)*90}ms"`:''}):ball(n,g,{sm:o.sm,bonus:true})).join('')}
  return `<div class="balls">${h}</div>`;
}
// One line of balls that never wraps; ball size comes from the fit class
function rowBalls(g,main,extra,o={}){
  const mk=(n,isX,i)=>{const c=[o.anim?'drop':'',o.mark?o.mark(n,isX):''].join(' '),a=o.anim?`style="animation-delay:${i*90}ms"`:'';
    return isX&&g.sepPool?ball(n,g,{star:true,cls:c,attr:a}):ball(n,g,{bonus:isX,cls:c,attr:a})};
  let h=main.map((n,i)=>mk(n,false,i)).join('');
  if(extra&&extra.length)h+=`<span class="plus">+</span>`+extra.map((n,i)=>mk(n,true,main.length+i)).join('');
  return `<div class="balls nw ${o.fit||'fit-lg'}">${h}</div>`;
}
const shortDate=s=>new Date(s+'T12:00:00').toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short'});

/* ---------- Data ---------- */
function demoDraws(g){
  const rng=mulberry32(g.key==='lotto'?1959:2050),out=[];
  const end=new Date(Date.now()-22*3600e3);
  for(let d=new Date(g.since+'T12:00:00');d<=end;d.setDate(d.getDate()+1)){
    if(!g.days.includes(d.getDay()))continue;
    const rounds=g.roundsSince&&iso(d)>=g.roundsSince?['Round 1','Round 2']:[null];
    for(const round of rounds){
      const main=pickDistinct(rng,g.main,g.mainMax);
      const extra=g.sepPool?pickDistinct(rng,g.extra,g.extraMax):pickDistinct(rng,1,g.mainMax,new Set(main));
      out.push({date:iso(d),round,main,extra,jackpot:null});
    }
  }
  sortDraws(out);
  if(out[0])out[0].jackpot=g.key==='lotto'?2000000+Math.round(rng()*8)*1e6:17000000+Math.round(rng()*150)*1e6;
  return out;
}
function draws(g=G()){
  const arr=settings.demo?(demoCache[g.key]||(demoCache[g.key]=demoDraws(g))):state.live[g.key]||[];
  return arr.filter(d=>d.date>=g.since);
}
function valid(g,d){return d&&/^\d{4}-\d{2}-\d{2}$/.test(d.date)&&Array.isArray(d.main)&&d.main.length===g.main&&d.main.every(n=>n>=1&&n<=g.mainMax)}

function callsThisMonth(){const m=iso(new Date()).slice(0,7);const c=LS.get('calls',{});return c[m]||0}
function bumpCalls(){const m=iso(new Date()).slice(0,7);const c=LS.get('calls',{});c[m]=(c[m]||0)+1;LS.set('calls',c)}
// costsCall: true only for routes that go straight to the lottery API (not the Worker's stored history)
async function api(path,costsCall=true){
  if(!settings.workerUrl)throw new Error('No worker URL set');
  const r=await fetch(settings.workerUrl.replace(/\/$/,'')+path);if(costsCall)bumpCalls();
  const j=await r.json().catch(()=>({}));
  if(j.remaining!=null){state.meta.remaining={n:j.remaining,limit:j.limit,at:j.rateAt?Date.parse(j.rateAt):Date.now()};LS.set('meta',state.meta)}
  if(!r.ok)throw new Error(j.error||('HTTP '+r.status));return j;
}
async function syncGame(g,full){
  // Preferred: the Worker's stored history (built up by its schedule). Costs no API calls.
  try{
    const r=await api(`/history?game=${g.key}`,false);
    const map=new Map(state.live[g.key].map(d=>[dKey(d),d]));
    (r.draws||[]).forEach(d=>{if(valid(g,d))map.set(dKey(d),d)});
    state.live[g.key]=sortDraws([...map.values()]);
    await DB.set('draws_'+g.key,state.live[g.key]);
    state.meta[g.key]={lastSync:Date.now(),nextJackpot:r.nextJackpot??state.meta[g.key]?.nextJackpot??null,store:{updatedAt:r.updatedAt,lastRun:r.lastRun,count:(r.draws||[]).length}};
    LS.set('meta',state.meta);return;
  }catch(e){
    // Older Worker (no /history) or KV not set up: fall back to asking the API directly
    if(!/not found|KV not set up/i.test(e.message))throw e;
  }
  let years;
  if(settings.freePlan){const n=new Date();years=[n.getFullYear()];if(n.getMonth()===0)years.unshift(n.getFullYear()-1)}
  else if(full||!state.live[g.key].length){
    const y=await api(`/years?game=${g.key}`);
    years=(y.years||[]).map(Number).filter(v=>v>=+g.since.slice(0,4)).sort((a,b)=>a-b);
  }else{const n=new Date();years=[n.getFullYear()];if(n.getMonth()===0)years.unshift(n.getFullYear()-1)}
  const map=new Map(state.live[g.key].map(d=>[dKey(d),d]));
  let nextJackpot=null;
  for(const y of years){const r=await api(`/draws?game=${g.key}&year=${y}`);(r.draws||[]).forEach(d=>{if(valid(g,d))map.set(dKey(d),d)});if(r.nextJackpot!=null)nextJackpot=r.nextJackpot}
  state.live[g.key]=sortDraws([...map.values()]);
  await DB.set('draws_'+g.key,state.live[g.key]);
  state.meta[g.key]={lastSync:Date.now(),nextJackpot:nextJackpot??state.meta[g.key]?.nextJackpot??null};LS.set('meta',state.meta);
}
async function syncAll(full,quiet){
  try{for(const g of Object.values(GAMES))await syncGame(g,full);if(!quiet)toast('Results updated ✨')}
  catch(e){if(!quiet)toast('Update failed: '+e.message)}
  render();
}
function lastResultsTime(g){const now=new Date();for(let i=0;i<8;i++){const c=new Date(now);c.setDate(now.getDate()-i);c.setHours(22,30,0,0);if(g.days.includes(c.getDay())&&c<=now)return c.getTime()}return 0}
function nextDraw(g){const now=new Date();for(let i=0;i<8;i++){const c=new Date(now);c.setDate(now.getDate()+i);c.setHours(20,0,0,0);if(g.days.includes(c.getDay())&&c>now)return c}}
async function maybeAutoSync(){
  if(settings.demo||!settings.workerUrl)return;
  const last=Math.min(...Object.values(GAMES).map(g=>state.meta[g.key]?.lastSync||0));
  if(Date.now()-last>5*60e3)await syncAll(false,true);
}

/* ---------- Analysis ---------- */
const inter=(a,b)=>a.filter(n=>b.includes(n)).length;
const same=(a,b)=>a.length===b.length&&a.every((v,i)=>v===b[i]);
function popularity(g,main,ds){
  const lastMain=unionMain(lastSet(ds)),k=main.length,r=[];let s=0;
  const bday=main.filter(n=>n<=31).length;
  if(bday===k){s+=35;r.push('Every number is 31 or under — birthday range, the most popular kind of line')}
  else if(bday>=k-1){s+=18;r.push(`${bday} of ${k} numbers are in the birthday range (1–31)`)}
  let pairs=0,run=1,maxRun=1;for(let i=1;i<k;i++){if(main[i]===main[i-1]+1){pairs++;run++;maxRun=Math.max(maxRun,run)}else run=1}
  if(maxRun>=3){s+=20;r.push(`A run of ${maxRun} consecutive numbers`)}else if(pairs){s+=6*pairs;r.push(`${pairs} consecutive pair${pairs>1?'s':''}`)}
  const diffs=main.slice(1).map((v,i)=>v-main[i]);
  if(diffs.every(d=>d===diffs[0])){s+=30;r.push('An evenly spaced pattern (like 5, 10, 15…)')}
  for(const m of[5,7,10]){const c=main.filter(n=>n%m===0).length;if(c>=4){s+=12;r.push(`${c} multiples of ${m}`);break}}
  const ld={};main.forEach(n=>ld[n%10]=(ld[n%10]||0)+1);const mx=Math.max(...Object.values(ld));
  if(mx>=3){s+=8;r.push(`${mx} numbers end in the same digit`)}
  if(new Set(main.map(n=>Math.floor(n/10))).size<=2){s+=10;r.push('Bunched into one or two decades')}
  if(lastMain.length){const o=inter(main,lastMain);if(o){s+=5*o;r.push(`${o} number${o>1?'s':''} from the last draw — some players copy recent results`)}}
  if(ds.some(d=>same(d.main,main))){s+=25;r.push('This exact line has come up before — some people play past winning lines')}
  const sum=main.reduce((a,b)=>a+b,0);if(sum<k*(g.mainMax+1)/2*.6){s+=8;r.push('Low total — skewed towards small numbers')}
  s=Math.min(100,s);
  return{score:s,reasons:r,band:s<15?'low':s<40?'med':'high'};
}
function popHTML(p){
  const lbl={low:'Low popularity',med:'Medium popularity',high:'High popularity'}[p.band];
  const msg={low:'Few obvious patterns — if it won, you\'d be less likely to share.',med:'Some common patterns — a share is more likely.',high:'Lots of people probably play something like this.'}[p.band];
  return `<div class="row" style="justify-content:space-between"><span class="pill p-${p.band}">${lbl}</span><span class="muted small">${p.score}/100</span></div>
  <div class="meter"><i style="left:${Math.max(3,Math.min(97,p.score))}%"></i></div><div class="small">${msg}</div>
  ${p.reasons.length?`<ul class="r">${p.reasons.map(x=>`<li>${x}</li>`).join('')}</ul>`:''}`;
}
function generate(g,ds){
  const ls=lastSet(ds);
  const excl=new Set(settings.avoidLast?ls.flatMap(d=>d.main.concat(g.sepPool?[]:d.extra)):[]);
  let best=null;
  for(let i=0;i<400;i++){const main=pickDistinct(rand,g.main,g.mainMax,excl);const p=popularity(g,main,ds);if(!best||p.score<best.p.score)best={main,p};if(p.score===0)break}
  const extra=g.sepPool?pickDistinct(rand,g.extra,g.extraMax,new Set(settings.avoidLast?ls.flatMap(d=>d.extra):[])):[];
  return{...best,extra};
}
/* ---------- My lines: replace numbers that came up in the last draw ---------- */
function lastDrawn(g,ds){
  const ls=lastSet(ds),m=new Set(ls.flatMap(d=>d.main)),x=new Set(ls.flatMap(d=>d.extra));
  if(!g.sepPool){if(settings.bonusCounts)x.forEach(n=>m.add(n));return{m,x:new Set(),ls}}
  return{m,x,ls};
}
// Eligible numbers, least drawn first; keep everything tied with the 5th-lowest count
function leastPool(g,ds,isX,excl){
  const N=isX?g.extraMax:g.mainMax,cnt=Array(N+1).fill(0);
  ds.forEach(d=>(isX?d.extra:d.main).forEach(n=>cnt[n]++));
  const el=[];for(let n=1;n<=N;n++)if(!excl.has(n))el.push(n);
  if(!el.length)return[];
  el.sort((a,b)=>cnt[a]-cnt[b]);
  const cut=cnt[el[Math.min(4,el.length-1)]];
  return el.filter(n=>cnt[n]<=cut);
}
function suggestFor(g,ds,line){
  const {m,x}=lastDrawn(g,ds);
  const hitM=line.main.filter(n=>m.has(n)),hitX=g.sepPool?line.extra.filter(n=>x.has(n)):[];
  if(!hitM.length&&!hitX.length)return{none:true,hitM,hitX};
  const pick=(pool,k)=>{const p=[...pool],out=[];while(out.length<k&&p.length)out.push(p.splice(Math.floor(rand()*p.length),1)[0]);return out};
  const newM=pick(leastPool(g,ds,false,new Set([...m,...line.main])),hitM.length);
  const newX=g.sepPool?pick(leastPool(g,ds,true,new Set([...x,...line.extra])),hitX.length):[];
  return{hitM,hitX,newM,newX,
    main:[...line.main.filter(n=>!m.has(n)),...newM].sort((a,b)=>a-b),
    extra:g.sepPool?[...line.extra.filter(n=>!x.has(n)),...newX].sort((a,b)=>a-b):[]};
}
// Suggestions are kept until the next draw arrives, so they don't change every time the screen redraws
function lineSugg(g,ds,line){
  const base=JSON.stringify([line.main,line.extra,settings.bonusCounts]);
  if(!line.sugg||line.sugg.forDate!==ds[0].date||line.sugg.base!==base){line.sugg={...suggestFor(g,ds,line),forDate:ds[0].date,base};saveLines()}
  return line.sugg;
}
function erf(x){const s=Math.sign(x);x=Math.abs(x);const t=1/(1+.3275911*x);return s*(1-((((1.061405429*t-1.453152027)*t+1.421413741)*t-.284496736)*t+.254829592)*t*Math.exp(-x*x))}
const phi=z=>.5*(1+erf(z/Math.SQRT2));
function chiP(x,k){const z=(Math.cbrt(x/k)-(1-2/(9*k)))/Math.sqrt(2/(9*k));return 1-phi(z)}
function comb(n,k){if(k<0||k>n)return 0;let r=1;for(let i=1;i<=k;i++)r=r*(n-k+i)/i;return r}

/* ---------- Crowd score: how popular were the drawn numbers? ----------
   Uses the draw's own prize breakdown. By pure chance, the ratio of Match-3 to Match-2 winners is fixed
   (Lotto: 0.1067; EuroMillions, both with no stars: 0.0698), whatever the numbers and however many
   tickets were sold. If the drawn numbers are popular, more people share 3 of them, so the ratio rises.
   Score = observed ratio ÷ chance ratio − 1. Noise ≈ ±2·sqrt(1/W_a + 1/W_b). */
function tierMap(prizes){
  const m={};
  for(const x of prizes||[]){const r=/Match (\d)(?: plus (?:(\d) )?Bonus Balls?)?/i.exec(x.t||'');if(!r||!(x.w>0))continue;
    const k=r[1]+'+'+(r[2]?+r[2]:/plus/i.test(x.t)?1:0);m[k]=(m[k]||0)+x.w}
  return m;
}
function ratioScore(wa,wb,expected){
  if(!(wa>0&&wb>0))return null;
  const pct=(wa/wb)/expected-1,noise=2*Math.sqrt(1/wa+1/wb);
  return{pct,noise,sig:Math.abs(Math.log(1+pct))>noise};
}
const CROWD={lotto:{m3:0.10666666666666666,m4:0.004705882352941177},euromillions:{m3:0.0697674418604651,st:1/45}};
function crowd(g,d){
  if(!d.prizes)return null;
  const m=tierMap(d.prizes),c=CROWD[g.key];
  const main=ratioScore(m['3+0'],m['2+0'],c.m3);if(!main)return null;
  return{main,
    m4:g.key==='lotto'?ratioScore(m['4+0'],m['2+0'],c.m4):null,
    stars:g.sepPool?ratioScore(m['2+2'],m['2+0'],c.st):null};
}
const pctTxt=x=>(x.pct>=0?'+':'−')+Math.round(Math.abs(x.pct)*100)+'%';
function cwChip(x,short){
  if(!x)return '';
  const cls=!x.sig?'cw-av':x.pct>0?'cw-hi':'cw-lo';
  return `<span class="cw ${cls}">${short?'':'👥 '}${x.sig?pctTxt(x):'≈ avg'}</span>`;
}
function crowdLine(g,d){
  const c=crowd(g,d);
  if(!c)return `<div class="crowdline">👥 Crowd score: waiting for the prize breakdown (published a few hours after the draw)</div>`;
  const desc=!c.main.sig?'about as popular as chance':c.main.pct>0?`${Math.round(c.main.pct*100)}% more popular than chance — prizes shared more widely`:`${Math.round(-c.main.pct*100)}% less popular than chance — prizes shared less widely`;
  let extra='';
  if(c.m4)extra+=` · Match 4: ${pctTxt(c.m4)}`;
  if(c.stars)extra+=` · Lucky Stars ${cwChip(c.stars,true)}`;
  return `<div class="crowdline">${cwChip(c.main)}<span>${g.sepPool?'Main numbers ':'Numbers '}${desc}${extra}</span></div>`;
}
function crowdCard(g,ds){
  const rows=ds.map(d=>({d,c:crowd(g,d)})).filter(x=>x.c);
  let h=`<div class="card"><h2>👥 Crowd watch</h2><p class="small muted" style="margin-top:0">How popular each draw's numbers were with real UK players, worked out from how many people won at each prize level. Popular numbers mean shared prizes.</p>`;
  if(!rows.length)return h+`<p>No prize breakdowns stored yet.</p></div>`;
  const when=d=>shortDate(d.date)+(d.round?` ${d.round.replace('Round ','R')}`:'');
  const sorted=[...rows].sort((a,b)=>b.c.main.pct-a.c.main.pct);
  const line=x=>`<div class="rank"><span class="when">${when(x.d)}</span>${rowBalls(g,x.d.main,[],{fit:'fit'})}${cwChip(x.c.main,true)}</div>`;
  h+=`<h3>Most crowded</h3>${sorted.slice(0,3).map(line).join('')}<h3>Quietest</h3>${sorted.slice(-3).reverse().map(line).join('')}`;
  // Birthday effect, measured: average crowd score by how many drawn numbers were 31 or under
  const grp={};rows.forEach(x=>{const k=x.d.main.filter(n=>n<=31).length;(grp[k]=grp[k]||[]).push(x.c.main.pct)});
  const ks=Object.keys(grp).map(Number).sort((a,b)=>a-b),avg=k=>grp[k].reduce((a,b)=>a+b,0)/grp[k].length;
  const top=Math.max(0.05,...ks.map(k=>Math.abs(avg(k))));
  h+=`<h3>The birthday effect, measured</h3><div class="dv">${ks.map(k=>{const a=avg(k),w=Math.abs(a)/top*50;
    return `<div class="b"><span>${k} of ${g.main} ≤31 <span class="muted">(${grp[k].length})</span></span><div class="t"><i style="${a>=0?`left:50%;width:${w}%;background:var(--bad)`:`right:50%;width:${w}%;background:var(--good)`}"></i></div><span class="small">${(a>=0?'+':'−')+Math.round(Math.abs(a)*100)}%</span></div>`}).join('')}</div>
  <div class="note">Average crowd score for draws with that many numbers in the birthday range (number of draws in brackets). If people really favour birthdays, the bars should climb as you go down. Based on ${rows.length} draw${rows.length===1?'':'s'} so far${g.roundsSince?' (each round counts)':''} — it firms up as the Worker stores more.</div></div>`;
  return h;
}

/* ---------- Locked entries & results ---------- */
const EM_WIN=new Set(['5+2','5+1','5+0','4+2','4+1','4+0','3+2','3+1','3+0','2+2','2+1','2+0','1+2']);
const LOTTO_FIXED={'2+0':1,'3+0':10,'4+0':50,'5+0':1000,'5+1':1000000};
const expectedRounds=(g,date)=>g.roundsSince&&date>=g.roundsSince?2:1;
const liveFor=(g,date)=>(state.live[g.key]||[]).filter(d=>d.date===date);
const isDrawn=(g,date)=>liveFor(g,date).length>=expectedRounds(g,date);
// Upcoming draw dates you can still buy for (sales close about 19:30 on the day)
function upcomingDates(g,n=8){const out=[],now=new Date();for(let i=0;out.length<n&&i<60;i++){const c=new Date(now);c.setDate(now.getDate()+i);c.setHours(19,30,0,0);if(g.days.includes(c.getDay())&&c>now)out.push(iso(c))}return out}
// Still on sale: draw date in the future, or today before sales close (19:30)
const stillOpen=dt=>{const c=new Date(dt+'T19:30:00');return c>new Date()};
const sameLine=(a,b)=>same(a.main,b.main)&&same(a.extra||[],b.extra||[]);
// Pending (not yet drawn) dates this exact line is locked in for
function lockedDates(g,line){const out=new Set();tickets[g.key].forEach(t=>{if(t.lines.some(l=>sameLine(l,line)))t.dates.forEach(dt=>{if(!isDrawn(g,dt))out.add(dt)})});return[...out].sort()}
function prizeKeyMap(d){const m={};for(const x of d.prizes||[]){const r=/Match (\d)(?: plus (?:(\d) )?Bonus Balls?)?/i.exec(x.t||'');if(!r)continue;m[r[1]+'+'+(r[2]?+r[2]:/plus/i.test(x.t)?1:0)]=x}return m}
function prizeFor(g,d,k){
  if(d.prizes){const x=prizeKeyMap(d)[k];if(!x)return null;
    if(k==='6+0'&&!g.sepPool||k==='5+2'&&g.sepPool)return{amount:x.p||d.jackpot,known:!!(x.p||d.jackpot),jackpot:true};
    return x.p>0?{amount:x.p,known:true}:null}
  if(!g.sepPool){if(k==='6+0')return{amount:d.jackpot,known:false,jackpot:true};return LOTTO_FIXED[k]?{amount:LOTTO_FIXED[k],known:true}:null}
  return EM_WIN.has(k)?{amount:null,known:false,jackpot:k==='5+2'}:null;
}
// Result of one locked entry on one date (null until every round of that draw is stored)
function entryResult(g,t,date){
  if(!isDrawn(g,date))return null;
  const rs=liveFor(g,date).sort((a,b)=>String(a.round||'').localeCompare(String(b.round||''))),wins=[];
  t.lines.forEach((l,li)=>rs.forEach(d=>{
    const m=inter(l.main,d.main),st=g.sepPool?inter(l.extra,d.extra):(m===5&&d.extra.some(x=>l.main.includes(x))?1:0);
    const pr=prizeFor(g,d,m+'+'+st);if(pr)wins.push({li,round:d.round,m,st,...pr});
  }));
  return{wins,total:wins.reduce((a,w)=>a+(w.known?w.amount:0),0),unknown:wins.some(w=>!w.known)};
}
const winTxt=(g,w)=>`${w.m}${g.sepPool?(w.st?` + ${w.st}★`:''):(w.st?' + Bonus':'')}`;
// Every drawn (game, date) you had entries for, combined across entries
function resultsByDate(g){
  const map={};
  tickets[g.key].forEach(t=>t.dates.forEach(dt=>{const r=entryResult(g,t,dt);if(!r)return;
    const e=map[dt]||(map[dt]={date:dt,lines:0,wins:[],total:0,unknown:false});
    e.lines+=t.lines.length;r.wins.forEach(w=>e.wins.push({...w,lineNo:e.lines-t.lines.length+w.li+1}));e.total+=r.total;e.unknown=e.unknown||r.unknown}));
  return Object.values(map).sort((a,b)=>b.date.localeCompare(a.date));
}
const moneyWin=v=>v>=1e6?money(v):'£'+(v%1?v.toFixed(2):Math.round(v).toLocaleString('en-GB'));
function bannerHTML(){
  if(settings.demo)return '';
  let h='';
  for(const g of Object.values(GAMES))for(const r of resultsByDate(g)){
    const k=g.key+'|'+r.date;if(seen.has(k))continue;
    if(!r.wins.length){h+=`<div class="banner quiet"><button class="x" data-act="seen" data-k="${k}">✕</button>🎟️ ${g.name}, ${shortDate(r.date)}: checked your ${r.lines} line${r.lines>1?'s':''} — no wins this time.</div>`;continue}
    const conf=Array.from({length:18},(_,i)=>`<i class="conf" style="left:${(i*37)%100}%;background:${['#f7c948','#ff5fa8','#3ddc97','#2f86ff','#a066ff'][i%5]};animation-delay:${(i*0.17)%2.8}s"></i>`).join('');
    const jp=r.wins.some(w=>w.jackpot);
    const amt=r.total>0?moneyWin(r.total)+(r.unknown?' + more to come':''):'a prize';
    h+=`<div class="banner">${conf}<button class="x" data-act="seen" data-k="${k}">✕</button><h2>${jp?'🤯 JACKPOT!':'🎉 You won '+amt+'!'}</h2>
      <div class="small">${g.name}, ${fmtDate(r.date)}</div>
      <ul class="r">${r.wins.map(w=>`<li>Line ${w.lineNo}${w.round?`, ${w.round}`:''}: matched ${winTxt(g,w)} — <b>${w.known?moneyWin(w.amount):'amount to follow'}</b></li>`).join('')}</ul>
      ${r.unknown?`<div class="note">EuroMillions prizes are shared out, so some amounts appear once the prize breakdown is published.</div>`:''}</div>`;
  }
  return h;
}

/* ---------- Backup ---------- */
const BACKUP_APPS=['oddly','lotto-lab'];
function exportBackup(){
  const data={app:'oddly',version:1,exported:new Date().toISOString(),
    draws:{lotto:state.live.lotto,euromillions:state.live.euromillions},lines:myLines,tickets,seen:[...seen],
    settings:{workerUrl:settings.workerUrl,worthIt:settings.worthIt,freePlan:settings.freePlan,bonusCounts:settings.bonusCounts,avoidLast:settings.avoidLast}};
  const blob=new Blob([JSON.stringify(data)],{type:'application/json'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`oddly-backup-${iso(new Date())}.json`;
  document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),5000);
  LS.set('lastBackup',Date.now());toast('Backup saved to Downloads');
}
async function importBackup(file){
  let data;try{data=JSON.parse(await file.text())}catch(e){toast('That file isn\'t an Oddly backup');return}
  // 'lotto-lab' = backups made before the rename to Oddly (Oct 2026)
  if(!BACKUP_APPS.includes(data?.app)||!data.draws){toast('That file isn\'t an Oddly backup');return}
  let addedD=0,addedL=0;
  for(const g of Object.values(GAMES)){
    // Draws: merge, so nothing already on this device is lost
    const map=new Map(state.live[g.key].map(d=>[dKey(d),d]));
    (data.draws[g.key]||[]).forEach(d=>{if(valid(g,d)&&!map.has(dKey(d))){map.set(dKey(d),d);addedD++}});
    state.live[g.key]=sortDraws([...map.values()]);await DB.set('draws_'+g.key,state.live[g.key]);
    // Lines: add any that aren't already here
    const have=new Set(myLines[g.key].map(l=>JSON.stringify([l.main,l.extra])));
    (data.lines?.[g.key]||[]).forEach(l=>{const k=JSON.stringify([l.main,l.extra]);
      if(Array.isArray(l.main)&&l.main.length===g.main&&!have.has(k)&&myLines[g.key].length<MAX_LINES){myLines[g.key].push({main:l.main,extra:l.extra||[]});have.add(k);addedL++}});
  }
  saveLines();
  let addedT=0;
  for(const g of Object.values(GAMES)){const have=new Set(tickets[g.key].map(t=>t.id));
    (data.tickets?.[g.key]||[]).forEach(t=>{if(t&&t.id&&!have.has(t.id)&&Array.isArray(t.lines)&&Array.isArray(t.dates)){tickets[g.key].push(t);addedT++}})}
  saveTickets();(data.seen||[]).forEach(k=>seen.add(k));saveSeen();
  const bs=data.settings||{};
  if(!settings.workerUrl&&bs.workerUrl)settings.workerUrl=bs.workerUrl;
  for(const k of ['worthIt','freePlan','bonusCounts','avoidLast'])if(bs[k]!=null)settings[k]=bs[k];
  if(state.live.lotto.length||state.live.euromillions.length)settings.demo=false;
  saveSettings();render();
  toast(`Restored: ${addedD} new draws, ${addedL} new lines, ${addedT} entries`);
}

/* ---------- Views ---------- */
function renderHeader(){
  const g=G(),ds=draws();let badge;
  if(settings.demo)badge=`<span class="badge demo">✨ SAMPLE DATA — not real results</span>`;
  else if(!ds.length)badge=`<span class="badge">No results yet — add your worker in Settings</span>`;
  else{const t=state.meta[g.key]?.lastSync;badge=`<span class="badge">Live · ${ds.length} draws${t?' · updated '+new Date(t).toLocaleString('en-GB',{weekday:'short',hour:'2-digit',minute:'2-digit'}):''}</span>`}
  const sp=[[8,20,0],[78,14,.8],[90,52,1.6],[55,8,1.2],[30,60,2]].map(([l,t,d])=>`<i class="spark" style="left:${l}%;top:${t}px;animation-delay:${d}s"></i>`).join('');
  $('#hdr').innerHTML=`${sp}<h1>Oddly ✦</h1><div class="sub">Stats for fun — every line has the same chance</div>
  <div class="seg">${Object.values(GAMES).map(x=>`<button data-game="${x.key}" class="${x.key===g.key?'on':''}">${x.name}</button>`).join('')}</div>${badge}`;
}
function renderNav(){
  const items=[['latest','🎱','Latest'],['check','🔍','Check'],['gen','🎟️','My lines'],['stats','📊','Stats'],['settings','⚙️','Settings']];
  $('#nav').innerHTML=items.map(([k,i,l])=>`<button data-view="${k}" class="${state.view===k?'on':''}"><span>${i}</span>${l}</button>`).join('');
}
function noData(){return `<div class="card"><h2>No results yet</h2><p class="muted">Turn on sample data, or add your worker URL in Settings and tap “Get latest”.</p></div>`}

function viewLatest(){
  const g=G(),ds=draws();if(!ds.length)return noData();
  const d=ds[0],ls=lastSet(ds),nd=nextDraw(g),jp=settings.demo?d.jackpot:(state.meta[g.key]?.nextJackpot??d.jackpot);
  let jack='';
  if(jp!=null){
    const worth=g.key==='euromillions'?(jp>=settings.worthIt?`🔥 Over your ${money(settings.worthIt)} line — worth winning!`:`😴 Under your ${money(settings.worthIt)} “worth winning” line`):'';
    jack=`<div class="card jack"><div class="muted small">${settings.demo?'Sample jackpot':'Jackpot'}</div><div class="big">${money(jp)}</div>${worth?`<div style="margin-top:6px;font-weight:700">${worth}</div>`:''}</div>`;
  }
  const anim=state.animKey!==g.key+d.date;state.animKey=g.key+d.date;
  const lk='L'+g.key+d.date,lopen=state.open.has(lk);
  const meta=x=>x.machine||x.ballSet?`<div class="meta">Machine ${x.machine??'?'} · Ball set ${x.ballSet??'?'}</div>`:'';
  return `${bannerHTML()}${jack}<div class="card latest${lopen?' open':''}" data-grp="${lk}"><h2>${g.name} · ${fmtDate(d.date)}<span class="chev">▸</span></h2>${[...ls].reverse().map(x=>`${x.round?`<h3>${x.round}</h3>`:''}${rowBalls(g,x.main,x.extra,{fit:'fit-lg',anim})}${settings.demo?'':crowdLine(g,x)}${lopen&&(x.prizes||x.machine||x.ballSet||settings.demo)?`<div class="pb">${prizeTable(g,x)}${meta(x)}</div>`:''}`).join('')}
  ${nd?`<div class="note">Next draw: ${nd.toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'short'})}</div>`:''}</div>
  <div class="card"><h2>Recent draws</h2>${recentHTML(g,ds)}</div>`;
}
// Prize breakdown table for one draw/round, top tier first
function prizeMoney(v){if(!(v>0))return '—';if(v>=1e6)return money(v);return '£'+(v%1?v.toFixed(2):Math.round(v).toLocaleString('en-GB'))}
function prizeTable(g,d){
  if(!d.prizes)return settings.demo?`<p class="small muted" style="margin:0">Sample data has no prize breakdown.</p>`:'';
  const rows=d.prizes.map(x=>{const r=/Match (\d)(?: plus (?:(\d) )?Bonus Balls?)?/i.exec(x.t||'');if(!r)return null;
    const m=+r[1],st=r[2]?+r[2]:/plus/i.test(x.t)?1:0;return{m,st,w:x.w,p:x.p}}).filter(Boolean)
    .sort((a,b)=>b.m-a.m||b.st-a.st);
  const lbl=x=>g.sepPool?`${x.m}${x.st?` + ${x.st}★`:''}`:`${x.m}${x.st?' + Bonus':''}`;
  return `<table><tr><th>Match</th><th>Winners</th><th>Prize each</th></tr>${rows.map(x=>`<tr><td>${lbl(x)}</td><td>${x.w>0?x.w.toLocaleString('en-GB'):'0'}</td><td class="${x.w>0&&x.p>0?'prize':''}">${prizeMoney(x.p)}</td></tr>`).join('')}</table>`;
}
function recentHTML(g,ds){
  const dates=[...new Set(ds.map(x=>x.date))].slice(1,7);
  return dates.map(dt=>{
    const rs=ds.filter(x=>x.date===dt).sort((a,b)=>String(a.round||'').localeCompare(String(b.round||'')));
    const chips=settings.demo?'':rs.map(x=>{const c=crowd(g,x);return c?`${x.round?`<span class="small muted">${x.round.replace('Round ','R')}</span>`:''}${cwChip(c.main,true)}`:''}).join(' ');
    const open=state.open.has(g.key+dt);
    const detail=!open?'':rs.map(x=>`<div class="pb">${x.round?`<h4>${x.round}</h4>`:''}${settings.demo?'':crowdLine(g,x)}${prizeTable(g,x)}${x.machine||x.ballSet?`<div class="meta">Machine ${x.machine??'?'} · Ball set ${x.ballSet??'?'}</div>`:''}</div>`).join('');
    return `<div class="grp${open?' open':''}" data-grp="${g.key+dt}"><div class="dt"><span>${shortDate(dt)}<span class="chev">▸</span></span><span class="cws">${chips}</span></div>${rs.map(x=>x.round
      ?`<div class="rr"><span class="lbl">${x.round}</span>${rowBalls(g,x.main,x.extra,{fit:'fit'})}</div>`
      :`<div class="rr">${rowBalls(g,x.main,x.extra,{fit:'fit-md'})}</div>`).join('')}${detail}</div>`}).join('');
}

function pickerGrid(g,pool){
  const max=pool==='main'?g.mainMax:g.extraMax,sel=state.pick[pool];let h='';
  for(let n=1;n<=max;n++)h+=pool==='extra'?ball(n,g,{star:true,cls:sel.has(n)?'':'off',attr:`data-pick="extra" data-n="${n}"`}):ball(n,g,{cls:sel.has(n)?'':'off',attr:`data-pick="main" data-n="${n}"`});
  return `<div class="grid">${h}</div>`;
}
function viewCheck(){
  const g=G(),ds=draws(),pm=state.pick.main,pe=state.pick.extra;
  const needM=g.main-pm.size,needE=g.sepPool?g.extra-pe.size:0;
  const ed=state.editing;
  let h=`<div class="card"><h2>${ed!=null&&ed>=0?`Editing Line ${ed+1}`:ed===-1?'Add a line':'Check a line'}</h2><p class="small muted" style="margin-top:0">Tap ${g.main} numbers${g.sepPool?` and ${g.extra} Lucky Stars`:''}. ${needM>0?`<b style="color:var(--gold2)">${needM} more to go.</b>`:''}</p>${pickerGrid(g,'main')}
  ${g.sepPool?`<h3>Lucky Stars ${needE>0?`<span style="color:var(--gold2)">· ${needE} more</span>`:''}</h3>${pickerGrid(g,'extra')}`:''}
  <div class="row" style="margin-top:12px"><button class="btn ghost" data-act="clearpick">Clear</button><button class="btn ghost" data-act="randpick">Lucky dip</button></div></div>`;
  if(needM>0||needE>0||!ds.length)return h+(ds.length?'':noData());
  const main=[...pm].sort((a,b)=>a-b),extra=[...pe].sort((a,b)=>a-b);
  const p=popularity(g,main,ds);
  const exact=ds.filter(d=>same(d.main,main));
  const scored=ds.map(d=>({d,m:inter(main,d.main),e:g.sepPool?inter(extra,d.extra):(d.extra.some(x=>main.includes(x))?1:0)}));
  const best=Math.max(...scored.map(s=>s.m)),bestDates=scored.filter(s=>s.m===best).slice(0,3);
  const dl=x=>fmtDate(x.date)+(x.round?` (${x.round})`:'');
  const ls=lastSet(ds),lastTxt=[...ls].reverse().map(x=>{const o=inter(main,x.main);return `${x.round?x.round+': ':''}${o} of your numbers`}).join(' · ');
  const saveLbl=ed!=null&&ed>=0?`💾 Update Line ${ed+1}`:'⭐ Save to my lines';
  h+=`<div class="card"><h2>Your line</h2>${rowBalls(g,main,extra)}<button class="btn" style="margin-top:12px" data-act="saveline">${saveLbl}</button><h3>Popularity</h3>${popHTML(p)}</div>`;
  h+=`<div class="card"><h2>Ever drawn?</h2>${exact.length?
    `<p>🎉 Yes — this exact line came up on <b>${exact.map(dl).join(', ')}</b>.</p><p class="small muted">Its chance of coming up again is the same as any other line. But people do play past winning lines, so a repeat would probably be shared.</p>`:
    `<p>Never drawn as a full line in <b>${ds.length.toLocaleString()}</b> draws${g.roundsSince?' (each round counts as one)':''} since ${fmtDate(g.since)}.</p><p class="small muted">With ${comb(g.mainMax,g.main).toLocaleString()} possible lines, almost every line is in the same boat — it doesn't make it “due”.</p>`}
  <h3>Closest call</h3><p style="margin:0"><b>${best}</b> main number${best===1?'':'s'} on ${bestDates.map(s=>dl(s.d)).join(', ')}${scored.filter(s=>s.m===best).length>3?' and others':''}.</p>
  <h3>Last draw · ${fmtDate(ls[0].date)}</h3><p style="margin:0">${lastTxt}.</p></div>`;
  if(g.key==='lotto'){
    const c=k=>scored.filter(s=>s.m===k&&!(k===5&&s.e)).length,c5b=scored.filter(s=>s.m===5&&s.e).length;
    const rows=[['6 (jackpot)',c(6)],['5 + bonus',c5b],['5',c(5)],['4',c(4)],['3',c(3)],['2',c(2)]];
    h+=`<div class="card"><h2>If you'd played it every draw</h2><table><tr><th>Matched</th><th>Times</th></tr>${rows.map(([l,v])=>`<tr><td>${l}</td><td class="${v?'prize':''}">${v}</td></tr>`).join('')}</table><div class="note">All rows are prize tiers. Out of ${ds.length.toLocaleString()} draws — since June 2026 each draw has two rounds, and each round counts.</div></div>`;
  }else{
    const prize=new Set(['5-2','5-1','5-0','4-2','4-1','4-0','3-2','3-1','3-0','2-2','2-1','2-0','1-2']);
    let t='<tr><th>Main</th><th>+2★</th><th>+1★</th><th>+0★</th></tr>';
    for(let m=5;m>=0;m--){t+=`<tr><td><b>${m}</b></td>`;for(let e=2;e>=0;e--){const v=scored.filter(s=>s.m===m&&s.e===e).length;t+=`<td class="${prize.has(m+'-'+e)&&v?'prize':''}">${v}</td>`}t+='</tr>'}
    h+=`<div class="card"><h2>If you'd played it every draw</h2><table>${t}</table><div class="note">Gold = prize tiers. Out of ${ds.length.toLocaleString()} draws.</div></div>`;
  }
  return h;
}

function viewLines(){
  const g=G(),ds=draws(),lines=myLines[g.key];
  if(!ds.length)return noData();
  const {ls}=lastDrawn(g,ds),when=shortDate(ls[0].date)+(ls.length>1?' (both rounds)':'');
  let h=`<div class="card"><h2>My ${g.name} lines</h2><p class="small muted" style="margin:0">Numbers that came up on <b>${when}</b> are swapped for one of the least-drawn numbers${g.sepPool?' (stars for stars)':''}.${g.sepPool?'':settings.bonusCounts?' The bonus ball counts as drawn.':' The bonus ball is ignored.'}</p>
  ${lines.length?'':`<p>No lines saved yet.</p>`}</div>`;
  if(state.lock)h+=lockPanel(g);
  lines.forEach((l,i)=>{
    const s=lineSugg(g,ds,l),hm=new Set(s.hitM),hx=new Set(s.hitX),p=popularity(g,l.main,ds),lk=lockedDates(g,l);
    h+=`<div class="card"><div class="lhead"><b>Line ${i+1}</b><div class="row"><button class="ibtn" data-act="checkline" data-i="${i}">Check</button>${lk.length?'':`<button class="ibtn" data-act="editline" data-i="${i}">Edit</button><button class="ibtn" data-act="delline" data-i="${i}">✕</button>`}</div></div>
    ${rowBalls(g,l.main,l.extra,{mark:lk.length?null:(n,isX)=>(isX?hx:hm).has(n)?'hit':''})}`;
    if(lk.length){h+=`<p class="small" style="margin:10px 0 0"><span class="lockbadge">🔒 Locked in</span> for ${lk.map(shortDate).join(', ')}. It can't be changed until ${lk.length>1?'those draws have':'that draw has'} happened.</p>`}
    else if(s.none)h+=`<p class="small" style="margin:10px 0 0">✅ None came up on ${shortDate(ls[0].date)} — keep it as it is.</p>`;
    else{
      const nm=new Set(s.newM),nx=new Set(s.newX),gone=[...s.hitM,...s.hitX.map(n=>n+'★')];
      h+=`<div class="arrow">↓ ${gone.join(', ')} came up — for the next draw:</div>
      ${rowBalls(g,s.main,s.extra,{mark:(n,isX)=>(isX?nx:nm).has(n)?'new':''})}
      ${s.newM.length+s.newX.length<s.hitM.length+s.hitX.length?`<p class="small" style="color:var(--warn)">Not enough numbers left to replace them all.</p>`:''}
      <div class="row" style="margin-top:12px"><button class="btn" data-act="acceptline" data-i="${i}">Use these</button><button class="btn ghost" data-act="rerollline" data-i="${i}">🎲 Re-roll</button></div>`;
    }
    h+=`<div class="note">Popularity ${p.score}/100 · <span class="pill p-${p.band}">${{low:'Low',med:'Medium',high:'High'}[p.band]}</span></div></div>`;
  });
  h+=`<div class="row" style="margin:4px 0 0">${lines.length<MAX_LINES?`<button class="btn ghost" data-act="addline">＋ Add a line</button>`:''}${lines.length&&!state.lock?`<button class="btn" data-act="lockopen">🔒 Lock in lines</button>`:''}</div>`;
  h+=entriesCard(g);
  h+=`<div class="note">Replacements come from the least-drawn numbers across the ${ds.length} draws stored so far${settings.freePlan?' — this pool gets more meaningful as history builds up':''}.</div>`;
  return h+viewGen(true);
}
function lockPanel(g){
  const L=myLines[g.key],up=upcomingDates(g),lk=state.lock;
  return `<div class="card" style="border-color:var(--gold)"><h2>🔒 Lock in lines</h2><p class="small muted" style="margin-top:0">Tick the lines you've bought and the draws they're for. Locked lines can't be changed until their draws have happened; you can still add more.</p>
  <h3>Lines</h3>${L.map((l,i)=>`<div class="chk ${lk.sel.has(i)?'on':''}" data-act="locksel" data-i="${i}"><span class="box">${lk.sel.has(i)?'✓':''}</span><b class="small" style="width:44px">Line ${i+1}</b>${rowBalls(g,l.main,l.extra,{fit:'fit'})}</div>`).join('')}
  <h3>Draws</h3><div class="chips">${up.map(dt=>`<button class="chip ${lk.dates.has(dt)?'on':''}" data-act="lockdate" data-d="${dt}">${shortDate(dt)}</button>`).join('')}</div>
  <div class="note">Away for a while? Tick every draw until you're back.</div>
  <div class="row" style="margin-top:12px"><button class="btn" data-act="lockgo">Lock in ${lk.sel.size} line${lk.sel.size===1?'':'s'} × ${lk.dates.size} draw${lk.dates.size===1?'':'s'}</button><button class="btn ghost" data-act="lockcancel">Cancel</button></div></div>`;
}
function entriesCard(g){
  const T=tickets[g.key];if(!T.length)return '';
  const pend={};T.forEach(t=>t.dates.forEach(dt=>{if(!isDrawn(g,dt))(pend[dt]=pend[dt]||[]).push(t)}));
  const pd=Object.keys(pend).sort();
  let h=`<div class="card"><h2>🎟️ My entries</h2>`;
  if(pd.length)h+=`<h3>Coming up</h3>`+pd.map(dt=>`<div class="ent"><div class="eh"><span>${shortDate(dt)}</span>${stillOpen(dt)?'':'<span class="muted small">waiting for results</span>'}</div>${pend[dt].map(t=>{
      const canUndo=t.dates.every(stillOpen);
      return t.lines.map(l=>`<div class="rr">${rowBalls(g,l.main,l.extra,{fit:'fit'})}</div>`).join('')+(canUndo?`<button class="ibtn" style="margin:2px 0 6px" data-act="delticket" data-id="${t.id}">Undo this lock${t.dates.length>1?` (all ${t.dates.length} draws)`:''}</button>`:'')}).join('')}</div>`).join('');
  const past=resultsByDate(g).slice(0,8);
  if(past.length)h+=`<h3>Results</h3>`+past.map(r=>`<div class="ent"><div class="eh"><span>${shortDate(r.date)}</span><span class="${r.wins.length?'won':'muted small'}">${r.wins.length?(r.total>0?moneyWin(r.total):'')+(r.unknown?(r.total>0?' + ':'')+'amount to follow':''):'No win'}</span></div>${r.wins.map(w=>`<div class="small">Line ${w.lineNo}${w.round?`, ${w.round}`:''}: matched ${winTxt(g,w)}${w.known?` — ${moneyWin(w.amount)}`:''}</div>`).join('')}</div>`).join('');
  return h+`</div>`;
}
function viewGen(embedded){
  const g=G(),ds=draws();if(!ds.length)return noData();
  let h=`<div class="card" style="margin-top:22px"><h2>Low-popularity lines</h2><p class="small muted" style="margin-top:0">Random lines, steered away from patterns lots of people pick. Same odds of winning — just less chance of sharing.</p>
  <div class="tog"><span>Avoid the last draw's numbers<div class="small muted">Your rule: skip numbers from the last draw (${g.key==='lotto'?'Wed ↔ Sat, both rounds':'Tue ↔ Fri'})</div></span><label class="sw"><input type="checkbox" data-set="avoidLast" ${settings.avoidLast?'checked':''}><span></span></label></div>
  <label class="f">Lines</label><div class="chips">${[1,2,3,4,5].map(n=>`<button class="chip ${settings.genLines===n?'on':''}" data-lines="${n}">${n}</button>`).join('')}</div>
  <button class="btn block" style="margin-top:14px" data-act="spin">🎲 Spin the machine</button></div>`;
  state.gen.forEach((l,i)=>{h+=`<div class="card"><div class="row" style="justify-content:space-between;margin-bottom:10px"><b>Line ${i+1}</b><span class="pill p-${l.p.band}">${l.p.score}/100</span></div>${rowBalls(g,l.main,l.extra,{anim:l.fresh})}
  <div class="row" style="margin-top:12px"><button class="btn ghost" data-act="checkgen" data-i="${i}">Check →</button><button class="btn ghost" data-act="keepgen" data-i="${i}">⭐ Save to my lines</button></div></div>`;l.fresh=false});
  return h;
}

function viewStats(){
  const g=G(),all=draws();if(!all.length)return noData();
  const wins={all:all.length,'100':100,'26':26},ds=all.slice(0,Math.min(all.length,wins[state.statWin]));
  const pool=g.sepPool?state.statPool:'main',N=pool==='extra'?g.extraMax:g.mainMax,k=pool==='extra'?g.extra:g.main,n=ds.length;
  const cnt=Array(N+1).fill(0),since=Array(N+1).fill(null);
  all.forEach((d,i)=>{(pool==='extra'?d.extra:d.main).forEach(x=>{if(since[x]===null)since[x]=i})});
  ds.forEach(d=>(pool==='extra'?d.extra:d.main).forEach(x=>cnt[x]++));
  const nums=[...Array(N).keys()].map(i=>i+1),mx=Math.max(...nums.map(x=>cnt[x])),mn=Math.min(...nums.map(x=>cnt[x]));
  const order=state.statSort==='freq'?[...nums].sort((a,b)=>cnt[b]-cnt[a]||a-b):nums;
  const isStar=pool==='extra';
  const exp=n*k/N;
  let x2=0;nums.forEach(x=>x2+=(cnt[x]-exp)**2/exp);x2*=(N-1)/(N-k);const df=N-1,pv=chiP(x2,df);
  const hot=[...nums].sort((a,b)=>cnt[b]-cnt[a]).slice(0,5),cold=[...nums].sort((a,b)=>cnt[a]-cnt[b]).slice(0,5);
  const absent=[...nums].sort((a,b)=>(since[b]??1e9)-(since[a]??1e9)).slice(0,5);
  let h=`<div class="card"><div class="chips">${[['all','All '+all.length],['100','Last 100'],['26','Last 26']].map(([v,l])=>`<button class="chip ${state.statWin===v?'on':''}" data-win="${v}">${l}</button>`).join('')}</div>
  ${g.sepPool?`<div class="chips" style="margin-top:8px">${[['main','Main balls'],['extra','Lucky Stars']].map(([v,l])=>`<button class="chip ${pool===v?'on':''}" data-pool="${v}">${l}</button>`).join('')}</div>`:''}
  <div class="note">${n} draws${state.statWin==='all'?' since '+fmtDate(g.since)+' (current format)':''}. Expected per ${isStar?'star':'number'}: ${exp.toFixed(1)}.</div></div>`;
  if(!isStar&&!settings.demo)h+=crowdCard(g,ds);
  h+=`<div class="card"><h2>Is it random?</h2><div class="row" style="justify-content:space-between"><span class="pill ${pv>.05?'p-low':pv>.01?'p-med':'p-high'}">${pv>.05?'Looks random':pv>.01?'Slightly unusual':'Unusual spread'}</span><span class="muted small">χ² ${x2.toFixed(1)} · df ${df} · p ${pv<.001?'<0.001':pv.toFixed(3)}</span></div>
  <p class="small" style="margin-bottom:0">${pv>.05?`The ups and downs between numbers are about what pure chance produces. “Hot” and “cold” numbers are just noise.`:`The spread is a bit lumpier than chance usually gives. With small windows that happens now and then — it isn't a signal to bet on.`}</p></div>`;
  h+=`<div class="card"><h2>Hot & cold</h2><h3>Most drawn</h3>${lineBalls(g,isStar?[]:hot,[],{sm:true})}${isStar?`<div class="balls">${hot.map(x=>ball(x,g,{star:true,sm:true})).join('')}</div>`:''}<div class="note">${hot.map(x=>`${x}: ${cnt[x]}`).join(' · ')}</div>
  <h3>Least drawn</h3>${isStar?`<div class="balls">${cold.map(x=>ball(x,g,{star:true,sm:true})).join('')}</div>`:lineBalls(g,cold,[],{sm:true})}<div class="note">${cold.map(x=>`${x}: ${cnt[x]}`).join(' · ')}</div>
  <h3>Longest absent</h3>${isStar?`<div class="balls">${absent.map(x=>ball(x,g,{star:true,sm:true})).join('')}</div>`:lineBalls(g,absent,[],{sm:true})}<div class="note">${absent.map(x=>`${x}: ${since[x]??'—'} draws ago`).join(' · ')}</div>
  <div class="note">A fun look back — none of this changes the next draw.</div></div>`;
  h+=`<div class="card"><div class="row" style="justify-content:space-between"><h2 style="margin:0">Every ${isStar?'star':'number'}</h2><div class="chips">${[['num','1→'+N],['freq','By count']].map(([v,l])=>`<button class="chip ${state.statSort===v?'on':''}" data-sort="${v}">${l}</button>`).join('')}</div></div>
  <div class="fgrid" style="margin-top:12px">${order.map(x=>`<div class="fcell">${isStar?ball(x,g,{star:true,sm:true}):ball(x,g,{sm:true})}<span>${cnt[x]}</span><div class="fbar"><i style="width:${mx===mn?50:((cnt[x]-mn)/(mx-mn)*100)}%"></i></div></div>`).join('')}</div></div>`;
  if(!isStar){
    const odd=Math.ceil(g.mainMax/2),even=g.mainMax-odd,tot=comb(g.mainMax,g.main),oc=Array(g.main+1).fill(0);
    ds.forEach(d=>oc[d.main.filter(v=>v%2).length]++);
    const rows=oc.map((c,j)=>({j,obs:c/n*100,exp:comb(odd,j)*comb(even,g.main-j)/tot*100}));
    const top=Math.max(...rows.map(r=>Math.max(r.obs,r.exp)));
    h+=`<div class="card"><h2>Odd / even split</h2><div class="bars">${rows.map(r=>`<div class="b"><span>${r.j} odd</span><div class="t"><i style="width:${r.obs/top*100}%"></i><u style="left:${r.exp/top*100}%"></u></div><span class="small">${r.obs.toFixed(0)}%</span></div>`).join('')}</div><div class="note">Bars = what happened. White marks = what chance predicts.</div></div>`;
  }
  return h;
}

function storeNote(){
  const st=Object.values(GAMES).map(g=>({g,s:state.meta[g.key]?.store}));
  if(!st.some(x=>x.s))return `Calls made directly from this device this month: <b>${callsThisMonth()}</b>.`;
  const when=t=>t?new Date(t).toLocaleString('en-GB',{weekday:'short',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}):'never';
  return `<br>Results come from your Worker, which fetches them itself after each draw (about 35 API calls a month). Opening the app or tapping <b>Get latest</b> costs no API calls.`+
    st.map(({g,s})=>!s?'':`<br>${g.name}: ${s.count} draws stored, last fetched ${when(s.updatedAt)}${s.lastRun&&!s.lastRun.ok?` · <span style="color:var(--warn)">last attempt failed (${s.lastRun.error}) — it'll retry at the next scheduled run</span>`:''}`).join('');
}
function viewSettings(){
  const esc=s=>String(s).replace(/[&"<>]/g,c=>({'&':'&amp;','"':'&quot;','<':'&lt;','>':'&gt;'}[c]));
  return `<div class="card"><h2>Data</h2>
  <div class="tog"><span>Use sample data<div class="small muted">Simulated draws for trying things out</div></span><label class="sw"><input type="checkbox" data-set="demo" ${settings.demo?'checked':''}><span></span></label></div>
  <label class="f">Worker URL</label><input type="url" id="wurl" placeholder="https://your-proxy.yourname.workers.dev" value="${esc(settings.workerUrl)}">
  <div class="row" style="margin-top:10px"><button class="btn ghost" data-act="saveurl">Save</button>${settings.freePlan?'':'<button class="btn ghost" data-act="syncfull">Sync all history</button>'}<button class="btn ghost" data-act="sync">Get latest</button></div>
  <div class="note">${state.meta.remaining?`API calls left: <b>${state.meta.remaining.n}</b>${state.meta.remaining.limit?' / '+state.meta.remaining.limit:''} (as of ${new Date(state.meta.remaining.at).toLocaleString('en-GB',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}). The free plan allows 100 a month and one month of history. `:''}${storeNote()}</div></div>
  <div class="card"><h2>Lotto</h2><div class="tog"><span>Bonus ball counts as drawn<div class="small muted">For My lines: if the bonus is one of your numbers, it gets swapped too</div></span><label class="sw"><input type="checkbox" data-set="bonusCounts" ${settings.bonusCounts?'checked':''}><span></span></label></div></div>
  <div class="card"><h2>EuroMillions</h2><label class="f">“Worth winning” threshold (£)</label><input type="number" inputmode="numeric" id="worth" value="${settings.worthIt}"><button class="btn ghost" style="margin-top:10px" data-act="saveworth">Save</button></div>
  <div class="card"><h2>Backup</h2><p class="small muted" style="margin-top:0">Saves your stored results, lines and settings to a file. Restoring merges it in, so nothing already here is lost — handy for moving between Chrome and Firefox.</p>
  <div class="row"><button class="btn ghost" data-act="backup">⬇️ Back up</button><button class="btn ghost" data-act="restore">⬆️ Restore</button></div>
  <input type="file" id="restoreFile" accept=".json,application/json" style="display:none">
  <div class="note">${LS.get('lastBackup',0)?'Last backup: '+new Date(LS.get('lastBackup',0)).toLocaleString('en-GB',{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}):'Not backed up yet.'} Stored: ${state.live.lotto.length} Lotto and ${state.live.euromillions.length} EuroMillions draws.</div></div>
  <div class="card"><h2>About</h2><p class="small muted" style="margin-top:0">Oddly v${APP_VERSION}. Statistics are for entertainment — every line has the same chance in every draw. Please play responsibly.</p><p class="small muted">Not affiliated with the National Lottery or its operator.</p><button class="btn ghost" data-act="wipe">Clear stored results</button></div>`;
}

function render(){
  renderHeader();renderNav();
  const v={latest:viewLatest,check:viewCheck,gen:viewLines,stats:viewStats,settings:viewSettings}[state.view];
  $('#view').innerHTML=v();
}

/* ---------- Events ---------- */
document.addEventListener('click',async e=>{
  const t=e.target.closest('[data-game],[data-view],[data-pick],[data-act],[data-lines],[data-win],[data-pool],[data-sort],[data-grp]');if(!t)return;
  if(t.dataset.grp){const k=t.dataset.grp;state.open.has(k)?state.open.delete(k):state.open.add(k);const y=scrollY;render();scrollTo(0,y);return}
  const g=G(),ds=draws();
  if(t.dataset.game){state.game=t.dataset.game;LS.set('game',state.game);state.pick={main:new Set(),extra:new Set()};state.gen=[];state.statPool='main';state.editing=null}
  else if(t.dataset.view){state.view=t.dataset.view;state.editing=null;scrollTo(0,0)}
  else if(t.dataset.pick){const pool=t.dataset.pick,n=+t.dataset.n,s=state.pick[pool],lim=pool==='main'?g.main:g.extra;
    if(s.has(n))s.delete(n);else if(s.size<lim)s.add(n);else{toast(`That's ${lim} already — tap one to remove it`);return}
    const y=scrollY;render();scrollTo(0,y);if(state.pick.main.size===g.main&&(!g.sepPool||state.pick.extra.size===g.extra))setTimeout(()=>document.querySelectorAll('.card')[1]?.scrollIntoView({behavior:'smooth'}),50);return}
  else if(t.dataset.lines){settings.genLines=+t.dataset.lines;saveSettings()}
  else if(t.dataset.win){state.statWin=t.dataset.win}
  else if(t.dataset.pool){state.statPool=t.dataset.pool}
  else if(t.dataset.sort){state.statSort=t.dataset.sort}
  else{const a=t.dataset.act;
    if(a==='clearpick')state.pick={main:new Set(),extra:new Set()};
    if(a==='randpick')state.pick={main:new Set(pickDistinct(rand,g.main,g.mainMax)),extra:new Set(g.sepPool?pickDistinct(rand,g.extra,g.extraMax):[])};
    if(a==='spin'){state.gen=Array.from({length:settings.genLines},()=>({...generate(g,ds),fresh:true}))}
    if(a==='checkgen'){const l=state.gen[+t.dataset.i];state.pick={main:new Set(l.main),extra:new Set(l.extra)};state.view='check';render();setTimeout(()=>document.querySelectorAll('.card')[1]?.scrollIntoView({behavior:'smooth'}),50);return}
    const L=myLines[g.key],li=+t.dataset.i,toCheck=()=>{state.view='check';render();scrollTo(0,0)};
    if(a==='lockopen'){const up=upcomingDates(g);state.lock={sel:new Set(L.map((_,i)=>i)),dates:new Set(up.slice(0,1))};render();scrollTo(0,0);return}
    if(a==='lockcancel')state.lock=null;
    if(a==='locksel'){state.lock.sel.has(li)?state.lock.sel.delete(li):state.lock.sel.add(li);const y=scrollY;render();scrollTo(0,y);return}
    if(a==='lockdate'){const d=t.dataset.d;state.lock.dates.has(d)?state.lock.dates.delete(d):state.lock.dates.add(d);const y=scrollY;render();scrollTo(0,y);return}
    if(a==='lockgo'){const lk=state.lock;if(!lk.sel.size||!lk.dates.size){toast('Pick at least one line and one draw');return}
      tickets[g.key].push({id:Date.now().toString(36)+Math.random().toString(36).slice(2,6),lines:[...lk.sel].sort((x,y)=>x-y).map(i=>({main:[...L[i].main],extra:[...(L[i].extra||[])]})),dates:[...lk.dates].sort(),at:new Date().toISOString()});
      saveTickets();state.lock=null;toast(`🔒 Locked in for ${[...lk.dates].sort().map(shortDate).join(', ')}`)}
    if(a==='delticket'){const T=tickets[g.key],ix=T.findIndex(x=>x.id===t.dataset.id);
      if(ix>=0&&T[ix].dates.every(stillOpen)&&confirm('Undo this lock? Use this only if you locked something by mistake.')){T.splice(ix,1);saveTickets();toast('Lock removed')}}
    if(a==='seen'){seen.add(t.dataset.k);saveSeen()}
    if(a==='addline'){if(L.length>=MAX_LINES){toast(`Up to ${MAX_LINES} lines`);return}state.editing=-1;state.pick={main:new Set(),extra:new Set()};toCheck();return}
    if((a==='editline'||a==='delline'||a==='acceptline')&&lockedDates(g,L[li]).length){toast('That line is locked in');return}
    if(a==='editline'||a==='checkline'){state.editing=a==='editline'?li:null;state.pick={main:new Set(L[li].main),extra:new Set(L[li].extra)};toCheck();return}
    if(a==='delline'){if(!confirm(`Delete Line ${li+1}?`))return;L.splice(li,1);saveLines()}
    if(a==='acceptline'){const s=L[li].sugg;if(s&&!s.none){L[li]={main:s.main,extra:s.extra};saveLines();toast('Line updated ✨')}}
    if(a==='rerollline'){delete L[li].sugg;saveLines()}
    if(a==='keepgen'){const l=state.gen[li];if(L.length>=MAX_LINES){toast(`Up to ${MAX_LINES} lines`);return}L.push({main:l.main,extra:l.extra});saveLines();toast(`Saved as Line ${L.length}`)}
    if(a==='saveline'){
      const line={main:[...state.pick.main].sort((x,y)=>x-y),extra:[...state.pick.extra].sort((x,y)=>x-y)};
      if(state.editing!=null&&state.editing>=0){L[state.editing]=line;toast(`Line ${state.editing+1} updated`)}
      else{if(L.length>=MAX_LINES){toast(`Up to ${MAX_LINES} lines`);return}L.push(line);toast(`Saved as Line ${L.length}`)}
      saveLines();state.editing=null;state.view='gen';scrollTo(0,0);
    }
    if(a==='backup'){exportBackup();render();return}
    if(a==='restore'){$('#restoreFile').click();return}
    if(a==='saveurl'){settings.workerUrl=$('#wurl').value.trim();saveSettings();toast('Saved')}
    if(a==='saveworth'){const v=+$('#worth').value;if(v>0){settings.worthIt=v;saveSettings();toast('Saved')}}
    if(a==='sync'||a==='syncfull'){settings.workerUrl=$('#wurl')?.value.trim()||settings.workerUrl;saveSettings();toast('Fetching…');await syncAll(a==='syncfull');return}
    if(a==='wipe'){if(!confirm('Clear stored live results? You\'ll need to sync again.'))return;for(const k of Object.keys(GAMES)){state.live[k]=[];await DB.set('draws_'+k,[])}state.meta={};LS.set('meta',{});toast('Cleared')}
  }
  render();
});
document.addEventListener('change',e=>{
  if(e.target.id==='restoreFile'){const f=e.target.files[0];if(f)importBackup(f);e.target.value='';return}
  const k=e.target.dataset.set;if(!k)return;settings[k]=e.target.checked;saveSettings();
  if(k==='demo'){state.gen=[];if(!settings.demo&&!draws().length)toast('Add your worker URL, then tap “Get latest”')}render()});

/* ---------- Boot ---------- */
(async()=>{
  await DB.open();
  for(const k of Object.keys(GAMES))state.live[k]=(await DB.get('draws_'+k))||[];
  render();
  maybeAutoSync();
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')maybeAutoSync()});
  if('serviceWorker' in navigator)try{navigator.serviceWorker.register('sw.js')}catch(e){}
})();
