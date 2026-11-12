// Flat 2D map, used when the device can't run the 3D map (no WebGL).
// It offers the same calls the app makes on the 3D map: the hole drawn top-down
// with the green at the top, overlays (plan arcs, markers, labels), taps, pan
// and zoom, and a simple putting view.
import { Course, Hole, XY, Feature, dist, bearing, YD, TREE_M } from './course';
import type { Arc, Ellipse, ViewName, Wind } from './scene';

const COLORS: Record<string, string> = {
  ob: '#7b8a68', rough: '#4f8c3c', wood: '#2e5c2a', fairway: '#6db347', tee: '#79bf52', green: '#8fd65f',
  bunker: '#eadfb4', water: '#3d80c6', path: '#c9c3b3', building: '#a39a90', range: '#5f9a45',
};

type Item =
  | { t: 'arc'; a: Arc }
  | { t: 'dot'; p: XY; color: string; r: number }
  | { t: 'line'; a: XY; b: XY; color: string }
  | { t: 'ellipse'; e: Ellipse }
  | { t: 'label'; p: XY; text: string; color: string }
  | { t: 'mark'; p: XY; kind: 'safe' | 'avoid' };

export class FlatScene {
  readonly flat = true;
  currentView: ViewName = 'top';
  userMoved = false;
  puttActive = false;
  puttPlacing = false;
  puttEx = 1;
  onTap: (p: XY) => void = () => {};
  onCompass: (deg: number) => void = () => {};
  onUserMove: (moved: boolean) => void = () => {};
  onAim: (p: XY | null, done: boolean) => void = () => {};
  onBallMove: (p: XY | null, done: boolean) => void = () => {};

  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private base: HTMLCanvasElement;
  private ppm: number;
  private hole: Hole | null = null;
  private teeXY: XY = [0, 0];
  private pin: XY = [0, 0];
  private me: { p: XY; acc: number } | null = null;
  private items: Item[] = [];
  private wind: Wind | null = null;
  private putt: { ball: XY; aim: XY; path: XY[]; holed: boolean } | null = null;
  private rollAt: { start: number; dur: number } | null = null;
  // View: map point at the screen center, rotation (compass bearing pointing up), pixels per meter.
  private center: XY = [0, 0];
  private rot = 0;
  private scale = 1;
  private dirty = true;
  private alive = true;
  private ro: ResizeObserver;

  constructor(private el: HTMLElement, private course: Course) {
    this.canvas = document.createElement('canvas');
    this.canvas.style.touchAction = 'none';
    this.canvas.setAttribute('aria-label', 'Hole map');
    el.appendChild(this.canvas);
    this.g = this.canvas.getContext('2d')!;
    const b = course.data.bounds;
    const W = b.maxX - b.minX, H = b.maxY - b.minY;
    this.ppm = Math.min(2, 3000 / Math.max(W, H));
    this.base = this.paintCourse();
    const note = document.createElement('div');
    note.className = 'flatnote';
    note.textContent = 'Flat map (3D not available on this device)';
    el.appendChild(note);
    this.setupInput();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(el);
    this.resize();
    const loop = () => {
      if (!this.alive) return;
      requestAnimationFrame(loop);
      if (this.rollAt) this.dirty = true;
      if (this.dirty) { this.dirty = false; this.draw(); }
    };
    requestAnimationFrame(loop);
  }

  stop() { this.alive = false; this.ro.disconnect(); this.el.innerHTML = ''; }
  render() { this.dirty = true; }

  private resize() {
    const r = this.el.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.canvas.style.width = `${r.width}px`;
    this.canvas.style.height = `${r.height}px`;
    this.render();
  }

  // ---------- coordinates ----------
  private get W() { return this.canvas.width; }
  private get H() { return this.canvas.height; }
  toScreen(p: XY): [number, number] {
    const r = (this.rot * Math.PI) / 180, dx = p[0] - this.center[0], dy = p[1] - this.center[1];
    const e = dx * Math.cos(r) - dy * Math.sin(r), n = dx * Math.sin(r) + dy * Math.cos(r);
    return [this.W / 2 + e * this.scale, this.H / 2 - n * this.scale];
  }
  private toMap(sx: number, sy: number): XY {
    const r = (this.rot * Math.PI) / 180;
    const e = (sx - this.W / 2) / this.scale, n = -(sy - this.H / 2) / this.scale;
    return [this.center[0] + e * Math.cos(r) + n * Math.sin(r), this.center[1] - e * Math.sin(r) + n * Math.cos(r)];
  }
  private clientToMap(cx: number, cy: number): XY {
    const b = this.canvas.getBoundingClientRect();
    const k = this.W / Math.max(1, b.width);
    return this.toMap((cx - b.left) * k, (cy - b.top) * k);
  }

  // ---------- hole and views ----------
  setHole(hole: Hole, tee: XY, pin: XY, keepCamera = false) {
    const same = this.hole?.ref === hole.ref;
    this.hole = hole; this.teeXY = tee; this.pin = pin;
    if (!same || !keepCamera) this.view(this.currentView === 'course' && keepCamera ? 'course' : 'top');
    this.render();
  }
  setPin(pin: XY) { this.pin = pin; this.render(); }
  setMe(p: XY | null, accuracy = 5) { this.me = p ? { p, acc: accuracy } : null; this.render(); }
  setExaggeration(_v: number) { /* flat map: no height */ }
  setPuttExaggeration(_v: number) { /* flat map: no height */ }
  setWind(w: Wind | null) { this.wind = w && w.windMph >= 1 ? w : null; this.render(); }

  view(name: ViewName) {
    if (!this.hole) return;
    // There's no 3D here; the tee view shows the hole the same way as overhead.
    this.currentView = name === 'tee' ? 'top' : name;
    const fit = (pts: XY[], marginPx: number) => {
      const rr = (this.rot * Math.PI) / 180;
      const ex = pts.map((p) => p[0] * Math.cos(rr) - p[1] * Math.sin(rr));
      const ny = pts.map((p) => p[0] * Math.sin(rr) + p[1] * Math.cos(rr));
      const e0 = Math.min(...ex), e1 = Math.max(...ex), n0 = Math.min(...ny), n1 = Math.max(...ny);
      const padTop = 56 * (this.W / Math.max(1, this.canvas.getBoundingClientRect().width || 1));
      const usableH = Math.max(50, this.H - padTop - marginPx * 2), usableW = Math.max(50, this.W - marginPx * 2);
      this.scale = Math.min(usableW / Math.max(1, e1 - e0), usableH / Math.max(1, n1 - n0));
      const ce = (e0 + e1) / 2, cn = (n0 + n1) / 2 + (padTop / 2) / this.scale;
      this.center = [ce * Math.cos(rr) + cn * Math.sin(rr), -ce * Math.sin(rr) + cn * Math.cos(rr)];
    };
    if (name === 'course') {
      this.rot = 0;
      const b = this.course.data.bounds;
      fit([[b.minX, b.minY], [b.maxX, b.maxY]], 4);
    } else {
      this.rot = bearing(this.teeXY, this.pin);
      const g = this.course.greenOf(this.hole);
      if (name === 'green') fit(g ? g.rings[0] : [this.pin], 30);
      else fit([this.teeXY, ...this.hole.line, this.pin, ...(g ? g.rings[0] : [])], 24);
    }
    this.userMoved = false;
    this.onUserMove(false);
    this.onCompass(-this.rot);
    this.render();
  }

  focus(p: XY) { this.center = p; this.render(); }

  holeNear(p: XY, maxM = 60): number | null {
    let best: number | null = null, bd = maxM;
    for (const h of this.course.holes) {
      const pts = [h.tees[0].center, ...h.line, h.pin];
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i], dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
        const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
        const d = Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t);
        if (d < bd) { bd = d; best = h.ref; }
      }
    }
    return best;
  }

  // ---------- overlays ----------
  clearOverlay() { this.items = []; this.render(); }
  addArc(a: Arc) { this.items.push({ t: 'arc', a }); this.render(); }
  addDot(p: XY, color: string, r = 1.2) { this.items.push({ t: 'dot', p, color, r }); this.render(); }
  addGroundLine(a: XY, b: XY, color: string) { this.items.push({ t: 'line', a, b, color }); this.render(); }
  addEllipse(e: Ellipse) { this.items.push({ t: 'ellipse', e }); this.render(); }
  addLabel(p: XY, text: string, color = '#ffffff') { this.items.push({ t: 'label', p, text, color }); this.render(); }
  addMark(p: XY, kind: 'safe' | 'avoid') { this.items.push({ t: 'mark', p, kind }); this.render(); }

  // ---------- putting ----------
  setPutt(state: { ball: XY; aim: XY; path: XY[]; holed: boolean } | null) {
    const was = this.puttActive;
    this.puttActive = !!state;
    this.putt = state;
    if (!state && was) { this.view('green'); return; }
    if (state && !was) this.puttView('above');
    this.render();
  }
  puttView(_kind: 'pov' | 'above') {
    if (!this.putt) return;
    this.currentView = 'puttTop';
    this.rot = bearing(this.putt.ball, this.pin);
    const pts = [this.putt.ball, this.pin, this.putt.aim];
    const mid: XY = [pts.reduce((a, p) => a + p[0], 0) / 3, pts.reduce((a, p) => a + p[1], 0) / 3];
    const span = Math.max(3, ...pts.map((p) => dist(p, mid)));
    this.center = mid;
    this.scale = Math.min(this.W, this.H - 120) / (span * 2.8);
    this.onCompass(-this.rot);
    this.render();
  }
  animatePutt() {
    if (!this.putt || this.putt.path.length < 2) return;
    this.rollAt = { start: performance.now(), dur: 2200 };
  }

  // ---------- drawing ----------
  private paintCourse(): HTMLCanvasElement {
    const b = this.course.data.bounds, ppm = this.ppm;
    const cv = document.createElement('canvas');
    cv.width = Math.ceil((b.maxX - b.minX) * ppm); cv.height = Math.ceil((b.maxY - b.minY) * ppm);
    const g = cv.getContext('2d')!;
    const tx = (p: XY): [number, number] => [(p[0] - b.minX) * ppm, (b.maxY - p[1]) * ppm];
    const path = (rings: XY[][]) => {
      g.beginPath();
      for (const ring of rings) ring.forEach((p, i) => { const [x, y] = tx(p); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
      g.closePath();
    };
    g.fillStyle = COLORS.ob; g.fillRect(0, 0, cv.width, cv.height);
    const lm = this.course.data.landmarks;
    if (lm) {
      g.lineCap = 'round';
      for (const r of lm.roads) { g.strokeStyle = '#9b9a94'; g.lineWidth = 9 * ppm; g.beginPath(); r.line.forEach((p, i) => { const [x, y] = tx(p); if (i) g.lineTo(x, y); else g.moveTo(x, y); }); g.stroke(); }
    }
    path(this.course.data.boundary); g.fillStyle = COLORS.rough; g.fill('evenodd');
    if (lm) {
      for (const lot of lm.parking) { path([lot]); g.fillStyle = '#6e706b'; g.fill(); }
      for (const bd of lm.buildings) { path([bd.ring]); g.fillStyle = '#8f8a83'; g.fill(); }
    }
    const order: Feature['kind'][] = ['range', 'wood', 'fairway', 'tee', 'green', 'bunker', 'water', 'building'];
    for (const kind of order) for (const f of this.course.features) {
      if (f.kind !== kind) continue;
      path([...f.rings, ...f.holes]); g.fillStyle = COLORS[kind] ?? COLORS.rough; g.fill('evenodd');
    }
    g.strokeStyle = COLORS.path; g.lineWidth = 2.4 * ppm; g.lineCap = 'round'; g.lineJoin = 'round';
    for (const line of this.course.data.paths) { g.beginPath(); line.forEach((p, i) => { const [x, y] = tx(p); if (i) g.lineTo(x, y); else g.moveTo(x, y); }); g.stroke(); }
    // Tree cover from the canopy map.
    const t = this.course.data.terrain;
    g.fillStyle = 'rgba(30,62,28,0.8)';
    for (let r = 0; r < t.rows; r++) for (let c = 0; c < t.cols; c++) {
      if (this.course.canopy[r * t.cols + c] < TREE_M) continue;
      const [x, y] = tx([t.minX + c * t.cell - t.cell / 2, t.minY + r * t.cell + t.cell / 2]);
      g.fillRect(x, y, t.cell * ppm + 0.5, t.cell * ppm + 0.5);
    }
    g.setLineDash([3 * ppm, 3 * ppm]); g.strokeStyle = 'rgba(255,255,255,0.85)'; g.lineWidth = 0.8 * ppm;
    path(this.course.data.boundary); g.stroke(); g.setLineDash([]);
    return cv;
  }

  private draw() {
    const g = this.g, b = this.course.data.bounds, ppm = this.ppm;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#1d3a26'; g.fillRect(0, 0, this.W, this.H);
    // Course picture: image pixel (u, v) is map point (minX + u/ppm, maxY - v/ppm).
    const r = (this.rot * Math.PI) / 180, s = this.scale, c0 = this.center[0], c1 = this.center[1];
    const cos = Math.cos(r), sin = Math.sin(r);
    g.setTransform(s * cos / ppm, -s * sin / ppm, s * sin / ppm, s * cos / ppm,
      this.W / 2 + s * ((b.minX - c0) * cos - (b.maxY - c1) * sin),
      this.H / 2 - s * ((b.minX - c0) * sin + (b.maxY - c1) * cos));
    g.imageSmoothingEnabled = true;
    g.drawImage(this.base, 0, 0);
    g.setTransform(1, 0, 0, 1, 0, 0);
    const k = this.W / Math.max(1, this.canvas.getBoundingClientRect().width || 1); // device pixels per CSS pixel

    if (this.puttActive && this.putt) { this.drawPutt(k); return; }

    // Hole line, yardage markers, flag and tee.
    if (this.hole && this.currentView !== 'course') {
      g.setLineDash([6 * k, 5 * k]); g.strokeStyle = 'rgba(255,255,255,0.75)'; g.lineWidth = 1.5 * k;
      g.beginPath();
      [this.teeXY, ...this.hole.line.slice(1, -1), this.pin].forEach((p, i) => { const [x, y] = this.toScreen(p); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
      g.stroke(); g.setLineDash([]);
      const pts: XY[] = [this.pin, ...this.hole.line.slice(1, -1).reverse(), this.teeXY];
      let total = 0;
      for (let i = 1; i < pts.length; i++) total += dist(pts[i - 1], pts[i]);
      for (const yds of [100, 150, 200, 250, 300]) {
        const m = yds * YD;
        if (m > total - 30) break;
        let left = m, at: XY = pts[0];
        for (let i = 1; i < pts.length; i++) { const seg = dist(pts[i - 1], pts[i]); if (left <= seg) { const f = left / seg; at = [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f]; break; } left -= seg; }
        this.pill(this.toScreen(at), String(yds), '#ffffff', '#17221b', k * 0.9);
      }
    }
    if (this.currentView === 'course') {
      for (const h of this.course.holes) this.badge(this.toScreen(h.tees[0].center), String(h.ref), '#1f7a45', k);
    }
    for (const it of this.items) this.drawItem(it, k);
    if (this.hole && this.currentView !== 'course') {
      this.flag(this.toScreen(this.pin), k);
      this.badge(this.toScreen(this.teeXY), String(this.hole.ref), '#1f7a45', k);
    }
    if (this.me) {
      const [x, y] = this.toScreen(this.me.p);
      g.fillStyle = 'rgba(41,121,255,0.2)'; g.beginPath(); g.arc(x, y, Math.max(8 * k, this.me.acc * this.scale), 0, Math.PI * 2); g.fill();
      g.fillStyle = '#2979ff'; g.strokeStyle = '#fff'; g.lineWidth = 2 * k; g.beginPath(); g.arc(x, y, 7 * k, 0, Math.PI * 2); g.fill(); g.stroke();
    }
    if (this.wind) {
      const x = this.W - 70 * k, y = this.H - 40 * k;
      const to = ((this.wind.windFrom + 180 - this.rot) * Math.PI) / 180;
      g.save(); g.translate(x, y); g.rotate(to);
      g.strokeStyle = '#ffe066'; g.fillStyle = '#ffe066'; g.lineWidth = 3 * k;
      g.beginPath(); g.moveTo(0, 14 * k); g.lineTo(0, -10 * k); g.stroke();
      g.beginPath(); g.moveTo(0, -16 * k); g.lineTo(-6 * k, -6 * k); g.lineTo(6 * k, -6 * k); g.fill();
      g.restore();
      this.pill([x + 34 * k, y], `${Math.round(this.wind.windMph)} mph`, '#102018', '#fff', k);
    }
  }

  private drawItem(it: Item, k: number) {
    const g = this.g;
    if (it.t === 'arc') {
      const [x0, y0] = this.toScreen(it.a.from), [x1, y1] = this.toScreen(it.a.to);
      g.strokeStyle = it.a.color; g.globalAlpha = it.a.dashed ? 0.6 : 1; g.lineWidth = (it.a.dashed ? 2 : 3) * k;
      if (it.a.dashed) g.setLineDash([6 * k, 5 * k]);
      g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke(); g.setLineDash([]); g.globalAlpha = 1;
      g.strokeStyle = it.a.color; g.lineWidth = 2.5 * k; g.beginPath(); g.arc(x1, y1, 7 * k, 0, Math.PI * 2); g.stroke();
      if (it.a.label) this.pill([x1, y1 - 18 * k], it.a.label, 'rgba(16,24,20,0.85)', '#fff', k, it.a.color);
    } else if (it.t === 'dot') {
      const [x, y] = this.toScreen(it.p);
      g.fillStyle = it.color; g.beginPath(); g.arc(x, y, Math.max(3 * k, it.r * this.scale), 0, Math.PI * 2); g.fill();
    } else if (it.t === 'line') {
      const [x0, y0] = this.toScreen(it.a), [x1, y1] = this.toScreen(it.b);
      g.strokeStyle = it.color; g.lineWidth = 2 * k; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
    } else if (it.t === 'ellipse') {
      const e = it.e, [x, y] = this.toScreen(e.center);
      g.save(); g.translate(x, y); g.rotate(((e.bearing - this.rot) * Math.PI) / 180);
      g.globalAlpha = e.opacity ?? 0.28; g.fillStyle = e.color;
      g.beginPath(); g.ellipse(0, 0, Math.max(3, e.across * this.scale), Math.max(3, e.along * this.scale), 0, 0, Math.PI * 2); g.fill();
      g.globalAlpha = 1; g.strokeStyle = e.color; g.lineWidth = 1.5 * k; g.stroke();
      g.restore();
    } else if (it.t === 'label') {
      this.pill(this.toScreen(it.p), it.text, 'rgba(16,24,20,0.85)', '#fff', k, it.color);
    } else if (it.t === 'mark') {
      const [x, y] = this.toScreen(it.p), R = 10 * k;
      g.fillStyle = it.kind === 'safe' ? '#1e9e57' : '#d8432f'; g.beginPath(); g.arc(x, y, R, 0, Math.PI * 2); g.fill();
      g.strokeStyle = '#fff'; g.lineWidth = 1.5 * k; g.stroke();
      g.lineWidth = 2.5 * k; g.lineCap = 'round'; g.beginPath();
      if (it.kind === 'safe') { g.moveTo(x - 5 * k, y); g.lineTo(x - 1.5 * k, y + 4 * k); g.lineTo(x + 5 * k, y - 4 * k); }
      else { g.moveTo(x - 4 * k, y - 4 * k); g.lineTo(x + 4 * k, y + 4 * k); g.moveTo(x + 4 * k, y - 4 * k); g.lineTo(x - 4 * k, y + 4 * k); }
      g.stroke();
    }
  }

  private drawPutt(k: number) {
    const g = this.g, pt = this.putt!;
    // cup
    const [hx, hy] = this.toScreen(this.pin);
    g.fillStyle = '#111'; g.beginPath(); g.arc(hx, hy, Math.max(4 * k, 0.054 * this.scale), 0, Math.PI * 2); g.fill();
    this.flag([hx, hy], k);
    // aim line and marker
    const [bx, by] = this.toScreen(pt.ball), [ax, ay] = this.toScreen(pt.aim);
    g.setLineDash([5 * k, 4 * k]); g.strokeStyle = '#fff'; g.lineWidth = 1.5 * k; g.beginPath(); g.moveTo(bx, by); g.lineTo(ax, ay); g.stroke(); g.setLineDash([]);
    g.strokeStyle = '#ffd54f'; g.lineWidth = 3 * k; g.beginPath(); g.arc(ax, ay, 9 * k, 0, Math.PI * 2); g.stroke();
    // predicted roll
    if (pt.path.length > 1) {
      g.strokeStyle = pt.holed ? '#ffffff' : '#ff8a3d'; g.lineWidth = 3 * k; g.beginPath();
      pt.path.forEach((p, i) => { const [x, y] = this.toScreen(p); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
      g.stroke();
    }
    // ball (rolling if animating)
    let ball = pt.ball;
    if (this.rollAt && pt.path.length > 1) {
      const t = Math.min(1, (performance.now() - this.rollAt.start) / this.rollAt.dur);
      const s = 1 - (1 - t) * (1 - t);
      ball = pt.path[Math.min(pt.path.length - 1, Math.floor(s * (pt.path.length - 1)))];
      if (t >= 1) this.rollAt = null;
    }
    const [x, y] = this.toScreen(ball);
    g.fillStyle = '#fff'; g.strokeStyle = '#17221b'; g.lineWidth = 2 * k; g.beginPath(); g.arc(x, y, 7 * k, 0, Math.PI * 2); g.fill(); g.stroke();
  }

  private pill(at: [number, number], text: string, bg: string, fg: string, k: number, bar?: string) {
    const g = this.g;
    g.font = `600 ${12 * k}px -apple-system, system-ui, sans-serif`;
    const w = g.measureText(text).width + 12 * k, h = 18 * k;
    g.fillStyle = bg; g.beginPath(); g.roundRect(at[0] - w / 2, at[1] - h / 2, w, h, 6 * k); g.fill();
    if (bar) { g.fillStyle = bar; g.fillRect(at[0] - w / 2, at[1] - h / 2, 3 * k, h); }
    g.fillStyle = fg; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, at[0], at[1] + 0.5 * k);
  }
  private badge(at: [number, number], text: string, color: string, k: number) {
    const g = this.g, R = 11 * k;
    g.fillStyle = color; g.strokeStyle = '#fff'; g.lineWidth = 2 * k;
    g.beginPath(); g.arc(at[0], at[1], R, 0, Math.PI * 2); g.fill(); g.stroke();
    g.fillStyle = '#fff'; g.font = `800 ${12 * k}px -apple-system, system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, at[0], at[1] + 0.5 * k);
  }
  private flag(at: [number, number], k: number) {
    const g = this.g, R = 12 * k;
    g.fillStyle = '#fff'; g.strokeStyle = '#e53935'; g.lineWidth = 2 * k;
    g.beginPath(); g.arc(at[0], at[1], R, 0, Math.PI * 2); g.fill(); g.stroke();
    g.fillStyle = '#333'; g.fillRect(at[0] - 3 * k, at[1] - 7 * k, 1.6 * k, 14 * k);
    g.fillStyle = '#e53935'; g.beginPath(); g.moveTo(at[0] - 1.4 * k, at[1] - 7 * k); g.lineTo(at[0] + 7 * k, at[1] - 4 * k); g.lineTo(at[0] - 1.4 * k, at[1] - 1 * k); g.fill();
  }

  // ---------- input ----------
  private setupInput() {
    const c = this.canvas;
    const pointers = new Map<number, { x: number; y: number }>();
    let down: { x: number; y: number; t: number } | null = null;
    let pinch: { d: number; scale: number } | null = null;
    let mode: 'pan' | 'aim' | 'ball' | null = null;
    const moved = () => { if (!this.userMoved) { this.userMoved = true; this.onUserMove(true); } };
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      down = { x: e.clientX, y: e.clientY, t: performance.now() };
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), scale: this.scale };
        mode = null;
        return;
      }
      mode = 'pan';
      if (this.puttActive && !this.puttPlacing && this.putt) {
        const bp = this.toScreen(this.putt.ball);
        const r = c.getBoundingClientRect(), k = this.W / Math.max(1, r.width);
        const near = Math.hypot(bp[0] / k + r.left - e.clientX, bp[1] / k + r.top - e.clientY) < 30;
        mode = near ? 'ball' : 'aim';
        const p = this.clientToMap(e.clientX, e.clientY);
        if (mode === 'ball') this.onBallMove(p, false); else this.onAim(p, false);
      }
    });
    c.addEventListener('pointermove', (e) => {
      const prev = pointers.get(e.pointerId);
      if (!prev) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        this.scale = Math.max(0.05, Math.min(400, pinch.scale * (Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1, pinch.d))));
        moved(); this.render();
        return;
      }
      if (mode === 'aim') { this.onAim(this.clientToMap(e.clientX, e.clientY), false); return; }
      if (mode === 'ball') { this.onBallMove(this.clientToMap(e.clientX, e.clientY), false); return; }
      if (mode === 'pan' && down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) {
        const a = this.clientToMap(prev.x, prev.y), b = this.clientToMap(e.clientX, e.clientY);
        this.center = [this.center[0] - (b[0] - a[0]), this.center[1] - (b[1] - a[1])];
        moved(); this.render();
      }
    });
    const end = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      const p = this.clientToMap(e.clientX, e.clientY);
      if (mode === 'aim') { this.onAim(p, true); mode = null; down = null; return; }
      if (mode === 'ball') { this.onBallMove(p, true); mode = null; down = null; return; }
      if (down && pointers.size === 0) {
        const quick = performance.now() - down.t < 450 && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 8;
        if (quick) this.onTap(p);
      }
      if (pointers.size === 0) { down = null; mode = null; }
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', (e) => { pointers.delete(e.pointerId); pinch = null; mode = null; down = null; });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const before = this.clientToMap(e.clientX, e.clientY);
      this.scale = Math.max(0.05, Math.min(400, this.scale * Math.exp(-e.deltaY * 0.0015)));
      const after = this.clientToMap(e.clientX, e.clientY);
      this.center = [this.center[0] + before[0] - after[0], this.center[1] + before[1] - after[1]];
      moved(); this.render();
    }, { passive: false });
  }
}
