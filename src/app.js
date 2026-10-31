'use strict';
const APP_VERSION='1.3.0';

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

// Built in so a fresh install shows real results straight away. Not a secret: the Worker only answers
// browser requests from the Bean Machine address, and reading the stored history costs no API calls.
const DEFAULT_WORKER='https://lotto-lab-proxy.wayne-lee-paul-reynolds.workers.dev';
const settings=Object.assign({workerUrl:DEFAULT_WORKER,demo:false,avoidLast:true,worthIt:50000000,genLines:3,freePlan:true,bonusCounts:true},LS.get('settings',{}));
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
function toast(msg,ms=2600){const t=$('#toast');t.textContent=msg;t.classList.add('show');clearTimeout(t._h);t._h=setTimeout(()=>t.classList.remove('show'),ms)}
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
  // A weak signal can stall a request for minutes, so give up after 20 seconds and say so
  const ac=typeof AbortController==='function'?new AbortController():null,timer=ac&&setTimeout(()=>ac.abort(),20e3);
  let r;
  try{r=await fetch(settings.workerUrl.replace(/\/$/,'')+path,ac?{signal:ac.signal}:undefined)}
  catch(e){throw new Error(ac?.signal.aborted?'No answer — the signal may be too weak':navigator.onLine===false?'No connection':'Couldn\'t reach the results service')}
  finally{clearTimeout(timer)}
  if(costsCall)bumpCalls();
  const j=await r.json().catch(()=>({}));
  if(j.remaining!=null){state.meta.remaining={n:j.remaining,limit:j.limit,at:j.rateAt?Date.parse(j.rateAt):Date.now()};LS.set('meta',state.meta)}
  if(!r.ok)throw new Error(j.error||('HTTP '+r.status));return j;
}
// Delta sync: once the phone holds a game's history, ask only for draws from 40 days before the newest one it has.
// That window covers late prize breakdowns and jackpot corrections (the API's free plan only reaches back about a
// month). `rev` is the import revision the phone last saw; if the Worker's import has changed it sends everything.
const DELTA_DAYS=40;
function historyQuery(g,full){
  const last=(state.live[g.key]||[])[0]?.date,rev=state.meta[g.key]?.store?.rev;
  // With a Stats code, the Worker also says whether this phone may still see Stats
  const acc=statsAccess.code?`&code=${encodeURIComponent(statsAccess.code)}&device=${deviceId()}`:'';
  if(full||!last||rev==null)return `/history?game=${g.key}${acc}`;
  const d=new Date(last+'T12:00:00');d.setDate(d.getDate()-DELTA_DAYS);
  return `/history?game=${g.key}&since=${iso(d)}&rev=${encodeURIComponent(rev)}${acc}`;
}
/* ---------- Stats access ----------
   Stats are locked until a tester enters their code. The Worker ties each code to at most two phones and,
   at each sync, says whether this phone is still allowed (so a code removed in Cloudflare locks again).
   Not real security (the code is public), just a stop on casual sharing. */
const statsAccess=Object.assign({code:'',ok:false},LS.get('statsAccess',{}));
const saveStatsAccess=()=>LS.set('statsAccess',statsAccess);
function deviceId(){
  let id=LS.get('deviceId','');
  if(!/^[A-Za-z0-9_-]{16,64}$/.test(id)){id=[...crypto.getRandomValues(new Uint8Array(16))].map(b=>b.toString(16).padStart(2,'0')).join('');LS.set('deviceId',id)}
  return id;
}
const statsUnlocked=()=>statsAccess.ok===true;
async function unlockStats(code){
  code=String(code||'').trim().toUpperCase();
  if(!code){toast('Type your code first');return}
  if(!settings.workerUrl){toast('No results service set up');return}
  let r;
  try{r=await api(`/unlock?code=${encodeURIComponent(code)}&device=${deviceId()}`,false)}
  catch(e){toast("Couldn't check the code. Are you online?");return}
  if(r.ok){statsAccess.code=code;statsAccess.ok=true;saveStatsAccess();toast('Stats unlocked ✨');render();return}
  toast(r.reason==='full'?'That code is already in use on other phones':'That code isn\'t recognised');
}
function lockedStats(){
  return `<div class="card locked"><h2>🔒 Stats</h2><p>Ten years of draws, put to the test: is it random, hot and cold numbers, draw days, “overdue” numbers, crowd watch and more.</p><p class="small muted">Stats are for invited testers for now. If you've been given a code, enter it here.</p>
  <div class="row" style="gap:8px;margin-top:6px;flex-wrap:nowrap"><input type="text" id="statscode" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX" style="flex:1;min-width:0;width:auto;text-transform:uppercase;letter-spacing:1px;font-size:16px"><button class="btn" data-act="unlockstats">Unlock</button></div></div>`;
}
async function syncGame(g,full){
  // Preferred: the Worker's stored history (built up by its schedule). Costs no API calls.
  try{
    const r=await api(historyQuery(g,full),false);
    const map=new Map(state.live[g.key].map(d=>[dKey(d),d]));
    (r.draws||[]).forEach(d=>{if(valid(g,d))map.set(dKey(d),d)});
    state.live[g.key]=sortDraws([...map.values()]);
    await DB.set('draws_'+g.key,state.live[g.key]);
    if(typeof r.stats==='boolean'&&statsAccess.code&&r.stats!==statsAccess.ok){statsAccess.ok=r.stats;saveStatsAccess()}
    state.meta[g.key]={lastSync:Date.now(),nextJackpot:r.nextJackpot??state.meta[g.key]?.nextJackpot??null,store:{updatedAt:r.updatedAt,lastRun:r.lastRun,count:r.apiCount??(r.draws||[]).length,imported:r.imported||null,rev:r.rev??null}};
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
  state.syncing=true;state.syncError=null;if(!draws().length)render();else renderHeader();
  try{for(const g of Object.values(GAMES))await syncGame(g,full);if(!quiet)toast('Results updated ✨')}
  catch(e){if(!quiet)toast('Update failed: '+e.message);state.syncError=e.message}
  state.syncing=false;render();
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
const BACKUP_APPS=['beanmachine','oddly','lotto-lab'];
function exportBackup(){
  const data={app:'beanmachine',version:1,exported:new Date().toISOString(),
    draws:{lotto:state.live.lotto,euromillions:state.live.euromillions},lines:myLines,tickets,seen:[...seen],
    settings:{workerUrl:settings.workerUrl,worthIt:settings.worthIt,freePlan:settings.freePlan,bonusCounts:settings.bonusCounts,avoidLast:settings.avoidLast}};
  const blob=new Blob([JSON.stringify(data)],{type:'application/json'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`beanmachine-backup-${iso(new Date())}.json`;
  document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),5000);
  LS.set('lastBackup',Date.now());toast('Backup saved to Downloads');
}
async function importBackup(file){
  let data;try{data=JSON.parse(await file.text())}catch(e){toast('That file isn\'t a Bean Machine backup');return}
  // 'oddly' and 'lotto-lab' = backups made under the app's earlier names (Oct 2026)
  if(!BACKUP_APPS.includes(data?.app)||!data.draws){toast('That file isn\'t a Bean Machine backup');return}
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
  // A backup's own Worker wins over the built-in one, but never over one typed in on this phone
  if((!settings.workerUrl||settings.workerUrl===DEFAULT_WORKER)&&bs.workerUrl)settings.workerUrl=bs.workerUrl;
  for(const k of ['worthIt','freePlan','bonusCounts','avoidLast'])if(bs[k]!=null)settings[k]=bs[k];
  if(state.live.lotto.length||state.live.euromillions.length)settings.demo=false;
  saveSettings();render();
  toast(`Restored: ${addedD} new draws, ${addedL} new lines, ${addedT} entries`);
}

/* ---------- Story: the bean machine ----------
   A Galton board: balls drop through rows of pegs, bouncing left or right at random, and pile up in bins.
   No single ball can be predicted, yet together they always build the same bell-shaped curve. */
const BM={rows:9,dx:26,dy:19,y0:70,cx:160,binTop:232,binBot:292,r:4,max:7};
const BM_COLS=['#2f86ff','#ff5fa8','#33cc66','#ffd431','#a066ff','#f3f3f8'];
const BEAN_D='M0,-9C8,-11 13,-4 11,4C9,11 0,12 -5,8C-9,5 -5,1 -8,-3C-10,-7 -6,-8 0,-9Z';
// One ball's journey: an L/R choice at each row of pegs. The bin is the number of rights (0..rows).
function galtonPath(rows,rng){return Array.from({length:rows},()=>rng()<.5?-1:1)}
const galtonBin=(rows,rng)=>galtonPath(rows,rng).filter(d=>d>0).length;
const bmBinX=k=>BM.cx+(k-BM.rows/2)*BM.dx;
const bmStackY=h=>BM.binBot-BM.r-h*(2*BM.r+.5);
let bm={counts:Array(BM.rows+1).fill(0),settled:[],live:[],n:0,last:0,run:0,fade:0};
function beanMachineSVG(){
  const {rows,dx,dy,y0,cx,binTop,binBot}=BM;let pegs='',walls='';
  for(let r=0;r<rows;r++)for(let k=0;k<=r;k++)pegs+=`<circle class="bm-peg" cx="${cx+(k-r/2)*dx}" cy="${y0+r*dy}" r="2.6"/>`;
  for(let k=0;k<=rows+1;k++){const x=bmBinX(k)-dx/2;walls+=`<line class="bm-wall" x1="${x}" y1="${binTop}" x2="${x}" y2="${binBot}"/>`}
  // Expected shape (binomial), scaled so the tallest bin is just under full
  const pk=k=>comb(rows,k)/2**rows,peak=pk(Math.floor(rows/2));
  const curve=Array.from({length:rows+1},(_,k)=>`${bmBinX(k)},${(bmStackY(pk(k)/peak*(BM.max-1))-BM.r).toFixed(1)}`).join(' ');
  const grads=BM_COLS.map((c,i)=>`<radialGradient id="bmg${i}" cx="35%" cy="30%" r="70%"><stop offset="0" stop-color="#fff"/><stop offset=".25" stop-color="${c}"/><stop offset="1" stop-color="${c}" stop-opacity=".75"/></radialGradient>`).join('');
  return `<svg id="beanm" class="bm" viewBox="0 0 320 300" role="img" aria-label="A bean machine: balls dropping through pegs and piling into a bell curve">
  <defs>${grads}<linearGradient id="bmgold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffe48a"/><stop offset="1" stop-color="#e0a420"/></linearGradient></defs>
  <path class="bm-hopper" d="M${cx-42},16 L${cx+42},16 L${cx+9},48 L${cx-9},48 Z"/>
  <g class="bm-mascot" transform="translate(${cx+58},26)"><g class="bm-wobble"><path d="${BEAN_D}" fill="url(#bmgold)" stroke="#a8730f" stroke-width="1"/>
    <circle cx="-2" cy="-2" r="1.6" fill="#3a2300"/><circle cx="4" cy="-3" r="1.6" fill="#3a2300"/><path d="M-2,3 Q1.5,6 5,2" fill="none" stroke="#3a2300" stroke-width="1.3" stroke-linecap="round"/></g></g>
  ${pegs}<g class="bm-walls">${walls}<line class="bm-wall" x1="${bmBinX(0)-dx/2}" y1="${binBot}" x2="${bmBinX(rows)+dx/2}" y2="${binBot}"/></g>
  <polyline class="bm-curve" points="${curve}"/>
  <g id="bm-settled"></g><g id="bm-live"></g></svg>`;
}
function bmShape(x,y,ci,bean,rot=0){
  return bean
    ?`<path d="${BEAN_D}" transform="translate(${x.toFixed(1)},${y.toFixed(1)}) rotate(${rot.toFixed(0)}) scale(.5)" fill="url(#bmgold)" stroke="#a8730f" stroke-width="1.5"/>`
    :`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${BM.r}" fill="url(#bmg${ci})"/>`;
}
// Where a ball is, t ms after it was dropped (null once it has landed)
function bmPos(b,t){
  const seg=105,{rows,dx,dy,y0,cx}=BM,s=t/seg;
  if(s<1)return{x:cx,y:40+(y0-7-40)*s};
  let x=cx,i=Math.floor(s-1),p=(s-1)-i;
  if(i<rows){for(let j=0;j<i;j++)x+=b.path[j]*dx/2;
    const x1=x+b.path[i]*dx/2,yA=y0-7+i*dy,e=p*p*(3-2*p);
    return{x:x+(x1-x)*e,y:yA+dy*p-Math.sin(Math.PI*p)*5};}
  const yA=y0-7+rows*dy,yB=bmStackY(b.h),fall=Math.max(1,(yB-yA)/BM.dy),q=(s-1-rows)/fall;
  return q>=1?null:{x:bmBinX(b.k),y:yA+(yB-yA)*q*q};
}
function bmDrawSettled(){const g=document.getElementById('bm-settled');if(g)g.innerHTML=bm.settled.map(b=>bmShape(bmBinX(b.k),bmStackY(b.h),b.ci,b.bean,b.rot)).join('')}
function bmTick(now){
  const live=document.getElementById('bm-live');if(!live)return false;
  if(bm.fade&&now>bm.fade){bm.fade=0;bm.counts.fill(0);bm.settled=[];bmDrawSettled();document.getElementById('bm-settled').style.opacity=1}
  if(!bm.fade&&now-bm.last>240&&bm.live.length<9){
    bm.last=now;const path=galtonPath(BM.rows,rand),k=path.filter(d=>d>0).length;
    bm.live.push({path,k,h:bm.counts[k]++,t0:now,ci:bm.n%BM_COLS.length,bean:bm.n%13===12,rot:rand()*360});bm.n++;
  }
  let html='';
  bm.live=bm.live.filter(b=>{const p=bmPos(b,now-b.t0);if(!p){bm.settled.push(b);bmDrawSettled();return false}
    html+=bmShape(p.x,p.y,b.ci,b.bean,b.rot+(now-b.t0)*.4);return true});
  live.innerHTML=html;
  if(!bm.fade&&bm.counts.some(c=>c>=BM.max)){bm.fade=now+1800;const g=document.getElementById('bm-settled');g.style.opacity=.15}
  return true;
}
// A finished pile for reduced motion: the expected shape, drawn once
function bmStatic(){
  const {rows}=BM,peak=comb(rows,Math.floor(rows/2));bm.settled=[];let n=0;
  for(let k=0;k<=rows;k++){const c=Math.round(comb(rows,k)/peak*(BM.max-1));for(let h=0;h<c;h++)bm.settled.push({k,h,ci:n%BM_COLS.length,bean:n++===17,rot:30})}
  bmDrawSettled();
}
function startBeanMachine(){
  const svg=document.getElementById('beanm');if(!svg)return;
  const run=++bm.run;bm.live=[];bm.counts=Array(BM.rows+1).fill(0);bm.settled.forEach(b=>bm.counts[b.k]=Math.max(bm.counts[b.k],b.h+1));
  if(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches){bmStatic();return}
  bmDrawSettled();
  const loop=t=>{if(run!==bm.run||!bmTick(t))return;requestAnimationFrame(loop)};
  requestAnimationFrame(loop);
}
function viewStory(){
  return `<div class="card story"><h2>The bean machine</h2>${beanMachineSVG()}
  <p class="small muted cap">Every ball bounces left or right at random. You can't predict one — but together they always build the same curve.</p></div>
  <div class="card story">
  <h3>Where it comes from</h3>
  <p>In the 1870s the Victorian scientist Francis Galton built a board covered in pegs. Drop a ball in at the top and it bounces left or right at every peg, completely by chance, before landing in a slot at the bottom. It's known as a Galton board, or a <b>bean machine</b>, because the early ones used beans.</p>
  <p>Nobody can say where the next ball will land. But drop a few hundred and they pile up into the same bell-shaped curve every single time. Randomness is unpredictable one at a time, and remarkably predictable in bulk.</p>
  <h3>What it means for the lottery</h3>
  <p>Each draw is one ball. It has no memory, so no number is ever “due”, and every line has exactly the same chance. Over hundreds of draws the counts settle down around the average, just like the bins. The <b>Stats</b> page checks that with a proper test, so you can see the machine is fair for yourself.</p>
  <h3>What you <i>can</i> change</h3>
  <p>Not your chance of winning — but who you'd share with. People don't choose at random: birthdays, patterns and lucky numbers make some lines very crowded. This app measures what players actually pick, using real winner counts, and helps you steer clear of the crowd. If your numbers do come up, there should be fewer people to split the prize with.</p>
  <h3>And the bean?</h3>
  <p>Every so often a bean drops instead of a ball, in honour of the original machine. It has exactly the same chance as everything else. That's rather the point.</p>
  <p class="note">Statistics for entertainment, not a way to win. 18+ only. Please play responsibly. Not affiliated with the National Lottery or its operator.</p>
  </div>`;
}

/* ---------- Views ---------- */
function renderHeader(){
  const g=G(),ds=draws();let badge;
  if(settings.demo)badge=`<span class="badge demo">✨ SAMPLE DATA — not real results</span>`;
  else if(!ds.length)badge=`<span class="badge">${state.syncing?'Fetching results…':settings.workerUrl?'No results yet':'No results yet — add your worker in Settings'}</span>`;
  else{
    const t=state.meta[g.key]?.lastSync,when=t?new Date(t).toLocaleString('en-GB',{weekday:'short',hour:'2-digit',minute:'2-digit'}):'';
    if(state.syncing)badge=`<span class="badge">Live · ${ds.length} draws · checking for new results…</span>`;
    else if(state.syncError)badge=`<span class="badge warn">⚠️ Couldn't update · showing results${when?' from '+when:' saved on this phone'}</span>`;
    else badge=`<span class="badge">Live · ${ds.length} draws${when?' · updated '+when:''}</span>`;
  }
  const sp=[[8,20,0],[78,14,.8],[90,52,1.6],[55,8,1.2],[30,60,2]].map(([l,t,d])=>`<i class="spark" style="left:${l}%;top:${t}px;animation-delay:${d}s"></i>`).join('');
  const pk=partyToday(),deco=partyHeaderHTML(pk);$('#hdr').classList.toggle('party-hdr',!!deco);
  $('#hdr').innerHTML=`${deco}${sp}<button class="hstory${state.view==='story'?' on':''}" data-view="story" aria-label="The story">📖 Story</button><h1>Bean Machine ✦</h1><div class="sub">Stats for fun — every line has the same chance</div>
  <div class="seg">${Object.values(GAMES).map(x=>`<button data-game="${x.key}" class="${x.key===g.key?'on':''}">${x.name}</button>`).join('')}</div>${badge}`;
}
function renderNav(){
  const items=[['latest','🎱','Latest'],['check','🔍','Check'],['gen','🎟️','My lines'],['stats','📊','Stats'],['settings','⚙️','Settings']];
  $('#nav').innerHTML=items.map(([k,i,l])=>`<button data-view="${k}" class="${state.view===k?'on':''}"><span>${i}</span>${l}</button>`).join('');
}
function noData(){
  if(state.syncing)return `${installBanner()}<div class="card"><h2>Fetching results…</h2><p class="muted">Downloading ten years of draws. This takes a few seconds the first time, then only new draws are fetched.</p></div>`;
  if(!settings.demo&&settings.workerUrl&&state.syncError)return `${installBanner()}<div class="card"><h2>Couldn't fetch results</h2><p class="muted">The results service didn't answer. Check you're online, then try again.</p><button class="btn" data-act="sync">Try again</button></div>`;
  return `${installBanner()}<div class="card"><h2>No results yet</h2><p class="muted">Turn on sample data, or add your worker URL in Settings and tap “Get latest”.</p></div>`;
}

function viewLatest(){
  const g=G(),ds=draws();if(!ds.length)return noData();
  const ib=installBanner();
  const d=ds[0],ls=lastSet(ds),nd=nextDraw(g),jp=settings.demo?d.jackpot:(state.meta[g.key]?.nextJackpot??d.jackpot);
  let jack='';
  if(jp!=null){
    const worth=g.key==='euromillions'?(jp>=settings.worthIt?`🔥 Over your ${money(settings.worthIt)} line — worth winning!`:`😴 Under your ${money(settings.worthIt)} “worth winning” line`):'';
    jack=`<div class="card jack"><div class="muted small">${settings.demo?'Sample jackpot':'Jackpot'}</div><div class="big">${money(jp)}</div>${worth?`<div style="margin-top:6px;font-weight:700">${worth}</div>`:''}</div>`;
  }
  const anim=state.animKey!==g.key+d.date;state.animKey=g.key+d.date;
  const lk='L'+g.key+d.date,lopen=state.open.has(lk);
  const meta=drawMeta;
  return `${ib}${bannerHTML()}${jack}<div class="card latest${lopen?' open':''}" data-grp="${lk}"><h2>${g.name} · ${fmtDate(d.date)}<span class="chev">▸</span></h2>${[...ls].reverse().map(x=>`${x.round?`<h3>${x.round}</h3>`:''}${rowBalls(g,x.main,x.extra,{fit:'fit-lg',anim})}${settings.demo?'':crowdLine(g,x)}${lopen&&(x.prizes||x.machine||x.ballSet||x.drawNo||(x.src&&x.src!=='api')||settings.demo)?`<div class="pb">${prizeTable(g,x)}${meta(x)}</div>`:''}`).join('')}
  ${nd?`<div class="note">Next draw: ${nd.toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'short'})}</div>`:''}</div>
  <div class="card"><h2>Recent draws</h2>${recentHTML(g,ds)}</div>`;
}
// Prize breakdown table for one draw/round, top tier first
function prizeMoney(v){if(!(v>0))return '—';if(v>=1e6)return money(v);return '£'+(v%1?v.toFixed(2):Math.round(v).toLocaleString('en-GB'))}
// Where a draw came from. Draws without `src` were stored before imports existed, so they came from the API.
const SRC_NAMES={lottometrics:'lottometrics.app','lotto-net':'lotto.net','national-lottery':'the official results download','euromillions-api':'a EuroMillions results API'};
function drawMeta(x){
  const bits=[];
  if(x.machine||x.ballSet)bits.push(`Machine ${x.machine??'?'} · Ball set ${x.ballSet??'?'}`);
  if(x.drawNo)bits.push(`Draw ${x.drawNo}`);
  if(x.src&&x.src!=='api')bits.push(`Imported from ${SRC_NAMES[x.src]||x.src}`);
  return bits.length?`<div class="meta">${bits.join(' · ')}</div>`:'';
}
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
    const detail=!open?'':rs.map(x=>`<div class="pb">${x.round?`<h4>${x.round}</h4>`:''}${settings.demo?'':crowdLine(g,x)}${prizeTable(g,x)}${drawMeta(x)}</div>`).join('');
    return `<div class="grp${open?' open':''}" data-grp="${g.key+dt}"><div class="dt"><span>${shortDate(dt)}<span class="chev">▸</span></span><span class="cws">${chips}</span></div>${rs.map(x=>x.round
      ?`<div class="rr"><span class="lbl">${x.round}</span>${rowBalls(g,x.main,x.extra,{fit:'fit'})}</div>`
      :`<div class="rr">${rowBalls(g,x.main,x.extra,{fit:'fit-md'})}</div>`).join('')}${detail}</div>`}).join('');
}

function pickerGrid(g,pool){
  const max=pool==='main'?g.mainMax:g.extraMax,sel=state.pick[pool];let h='';
  for(let n=1;n<=max;n++)h+=pool==='extra'?ball(n,g,{star:true,cls:sel.has(n)?'':'off',attr:`data-pick="extra" data-n="${n}"`}):ball(n,g,{cls:sel.has(n)?'':'off',attr:`data-pick="main" data-n="${n}"`});
  return `<div class="grid">${h}</div>`;
}
/* ---------- Play it for years: a fast, fair simulator on Check ---------- */
// One line played every draw for years. A £2 Lotto line enters both rounds; EuroMillions is £2.50 a line.
const SIM_PRICE={lotto:2,euromillions:2.5},SIM_ROUNDS={lotto:2,euromillions:1},SIM_PER_YEAR=365.2425*2/7;
const SIM_YEARS=[1,2,5,10,20,50,100,200,500,1000,2000,5000,10000,20000,50000,100000,200000,500000,1000000];
// Rough EuroMillions lower-tier prizes, only used until stored results have prize breakdowns
const SIM_EM_ROUGH={'5+1':150000,'5+0':20000,'4+2':900,'4+1':85,'4+0':35,'3+2':45,'3+1':8,'3+0':9,'2+2':11,'2+1':4.5,'2+0':3,'1+2':6.5};
const SIM_TIERS={lotto:[['6+0','6 (jackpot)'],['5+1','5 + bonus'],['5+0','5'],['4+0','4'],['3+0','3'],['2+0','2']],
  euromillions:[...EM_WIN].map(k=>[k,k==='5+2'?'5 + 2★ (jackpot)':k.replace('+',' + ')+'★'])};
const median=a=>{if(!a.length)return null;const b=[...a].sort((x,y)=>x-y),m=b.length>>1;return b.length%2?b[m]:(b[m-1]+b[m])/2};
// Prize per tier: Lotto's fixed prizes; EuroMillions' typical (median) prize from stored breakdowns. Jackpot = typical stored jackpot.
function simPrizes(g,ds){
  const jk=g.sepPool?'5+2':'6+0',out={},jacks=ds.map(d=>d.jackpot).filter(v=>v>0);
  out[jk]=median(jacks)||(g.sepPool?17e6:2e6);
  let rough=false;
  for(const [k] of SIM_TIERS[g.key]){if(k===jk)continue;
    if(!g.sepPool){out[k]=LOTTO_FIXED[k];continue}
    const v=median(ds.filter(d=>d.prizes).map(d=>prizeFor(g,d,k)).filter(x=>x&&x.known&&x.amount>0).map(x=>x.amount));
    if(v==null)rough=true;out[k]=v??SIM_EM_ROUGH[k];
  }
  return{p:out,rough,jk};
}
// Fair random numbers from the phone's secure generator, fetched in batches
const simRng=(()=>{const buf=new Uint32Array(4096);let i=4096;return()=>{if(i===4096){crypto.getRandomValues(buf);i=0}return buf[i++]/4294967296}})();
function simPick(k,N,mark,tick,out,from=0){let c=0;while(c<k){const x=1+(simRng()*N|0);if(mark[x]!==tick){mark[x]=tick;out[from+c++]=x}}}
let sim=null;
/* Simulated calendar: draw 1 is the next real draw date, then every real draw day after it (two a week).
   Dates are counted in days since 1970 and turned into Y-M-D by arithmetic, because JavaScript's Date
   stops at the year 275,760 and a long run goes well past that. */
const SIM_DOW=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'],SIM_MON=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function civilFromDays(z){ // Howard Hinnant's days-to-civil algorithm (proleptic Gregorian)
  z+=719468;const era=Math.floor(z/146097),doe=z-era*146097,yoe=Math.floor((doe-Math.floor(doe/1460)+Math.floor(doe/36524)-Math.floor(doe/146096))/365);
  const doy=doe-(365*yoe+Math.floor(yoe/4)-Math.floor(yoe/100)),mp=Math.floor((5*doy+2)/153),d=doy-Math.floor((153*mp+2)/5)+1,m=mp<10?mp+3:mp-9;
  return{y:yoe+era*400+(m<=2?1:0),m,d};
}
function simCal(g){
  const iso0=upcomingDates(g,1)[0],[y,m,d]=iso0.split('-').map(Number),start=Math.round(Date.UTC(y,m-1,d)/864e5);
  const w=((start%7)+7+4)%7,other=g.days.find(x=>x!==w)??w;
  return{start,g1:(other-w+7)%7||7};
}
const simDay=(s,n)=>s.cal.start+Math.floor((n-1)/2)*7+((n-1)%2?s.cal.g1:0);
function simDate(s,n){const z=simDay(s,Math.max(1,n)),c=civilFromDays(z);return `${SIM_DOW[((z%7)+7+4)%7]} ${c.d} ${SIM_MON[c.m-1]} ${c.y<10000?c.y:'in the year '+c.y}`}
const simWhen=(s,j)=>simDate(s,j.n)+(j.round?` (Round ${j.round})`:'');
// How good a match is, so the closest call can be kept: Lotto 5+bonus beats 5; EuroMillions follows the prize tiers
const SIM_EM_ORDER=[...EM_WIN];
const simRank=(lotto,m,e)=>lotto?m*2+(m===5&&e?1:0):(SIM_EM_ORDER.includes(m+'+'+e)?100-SIM_EM_ORDER.indexOf(m+'+'+e):m*3+e);
const simKey=(g,main,extra)=>g.key+':'+main.join(',')+'|'+extra.join(',');
function simNew(g,main,extra,ds){
  const line=new Uint8Array(g.mainMax+1),lx=new Uint8Array((g.extraMax||0)+1);main.forEach(x=>line[x]=1);extra.forEach(x=>lx[x]=1);
  const pr=simPrizes(g,ds);
  return{key:simKey(g,main,extra),game:g.key,main,extra,line,lx,n:0,rounds:0,counts:{},won:0,hit:null,done:false,running:false,cal:simCal(g),jacks:[],jackDraw:null,best:null,
    mark:new Int32Array(g.mainMax+1),xmark:new Int32Array((g.extraMax||0)+1),tick:0,last:null,prizes:pr.p,rough:pr.rough,jk:pr.jk,lastPaint:0,watchAt:0};
}
const simTarget=()=>Math.round(SIM_YEARS[state.simYi??9]*SIM_PER_YEAR);
// Run up to `max` draw nights. Stops early on a jackpot or at the target. Returns how many ran.
function simStep(s,max){
  const g=GAMES[s.game],R=SIM_ROUNDS[g.key],tgt=simTarget(),buf=new Uint8Array(8),xb=new Uint8Array(2);let ran=0;
  while(ran<max&&s.n<tgt&&!s.hit){
    s.n++;ran++;
    for(let r=0;r<R;r++){
      s.rounds++;const t=++s.tick;let key=null;
      if(!g.sepPool){
        simPick(7,59,s.mark,t,buf);let m=0;for(let i=0;i<6;i++)m+=s.line[buf[i]];
        const bx=m===5&&s.line[buf[6]]?1:0;
        if(m>=2)key=bx?'5+1':m+'+0';
        if(ran===max||s.n>=tgt||m===6)s.last={main:Array.from(buf.subarray(0,6)),extra:[buf[6]],round:R>1?r+1:null};
        if(m<6&&(!s.best||simRank(true,m,bx)>s.best.r))s.best={r:simRank(true,m,bx),m,e:bx,n:s.n,round:R>1?r+1:null,main:Array.from(buf.subarray(0,6)),extra:[buf[6]]};
      }else{
        simPick(5,50,s.mark,t,buf);simPick(2,12,s.xmark,t,xb);let m=0,e=0;for(let i=0;i<5;i++)m+=s.line[buf[i]];e=s.lx[xb[0]]+s.lx[xb[1]];
        key=m+'+'+e;if(!EM_WIN.has(key))key=null;
        if(ran===max||s.n>=tgt||key==='5+2')s.last={main:Array.from(buf.subarray(0,5)),extra:Array.from(xb),round:null};
        if(!(m===5&&e===2)&&(!s.best||simRank(false,m,e)>s.best.r))s.best={r:simRank(false,m,e),m,e,n:s.n,round:null,main:Array.from(buf.subarray(0,5)),extra:Array.from(xb)};
      }
      if(key){s.counts[key]=(s.counts[key]||0)+1;s.won+=s.prizes[key]||0;if(key===s.jk){const j={n:s.n,round:R>1?r+1:null};s.jacks.push(j);if(!s.jackDraw)s.jackDraw={...s.last};if(!s.hit)s.hit=j}}
    }
  }
  if(s.n>=tgt&&!s.hit)s.done=true;
  if(s.hit||s.done)s.running=false;
  return ran;
}
const fmtN=v=>Math.round(v).toLocaleString('en-GB');
const simYearsOf=n=>n/SIM_PER_YEAR;
const simYearsTxt=n=>{const y=simYearsOf(n);return y<1?`${fmtN(n)} draw${n===1?'':'s'}`:`${y<10?(Math.floor(y*10)/10).toFixed(1):fmtN(Math.floor(y))} years`};
const simMoney=v=>v>=1e6?money(v):'£'+(v<1000&&v%1?v.toFixed(2):fmtN(v));
function simBalls(s){
  const g=GAMES[s.game],srt=a=>[...a].sort((x,y)=>x-y);
  if((s.hit||s.done)&&!s.running){
    const mk=(n,isX)=>(isX&&g.sepPool?s.lx[n]:s.line[n])?'simhit':'';
    if(s.jacks.length){const d=s.jackDraw,J=s.jacks,show=J.slice(0,12);
      return `<div class="simend"><div class="small" style="font-weight:800;color:var(--gold2)">🏆 Your jackpot line</div>${rowBalls(g,srt(d.main),srt(d.extra),{fit:'fit',mark:mk})}
      <div class="small simdates"><div>${J.length===1?'Won on':`Won ${fmtN(J.length)} times:`}</div>${show.map(j=>`<b>${simWhen(s,j)}</b>`).join('')}${J.length>show.length?`<div>and ${fmtN(J.length-show.length)} more</div>`:''}</div></div>`}
    const b=s.best;if(b){const lbl=g.sepPool?`${b.m} + ${b.e}★`:b.m===5&&b.e?'5 + bonus':`${b.m}`;
      return `<div class="simend"><div class="small" style="font-weight:800">No jackpot. Closest: ${lbl}</div>${rowBalls(g,srt(b.main),srt(b.extra),{fit:'fit',mark:mk})}
      <div class="small simdates"><div>First on</div><b>${simWhen(s,b)}</b></div></div>`}
  }
  if(!s.last)return `<div class="muted small" style="min-height:44px;display:flex;align-items:center">Balls appear here once it starts.</div>`;
  const mk=(n,isX)=>(isX&&g.sepPool?s.lx[n]:s.line[n])?'simhit':'';
  return rowBalls(g,[...s.last.main].sort((a,b)=>a-b),[...s.last.extra].sort((a,b)=>a-b),{fit:'fit',mark:mk,anim:speedOf()==='watch'});
}
const speedOf=()=>state.simSpeed||'warp';
function simStatus(s){
  const g=GAMES[s.game],R=SIM_ROUNDS[g.key],spent=s.n*SIM_PRICE[g.key];
  const odds=comb(g.mainMax,g.main)*(g.sepPool?comb(g.extraMax,g.extra):1),avgN=odds/R;
  if(s.hit)return `<div class="banner"><h2>🎉 Jackpot after ${simYearsTxt(s.hit.n)}</h2><p style="margin:0">On <b>${simWhen(s,s.hit)}</b>, draw ${fmtN(s.hit.n)}. Along the way you'd have spent <b>${simMoney(spent)}</b> and won <b>${simMoney(s.won)}</b>, jackpot included.</p><div class="row" style="margin-top:10px"><button class="btn ghost" data-act="simmore">Keep going</button><button class="btn ghost" data-act="simreset">Start again</button></div></div>`;
  if(s.done){const j=s.counts[s.jk]||0,avgY=fmtN(simYearsOf(avgN));
    return `<div class="note" style="margin-top:10px">${j?`${fmtN(j)} jackpot${j===1?'':'s'} in ${simYearsTxt(s.n)}${j>1?`, about 1 every ${fmtN(simYearsOf(s.n/j))} years`:''}. On average it's 1 every <b>${avgY} years</b>.`:`No jackpot in ${simYearsTxt(s.n)}. On average it takes about <b>${avgY} years</b>.`}</div>`}
  return '';
}
function simTally(s){
  const g=GAMES[s.game];
  return `<table><tr><th>Matched</th><th>Times</th><th>Prize</th></tr>${SIM_TIERS[g.key].map(([k,l])=>{const c=s.counts[k]||0;return `<tr><td>${l}</td><td class="${c?'prize':''}">${fmtN(c)}</td><td class="small muted">${simMoney(s.prizes[k])}</td></tr>`}).join('')}</table>`;
}
function simNumbers(s){
  const g=GAMES[s.game],spent=s.n*SIM_PRICE[g.key],net=s.won-spent,tgt=simTarget();
  return `<div class="row" style="justify-content:space-between;align-items:baseline"><span style="font-size:22px;font-weight:900">${s.n?simYearsTxt(s.n):'Year 0'}</span><span class="small muted">${fmtN(s.n)} draw${s.n===1?'':'s'}${SIM_ROUNDS[g.key]>1?` · ${fmtN(s.rounds)} rounds`:''}</span></div>
  <div class="small muted">📅 ${s.n?simDate(s,s.n):'Starts '+simDate(s,1)}</div>
  <div class="fbar" style="margin:8px 0;width:100%"><i style="width:${Math.min(100,s.n/tgt*100)}%"></i></div>
  <div class="small">Spent <b>${simMoney(spent)}</b> · won <b>${simMoney(s.won)}</b> · <b style="color:${net>=0?'var(--good)':'var(--bad)'}">${net>=0?'+':'−'}${simMoney(Math.abs(net))}</b></div>`;
}
function simBtns(s){
  const btn=s.running?'⏸ Pause':s.hit||s.done?'':s.n?'▶ Carry on':'▶ Start';
  return `<div class="row" style="margin-top:12px">${btn?`<button class="btn" data-act="simgo">${btn}</button>`:''}${s.n&&!s.hit?`<button class="btn ghost" data-act="simreset">Reset</button>`:''}</div>`;
}
function simCard(g,main,extra,ds){
  const k=simKey(g,main,extra);
  if(!sim||sim.key!==k){if(sim)sim.running=false;sim=simNew(g,main,extra,ds)}
  const s=sim,yi=state.simYi??9,R=SIM_ROUNDS[g.key];
  const odds=comb(g.mainMax,g.main)*(g.sepPool?comb(g.extraMax,g.extra):1);
  return `<div class="card" id="simcard"><h2>Play it for years</h2><p class="small muted" style="margin-top:0">Pretend you played this line in every draw from the next one onwards, on the real draw days, for as long as you like. Every draw is random and fair, with the real odds: 1 in ${fmtN(odds/R)} per draw for the jackpot${R>1?` (a line enters both rounds)`:''}.</p>
  <label class="f">Run for <b id="simyl">${fmtN(SIM_YEARS[yi])} year${yi?'s':''}</b></label>
  <input type="range" id="simyears" min="0" max="${SIM_YEARS.length-1}" step="1" value="${yi}" style="width:100%">
  <div class="chips" style="margin-top:8px">${[['watch','Watch'],['fast','Fast'],['warp','Warp']].map(([v,l])=>`<button class="chip ${speedOf()===v?'on':''}" data-act="simspeed" data-speed="${v}">${l}</button>`).join('')}</div>
  <div class="simview"><canvas id="simwarp" aria-hidden="true"></canvas><div id="simballs">${simBalls(s)}</div></div>
  <div id="simnum" style="margin-top:10px">${simNumbers(s)}</div>
  <div id="simbtns">${simBtns(s)}</div>
  <div id="simstat">${simStatus(s)}</div>
  <div id="simtally" style="margin-top:12px">${simTally(s)}</div>
  ${(setTimeout(()=>{if(!simLoopOn)starsDraw(0)},0),'')}<div class="note">Your numbers glow gold when they come up. Prizes: ${g.sepPool?(s.rough?'rough typical EuroMillions prizes (real ones are shared, so they vary)':'typical EuroMillions prizes from stored results (real ones are shared, so they vary)'):'the fixed Lotto prizes'}, and a ${money(s.prizes[s.jk])} jackpot as if you didn't share it. Just for fun: the real draws work the same way, so expect the same result.</div></div>`;
}
function simPaint(s){
  const el=id=>document.getElementById(id);
  if(!el('simcard')){s.running=false;return}
  el('simballs').innerHTML=simBalls(s);el('simnum').innerHTML=simNumbers(s);el('simtally').innerHTML=simTally(s);
  el('simbtns').innerHTML=simBtns(s);el('simstat').innerHTML=simStatus(s);
}
// Warp takes at least this long for the chosen years (slower phones may take longer), after a short ramp up
const SIM_WARP_SECS=8,SIM_WARP_RAMP=1800;
let simLoopOn=false,simLast=0;
function simLoop(now){
  const s=sim,dt=Math.min(50,simLast?now-simLast:16);simLast=now;
  if(!document.getElementById('simcard')){if(s)s.running=false;simLoopOn=false;starV=0;return}
  const sp=speedOf();let ramp=1;
  if(s&&s.running){
    if(sp==='watch'){if(now-s.watchAt>=700){s.watchAt=now;simStep(s,1);simPaint(s)}}
    else if(sp==='fast'){simStep(s,26);simPaint(s)}
    else{
      ramp=Math.min(1,((now-s.warpAt)/SIM_WARP_RAMP)**2);
      const per=Math.max(1,Math.ceil(simTarget()/(SIM_WARP_SECS*60)*ramp)),t0=performance.now();let done=0;
      do{done+=simStep(s,Math.min(2000,per-done))}while(s.running&&done<per&&performance.now()-t0<28);
      simPaint(s);
    }
  }
  const run=s&&s.running,want=run?(sp==='warp'?0.12+0.88*ramp:sp==='fast'?0.35:0.05):0;
  starV+=(want-starV)*Math.min(1,dt/(want>starV?200:450));
  starsDraw(dt);
  if(run||starV>0.004){requestAnimationFrame(simLoop)}else{starV=0;simLoopOn=false;starsDraw(0)}
}
function simStartLoop(){if(simLoopOn)return;simLoopOn=true;simLast=0;requestAnimationFrame(simLoop)}
// Starfield behind the balls: stars fly towards you, streaking at speed, and coast to a stop when the run ends
const STARS=Array.from({length:150},()=>({x:Math.random()*2-1,y:Math.random()*2-1,z:Math.random()}));
let starV=0;
function starsDraw(dt){
  const c=document.getElementById('simwarp');if(!c||!c.getContext)return;
  let ctx;try{ctx=c.getContext('2d')}catch(e){return}if(!ctx)return;
  const dpr=window.devicePixelRatio||1,w=c.clientWidth,h=c.clientHeight;if(!w||!h)return;
  if(c.width!==Math.round(w*dpr)||c.height!==Math.round(h*dpr)){c.width=Math.round(w*dpr);c.height=Math.round(h*dpr)}
  ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);ctx.lineCap='round';
  const cx=w/2,cy=h/2,k=Math.max(w,h)*0.18,mv=starV*dt*0.0016;
  for(const st of STARS){
    st.z-=mv;
    const px=cx+st.x*k/st.z,py=cy+st.y*k/st.z;
    if(st.z<=0.03||px<-20||px>w+20||py<-20||py>h+20){st.x=Math.random()*2-1;st.y=Math.random()*2-1;st.z=0.8+Math.random()*0.2;continue}
    const qz=Math.min(1.2,st.z+starV*0.09+0.004),qx=cx+st.x*k/qz,qy=cy+st.y*k/qz,a=Math.min(1,(1.05-st.z)*1.3);
    ctx.strokeStyle=st.x*st.y>0?`rgba(255,236,190,${a})`:`rgba(215,200,255,${a})`;
    ctx.lineWidth=0.6+(1-st.z)*1.8;ctx.beginPath();ctx.moveTo(qx,qy);ctx.lineTo(px,py);ctx.stroke();
  }
}
function simRun(){if(!sim||sim.hit||sim.done)return;sim.running=true;sim.watchAt=0;sim.warpAt=performance.now();simStartLoop()}
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
  h+=simCard(g,main,extra,ds);
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

/* ---------- Most / least drawn, with ties shown honestly ---------- */
// Top `size` numbers by count (dir 1 = most, -1 = least). Numbers level with the last one shown are
// returned as `tied`, so the cut-off never silently picks between equals.
function rankTies(nums,cnt,size,dir){
  const s=[...nums].sort((a,b)=>dir*(cnt[b]-cnt[a])||a-b);
  if(s.length<=size)return{shown:s,tied:[]};
  const cut=cnt[s[size-1]];
  return{shown:s.slice(0,size),tied:s.slice(size).filter(x=>cnt[x]===cut),cut};
}
// One "Most drawn" / "Least drawn" block. `key` identifies its tie expander in state.open.
function rankBlock(g,title,r,cnt,star,key){
  const balls=xs=>star?`<div class="balls">${xs.map(x=>ball(x,g,{star:true,sm:true})).join('')}</div>`:lineBalls(g,xs,[],{sm:true});
  const open=state.open.has(key);
  const tie=r.tied.length?` <button class="tie" data-grp="${key}" aria-expanded="${open}">+${r.tied.length} tied ${open?'▴':'▾'}</button>`:'';
  return `<h3>${title}${tie}</h3>${balls(r.shown)}<div class="note">${r.shown.map(x=>`${x}: ${cnt[x]}`).join(' · ')}</div>`+
    (open&&r.tied.length?`<div class="tied">${balls(r.tied)}<div class="note">Also drawn ${r.cut} time${r.cut===1?'':'s'}: ${r.tied.join(', ')}</div></div>`:'');
}
const DAY_NAMES=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const STAT_DAYS={lotto:[6,3],euromillions:[2,5]}; // Saturday then Wednesday; Tuesday then Friday
const weekday=d=>new Date(d.date+'T12:00:00').getDay();
// Do the two draw days differ by more than chance? A 2×N chi-square of counts per number per day.
// The (N-1)/(N-k) factor allows for balls being drawn without replacement, as in "Is it random?".
function dayChi(a,b,N,k){
  const ta=a.reduce((s,v)=>s+v,0),tb=b.reduce((s,v)=>s+v,0),T=ta+tb;
  if(!ta||!tb)return null;
  let x2=0;
  for(let x=1;x<=N;x++){const c=a[x]+b[x];if(!c)continue;const ea=ta*c/T,eb=tb*c/T;x2+=(a[x]-ea)**2/ea+(b[x]-eb)**2/eb}
  x2*=(N-1)/(N-k);
  return{x2,df:N-1,p:chiP(x2,N-1),minExp:Math.min(ta,tb)/N};
}
function chiLine(r,label,names){
  if(!r)return '';
  const few=r.minExp<5;
  const pill=few?`<span class="pill p-med">Too few draws yet</span>`:`<span class="pill ${r.p>.05?'p-low':r.p>.01?'p-med':'p-high'}">${r.p>.05?'No real difference':r.p>.01?'Slightly unusual':'Unusual difference'}</span>`;
  return `<div class="row" style="justify-content:space-between;margin-top:8px"><span class="small">${label} ${pill}</span><span class="muted small">χ² ${r.x2.toFixed(1)} · df ${r.df} · p ${r.p<.001?'<0.001':r.p.toFixed(3)}</span></div>`+
    (few?`<div class="note">About ${r.minExp.toFixed(1)} per ${label==='Stars'?'star':'number'} on the quieter day so far. The test needs about 5 before its answer means much.</div>`:'');
}
function dayCard(g,ds){
  const days=STAT_DAYS[g.key],withBonus=!g.sepPool&&settings.bonusCounts;
  const nums=n=>[...Array(n).keys()].map(i=>i+1);
  const per=days.map(day=>{
    const dd=ds.filter(d=>weekday(d)===day),m=Array(g.mainMax+1).fill(0),s=Array(g.extraMax+1).fill(0);
    dd.forEach(d=>{d.main.forEach(x=>m[x]++);if(withBonus)(d.extra||[]).forEach(x=>m[x]++);if(g.sepPool)(d.extra||[]).forEach(x=>s[x]++)});
    return{day,n:dd.length,dates:new Set(dd.map(d=>d.date)).size,m,s};
  });
  let h=`<div class="card"><h2>📅 By draw day</h2><p class="small muted" style="margin-top:0">The most and least drawn ${g.sepPool?'numbers and stars':'balls'} on each draw day${g.sepPool?'':`, counting both rounds${withBonus?' and the bonus ball (Settings)':''}`}. The day can't change which balls come out, so expect any differences to be chance.</p>`;
  per.forEach(p=>{
    const nm=DAY_NAMES[p.day],key=`day:${g.key}:${p.day}`;
    h+=`<h3 class="dayh">${nm}</h3><div class="note" style="margin-top:0">${p.n} draw${p.n===1?'':'s'}${p.dates!==p.n?` on ${p.dates} date${p.dates===1?'':'s'}`:''}</div>`;
    if(!p.n){h+=`<p class="small muted">No ${nm} draws in this window yet.</p>`;return}
    h+=rankBlock(g,'Most drawn',rankTies(nums(g.mainMax),p.m,g.main,1),p.m,false,key+':hot');
    h+=rankBlock(g,'Least drawn',rankTies(nums(g.mainMax),p.m,g.main,-1),p.m,false,key+':cold');
    if(g.sepPool){
      h+=rankBlock(g,'Most drawn stars',rankTies(nums(g.extraMax),p.s,g.extra,1),p.s,true,key+':shot');
      h+=rankBlock(g,'Least drawn stars',rankTies(nums(g.extraMax),p.s,g.extra,-1),p.s,true,key+':scold');
    }
  });
  const [a,b]=per;
  h+=`<h3>${DAY_NAMES[a.day]} vs ${DAY_NAMES[b.day]}</h3>`;
  h+=chiLine(dayChi(a.m,b.m,g.mainMax,g.main+(withBonus?1:0)),g.sepPool?'Numbers':'Balls');
  if(g.sepPool)h+=chiLine(dayChi(a.s,b.s,g.extraMax,g.extra),'Stars');
  return h+`<div class="note">A fun look back — none of this changes the next draw.</div></div>`;
}

/* ---------- What chance predicts: droughts, consecutive numbers, sums ---------- */
// Bars of what happened, with a white mark where chance puts each one (rows: {l: label, obs: %, exp: %})
function chanceBars(rows){
  const top=Math.max(1e-9,...rows.map(r=>Math.max(r.obs,r.exp)));
  return `<div class="bars">${rows.map(r=>`<div class="b"><span>${r.l}</span><div class="t"><i style="width:${r.obs/top*100}%"></i><u style="left:${Math.min(r.exp/top*100,99.5)}%"></u></div><span class="small">${r.obs<1&&r.obs>0?'<1':r.obs.toFixed(0)}%</span></div>`).join('')}</div><div class="note">Bars = what happened. White marks = what chance predicts.</div>`;
}
// Gaps between a number's appearances, pooled over every number. ds is newest first; each draw (or round) counts as one.
function droughts(ds,N,pick){
  const last=Array(N+1).fill(null),gaps=[];
  for(let i=ds.length-1;i>=0;i--){const at=ds.length-1-i;pick(ds[i]).forEach(x=>{if(last[x]!==null)gaps.push(at-last[x]);last[x]=at})}
  const current=[...Array(N).keys()].map(i=>i+1).map(x=>({x,g:last[x]===null?null:ds.length-1-last[x]}));
  return{gaps,current};
}
// Draw-to-draw chance a given number comes up is p = k/N, so a gap of exactly g draws has chance p(1−p)^(g−1)
const geoAtLeast=(p,g)=>Math.pow(1-p,g-1);
function droughtCard(g,ds,isStar){
  const N=isStar?g.extraMax:g.mainMax,k=isStar?g.extra:g.main,p=k/N,pick=d=>isStar?d.extra:d.main;
  const {gaps,current}=droughts(ds,N,pick);if(gaps.length<20)return '';
  const w=Math.max(1,Math.round(1/p/2)),nb=8,rows=[];
  for(let b=0;b<nb;b++){
    const lo=b*w+1,hi=b===nb-1?Infinity:(b+1)*w;
    const obs=gaps.filter(x=>x>=lo&&x<=hi).length/gaps.length*100;
    const exp=(geoAtLeast(p,lo)-(hi===Infinity?0:geoAtLeast(p,hi+1)))*100;
    rows.push({l:hi===Infinity?`${lo}+`:lo===hi?`${lo}`:`${lo}–${hi}`,obs,exp});
  }
  const longest=Math.max(...gaps),cur=current.filter(c=>c.g!==null).sort((a,b)=>b.g-a.g)[0];
  const odds=x=>{const v=geoAtLeast(p,x+1)*100;return v>=1?`${v.toFixed(0)}%`:v>=0.1?`${v.toFixed(1)}%`:'under 0.1%'};
  const ball1=x=>isStar?ball(x,g,{star:true,sm:true}):ball(x,g,{sm:true});
  return `<div class="card"><h2>Is “overdue” real?</h2><p class="small muted" style="margin-top:0">How many draws each ${isStar?'star':'number'} waited between appearances, over ${gaps.length.toLocaleString('en-GB')} waits. Every draw is a fresh start, so a ${isStar?'star':'number'} that's been away a long time is no more likely to come up next.</p>
  ${chanceBars(rows)}
  ${cur?`<div class="row" style="margin-top:12px;gap:10px;align-items:center;flex-wrap:nowrap">${ball1(cur.x)}<span class="small" style="flex:1">Away longest right now: <b>${cur.g} draws</b>. Any given ${isStar?'star':'number'} stays away that long about ${odds(cur.g)} of the time. Its chance next draw is still ${(p*100).toFixed(0)}%.</span></div>`:''}
  <div class="note">Longest wait in this window: ${longest} draws. Long waits are part of the curve, not a sign that something is due.</div>${isStar?'':onPaperHTML(g,draws(g))}</div>`;
}
// "Due on paper": each ball turns up on average once every N/k draws (each stored draw or round counts as one).
// Rank balls by how far past that average they are (draws since last seen ÷ average gap), furthest first.
// Lotto counts the bonus ball as drawn (7 of 59). Balls never seen in the history rank first.
function onPaperRank(ds,N,k,pick){
  const avg=N/k,last=Array(N+1).fill(null);
  ds.forEach((d,i)=>pick(d).forEach(x=>{if(last[x]===null)last[x]=i}));
  return [...Array(N).keys()].map(i=>i+1).map(x=>{const g=last[x]??ds.length;return{x,g,never:last[x]===null,r:g/avg}})
    .sort((a,b)=>b.r-a.r||a.x-b.x);
}
function onPaperLine(g,ds){
  const lotto=!g.sepPool,mk=lotto?g.main+1:g.main;
  const mains=onPaperRank(ds,g.mainMax,mk,d=>lotto?[...d.main,...(d.extra||[])]:d.main).slice(0,g.main);
  const stars=g.sepPool?onPaperRank(ds,g.extraMax,g.extra,d=>d.extra||[]).slice(0,g.extra):[];
  return{mains,stars,avgM:g.mainMax/mk,avgS:g.sepPool?g.extraMax/g.extra:null};
}
function onPaperHTML(g,ds){
  if(ds.length<20)return '';
  const {mains,stars,avgM,avgS}=onPaperLine(g,ds),f=v=>v.toFixed(1);
  const past=[...mains,...stars].filter(b=>b.r>=1).length,all=mains.length+stars.length;
  const desc=b=>`${b.x}: ${b.never?b.g+'+':b.g} draw${b.g===1?'':'s'} (${b.r.toFixed(1)}×)`;
  const pool=!g.sepPool?`${g.main+1} of ${g.mainMax} balls come out each draw (bonus included), so each one turns up on average every <b>${f(avgM)} draws</b>`
    :`each main number turns up on average every <b>${f(avgM)} draws</b>, and each star every <b>${f(avgS)}</b>`;
  return `<h3>Due on paper</h3><p class="small muted" style="margin-top:0">${pool[0].toUpperCase()+pool.slice(1)}. This line is the ${g.sepPool?'numbers and stars':'balls'} furthest past their average gap. ${past===all?'All of them are':past?`${past} of them ${past===1?'is':'are'}`:'None of them is yet'} past it.</p>
  ${rowBalls(g,mains.map(b=>b.x).sort((a,b)=>a-b),stars.map(b=>b.x).sort((a,b)=>a-b),{fit:'fit'})}
  <div class="note">Draws since last seen, and how many times its average gap that is: ${[...mains,...stars].map(desc).join(' · ')}</div>
  <button class="btn ghost" style="margin-top:10px" data-act="keeppaper">Save to My lines</button>
  <div class="note">On paper only. The machine has no memory, so each ${g.sepPool?'number still has a 1 in '+f(avgM)+' chance of coming out next draw, and each star 1 in '+f(avgS):'ball still has a 1 in '+f(avgM)+' chance of coming out next draw'}.</div>`;
}
// Draws (k of 1..N) with exactly j consecutive pairs: C(k−1, j)·C(N−k+1, k−j)
function consecutiveDist(N,k){return[...Array(k).keys()].map(j=>comb(k-1,j)*comb(N-k+1,k-j)/comb(N,k))}
const pairsIn=main=>{const a=[...main].sort((x,y)=>x-y);let n=0;for(let i=1;i<a.length;i++)if(a[i]-a[i-1]===1)n++;return n};
function consecutiveCard(g,ds){
  const dist=consecutiveDist(g.mainMax,g.main),n=ds.length,cnt=Array(4).fill(0);
  ds.forEach(d=>cnt[Math.min(3,pairsIn(d.main))]++);
  const exp=[dist[0],dist[1],dist[2],dist.slice(3).reduce((a,b)=>a+b,0)];
  const rows=['None','1 pair','2 pairs','3+'].map((l,i)=>({l,obs:cnt[i]/n*100,exp:exp[i]*100}));
  const any=(n-cnt[0])/n*100;
  return `<div class="card"><h2>Consecutive numbers</h2><p class="small muted" style="margin-top:0">Draws containing neighbours like 14 and 15 (a run of three counts as two pairs). They feel “not random”, but chance puts at least one pair in <b>${((1-dist[0])*100).toFixed(1)}%</b> of draws. Here: <b>${any.toFixed(1)}%</b>.</p>${chanceBars(rows)}</div>`;
}
// How many k-number draws from 1..N add up to each total (counted exactly, not simulated)
const sumCache={};
function sumDist(N,k){
  const key=N+'/'+k;if(sumCache[key])return sumCache[key];
  const max=k*N,dp=[...Array(k+1)].map(()=>new Float64Array(max+1));dp[0][0]=1;
  for(let x=1;x<=N;x++)for(let j=Math.min(k,x);j>=1;j--)for(let s=max;s>=x;s--)dp[j][s]+=dp[j-1][s-x];
  const tot=comb(N,k);return sumCache[key]=Array.from(dp[k],v=>v/tot);
}
function sumCard(g,ds){
  const N=g.mainMax,k=g.main,dist=sumDist(N,k),n=ds.length,mid=k*(N+1)/2;
  const lo=k*(k+1)/2,hi=k*(2*N-k+1)/2,sd=Math.sqrt(k*(N+1)*(N-k)/12),w=Math.max(5,Math.round(sd/2/5)*5),rows=[];
  // Bins centred on the middle total, with the thin tails folded into the end bins
  const edges=[];for(let e=Math.round(mid-w*3.5);e<=mid+w*3.5;e+=w)edges.push(e);
  const sums=ds.map(d=>d.main.reduce((a,b)=>a+b,0));
  for(let i=0;i<=edges.length;i++){
    const a=i===0?lo:edges[i-1],b=i===edges.length?hi:edges[i]-1;if(a>b)continue;
    let e=0;for(let s=a;s<=b;s++)e+=dist[s]||0;
    rows.push({l:i===0?`≤${b}`:i===edges.length?`${a}+`:`${a}–${b}`,obs:sums.filter(s=>s>=a&&s<=b).length/n*100,exp:e*100});
  }
  const avg=sums.reduce((a,b)=>a+b,0)/n;
  return `<div class="card"><h2>Line totals</h2><p class="small muted" style="margin-top:0">Add up the ${k} main numbers of each draw. Totals can run from ${lo} to ${hi}, but most land near the middle (${mid}) just by chance, the same bell curve as the bean machine. Average here: <b>${avg.toFixed(1)}</b>.</p>${chanceBars(rows)}<div class="note">Every line has the same chance whatever its total. Middle totals are common only because many more lines add up to them.</div></div>`;
}
// Draw days with no stored draw, between the oldest and newest draws given, grouped into runs
function missingRuns(g,ds){
  if(ds.length<2)return{n:0,runs:[]};
  const have=new Set(ds.map(d=>d.date)),runs=[];let n=0,cur=null;
  for(let d=new Date(ds[ds.length-1].date+'T12:00:00');iso(d)<=ds[0].date;d.setDate(d.getDate()+1)){
    if(!g.days.includes(d.getDay()))continue;
    const k=iso(d);
    if(have.has(k)){cur=null;continue}
    n++;if(cur){cur.to=k;cur.n++}else runs.push(cur={from:k,to:k,n:1});
  }
  return{n,runs};
}
function gapNote(g,ds){
  const m=missingRuns(g,ds);if(!m.n)return '';
  const sd=s=>new Date(s+'T12:00:00').toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'});
  const big=[...m.runs].sort((a,b)=>b.n-a.n).slice(0,2).map(r=>r.from===r.to?sd(r.from):`${sd(r.from)} – ${sd(r.to)}`);
  return `<div class="note" style="color:var(--warn)">${m.n} draw date${m.n===1?' is':'s are'} missing from this window (${big.join('; ')}${m.runs.length>2?'; and others':''}). Counts are from the draws that are here, and “draws ago” skips the gap.</div>`;
}
function viewStats(){
  if(!statsUnlocked())return lockedStats();
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
  const absent=[...nums].sort((a,b)=>(since[b]??1e9)-(since[a]??1e9)).slice(0,isStar?5:g.main);
  let h=`<div class="card"><div class="chips">${[['all','All '+all.length],['100','Last 100'],['26','Last 26']].map(([v,l])=>`<button class="chip ${state.statWin===v?'on':''}" data-win="${v}">${l}</button>`).join('')}</div>
  ${g.sepPool?`<div class="chips" style="margin-top:8px">${[['main','Main balls'],['extra','Lucky Stars']].map(([v,l])=>`<button class="chip ${pool===v?'on':''}" data-pool="${v}">${l}</button>`).join('')}</div>`:''}
  <div class="note">${n} draws${state.statWin==='all'?' since '+fmtDate(g.since)+' (current format)':''}. Expected per ${isStar?'star':'number'}: ${exp.toFixed(1)}.</div>${settings.demo?'':gapNote(g,ds)}</div>`;
  if(!isStar&&!settings.demo)h+=crowdCard(g,ds);
  h+=`<div class="card"><h2>Is it random?</h2><div class="row" style="justify-content:space-between"><span class="pill ${pv>.05?'p-low':pv>.01?'p-med':'p-high'}">${pv>.05?'Looks random':pv>.01?'Slightly unusual':'Unusual spread'}</span><span class="muted small">χ² ${x2.toFixed(1)} · df ${df} · p ${pv<.001?'<0.001':pv.toFixed(3)}</span></div>
  <p class="small" style="margin-bottom:0">${pv>.05?`The ups and downs between numbers are about what pure chance produces. “Hot” and “cold” numbers are just noise.`:`The spread is a bit lumpier than chance usually gives. With small windows that happens now and then — it isn't a signal to bet on.`}</p></div>`;
  // One line's worth: 6 for Lotto, 5 main numbers and 2 stars for EuroMillions
  const size=isStar?g.extra:g.main,hk=`hc:${g.key}:${pool}`;
  let stars='';
  if(g.sepPool&&!isStar){
    const sc=Array(g.extraMax+1).fill(0),sn=[...Array(g.extraMax).keys()].map(i=>i+1);
    ds.forEach(d=>(d.extra||[]).forEach(x=>sc[x]++));
    stars=`<h3 class="dayh">Lucky Stars</h3>`+rankBlock(g,'Most drawn',rankTies(sn,sc,g.extra,1),sc,true,hk+':shot')+rankBlock(g,'Least drawn',rankTies(sn,sc,g.extra,-1),sc,true,hk+':scold');
  }
  h+=`<div class="card"><h2>Hot & cold</h2>${g.sepPool&&!isStar?`<h3 class="dayh">Main numbers</h3>`:''}${rankBlock(g,'Most drawn',rankTies(nums,cnt,size,1),cnt,isStar,hk+':hot')}${rankBlock(g,'Least drawn',rankTies(nums,cnt,size,-1),cnt,isStar,hk+':cold')}${stars}
  <h3>Longest absent</h3>${isStar?`<div class="balls">${absent.map(x=>ball(x,g,{star:true,sm:true})).join('')}</div>`:lineBalls(g,absent,[],{sm:true})}<div class="note">${absent.map(x=>`${x}: ${since[x]??'—'} draws ago`).join(' · ')}</div>
  <div class="note">A fun look back — none of this changes the next draw.</div></div>`;
  h+=droughtCard(g,ds,isStar);
  h+=dayCard(g,ds);
  h+=`<div class="card"><div class="row" style="justify-content:space-between"><h2 style="margin:0">Every ${isStar?'star':'number'}</h2><div class="chips">${[['num','1→'+N],['freq','By count']].map(([v,l])=>`<button class="chip ${state.statSort===v?'on':''}" data-sort="${v}">${l}</button>`).join('')}</div></div>
  <div class="fgrid" style="margin-top:12px">${order.map(x=>`<div class="fcell">${isStar?ball(x,g,{star:true,sm:true}):ball(x,g,{sm:true})}<span>${cnt[x]}</span><div class="fbar"><i style="width:${mx===mn?50:((cnt[x]-mn)/(mx-mn)*100)}%"></i></div></div>`).join('')}</div></div>`;
  if(!isStar){
    const odd=Math.ceil(g.mainMax/2),even=g.mainMax-odd,tot=comb(g.mainMax,g.main),oc=Array(g.main+1).fill(0);
    ds.forEach(d=>oc[d.main.filter(v=>v%2).length]++);
    const rows=oc.map((c,j)=>({j,obs:c/n*100,exp:comb(odd,j)*comb(even,g.main-j)/tot*100}));
    const top=Math.max(...rows.map(r=>Math.max(r.obs,r.exp)));
    h+=`<div class="card"><h2>Odd / even split</h2><div class="bars">${rows.map(r=>`<div class="b"><span>${r.j} odd</span><div class="t"><i style="width:${r.obs/top*100}%"></i><u style="left:${r.exp/top*100}%"></u></div><span class="small">${r.obs.toFixed(0)}%</span></div>`).join('')}</div><div class="note">Bars = what happened. White marks = what chance predicts.</div></div>`;
    h+=consecutiveCard(g,ds);
    h+=sumCard(g,ds);
  }
  return h;
}

function storeNote(){
  const st=Object.values(GAMES).map(g=>({g,s:state.meta[g.key]?.store}));
  if(!st.some(x=>x.s))return `Calls made directly from this device this month: <b>${callsThisMonth()}</b>.`;
  const when=t=>t?new Date(t).toLocaleString('en-GB',{weekday:'short',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}):'never';
  return `<br>Results come from your Worker, which fetches them itself after each draw (about 35 API calls a month). Opening the app or tapping <b>Get latest</b> costs no API calls.`+
    st.map(({g,s})=>!s?'':`<br>${g.name}: ${s.count} draws stored, last fetched ${when(s.updatedAt)}${s.lastRun&&!s.lastRun.ok?` · <span style="color:var(--warn)">last attempt failed (${s.lastRun.error}) — it'll retry at the next scheduled run</span>`:''}${importNote(s.imported)}`).join('');
}
// Imported history, kept apart from the API's on the Worker and labelled by source
function importNote(im){
  if(!im)return '';
  const src=Object.entries(im.sources||{}).map(([k,v])=>`${SRC_NAMES[k]||k} ${v.kept}${v.from?` (${v.from.slice(0,4)}${v.to&&v.to.slice(0,4)!==v.from.slice(0,4)?'–'+v.to.slice(0,4):''})`:''}`).join(', ');
  const mm=im.mismatches||[];
  return `<br><span class="muted">+ ${im.count.toLocaleString('en-GB')} imported: ${src}.${im.overlap?` ${im.overlap} overlap with the API`:''}${im.overlap&&!mm.length?' and agree.':im.overlap?'.':''}</span>`+
    (mm.length?` <span style="color:var(--warn)">${mm.length} disagree with the API (${mm.slice(0,3).map(m=>m.date+(m.round?' '+m.round.replace('Round ','R'):'')).join(', ')}${mm.length>3?'…':''}) — the API's numbers are used.</span>`:'');
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
  <div class="card"><h2>About</h2><p class="small muted" style="margin-top:0">Bean Machine v${APP_VERSION}. Statistics are for entertainment — every line has the same chance in every draw. Please play responsibly.</p><p class="small muted">Not affiliated with the National Lottery or its operator.</p><button class="btn ghost" data-view="story">📖 The story behind the app</button> <button class="btn ghost" data-act="wipe">Clear stored results</button></div>`;
}

function render(){
  renderHeader();renderNav();
  const v={latest:viewLatest,check:viewCheck,gen:viewLines,stats:viewStats,settings:viewSettings,story:viewStory}[state.view]||viewLatest;
  $('#view').innerHTML=v();
  if(state.view==='story')startBeanMachine();else bm.run++;
}

/* ---------- Events ---------- */
document.addEventListener('keydown',e=>{if(e.key==='Enter'&&e.target.id==='statscode'){e.preventDefault();unlockStats(e.target.value)}});
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
    if(a==='keeppaper'){const p=onPaperLine(g,draws(g));if(L.length>=MAX_LINES){toast(`Up to ${MAX_LINES} lines`);return}
      L.push({main:p.mains.map(b=>b.x).sort((x,y)=>x-y),extra:p.stars.map(b=>b.x).sort((x,y)=>x-y)});saveLines();toast(`Saved as Line ${L.length}`)}
    if(a==='simgo'){if(sim&&sim.running){sim.running=false}else{simRun()}}
    if(a==='simspeed'){state.simSpeed=t.dataset.speed;if(sim)sim.warpAt=performance.now()}
    if(a==='simreset'){if(sim){sim.running=false;sim=null}}
    if(a==='simmore'){if(sim){sim.hit=null;simRun()}}
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
    if(a==='install'&&installPrompt){const p=installPrompt;installPrompt=null;p.prompt();try{await p.userChoice}catch(e){}render();return}
    if(a==='installhelp'){openInstallHelp();return}
    if(a==='unlockstats'){await unlockStats($('#statscode')?.value);return}
    if(a==='installlater'){LS.set('installLater',Date.now());render();return}
    if(a==='sync'||a==='syncfull'){settings.workerUrl=$('#wurl')?.value.trim()||settings.workerUrl;saveSettings();toast('Fetching…');await syncAll(a==='syncfull');return}
    if(a==='wipe'){if(!confirm('Clear stored live results? You\'ll need to sync again.'))return;for(const k of Object.keys(GAMES)){state.live[k]=[];await DB.set('draws_'+k,[])}state.meta={};LS.set('meta',{});toast('Cleared')}
  }
  render();
});
// Years slider: update the label and target live, without a full re-render so dragging stays smooth
document.addEventListener('input',e=>{
  if(e.target.id!=='simyears')return;state.simYi=+e.target.value;
  const yl=document.getElementById('simyl');if(yl)yl.textContent=fmtN(SIM_YEARS[state.simYi])+' year'+(state.simYi?'s':'');
  if(sim){sim.done=sim.n>=simTarget()&&!sim.hit;simPaint(sim)}
});
document.addEventListener('change',e=>{
  if(e.target.id==='restoreFile'){const f=e.target.files[0];if(f)importBackup(f);e.target.value='';return}
  const k=e.target.dataset.set;if(!k)return;settings[k]=e.target.checked;saveSettings();
  if(k==='demo'){state.gen=[];if(!settings.demo&&!draws().length)toast('Add your worker URL, then tap “Get latest”')}render()});


/* ---------- Installing ----------
   Android (and desktop Chrome) offer their own install prompt, which we catch and put behind an Install button.
   iPhones never offer one: the only way is Safari's Share → Add to Home Screen, so we show the steps instead.
   Same approach as the trip countdown app. */
let installPrompt=null;
function iosInstallState(env){
  const ua=env.userAgent||'';
  // iPadOS asks for the desktop site and reports itself as a Mac; a touch screen gives it away
  const ios=/iPhone|iPad|iPod/i.test(ua)||(/Macintosh/i.test(ua)&&(env.maxTouchPoints||0)>1);
  if(!ios)return 'not-ios';
  return env.standalone===true||env.displayModeStandalone===true?'installed':'needs-install';
}
const iosNeedsInstall=()=>iosInstallState({userAgent:navigator.userAgent,maxTouchPoints:navigator.maxTouchPoints,
  standalone:navigator.standalone,displayModeStandalone:!!window.matchMedia?.('(display-mode: standalone)').matches})==='needs-install';
const INSTALL_SNOOZE_DAYS=7;
const installSnoozed=()=>{const t=+LS.get('installLater',0);return t>0&&Date.now()-t<INSTALL_SNOOZE_DAYS*864e5};
function installBanner(){
  if(installSnoozed())return '';
  if(installPrompt)return `<div class="card install"><div><b>Install Bean Machine</b><div class="small">Adds it to your home screen and app list, and it opens like an app.</div></div><div class="row" style="margin-top:10px"><button class="btn" data-act="install">Install</button><button class="btn ghost" data-act="installlater">Not now</button></div></div>`;
  if(iosNeedsInstall())return `<div class="card install"><div><b>Add Bean Machine to your Home Screen</b><div class="small">It then opens like an app, full screen, with its own icon.</div></div><div class="row" style="margin-top:10px"><button class="btn" data-act="installhelp">Show me how</button><button class="btn ghost" data-act="installlater">Not now</button></div></div>`;
  return '';
}
const SHARE_ICON='<svg class="share-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M8 7l4-4 4 4M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/></svg>';
function openInstallHelp(){
  let d=$('#dlg-install');
  if(!d){d=document.createElement('dialog');d.id='dlg-install';d.className='sheet';document.body.appendChild(d)}
  d.innerHTML=`<form method="dialog"><h2>Install on your iPhone</h2><ol class="install-steps">
    <li><span class="n">1</span><span>Tap the <b>Share</b> button ${SHARE_ICON} at the bottom of Safari. Can't see it? Tap <b>⋯</b> or the <b>three lines (≡)</b> in the address bar, then <b>Share</b>.</span></li>
    <li><span class="n">2</span><span>Scroll down and tap <b>Add to Home Screen</b>.</span></li>
    <li><span class="n">3</span><span>Tap <b>Add</b>, then open <b>Bean Machine</b> from your Home Screen.</span></li></ol>
    <p class="small muted">Use the Home Screen app from then on. It keeps its own saved lines, separate from Safari, and the iPhone won't clear them the way it can clear websites you haven't visited for a while.</p>
    <p class="small muted">No Share button? The link may have opened inside another app, such as WhatsApp or Messages. Open it in Safari first.</p>
    <button class="btn block" style="margin-top:6px">Got it</button></form>`;
  if(d.showModal)d.showModal();else d.setAttribute('open','');
}
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();installPrompt=e;if(typeof render==='function')render()});
window.addEventListener('appinstalled',()=>{installPrompt=null;render();toast('Installed ✨')});

/* ---------- Party days: purely decorative, never load-bearing ---------- */
// Bank holidays come from gov.uk's feed (England and Wales). Its "bunting" flag marks the celebratory
// ones (Good Friday gets false). The rest are fixed dates, plus a record jackpot in the stored history.
// The animation plays once per app open, on its own layer with pointer-events off, removes itself,
// and can't break startup. Preview any of them with ?party=<key>, e.g. ?party=halloween.
const PARTIES=['bunting','xmas','newyear','easter','halloween','bonfire','valentine','firstdraw','record'];
const HOLS_URL='https://www.gov.uk/bank-holidays.json';
const FIRST_DRAW={main:[3,5,14,22,30,44],bonus:10}; // Lotto, Sat 19 Nov 1994
let partyRan=false;
async function syncHolidays(){
  if(typeof fetch!=='function'||partyPreview()==='none')return false;
  if(LS.get('hols',null)&&Date.now()-LS.get('holsAt',0)<20*3600e3)return false; // once a day is plenty
  try{
    const r=await fetch(HOLS_URL);if(!r.ok)return false;
    const j=await r.json(),from=iso(new Date(Date.now()-40*864e5));
    const ev=(j['england-and-wales']?.events||[]).filter(e=>e&&e.date>=from)
      .map(e=>({date:e.date,title:String(e.title||''),bunting:!!e.bunting}));
    const before=JSON.stringify(LS.get('hols',[]));
    LS.set('hols',ev);LS.set('holsAt',Date.now());
    return before!==JSON.stringify(ev);
  }catch(e){return false} // offline: the cached copy (or the fixed-date fallbacks) will do
}
function partyFor(d=new Date(),hols=LS.get('hols',[])){
  const m=d.getMonth()+1,day=d.getDate(),h=(hols||[]).find(e=>e.date===iso(d));
  if(h&&h.bunting){
    if(/christmas|boxing/i.test(h.title))return 'xmas';
    if(/new year/i.test(h.title))return 'newyear';
    if(/easter/i.test(h.title))return 'easter';
    return 'bunting';
  }
  if(m===12&&(day===25||day===26))return 'xmas'; // even when the bank holiday moves to a weekday
  if(m===1&&day===1)return 'newyear';
  if(m===10&&day===31)return 'halloween';
  if(m===11&&day===5)return 'bonfire';
  if(m===2&&day===14)return 'valentine';
  if(m===11&&day===19)return 'firstdraw';
  return null;
}
// The latest draw (within 3 days) has a bigger jackpot than any earlier draw in the stored history.
// Needs 100+ earlier draws with a jackpot recorded, so gaps in imported history can't fake a record.
function recordJackpot(now=new Date()){
  if(settings.demo)return null;
  for(const g of Object.values(GAMES)){
    const ds=state.live[g.key]||[];
    const last=ds.reduce((m,d)=>d.date>m?d.date:m,'');if(!last)continue;
    const age=(now-new Date(last+'T12:00:00'))/864e5;if(age<0||age>3)continue;
    const top=Math.max(0,...ds.filter(d=>d.date===last).map(d=>d.jackpot||0));
    const earlier=ds.filter(d=>d.date<last&&d.jackpot>0);
    if(top>0&&earlier.length>=100&&top>Math.max(...earlier.map(d=>d.jackpot)))return {g,jackpot:top};
  }
  return null;
}
// ?party=none turns it all off (the tests use it, so they don't depend on today's date or reach gov.uk)
function partyPreview(){try{const p=new URLSearchParams(location.search).get('party');return p==='none'||PARTIES.includes(p)?p:null}catch(e){return null}}
function partyToday(){try{const p=partyPreview();if(p)return p==='none'?null:p;return partyFor()||(recordJackpot()?'record':null)}catch(e){return null}}

// Static header decorations (no motion needed, so these show with reduced motion too)
const PARTY_FLAGS=['#f7c948','#ff5fa8','#a066ff','#2f86ff','#33cc66'];
function partyHeaderHTML(k){
  if(k==='bunting'||k==='newyear'||k==='easter'){
    return `<div class="bunting" aria-hidden="true">${Array.from({length:22},(_,i)=>`<i style="background:${PARTY_FLAGS[i%5]};animation-delay:${(i%4)*.25}s"></i>`).join('')}</div>`;
  }
  if(k==='xmas'){
    const n=13,cols=['#ff4d5e','#33cc66','#f7c948','#2f86ff','#f3f3f8'];
    const bulbs=Array.from({length:n},(_,i)=>{const x=(i+.5)/n*100,y=6+Math.sin((i+.5)/n*Math.PI*3)**2*9;
      return `<i style="left:${x}%;top:${y}px;--c:${cols[i%5]};animation-delay:${(i%3)*.5}s"></i>`}).join('');
    return `<div class="xlights" aria-hidden="true"><svg viewBox="0 0 100 20" preserveAspectRatio="none"><path d="${Array.from({length:61},(_,i)=>`${i?'L':'M'}${i/60*100},${4+Math.sin(i/60*Math.PI*3)**2*9}`).join('')}" fill="none" stroke="#2d6b3a" stroke-width="1.4" vector-effect="non-scaling-stroke"/></svg>${bulbs}</div>`;
  }
  return '';
}

// ---- Animation helpers ----
const PARTY_MSG={
  bunting:"It's a bunting day. The odds haven't moved.",
  xmas:'Merry Christmas. Every line still has the same chance.',
  newyear:'Happy New Year. Same odds.',
  easter:'Happy Easter. No egg is more likely than another.',
  halloween:'Happy Halloween. No number is cursed.',
  bonfire:'Remember, remember: every line has the same chance.',
  valentine:"Happy Valentine's Day. The odds still don't love you.",
  firstdraw:`On this day in 1994, the first UK Lotto draw: ${FIRST_DRAW.main.join(', ')}, bonus ${FIRST_DRAW.bonus}.`,
};
function partyLayer(ms){
  const el=document.createElement('div');el.className='party';el.setAttribute('aria-hidden','true');
  document.body.appendChild(el);
  el.animate([{opacity:1},{opacity:1,offset:.9},{opacity:0}],{duration:ms,fill:'forwards'});
  setTimeout(()=>el.remove(),ms+200);
  return el;
}
function partySprite(layer,html,w,h=w){
  const s=document.createElement('div');s.className='party-sp';s.style.width=w+'px';s.style.height=h+'px';
  s.innerHTML=html;layer.appendChild(s);return s;
}
const PARTY_FLOOR=200; // px from the bottom: piles and pumpkins stay above the nav bar and the message
const pick=a=>a[Math.floor(rand()*a.length)];
const lottoBall=(n,s)=>`<span class="ball c${Math.floor(n/10)}" style="--s:${s}px"><b>${n}</b></span>`;
const plainBall=(c,s)=>`<span class="ball ${c}" style="--s:${s}px"></span>`;

// Things tumble through a Galton board of pegs and pile up in the bins, like the Story page.
function pegDrop(layer,{n,size,make,spin=0,stagger=3200,fall=2400}){
  const vw=innerWidth,vh=innerHeight,rows=9,dx=Math.min(40,(vw-32)/(rows+1)),cx=vw/2;
  const top=Math.max(90,vh*.14),bot=vh-PARTY_FLOOR,dy=(bot-top-size*4)/rows;
  const pegs=[];for(let r=0;r<rows;r++)for(let i=0;i<=r;i++)pegs.push(`<circle cx="${cx+(i-r/2)*dx}" cy="${top+r*dy+size*.5}" r="3"/>`);
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
  svg.setAttribute('class','party-pegs');svg.setAttribute('width',vw);svg.setAttribute('height',vh);svg.innerHTML=pegs.join('');
  layer.appendChild(svg);
  svg.animate([{opacity:0},{opacity:.45,offset:.12},{opacity:.45,offset:.8},{opacity:0}],{duration:stagger+fall+1500,fill:'forwards'});
  const counts=Array(rows+1).fill(0);
  for(let i=0;i<n;i++){
    const path=galtonPath(rows,rand),k=path.filter(d=>d>0).length;
    let s=0,rot=0;const at=(x,y,o,e='cubic-bezier(.45,0,.8,.55)')=>({transform:`translate(${x-size/2}px,${y-size}px) rotate(${rot}deg)`,offset:o,easing:e});
    const fr=[at(cx,-size,0,'ease-in'),at(cx,top,.14)];
    path.forEach((d,r)=>{s+=d;rot+=spin*d*(.6+rand()*.8);fr.push(at(cx+s*dx/2,top+(r+1)*dy,.14+(r+1)/rows*.66))});
    const fy=bot-counts[k]++*size*.82;
    fr.push(at(cx+s*dx/2,fy,.88,'ease-out'),at(cx+s*dx/2,fy-size*.35,.94,'ease-in'),at(cx+s*dx/2,fy,1));
    const sp=partySprite(layer,make(i),size);
    sp.animate(fr,{duration:fall+rand()*500,delay:i/n*stagger+rand()*150,fill:'both'});
  }
  return stagger+fall+500;
}
function fireworks(layer,{bursts,span,colors,balls=false}){
  for(let b=0;b<bursts;b++)setTimeout(()=>firework(layer,colors,balls),b*span/bursts+rand()*250);
}
function firework(layer,colors,balls){
  if(!layer.isConnected)return;
  const vw=innerWidth,vh=innerHeight,x=vw*(.15+rand()*.7),y=vh*(.14+rand()*.32),col=pick(colors);
  const rk=partySprite(layer,'',5,5);rk.className='party-sp party-spark';rk.style.setProperty('--c','#ffe48a');
  const up=rk.animate([{transform:`translate(${x}px,${vh}px)`},{transform:`translate(${x}px,${y}px)`}],{duration:650+rand()*200,easing:'cubic-bezier(.2,.7,.4,1)',fill:'forwards'});
  up.onfinish=()=>{
    rk.remove();if(!layer.isConnected)return;
    const n=balls?14:18,rad=70+rand()*60;
    for(let p=0;p<n;p++){
      const a=p/n*Math.PI*2,ox=Math.cos(a)*rad,oy=Math.sin(a)*rad,s=balls?14:6;
      const c=balls?pick(['c1','c2','c3','c4','c5','c0']):'';
      const el=partySprite(layer,balls?plainBall(c,s):'',s);
      if(!balls){el.className='party-sp party-spark';el.style.setProperty('--c',p%3?col:pick(colors))}
      el.animate([{transform:`translate(${x-s/2}px,${y-s/2}px) scale(.4)`,opacity:1},
        {transform:`translate(${x+ox-s/2}px,${y+oy-s/2}px) scale(1)`,opacity:1,offset:.45,easing:'ease-in'},
        {transform:`translate(${x+ox*1.15-s/2}px,${y+oy+90-s/2}px) scale(.8)`,opacity:0}],{duration:1500+rand()*400,easing:'ease-out',fill:'forwards'});
    }
  };
}
const GHOST_SVG='<svg viewBox="0 0 100 110" width="100%" height="100%"><defs><linearGradient id="pgGhost" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f4f2ea" stop-opacity=".75"/><stop offset=".6" stop-color="#e9ddff" stop-opacity=".5"/><stop offset="1" stop-color="#e9ddff" stop-opacity=".05"/></linearGradient></defs><path d="M50 6C22 6 8 28 8 55V95c0 5 6 6 9 2l7-9c2-3 6-3 8 0l6 8c2 3 6 3 8 0l4-6 4 6c2 3 6 3 8 0l6-8c2-3 6-3 8 0l7 9c3 4 9 3 9-2V55C92 28 78 6 50 6Z" fill="url(#pgGhost)"/><ellipse cx="36" cy="46" rx="6" ry="8" fill="#1a0b3d" opacity=".55"/><ellipse cx="64" cy="46" rx="6" ry="8" fill="#1a0b3d" opacity=".55"/><ellipse cx="50" cy="68" rx="7" ry="9" fill="#1a0b3d" opacity=".45"/></svg>';
const PUMPKIN_SVG='<svg viewBox="0 0 100 100" width="100%" height="100%"><path d="M50 18c-4-10 2-15 9-14" stroke="#3f7a2a" stroke-width="6" fill="none" stroke-linecap="round"/><ellipse cx="50" cy="58" rx="46" ry="38" fill="#ff8a1f"/><ellipse cx="50" cy="58" rx="26" ry="38" fill="none" stroke="#d9640a" stroke-width="3"/><ellipse cx="50" cy="58" rx="9" ry="38" fill="none" stroke="#d9640a" stroke-width="3"/><path d="M28 48l9-12 9 12zM54 48l9-12 9 12z" fill="#3a1500"/><path d="M24 64q26 22 52 0l-7 3-5 6-6-5-7 6-6-6-7 5-5-6z" fill="#3a1500"/><ellipse cx="34" cy="40" rx="8" ry="5" fill="#fff" opacity=".25"/></svg>';
const BAT_SVG='<svg viewBox="0 0 100 50" width="100%" height="100%"><g class="party-wing"><path d="M50 22C42 6 22 2 2 12c10 4 12 12 10 20 10-8 18-6 24 2 4-6 8-8 14-6 6-2 10 0 14 6 6-8 14-10 24-2-2-8 0-16 10-20C78 2 58 6 50 22Z" fill="#14081f"/></g><circle cx="46" cy="20" r="1.6" fill="#ffb648"/><circle cx="54" cy="20" r="1.6" fill="#ffb648"/></svg>';
const heartSVG=c=>`<svg viewBox="0 0 100 92" width="100%" height="100%"><path d="M50 88C20 64 4 48 4 28 4 13 16 3 29 3c9 0 16 5 21 12C55 8 62 3 71 3c13 0 25 10 25 25 0 20-16 36-46 60Z" fill="${c}"/><ellipse cx="28" cy="24" rx="10" ry="6" fill="#fff" opacity=".35" transform="rotate(-30 28 24)"/></svg>`;
const eggSVG=(c,s)=>`<svg viewBox="0 0 80 100" width="100%" height="100%"><path d="M40 2C18 2 4 40 4 62c0 21 16 36 36 36s36-15 36-36C76 40 62 2 40 2Z" fill="${c}"/><path d="M6 52l9-7 9 7 8-7 8 7 8-7 8 7 9-7 9 7" stroke="${s}" stroke-width="5" fill="none" stroke-linejoin="round"/><path d="M6 70h68" stroke="${s}" stroke-width="4" stroke-dasharray="2 8" stroke-linecap="round"/><ellipse cx="26" cy="30" rx="7" ry="12" fill="#fff" opacity=".35" transform="rotate(20 26 30)"/></svg>`;
const SNOW_SVG='<svg viewBox="-10 -10 20 20" width="100%" height="100%"><g stroke="#fff" stroke-width="1.6" stroke-linecap="round"><path d="M0-9V9M-7.8-4.5 7.8 4.5M-7.8 4.5 7.8-4.5"/><path d="M-2-7 0-5 2-7M-2 7 0 5 2 7" fill="none"/></g></svg>';
const bauble=c=>`<svg viewBox="0 0 40 46" width="100%" height="100%"><rect x="15" y="2" width="10" height="7" rx="2" fill="#d8b24a"/><circle cx="20" cy="27" r="18" fill="${c}"/><circle cx="13" cy="20" r="5" fill="#fff" opacity=".45"/></svg>`;

function partyHalloween(layer){
  const vw=innerWidth,vh=innerHeight;
  // Ghost drifts across from one side to another
  const gw=Math.max(150,Math.min(240,vw*.48)),gh=gw*1.1,ghost=partySprite(layer,GHOST_SVG,gw,gh);
  const side=rand()<.5,ty=vh*(.15+rand()*.35);
  ghost.animate([{transform:`translate(${side?-gw:vw}px,${ty}px) rotate(${side?8:-8}deg)`,opacity:0},
    {opacity:1,offset:.12},{transform:`translate(${vw/2-gw/2}px,${ty-60}px) rotate(0deg)`,offset:.5},{opacity:1,offset:.85},
    {transform:`translate(${side?vw:-gw}px,${ty+40}px) rotate(${side?-8:8}deg)`,opacity:0}],{duration:8000,easing:'ease-in-out',fill:'forwards'});
  // Pumpkins roll along the bottom, like balls with faces
  for(let i=0;i<4;i++){
    const s=40+rand()*22,y=vh-PARTY_FLOOR-s,dir=i%2?-1:1,dist=vw+s*2,turns=dist/(Math.PI*s)*360;
    const p=partySprite(layer,PUMPKIN_SVG,s);
    p.animate([{transform:`translate(${dir>0?-s:vw}px,${y}px) rotate(0deg)`},{transform:`translate(${dir>0?vw:-s}px,${y}px) rotate(${dir*turns}deg)`}],
      {duration:4200+rand()*1500,delay:600+i*1300,easing:'linear',fill:'both'});
  }
  // Bats flap across the top
  for(let i=0;i<6;i++){
    const w=36+rand()*26,y0=60+rand()*vh*.3,dir=rand()<.5?1:-1,b=partySprite(layer,BAT_SVG,w,w/2),fr=[];
    for(let t=0;t<=8;t++){const x=dir>0?-w+(vw+w*2)*t/8:vw+w-(vw+w*2)*t/8;fr.push({transform:`translate(${x}px,${y0+Math.sin(t*1.4)*30}px) scaleX(${-dir})`})}
    b.animate(fr,{duration:3500+rand()*2000,delay:rand()*4500,easing:'ease-in-out',fill:'both'});
  }
  return 9000;
}

function runParty(k){
  if(!k||partyRan)return;partyRan=true;
  try{
    if(k==='record'){const r=recordJackpot();if(r)toast(`${r.g.name}: ${money(r.jackpot)}, the biggest jackpot in the stored history.`,5500)}
    else if(PARTY_MSG[k])toast(PARTY_MSG[k],5500);
    if(typeof document.body.animate!=='function'||window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)return;
    const L=GAMES.lotto,layer=partyLayer(10000);let n;
    switch(k){
      case 'bunting':{const nums=pickDistinct(rand,30,L.mainMax);pegDrop(layer,{n:30,size:30,make:i=>lottoBall(nums[i],30)});break}
      case 'xmas':pegDrop(layer,{n:56,size:18,stagger:4600,fall:3200,spin:40,make:i=>i%7===3?bauble(pick(['#ff4d5e','#33cc66','#f7c948','#2f86ff'])):SNOW_SVG});break;
      case 'newyear':fireworks(layer,{bursts:9,span:6000,colors:['#f7c948','#ffe48a','#fff'],balls:true});break;
      case 'easter':pegDrop(layer,{n:26,size:30,spin:25,make:()=>{const c=pick([['#ffd1e8','#ff5fa8'],['#cfe8ff','#2f86ff'],['#d8ffe0','#33cc66'],['#fff2b8','#f7c948'],['#ead9ff','#a066ff']]);return eggSVG(c[0],c[1])}});break;
      case 'halloween':partyHalloween(layer);break;
      case 'bonfire':fireworks(layer,{bursts:10,span:6200,colors:['#f7c948','#ff5fa8','#a066ff','#ff8a1f','#ffe48a','#2f86ff']});break;
      case 'valentine':pegDrop(layer,{n:30,size:28,spin:20,make:()=>heartSVG(pick(['#ff4d6d','#ff5fa8','#ff9ad5','#f7c948','#d6336c']))});break;
      case 'firstdraw':n=[...FIRST_DRAW.main,FIRST_DRAW.bonus];pegDrop(layer,{n:7,size:40,stagger:3000,make:i=>lottoBall(n[i],40)});break;
      case 'record':pegDrop(layer,{n:36,size:24,make:()=>plainBall('c4',24)});fireworks(layer,{bursts:4,span:4000,colors:['#f7c948','#ffe48a'],balls:false});break;
    }
  }catch(e){/* decorative only */}
}

/* ---------- Boot ---------- */
(async()=>{
  await DB.open();
  for(const k of Object.keys(GAMES))state.live[k]=(await DB.get('draws_'+k))||[];
  render();
  runParty(partyToday());
  syncHolidays().then(ch=>{if(ch){render();runParty(partyToday())}});
  maybeAutoSync();
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')maybeAutoSync()});
  window.addEventListener('online',()=>maybeAutoSync()); // signal back: try again straight away
  if('serviceWorker' in navigator)try{navigator.serviceWorker.register('sw.js')}catch(e){}
})();
