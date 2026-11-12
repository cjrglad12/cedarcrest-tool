const { chromium, devices } = require('playwright');
// Messy-round checks in a phone-sized browser. Start the dev server (npm run dev -- --port 5173),
// then run: node tests/e2e/messy-rounds.cjs /tmp
const S = process.argv[2] || '/tmp';
const BASE = 'http://127.0.0.1:5173/';
const SEED = JSON.stringify({ version: 1, settings: { onboarded: true, measureHint: false, simulateGps: true } });
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); ok ? pass++ : fail++; };

async function fresh(b, { seed = SEED, hash = '1', offline = false } = {}) {
  const ctx = await b.newContext({ ...devices['iPhone 13'], deviceScaleFactor: 1 });
  if (seed !== null) await ctx.addInitScript((st) => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('cedarcrest.v1', st); sessionStorage.setItem('seeded', '1'); } }, seed);
  const p = await ctx.newPage();
  p.errors = [];
  p.on('pageerror', (e) => p.errors.push(e.message));
  await p.goto(BASE + '#' + hash);
  await p.waitForFunction(() => window.__app && window.__app.scene, null, { timeout: 30000 });
  await p.waitForTimeout(1500);
  if (offline) await ctx.setOffline(true);
  return p;
}
const st = (p) => p.evaluate(() => JSON.parse(localStorage.getItem('cedarcrest.v1')));
const click = async (p, sel) => { await p.click(sel); await p.waitForTimeout(200); };
const tapMap = (p, fn) => p.evaluate(`(() => { const a = window.__app; const h = a.course.hole(a.ref); const t = h.tees[Math.floor((h.tees.length-1)/2)].center; const pin = h.pin; const lerp=(u,v,k)=>[u[0]+(v[0]-u[0])*k,u[1]+(v[1]-u[1])*k]; a.scene.onTap(${fn}); })()`);
// Save a quick-scored hole, then go on with "Next hole" (unless the scorecard opened).
async function saveHole(p) {
  if (!(await p.locator('[data-act=savehole]').count())) throw new Error('no Save hole button: ' + (await p.evaluate(() => document.querySelector('#top').innerText + ' / ' + document.querySelector('#panel').innerText.slice(0, 200))));
  await click(p, '[data-act=savehole]');
  const next = p.locator('#panel [data-act=next]');
  if (await p.evaluate(() => document.querySelector('#modal').hidden) && await next.count()) await click(p, '#panel [data-act=next]');
}
// Mark a shot: press Mark shot, tap where the ball is, pick the club.
async function mark(p, where, club) { await click(p, '[data-act=mark]'); await tapMap(p, where); await p.waitForTimeout(200); await click(p, `[data-club="${club}"]`); }

(async () => {
  const b = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });

  // 1. Start on 10, play the back nine with quick scoring, end the round.
  { const p = await fresh(b, { hash: '10' });
    await click(p, '[data-tab=play]'); await click(p, '[data-act=trackshots][data-v="0"]'); await click(p, '[data-act=startround]');
    for (let i = 0; i < 9; i++) { await saveHole(p); await p.waitForTimeout(400); }
    await p.waitForTimeout(500);
    await click(p, '[data-act=closemodal]').catch(() => {});
    await click(p, '[data-act=endround]'); await click(p, '[data-ans=yes]'); await click(p, '[data-ans=no]').catch(() => {}); await click(p, '[data-act=closemodal]').catch(() => {});
    const s = await st(p); const r = s.rounds[0];
    const refs = Object.keys(r.holes).map(Number).sort((a, c) => a - c);
    check('Start on 10, play 9 holes', r.finished && refs.join() === '10,11,12,13,14,15,16,17,18', `holes ${refs.join()}`);
    check('  scores saved as par', Object.values(r.holes).every((h) => h.done && h.strokes >= 3));
    check('  no errors', !p.errors.length, p.errors.join('; '));
    await p.context().close(); }

  // 2. App closed right after marking a shot.
  { const p = await fresh(b);
    await click(p, '[data-tab=play]'); await click(p, '[data-act=trackshots][data-v="1"]'); await click(p, '[data-act=startround]');
    await mark(p, 't', 'Driver');
    await p.reload(); await p.waitForFunction(() => window.__app && window.__app.scene); await p.waitForTimeout(1000);
    const s = await st(p); const r = s.rounds.find((x) => x.id === s.activeRoundId);
    check('Reload right after marking a shot keeps it', r && r.holes[1].shots.length === 1);
    const tab = await p.evaluate(() => window.__app.tab);
    check('  reopens on the Play tab with the round active', tab === 'play');
    await p.context().close(); }

  // 3. Hole out from the fairway, and a lost ball (stroke and distance).
  { const p = await fresh(b);
    await click(p, '[data-tab=play]'); await click(p, '[data-act=trackshots][data-v="1"]'); await click(p, '[data-act=startround]');
    await mark(p, 't', 'Driver'); await mark(p, 'lerp(t,pin,0.6)', '7 Iron');
    await click(p, '[data-act=holedout]');
    let s = await st(p); let h = s.rounds[0].holes[1];
    const v1 = await p.evaluate(() => { const a = window.__app; return a.state.rounds[0] && window.__score1; });
    check('Hole out from the fairway counts 2 strokes, 0 putts', h.done && h.putts === 0 && h.shots.length === 2);
    await click(p, '[data-act=next]');
    await mark(p, 't', 'Driver'); await click(p, '[data-act=more]'); await click(p, '[data-act=pen][data-i="0"]'); await click(p, '[data-act=more]'); // lost: stroke and distance
    await mark(p, 't', 'Driver'); await mark(p, 'lerp(t,pin,0.7)', '8 Iron');
    await click(p, '[data-act=ongreen]'); await tapMap(p, 'lerp(pin,t,0.02)'); await p.waitForTimeout(200);
    for (let k = 0; k < 4 && (await st(p)).rounds[0].holes[2].putts < 2; k++) await click(p, '[data-act=putt][data-d="1"]');
    await click(p, '[data-act=finish]');
    s = await st(p); h = s.rounds[0].holes[2];
    const score = h.shots.length + h.shots.reduce((a, x) => a + x.penalty, 0) + h.putts;
    check('Lost ball off the tee (re-tee + penalty) scores correctly', score === 6, `score ${score}`);
    await p.context().close(); }

  // 4. Skipped holes, then two rounds the same day.
  { const p = await fresh(b);
    await click(p, '[data-tab=play]'); await click(p, '[data-act=trackshots][data-v="0"]'); await click(p, '[data-act=startround]');
    await saveHole(p); await p.waitForTimeout(300);
    for (let i = 0; i < 3; i++) await click(p, '#top [data-act=next]');
    await saveHole(p); await p.waitForTimeout(300);
    await click(p, '[data-act=endround]'); await click(p, '[data-ans=yes]'); await click(p, '[data-ans=no]').catch(() => {}); await click(p, '[data-act=closemodal]').catch(() => {});
    await click(p, '[data-tab=play]'); await click(p, '[data-act=startround]'); await saveHole(p); await p.waitForTimeout(300);
    await click(p, '[data-act=endround]'); await click(p, '[data-ans=yes]'); await click(p, '[data-ans=no]').catch(() => {}); await click(p, '[data-act=closemodal]').catch(() => {});
    const s = await st(p);
    check('Skipped holes are left out, not scored', Object.keys(s.rounds[0].holes).join() === '1,5', Object.keys(s.rounds[0].holes).join());
    check('Two rounds on the same day are kept separately', s.rounds.length === 2 && s.rounds[0].id !== s.rounds[1].id);
    await p.context().close(); }

  // 5. Damaged saved data.
  { const p = await fresh(b, { seed: '{"version":1,"rounds":[{"broken' });
    const keys = await p.evaluate(() => Object.keys(localStorage));
    check('Unreadable saved data is kept, not overwritten', keys.some((k) => k.startsWith('cedarcrest.v1.unreadable-')), keys.join());
    check('  app still opens', !p.errors.length, p.errors.join('; '));
    await p.context().close(); }

  // 6. No signal mid-round.
  { const p = await fresh(b, { offline: true });
    await click(p, '[data-tab=play]'); await click(p, '[data-act=trackshots][data-v="0"]'); await click(p, '[data-act=startround]');
    await p.waitForTimeout(1500);
    await saveHole(p); await p.waitForTimeout(300);
    const s = await st(p);
    check('No signal: round starts and scores save', s.rounds[0].holes[1].done);
    check('  no errors', !p.errors.length, p.errors.join('; '));
    await p.context().close(); }

  // 7. Phone storage full.
  { const p = await fresh(b);
    await p.evaluate(() => { const orig = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (k === 'cedarcrest.v1') throw new DOMException('full', 'QuotaExceededError'); return orig.call(this, k, v); }; });
    await click(p, '[data-tab=play]'); await click(p, '[data-act=startround]'); await p.waitForTimeout(300);
    const toast = await p.evaluate(() => document.querySelector('#toast').textContent);
    check('Storage full shows a warning', /storage may be full/i.test(toast), toast);
    check('  app keeps working', !p.errors.length, p.errors.join('; '));
    await p.context().close(); }

  // 8. Full 18 with a blow-up hole: adjusted gross and differential.
  { const p = await fresh(b, { seed: JSON.stringify({ version: 1, settings: { onboarded: true, measureHint: false, simulateGps: true, handicap: 12.4, teeSet: 'back' } }) });
    await click(p, '[data-tab=play]'); await click(p, '[data-act=trackshots][data-v="0"]'); await click(p, '[data-act=startround]');
    for (let i = 0; i < 18; i++) {
      if (i === 9) for (let k = 0; k < 6; k++) await click(p, '[data-act=qs][data-d="1"]'); // 11 on hole 10
      await saveHole(p); await p.waitForTimeout(250);
    }
    await p.waitForTimeout(500);
    const txt = await p.evaluate(() => document.querySelector('#modal').innerText);
    const ags = /(\d+)\s*Adjusted gross/.exec(txt.replace(/\n/g, ' '));
    check('18 holes: scorecard shows adjusted gross and differential', !!ags && /Differential/.test(txt), ags ? `adjusted gross ${ags[1]} (gross ${71 + 6})` : txt.slice(0, 120));
    check('  blow-up hole capped at net double bogey', ags && +ags[1] === 71 + 6 - (11 - 8), '');
    await p.screenshot({ path: `${S}/m8-scorecard.png` });
    await p.context().close(); }

  console.log(`\n${pass} passed, ${fail} failed`);
  await b.close();
})();
