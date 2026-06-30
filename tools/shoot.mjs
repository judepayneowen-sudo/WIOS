#!/usr/bin/env node
/*
 * shoot.mjs — headless screenshot harness for the WHOOP Core web app.
 *
 * Renders www/ in Chromium with ?demo=1 (seeds ~10 sample days so screens fill) and screenshots each named screen
 * at iPhone size. Lets us iterate on the UI design without a SideStore build: edit src/ → npm run build:web →
 * node tools/shoot.mjs → look at the PNGs.
 *
 *   npm run build:web && node tools/shoot.mjs                 # default screens → shots/
 *   node tools/shoot.mjs overview recovery sleep strain trends
 *   PW_CHROMIUM=/path/to/chrome node tools/shoot.mjs          # override the browser binary
 *
 * Needs playwright-core (devDependency) + a Chromium binary. In the managed dev env the binary is preinstalled
 * under /opt/pw-browsers and auto-detected; elsewhere set PW_CHROMIUM. Output dir defaults to <repo>/shots
 * (gitignored) or $SHOOT_OUT.
 */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WWW  = path.join(ROOT, 'www');
const OUT  = process.env.SHOOT_OUT || path.join(ROOT, 'shots');

// Screens reachable from Home: overview is the tab; recovery/sleep/strain are data-go links on it; trends via profile.
const TARGETS = process.argv.slice(2).length ? process.argv.slice(2) : ['overview', 'recovery', 'sleep', 'strain'];

function findChromium(){
  if(process.env.PW_CHROMIUM && existsSync(process.env.PW_CHROMIUM)) return process.env.PW_CHROMIUM;
  const baseDirs = ['/opt/pw-browsers', process.env.PLAYWRIGHT_BROWSERS_PATH].filter(Boolean);
  for(const base of baseDirs){
    if(!existsSync(base)) continue;
    for(const d of readdirSync(base).filter(n=>n.startsWith('chromium-')).sort().reverse()){
      const exe = path.join(base, d, 'chrome-linux', 'chrome');
      if(existsSync(exe)) return exe;
    }
  }
  return null;   // let playwright try its own default
}

const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.png':'image/png', '.svg':'image/svg+xml' };
function serve(){
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]); if(p === '/') p = '/index.html';
    const f = path.join(WWW, p);
    if(!existsSync(f)){ res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
    res.end(readFileSync(f));
  });
  return server;
}

mkdirSync(OUT, { recursive: true });
const exe = findChromium();
const server = serve();
await new Promise(r => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}/?demo=1`;

const browser = await chromium.launch({ executablePath: exe || undefined, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
page.on('console', m => { if(m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });

await page.goto(base, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

const shoot = async (name) => { await page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: true }); console.log('  shot', name); };
const home  = async () => { await page.click('#tabs button[data-tab=overview]'); await page.waitForTimeout(400); };

for(const t of TARGETS){
  if(t === 'overview'){ await home(); await shoot('overview'); continue; }
  await home();
  const link = await page.$(`[data-go="${t}"]`);
  if(!link){ console.log('  (no data-go for ' + t + ' — skipped)'); continue; }
  await link.click();
  await page.waitForTimeout(600);
  await shoot(t);
}

console.log(exe ? `chromium: ${exe}` : 'chromium: playwright default');
console.log('console errors:', errors.length);
errors.slice(0, 12).forEach(e => console.log('  ! ' + e.slice(0, 160)));
await browser.close();
server.close();
console.log('done →', OUT);
