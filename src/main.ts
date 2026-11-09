import './styles.css';
import { bestFix } from './gps';
import { Course, Hole, XY, Lie, dist, bearing, toYds, teeFor, pointInFeature } from './course';
import { HoleScene, dispersion, ViewName } from './scene';
import { Conditions, fetchConditions, windComponents, playsLike, compass } from './conditions';
import { suggest, buildPlan, evaluate, Option, Ctx } from './advice';
import { analyzeRound, analyzeHole, clubStats, effectiveBag, holeHistory, ClubStat } from './stats';
import { CATEGORY_LABEL, Category } from './sg';
import { loadState, saveState, saveNow, migrate, uid, freshState, State, Round, HoleRec, HolePlan, TeeSet, Club, DEFAULT_BAG } from './store';

type Tab = 'plan' | 'play' | 'stats';
type Mode = null | { kind: 'aim'; step: number } | { kind: 'pin' } | { kind: 'sim' } | { kind: 'green' };

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const y0 = (m: number) => Math.round(toYds(m));
const sgn = (v: number, d = 1) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(d);

const app = {
  course: null as unknown as Course,
  scene: null as unknown as HoleScene,
  state: loadState(),
  ref: 1,
  tab: 'plan' as Tab,
  mode: null as Mode,
  options: null as Option[] | null,
  optFrom: null as XY | null,
  selOpt: 0,
  measure: null as XY | null,
  gps: null as { xy: XY; acc: number; at: number } | null,
  gpsError: '' as string,
  sim: null as XY | null,
  showHistory: false,
  stats: [] as ClubStat[],
  bag: [] as Club[],
  watchId: null as number | null,
  fixes: [] as { xy: XY; acc: number; at: number }[], // recent GPS readings
};

// ---------------- helpers ----------------
const S = () => app.state;
const save = () => saveState(app.state);
const hole = (): Hole => app.course.hole(app.ref);
const round = (): Round | null => S().rounds.find((r) => r.id === S().activeRoundId) ?? null;
const holeRec = (): HoleRec | null => round()?.holes[app.ref] ?? null;
const teeSet = (): TeeSet => round()?.teeSet ?? S().settings.teeSet;
const tee = () => teeFor(hole(), teeSet());
const planPin = (): XY => S().pins[app.ref] ?? hole().pin;
const pin = (): XY => (app.tab === 'play' && holeRec()?.pin) || planPin();
const cond = (): Conditions => round()?.conditions ?? S().conditions;
const plan = (): HolePlan => S().plans[app.ref] ?? { steps: [], notes: '', updated: '' };
const setPlan = (p: HolePlan) => { S().plans[app.ref] = { ...p, updated: new Date().toISOString() }; save(); };
const farFromCourse = () => !app.gps || dist(app.gps.xy, [0, 0]) > 2500;
const usingSim = () => S().settings.simulateGps || (farFromCourse() && !!app.sim);
const myPos = (): XY | null => (usingSim() ? app.sim : app.gps?.xy ?? null);

function refreshBag() {
  app.stats = clubStats(app.course, S());
  app.bag = effectiveBag(S(), app.stats);
}

function ctx(from: XY, lie: Lie): Ctx {
  return { course: app.course, hole: hole(), from, lie, pin: pin(), cond: cond(), bag: app.bag, handicap: S().settings.handicap };
}

function toast(msg: string, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout((t as any)._h); (t as any)._h = setTimeout(() => t.classList.remove('show'), ms);
}

function plays(from: XY, to: XY) {
  const d = dist(from, to);
  const rise = app.course.height(to[0], to[1]) - app.course.height(from[0], from[1]);
  return { d: y0(d), plays: y0(playsLike(d, rise, cond(), bearing(from, to))), riseFt: Math.round(rise * 3.28) };
}

function windText(from: XY, to: XY) {
  const c = cond();
  if (c.windMph < 1) return 'no wind';
  const { head, cross } = windComponents(c, bearing(from, to));
  const hw = Math.abs(head) < 1.5 ? '' : head > 0 ? `${Math.round(head)} into` : `${Math.round(-head)} helping`;
  const cw = Math.abs(cross) < 1.5 ? '' : `${Math.round(Math.abs(cross))} ${cross > 0 ? 'L→R' : 'R→L'}`;
  return [hw, cw].filter(Boolean).join(', ') || 'Light';
}

// ---------------- header & tabs ----------------
function renderTop() {
  const h = hole(), t = tee();
  const rec = holeRec();
  const score = rec?.done ? ` · scored ${analyzeHole(app.course, rec, S().settings.handicap).score}` : '';
  $('#top').innerHTML = `
    <button class="navbtn" data-act="prev" aria-label="Previous hole">‹</button>
    <div class="hole"><b>Hole ${h.ref}</b> · Par ${h.par}<small>${t.lengthYds} yds · ${teeSet()} tees${score}</small></div>
    <button class="navbtn" data-act="next" aria-label="Next hole">›</button>
    <button class="navbtn" data-act="menu" aria-label="Menu">☰</button>`;
  $('#tabs').innerHTML = (['plan', 'play', 'stats'] as Tab[]).map((k) => `<button data-tab="${k}" class="${app.tab === k ? 'on' : ''}">${{ plan: 'Plan', play: round() ? 'Play ●' : 'Play', stats: 'Stats' }[k]}</button>`).join('');
  const cur = app.scene?.currentView;
  $('#viewbtns').innerHTML = `<button class="compass" data-act="northup" aria-label="Compass: tap for the course map, north up"><i id="needle">▲</i><small>N</small></button>` +
    (['top', 'tee', 'green', 'course'] as ViewName[]).map((v) => `<button data-view="${v}" class="${cur === v ? 'on' : ''}">${{ top: 'Hole', tee: '3D', green: 'Green', course: 'Course' }[v]}</button>`).join('') +
    `<button data-act="wind" class="${S().settings.showWind ? 'on' : ''}" aria-pressed="${S().settings.showWind}">Wind</button>` +
    (myPos() ? '<button data-act="viewme">Me</button>' : '');
  setNeedle(lastNeedle);
}

function renderHint() {
  document.querySelector('.hint')?.remove();
  if (app.tab !== 'plan' || app.mode || !S().settings.measureHint || app.measure) return;
  const el = document.createElement('div');
  el.className = 'hint';
  el.textContent = 'Tap anywhere on the hole to measure';
  $('#view').appendChild(el);
}

function welcome() {
  let hcp = S().settings.handicap, drv = S().bag.find((c) => c.name === 'Driver')?.yds ?? 230, tees = S().settings.teeSet;
  const draw = () => {
    modal(`<h2>Welcome to Cedar Crest</h2>
      <p class="small muted">Three quick questions so the yardages and advice fit your game. You can change them later in ☰.</p>
      <div class="row spread" style="margin-top:12px"><span>Your handicap</span><div class="stepper"><button data-w="hcp" data-d="-1" aria-label="Lower handicap">−</button><b>${hcp}</b><button data-w="hcp" data-d="1" aria-label="Higher handicap">+</button></div></div>
      <div class="row spread" style="margin-top:12px"><span>Driver distance</span><div class="stepper"><button data-w="drv" data-d="-5" aria-label="Shorter">−</button><b>${drv}</b><button data-w="drv" data-d="5" aria-label="Longer">+</button></div></div>
      <div class="small muted" style="margin:12px 0 6px">Tees you usually play</div>
      <div class="seg">${(['back', 'middle', 'forward'] as TeeSet[]).map((t) => `<button class="${t === tees ? 'on' : ''}" data-w="tees" data-v="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div>
      <button class="btn primary wide" style="margin-top:16px" data-w="go">Let's go</button>`);
    $('#modal').onclick = (e) => {
      const b = (e.target as HTMLElement).closest('[data-w]') as HTMLElement | null;
      if (!b) return;
      const w = b.dataset.w;
      if (w === 'hcp') hcp = Math.max(0, Math.min(40, hcp + +b.dataset.d!));
      if (w === 'drv') drv = Math.max(150, Math.min(330, drv + +b.dataset.d!));
      if (w === 'tees') tees = b.dataset.v as TeeSet;
      if (w === 'go') {
        const base = S().bag.find((c) => c.name === 'Driver')?.yds ?? 230;
        const k = drv / base;
        S().bag = S().bag.map((c) => ({ ...c, yds: Math.round(c.yds * k) }));
        Object.assign(S().settings, { handicap: hcp, teeSet: tees, onboarded: true });
        saveNow(S()); refreshBag(); closeModal(); refresh({ camera: true });
        return;
      }
      draw();
    };
  };
  draw();
}

/** Walked onto another hole's tee between holes? Switch to that hole. */
function maybeAdvance() {
  const r = round(), me = app.gps?.xy;
  if (!r || !me || app.mode || usingSim()) return;
  const cur = r.holes[app.ref];
  const midHole = cur && !cur.done && (cur.shots.length > 0 || (cur.quick && cur.strokes !== undefined && cur.strokes !== hole().par));
  if (midHole) return;
  for (const h of app.course.holes) {
    if (h.ref === app.ref || r.holes[h.ref]?.done) continue;
    if (h.tees.some((t) => dist(t.center, me) < 18)) { goHole(h.ref); toast(`You're on the ${h.ref} tee`); return; }
  }
}

function renderModebar() {
  document.querySelector('.modebar')?.remove();
  if (!app.mode) return;
  const text = { aim: `Tap to place shot ${app.mode.kind === 'aim' ? app.mode.step + 1 : ''} target`, pin: 'Tap the green to set the pin', sim: 'Tap where your ball is', green: 'Tap where your ball is on the green' }[app.mode.kind];
  const bar = document.createElement('div');
  bar.className = 'modebar';
  bar.innerHTML = `${text}<button data-act="cancelmode">Cancel</button>`;
  $('#app').appendChild(bar);
}

let lastNeedle = 0;
function setNeedle(deg: number) {
  lastNeedle = deg;
  const n = document.getElementById('needle');
  if (n) n.style.transform = `rotate(${deg}deg)`;
}

// ---------------- 3D overlays ----------------
function redraw() {
  const sc = app.scene;
  sc.clearOverlay();
  sc.setWind(S().settings.showWind ? cond() : null);
  sc.setMe(myPos(), usingSim() ? 2 : app.gps?.acc ?? 5);
  const pinXY = pin();
  if (app.tab === 'plan') {
    const steps = plan().steps;
    let from: XY = tee().center;
    steps.forEach((s, i) => {
      const p = plays(from, s.target);
      sc.addArc({ from, to: s.target, color: '#ffb300', label: `${i + 1}  ${s.club} · ${p.d}` });
      from = s.target;
    });
    if (steps.length && !app.options) {
      const last = steps[steps.length - 1];
      const leave = y0(dist(last.target, pinXY));
      if (leave > 12) sc.addGroundLine(last.target, pinXY, '#ffe082');
    }
  }
  if (app.tab === 'play') {
    const rec = holeRec();
    if (rec) {
      const pts = rec.shots.map((s) => s.start);
      if (rec.greenMark) pts.push(rec.greenMark);
      for (let i = 1; i < pts.length; i++) sc.addArc({ from: pts[i - 1], to: pts[i], color: '#ffffff', label: `${rec.shots[i - 1].club} ${y0(dist(pts[i - 1], pts[i]))}` });
      pts.forEach((p) => sc.addDot(p, '#ffffff', 1));
    }
    const me = myPos();
    if (me && !app.options) sc.addGroundLine(me, pinXY, '#90caf9');
    // Show today's plan faintly
    let from: XY = tee().center;
    for (const s of plan().steps) { sc.addArc({ from, to: s.target, color: '#ffb300', dashed: true, width: 0.35 }); from = s.target; }
  }
  if (app.tab === 'stats' && app.showHistory) {
    const hist = holeHistory(app.course, S(), app.ref).slice(0, 8);
    const palette = ['#ffffff', '#ffd54f', '#80deea', '#f48fb1', '#a5d6a7', '#ce93d8', '#ffab91', '#b0bec5'];
    hist.forEach((h, k) => h.view.shots.forEach((s) => sc.addArc({ from: s.start, to: s.end, color: palette[k % palette.length], width: 1.6, dashed: s.endEstimated })));
  }
  if (app.options && app.optFrom) {
    const o = app.options[app.selOpt];
    if (o) {
      const club = app.bag.find((c) => c.name === o.club)!;
      const disp = dispersion({ ...club, yds: o.carryYds });
      sc.addEllipse({ center: o.aim, along: disp.along * (o.swing < 1 ? 0.8 : 1), across: disp.across, bearing: bearing(app.optFrom, o.aim), color: '#ffb300' });
      sc.addArc({ from: app.optFrom, to: o.aim, color: '#ffb300', label: `${o.club} · ${Math.round(o.carryYds)}` });
    }
  }
  if (app.measure) {
    const from = app.tab === 'play' && myPos() ? myPos()! : tee().center;
    sc.addGroundLine(from, app.measure, '#ffffff');
    sc.addGroundLine(app.measure, pinXY, '#ffffff');
    sc.addLabel(app.measure, `${y0(dist(from, app.measure))} yds · ${y0(dist(app.measure, pinXY))} to pin`);
  }
}

// ---------------- Plan tab ----------------
function renderPlan(): string {
  const h = hole(), t = tee(), pinXY = planPin();
  const gd = app.course.greenDistances(h, t.center, pinXY);
  const p = plays(t.center, pinXY);
  const c = cond();
  const hz = app.course.hazards(h, t.center, pinXY).slice(0, 6);
  const steps = plan().steps;
  let from: XY = t.center;
  const stepRows = steps.map((s, i) => {
    const pl = plays(from, s.target);
    const leave = y0(dist(s.target, pinXY));
    const lie = app.course.lieAt(s.target, h);
    from = s.target;
    return `<li><span class="step">${i + 1}</span>
      <div class="grow"><select class="clubsel" data-act="stepclub" data-i="${i}">${clubOptions(s.club)}</select>
      <div class="small muted">${pl.d} yds${pl.plays !== pl.d ? ` (plays ${pl.plays})` : ''} · <span class="lie">${lie}</span>${leave > 3 ? ` · leaves ${leave}` : ''}</div></div>
      <button class="btn sm" data-act="aim" data-i="${i}">Move</button><button class="btn sm" data-act="delstep" data-i="${i}">✕</button></li>`;
  }).join('');
  const optList = app.options ? renderOptions() : '';
  return `
    <div class="big3">
      <div><b>${y0(gd.front)}</b><span>Front</span></div>
      <div><b>${y0(gd.pin)}</b><span>Pin · plays ${p.plays}</span></div>
      <div><b>${y0(gd.back)}</b><span>Back</span></div>
    </div>
    <div class="row wrap small" style="margin-top:8px">
      <span class="chip" data-act="editwx">💨 ${c.windMph < 1 ? 'Calm' : `${Math.round(c.windMph)} mph ${compass(c.windFrom)} · ${windText(t.center, pinXY)}`}</span>
      <span class="chip">🌡 ${Math.round(c.tempF)}°F</span>
      <span class="chip">${p.riseFt >= 0 ? '▲' : '▼'} ${Math.abs(p.riseFt)} ft</span>
      <button class="btn sm" data-act="wx">${c.fetchedAt ? 'Update' : 'Get'} weather</button>
    </div>

    <h3>Your plan</h3>
    ${steps.length ? `<ul class="list">${stepRows}</ul>` : '<p class="muted small">No plan yet. Let the app suggest one, or add shots and tap the map to place each target.</p>'}
    <div class="row wrap">
      <button class="btn primary" data-act="suggestplan">Suggest best plan</button>
      <button class="btn" data-act="addstep">+ Shot</button>
      ${steps.length ? '<button class="btn danger" data-act="clearplan">Clear</button>' : ''}
    </div>
    ${steps.length ? `<p class="small muted">Expected score with this plan: <b>${planExpected().toFixed(2)}</b> (par ${h.par})</p>` : ''}

    <h3>Compare clubs from the tee</h3>
    ${optList || '<button class="btn" data-act="opts">Show options off the tee</button>'}

    <h3>Hazards from the tee</h3>
    ${hz.length ? `<table><tr><th>Hazard</th><th>Reach</th><th>Carry</th></tr>${hz.map((z) => `<tr><td>${z.kind === 'water' ? '💧 Water' : '⛱ Bunker'} ${z.side}</td><td>${y0(z.reach)}</td><td>${y0(z.carry)}</td></tr>`).join('')}</table>` : '<p class="muted small">No bunkers or water near the line.</p>'}

    <h3>Pin &amp; notes</h3>
    <div class="row wrap"><button class="btn sm" data-act="setpin">Move pin</button>${S().pins[app.ref] ? '<button class="btn sm" data-act="resetpin">Reset pin</button>' : '<span class="small muted">Using the mapped pin</span>'}</div>
    <textarea data-act="notes" placeholder="Notes for this hole (miss short, favor left side…)">${esc(plan().notes)}</textarea>
    <p class="tiny muted">Tap anywhere on the hole to measure. Distances are in yards. "Plays" adjusts for elevation, wind and temperature.</p>`;
}

function planExpected(): number {
  const steps = plan().steps;
  if (!steps.length) return NaN;
  const club = app.bag.find((c) => c.name === steps[0].club) ?? app.bag[0];
  return evaluate(ctx(tee().center, 'tee'), club, bearing(tee().center, steps[0].target), 1, 300).expected;
}

function clubOptions(sel: string) {
  return app.bag.filter((c) => c.on || c.name === sel).map((c) => `<option ${c.name === sel ? 'selected' : ''}>${c.name}</option>`).join('');
}

function renderOptions(): string {
  const opts = app.options!;
  if (!opts.length) return '<p class="muted small">No clubs reach. Check your bag in the menu.</p>';
  const best = opts[0].expected;
  return `<ul class="list">${opts.map((o, i) => `
    <li class="opt ${i === app.selOpt ? 'sel' : ''}" data-act="selopt" data-i="${i}" style="border-radius:10px;padding:8px">
      <div class="grow"><b>${o.club}</b> <span class="small muted">${Math.round(o.carryYds)} yds${o.swing < 0.99 ? ' (soft)' : ''} · leaves ${Math.round(o.leaveYds)}</span>
      <div class="tiny muted">${o.pGreen > 0.02 ? `green ${pct(o.pGreen)} · ` : ''}${o.pFairway > 0.02 ? `fairway ${pct(o.pFairway)} · ` : ''}sand ${pct(o.pSand)} · trees/water/OB ${pct(o.pTrouble)}${o.pOther > 0.02 ? ` · other hole ${pct(o.pOther)}` : ''}</div></div>
      <div style="text-align:right"><b class="num">${o.expected.toFixed(2)}</b><div class="tiny ${i ? 'loss' : 'gain'}">${i ? '+' + (o.expected - best).toFixed(2) : 'best'}</div></div>
    </li>`).join('')}</ul>
    <div class="row wrap"><button class="btn sm primary" data-act="useopt">Use ${opts[app.selOpt].club}</button><button class="btn sm" data-act="closeopts">Hide</button></div>
    <p class="tiny muted">Expected strokes to finish the hole. Based on ${S().settings.useMyNumbers && app.stats.some((s) => s.n >= 5) ? 'your recorded distances and misses' : 'typical numbers for your handicap'}; the yellow oval is where ~80% of shots land.</p>`;
}
const pct = (v: number) => `${Math.round(v * 100)}%`;

// ---------------- Play tab ----------------
function newHoleRec(r: Round): HoleRec {
  const quick = r.trackShots === false;
  return { ref: app.ref, teeId: tee().id, pin: S().pins[app.ref] ?? hole().pin, shots: [], greenMark: null, putts: quick ? 2 : 0, holedFromOff: false, followedPlan: null, done: false, quick, strokes: quick ? hole().par : undefined, fairway: null };
}

function renderPlay(): string {
  const r = round();
  if (!r) {
    const past = S().rounds.filter((x) => x.finished).slice(-3).reverse();
    const track = S().settings.trackShots;
    return `
      <h3>Start a round</h3>
      <div class="small muted" style="margin-bottom:6px">Tees</div>
      <div class="seg">${(['back', 'middle', 'forward'] as TeeSet[]).map((t) => `<button class="${S().settings.teeSet === t ? 'on' : ''}" data-act="teeset" data-v="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div>
      <div class="small muted" style="margin:12px 0 6px">How do you want to keep score?</div>
      <div class="seg">
        <button class="${!track ? 'on' : ''}" data-act="trackshots" data-v="0">Score only<small>Quick: strokes, putts, fairway</small></button>
        <button class="${track ? 'on' : ''}" data-act="trackshots" data-v="1">Track shots<small>GPS each shot: club distances &amp; strokes gained</small></button>
      </div>
      <button class="btn primary wide" style="margin-top:14px" data-act="startround">Start round on hole ${app.ref}</button>
      <p class="tiny muted">You can switch between the two on any hole.</p>
      ${past.length ? `<h3>Recent rounds</h3><ul class="list">${past.map((x) => { const v = analyzeRound(app.course, x, S().settings.handicap); return `<li data-act="scorecard" data-id="${x.id}"><div class="grow">${new Date(x.date).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</div><b>${v.score}</b><span class="muted small">${v.holes.length} holes ›</span></li>`; }).join('')}</ul>` : ''}`;
  }
  let rec = r.holes[app.ref];
  if (!rec) { rec = r.holes[app.ref] = newHoleRec(r); save(); }
  const me = myPos();
  const h = hole();
  let gpsLine = '';
  if (usingSim()) gpsLine = `<div class="banner">${S().settings.simulateGps ? 'Practice mode: tap the map to place your ball.' : 'You\'re away from Cedar Crest. Tap the map to place your ball.'}</div>`;
  else if (app.gpsError) gpsLine = `<div class="banner">GPS: ${esc(app.gpsError)} <button class="btn sm" data-act="simnow">Place by hand</button></div>`;
  else if (!app.gps) gpsLine = '<div class="banner">Finding your location…</div>';
  else if (farFromCourse()) gpsLine = '<div class="banner">You\'re away from Cedar Crest. Tap the map to place your ball. <button class="btn sm" data-act="simnow">OK</button></div>';

  const from = me ?? (rec.shots.length ? rec.shots[rec.shots.length - 1].start : tee().center);
  const gd = app.course.greenDistances(h, from, rec.pin);
  const pl = plays(from, rec.pin);
  const hv = analyzeHole(app.course, rec, S().settings.handicap);
  const toPar = (n: number) => (n === 0 ? 'E' : sgn(n, 0));
  const distances = `
    <div class="big3 play">
      <div><b>${y0(gd.front)}</b><span>Front</span></div>
      <div class="mid"><b>${y0(gd.pin)}</b><span>${pl.plays !== y0(gd.pin) ? `Plays ${pl.plays}` : 'Pin'}</span></div>
      <div><b>${y0(gd.back)}</b><span>Back</span></div>
    </div>
    ${gpsLine || (app.gps ? `<div class="tiny muted" style="text-align:center;margin-top:2px">GPS ±${Math.max(1, Math.round(app.gps.acc * 1.09))} yds</div>` : '')}`;

  if (rec.done) {
    return `<div class="card"><div class="row spread"><b>Hole ${h.ref}: ${hv.score}</b><span class="chip">${hv.score - h.par === 0 ? 'Par' : toPar(hv.score - h.par)}</span></div>
      <div class="small muted">${hv.putts} putt${hv.putts === 1 ? '' : 's'}${hv.fairway !== null ? ` · fairway ${hv.fairway ? 'hit' : 'missed'}` : ''}${hv.gir ? ' · green in regulation' : ''}</div>
      ${hv.shots.length ? `<div class="small">${(Object.keys(hv.sg) as Category[]).filter((k) => hv.sg[k] !== 0).map((k) => `${CATEGORY_LABEL[k]} <b class="${hv.sg[k] >= 0 ? 'gain' : 'loss'}">${sgn(hv.sg[k], 2)}</b>`).join(' · ')}</div>` : ''}</div>
      <button class="btn primary wide" data-act="next">Next hole ›</button>
      <div class="row" style="margin-top:8px"><button class="btn grow" data-act="reopen">Edit hole ${h.ref}</button><button class="btn grow" data-act="scorecard">Scorecard</button></div>
      ${roundFooter()}`;
  }

  if (rec.quick) {
    const strokes = rec.strokes ?? h.par;
    return `${distances}
      <div class="row wrap small" style="margin:8px 0"><span class="chip">💨 ${windText(from, rec.pin)}</span><span class="chip">${pl.riseFt >= 0 ? '▲' : '▼'} ${Math.abs(pl.riseFt)} ft</span><button class="btn sm" data-act="playopts">What should I hit?</button></div>
      ${app.options ? renderOptions() : ''}
      <div class="scorebox">
        <div><div class="small muted">Score</div><div class="stepper big"><button data-act="qs" data-d="-1" aria-label="One less stroke">−</button><b>${strokes}</b><button data-act="qs" data-d="1" aria-label="One more stroke">+</button></div><div class="tiny muted">${strokes - h.par === 0 ? 'Par' : toPar(strokes - h.par)}</div></div>
        <div><div class="small muted">Putts</div><div class="stepper big"><button data-act="putt" data-d="-1" aria-label="One less putt">−</button><b>${rec.putts}</b><button data-act="putt" data-d="1" aria-label="One more putt">+</button></div></div>
      </div>
      ${h.par >= 4 ? `<div class="small muted" style="margin-top:10px">Tee shot</div><div class="seg">${(['left', 'hit', 'right'] as const).map((v) => `<button class="${rec!.fairway === v ? 'on' : ''}" data-act="fw" data-v="${v}">${{ left: '← Left', hit: 'Fairway', right: 'Right →' }[v]}</button>`).join('')}</div>` : ''}
      <button class="btn primary wide" style="margin-top:12px" data-act="savehole">Save hole ${h.ref} ›</button>
      <div class="row wrap" style="margin-top:8px"><button class="btn sm" data-act="trackmode">Track shots on this hole</button><button class="btn sm" data-act="scorecard">Scorecard</button><button class="btn sm" data-act="roundpin">Set today's pin</button></div>
      ${roundFooter()}`;
  }

  const nextIdx = rec.shots.length;
  const planned = plan().steps[nextIdx];
  const shotRows = hv.shots.map((s, i) => `<li><span class="step" style="background:var(--chip)">${i + 1}</span>
    <div class="grow"><b>${s.club}</b> <span class="small muted">${Math.round(s.yds)} yds${s.endEstimated ? '?' : ''} · <span class="lie">${s.startLie}</span> → <span class="lie">${s.endLie}</span></span>${s.penalty ? ` <span class="chip loss">+${s.penalty} pen</span>` : ''}</div>
    <button class="btn sm" data-act="pen" data-i="${i}" aria-label="Add a penalty stroke">+Pen</button><button class="btn sm" data-act="delshot" data-i="${i}" aria-label="Delete shot">✕</button></li>`).join('');
  return `${distances}
    <div class="row wrap small" style="margin:8px 0"><span class="chip">💨 ${windText(from, rec.pin)}</span><span class="chip">${pl.riseFt >= 0 ? '▲' : '▼'} ${Math.abs(pl.riseFt)} ft</span>
      ${planned ? `<span class="chip">Plan: ${planned.club} → ${y0(dist(from, planned.target))}</span>` : ''}
      <button class="btn sm" data-act="playopts">What should I hit?</button></div>
    ${app.options ? renderOptions() : ''}
    ${rec.shots.length ? `<ul class="list">${shotRows}</ul>` : '<p class="small muted" style="margin:4px 0">Stand at your ball and tap <b>Mark shot</b> before each swing.</p>'}
    <div class="row" style="margin-top:6px">
      <button class="btn primary grow big" data-act="mark" ${me ? '' : 'disabled'}>📍 Mark shot ${nextIdx + 1}</button>
      <button class="btn grow big" data-act="ongreen" ${rec.shots.length ? '' : 'disabled'}>⛳ ${rec.greenMark ? 'Re-mark green' : "I'm on the green"}</button>
    </div>
    <div class="row spread" style="margin-top:10px">
      <div><div class="small muted">Putts</div><div class="stepper"><button data-act="putt" data-d="-1" aria-label="One less putt">−</button><b>${rec.putts}</b><button data-act="putt" data-d="1" aria-label="One more putt">+</button></div></div>
      <button class="btn primary" data-act="finish" ${rec.shots.length ? '' : 'disabled'}>Finish hole</button>
    </div>
    <div class="row wrap" style="margin-top:8px"><button class="btn sm" data-act="quick">Just enter my score</button><button class="btn sm" data-act="scorecard">Scorecard</button><button class="btn sm" data-act="roundpin">Set today's pin</button><button class="btn sm" data-act="simnow">Place ball by hand</button></div>
    ${roundFooter()}`;
}

/** Hole-by-hole card for a round, with front and back nine totals. */
function scorecard(roundId?: string) {
  const r = (roundId ? S().rounds.find((x) => x.id === roundId) : round()) ?? null;
  if (!r) return;
  const views = new Map(analyzeRound(app.course, r, S().settings.handicap).holes.map((v) => [v.ref, v]));
  const cell = (ref: number) => {
    const v = views.get(ref), par = app.course.hole(ref).par;
    if (!v) return '<td class="muted">–</td>';
    const d = v.score - par;
    return `<td><span class="sc ${d <= -2 ? 'eagle' : d === -1 ? 'birdie' : d === 1 ? 'bogey' : d >= 2 ? 'double' : ''}">${v.score}</span></td>`;
  };
  const nine = (from: number) => {
    const refs = Array.from({ length: 9 }, (_, i) => from + i);
    const par = refs.reduce((a, r0) => a + app.course.hole(r0).par, 0);
    const played = refs.filter((r0) => views.has(r0));
    const score = played.reduce((a, r0) => a + views.get(r0)!.score, 0);
    const putts = played.reduce((a, r0) => a + views.get(r0)!.putts, 0);
    return `<table class="card-t"><tr><th>Hole</th>${refs.map((r0) => `<th>${r0}</th>`).join('')}<th>${from === 1 ? 'Out' : 'In'}</th></tr>
      <tr><td>Par</td>${refs.map((r0) => `<td class="muted">${app.course.hole(r0).par}</td>`).join('')}<td class="muted">${par}</td></tr>
      <tr><td>Score</td>${refs.map(cell).join('')}<td><b>${played.length ? score : '–'}</b></td></tr>
      <tr><td>Putts</td>${refs.map((r0) => `<td class="muted">${views.get(r0)?.putts ?? '–'}</td>`).join('')}<td class="muted">${played.length ? putts : '–'}</td></tr></table>`;
  };
  const all = [...views.values()];
  const total = all.reduce((a, v) => a + v.score, 0), par = all.reduce((a, v) => a + v.par, 0);
  modal(`<h2>Scorecard · ${new Date(r.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</h2>
    <div class="scroll-x">${nine(1)}</div><div class="scroll-x" style="margin-top:8px">${nine(10)}</div>
    <p><b>${all.length ? total : '–'}</b> ${all.length ? `(${total - par === 0 ? 'E' : sgn(total - par, 0)}) over ${all.length} holes` : ''}</p>
    <button class="btn primary wide" data-act="closemodal">Done</button>`);
  $('#modal').onclick = null;
}

function roundFooter() {
  const r = round()!;
  const v = analyzeRound(app.course, r, S().settings.handicap);
  return `<div class="row spread small muted" style="margin-top:12px"><span>Round: ${v.holes.length} holes · ${v.score} (${v.score - v.par === 0 ? 'E' : sgn(v.score - v.par, 0)})</span><button class="btn sm danger" data-act="endround">End round</button></div>`;
}

// ---------------- Stats tab ----------------
function renderStats(): string {
  const hcp = S().settings.handicap;
  const rounds = S().rounds.map((r) => analyzeRound(app.course, r, hcp)).filter((v) => v.holes.length);
  if (!rounds.length) {
    return `<p class="muted">No rounds yet. Play a round from the Play tab and your strokes gained, hole history and club distances will show up here.</p>${clubsTable()}`;
  }
  const last5 = rounds.slice(-5);
  const avg = (k: Category) => last5.reduce((s, v) => s + (v.sg[k] / v.holes.length) * 18, 0) / last5.length;
  const cats = Object.keys(CATEGORY_LABEL) as Category[];
  const maxAbs = Math.max(2, ...cats.map((k) => Math.abs(avg(k))));
  const sgRows = cats.map((k) => {
    const v = avg(k), w = (Math.abs(v) / maxAbs) * 50;
    return `<div class="row" style="margin:6px 0"><div style="width:120px" class="small">${CATEGORY_LABEL[k]}</div>
      <div class="bar grow"><i class="mid"></i><i style="${v >= 0 ? `left:50%;width:${w}%;background:var(--gain)` : `right:50%;width:${w}%;background:var(--loss)`}"></i></div>
      <b class="num ${v >= 0 ? 'gain' : 'loss'}" style="width:48px;text-align:right">${sgn(v)}</b></div>`;
  }).join('');
  const worst = cats.slice().sort((a, b) => avg(a) - avg(b))[0];
  const hist = holeHistory(app.course, S(), app.ref);
  const h = hole();
  const followed = hist.filter((x) => x.view.followedPlan === true), skipped = hist.filter((x) => x.view.followedPlan === false);
  const avgScore = (xs: typeof hist) => xs.reduce((s, x) => s + x.view.score, 0) / xs.length;
  return `
    <h3>Strokes gained · per 18 holes</h3>
    <div class="small muted">Last ${last5.length} round${last5.length > 1 ? 's' : ''}, compared with a typical ${hcp}-handicap (approximate).</div>
    ${sgRows}
    <div class="card small">Biggest opportunity: <b>${CATEGORY_LABEL[worst]}</b>.</div>

    <h3>Rounds</h3>
    <table><tr><th>Date</th><th>Score</th><th>Putts</th><th>FW</th><th>GIR</th></tr>
    ${rounds.slice().reverse().slice(0, 10).map((v) => `<tr><td>${new Date(v.round.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}${v.holes.length < 18 ? ` <span class="muted">(${v.holes.length})</span>` : ''}</td><td>${v.score} <span class="muted">${v.score - v.par === 0 ? 'E' : sgn(v.score - v.par, 0)}</span></td><td>${v.putts}</td><td>${v.fairways[0]}/${v.fairways[1]}</td><td>${v.gir[0]}/${v.gir[1]}</td></tr>`).join('')}</table>

    <h3>Hole ${h.ref} history</h3>
    ${hist.length ? `<div class="small">Average ${avgScore(hist).toFixed(2)} on par ${h.par} over ${hist.length} round${hist.length > 1 ? 's' : ''}.${followed.length && skipped.length ? ` Followed plan: ${avgScore(followed).toFixed(2)} · didn't: ${avgScore(skipped).toFixed(2)}` : ''}</div>
      <table><tr><th>Date</th><th>Score</th><th>Putts</th><th>SG</th></tr>${hist.slice(0, 8).map((x) => { const t = Object.values(x.view.sg).reduce((a, b) => a + b, 0); return `<tr><td>${new Date(x.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</td><td>${x.view.score}</td><td>${x.view.putts}</td><td class="${t >= 0 ? 'gain' : 'loss'}">${sgn(t, 2)}</td></tr>`; }).join('')}</table>
      <button class="btn sm" data-act="togglehist" style="margin-top:6px">${app.showHistory ? 'Hide' : 'Show'} shots on the map</button>` : '<p class="muted small">You haven\'t played this hole yet.</p>'}
    ${clubsTable()}`;
}

function clubsTable() {
  const st = app.stats;
  return `<h3>Club distances (yards, total)</h3>
    ${st.length ? `<table><tr><th>Club</th><th>Shots</th><th>Median</th><th>Middle 50%</th><th>L/R</th></tr>
      ${st.map((s) => `<tr><td>${s.club}</td><td>${s.n}</td><td><b>${Math.round(s.median)}</b></td><td>${Math.round(s.p25)}–${Math.round(s.p75)}</td><td>${s.sdDeg !== null ? `±${s.sdDeg.toFixed(0)}°${s.missBias !== null && Math.abs(s.missBias) >= 1.5 ? (s.missBias > 0 ? ' R' : ' L') : ''}` : '–'}</td></tr>`).join('')}</table>` : '<p class="muted small">Distances appear after you mark shots during a round.</p>'}
    <label class="row small" style="margin-top:8px"><input type="checkbox" data-act="usemine" ${S().settings.useMyNumbers ? 'checked' : ''}/> Use my numbers for advice (clubs with 5+ shots)</label>`;
}

// ---------------- panel ----------------
function renderPanel() {
  const panel = $('#panel');
  const scroll = panel.scrollTop;
  panel.innerHTML = app.tab === 'plan' ? renderPlan() : app.tab === 'play' ? renderPlay() : renderStats();
  panel.scrollTop = scroll;
}

function refresh(opts: { camera?: boolean } = {}) {
  const pinXY = pin();
  app.scene.setHole(hole(), tee().center, pinXY, !opts.camera);
  app.scene.setPin(pinXY);
  renderTop();
  renderPanel();
  renderModebar();
  renderHint();
  redraw();
}

function goHole(ref: number) {
  app.ref = ((ref - 1 + 18) % 18) + 1;
  app.options = null; app.measure = null; app.mode = null;
  $('#panel').scrollTop = 0;
  refresh({ camera: true });
}

// ---------------- modal ----------------
function modal(html: string) {
  const m = $('#modal');
  m.innerHTML = `<div class="box">${html}</div>`;
  m.hidden = false;
}
function closeModal() { $('#modal').hidden = true; $('#modal').innerHTML = ''; }

/** In-page yes/no question (browser pop-ups don't work everywhere, e.g. inside Claude). */
function ask(question: string, yes: string, danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    modal(`<h2>${esc(question)}</h2><div class="row" style="margin-top:12px"><button class="btn grow" data-ans="no">Cancel</button><button class="btn grow ${danger ? 'danger' : 'primary'}" data-ans="yes">${esc(yes)}</button></div>`);
    $('#modal').onclick = (e) => {
      const b = (e.target as HTMLElement).closest('[data-ans]') as HTMLElement | null;
      if (!b) return;
      closeModal();
      resolve(b.dataset.ans === 'yes');
    };
  });
}

function clubPicker(suggested: string | undefined, onPick: (c: string) => void) {
  modal(`<h2>Which club?</h2><div class="clubgrid">${app.bag.filter((c) => c.on).map((c) => `<button data-club="${c.name}" class="${c.name === suggested ? 'sug' : ''}">${c.name}<small>${c.yds} yds</small></button>`).join('')}</div>
    <div class="row" style="margin-top:12px"><button class="btn grow" data-act="closemodal">Cancel</button></div>`);
  $('#modal').onclick = (e) => {
    const b = (e.target as HTMLElement).closest('[data-club]') as HTMLElement | null;
    if (b) { closeModal(); onPick(b.dataset.club!); }
  };
}

function menu() {
  const s = S().settings;
  modal(`<h2>Settings</h2>
    <div class="row spread"><span>Handicap</span><input type="number" step="1" min="-5" max="40" value="${s.handicap}" data-set="handicap"/></div>
    <div class="row spread" style="margin-top:8px"><span>Default tees</span><select class="clubsel" data-set="teeSet">${(['back', 'middle', 'forward'] as TeeSet[]).map((t) => `<option ${t === s.teeSet ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
    <div class="row spread" style="margin-top:8px"><span>Slope exaggeration</span><select class="clubsel" data-set="exaggerate">${[1, 1.5, 2, 3].map((v) => `<option value="${v}" ${v === s.exaggerate ? 'selected' : ''}>${v}×</option>`).join('')}</select></div>
    <label class="row spread" style="margin-top:8px"><span>Practice mode (place ball by hand)</span><input type="checkbox" data-set="simulateGps" ${s.simulateGps ? 'checked' : ''}/></label>
    <h3>Bag</h3>
    <table><tr><th>On</th><th style="text-align:left">Club</th><th>Yds</th><th>± yds</th><th>± °</th></tr>
    ${S().bag.map((c, i) => `<tr><td><input type="checkbox" data-bag="${i}" data-k="on" ${c.on ? 'checked' : ''}/></td><td style="text-align:left">${c.name}</td><td><input type="number" data-bag="${i}" data-k="yds" value="${c.yds}"/></td><td><input type="number" style="width:52px" data-bag="${i}" data-k="sdYds" value="${c.sdYds}"/></td><td><input type="number" style="width:52px" step="0.5" data-bag="${i}" data-k="sdDeg" value="${c.sdDeg}"/></td></tr>`).join('')}</table>
    <p class="tiny muted">"± yds" and "± °" are your typical distance and left/right spread. Once a club has 5+ recorded shots, your measured numbers are used instead.</p>
    <button class="btn sm" data-act="resetbag">Reset bag to defaults</button>
    <h3>Your data</h3>
    <p class="small muted">Saved on this phone only. Export a backup now and then.</p>
    <div class="row wrap"><button class="btn" data-act="export">Export backup</button><button class="btn" data-act="import">Import backup</button><button class="btn danger" data-act="wipe">Erase everything</button></div>
    <h3>About</h3>
    <p class="tiny muted">Course map © OpenStreetMap contributors (ODbL), fetched ${app.course.data.fetched}. Elevation: USGS 3DEP. Trees: Meta &amp; WRI canopy height map (CC BY 4.0). Weather: Open-Meteo. Strokes-gained baseline adapted from Mark Broadie's tour data and scaled for your handicap (approximate).</p>
    <button class="btn primary wide" data-act="closemodal">Done</button>`);
  $('#modal').onclick = null;
}

function finishHoleDialog() {
  const hasPlan = plan().steps.length > 0;
  modal(`<h2>Finish hole ${app.ref}</h2>
    ${hasPlan ? '<p>Did you stick to your plan?</p><div class="row"><button class="btn grow" data-fp="yes">Yes</button><button class="btn grow" data-fp="no">No</button><button class="btn grow" data-fp="na">Partly</button></div>' : '<button class="btn primary wide" data-fp="na">Save hole</button>'}
    <label class="row small" style="margin-top:12px"><input type="checkbox" id="holedoff" ${holeRec()!.putts === 0 ? 'checked' : ''}/> Holed out from off the green (no putts)</label>
    <div class="row" style="margin-top:10px"><button class="btn grow" data-act="closemodal">Cancel</button></div>`);
  $('#modal').onclick = (e) => {
    const b = (e.target as HTMLElement).closest('[data-fp]') as HTMLElement | null;
    if (!b) return;
    const rec = holeRec()!;
    const off = ($('#holedoff') as HTMLInputElement).checked;
    if (!off && rec.putts === 0) { toast('Add your putts first, or tick "holed out".'); return; }
    if (off) { rec.putts = 0; rec.greenMark = null; }
    rec.followedPlan = b.dataset.fp === 'yes' ? true : b.dataset.fp === 'no' ? false : null;
    rec.done = true;
    saveNow(S());
    refreshBag();
    closeModal();
    const v = analyzeHole(app.course, rec, S().settings.handicap);
    toast(`Hole ${app.ref}: ${v.score}`);
    app.options = null;
    refresh();
  };
}

// ---------------- actions ----------------
async function getWeather(quiet = false) {
  try {
    const { lat, lon } = app.course.data.origin;
    const c = await fetchConditions(lat, lon);
    S().conditions = c;
    const r = round();
    if (r) r.conditions = c;
    save();
    if (!quiet) toast(`Wind ${Math.round(c.windMph)} mph from ${compass(c.windFrom)}, ${Math.round(c.tempF)}°F`);
  } catch (e) {
    if (!quiet) toast('Could not get weather. Tap the wind chip to enter it.');
  }
  app.options = null;
  renderPanel(); redraw();
}

function editWeather() {
  const c = cond();
  modal(`<h2>Conditions</h2>
    <div class="row spread"><span>Wind (mph)</span><input type="number" id="wmph" value="${Math.round(c.windMph)}"/></div>
    <div class="row spread" style="margin-top:8px"><span>Wind from</span><select class="clubsel" id="wfrom">${['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'].map((d, i) => `<option value="${i * 45}" ${compass(c.windFrom) === d ? 'selected' : ''}>${d}</option>`).join('')}</select></div>
    <div class="row spread" style="margin-top:8px"><span>Temperature (°F)</span><input type="number" id="wtemp" value="${Math.round(c.tempF)}"/></div>
    <div class="row" style="margin-top:12px"><button class="btn grow" data-act="closemodal">Cancel</button><button class="btn primary grow" id="wsave">Save</button></div>`);
  $('#modal').onclick = null;
  $('#wsave').onclick = () => {
    const n: Conditions = { windMph: +($('#wmph') as HTMLInputElement).value || 0, gustMph: 0, windFrom: +($('#wfrom') as HTMLSelectElement).value, tempF: +($('#wtemp') as HTMLInputElement).value || 75, fetchedAt: null };
    S().conditions = n;
    const r = round(); if (r) r.conditions = n;
    save(); closeModal(); app.options = null; renderPanel(); redraw();
  };
}

function startRound() {
  const r: Round = { id: uid(), date: new Date().toISOString(), teeSet: S().settings.teeSet, conditions: { ...S().conditions }, holes: {}, finished: false, trackShots: S().settings.trackShots };
  S().rounds.push(r);
  S().activeRoundId = r.id;
  saveNow(S());
  startGps();
  getWeather();
  refresh();
}

function startGps() {
  if (app.watchId !== null || !('geolocation' in navigator)) { if (!('geolocation' in navigator)) app.gpsError = 'not available on this device'; return; }
  app.watchId = navigator.geolocation.watchPosition(
    (p) => {
      const now = Date.now();
      app.fixes.push({ xy: app.course.toXY(p.coords.latitude, p.coords.longitude), acc: Math.max(1, p.coords.accuracy), at: now });
      app.fixes = app.fixes.filter((f) => now - f.at < 12000).slice(-15);
      app.gps = bestFix(app.fixes);
      maybeAdvance();
      app.gpsError = '';
      if (app.tab === 'play') { renderPanel(); app.scene.setMe(myPos(), usingSim() ? 2 : p.coords.accuracy); }
    },
    (err) => { app.gpsError = err.code === 1 ? 'permission denied' : 'no signal'; if (app.tab === 'play') renderPanel(); },
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 },
  );
}

function markShot() {
  const me = myPos();
  const rec = holeRec();
  if (!me || !rec) return;
  if (!usingSim() && app.gps && app.gps.acc > 12) toast(`Weak GPS (±${Math.round(app.gps.acc * 1.09)} yds). Standing still for a few seconds helps.`, 3500);
  const idx = rec.shots.length;
  const lie: Lie = idx === 0 ? 'tee' : app.course.lieAt(me, hole());
  const suggestedClub = app.options?.[app.selOpt]?.club ?? plan().steps[idx]?.club;
  clubPicker(suggestedClub, (club) => {
    rec.shots.push({ club, start: me, lie: lie === 'water' || lie === 'ob' ? 'rough' : lie, acc: usingSim() ? null : app.gps?.acc ?? null, penalty: 0, t: new Date().toISOString() });
    save();
    app.options = null;
    toast(`Shot ${idx + 1}: ${club} from the ${lie === 'tee' ? 'tee' : lie}`);
    renderPanel(); redraw();
  });
}

function markGreen(p: XY) {
  const rec = holeRec()!;
  rec.greenMark = p;
  if (rec.putts === 0) rec.putts = 2;
  save();
  toast(`On the green, ${Math.round(toYds(dist(p, rec.pin)) * 3)} ft from the pin`);
  renderPanel(); redraw();
}

function showOptions(from: XY, lie: Lie) {
  app.optFrom = from;
  app.selOpt = 0;
  app.options = suggest(ctx(from, lie), 4);
  renderPanel(); redraw();
}

async function exportData() {
  const filename = `cedarcrest-backup-${new Date().toISOString().slice(0, 10)}.json`;
  const json = JSON.stringify(S(), null, 1);
  const claude = (window as any).claude;
  if (claude?.use) {
    // Inside a Claude artifact: plain downloads are blocked, so ask the viewer to save it.
    const downloads = await claude.use('downloads').catch(() => null);
    if (downloads) {
      try { await downloads.save({ filename, data: json }); toast('Backup saved'); } catch { toast('Backup not saved'); }
    } else {
      try { await navigator.clipboard.writeText(json); toast('Backup copied. Paste it into a note to keep it.'); } catch { toast('Saving backups isn\'t available here.'); }
    }
    return;
  }
  const blob = new Blob([json], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function importData() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'application/json,.json';
  inp.onchange = async () => {
    const f = inp.files?.[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (data.version !== 1 || !Array.isArray(data.rounds)) throw new Error('bad file');
      if (!(await ask(`Replace your data with this backup (${data.rounds.length} rounds)?`, 'Replace', true))) return;
      app.state = migrate(data);
      saveNow(S()); refreshBag(); closeModal(); refresh(); toast('Backup restored');
    } catch { toast('That file is not a Cedar Crest backup.'); }
  };
  inp.click();
}

function onTap(p: XY) {
  const m = app.mode;
  if (!m && app.scene.currentView === 'course') {
    const ref = app.scene.holeNear(p);
    if (ref) { app.scene.currentView = 'top'; goHole(ref); }
    return;
  }
  if (m?.kind === 'aim') {
    const pl = plan();
    pl.steps[m.step].target = p;
    setPlan(pl);
    app.mode = null; app.options = null;
  } else if (m?.kind === 'pin') {
    const g = app.course.greenOf(hole());
    if (g && !pointInFeature(p, g)) { toast('Tap on the green'); return; }
    if (app.tab === 'play' && holeRec()) holeRec()!.pin = p; else S().pins[app.ref] = p;
    save(); app.mode = null; app.options = null;
  } else if (m?.kind === 'green') {
    app.mode = null;
    markGreen(p);
  } else if (app.tab === 'play' && (usingSim() || m?.kind === 'sim')) {
    app.sim = p; app.mode = null; app.options = null;
    if (!S().settings.simulateGps && !farFromCourse()) S().settings.simulateGps = true;
  } else {
    app.measure = app.measure && dist(app.measure, p) < 6 ? null : p;
    if (S().settings.measureHint) { S().settings.measureHint = false; save(); }
    renderHint();
    redraw();
    return;
  }
  refresh();
}

function onClick(e: Event) {
  const el = (e.target as HTMLElement).closest('[data-act],[data-tab],[data-view]') as HTMLElement | null;
  if (!el || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT')) return;
  if (el.dataset.tab) {
    app.tab = el.dataset.tab as Tab; app.options = null; app.measure = null; app.mode = null;
    if (app.tab === 'play' && round()) startGps();
    $('#sheet').classList.remove('min');
    refresh(); return;
  }
  if (el.dataset.view) {
    app.scene.view(el.dataset.view as ViewName);
    if (el.dataset.view === 'course') toast('Tap a hole to jump to it');
    renderTop();
    return;
  }
  const i = +(el.dataset.i ?? -1);
  const act = el.dataset.act!;
  const pl = plan();
  const rec = holeRec();
  switch (act) {
    case 'prev': goHole(app.ref - 1); break;
    case 'next': goHole(app.ref + 1); break;
    case 'menu': menu(); break;
    case 'northup': app.scene.view('course'); renderTop(); break;
    case 'wind': {
      S().settings.showWind = !S().settings.showWind;
      save();
      const c = cond();
      if (S().settings.showWind && c.windMph < 1) toast(c.fetchedAt ? 'No wind right now' : 'Tap Get weather (Plan tab) or enter the wind to see arrows');
      else if (S().settings.showWind) toast(`Wind ${Math.round(c.windMph)} mph from the ${compass(c.windFrom)}`);
      renderTop(); redraw();
      break;
    }
    case 'closemodal': closeModal(); break;
    case 'cancelmode': app.mode = null; renderModebar(); break;
    case 'viewme': { const me = myPos(); if (me) app.scene.focus(me); break; }
    case 'wx': getWeather(); break;
    case 'editwx': editWeather(); break;
    case 'aim': app.mode = { kind: 'aim', step: i }; renderModebar(); break;
    case 'delstep': pl.steps.splice(i, 1); setPlan(pl); refresh(); break;
    case 'addstep': {
      const from = pl.steps.length ? pl.steps[pl.steps.length - 1].target : tee().center;
      const lie: Lie = pl.steps.length ? app.course.lieAt(from, hole()) : 'tee';
      const best = suggest(ctx(from, lie === 'water' || lie === 'ob' ? 'rough' : lie), 1)[0];
      pl.steps.push({ club: best?.club ?? 'Driver', target: best?.aim ?? pin() });
      setPlan(pl); app.mode = { kind: 'aim', step: pl.steps.length - 1 }; refresh();
      toast('Tap the map to adjust this target, or Cancel to keep it');
      break;
    }
    case 'suggestplan': {
      toast('Working out the best plan…', 1200);
      setTimeout(() => { const res = buildPlan(ctx(tee().center, 'tee')); setPlan({ ...pl, steps: res.steps }); app.options = null; refresh(); }, 30);
      break;
    }
    case 'clearplan': setPlan({ ...pl, steps: [] }); refresh(); break;
    case 'opts': toast('Simulating shots…', 1000); setTimeout(() => showOptions(tee().center, 'tee'), 30); break;
    case 'selopt': app.selOpt = i; renderPanel(); redraw(); break;
    case 'closeopts': app.options = null; renderPanel(); redraw(); break;
    case 'useopt': {
      const o = app.options![app.selOpt];
      if (app.tab === 'plan') { pl.steps = [{ club: o.club, target: o.aim }, ...pl.steps.slice(1)]; setPlan(pl); app.options = null; refresh(); }
      else { markShot(); }
      break;
    }
    case 'setpin': case 'roundpin': app.mode = { kind: 'pin' }; app.scene.view('green'); renderModebar(); break;
    case 'resetpin': delete S().pins[app.ref]; save(); refresh(); break;
    case 'teeset': S().settings.teeSet = el.dataset.v as TeeSet; save(); refresh(); break;
    case 'startround': startRound(); break;
    case 'trackshots': S().settings.trackShots = el.dataset.v === '1'; save(); renderPanel(); break;
    case 'scorecard': scorecard(el.dataset.id); break;
    case 'qs': if (rec) { rec.strokes = Math.max(1, Math.min(15, (rec.strokes ?? hole().par) + +el.dataset.d!)); if (rec.putts > rec.strokes) rec.putts = rec.strokes; save(); renderPanel(); } break;
    case 'fw': if (rec) { rec.fairway = rec.fairway === el.dataset.v ? null : (el.dataset.v as HoleRec['fairway']); save(); renderPanel(); } break;
    case 'quick': if (rec) { rec.quick = true; rec.strokes = rec.strokes ?? Math.max(hole().par, rec.shots.length + rec.putts); if (!rec.putts) rec.putts = 2; save(); app.options = null; refresh(); } break;
    case 'trackmode': if (rec) { rec.quick = false; save(); startGps(); refresh(); } break;
    case 'savehole': if (rec) {
      rec.done = true; saveNow(S()); refreshBag();
      const v = analyzeHole(app.course, rec, S().settings.handicap);
      toast(`Hole ${app.ref}: ${v.score}`);
      if (app.ref === 18 || Object.values(round()!.holes).filter((x) => x.done).length >= 18) { scorecard(); refresh(); }
      else goHole(app.ref + 1);
    } break;
    case 'endround':
      ask('End this round?', 'End round').then((ok) => {
        if (!ok) return;
        const r = round()!;
        r.finished = true;
        for (const [k, h] of Object.entries(r.holes)) if (!h.done) delete r.holes[+k];
        S().activeRoundId = null;
        if (!Object.keys(r.holes).length) S().rounds = S().rounds.filter((x) => x.id !== r.id);
        saveNow(S()); refreshBag(); app.tab = 'stats'; refresh();
      });
      break;
    case 'simnow': app.mode = { kind: 'sim' }; renderModebar(); break;
    case 'mark': markShot(); break;
    case 'ongreen': {
      const me = myPos();
      if (me && !usingSim()) markGreen(me);
      else { app.mode = { kind: 'green' }; app.scene.view('green'); renderModebar(); }
      break;
    }
    case 'putt': if (rec) { rec.putts = Math.max(0, Math.min(9, rec.putts + +el.dataset.d!)); save(); renderPanel(); } break;
    case 'pen': if (rec) { rec.shots[i].penalty = (rec.shots[i].penalty + 1) % 3; save(); renderPanel(); } break;
    case 'delshot': if (rec) ask('Delete this shot?', 'Delete', true).then((ok) => { if (ok) { rec.shots.splice(i, 1); save(); renderPanel(); redraw(); } }); break;
    case 'finish': finishHoleDialog(); break;
    case 'reopen': if (rec) { rec.done = false; save(); refreshBag(); refresh(); } break;
    case 'playopts': {
      const me = myPos() ?? tee().center;
      const lie: Lie = rec && rec.shots.length === 0 && dist(me, tee().center) < 25 ? 'tee' : app.course.lieAt(me, hole());
      toast('Simulating shots…', 1000);
      setTimeout(() => showOptions(me, lie === 'water' || lie === 'ob' ? 'rough' : lie), 30);
      break;
    }
    case 'togglehist': app.showHistory = !app.showHistory; renderPanel(); redraw(); if (app.showHistory) app.scene.view('top'); break;
    case 'export': void exportData(); break;
    case 'import': importData(); break;
    case 'wipe': ask('Erase all rounds, plans and settings on this device?', 'Erase everything', true).then((ok) => { if (ok) { app.state = freshState(); saveNow(S()); refreshBag(); refresh(); } else menu(); }); break;
    case 'resetbag': S().bag = DEFAULT_BAG.map((c) => ({ ...c })); save(); refreshBag(); menu(); break;
  }
}

function onChange(e: Event) {
  const el = e.target as HTMLInputElement;
  if (el.dataset.act === 'stepclub') { const pl = plan(); pl.steps[+el.dataset.i!].club = el.value; setPlan(pl); renderPanel(); redraw(); return; }
  if (el.dataset.act === 'usemine') { S().settings.useMyNumbers = el.checked; save(); refreshBag(); return; }
  if (el.dataset.set) {
    const k = el.dataset.set as keyof State['settings'];
    const v = el.type === 'checkbox' ? el.checked : k === 'teeSet' ? el.value : +el.value;
    (S().settings as any)[k] = v;
    save();
    if (k === 'exaggerate') app.scene.setExaggeration(v as number);
    if (k === 'simulateGps' && !v) app.sim = null;
    refresh();
    return;
  }
  if (el.dataset.bag) {
    const c = S().bag[+el.dataset.bag] as any;
    c[el.dataset.k!] = el.type === 'checkbox' ? el.checked : +el.value;
    save(); refreshBag();
  }
}

// ---------------- boot ----------------
async function boot() {
  try {
    app.course = await Course.load();
  } catch (e) {
    $('#loading').textContent = 'Could not load the course data. Check your connection and reload.';
    return;
  }
  $('#loading').remove();
  refreshBag();
  app.scene = new HoleScene($('#view'), app.course);
  app.scene.onTap = onTap;
  app.scene.onCompass = setNeedle;
  app.scene.setExaggeration(S().settings.exaggerate);
  const hash = +location.hash.replace('#', '');
  if (hash >= 1 && hash <= 18) app.ref = hash;
  document.addEventListener('click', onClick);
  document.addEventListener('change', onChange);
  document.addEventListener('input', (e) => {
    const el = e.target as HTMLTextAreaElement;
    if (el.dataset.act === 'notes') { const pl = plan(); pl.notes = el.value; setPlan(pl); }
  });
  $('#grip').addEventListener('click', () => $('#sheet').classList.toggle('min'));
  window.addEventListener('pagehide', () => saveNow(S()));
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow(S()); });
  if (round()) { app.tab = 'play'; startGps(); }
  refresh({ camera: true });
  const c = S().conditions;
  if (!c.fetchedAt || Date.now() - Date.parse(c.fetchedAt) > 45 * 60 * 1000) void getWeather(true);
  if (!S().settings.onboarded) welcome();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('./sw.js').catch(() => {});
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  (window as any).__app = app; // handy for debugging
}

boot();
