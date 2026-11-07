// 3D view of one hole: real terrain with the course surfaces painted on top.
// World axes: X = east, Y = up, Z = south (so map y = -Z). Each hole is rotated so
// the tee-to-green direction points "into the screen" (−Z).
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Course, Hole, XY, Feature, dist, bearing, pointInFeature, YD } from './course';

export interface Arc { from: XY; to: XY; color: string; label?: string; dashed?: boolean; width?: number }
export interface Ellipse { center: XY; along: number; across: number; bearing: number; color: string }
export type ViewName = 'tee' | 'top' | 'green';

const COLORS = {
  ob: '#7b8a68', rough: '#4f8c3c', wood: '#2e5c2a', fairway: '#6db347', tee: '#79bf52', green: '#8fd65f',
  bunker: '#eadfb4', water: '#3d80c6', path: '#c9c3b3', building: '#a39a90', range: '#5f9a45',
};

interface Region { minX: number; minY: number; maxX: number; maxY: number }
interface HoleAssets { region: Region; mesh: THREE.Mesh; trees: THREE.Object3D }

export class HoleScene {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  group = new THREE.Group(); // rotated per hole
  overlay = new THREE.Group(); // plan arcs, markers
  me = new THREE.Group();
  onTap: (p: XY) => void = () => {};
  private course: Course;
  private hole: Hole | null = null;
  private exaggerate = 1.5;
  private cache = new Map<string, HoleAssets>();
  private current: HoleAssets | null = null;
  private backdrop: THREE.Mesh | null = null;
  private teeXY: XY = [0, 0];
  private pin: XY = [0, 0];
  private needsRender = true;
  private pinObj = new THREE.Group();
  private teeObj = new THREE.Group();

  constructor(private el: HTMLElement, course: Course) {
    this.course = course;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    el.appendChild(this.renderer.domElement);
    this.camera = new THREE.PerspectiveCamera(50, 1, 1, 6000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.maxPolarAngle = Math.PI * 0.47;
    this.controls.minDistance = 15;
    this.controls.maxDistance = 1400;
    this.controls.screenSpacePanning = false;
    this.controls.addEventListener('change', () => this.render());

    this.scene.fog = new THREE.Fog(0xcfe3f2, 700, 2200);
    this.scene.add(new THREE.HemisphereLight(0xdfefff, 0x4a5a30, 1.1));
    const sun = new THREE.DirectionalLight(0xfff4e0, 1.9);
    sun.position.set(-300, 420, 200);
    this.scene.add(sun);
    this.scene.add(this.group);
    this.group.add(this.overlay, this.me, this.pinObj, this.teeObj);
    this.buildMarkers();

    this.setupTap();
    new ResizeObserver(() => this.resize()).observe(el);
    this.resize();
    const loop = () => {
      requestAnimationFrame(loop);
      if (this.controls.update() || this.needsRender) {
        this.renderer.render(this.scene, this.camera);
        this.needsRender = false;
      }
    };
    loop();
  }

  render() { this.needsRender = true; }

  private resize() {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.render();
  }

  // ---------- coordinates ----------
  private y(p: XY, lift = 0) { return this.course.height(p[0], p[1]) * this.exaggerate + lift; }
  private v3(p: XY, lift = 0) { return new THREE.Vector3(p[0], this.y(p, lift), -p[1]); }

  setExaggeration(v: number) {
    if (v === this.exaggerate) return;
    this.exaggerate = v;
    for (const a of this.cache.values()) { a.mesh.geometry.dispose(); }
    this.cache.clear();
    this.buildBackdrop();
    if (this.hole) { const h = this.hole; this.hole = null; this.setHole(h, this.teeXY, this.pin); }
  }

  // ---------- hole ----------
  setHole(hole: Hole, tee: XY, pin: XY, keepCamera = false) {
    const same = this.hole?.ref === hole.ref;
    this.hole = hole;
    this.teeXY = tee;
    this.pin = pin;
    if (!this.backdrop) this.buildBackdrop();
    let assets = this.cache.get(String(hole.ref));
    if (!assets) { assets = this.buildHole(hole); this.cache.set(String(hole.ref), assets); }
    if (this.current !== assets) {
      if (this.current) this.group.remove(this.current.mesh, this.current.trees);
      this.group.add(assets.mesh, assets.trees);
      this.current = assets;
    }
    // Rotate so tee→green points to −Z.
    const brg = bearing(tee, pin);
    this.group.rotation.y = (brg * Math.PI) / 180;
    this.placeMarkers();
    if (!same || !keepCamera) this.view('tee');
    this.render();
  }

  private holeRegion(hole: Hole): Region {
    const pts: XY[] = [...hole.line, ...hole.tees.map((t) => t.center), hole.pin];
    const g = this.course.greenOf(hole);
    if (g) pts.push(...g.rings[0]);
    const M = 75;
    const b = this.course.data.terrain;
    return {
      minX: Math.max(b.minX, Math.min(...pts.map((p) => p[0])) - M),
      minY: Math.max(b.minY, Math.min(...pts.map((p) => p[1])) - M),
      maxX: Math.min(b.minX + (b.cols - 1) * b.cell, Math.max(...pts.map((p) => p[0])) + M),
      maxY: Math.min(b.minY + (b.rows - 1) * b.cell, Math.max(...pts.map((p) => p[1])) + M),
    };
  }

  private buildHole(hole: Hole): HoleAssets {
    const region = this.holeRegion(hole);
    const mesh = this.buildTerrain(region, 90000, 3, bearing(hole.line[0], hole.pin), hole.ref, 0);
    mesh.name = 'terrain';
    return { region, mesh, trees: this.buildTrees(region) };
  }

  /** Low-detail terrain for the whole course, shown around the current hole. */
  private buildBackdrop() {
    if (this.backdrop) { this.group.remove(this.backdrop); this.backdrop.geometry.dispose(); }
    const t = this.course.data.terrain;
    const region = { minX: t.minX, minY: t.minY, maxX: t.minX + (t.cols - 1) * t.cell, maxY: t.minY + (t.rows - 1) * t.cell };
    this.backdrop = this.buildTerrain(region, 30000, 1.2, null, 0, -1.2);
    (this.backdrop.material as THREE.MeshLambertMaterial).color.setScalar(0.72);
    this.group.add(this.backdrop);
  }

  private buildTerrain(region: Region, maxVerts: number, maxPpm: number, stripes: number | null, seed: number, lift: number) {
    const W = region.maxX - region.minX, H = region.maxY - region.minY;
    const cell = this.course.data.terrain.cell;
    let step = cell;
    while ((W / step) * (H / step) > maxVerts) step += cell;
    const nx = Math.floor(W / step) + 1, ny = Math.floor(H / step) + 1;
    const pos = new Float32Array(nx * ny * 3), uv = new Float32Array(nx * ny * 2);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const x = region.minX + i * step, yy = region.minY + j * step, k = j * nx + i;
      pos[k * 3] = x; pos[k * 3 + 1] = this.course.height(x, yy) * this.exaggerate + lift; pos[k * 3 + 2] = -yy;
      uv[k * 2] = (x - region.minX) / W; uv[k * 2 + 1] = (yy - region.minY) / H;
    }
    const idx = new Uint32Array((nx - 1) * (ny - 1) * 6);
    let n = 0;
    for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      idx[n++] = a; idx[n++] = b; idx[n++] = c; idx[n++] = b; idx[n++] = d; idx[n++] = c;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();
    const tex = new THREE.CanvasTexture(this.paint(region, maxPpm, stripes, seed));
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    return new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: tex }));
  }

  private paint(r: Region, maxPpm: number, stripes: number | null, seed: number): HTMLCanvasElement {
    const W = r.maxX - r.minX, H = r.maxY - r.minY;
    const ppm = Math.min(2048 / W, 2048 / H, maxPpm);
    const cv = document.createElement('canvas');
    cv.width = Math.round(W * ppm); cv.height = Math.round(H * ppm);
    const g = cv.getContext('2d')!;
    const tx = (p: XY): [number, number] => [(p[0] - r.minX) * ppm, (r.maxY - p[1]) * ppm];
    const path = (rings: XY[][]) => {
      g.beginPath();
      for (const ring of rings) ring.forEach((p, i) => { const [a, b] = tx(p); if (i) g.lineTo(a, b); else g.moveTo(a, b); });
      g.closePath();
    };
    const fill = (f: Feature, color: string) => { path([...f.rings, ...f.holes]); g.fillStyle = color; g.fill('evenodd'); };

    g.fillStyle = COLORS.ob; g.fillRect(0, 0, cv.width, cv.height);
    path(this.course.data.boundary); g.fillStyle = COLORS.rough; g.fill('evenodd');
    // grass texture noise
    const rnd = mulberry(seed * 999 + 1);
    for (let i = 0; i < (cv.width * cv.height) / 90; i++) {
      g.fillStyle = rnd() > 0.5 ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.045)';
      g.fillRect(rnd() * cv.width, rnd() * cv.height, 2 + rnd() * 3, 2 + rnd() * 3);
    }
    const order: Feature['kind'][] = ['range', 'wood', 'fairway', 'tee', 'green', 'bunker', 'water', 'building'];
    for (const kind of order) {
      for (const f of this.course.features) {
        if (f.kind !== kind) continue;
        const b = f.bbox!;
        if (b[2] < r.minX || b[0] > r.maxX || b[3] < r.minY || b[1] > r.maxY) continue;
        fill(f, COLORS[kind as keyof typeof COLORS] ?? COLORS.rough);
        if (stripes !== null && (kind === 'fairway' || kind === 'green' || kind === 'tee')) {
          // mowing stripes across the line of play
          g.save(); path([...f.rings, ...f.holes]); g.clip('evenodd');
          g.translate(cv.width / 2, cv.height / 2); g.rotate((stripes * Math.PI) / 180);
          const s = (kind === 'green' ? 4 : 9) * ppm;
          g.fillStyle = 'rgba(255,255,255,0.07)';
          for (let y = -cv.height * 1.5; y < cv.height * 1.5; y += s * 2) g.fillRect(-cv.width * 1.5, y, cv.width * 3, s);
          g.restore();
        }
        if (kind === 'bunker') { path(f.rings); g.strokeStyle = 'rgba(120,100,60,0.45)'; g.lineWidth = 0.6 * ppm; g.stroke(); }
        if (kind === 'water') { path(f.rings); g.strokeStyle = 'rgba(20,60,110,0.6)'; g.lineWidth = 0.8 * ppm; g.stroke(); }
        if (kind === 'green') { path(f.rings); g.strokeStyle = 'rgba(40,90,30,0.5)'; g.lineWidth = 1.2 * ppm; g.stroke(); }
      }
    }
    g.lineCap = 'round'; g.lineJoin = 'round'; g.strokeStyle = COLORS.path; g.lineWidth = 2.4 * ppm;
    for (const line of this.course.data.paths) {
      g.beginPath(); line.forEach((p, i) => { const [a, b] = tx(p); if (i) g.lineTo(a, b); else g.moveTo(a, b); }); g.stroke();
    }
    // OB line
    g.setLineDash([3 * ppm, 3 * ppm]); g.strokeStyle = 'rgba(255,255,255,0.85)'; g.lineWidth = 0.7 * ppm;
    path(this.course.data.boundary); g.stroke(); g.setLineDash([]);
    return cv;
  }

  private buildTrees(r: Region): THREE.Object3D {
    const grp = new THREE.Group();
    const rnd = mulberry(Math.round(r.minX * 31 + r.minY));
    const spots: { p: XY; s: number }[] = [];
    const woods = this.course.features.filter((f) => f.kind === 'wood');
    for (const f of woods) {
      const b = f.bbox!;
      const x0 = Math.max(b[0], r.minX), x1 = Math.min(b[2], r.maxX), y0 = Math.max(b[1], r.minY), y1 = Math.min(b[3], r.maxY);
      if (x0 >= x1 || y0 >= y1) continue;
      const tries = Math.min(5000, ((x1 - x0) * (y1 - y0)) / 55);
      for (let i = 0; i < tries && spots.length < 3500; i++) {
        const p: XY = [x0 + rnd() * (x1 - x0), y0 + rnd() * (y1 - y0)];
        if (pointInFeature(p, f)) spots.push({ p, s: 0.75 + rnd() * 0.6 });
      }
    }
    for (const t of this.course.data.trees) if (t[0] > r.minX && t[0] < r.maxX && t[1] > r.minY && t[1] < r.maxY) spots.push({ p: t, s: 1 });
    if (!spots.length) return grp;
    const canopyGeo = new THREE.IcosahedronGeometry(1, 0);
    canopyGeo.scale(4.5, 5.5, 4.5);
    canopyGeo.translate(0, 8, 0);
    const trunkGeo = new THREE.CylinderGeometry(0.35, 0.5, 4, 5);
    trunkGeo.translate(0, 2, 0);
    const canopy = new THREE.InstancedMesh(canopyGeo, new THREE.MeshLambertMaterial({ flatShading: true }), spots.length);
    const trunk = new THREE.InstancedMesh(trunkGeo, new THREE.MeshLambertMaterial({ color: 0x5b4632 }), spots.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), c = new THREE.Color();
    spots.forEach(({ p, s }, i) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * Math.PI);
      m.compose(new THREE.Vector3(p[0], this.y(p) - 0.3, -p[1]), q, new THREE.Vector3(s, s, s));
      canopy.setMatrixAt(i, m); trunk.setMatrixAt(i, m);
      canopy.setColorAt(i, c.setHSL(0.26 + rnd() * 0.06, 0.45 + rnd() * 0.2, 0.2 + rnd() * 0.1));
    });
    grp.add(canopy, trunk);
    return grp;
  }

  // ---------- markers ----------
  private buildMarkers() {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 7, 6), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    pole.position.y = 3.5;
    const flagShape = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(2.6, -0.8), new THREE.Vector2(0, -1.6)]);
    const flag = new THREE.Mesh(new THREE.ShapeGeometry(flagShape), new THREE.MeshBasicMaterial({ color: 0xe53935, side: THREE.DoubleSide }));
    flag.position.y = 7;
    const cup = new THREE.Mesh(new THREE.RingGeometry(0.6, 1.1, 24), new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }));
    cup.rotation.x = -Math.PI / 2; cup.position.y = 0.15;
    this.pinObj.add(pole, flag, cup);
    for (const dx of [-3, 3]) {
      const ball = new THREE.Mesh(new THREE.SphereGeometry(0.6, 10, 8), new THREE.MeshLambertMaterial({ color: 0xffffff }));
      ball.position.set(dx, 0.5, 0);
      this.teeObj.add(ball);
    }
    const dot = new THREE.Mesh(new THREE.SphereGeometry(1.6, 16, 12), new THREE.MeshBasicMaterial({ color: 0x2979ff }));
    dot.position.y = 1.6;
    const halo = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 48), new THREE.MeshBasicMaterial({ color: 0x2979ff, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false }));
    halo.rotation.x = -Math.PI / 2; halo.position.y = 0.4; halo.name = 'halo';
    this.me.add(dot, halo);
    this.me.visible = false;
  }

  private placeMarkers() {
    this.pinObj.position.copy(this.v3(this.pin));
    this.teeObj.position.copy(this.v3(this.teeXY));
    this.teeObj.rotation.y = this.group.rotation.y;
  }

  setPin(pin: XY) { this.pin = pin; this.placeMarkers(); this.render(); }

  setMe(p: XY | null, accuracy = 5) {
    this.me.visible = !!p;
    if (p) {
      this.me.position.copy(this.v3(p));
      const halo = this.me.getObjectByName('halo')!;
      const s = Math.max(2, accuracy);
      halo.scale.set(s, s, s);
    }
    this.render();
  }

  // ---------- overlays ----------
  clearOverlay() {
    for (const o of [...this.overlay.children]) {
      this.overlay.remove(o);
      o.traverse((c) => { const m = c as THREE.Mesh; m.geometry?.dispose(); const mat = m.material as THREE.Material & { map?: THREE.Texture }; mat?.map?.dispose(); mat?.dispose?.(); });
    }
    this.render();
  }

  addArc(a: Arc) {
    const p0 = this.v3(a.from, 0.5), p2 = this.v3(a.to, 0.5);
    const d = dist(a.from, a.to);
    const peak = Math.min(38, d * 0.14);
    const mid = p0.clone().lerp(p2, 0.55); mid.y = Math.max(p0.y, p2.y) + peak * 2;
    const curve = new THREE.QuadraticBezierCurve3(p0, mid, p2);
    const color = new THREE.Color(a.color);
    const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 48, (a.width ?? 0.7), 6, false), new THREE.MeshBasicMaterial({ color, transparent: !!a.dashed, opacity: a.dashed ? 0.55 : 1 }));
    this.overlay.add(tube);
    // landing marker
    const ring = new THREE.Mesh(new THREE.RingGeometry(2.2, 3.2, 32), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2; ring.position.copy(this.v3(a.to, 0.3));
    this.overlay.add(ring);
    if (a.label) this.addLabel(a.to, a.label, a.color);
    this.render();
  }

  addDot(p: XY, color: string, r = 1.2) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 8), new THREE.MeshBasicMaterial({ color }));
    m.position.copy(this.v3(p, r * 0.7));
    this.overlay.add(m);
    this.render();
  }

  addGroundLine(a: XY, b: XY, color: string) {
    const n = Math.max(2, Math.ceil(dist(a, b) / 3));
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      pts.push(this.v3([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], 0.6));
    }
    const curve = new THREE.CatmullRomCurve3(pts);
    this.overlay.add(new THREE.Mesh(new THREE.TubeGeometry(curve, n * 2, 0.35, 5, false), new THREE.MeshBasicMaterial({ color })));
    this.render();
  }

  addEllipse(e: Ellipse) {
    const seg = 48, pts: number[] = [], rad = (e.bearing * Math.PI) / 180;
    const fwd: XY = [Math.sin(rad), Math.cos(rad)], side: XY = [Math.cos(rad), -Math.sin(rad)];
    const center = this.v3(e.center, 0.35);
    const verts: THREE.Vector3[] = [center];
    for (let i = 0; i <= seg; i++) {
      const t = (i / seg) * Math.PI * 2;
      const p: XY = [e.center[0] + fwd[0] * Math.cos(t) * e.along + side[0] * Math.sin(t) * e.across, e.center[1] + fwd[1] * Math.cos(t) * e.along + side[1] * Math.sin(t) * e.across];
      verts.push(this.v3(p, 0.35));
    }
    for (let i = 1; i <= seg; i++) pts.push(...verts[0].toArray(), ...verts[i].toArray(), ...verts[i + 1].toArray());
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.overlay.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: e.color, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false })));
    const outline = new THREE.BufferGeometry().setFromPoints(verts.slice(1));
    this.overlay.add(new THREE.Line(outline, new THREE.LineBasicMaterial({ color: e.color })));
    this.render();
  }

  addLabel(p: XY, text: string, color = '#ffffff') {
    const cv = document.createElement('canvas');
    const g = cv.getContext('2d')!;
    const font = '600 30px -apple-system, system-ui, sans-serif';
    g.font = font;
    const w = Math.ceil(g.measureText(text).width) + 28;
    cv.width = w; cv.height = 46;
    g.font = font;
    g.fillStyle = 'rgba(16,24,20,0.82)';
    roundRect(g, 0, 0, w, 46, 12); g.fill();
    g.fillStyle = color; g.fillRect(0, 0, 7, 46);
    g.fillStyle = '#fff'; g.textBaseline = 'middle'; g.fillText(text, 16, 24);
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, sizeAttenuation: false }));
    const hpx = 23; // on-screen height in CSS px
    sprite.userData = { w, h: 46, hpx };
    sprite.center.set(0.5, -0.4);
    sprite.position.copy(this.v3(p, 2));
    sprite.renderOrder = 10;
    this.overlay.add(sprite);
    this.sizeLabels();
  }

  private sizeLabels() {
    const vh = this.el.clientHeight || 600;
    const fovScale = 2 * Math.tan(((this.camera.fov / 2) * Math.PI) / 180);
    this.overlay.traverse((o) => {
      if ((o as THREE.Sprite).isSprite) {
        const { w, h, hpx } = o.userData;
        const sy = (hpx / vh) * fovScale;
        o.scale.set(sy * (w / h), sy, 1);
      }
    });
  }

  // ---------- camera ----------
  view(name: ViewName) {
    if (!this.hole) return;
    const tee = this.v3(this.teeXY), pin = this.v3(this.pin);
    const toLocal = (v: THREE.Vector3) => this.group.localToWorld(v.clone());
    const teeW = toLocal(tee), pinW = toLocal(pin);
    const len = dist(this.teeXY, this.pin);
    const dir = pinW.clone().sub(teeW).setY(0).normalize();
    if (name === 'tee') {
      const look = teeW.clone().lerp(pinW, Math.min(0.6, 210 / len));
      this.camera.position.copy(teeW).addScaledVector(dir, -32).add(new THREE.Vector3(0, 22, 0));
      this.controls.target.copy(look);
    } else if (name === 'top') {
      const mid = teeW.clone().lerp(pinW, 0.5);
      const h = (len * 0.62 + 30) / Math.tan(((this.camera.fov / 2) * Math.PI) / 180);
      this.camera.position.copy(mid).add(new THREE.Vector3(0, h, 0)).addScaledVector(dir, -h * 0.12);
      this.controls.target.copy(mid);
    } else {
      this.camera.position.copy(pinW).addScaledVector(dir, -55).add(new THREE.Vector3(0, 26, 0));
      this.controls.target.copy(pinW);
    }
    this.controls.update();
    this.sizeLabels();
    this.render();
  }

  focus(p: XY) {
    const w = this.group.localToWorld(this.v3(p));
    this.camera.position.add(w.clone().sub(this.controls.target));
    this.controls.target.copy(w);
    this.controls.update();
    this.render();
  }

  // ---------- tapping ----------
  private setupTap() {
    const c = this.renderer.domElement;
    let down: { x: number; y: number; t: number } | null = null;
    c.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
    c.addEventListener('pointerup', (e) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      const quick = performance.now() - down.t < 450;
      down = null;
      if (moved > 8 || !quick) return;
      const p = this.pick(e.clientX, e.clientY);
      if (p) this.onTap(p);
    });
  }

  pick(clientX: number, clientY: number): XY | null {
    if (!this.current) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hit = ray.intersectObject(this.current.mesh)[0];
    if (!hit) return null;
    const local = this.group.worldToLocal(hit.point.clone());
    return [local.x, -local.z];
  }

  /** Screen position of a map point (for DOM overlays and tests). */
  project(p: XY) {
    const v = this.group.localToWorld(this.v3(p)).project(this.camera);
    const rect = this.renderer.domElement.getBoundingClientRect();
    return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height };
  }
}

export function dispersion(club: { yds: number; sdYds: number; sdDeg: number }) {
  // ~80% of shots land inside 1.3 standard deviations in each direction
  const k = 1.3;
  return { along: club.sdYds * YD * k, across: Math.tan((club.sdDeg * Math.PI) / 180) * club.yds * YD * k };
}

function mulberry(a: number) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
