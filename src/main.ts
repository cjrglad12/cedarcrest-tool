import './styles.css';
import { bestFix, fmtHcp, parseHcp } from './gps';
import { findLine, roll, speedFor, rise, describeAim, learnStimp, M_TO_FT, PuttGreen, PuttResult, PuttRead } from './putt';
import { tipsFor, isWet, Tip } from './tips';
import { roundRecap, whereToMiss, whichSide, blockedPlay, MissAdvice, SideAdvice, BlockedPlay } from './insights';
import { Course, Hole, XY, Lie, dist, bearing, toYds, teeFor, pointInFeature, fromBearing, ringCentroid } from './course';
import { HoleScene, dispersion, ViewName } from './scene';
import { FlatScene } from './flatscene';
import { Conditions, fetchConditions, windComponents, playsLike, compass, outlookNotes } from './conditions';
import { suggest, buildPlan, evaluate, Option, Ctx } from './advice';
import { analyzeRound, analyzeHole, clubStats, effectiveBag, holeHistory, ClubStat, scoringStats, differential, courseHandicap, adjustedGross } from './stats';
import { CATEGORY_LABEL, Category } from './sg';
import { loadState, saveState, saveNow, setTee, switchCourse, migrate, uid, freshState, recoveredFrom, setSaveErrorHandler, State, Round, HoleRec, HolePlan, TeeSet, Club, DEFAULT_BAG } from './store';
import { cardHole, cardTotal, cardSource, TEE_SETS, setActiveCourse, courseInfo, courseList, type CourseId } from './card';
import { clubSentence, par5Sentence } from './copy';

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
  tab: 'play' as Tab,
  more: false,
  markAfter: false,
  planning: '' as string,
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
  putt: null as null | { ball: XY; aim: XY; result: PuttResult; best: PuttRead | null; placing: boolean },
  fixes: [] as { xy: XY; acc: number; at: number }[], // recent GPS readings
};

// ---------------- helpers ----------------
const S = () => app.state;
const save = () => saveState(app.state);
const courseNow = (): CourseId => S().settings.courseId ?? 'cedar';
const pkey = (ref = app.ref) => `${courseNow()}:${ref}`;
const hole = (): Hole => app.course.hole(app.ref);
const round = (): Round | null => S().rounds.find((r) => r.id === S().activeRoundId) ?? null;
const holeRec = (): HoleRec | null => round()?.holes[app.ref] ?? null;
const teeSet = (): TeeSet => round()?.teeSet ?? S().settings.teeSet;
const tee = () => teeFor(hole(), teeSet(), cardHole(hole().ref, teeSet()).yards);
const planPin = (): XY => S().pins[pkey()] ?? hole().pin;
const pin = (): XY => (app.tab === 'play' && holeRec()?.pin) || planPin();
const cond = (): Conditions => round()?.conditions ?? S().conditions;
const plan = (): HolePlan => S().plans[pkey()] ?? { steps: [], notes: '', updated: '' };
const setPlan = (p: HolePlan) => { S().plans[pkey()] = { ...p, updated: new Date().toISOString() }; save(); };
const farFromCourse = () => !app.gps || dist(app.gps.xy, [0, 0]) > 2500;
const usingSim = () => S().settings.simulateGps || (farFromCourse() && !!app.sim);
const myPos = (): XY | null => (usingSim() ? app.sim : app.gps?.xy ?? null);

function refreshBag() {
  app.stats = clubStats(app.course, S());
  app.bag = effectiveBag(S(), app.stats);
}

function ctx(from: XY, lie: Lie): Ctx {
  return { course: app.course, hole: hole(), from, lie, pin: pin(), cond: cond(), bag: app.bag, handicap: S().settings.handicap, leftHanded: S().settings.leftHanded, wet: wetNow() };
}

let warningUntil = 0;
/** Short message at the bottom. A warning stays up for its full time; routine messages don't replace it. */
function toast(msg: string, ms = 2200, warning = false) {
  if (!warning && Date.now() < warningUntil) return;
  if (warning) warningUntil = Date.now() + ms;
  const t = $('#toast');
  t.textContent = msg; t.classList.toggle('warn', warning); t.classList.add('show');
  clearTimeout((t as any)._h); (t as any)._h = setTimeout(() => t.classList.remove('show'), ms);
}

function plays(from: XY, to: XY) {
  const d = dist(from, to);
  const rise = app.course.height(to[0], to[1]) - app.course.height(from[0], from[1]);
  const c = cond(), brg = bearing(from, to);
  // Wind and air change carry. Past one full shot (a par 4 or 5 from the tee) the ball
  // also rolls and lay-ups fly lower, so only about 60% of the carry effect shows up
  // in the total; applying all of it made long holes read 10%+ too long in wind.
  const k = d > 210 ? 0.6 : 1;
  const wind = (playsLike(d, 0, { ...c, tempF: 70 }, brg) - d) * k;
  const temp = (playsLike(d, 0, { ...c, windMph: 0, gustMph: 0 }, brg) - d) * k;
  const m = d + rise + wind + temp;
  return { d: y0(d), plays: y0(m), riseFt: Math.round(rise * 3.28), parts: { slope: y0(d + rise) - y0(d), wind: Math.round(toYds(wind)), temp: Math.round(toYds(temp)) } };
}

/** Why the plays-as number differs from the yardage, in a few words. */
function playsWhy(parts: { slope: number; wind: number; temp: number }): string {
  const bits: string[] = [];
  const say = (v: number, up: string, down: string) => { if (Math.abs(v) >= 2) bits.push(`${v > 0 ? '+' : '−'}${Math.abs(v)} ${v > 0 ? up : down}`); };
  say(parts.slope, 'uphill', 'downhill');
  say(parts.wind, 'wind', 'wind');
  say(parts.temp, 'cold air', 'warm air');
  return bits.join(', ');
}

function windPlain(from: XY, to: XY) {
  const c = cond();
  if (c.windMph < 1) return 'Calm';
  const { head, cross } = windComponents(c, bearing(from, to));
  const hw = Math.abs(head) < 1.5 ? '' : head > 0 ? `${Math.round(head)} into` : `${Math.round(-head)} helping`;
  const cw = Math.abs(cross) < 4 ? '' : cross > 0 ? 'a little left to right' : 'a little right to left';
  return [hw, cw].filter(Boolean).join(', ') || 'Calm';
}


// ---------------- header & tabs ----------------
function renderTop() {
  const h = hole();
  const plate = cardHole(h.ref, teeSet());
  const rec = holeRec();
  const score = rec?.done ? ` · You: ${analyzeHole(app.course, rec, S().settings.handicap).score}` : '';
  $('#top').innerHTML = `
    <button class="navbtn" data-act="prev" aria-label="Previous hole">‹</button>
    <div class="hole"><b>Hole ${h.ref}</b> · Par ${plate.par}<small>${plate.yards} yds · ${plate.name}${plate.stroke ? ` · Hcp ${plate.stroke}` : ''}${score}</small></div>
    <button class="navbtn" data-act="next" aria-label="Next hole">›</button>
    <button class="navbtn" data-act="menu" aria-label="Menu">☰</button>`;
  $('#tabs').innerHTML = (['plan', 'play', 'stats'] as Tab[]).map((k) => `<button data-tab="${k}" class="${app.tab === k ? 'on' : ''}">${{ plan: 'Plan', play: round() ? 'Play' : 'Play', stats: 'Stats' }[k]}</button>`).join('');
  const cur = app.scene?.currentView;
  $('#viewbtns').scrollLeft = 0;
  if (app.putt) {
    $('#viewbtns').innerHTML = `<button data-act="puttpov" class="${cur === 'putt' ? 'on' : ''}">Behind ball</button><button data-act="puttabove" class="${cur === 'puttTop' ? 'on' : ''}">Above</button><button data-act="puttexit">Done</button>`;
    return;
  }
  const views = (['top', 'tee', 'green', 'course'] as const).map((v) => `<button data-view="${v}" class="${cur === v ? 'on' : ''}">${{ top: 'Overhead', tee: 'Tee', green: 'Green', course: 'Course' }[v]}</button>`).join('');
  $('#viewbtns').innerHTML = `<button class="cardbtn" data-act="caddieon">Card</button>` + views +
    `<button class="compass" data-act="northup" aria-label="Compass, north up"><i id="needle">▲</i><small>N</small></button>` +
    (app.scene?.userMoved ? `<button class="reset" data-act="resetview">Reset</button>` : '') +
    (cur === 'green' ? '<button class="reset" data-act="puttstart">Read putt</button>' : '') +
    (myPos() ? '<button data-act="viewme">Me</button>' : '');
  setNeedle(lastNeedle);
}

function renderHint() {
  document.querySelector('.hint')?.remove();
  if (app.scene?.currentView === 'green' && !app.mode) {
    const el = document.createElement('div');
    el.className = 'hint legend';
    el.innerHTML = 'Arrows point downhill · <i style="color:#7fd1ff">■</i> flat <i style="color:#ffe066">■</i> 1–2% <i style="color:#ff9f43">■</i> 2–3% <i style="color:#ff5a4f">■</i> 3%+';
    $('#view').appendChild(el);
    return;
  }
  if (app.tab !== 'plan' || app.mode || !S().settings.measureHint || app.measure) return;
  const el = document.createElement('div');
  el.className = 'hint';
  el.textContent = 'Tap anywhere on the hole to measure';
  $('#view').appendChild(el);
}

function welcome() {
  let hcp = S().settings.handicap, drv = S().bag.find((c) => c.name === 'Driver')?.yds ?? 230, tees = S().settings.teeSet;
  let showHcp = false;
  const draw = () => {
    modal(`<h2>${courseInfo().name}</h2>
      <p class="small">Which tees, and how far does the driver go. You can change both later.</p>
      <div class="small" style="margin:12px 0 6px">Course</div>
      <div class="seg">${courseList().map((c) => `<button class="${c.id === courseNow() ? 'on' : ''}" data-w="course" data-v="${c.id}">${c.name}</button>`).join('')}</div>
      <div class="small" style="margin:12px 0 6px">Tees</div>
      <div class="seg">${TEE_SETS.map((t) => `<button class="${t === tees ? 'on' : ''}" data-w="tees" data-v="${t}">${teeName(t)}<small>${cardTotal(t)}</small></button>`).join('')}</div>
      <div class="row spread" style="margin-top:12px"><span>Driver distance</span><div class="stepper"><button data-w="drv" data-d="-5" aria-label="Shorter">−</button><b>${drv}</b><button data-w="drv" data-d="5" aria-label="Longer">+</button></div></div>
      ${showHcp
        ? `<div class="row spread" style="margin-top:12px"><label for="w-hcp">Handicap</label><input id="w-hcp" class="hcp-in" inputmode="decimal" autocomplete="off" value="${fmtHcp(hcp)}"/></div>`
        : `<div class="tiny" style="text-align:right;margin-top:8px"><button class="linkish" data-w="hashcp">Add a handicap</button></div>`}
      <button class="btn primary wide" style="margin-top:16px" data-w="go">Let's play</button>`);
    $('#modal').onclick = (e) => {
      const b = (e.target as HTMLElement).closest('[data-w]') as HTMLElement | null;
      if (!b) return;
      const w = b.dataset.w;
      const input = document.getElementById('w-hcp') as HTMLInputElement | null;
      const typed = input ? parseHcp(input.value) : null;
      if (typed !== null) hcp = typed;
      if (w === 'hashcp') showHcp = true;
      if (w === 'drv') drv = Math.max(120, Math.min(330, drv + +b.dataset.d!));
      if (w === 'tees') tees = b.dataset.v as TeeSet;
      if (w === 'course') {
        const id = b.dataset.v as CourseId;
        if (id !== courseNow()) {
          setTee(S(), tees);
          switchCourse(S(), id);
          tees = S().settings.teeSet;
          app.ref = 1;
          saveNow(S());
          void openCourse().then(draw);
          draw();
          return;
        }
      }
      if (w === 'go') {
        if (showHcp && typed === null) { toast('Enter a handicap like 12.4, or skip it'); return; }
        const base = S().bag.find((c) => c.name === 'Driver')?.yds ?? 230;
        const k = drv / base;
        S().bag = S().bag.map((c) => ({ ...c, yds: Math.round(c.yds * k) }));
        Object.assign(S().settings, { handicap: hcp, onboarded: true, simple: true });
        setTee(S(), tees);
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

/** Elevation in plain words, with what it does to the yardage. */
function elevText(from: XY, to: XY, who: 'you' | 'the tee' = 'you') {
  const rise = app.course.height(to[0], to[1]) - app.course.height(from[0], from[1]);
  const ft = Math.round(rise * 3.28);
  const yds = Math.round(Math.abs(rise) * 1.094); // roughly a yard of distance per yard of height
  if (Math.abs(ft) < 6) return `Green is about level with ${who}`;
  return `Green is <b>${Math.abs(ft)} ft ${ft > 0 ? 'above' : 'below'}</b> ${who}: plays about <b>${yds} yds ${ft > 0 ? 'longer' : 'shorter'}</b>`;
}

const wetNow = () => isWet(cond(), S().settings.wet);

function outlookHtml() {
  if (S().settings.manualWeather) return '';
  const notes = outlookNotes(cond());
  return notes.length ? `<div class="outlook">${notes.map((n) => `<span>⏱ ${n}</span>`).join('')}</div>` : '';
}

function tipsHtml(tips: Tip[]) {
  if (!tips.length) return '';
  return `<ul class="tips">${tips.map((t) => `<li><span aria-hidden="true">${t.icon}</span><span>${t.text}</span></li>`).join('')}</ul>`;
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
  // Safe (green) and avoid (red) sides, drawn where they are.
  if (!app.options && !app.putt && sc.currentView !== 'course') {
    const SAFE = '#2ecc71', AVOID = '#ff5a4f';
    const af = approachFrom();
    const m = af ? missAdvice(af) : null;
    if (m && af) {
      const b = bearing(af, pinXY);
      // Markers sit a little farther out than the zones so they stay clear of the flag.
      const out = (p: XY) => fromBearing(p, bearing(pinXY, p), 8);
      sc.addEllipse({ center: m.points[m.best], along: 9, across: 9, bearing: b, color: SAFE, opacity: 0.5 });
      sc.addEllipse({ center: m.points[m.worst], along: 9, across: 9, bearing: b, color: AVOID, opacity: 0.5 });
      sc.addMark(out(m.points[m.best]), 'safe');
      sc.addMark(out(m.points[m.worst]), 'avoid');
    }
    const me = myPos();
    const showTee = hole().par >= 4 && (app.tab === 'plan' || (app.tab === 'play' && me !== null && onTeeNow(me)) || (app.tab === 'play' && !me && !holeRec()?.shots.length && !holeRec()?.done));
    const side = showTee ? sideCache.get(teeSideKey())?.advice : null;
    if (side) {
      const at = (s: 'left' | 'right', m = 18) => fromBearing(side.target, side.brg + (s === 'left' ? -90 : 90), m);
      const other = side.favor === 'left' ? 'right' : 'left';
      sc.addEllipse({ center: at(side.favor), along: 30, across: 11, bearing: side.brg, color: SAFE, opacity: 0.5 });
      sc.addEllipse({ center: at(other), along: 30, across: 11, bearing: side.brg, color: AVOID, opacity: 0.5 });
      sc.addMark(at(side.favor, 36), 'safe');
      sc.addMark(at(other, 36), 'avoid');
    }
    if (app.tab === 'play' && me) {
      const bl = blockedNow(me);
      if (bl && bl.dir !== 'straight') sc.addArc({ from: me, to: bl.aim, color: '#ffffff', label: `Out: ${bl.club} ${bl.yds}` });
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
function treeLine(from: XY): string {
  const b = blockedNow(from);
  if (!b) return '';
  return b.dir === 'straight'
    ? `Trees in the line. ${b.club}, ${b.yds} yards, leaving ${b.leave}.`
    : `Trees in the line. ${b.club} out to the ${b.dir}, leaving ${b.leave}.`;
}

function shotNumbers(from: XY, pinXY: XY) {
  const h = hole();
  const gd = app.course.greenDistances(h, from, pinXY);
  const pl = plays(from, pinXY);
  const rawMap = y0(gd.pin);
  const me = myPos();
  const atTee = dist(from, tee().center) < 20 && (!me || dist(me, tee().center) < 25);
  const why = playsWhy(pl.parts);
  if (!atTee) return { plays: pl.plays, raw: rawMap, front: y0(gd.front), back: y0(gd.back), why };
  const plate = cardHole(h.ref, teeSet());
  const delta = pl.plays - rawMap;
  return {
    plays: Math.max(1, plate.yards + delta),
    raw: plate.yards,
    front: Math.max(1, plate.yards - (rawMap - y0(gd.front))),
    back: plate.yards + (y0(gd.back) - rawMap),
    why,
  };
}

function renderDecision(from: XY, pinXY: XY): string {
  const h = hole();
  const n = shotNumbers(from, pinXY);
  const shots = holeRec()?.shots.length ?? 0;
  const onTee = dist(from, tee().center) < 25 && shots === 0;
  const trees = onTee ? '' : treeLine(from);
  const side = onTee && h.par >= 4 ? teeSideHtml() : '';
  const approach = !onTee && !trees ? missHtml(from) : '';
  const extra = onTee && parNow() >= 5 ? par5Sentence(n.plays, app.bag) : '';
  const club = n.plays >= 30 ? clubSentence(n.plays, app.bag) : 'On the green.';
  const wind = windPlain(from, pinXY);
  return `<div class="decision">
      <div class="plays"><b>${n.plays}</b><span>${n.plays !== n.raw ? `plays · ${n.raw} yards` : 'yards, plays as it reads'}</span></div>
      ${n.plays !== n.raw && n.why ? `<div class="playswhy">${n.why}</div>` : ''}
      <div class="ends"><span>Front ${n.front}</span><span>Back ${n.back}</span></div>
      <div class="clubline">${club}</div>
      ${side}${approach}${trees ? `<div class="miss">${trees}</div>` : ''}
      <div class="windline">${wind}</div>
      ${extra ? `<div class="extra">${extra}</div>` : ''}
    </div>`;
}

function renderPlan(): string {
  const h = hole(), t = tee(), pinXY = planPin();
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
  if (!steps.length && app.planning !== `${h.ref}|${teeSet()}`) {
    app.planning = `${h.ref}|${teeSet()}`;
    setTimeout(() => {
      if (plan().steps.length) return;
      const res = buildPlan(ctx(tee().center, 'tee'));
      setPlan({ ...plan(), steps: res.steps });
      refresh();
    }, 40);
  }
  return `
    ${renderDecision(t.center, pinXY)}
    <div class="row wrap small" style="margin-top:8px">
      <button class="chip" data-act="editwx">${Math.round(c.tempF)}° · ${c.windMph < 1 ? 'Calm' : `${Math.round(c.windMph)} mph ${compass(c.windFrom)}`}</button>
      <button class="chip" data-act="wet">${{ auto: wetNow() ? 'Wet from rain' : 'Dry', wet: 'Wet', dry: 'Dry' }[S().settings.wet]}</button>
      ${S().settings.manualWeather ? '<button class="btn sm" data-act="wxlive">Use live weather</button>' : `<button class="chip" data-act="wx"><span data-age>${weatherLabel()}</span></button>`}
    </div>
    ${outlookHtml()}

    <div class="elev">${elevText(t.center, pinXY, 'the tee')}</div>
    ${tipsHtml(tipsFor({ cond: c, wetSetting: S().settings.wet, where: 'plan', shotYds: toYds(dist(t.center, pinXY)) > 260 ? 230 : toYds(dist(t.center, pinXY)), shotBearing: bearing(t.center, pinXY) }))}

    ${h.par === 3 ? missHtml(t.center) : steps.length >= 2 ? missHtml(steps[steps.length - 2].target, 'On your approach: ') : ''}

    <h3>Your plan</h3>
    ${steps.length ? `<ul class="list">${stepRows}</ul>` : '<p class="muted small">Working out a plan for this hole.</p>'}
    <div class="row wrap">
      <button class="btn" data-act="suggestplan">Redo plan</button>
      <button class="btn" data-act="addstep">+ Shot</button>
      ${steps.length ? '<button class="btn danger" data-act="clearplan">Clear</button>' : ''}
    </div>
    ${steps.length ? `<p class="small muted">${S().settings.simple ? `With this plan you'd usually make about <b>${Math.round(planExpected())}</b> here (par ${h.par}).` : `Expected score with this plan: <b>${planExpected().toFixed(2)}</b> (par ${h.par})`}</p>` : ''}

    <h3>Compare clubs from the tee</h3>
    ${optList || '<button class="btn" data-act="opts">Show options off the tee</button>'}

    <h3>Hazards from the tee</h3>
    ${hz.length ? `<table><tr><th>Hazard</th><th>Reach</th><th>Carry</th></tr>${hz.map((z) => `<tr><td>${z.kind === 'water' ? '💧 Water' : '⛱ Bunker'} ${z.side}</td><td>${y0(z.reach)}</td><td>${y0(z.carry)}</td></tr>`).join('')}</table>` : '<p class="muted small">No bunkers or water near the line.</p>'}

    <h3>Putting</h3>
    <button class="btn" data-act="readputt">⛳ Read a putt on this green</button>

    <h3>Pin &amp; notes</h3>
    <div class="row wrap"><button class="btn sm" data-act="pinsheet">Pin sheet</button><button class="btn sm" data-act="setpin">Tap to move pin</button>${S().pins[pkey()] ? '<button class="btn sm" data-act="resetpin">Reset pin</button>' : '<span class="small muted">Using the mapped pin</span>'}</div>
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
      <div style="text-align:right">${S().settings.simple ? `<b class="${i ? '' : 'gain'}">${i ? (o.expected - best < 0.08 ? 'Also good' : o.pTrouble < opts[0].pTrouble - 0.01 ? 'Safer, but leaves more' : 'Riskier') : 'Best'}</b>` : `<b class="num">${o.expected.toFixed(2)}</b><div class="tiny ${i ? 'loss' : 'gain'}">${i ? '+' + (o.expected - best).toFixed(2) : 'best'}</div>`}</div>
    </li>`).join('')}</ul>
    <div class="row wrap"><button class="btn sm primary" data-act="useopt">Use ${opts[app.selOpt].club}</button><button class="btn sm" data-act="closeopts">Hide</button></div>
    <p class="tiny muted">${S().settings.simple ? 'Ranked by how many strokes each choice usually takes to finish the hole.' : 'Expected strokes to finish the hole.'} Based on ${S().settings.useMyNumbers && app.stats.some((s) => s.n >= 5) ? 'your recorded distances and misses' : 'typical numbers for your handicap'}; the yellow oval is where ~80% of shots land.</p>`;
}
const pct = (v: number) => `${Math.round(v * 100)}%`;

// ---------------- Play tab ----------------
/** Which side of the green is safe to miss on from here, and which to avoid. */
function missAdvice(from: XY): MissAdvice | null {
  const h = hole(), d = toYds(dist(from, pin()));
  if (d < 30 || d > 260 || app.course.lieAt(from, h) === 'green') return null;
  const lie: Lie = dist(from, tee().center) < 15 ? 'tee' : app.course.lieAt(from, h);
  return whereToMiss(ctx(from, lie === 'water' || lie === 'ob' ? 'rough' : lie));
}
function missHtml(from: XY, label = '') {
  const m = missAdvice(from);
  if (!m) return '';
  const cost = S().settings.simple || m.spread < 0.4 ? '' : ` That is about ${m.spread.toFixed(1)} strokes.`;
  return `<div class="miss">Miss <b>${m.best}</b> if you miss. Avoid <b>${m.worst}</b>.${cost}</div>`;
}

/** Where the approach in view is played from (for where-to-miss), or null when it doesn't apply. */
function approachFrom(): XY | null {
  const h = hole();
  if (app.tab === 'plan') {
    const steps = plan().steps;
    return h.par === 3 ? tee().center : steps.length >= 2 ? steps[steps.length - 2].target : null;
  }
  if (app.tab !== 'play') return null;
  const rec = holeRec();
  if (!rec || rec.done) return null;
  const from = myPos() ?? (rec.shots.length ? rec.shots[rec.shots.length - 1].start : tee().center);
  return onTeeNow(from) ? null : from;
}
/** Standing on the tee of a par 4 or 5 with no shots marked yet. */
function onTeeNow(from: XY) {
  const rec = holeRec();
  return hole().par >= 4 && (!rec || rec.shots.length === 0) && dist(from, tee().center) < 25;
}

const sideCache = new Map<string, { html: string; advice: SideAdvice | null }>();
function teeSideKey() {
  const h = hole(), c = cond(), step = plan().steps[0];
  return [h.ref, teeSet(), step ? step.target.map((v) => Math.round(v)).join(',') : 'auto', pin().map((v) => Math.round(v)).join(','), Math.round(c.windMph / 3), Math.round(c.windFrom / 30), S().settings.handicap, wetNow()].join('|');
}
/**
 * Off the tee on par 4s and 5s: which side to favor, and why. It plays out the next
 * shot from both sides, which takes a moment, so it fills in just after the screen draws.
 */
function teeSideHtml() {
  const h = hole();
  if (h.par < 4) return '';
  const t = tee().center, step = plan().steps[0];
  const key = teeSideKey();
  const cached = sideCache.get(key);
  if (cached !== undefined) return cached.html;
  setTimeout(() => {
    if (!sideCache.has(key)) {
      const teeCtx = { ...ctx(t, 'tee'), hole: h };
      const target = step?.target ?? suggest(teeCtx, 1)[0]?.aim;
      const a = target ? whichSide(teeCtx, target) : null;
      sideCache.set(key, { advice: a, html: a ? `<div class="miss">Favor the <b>${a.favor}</b>. ${a.favor === 'left' ? 'Right' : 'Left'} is the side that costs you${S().settings.simple || a.spread < 0.3 ? '' : `, about ${a.spread.toFixed(1)} strokes`}.</div>`
        : target ? '<div class="miss">No bad side off this tee. A miss either way costs about the same, so aim at the middle of the fairway.</div>' : '' });
    }
    const slot = document.querySelector(`[data-side="${CSS.escape(key)}"]`);
    if (slot) { slot.outerHTML = sideCache.get(key)!.html; redraw(); }
  }, 60);
  return `<div data-side="${esc(key)}"></div>`;
}

const blockCache = new Map<string, BlockedPlay | null>();
/** Trees between you and the green? Say so, with the best way out. */
function blockedNow(from: XY): BlockedPlay | null {
  const lie = app.course.lieAt(from, hole());
  if (lie === 'green' || lie === 'water' || lie === 'ob' || onTeeNow(from) || dist(from, tee().center) < 15) return null;
  const c = cond();
  const key = [app.ref, Math.round(from[0] / 4), Math.round(from[1] / 4), pin().map((v) => Math.round(v)).join(','), Math.round(c.windMph / 3), Math.round(c.windFrom / 30)].join('|');
  if (!blockCache.has(key)) blockCache.set(key, blockedPlay(ctx(from, lie)));
  return blockCache.get(key)!;
}

/** The slope under the ball, in words, with what it does to the shot. */
function lieHtml(from: XY, toward: XY) {
  const lie = app.course.lieAt(from, hole());
  if (lie === 'green' || dist(from, tee().center) < 15) return '';
  const { along, across } = app.course.lieSlope(from, bearing(from, toward));
  const above = S().settings.leftHanded ? -across : across;
  const parts: string[] = [], tips: string[] = [];
  if (along >= 2) { parts.push(`uphill slope (${Math.round(along)}°)`); tips.push('ball flies higher and shorter, so take more club'); }
  else if (along <= -2) { parts.push(`downhill slope (${Math.round(-along)}°)`); tips.push('ball flies lower and runs, so take less club'); }
  const side = S().settings.leftHanded ? ['right', 'left'] : ['left', 'right'];
  if (above >= 2) { parts.push('ball above your feet'); tips.push(`it tends to go ${side[0]}, so aim a little ${side[1]}`); }
  else if (above <= -2) { parts.push('ball below your feet'); tips.push(`it tends to go ${side[1]}, so aim a little ${side[0]}`); }
  if (!parts.length) return '<div class="elev">Your ball is on <b>flat ground</b></div>';
  return `<div class="elev">Your ball is on a <b>${parts.join(', ')}</b>: ${tips.join('; ')}.</div>`;
}

/** Bunkers and water between you and the green: yards to reach and to carry. */
function carriesHtml(from: XY, pinXY: XY) {
  const hz = app.course.hazards(hole(), from, pinXY).slice(0, 4);
  if (!hz.length) return '';
  return `<div class="carries">${hz.map((z) => `<span>${z.kind === 'water' ? '💧' : '⛱'} ${z.side === 'center' ? '' : z.side === 'left' ? 'L ' : 'R '}<b>${y0(z.reach)}</b>/<b>${y0(z.carry)}</b></span>`).join('')}<span class="muted">reach/carry</span></div>`;
}

/**
 * The club for a plays-like distance, from your bag (your measured distances once you have
 * them). Picks the club whose typical distance is nearest, preferring one that gets there.
 */


function newHoleRec(r: Round): HoleRec {
  const quick = r.trackShots === false;
  return { ref: app.ref, teeId: tee().id, pin: S().pins[pkey()] ?? hole().pin, shots: [], greenMark: null, putts: quick ? 2 : 0, holedFromOff: false, followedPlan: null, done: false, quick, strokes: quick ? parNow() : undefined, fairway: null };
}

function renderPlay(): string {
  const r = round();
  if (!r) {
    const past = S().rounds.filter((x) => x.finished && (x.courseId ?? 'cedar') === courseNow()).slice(-3).reverse();
    const track = S().settings.trackShots;
    return `
      <h3>Start a round</h3>
      <div class="seg">${courseList().map((c) => `<button class="${c.id === courseNow() ? 'on' : ''}" data-act="course" data-v="${c.id}">${c.name}</button>`).join('')}</div>
      <div class="small" style="margin:12px 0 6px">Tees</div>
      <div class="seg">${TEE_SETS.map((t) => `<button class="${S().settings.teeSet === t ? 'on' : ''}" data-act="teeset" data-v="${t}">${teeName(t)}<small>${cardTotal(t)}</small></button>`).join('')}</div>
      <div class="small" style="margin:12px 0 6px">Scoring</div>
      <div class="seg">
        <button class="${!track ? 'on' : ''}" data-act="trackshots" data-v="0">Score only<small>Strokes and putts</small></button>
        <button class="${track ? 'on' : ''}" data-act="trackshots" data-v="1">Track shots<small>Club on each swing</small></button>
      </div>
      <button class="btn primary wide" style="margin-top:14px" data-act="startround">Start on hole ${app.ref}</button>
      ${past.length ? `<h3>Recent rounds</h3><ul class="list">${past.map((x) => { const v = analyzeRound(app.course, x, S().settings.handicap); return `<li><div class="grow" data-act="scorecard" data-id="${x.id}">${new Date(x.date).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</div><b>${v.score}</b><button class="btn sm danger" data-act="delround" data-id="${x.id}">Delete</button></li>`; }).join('')}</ul>` : ''}
      ${installHtml()}`;
  }
  let rec = r.holes[app.ref];
  if (!rec) { rec = r.holes[app.ref] = newHoleRec(r); save(); }
  const me = myPos();
  const h = hole();
  const from = me ?? (rec.shots.length ? rec.shots[rec.shots.length - 1].start : tee().center);
  const hv = analyzeHole(app.course, rec, S().settings.handicap);
  const toPar = (n: number) => (n === 0 ? 'E' : sgn(n, 0));
  const par = parNow();
  const decision = renderDecision(from, rec.pin);
  const where = !rec.quick && (usingSim() || farFromCourse() || app.gpsError) ? '<p class="tiny where">Mark the shot, then tap the ball on the map.</p>' : '';

  if (rec.done) {
    const sg = !S().settings.simple && hv.shots.length ? `<div class="small">${(Object.keys(hv.sg) as Category[]).filter((k) => hv.sg[k] !== 0).map((k) => `${CATEGORY_LABEL[k]} <b class="${hv.sg[k] >= 0 ? 'gain' : 'loss'}">${sgn(hv.sg[k], 2)}</b>`).join(' · ')}</div>` : '';
    return `<div class="card"><div class="row spread"><b>Hole ${h.ref}: ${hv.score}</b><span class="chip">${hv.score - par === 0 ? 'Par' : toPar(hv.score - par)}</span></div>
      <div class="small">${hv.putts} putt${hv.putts === 1 ? '' : 's'}${hv.fairway !== null ? ` · fairway ${hv.fairway ? 'hit' : 'missed'}` : ''}${hv.gir ? ' · green in regulation' : ''}</div>
      ${sg}</div>
      <button class="btn primary wide" data-act="next">Next hole</button>
      <div class="row" style="margin-top:8px"><button class="btn grow" data-act="reopen">Edit hole ${h.ref}</button><button class="btn grow" data-act="scorecard">Scorecard</button></div>
      ${roundFooter()}`;
  }

  const moreBtn = `<button class="btn wide" data-act="more">${app.more ? 'Hide extras' : rec.quick ? 'Fairway, penalties, carries' : 'Shot list, carries, other clubs'}</button>`;

  if (rec.quick) {
    const strokes = rec.strokes ?? par;
    const detail = app.more ? `
      ${carriesHtml(from, rec.pin)}
      <div class="elev">${elevText(from, rec.pin)}</div>
      ${me ? lieHtml(me, rec.pin) : ''}
      ${h.par >= 4 ? `<div class="small" style="margin-top:10px">Tee shot</div><div class="seg">${(['left', 'hit', 'right'] as const).map((v) => `<button class="${rec!.fairway === v ? 'on' : ''}" data-act="fw" data-v="${v}">${{ left: 'Left', hit: 'Fairway', right: 'Right' }[v]}</button>`).join('')}</div>` : ''}
      <div class="row spread" style="margin-top:10px"><span class="small">Penalty strokes</span><div class="stepper"><button data-act="pens" data-d="-1" aria-label="Remove a penalty">−</button><b>${rec.penalties ?? 0}</b><button data-act="pens" data-d="1" aria-label="Add a penalty">+</button></div></div>
      <div class="row wrap" style="margin-top:8px"><button class="btn sm" data-act="trackmode">Track shots</button><button class="btn sm" data-act="scorecard">Scorecard</button><button class="btn sm" data-act="pinsheet">Pin</button></div>` : '';
    return `${decision}
      ${where}
      <div class="scorebox">
        <div><div class="small">Score</div><div class="stepper big"><button data-act="qs" data-d="-1" aria-label="Remove a stroke">−</button><b>${strokes}</b><button data-act="qs" data-d="1" aria-label="Add a stroke">+</button></div><div class="tiny">${strokes - par === 0 ? 'Par' : toPar(strokes - par)}</div></div>
        <div><div class="small">Putts</div><div class="stepper big"><button data-act="putt" data-d="-1" aria-label="Remove a putt">−</button><b>${rec.putts}</b><button data-act="putt" data-d="1" aria-label="Add a putt">+</button></div></div>
      </div>
      <button class="btn primary wide" style="margin-top:12px" data-act="savehole">Save hole ${h.ref}</button>
      ${moreBtn}
      ${roundFooter()}
      ${detail}`;
  }

  const nextIdx = rec.shots.length;
  const detail = app.more ? `
      <div class="elev">${elevText(from, rec.pin)}</div>
      ${carriesHtml(from, rec.pin)}
      ${me ? lieHtml(me, rec.pin) : ''}
      ${app.options ? renderOptions() : `<button class="btn" data-act="playopts">Other clubs</button>`}
      ${rec.shots.length ? `<ul class="list">${hv.shots.map((s, i) => `<li><span class="step" style="background:var(--chip)">${i + 1}</span>
        <div class="grow"><b>${s.club}</b> <span class="small">${Math.round(s.yds)} yds · ${s.startLie}</span></div>
        <button class="btn sm" data-act="pen" data-i="${i}" aria-label="Penalty strokes on this shot">${rec.shots[i]?.penalty ? `+${rec.shots[i].penalty} penalty` : 'Penalty'}</button>
        <button class="btn sm" data-act="delshot" data-i="${i}" aria-label="Delete shot">Delete</button></li>`).join('')}</ul>` : ''}
      <div class="row wrap" style="margin-top:8px"><button class="btn sm" data-act="quick">Just the score</button><button class="btn sm" data-act="scorecard">Scorecard</button><button class="btn sm" data-act="pinsheet">Pin</button><button class="btn sm" data-act="readputt">Read the putt</button></div>` : '';
  return `${decision}
    ${where}
    <button class="btn primary wide big" data-act="mark">Mark shot ${nextIdx + 1}</button>
    ${rec.shots.length ? `<button class="btn wide" data-act="ongreen">${rec.greenMark ? 'Move the mark' : 'On the green'}</button>` : ''}
    <div class="row spread" style="margin-top:10px">
      <div><div class="small">Putts</div><div class="stepper"><button data-act="putt" data-d="-1" aria-label="Remove a putt">−</button><b>${rec.putts}</b><button data-act="putt" data-d="1" aria-label="Add a putt">+</button></div></div>
      <button class="btn primary" data-act="finish" ${rec.shots.length ? '' : 'disabled'}>Save hole</button>
    </div>
    ${rec.shots.length ? '<button class="btn wide" data-act="holedout">Holed out from off the green</button>' : ''}
    ${moreBtn}
    ${roundFooter()}
    ${detail}`;
}

/** Score differential for a finished 18-hole round (null if not 18 holes or no rating). */
function roundDifferential(r: Round): number | null {
  const v = analyzeRound(app.course, r, S().settings.handicap);
  const rs = ratingFor(r.teeSet);
  if (!rs || v.holes.length !== 18) return null;
  const ch = courseHandicap(S().settings.handicap, rs.rating, rs.slope, app.course.holes.reduce((a, h) => a + h.par, 0));
  return differential(adjustedGross(v.holes.map((x) => ({ score: x.score, par: x.par, strokeIndex: app.course.hole(x.ref).handicap })), ch), rs.rating, rs.slope);
}

/** After a round: what went well, what cost shots, one thing to work on. */
function recap(roundId: string) {
  const r = S().rounds.find((x) => x.id === roundId);
  if (!r) return;
  const v = analyzeRound(app.course, r, S().settings.handicap);
  if (!v.holes.length) return;
  const rc = roundRecap(v);
  const diff = roundDifferential(r);
  modal(`<h2>Round recap · ${new Date(r.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</h2>
    <p><b>${rc.headline}</b>${diff !== null ? ` · differential ${diff.toFixed(1)}` : ''}</p>
    ${rc.good.length ? `<h3>Went well</h3><ul class="plain">${rc.good.map((g) => `<li>${g}</li>`).join('')}</ul>` : ''}
    ${rc.cost.length ? `<h3>Where shots went</h3><ul class="plain">${rc.cost.map((c) => `<li><b>${c.strokes}</b> · ${c.label}</li>`).join('')}</ul>` : ''}
    <h3>One thing to work on</h3><div class="card">${rc.focus}</div>
    <div class="row" style="margin-top:10px"><button class="btn grow" data-act="scorecard" data-id="${r.id}">Scorecard</button><button class="btn grow danger" data-act="delround" data-id="${r.id}">Delete round</button><button class="btn primary grow" data-act="closemodal">Done</button></div>`);
  $('#modal').onclick = null;
}

/** Rating and slope for a tee set: yours from Settings, else the published scorecard. */
function ratingFor(set: TeeSet) {
  const mine = (S().settings.ratingsCourse ?? 'cedar') === courseNow() ? S().settings.ratings[set] : undefined;
  if (mine && mine.rating > 50 && mine.slope >= 55 && mine.slope <= 155) return mine;
  const pub = cardHole(1, set);
  return { rating: pub.rating, slope: pub.slope };
}

const teeName = (set: TeeSet) => cardHole(1, set).name;
const parNow = () => cardHole(app.ref, teeSet()).par;

/**
 * Set the pin the way pin sheets give it: paces on from the front edge, and paces
 * from the left or right edge (a pace is about a yard).
 */
function pinSheet() {
  const h = hole(), g = app.course.greenOf(h);
  if (!g) { toast('No green outline for this hole'); return; }
  let on = 15, side: 'left' | 'right' = 'left', from = 6;
  const center = ringCentroid(g.rings[0]);
  // Line of approach: from the middle of the fairway side (tee) toward the green's center.
  const approach = bearing(tee().center, center);
  const inG = (p: XY) => pointInFeature(p, g);
  const solve = (): XY | null => {
    // Front edge along the line of approach through the center.
    let front: XY | null = null;
    for (let m = -60; m <= 60; m += 0.25) { const p = fromBearing(center, approach, m); if (inG(p)) { front = p; break; } }
    if (!front) return null;
    const depthPt = fromBearing(front, approach, on * 0.9144);
    // Walk across the green at that depth to find the left and right edges.
    let left: XY | null = null, right: XY | null = null;
    for (let m = 0; m <= 60; m += 0.25) { const p = fromBearing(depthPt, approach - 90, m); if (inG(p)) left = p; else if (left) break; }
    for (let m = 0; m <= 60; m += 0.25) { const p = fromBearing(depthPt, approach + 90, m); if (inG(p)) right = p; else if (right) break; }
    if (!left || !right) return inG(depthPt) ? depthPt : null;
    const edge = side === 'left' ? left : right;
    return fromBearing(edge, side === 'left' ? approach + 90 : approach - 90, from * 0.9144);
  };
  const draw = () => {
    const p = solve();
    modal(`<h2>Today's pin · Hole ${h.ref}</h2>
      <p class="small muted">From the pin sheet. A pace is about a yard.</p>
      <div class="row spread"><span>Paces on (from front edge)</span><div class="stepper"><button data-ps="on" data-d="-1" aria-label="Fewer paces on">−</button><b>${on}</b><button data-ps="on" data-d="1" aria-label="More paces on">+</button></div></div>
      <div class="row spread" style="margin-top:10px"><span>Paces from the</span><div class="seg" style="width:150px"><button class="${side === 'left' ? 'on' : ''}" data-ps="side" data-v="left">Left</button><button class="${side === 'right' ? 'on' : ''}" data-ps="side" data-v="right">Right</button></div></div>
      <div class="row spread" style="margin-top:10px"><span>Paces from the ${side} edge</span><div class="stepper"><button data-ps="from" data-d="-1" aria-label="Fewer paces">−</button><b>${from}</b><button data-ps="from" data-d="1" aria-label="More paces">+</button></div></div>
      <p class="small ${p && inG(p) ? 'muted' : 'loss'}">${p && inG(p) ? `That puts the pin ${Math.round(toYds(dist(tee().center, p)))} yds from the tee.` : "That's off the green. Check the numbers."}</p>
      <div class="row"><button class="btn grow" data-act="closemodal">Cancel</button><button class="btn primary grow" data-ps="save" ${p && inG(p) ? '' : 'disabled'}>Set pin</button></div>`);
    $('#modal').onclick = (e) => {
      const b = (e.target as HTMLElement).closest('[data-ps]') as HTMLElement | null;
      if (!b) return;
      const k = b.dataset.ps;
      if (k === 'on') on = Math.max(1, Math.min(60, on + +b.dataset.d!));
      if (k === 'from') from = Math.max(1, Math.min(40, from + +b.dataset.d!));
      if (k === 'side') side = b.dataset.v as 'left' | 'right';
      if (k === 'save') {
        const pt = solve();
        if (!pt) return;
        if (app.tab === 'play' && holeRec()) holeRec()!.pin = pt; else S().pins[pkey()] = pt;
        save(); closeModal(); app.options = null; refresh(); toast(`Pin set: ${on} on, ${from} from the ${side}`);
        return;
      }
      draw();
    };
  };
  draw();
}

function copyForGhin(roundId?: string) {
  const r = (roundId ? S().rounds.find((x) => x.id === roundId) : round()) ?? null;
  if (!r) return;
  const views = analyzeRound(app.course, r, S().settings.handicap).holes;
  const line = (v: (typeof views)[number]) => `${v.ref}: ${v.score} (${v.putts} putt${v.putts === 1 ? '' : 's'}${v.fairway === null ? '' : v.fairway ? ', FIR' : `, missed ${v.fairwayMiss ?? 'fairway'}`}${v.gir ? ', GIR' : ''}${v.penalties ? `, ${v.penalties} pen` : ''})`;
  const text = [`${courseInfo((r.courseId ?? "cedar") as CourseId).name} · ${new Date(r.date).toLocaleDateString()} · ${teeName(r.teeSet)} tees`, ...views.map(line), `Total ${views.reduce((a, v) => a + v.score, 0)} over ${views.length} holes`].join('\n');
  navigator.clipboard.writeText(text).then(() => toast('Copied. Paste into notes, then enter in GHIN.'), () => toast("Couldn't copy here. Take a screenshot of the scorecard instead."));
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
  const rs = ratingFor(r.teeSet);
  const coursePar = app.course.holes.reduce((a, h) => a + h.par, 0);
  const ch = rs ? courseHandicap(S().settings.handicap, rs.rating, rs.slope, coursePar) : null;
  const ags = ch !== null && all.length === 18 ? adjustedGross(all.map((v) => ({ score: v.score, par: v.par, strokeIndex: app.course.hole(v.ref).handicap })), ch) : null;
  const diff = rs && ags !== null ? differential(ags, rs.rating, rs.slope) : null;
  modal(`<h2>Scorecard · ${new Date(r.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ${teeName(r.teeSet)} tees</h2>
    <div class="scroll-x">${nine(1)}</div><div class="scroll-x" style="margin-top:8px">${nine(10)}</div>
    <p><b>${all.length ? total : '–'}</b> ${all.length ? `(${total - par === 0 ? 'E' : sgn(total - par, 0)}) over ${all.length} holes` : ''}</p>
    ${diff !== null ? `<div class="statgrid"><div><b>${ags}</b><span>Adjusted gross</span></div><div><b>${diff.toFixed(1)}</b><span>Differential</span></div><div><b>${ch! < 0 ? '+' + -ch! : ch}</b><span>Course handicap</span></div></div>
      <p class="tiny muted">${teeName(r.teeSet)} tees ${rs!.rating} / ${rs!.slope}. Each hole is capped at net double bogey, the same way GHIN adjusts it.</p>` : all.length === 18 && !rs ? '<p class="tiny muted">Add the course rating and slope for these tees in ☰ Settings to see your score differential.</p>' : all.length < 18 ? '<p class="tiny muted">Play all 18 to get a score differential.</p>' : ''}
    <div class="row"><button class="btn grow" data-act="copyghin" data-id="${r.id}">Copy scores for GHIN</button><button class="btn grow danger" data-act="delround" data-id="${r.id}">Delete</button><button class="btn primary grow" data-act="closemodal">Done</button></div>
    <p class="tiny muted">GHIN has no public way for other apps to post scores, so copy them here and enter them hole by hole in the GHIN app.</p>`);
  $('#modal').onclick = null;
}

function roundFooter() {
  const r = round()!;
  const n = Object.values(r.holes).filter((h) => h.done).length;
  return `<div class="row spread" style="margin-top:14px"><span class="tiny muted">${n ? `${n} hole${n === 1 ? '' : 's'} saved` : 'Nothing saved yet'}</span><button class="btn sm" data-act="endround">End round</button></div>`;
}

// ---------------- Stats tab ----------------
/** Handicap level strokes gained compares against: yours, a scratch golfer, or the PGA Tour (the baseline itself). */
function baselineHcp() {
  const b = S().settings.sgBaseline;
  return b === 'tour' ? 0 : b === 'scratch' ? 4 : S().settings.handicap;
}
const baselineName = () => ({ me: `a typical ${fmtHcp(S().settings.handicap)} handicap`, scratch: 'a scratch golfer', tour: 'a PGA Tour player' }[S().settings.sgBaseline]);

function renderStats(): string {
  const hcp = baselineHcp();
  const rounds = S().rounds.filter((r) => (r.courseId ?? 'cedar') === courseNow()).map((r) => analyzeRound(app.course, r, hcp)).filter((v) => v.holes.length);
  if (!rounds.length) {
    return `<p class="muted">No rounds yet. Play a round from the Play tab and your strokes gained, hole history and club distances will show up here.</p>${clubsTable()}`;
  }
  const last5 = rounds.slice(-5);
  // Strokes gained only means something on holes where shots were tracked.
  const tracked = last5.flatMap((v) => v.holes).filter((x) => x.shots.length > 0);
  const avg = (k: Category) => (tracked.length ? (tracked.reduce((s, x) => s + x.sg[k], 0) / tracked.length) * 18 : 0);
  const cats = Object.keys(CATEGORY_LABEL) as Category[];
  const maxAbs = Math.max(2, ...cats.map((k) => Math.abs(avg(k))));
  const sgRows = cats.map((k) => {
    const v = avg(k), w = (Math.abs(v) / maxAbs) * 50;
    return `<div class="row" style="margin:6px 0"><div style="width:120px" class="small">${CATEGORY_LABEL[k]}</div>
      <div class="bar grow"><i class="mid"></i><i style="${v >= 0 ? `left:50%;width:${w}%;background:var(--gain)` : `right:50%;width:${w}%;background:var(--loss)`}"></i></div>
      <b class="num ${v >= 0 ? 'gain' : 'loss'}" style="width:48px;text-align:right">${sgn(v)}</b></div>`;
  }).join('');
  const worst = cats.slice().sort((a, b) => avg(a) - avg(b))[0];
  const hist = holeHistory(app.course, S(), app.ref, hcp);
  const h = hole();
  const followed = hist.filter((x) => x.view.followedPlan === true), skipped = hist.filter((x) => x.view.followedPlan === false);
  const avgScore = (xs: typeof hist) => xs.reduce((s, x) => s + x.view.score, 0) / xs.length;
  return `
    ${S().settings.simple ? '' : `<h3>Strokes gained · per 18 holes</h3>
    ${tracked.length ? `<div class="small muted">From ${tracked.length} tracked hole${tracked.length > 1 ? 's' : ''} in your last ${last5.length} round${last5.length > 1 ? 's' : ''}, compared with ${baselineName()} (approximate).</div>
    <div class="seg" style="margin:6px 0">${(['me', 'scratch', 'tour'] as const).map((b) => `<button class="${S().settings.sgBaseline === b ? 'on' : ''}" data-act="sgbase" data-v="${b}">${{ me: 'My level', scratch: 'Scratch', tour: 'Tour' }[b]}</button>`).join('')}</div>
    ${sgRows}
    <div class="card small">Biggest opportunity: <b>${CATEGORY_LABEL[worst]}</b>.</div>` : '<div class="card small">Strokes gained needs shot tracking. Choose <b>Track shots</b> when you start a round (or on any hole), and this fills in. Quick-scored holes still count in the scoring stats below.</div>'}`}

    ${(() => {
      const st = scoringStats(rounds.slice(-5).flatMap((v) => v.holes));
      const pc = (x: number | null) => (x === null ? '–' : `${Math.round(x * 100)}%`);
      const mg = st.missedGreen;
      const nr = Math.min(5, rounds.length);
      return `<h3>Scoring · ${nr === 1 ? 'last round' : `last ${nr} rounds`}</h3>
      <div class="statgrid">
        <div><b>${pc(st.fairwayPct)}</b><span>Fairways${st.fairwayLeft + st.fairwayRight ? ` · miss ${st.fairwayLeft}L/${st.fairwayRight}R` : ''}</span></div>
        <div><b>${pc(st.girPct)}</b><span>${S().settings.simple ? 'Greens hit' : 'Greens in reg.'}</span></div>
        <div><b>${pc(st.scramblePct)}</b><span>Up &amp; down</span></div>
        <div><b>${st.puttsPer18.toFixed(1)}</b><span>Putts / 18</span></div>
        <div><b>${st.puttsPerGir === null ? '–' : st.puttsPerGir.toFixed(2)}</b><span>${S().settings.simple ? 'Putts when on in reg.' : 'Putts per GIR'}</span></div>
        <div><b>${st.penaltiesPer18.toFixed(1)}</b><span>Penalties / 18</span></div>
      </div>
      ${mg.short + mg.long + mg.left + mg.right ? `<div class="small muted">Missed greens: ${mg.short} short · ${mg.long} long · ${mg.left} left · ${mg.right} right</div>` : ''}`;
    })()}

    <h3>Rounds <span class="tiny muted" style="text-transform:none;letter-spacing:0">tap one for its recap</span></h3>
    <table><tr><th>Date</th><th>Score</th><th>Putts</th><th>FW</th><th>GIR</th></tr>
    ${rounds.slice().reverse().slice(0, 10).map((v) => `<tr><td data-act="recap" data-id="${v.round.id}" style="cursor:pointer">${new Date(v.round.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}${v.holes.length < 18 ? ` <span class="muted">(${v.holes.length})</span>` : ''}</td><td data-act="recap" data-id="${v.round.id}">${v.score} <span class="muted">${v.score - v.par === 0 ? 'E' : sgn(v.score - v.par, 0)}</span></td><td>${v.putts}</td><td>${v.fairways[0]}/${v.fairways[1]}</td><td>${v.gir[0]}/${v.gir[1]}</td><td><button class="btn sm danger" data-act="delround" data-id="${v.round.id}">Delete</button></td></tr>`).join('')}</table>

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

// ---------------- install to home screen ----------------
let installEvent: any = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; if (app.course) renderPanel(); });
const isInstalled = () => matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent);

/**
 * On iPhone, Safari can clear a website's saved data after a few weeks unless it's added
 * to the Home Screen, so nudge people to install it (not shown inside Claude, or once installed).
 */
function installHtml() {
  if (isInstalled() || S().settings.installDismissed || round() || (window as any).claude || location.protocol !== 'https:' && location.hostname !== '127.0.0.1') return '';
  if (!installEvent && !isIOS()) return '';
  return `<div class="install-line"><span>📲 Add to your Home Screen to keep your rounds safe</span><button class="btn sm primary" data-act="${installEvent ? 'install' : 'installhow'}">${installEvent ? 'Install' : 'How'}</button><button class="btn sm" data-act="installno" aria-label="Dismiss">✕</button></div>`;
}

function installHow() {
  modal(`<h2>Add to your Home Screen</h2>
    <p>On iPhone, Safari can erase saved rounds from websites you haven't opened in a while. Adding the app to your Home Screen keeps them safe and lets it work offline on the course.</p>
    <ol class="plain"><li>Tap <b>Share</b> (the square with an arrow, □↑) at the bottom of Safari.</li><li>Scroll down and tap <b>Add to Home Screen</b>.</li><li>Open it from the new icon from now on.</li></ol>
    <div class="row"><button class="btn grow" data-act="installno">Don't show again</button><button class="btn primary grow" data-act="closemodal">OK</button></div>`);
  $('#modal').onclick = null;
}

async function installApp() {
  if (!installEvent) return;
  installEvent.prompt();
  try { await installEvent.userChoice; } catch { /* closed */ }
  installEvent = null;
  renderPanel();
}

// ---------------- panel ----------------
let lastScreen = '';
// ---------------- Caddie card ----------------
/** Card mode: one big, map-free card per hole. Everything you need standing over the ball. */
const caddieOn = () => !!S().settings.caddie && !app.putt;

function caddieFrom(): XY {
  const rec = holeRec();
  const me = myPos();
  if (me && (usingSim() || app.scene.holeNear(me, 80) === app.ref)) return me;
  if (rec?.shots.length) return rec.shots[rec.shots.length - 1].start;
  return tee().center;
}

function hazardWords(from: XY, pinXY: XY): string[] {
  return app.course.hazards(hole(), from, pinXY).slice(0, 3).map((z) => {
    const what = z.kind === 'water' ? 'Water' : 'Bunker';
    const where = z.side === 'center' ? 'across the line' : `on the ${z.side}`;
    const reach = y0(z.reach), carry = y0(z.carry);
    return z.side === 'center'
      ? `${what} ${where}: <b>${reach}</b> to reach, <b>${carry}</b> to carry`
      : carry - reach < 6 ? `${what} ${where} at <b>${reach}</b>` : `${what} ${where}, <b>${reach}</b> to <b>${carry}</b>`;
  });
}

function renderCaddie() {
  const el = document.getElementById('caddie');
  if (!el) return;
  if (!caddieOn()) { el.hidden = true; return; }
  el.hidden = false;
  const h = hole(), r = round(), rec = holeRec();
  const pinXY = pin();
  const from = caddieFrom();
  const n = shotNumbers(from, pinXY);
  const onTee = dist(from, tee().center) < 25 && !(rec?.shots.length);
  const plate = cardHole(h.ref, teeSet());
  const lines: string[] = [];
  const club = n.plays >= 30 ? clubSentence(n.plays, app.bag) : 'On the green.';
  if (onTee && h.par >= 4) lines.push(teeSideHtml());
  else if (!onTee) { const tr = treeLine(from); if (tr) lines.push(`<div class="miss">${tr}</div>`); }
  const steps = plan().steps;
  const planLine = onTee && steps.length >= 2
    ? `<div class="cline"><span>Your plan</span>${steps.map((st, i) => `${i ? ' → ' : ''}<b>${esc(st.club)}</b>`).join('')}, leaving ${y0(dist(steps[steps.length - 2].target, pinXY))} in</div>`
    : onTee && plate.par >= 5 ? `<div class="cline"><span>Then</span>${par5Sentence(n.plays, app.bag)}</div>` : '';
  const approach = h.par === 3 || !onTee ? from : steps.length >= 2 ? steps[steps.length - 2].target : null;
  const miss = approach ? missAdvice(approach) : null;
  const hz = hazardWords(from, pinXY);
  const notes = plan().notes.trim();
  const card = `
    <div class="cnum"><b>${n.plays}</b><span>${n.plays !== n.raw ? `plays<small>${n.raw} yds</small>` : `yards`}</span></div>
    ${n.plays !== n.raw && n.why ? `<div class="cwhy">${n.why}</div>` : ''}
    <div class="cends"><span>Front <b>${n.front}</b></span><span>Back <b>${n.back}</b></span></div>
    <div class="cclub">${club}</div>
    ${lines.join('')}
    <div class="cline"><span>Wind</span>${windPlain(from, pinXY)}</div>
    ${hz.length ? `<div class="cline"><span>Trouble</span>${hz.join('<br>')}</div>` : ''}
    ${planLine}
    ${miss ? `<div class="cline"><span>Green</span>Miss <b>${miss.best}</b>. Avoid <b>${miss.worst}</b>.</div>` : ''}
    ${notes ? `<div class="cline"><span>Notes</span>${esc(notes)}</div>` : ''}`;
  let bar = '';
  if (r && rec && !rec.done) {
    const strokes = rec.strokes ?? plate.par;
    bar = rec.quick
      ? `<div class="cbar">
          <div><div class="small">Score</div><div class="stepper big"><button data-act="qs" data-d="-1" aria-label="Remove a stroke">−</button><b>${strokes}</b><button data-act="qs" data-d="1" aria-label="Add a stroke">+</button></div></div>
          <div><div class="small">Putts</div><div class="stepper big"><button data-act="putt" data-d="-1" aria-label="Remove a putt">−</button><b>${rec.putts}</b><button data-act="putt" data-d="1" aria-label="Add a putt">+</button></div></div>
        </div>
        <div class="cbar2"><button class="btn primary wide" data-act="savehole">${saveLabel()}</button></div>`
      : `<div class="cbar">
          <div><div class="small">Putts</div><div class="stepper big"><button data-act="putt" data-d="-1" aria-label="Remove a putt">−</button><b>${rec.putts}</b><button data-act="putt" data-d="1" aria-label="Add a putt">+</button></div></div>
          <button class="btn" data-act="mark">Mark shot ${rec.shots.length + 1}</button>
        </div>
        <div class="cbar2"><button class="btn primary wide" data-act="finish" ${rec.shots.length ? '' : 'disabled'}>${saveLabel()}</button></div>`;
  } else if (r && rec?.done) {
    const v = analyzeHole(app.course, rec, S().settings.handicap);
    bar = `<div class="cbar"><div class="grow"><b>Hole ${h.ref}: ${v.score}</b><div class="tiny">${v.putts} putt${v.putts === 1 ? '' : 's'}</div></div><button class="btn" data-act="reopen">Edit</button><button class="btn primary" data-act="next">Next hole</button></div>`;
  } else if (!r) {
    bar = `<div class="cbar"><button class="btn primary grow" data-act="caddiestart">Start a round on hole ${h.ref}</button></div>`;
  }
  el.innerHTML = `<div class="cscroll"><div class="ctop"><span>${plate.name} tees${onTee ? '' : ' · from your ball'}</span><button class="btn sm" data-act="caddieoff">Map</button></div>${card}</div>${bar}`;
}

/** The save button says where it goes next. */
function saveLabel() {
  const r = round();
  const left = r ? 18 - Object.values(r.holes).filter((x) => x.done).length : 18;
  return app.ref === 18 || left <= 1 ? 'Save and see the scorecard' : `Save, then hole ${app.ref + 1}`;
}

function renderPanel() {
  const panel = $('#panel');
  // Keep the scroll position while working on one screen; start at the top of a new one.
  const rec = holeRec();
  const screen = `${app.putt ? 'putt' : app.tab}|${app.ref}|${round()?.id ?? ''}|${rec?.done ?? ''}|${rec?.quick ?? ''}`;
  const scroll = screen === lastScreen ? panel.scrollTop : 0;
  lastScreen = screen;
  panel.innerHTML = app.putt ? renderPutt() : (app.tab === 'plan' ? renderPlan() : app.tab === 'play' ? renderPlay() : renderStats());
  panel.scrollTop = scroll;
  document.getElementById('app')!.classList.toggle('caddie', caddieOn());
  renderCaddie();
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

// ---------------- Putting ----------------
const todayKey = () => new Date().toLocaleDateString('en-CA');
/** Green speed for reads: what today's putts taught us, else your setting (a bit slower when wet). */
function stimpNow() {
  const t = S().settings.stimpToday;
  if (t && t.date === todayKey()) return t.value;
  return Math.max(6, S().settings.stimp - (wetNow() ? 1.5 : 0));
}
function puttGreen(): PuttGreen {
  return { height: (x, y) => app.course.height(x, y), hole: pin(), stimp: stimpNow(), grainToward: S().settings.grainToward };
}

/** Where to start the ball: your mark on the green, your position if you're on it, else a sample 20 ft putt. */
function defaultBall(): XY {
  const rec = holeRec();
  if (app.tab === 'play' && rec?.greenMark) return rec.greenMark;
  const me = myPos();
  const g = app.course.greenOf(hole());
  if (me && g && pointInFeature(me, g)) return me;
  const p = pin(), from = tee().center;
  const d = 6 / Math.max(1, dist(from, p));
  return [p[0] + (from[0] - p[0]) * d, p[1] + (from[1] - p[1]) * d];
}

function startPutt(ball = defaultBall()) {
  const g = puttGreen();
  const best = findLine(g, ball);
  const aim: XY = best?.aim ?? pin();
  const result = best?.result ?? roll(g, ball, bearing(ball, aim), speedFor(g.stimp, dist(ball, aim)));
  app.putt = { ball, aim, result, best, placing: false };
  app.options = null; app.measure = null; app.mode = null;
  const wasPutting = app.scene.puttActive;
  app.scene.setPutt({ ball, aim, path: result.path, holed: result.holed });
  if (!wasPutting) app.scene.puttView('pov');
  document.querySelector('.hint')?.remove();
  renderTop(); renderPanel();
}

function aimPutt(aim: XY) {
  const pt = app.putt!;
  const g = puttGreen();
  pt.aim = aim;
  pt.result = roll(g, pt.ball, bearing(pt.ball, aim), speedFor(g.stimp, dist(pt.ball, aim)));
  app.scene.setPutt({ ball: pt.ball, aim, path: pt.result.path, holed: pt.result.holed });
}

function exitPutt() {
  app.putt = null;
  app.scene.puttPlacing = false;
  app.scene.setPutt(null);
  renderTop(); renderPanel(); renderHint(); redraw();
}

function renderPutt(): string {
  const pt = app.putt!;
  const g = puttGreen();
  const ft = dist(pt.ball, g.hole) * M_TO_FT;
  const riseIn = rise(g, pt.ball) * 39.37;
  const r = pt.result;
  const missSide = () => {
    // Which side the ball passed the hole on, looking from the ball.
    const brgHole = bearing(pt.ball, g.hole);
    const near = r.path.reduce((b, p) => (dist(p, g.hole) < dist(b, g.hole) ? p : b), r.path[0]);
    const side = ((bearing(pt.ball, near) - brgHole + 540) % 360) - 180;
    return side > 0 ? 'right' : 'left';
  };
  const resultText = r.holed
    ? `<b class="gain">Drops.</b> At this pace it would finish ${(Math.max(0, r.pastHole) * M_TO_FT).toFixed(1)} ft past.`
    : `<b class="loss">Misses</b> ${Math.round(r.closest * 39.37)} in ${missSide()}, finishing ${Math.abs(r.pastHole * M_TO_FT).toFixed(1)} ft ${r.pastHole >= 0 ? 'past' : 'short'}.`;
  const speeds: [number, string][] = [[8, 'Slow'], [9, ''], [10, 'Medium'], [11, ''], [12, 'Fast']];
  const best = pt.best;
  const tips = tipsFor({ cond: cond(), wetSetting: S().settings.wet, where: 'putt', puttFt: ft, puttRiseIn: riseIn, stimp: g.stimp, hour: new Date().getHours() });
  const pace = !best ? 'Set the ball to see the read.' : best.flatDistance > dist(pt.ball, g.hole) * 1.15 ? 'Hit it firm.' : 'Die it in the hole.';
  const lead = best ? `<div class="readline"><b>${describeAim(best.breakM)}</b><span>${pace}</span></div>` : '';
  return `
    ${lead}
    <div class="big3">
      <div><b>${ft < 10 ? ft.toFixed(1) : Math.round(ft)}</b><span>feet</span></div>
      <div><b>${Math.abs(riseIn) < 1 ? '0' : Math.round(Math.abs(riseIn))}″</b><span>${Math.abs(riseIn) < 1 ? 'level' : riseIn > 0 ? 'uphill' : 'downhill'}</span></div>
      <div><b>${g.stimp}</b><span>green speed${S().settings.stimpToday?.date === todayKey() ? ' (learned)' : wetNow() ? ' (wet)' : ''}</span></div>
    </div>
    ${best ? `<div class="card"><div class="small muted">Best line</div><b>${describeAim(best.breakM)}</b><div class="small">Hit it like a ${Math.round(best.flatDistance * M_TO_FT)}-ft putt on a flat green${best.flatDistance > dist(pt.ball, g.hole) * 1.15 ? ' (firm)' : best.flatDistance < dist(pt.ball, g.hole) * 0.95 ? ' (soft, it runs)' : ''}.</div></div>` : ''}
    <div class="elev">Your aim: ${resultText}</div>
    <p class="small muted" style="margin:4px 0">Drag on the green to move the yellow aim marker (farther away = firmer). Grab the ball to move it. The line shows how it rolls.</p>
    <div class="row wrap"><button class="btn primary" data-act="puttbest">Find the line</button><button class="btn" data-act="puttroll">▶ Roll it</button><button class="btn" data-act="puttball">${pt.placing ? 'Tap the green…' : 'Move ball'}</button></div>
    <div class="small muted" style="margin:12px 0 6px">Hit this putt? How did it finish?</div>
    <div class="seg">${([[-4, '3+ ft short'], [-2, 'A bit short'], [0, 'Good pace'], [2, 'A bit long'], [4, '3+ ft long']] as const).map(([v, l]) => `<button data-act="puttlearn" data-v="${v}">${l}</button>`).join('')}</div>
    <p class="tiny muted" style="margin-top:4px">The app learns today's green speed from this and updates the read.${S().settings.stimpToday?.date === todayKey() ? ` Learned today: ${S().settings.stimpToday!.value}. <button class="linkish" data-act="puttforget">Reset</button>` : ''}</p>
    <div class="small muted" style="margin:10px 0 6px">Slope view (how much the green's shape is stretched)</div>
    <div class="seg">${[[1, 'True'], [3, '3×'], [5, '5×']].map(([v, l]) => `<button class="${app.scene.puttEx === v ? 'on' : ''}" data-act="puttex" data-v="${v}">${l}</button>`).join('')}</div>
    <p class="tiny muted" style="margin-top:4px">White lines are 1 inch of height apart: close together means steep, far apart means flat.</p>
    <div class="small muted" style="margin:10px 0 6px">Grain (bermuda): which way does it grow?</div>
    <div class="row wrap">${[['off', 'Ignore'], ['270', 'Toward sunset (W)'], ['other', 'Other…']].map(([v, l]) => `<button class="btn sm ${(v === 'off' && S().settings.grainToward === null) || (v === '270' && S().settings.grainToward === 270) || (v === 'other' && S().settings.grainToward !== null && S().settings.grainToward !== 270) ? 'primary' : ''}" data-act="grain" data-v="${v}">${l}${v === 'other' && S().settings.grainToward !== null && S().settings.grainToward !== 270 ? ` (${compass(S().settings.grainToward!)})` : ''}</button>`).join('')}</div>
    <div class="small muted" style="margin:10px 0 6px">Green speed${S().settings.simple ? ' (how fast putts roll)' : ' (Stimpmeter, feet)'}</div>
    <div class="seg">${speeds.map(([v, l]) => `<button class="${S().settings.stimp === v ? 'on' : ''}" data-act="stimp" data-v="${v}">${v}${l ? `<small>${l}</small>` : ''}</button>`).join('')}</div>
    <h3>Tips</h3>
    ${tipsHtml(tips)}
    <p class="tiny muted">Reads use 1 m elevation (within a few cm of USGS survey data), so tilt and tiers are reliable; small bumps under about 1 m, grain and wetness aren't measured. Treat it as a first read and trust your eyes on short putts.</p>`;
}

/** Big "Hole 7 · Par 5" card for a moment whenever the hole changes. */
function holeCard() {
  document.querySelector('.holecard')?.remove();
  const h = hole();
  const el = document.createElement('div');
  el.className = 'holecard';
  el.innerHTML = `<b>Hole ${h.ref}</b><span>Par ${cardHole(h.ref, teeSet()).par} · ${cardHole(h.ref, teeSet()).yards} yds · ${teeName(teeSet())}</span>`;
  $('#view').appendChild(el);
  setTimeout(() => el.classList.add('out'), 1300);
  setTimeout(() => el.remove(), 1800);
}

function goHole(ref: number) {
  app.ref = ((ref - 1 + 18) % 18) + 1;
  app.options = null; app.measure = null; app.mode = null; app.more = false;
  $('#panel').scrollTop = 0;
  refresh({ camera: true });
  holeCard();
}

// ---------------- modal ----------------
function modal(html: string) {
  const m = $('#modal');
  m.innerHTML = `<div class="box">${html}</div>`;
  m.hidden = false;
}
function closeModal() { $('#modal').hidden = true; $('#modal').innerHTML = ''; }

/** End the round: keep the finished holes, throw the round out, or keep playing. */
function endRoundAsk(saved: number): Promise<'save' | 'drop' | 'cancel'> {
  return new Promise((resolve) => {
    modal(`<h2>End this round?</h2>
      <p class="small">${saved ? `${saved} hole${saved === 1 ? '' : 's'} saved. Holes you didn't finish are left out.` : 'No holes saved yet.'}</p>
      <button class="btn primary wide" data-ans="yes" ${saved ? '' : 'disabled'}>Save ${saved || ''} hole${saved === 1 ? '' : 's'} and stop</button>
      <button class="btn danger wide" style="margin-top:8px" data-ans="drop">Don't save this round</button>
      <button class="btn wide" style="margin-top:8px" data-ans="no">Keep playing</button>`);
    $('#modal').onclick = (e) => {
      const b = (e.target as HTMLElement).closest('[data-ans]') as HTMLElement | null;
      if (!b || (b as HTMLButtonElement).disabled) return;
      closeModal();
      resolve(b.dataset.ans === 'yes' ? 'save' : b.dataset.ans === 'drop' ? 'drop' : 'cancel');
    };
  });
}

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
  const clubs = app.bag.filter((c) => c.on);
  const sug = clubs.find((c) => c.name === suggested) ?? clubs[0];
  const rest = clubs.filter((c) => c !== sug);
  modal(`<h2>Club</h2>
    ${sug ? `<button class="btn primary wide big" data-club="${sug.name}">${sug.name}<small style="display:block;font-weight:500">${sug.yds} yards</small></button>` : ''}
    <div class="clubgrid" style="margin-top:8px">${rest.map((c) => `<button data-club="${c.name}">${c.name}<small>${c.yds}</small></button>`).join('')}</div>
    <div class="row" style="margin-top:12px"><button class="btn grow" data-act="closemodal">Cancel</button></div>`);
  $('#modal').onclick = (e) => {
    const b = (e.target as HTMLElement).closest('[data-club]') as HTMLElement | null;
    if (b) { closeModal(); onPick(b.dataset.club!); }
  };
}

function menu() {
  const s = S().settings;
  modal(`<h2>Settings</h2>
    <div class="small" style="margin-bottom:6px">Course</div>
    <div class="seg">${courseList().map((c) => `<button class="${c.id === courseNow() ? 'on' : ''}" data-act="course" data-v="${c.id}">${c.name}</button>`).join('')}</div>
    <div class="row spread" style="margin-top:10px"><span>Handicap</span><input class="hcp-in" inputmode="decimal" autocomplete="off" value="${fmtHcp(s.handicap)}" data-set="handicap" aria-label="Handicap index"/></div>
    <div class="row spread" style="margin-top:8px"><span>Default tees</span><select class="clubsel" data-set="teeSet">${TEE_SETS.map((t) => `<option value="${t}" ${t === s.teeSet ? 'selected' : ''}>${teeName(t)}</option>`).join('')}</select></div>
    <div class="row spread" style="margin-top:8px"><span>Slope exaggeration</span><select class="clubsel" data-set="exaggerate">${[1, 1.5, 2, 3].map((v) => `<option value="${v}" ${v === s.exaggerate ? 'selected' : ''}>${v}×</option>`).join('')}</select></div>
    <label class="row spread" style="margin-top:8px"><span>Simple view (plain words, fewer numbers)</span><input type="checkbox" data-set="simple" ${s.simple ? 'checked' : ''}/></label>
    <label class="row spread" style="margin-top:8px"><span>Larger text</span><input type="checkbox" data-set="bigText" ${s.bigText ? 'checked' : ''}/></label>
    <label class="row spread" style="margin-top:8px"><span>Left-handed</span><input type="checkbox" data-set="leftHanded" ${s.leftHanded ? 'checked' : ''}/></label>
    <label class="row spread" style="margin-top:8px"><span>Practice mode (place ball by hand)</span><input type="checkbox" data-set="simulateGps" ${s.simulateGps ? 'checked' : ''}/></label>
    <h3>Course rating and slope</h3>
    <p class="tiny muted">${cardSource()}</p>
    ${TEE_SETS.map((t) => `<div class="row spread" style="margin-top:6px"><span>${teeName(t)}</span><span class="row"><input type="number" step="0.1" placeholder="${cardHole(1, t).rating}" style="width:76px" data-rating="${t}" data-k="rating" value="${S().settings.ratings[t]?.rating ?? ''}"/><input type="number" step="1" placeholder="${cardHole(1, t).slope}" style="width:66px" data-rating="${t}" data-k="slope" value="${S().settings.ratings[t]?.slope ?? ''}"/></span></div>`).join('')}
    <h3>Bag</h3>
    <table><tr><th>On</th><th style="text-align:left">Club</th><th>Carry</th><th>Total</th><th>± yds</th><th>± °</th></tr>
    ${S().bag.map((c, i) => `<tr><td><input type="checkbox" data-bag="${i}" data-k="on" ${c.on ? 'checked' : ''}/></td><td style="text-align:left">${c.name}</td><td><input type="number" style="width:56px" data-bag="${i}" data-k="carry" value="${c.carry ?? ''}"/></td><td><input type="number" style="width:56px" data-bag="${i}" data-k="yds" value="${c.yds}"/></td><td><input type="number" style="width:52px" data-bag="${i}" data-k="sdYds" value="${c.sdYds}"/></td><td><input type="number" style="width:52px" step="0.5" data-bag="${i}" data-k="sdDeg" value="${c.sdDeg}"/></td></tr>`).join('')}</table>
    <p class="tiny muted">"± yds" and "± °" are the typical spread for a 15 handicap; the advice tightens or widens them for your handicap. Once a club has 5+ recorded shots, your measured numbers are used instead.</p>
    <p class="tiny muted">Advice uses Total (carry and roll). Untick clubs that aren't in the bag today (14 max).</p>
    <button class="btn sm" data-act="resetbag">Reset to my Nov 12 Toptracer numbers</button>
    <h3>Your data</h3>
    <p class="small muted">Saved on this phone only. Last backup: ${S().settings.lastBackup ? new Date(S().settings.lastBackup!).toLocaleDateString() : 'never'}.</p>
    <div class="row wrap"><button class="btn" data-act="export">Export backup</button><button class="btn" data-act="import">Import backup</button><button class="btn danger" data-act="wipe">Erase everything</button></div>
    <h3>About</h3>
    <p class="tiny muted">Course map © OpenStreetMap contributors (ODbL), fetched ${app.course.data.fetched}. Elevation: USGS 3DEP. Trees: Meta &amp; WRI canopy height map (CC BY 4.0). Weather: Open-Meteo. Strokes-gained baseline adapted from Mark Broadie's tour data and scaled for your handicap (approximate).</p>
    <button class="btn primary wide" data-act="closemodal">Done</button>`);
  $('#modal').onclick = null;
}

function finishHole(off: boolean) {
  const rec = holeRec();
  if (!rec) return;
  if (!off && rec.putts === 0) { toast('Add your putts, or mark holed out.'); return; }
  if (off) { rec.putts = 0; rec.greenMark = null; rec.holedFromOff = true; }
  rec.followedPlan = null;
  rec.done = true;
  saveNow(S());
  refreshBag();
  advanceAfterSave();
}

/** After saving a hole: say the score and move on one hole (or show the card after the last). */
function advanceAfterSave() {
  const rec = holeRec();
  if (!rec) return;
  const v = analyzeHole(app.course, rec, S().settings.handicap);
  const par = parNow();
  toast(`Hole ${app.ref}: ${v.score} (${v.score - par === 0 ? "par" : sgn(v.score - par, 0)}). Go back with ‹ to change it.`, 2600);
  app.options = null; app.more = false;
  const done = Object.values(round()!.holes).filter((x) => x.done).length;
  if (app.ref === 18 || done >= 18) { refresh(); scorecard(); return; }
  goHole(app.ref + 1);
}

// ---------------- actions ----------------
let weatherBusy = false;
/** Fetch live weather. Every round and every number in the app uses the latest reading. */
async function getWeather(quiet = false, force = false) {
  if (weatherBusy || (S().settings.manualWeather && !force)) return;
  weatherBusy = true;
  try {
    const { lat, lon } = app.course.data.origin;
    const c = await fetchConditions(lat, lon);
    const before = S().conditions;
    S().conditions = c;
    S().settings.manualWeather = false;
    const r = round();
    if (r) r.conditions = c;
    save();
    if (!quiet) toast(`Wind ${Math.round(c.windMph)} mph from ${compass(c.windFrom)}, ${Math.round(c.tempF)}°F`);
    // Only re-plan advice if the weather changed enough to matter.
    const changed = Math.abs(before.windMph - c.windMph) >= 3 || Math.abs(before.tempF - c.tempF) >= 5 || Math.abs(((before.windFrom - c.windFrom + 540) % 360) - 180) >= 30;
    if (changed && app.options) app.options = null;
  } catch (e) {
    if (!quiet) toast('Could not get weather. Tap the wind chip to enter it.');
  } finally {
    weatherBusy = false;
  }
  renderPanel(); redraw();
}

const WEATHER_EVERY = 10 * 60 * 1000;
function weatherAge() {
  const c = S().conditions;
  return c.fetchedAt ? Date.now() - Date.parse(c.fetchedAt) : Infinity;
}
/** Keep the weather live: refresh every 10 minutes while the app is open, and when you come back to it. */
function startLiveWeather() {
  setInterval(() => { if (!document.hidden && weatherAge() > WEATHER_EVERY - 30000) void getWeather(true); }, 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && weatherAge() > WEATHER_EVERY) void getWeather(true); });
  setInterval(() => { if (!document.hidden && document.querySelector('[data-age]')) refreshAgeLabels(); }, 30 * 1000);
}
function refreshAgeLabels() {
  document.querySelectorAll<HTMLElement>('[data-age]').forEach((el) => { el.textContent = weatherLabel(); });
}
function weatherLabel() {
  const c = S().conditions;
  if (S().settings.manualWeather || !c.fetchedAt) return 'entered by hand';
  const min = Math.floor(weatherAge() / 60000);
  return min < 1 ? 'live · just now' : `live · ${min} min ago`;
}

function editWeather() {
  const c = cond();
  modal(`<h2>Conditions</h2>
    <div class="row spread"><span>Wind (mph)</span><input type="number" id="wmph" value="${Math.round(c.windMph)}"/></div>
    <div class="row spread" style="margin-top:8px"><span>Wind from</span><select class="clubsel" id="wfrom">${['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'].map((d, i) => `<option value="${i * 45}" ${compass(c.windFrom) === d ? 'selected' : ''}>${d}</option>`).join('')}</select></div>
    <div class="row spread" style="margin-top:8px"><span>Temperature (°F)</span><input type="number" id="wtemp" value="${Math.round(c.tempF)}"/></div>
    <p class="tiny muted">Saving pauses live weather updates until you tap "Use live weather".</p>
    <div class="row" style="margin-top:12px"><button class="btn grow" data-act="closemodal">Cancel</button><button class="btn primary grow" id="wsave">Save</button></div>`);
  $('#modal').onclick = null;
  $('#wsave').onclick = () => {
    const n: Conditions = { windMph: +($('#wmph') as HTMLInputElement).value || 0, gustMph: 0, windFrom: +($('#wfrom') as HTMLSelectElement).value, tempF: +($('#wtemp') as HTMLInputElement).value || 75, fetchedAt: null };
    S().conditions = n;
    S().settings.manualWeather = true;
    const r = round(); if (r) r.conditions = n;
    save(); closeModal(); app.options = null; renderPanel(); redraw();
  };
}

function removeRound(id: string) {
  const wasActive = S().activeRoundId === id;
  S().rounds = S().rounds.filter((x) => x.id !== id);
  if (wasActive) S().activeRoundId = null;
  saveNow(S());
  refreshBag();
  closeModal();
  app.more = false;
  if (wasActive) app.tab = 'play';
  refresh();
  toast('Round deleted');
}

function startRound() {
  const r: Round = { id: uid(), date: new Date().toISOString(), teeSet: S().settings.teeSet, conditions: { ...S().conditions }, holes: {}, finished: false, trackShots: S().settings.trackShots, courseId: courseNow() };
  S().rounds.push(r);
  S().activeRoundId = r.id;
  saveNow(S());
  startGps();
  if (weatherAge() > 2 * 60 * 1000) void getWeather(true);
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
  if (!rec) return;
  if (!me) {
    // No GPS: the ball has to be tapped on the map, so leave the card for now.
    if (caddieOn()) { S().settings.caddie = false; save(); renderPanel(); }
    app.markAfter = true;
    app.mode = { kind: 'sim' };
    renderModebar();
    toast('Tap the map where the ball is');
    return;
  }
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
      try { await downloads.save({ filename, data: json }); S().settings.lastBackup = new Date().toISOString(); save(); toast('Backup saved'); } catch { toast('Backup not saved'); }
    } else {
      try { await navigator.clipboard.writeText(json); toast('Backup copied. Paste it into a note to keep it.'); } catch { toast('Saving backups isn\'t available here.'); }
    }
    return;
  }
  S().settings.lastBackup = new Date().toISOString(); save();
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
    } catch { toast('That file is not a backup from this app.'); }
  };
  inp.click();
}

function onTap(p: XY) {
  const m = app.mode;
  if (app.putt) {
    if (app.putt.placing) {
      app.scene.puttPlacing = false;
      startPutt(p);
    }
    return;
  }
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
    if (app.tab === 'play' && holeRec()) holeRec()!.pin = p; else S().pins[pkey()] = p;
    save(); app.mode = null; app.options = null;
  } else if (m?.kind === 'green') {
    app.mode = null;
    markGreen(p);
  } else if (app.tab === 'play' && (usingSim() || m?.kind === 'sim')) {
    app.sim = p; app.mode = null; app.options = null;
    if (!S().settings.simulateGps && !farFromCourse()) S().settings.simulateGps = true;
    if (app.markAfter) { app.markAfter = false; refresh(); markShot(); return; }
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
    $('#panel').scrollTop = 0;
    if (app.tab === 'play' && round()) startGps();
    $('#sheet').classList.remove('min');
    refresh(); return;
  }
  if (el.dataset.view) {
    app.scene.view(el.dataset.view as ViewName);
    if (el.dataset.view === 'course') toast('Tap a hole to jump to it');
    renderTop();
    renderHint();
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
    case 'puttstart': startPutt(); break;
    case 'puttexit': exitPutt(); break;
    case 'puttroll': app.scene.animatePutt(); break;
    case 'puttex': app.scene.setPuttExaggeration(+el.dataset.v!); renderPanel(); break;
    case 'puttpov': app.scene.puttView('pov'); renderTop(); break;
    case 'puttabove': app.scene.puttView('above'); renderTop(); break;
    case 'puttbest': if (app.putt) { const g = puttGreen(); const b = findLine(g, app.putt.ball); app.putt.best = b; if (b) { aimPutt(b.aim); app.putt.result = b.result; } renderPanel(); } break;
    case 'puttball': if (app.putt) { app.putt.placing = !app.putt.placing; app.scene.puttPlacing = app.putt.placing; renderPanel(); } break;
    case 'puttlearn': if (app.putt) {
      const pt = app.putt, g = puttGreen();
      const predicted = dist(pt.ball, pt.result.stop) * M_TO_FT;
      const next = learnStimp(g.stimp, predicted, +el.dataset.v!);
      S().settings.stimpToday = { date: todayKey(), value: next };
      save();
      toast(next === g.stimp ? 'Pace matched the read: speed unchanged' : `Green speed for today: ${next} (was ${g.stimp})`);
      app.putt.best = findLine(puttGreen(), pt.ball); aimPutt(pt.aim); renderPanel();
    } break;
    case 'puttforget': S().settings.stimpToday = null; save(); if (app.putt) { app.putt.best = findLine(puttGreen(), app.putt.ball); aimPutt(app.putt.aim); } renderPanel(); break;
    case 'grain': {
      const v = el.dataset.v!;
      if (v === 'off') S().settings.grainToward = null;
      else if (v === '270') S().settings.grainToward = 270;
      else { const dirs = [0, 45, 90, 135, 180, 225, 315]; const cur = S().settings.grainToward; S().settings.grainToward = dirs[(cur === null || cur === 270 ? -1 : dirs.indexOf(cur)) + 1] ?? 0; }
      save();
      if (app.putt) { app.putt.best = findLine(puttGreen(), app.putt.ball); aimPutt(app.putt.aim); }
      renderPanel();
      break;
    }
    case 'stimp': S().settings.stimp = +el.dataset.v!; S().settings.stimpToday = null; save(); if (app.putt) { const b = findLine(puttGreen(), app.putt.ball); app.putt.best = b; aimPutt(app.putt.aim); } renderPanel(); break;
    case 'readputt': app.scene.view('green'); startPutt(); break;
    case 'wet': { const order = ['auto', 'wet', 'dry'] as const; S().settings.wet = order[(order.indexOf(S().settings.wet) + 1) % 3]; save(); app.options = null; renderPanel(); break; }
    case 'resetview': app.scene.view(app.scene.currentView); renderTop(); break;
    case 'recap': recap(el.dataset.id!); break;
    case 'sgbase': S().settings.sgBaseline = el.dataset.v as 'me' | 'scratch' | 'tour'; save(); renderPanel(); break;
    case 'pinsheet': pinSheet(); break;
    case 'install': void installApp(); break;
    case 'installno': S().settings.installDismissed = true; save(); closeModal(); renderPanel(); break;
    case 'installhow': installHow(); break;
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
    case 'wx': getWeather(false, true); break;
    case 'wxlive': getWeather(false, true); break;
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
    case 'resetpin': delete S().pins[pkey()]; save(); refresh(); break;
    case 'course': {
      const id = el.dataset.v as CourseId;
      if (!id || id === courseNow()) break;
      if (round()) { toast("Save and stop, or don't save, before changing course"); break; }
      switchCourse(S(), id);
      app.ref = 1; app.measure = null; app.mode = null; app.options = null;
      saveNow(S());
      closeModal();
      void openCourse();
      break;
    }
    case 'teeset': setTee(S(), el.dataset.v as TeeSet); save(); refresh(); break;
    case 'startround': startRound(); break;
    case 'trackshots': S().settings.trackShots = el.dataset.v === '1'; save(); renderPanel(); break;
    case 'scorecard': scorecard(el.dataset.id); break;
    case 'qs': if (rec) { rec.strokes = Math.max(1, Math.min(15, (rec.strokes ?? hole().par) + +el.dataset.d!)); if (rec.putts > rec.strokes) rec.putts = rec.strokes; save(); renderPanel(); } break;
    case 'mg': if (rec) { rec.missedGreen = rec.missedGreen === el.dataset.v ? null : (el.dataset.v as HoleRec['missedGreen']); save(); renderPanel(); } break;
    case 'pens': if (rec) { rec.penalties = Math.max(0, Math.min(6, (rec.penalties ?? 0) + +el.dataset.d!)); save(); renderPanel(); } break;
    case 'copyghin': copyForGhin(el.dataset.id); break;
    case 'fw': if (rec) { rec.fairway = rec.fairway === el.dataset.v ? null : (el.dataset.v as HoleRec['fairway']); save(); renderPanel(); } break;
    case 'quick': if (rec) { rec.quick = true; rec.strokes = rec.strokes ?? Math.max(hole().par, rec.shots.length + rec.putts); if (!rec.putts) rec.putts = 2; save(); app.options = null; refresh(); } break;
    case 'trackmode': if (rec) { rec.quick = false; save(); startGps(); refresh(); } break;
    case 'savehole': if (rec) {
      rec.done = true; saveNow(S()); refreshBag();
      const v = analyzeHole(app.course, rec, S().settings.handicap);
      toast(`Hole ${app.ref}: ${v.score}`);
      advanceAfterSave();
    } break;
    case 'caddieon': S().settings.caddie = true; save(); renderPanel(); break;
    case 'caddieoff': S().settings.caddie = false; save(); renderPanel(); app.scene.render?.(); break;
    case 'caddiestart': S().settings.caddie = true; app.tab = 'play'; startRound(); break;
    case 'endround': {
      const r0 = round();
      if (!r0) break;
      const n = Object.values(r0.holes).filter((h) => h.done).length;
      endRoundAsk(n).then((choice) => {
        if (choice === 'drop') { removeRound(r0.id); return; }
        if (choice !== 'save') return;
        const r = round()!;
        r.finished = true;
        for (const [k, h] of Object.entries(r.holes)) if (!h.done) delete r.holes[+k];
        S().activeRoundId = null;
        if (!Object.keys(r.holes).length) S().rounds = S().rounds.filter((x) => x.id !== r.id);
        saveNow(S()); refreshBag(); app.tab = 'stats'; refresh();
        const last = S().settings.lastBackup ? Date.parse(S().settings.lastBackup!) : 0;
        if (S().rounds.length && Date.now() - last > 14 * 864e5) {
          ask('Back up your rounds? They live only on this phone.', 'Export backup').then((yes) => { if (yes) void exportData(); if (S().rounds.includes(r)) recap(r.id); });
        } else if (S().rounds.includes(r)) recap(r.id);
      });
      break;
    }
    case 'dropround': {
      const r = round();
      if (!r) break;
      const n = Object.values(r.holes).filter((h) => h.done).length;
      ask(n ? `Don't save this round? ${n} finished hole${n === 1 ? '' : 's'} will be thrown out.` : "Don't save this round?", "Don't save", true).then((ok) => { if (ok) removeRound(r.id); });
      break;
    }
    case 'delround': {
      const id = el.dataset.id;
      if (!id) break;
      ask('Delete this round? This cannot be undone.', 'Delete', true).then((ok) => { if (ok) removeRound(id); });
      break;
    }
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
    case 'finish': finishHole(false); break;
    case 'holedout': finishHole(true); break;
    case 'more': app.more = !app.more; $('#sheet').classList.toggle('more', app.more); renderPanel(); break;
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
    let v: unknown = el.type === 'checkbox' ? el.checked : k === 'teeSet' ? el.value : +el.value;
    if (k === 'handicap') {
      const h = parseHcp(el.value);
      if (h === null) { toast('Enter your handicap like 12.4, or +2.1 for a plus handicap'); el.value = fmtHcp(S().settings.handicap); return; }
      v = h;
    }
    (S().settings as any)[k] = v;
    if (k === 'teeSet') setTee(S(), v as TeeSet);
    save();
    if (k === 'exaggerate') app.scene.setExaggeration(v as number);
    if (k === 'simulateGps' && !v) app.sim = null;
    if (k === 'bigText') document.documentElement.classList.toggle('big', !!v);
    refresh();
    return;
  }
  if (el.dataset.rating) {
    const t = el.dataset.rating as TeeSet;
    const cur = { ...(S().settings.ratings[t] ?? { rating: 0, slope: 0 }) };
    (cur as any)[el.dataset.k!] = +el.value;
    if (!cur.rating && !cur.slope) delete S().settings.ratings[t];
    else { S().settings.ratings[t] = cur; S().settings.ratingsCourse = courseNow(); }
    save();
    return;
  }
  if (el.dataset.bag) {
    const c = S().bag[+el.dataset.bag] as any;
    c[el.dataset.k!] = el.type === 'checkbox' ? el.checked : +el.value;
    save(); refreshBag();
  }
}

// ---------------- boot ----------------
function bindScene() {
  app.scene.onTap = onTap;
  app.scene.onCompass = setNeedle;
  app.scene.onUserMove = () => renderTop();
  app.scene.onBallMove = (p, done) => {
    if (!app.putt || !p) { if (done && app.putt) renderPanel(); return; }
    const pt = app.putt, g = puttGreen();
    const dx = pt.aim[0] - pt.ball[0], dy = pt.aim[1] - pt.ball[1];
    pt.ball = p;
    if (done) { startPutt(p); return; }
    pt.aim = [p[0] + dx, p[1] + dy];
    pt.result = roll(g, p, bearing(p, pt.aim), speedFor(g.stimp, dist(p, pt.aim)));
    app.scene.setPutt({ ball: p, aim: pt.aim, path: pt.result.path, holed: pt.result.holed });
  };
  app.scene.onAim = (p, done) => {
    if (!app.putt) return;
    if (p) aimPutt(p);
    if (done) renderPanel();
  };
  app.scene.setExaggeration(S().settings.exaggerate);
}

/** The 3D map, or a flat 2D map when this browser can't run WebGL. */
function makeScene(view: HTMLElement, course: Course): HoleScene {
  const forceFlat = new URLSearchParams(location.search).has('flat');
  if (!forceFlat) {
    try {
      const probe = document.createElement('canvas');
      if (probe.getContext('webgl2') || probe.getContext('webgl')) return new HoleScene(view, course);
    } catch { /* fall through to the flat map */ }
    view.innerHTML = '';
  }
  return new FlatScene(view, course) as unknown as HoleScene;
}

async function openCourse() {
  setActiveCourse(courseNow());
  const baseUrl = new URL(location.href);
  if (!baseUrl.pathname.endsWith('/')) baseUrl.pathname += '/';
  const prev = app.scene as HoleScene | null;
  if (prev?.stop) prev.stop();
  const view = $('#view');
  view.innerHTML = '<div id="loading">Loading course…</div>';
  try {
    app.course = await Course.load(new URL(courseInfo().path, baseUrl).href);
    app.course.fitTeesToCard((ref) => TEE_SETS.map((t) => cardHole(ref, t).yards));
  } catch {
    const msg = document.getElementById('loading');
    if (msg) msg.textContent = 'Could not load the course. Check the connection and reload.';
    return;
  }
  document.getElementById('loading')?.remove();
  app.gps = null;
  app.fixes = [];
  app.sim = null;
  app.putt = null;
  app.scene = makeScene(view, app.course);
  bindScene();
  document.title = courseInfo().name;
  refreshBag();
  refresh({ camera: true });
  if (weatherAge() > 60_000) void getWeather(true);
}

/** Screen readers: buttons in a choice row say whether they're the one picked. */
function syncPressed() {
  for (const b of document.querySelectorAll<HTMLElement>('.seg button')) b.setAttribute('aria-pressed', b.classList.contains('on') ? 'true' : 'false');
}

async function boot() {
  new MutationObserver(syncPressed).observe(document.body, { childList: true, subtree: true });
  // Swipe the hole card left or right to change holes.
  {
    const card = $('#caddie');
    let sx = 0, sy = 0, on = false;
    card.addEventListener('pointerdown', (e) => { if ((e.target as HTMLElement).closest('button')) return; sx = e.clientX; sy = e.clientY; on = true; });
    card.addEventListener('pointerup', (e) => {
      if (!on) return;
      on = false;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.abs(dx) > 70 && Math.abs(dy) < 50) goHole(app.ref + (dx < 0 ? 1 : -1));
    });
  }
  try {
    await openCourse();
  } catch {
    const msg = document.getElementById('loading');
    if (msg) msg.textContent = 'Could not load the course. Check the connection and reload.';
    return;
  }
  if (!app.course) return;
  const hash = +location.hash.replace('#', '');
  if (hash >= 1 && hash <= 18) { app.ref = hash; refresh({ camera: true }); }
  document.documentElement.classList.toggle('big', !!S().settings.bigText);
  setSaveErrorHandler(() => toast("Couldn't save. Your phone's storage may be full. Export a backup from ☰ now.", 6000, true));
  if (recoveredFrom) setTimeout(() => toast("Your saved data couldn't be read, so a copy was kept and the app started fresh. Import a backup from ☰ if you have one.", 7000, true), 1500);
  document.addEventListener('click', onClick);
  document.addEventListener('change', onChange);
  document.addEventListener('input', (e) => {
    const el = e.target as HTMLTextAreaElement;
    if (el.dataset.act === 'notes') { const pl = plan(); pl.notes = el.value; setPlan(pl); }
  });
  $('#grip').addEventListener('click', () => $('#sheet').classList.toggle('min'));
  window.addEventListener('pagehide', () => saveNow(S()));
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow(S()); });
  if (round() && (round()!.courseId ?? 'cedar') === courseNow()) startGps();
  else if (round()) S().activeRoundId = null;
  refresh({ camera: true });
  startLiveWeather();
  if (!S().settings.onboarded) welcome();
  if ('serviceWorker' in navigator && location.hostname.endsWith('github.io')) navigator.serviceWorker.register('./sw.js').catch(() => {});
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
}
(window as unknown as { __app: typeof app }).__app = app;
let started = false;
export function start() {
  if (started) return;
  started = true;
  void boot();
}

start();
