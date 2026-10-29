// Loads index.html + src/app.js into a fresh jsdom window, in demo mode, and returns a way to reach
// the app's top-level functions and constants (which live in the page's global scope).
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

function loadApp({ settings, stats = true } = {}) {
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/<script src="src\/app\.js[^"]*"><\/script>/, '');
  const js = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => { if (!/Not implemented/.test(e.message)) errors.push(e); });
  const dom = new JSDOM(html, { url: 'https://lottolab.test/', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  w.scrollTo = () => {};
  // No real animation frames in tests: a running loop would keep the test process alive.
  // Tests that need the bean machine animation drive bmTick() by hand.
  w.requestAnimationFrame = () => 0;
  w.cancelAnimationFrame = () => {};
  // Tests run in sample mode with no Worker unless they say otherwise (the app's own default is the real Worker)
  w.localStorage.setItem('ll_settings', JSON.stringify(settings ?? { demo: true, workerUrl: '' }));
  // Stats are unlocked unless a test is about the lock itself
  if (stats) w.localStorage.setItem('ll_statsAccess', JSON.stringify({ code: '', ok: true }));
  // A real classic <script>, as in the browser, so top-level const/function bindings are global
  const el = w.document.createElement('script');
  el.textContent = js;
  w.document.body.appendChild(el);
  return { window: w, dom, errors, get: expr => w.eval(expr) };
}

module.exports = { loadApp };
