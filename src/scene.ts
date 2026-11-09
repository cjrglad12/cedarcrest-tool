// 3D view of one hole: real terrain with the course surfaces painted on top.
// World axes: X = east, Y = up, Z = south (so map y = -Z). Each hole is rotated so
// the tee-to-green direction points "into the screen" (−Z).
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { Course, Hole, XY, Feature, dist, bearing, YD, TREE_M, pointInFeature } from './course';

export interface Arc { from: XY; to: XY; color: string; label?: string; dashed?: boolean; width?: number }
export interface Ellipse { center: XY; along: number; across: number; bearing: number; color: string }
export type ViewName = 'tee' | 'top' | 'green' | 'course';
export interface Wind { windFrom: number; windMph: number }

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
  private landmarks = new THREE.Group(); // buildings and place labels
  private courseOnly = new THREE.Group(); // every hole's line, shown in the course view
  private windGroup = new THREE.Group();
  private windArrows: { mesh: THREE.Mesh; base: THREE.Vector3; dir: THREE.Vector3 }[] = [];
  private windSpacing = 50;
  private wind: Wind | null = null;
  private holeRot = 0;
  currentView: ViewName = 'top';
  /** Called with the on-screen angle of north (degrees clockwise from up) whenever the view turns. */
  onCompass: (deg: number) => void = () => {};

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
    this.group.add(this.overlay, this.me, this.pinObj, this.teeObj, this.landmarks, this.windGroup, this.greenSlope);
    this.landmarks.add(this.courseOnly);
    this.buildMarkers();

    this.setupTap();
    new ResizeObserver(() => this.resize()).observe(el);
    this.resize();
    let last = performance.now();
    const loop = (now: number) => {
      requestAnimationFrame(loop);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (this.windGroup.visible && this.windArrows.length) { this.animateWind(dt); this.needsRender = true; }
      if (this.controls.update() || this.needsRender) {
        this.renderer.render(this.scene, this.camera);
        this.needsRender = false;
        this.updateCompass();
      }
    };
    requestAnimationFrame(loop);
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
    this.buildLandmarks();
    if (this.hole) { const h = this.hole; this.hole = null; this.setHole(h, this.teeXY, this.pin); }
  }

  // ---------- hole ----------
  setHole(hole: Hole, tee: XY, pin: XY, keepCamera = false) {
    const same = this.hole?.ref === hole.ref;
    this.hole = hole;
    this.teeXY = tee;
    this.pin = pin;
    if (!this.backdrop) { this.buildBackdrop(); this.buildLandmarks(); }
    let assets = this.cache.get(String(hole.ref));
    if (!assets) { assets = this.buildHole(hole); this.cache.set(String(hole.ref), assets); }
    if (this.current !== assets) {
      if (this.current) this.group.remove(this.current.mesh, this.current.trees);
      this.group.add(assets.mesh, assets.trees);
      this.current = assets;
    }
    // Rotate so tee→green points to −Z.
    const brg = bearing(tee, pin);
    this.holeRot = (brg * Math.PI) / 180;
    this.group.rotation.y = this.currentView === 'course' ? 0 : this.holeRot;
    this.placeMarkers();
    this.buildWind();
    if (!same || !keepCamera) this.view(this.currentView === 'course' && keepCamera ? 'course' : 'top');
    else this.showLabelsFor(this.currentView);
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
    const lm = this.course.data.landmarks;
    if (lm) {
      g.lineCap = 'round'; g.lineJoin = 'round';
      for (const r0 of lm.roads) {
        g.strokeStyle = '#9b9a94';
        g.lineWidth = (r0.kind.startsWith('secondary') || r0.kind.startsWith('primary') ? 13 : r0.kind.startsWith('tertiary') ? 11 : 8) * ppm;
        g.beginPath(); r0.line.forEach((p, i) => { const [a, b] = tx(p); if (i) g.lineTo(a, b); else g.moveTo(a, b); }); g.stroke();
      }
    }
    path(this.course.data.boundary); g.fillStyle = COLORS.rough; g.fill('evenodd');
    if (lm) {
      for (const lot of lm.parking) {
        path([lot]); g.fillStyle = '#6e706b'; g.fill();
        g.save(); path([lot]); g.clip();
        g.strokeStyle = 'rgba(255,255,255,0.55)'; g.lineWidth = 0.25 * ppm;
        const bb = lot.reduce((a, p) => [Math.min(a[0], p[0]), Math.min(a[1], p[1]), Math.max(a[2], p[0]), Math.max(a[3], p[1])], [Infinity, Infinity, -Infinity, -Infinity]);
        for (let x = bb[0]; x < bb[2]; x += 2.7) { const [a, b] = tx([x, bb[3]]), [, d] = tx([x, bb[1]]); g.beginPath(); g.moveTo(a, b); g.lineTo(a, d); g.stroke(); }
        g.restore();
      }
      for (const bd of lm.buildings) { path([bd.ring]); g.fillStyle = '#8f8a83'; g.fill(); }
    }
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
    // Tree shade from the canopy map
    {
      const t = this.course.data.terrain;
      g.fillStyle = 'rgba(30,62,28,0.78)';
      const c0 = Math.max(0, Math.floor((r.minX - t.minX) / t.cell)), c1 = Math.min(t.cols - 1, Math.ceil((r.maxX - t.minX) / t.cell));
      const r0 = Math.max(0, Math.floor((r.minY - t.minY) / t.cell)), r1 = Math.min(t.rows - 1, Math.ceil((r.maxY - t.minY) / t.cell));
      for (let row = r0; row <= r1; row++) for (let col = c0; col <= c1; col++) {
        if (this.course.canopy[row * t.cols + col] < TREE_M) continue;
        const [px, py] = tx([t.minX + col * t.cell - t.cell / 2, t.minY + row * t.cell + t.cell / 2]);
        g.fillRect(px, py, t.cell * ppm + 0.5, t.cell * ppm + 0.5);
      }
    }
    // OB line
    g.setLineDash([3 * ppm, 3 * ppm]); g.strokeStyle = 'rgba(255,255,255,0.85)'; g.lineWidth = 0.7 * ppm;
    path(this.course.data.boundary); g.stroke(); g.setLineDash([]);
    return cv;
  }

  /** Trees from the canopy height map: one tree per ~6 m patch of canopy, at its measured height. */
  private buildTrees(r: Region): THREE.Object3D {
    const grp = new THREE.Group();
    const rnd = mulberry(Math.round(r.minX * 31 + r.minY));
    const spots: { p: XY; h: number }[] = [];
    const S = 6;
    for (let y = r.minY; y < r.maxY; y += S) for (let x = r.minX; x < r.maxX; x += S) {
      let best = 0, bx = 0, by = 0;
      for (let dy = 0; dy < S; dy += 2) for (let dx = 0; dx < S; dx += 2) {
        const h = this.course.treeAt(x + dx, y + dy);
        if (h > best) { best = h; bx = x + dx; by = y + dy; }
      }
      if (best >= TREE_M) spots.push({ p: [bx + (rnd() - 0.5) * 2, by + (rnd() - 0.5) * 2], h: best });
    }
    for (const t of this.course.data.trees) if (t[0] > r.minX && t[0] < r.maxX && t[1] > r.minY && t[1] < r.maxY) spots.push({ p: t, h: 10 });
    if (!spots.length) return grp;
    const canopyGeo = new THREE.IcosahedronGeometry(1, 1);
    const trunkGeo = new THREE.CylinderGeometry(0.6, 1, 1, 5);
    trunkGeo.translate(0, 0.5, 0);
    const canopy = new THREE.InstancedMesh(canopyGeo, new THREE.MeshLambertMaterial({ flatShading: true }), spots.length);
    const trunk = new THREE.InstancedMesh(trunkGeo, new THREE.MeshLambertMaterial({ color: 0x5b4632 }), spots.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), c = new THREE.Color(), up = new THREE.Vector3(0, 1, 0);
    spots.forEach(({ p, h }, i) => {
      const ground = this.y(p) - 0.3;
      const crownR = Math.max(2.5, Math.min(7, h * 0.38)) * (0.85 + rnd() * 0.3);
      const crownV = h * 0.42;
      q.setFromAxisAngle(up, rnd() * Math.PI);
      m.compose(new THREE.Vector3(p[0], ground + h - crownV, -p[1]), q, new THREE.Vector3(crownR, crownV, crownR));
      canopy.setMatrixAt(i, m);
      m.compose(new THREE.Vector3(p[0], ground, -p[1]), q, new THREE.Vector3(0.35 + h * 0.02, h - crownV, 0.35 + h * 0.02));
      trunk.setMatrixAt(i, m);
      canopy.setColorAt(i, c.setHSL(0.24 + rnd() * 0.08, 0.38 + rnd() * 0.2, 0.17 + rnd() * 0.09));
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

  private holeLine: THREE.Line | null = null;
  private greenSlope = new THREE.Group();

  /**
   * Slope arrows on the green, every 2.5 m: they point downhill and are colored by
   * steepness (from the 2 m elevation grid, so they show the general tilt and tiers,
   * not every small break).
   */
  private buildGreenSlope() {
    for (const o of [...this.greenSlope.children]) { this.greenSlope.remove(o); (o as THREE.Mesh).geometry?.dispose(); }
    const g = this.hole && this.course.greenOf(this.hole);
    if (!g) return;
    const ring = g.rings[0];
    const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
    const pts: { p: XY; dx: number; dy: number; pct: number }[] = [];
    const H = (x: number, y: number) => this.course.height(x, y);
    const step = 2.5, e = 2;
    for (let y = Math.min(...ys) + 1; y < Math.max(...ys); y += step) for (let x = Math.min(...xs) + 1; x < Math.max(...xs); x += step) {
      if (!pointInFeature([x, y], g)) continue;
      const gx = (H(x + e, y) - H(x - e, y)) / (2 * e), gy = (H(x, y + e) - H(x, y - e)) / (2 * e);
      const m = Math.hypot(gx, gy);
      pts.push({ p: [x, y], dx: -gx / (m || 1), dy: -gy / (m || 1), pct: m * 100 });
    }
    if (!pts.length) return;
    const shape = new THREE.Shape([[-0.22, -0.7], [0.22, -0.7], [0.22, 0.15], [0.6, 0.15], [0, 0.85], [-0.6, 0.15], [-0.22, 0.15]].map(([a, b]) => new THREE.Vector2(a, b)));
    const geo = new THREE.ShapeGeometry(shape);
    geo.rotateX(-Math.PI / 2);
    const mesh = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, depthWrite: false, transparent: true, opacity: 0.95 }), pts.length);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), c = new THREE.Color(), up = new THREE.Vector3(0, 1, 0);
    pts.forEach(({ p, dx, dy, pct }, i) => {
      q.setFromAxisAngle(up, Math.atan2(-dx, dy));
      const s = 0.7 + Math.min(1, pct / 3) * 0.6;
      m4.compose(this.v3(p, 0.35), q, new THREE.Vector3(s, s, s));
      mesh.setMatrixAt(i, m4);
      mesh.setColorAt(i, c.set(slopeColor(pct)));
    });
    mesh.renderOrder = 7;
    this.greenSlope.add(mesh);
  }
  private pinIcon: THREE.Sprite | null = null;
  private teeIcon: THREE.Sprite | null = null;

  private placeMarkers() {
    this.pinObj.position.copy(this.v3(this.pin));
    this.teeObj.position.copy(this.v3(this.teeXY));
    this.teeObj.rotation.y = this.group.rotation.y;
    // Screen-size flag and tee icons, so both are easy to spot even zoomed out.
    for (const o of [this.pinIcon, this.teeIcon, this.holeLine]) if (o) this.group.remove(o);
    this.pinIcon = iconSprite('flag');
    this.pinIcon.position.copy(this.v3(this.pin, 1));
    this.teeIcon = iconSprite('tee');
    this.teeIcon.position.copy(this.v3(this.teeXY, 1));
    if (this.hole) {
      const pts = [this.teeXY, ...this.hole.line.slice(1, -1), this.pin];
      const dense: THREE.Vector3[] = [];
      for (let i = 1; i < pts.length; i++) {
        const n = Math.max(1, Math.ceil(dist(pts[i - 1], pts[i]) / 6));
        for (let k = 0; k <= n; k++) dense.push(this.v3([pts[i - 1][0] + ((pts[i][0] - pts[i - 1][0]) * k) / n, pts[i - 1][1] + ((pts[i][1] - pts[i - 1][1]) * k) / n], 0.8));
      }
      this.holeLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(dense), new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 6, gapSize: 5, transparent: true, opacity: 0.7 }));
      this.holeLine.computeLineDistances();
      this.group.add(this.holeLine);
    }
    this.group.add(this.pinIcon, this.teeIcon);
    this.buildGreenSlope();
    this.greenSlope.visible = this.currentView === 'green';
    this.sizeLabels();
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
    this.overlay.add(this.makeLabel(p, text, color));
    this.sizeLabels();
  }

  private makeLabel(p: XY, text: string, color = '#ffffff', hpx = 23, style: 'tag' | 'place' | 'hole' = 'tag', lift = 2): THREE.Sprite {
    if (style !== 'tag') {
      const cv = document.createElement('canvas');
      const g = cv.getContext('2d')!;
      const font = style === 'hole' ? '800 34px -apple-system, system-ui, sans-serif' : '600 28px -apple-system, system-ui, sans-serif';
      g.font = font;
      const w = style === 'hole' ? 52 : Math.ceil(g.measureText(text).width) + 24;
      cv.width = Math.max(w, 52); cv.height = 52;
      g.font = font; g.textAlign = 'center'; g.textBaseline = 'middle';
      if (style === 'hole') {
        g.fillStyle = color; g.beginPath(); g.arc(26, 26, 24, 0, Math.PI * 2); g.fill();
        g.lineWidth = 3; g.strokeStyle = '#fff'; g.stroke();
        g.fillStyle = '#fff'; g.fillText(text, 26, 28);
      } else {
        g.lineWidth = 6; g.strokeStyle = 'rgba(20,28,22,0.85)'; g.strokeText(text, cv.width / 2, 27);
        g.fillStyle = color; g.fillText(text, cv.width / 2, 27);
      }
      const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, sizeAttenuation: false }));
      sp.userData = { w: cv.width, h: 52, hpx, p };
      sp.position.copy(this.v3(p, lift));
      sp.renderOrder = 9;
      return sp;
    }
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
    sprite.userData = { w, h: 46, hpx, p };
    sprite.center.set(0.5, -0.4);
    sprite.position.copy(this.v3(p, lift));
    sprite.renderOrder = 10;
    return sprite;
  }

  private sizeLabels() {
    const vh = this.el.clientHeight || 600;
    const fovScale = 2 * Math.tan(((this.camera.fov / 2) * Math.PI) / 180);
    this.group.traverse((o) => {
      if ((o as THREE.Sprite).isSprite && o.userData.w) {
        const { w, h, hpx } = o.userData;
        const sy = (hpx / vh) * fovScale;
        o.scale.set(sy * (w / h), sy, 1);
      }
    });
  }

  // ---------- camera ----------
  view(name: ViewName) {
    if (!this.hole) return;
    this.currentView = name;
    this.group.rotation.y = name === 'course' ? 0 : this.holeRot;
    this.group.updateMatrixWorld(true);
    this.showLabelsFor(name);
    this.buildWind();
    if (name === 'course') {
      const b = this.course.data.bounds;
      const mid = new THREE.Vector3((b.minX + b.maxX) / 2, 0, -(b.minY + b.maxY) / 2);
      const span = Math.max((b.maxY - b.minY) * 0.55, ((b.maxX - b.minX) * 0.55) / Math.max(0.5, this.camera.aspect));
      const h = span / Math.tan(((this.camera.fov / 2) * Math.PI) / 180);
      this.camera.position.set(mid.x, h, mid.z + h * 0.05);
      this.controls.target.copy(mid);
      this.controls.update();
      this.sizeLabels();
      this.render();
      return;
    }
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
      const mid = teeW.clone().lerp(pinW, 0.46);
      // Fit the whole hole, tee at the bottom and green at the top, slightly tilted.
      const h = (len * 0.68 + 45) / Math.tan(((this.camera.fov / 2) * Math.PI) / 180);
      this.camera.position.copy(mid).add(new THREE.Vector3(0, h * 0.95, 0)).addScaledVector(dir, -h * 0.3);
      this.controls.target.copy(mid);
    } else {
      // Look down onto the green from above the approach, clear of trees.
      const g = this.course.greenOf(this.hole);
      const c = g ? toLocal(this.v3(centroidOf(g.rings[0]))) : pinW;
      this.camera.position.copy(c).addScaledVector(dir, -24).add(new THREE.Vector3(0, 52, 0));
      this.controls.target.copy(c);
    }
    this.greenSlope.visible = name === 'green';
    this.controls.update();
    this.sizeLabels();
    this.render();
  }

  /** Buildings in 3D, place names, hole numbers, and every hole's line for the course view. */
  private buildLandmarks() {
    for (const o of [...this.landmarks.children]) if (o !== this.courseOnly) this.landmarks.remove(o);
    for (const o of [...this.courseOnly.children]) this.courseOnly.remove(o);
    const lm = this.course.data.landmarks;
    const labels: THREE.Sprite[] = [];
    if (lm) {
      for (const b of lm.buildings) {
        const shape = new THREE.Shape(b.ring.map((p) => new THREE.Vector2(p[0], p[1])));
        const h = b.clubhouse ? 7 : (b.levels ?? 1.5) * 3.2;
        const geo = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
        geo.rotateX(-Math.PI / 2);
        const base = Math.min(...b.ring.map((p) => this.y(p))) - 0.5;
        const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: b.clubhouse ? 0xd9cbb0 : 0xbdb7ad }));
        mesh.position.y = base;
        this.landmarks.add(mesh);
        if (b.name) labels.push(this.makeLabel(centroidOf(b.ring), b.name, '#fff6dd', 20, 'place', h + 6));
      }
      for (const lot of lm.parking) labels.push(this.makeLabel(centroidOf(lot), 'Parking', '#e8eef7', 18, 'place', 3));
      // One label per street, on its piece nearest the course.
      const byName = new Map<string, { line: XY[]; d: number }>();
      for (const r of lm.roads) {
        if (!r.name) continue;
        const mid = r.line[Math.floor(r.line.length / 2)];
        const d = Math.hypot(mid[0], mid[1]);
        const cur = byName.get(r.name);
        if (!cur || d < cur.d) byName.set(r.name, { line: r.line, d });
      }
      for (const [name, { line }] of byName) {
        const mid = line[Math.floor(line.length / 2)];
        const b = this.course.data.bounds;
        if (mid[0] < b.minX || mid[0] > b.maxX || mid[1] < b.minY || mid[1] > b.maxY) continue;
        const sp = this.makeLabel(mid, name.replace(/^(East|West|North|South) /, ''), '#f2f2ee', 15, 'place', 2);
        sp.userData.street = true;
        labels.push(sp);
      }
    }
    const range = this.course.features.filter((f) => f.kind === 'range').sort((a, b) => area(b) - area(a))[0];
    if (range) labels.push(this.makeLabel(centroidOf(range.rings[0]), 'Driving range', '#e9f7e1', 17, 'place', 3));
    for (const h of this.course.holes) {
      const tee = h.tees[0].center;
      const sp = this.makeLabel(tee, String(h.ref), '#1f7a45', 22, 'hole', 8);
      sp.userData.hole = h.ref;
      labels.push(sp);
      const pts = [tee, ...h.line.slice(1)].map((p) => this.v3(p, 1.5));
      this.courseOnly.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 })));
    }
    for (const l of labels) this.landmarks.add(l);
    this.showLabelsFor(this.currentView);
  }

  /** Course view shows every label; hole views show only what's around the current hole. */
  private showLabelsFor(view: ViewName) {
    const all = view === 'course';
    this.courseOnly.visible = all;
    const r = this.current?.region;
    for (const o of this.landmarks.children) {
      const p = o.userData.p as XY | undefined;
      if (!p) continue;
      if (all) { o.visible = true; continue; }
      if (o.userData.hole !== undefined) { o.visible = false; continue; } // hole numbers only on the course map
      const m = o.userData.street ? 0 : 60;
      o.visible = !!r && p[0] > r.minX - m && p[0] < r.maxX + m && p[1] > r.minY - m && p[1] < r.maxY + m;
    }
    this.sizeLabels();
  }

  /** Nearest hole to a map point (for tapping a hole in the course view). */
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

  // ---------- wind ----------
  setWind(w: Wind | null) {
    this.wind = w && w.windMph >= 1 ? w : null;
    this.buildWind();
  }

  private buildWind() {
    for (const a of this.windArrows) { this.windGroup.remove(a.mesh); a.mesh.geometry.dispose(); }
    this.windArrows = [];
    this.windGroup.visible = !!this.wind;
    if (!this.wind) { this.render(); return; }
    const { windFrom, windMph } = this.wind;
    const to = ((windFrom + 180) * Math.PI) / 180;
    const dir = new THREE.Vector3(Math.sin(to), 0, -Math.cos(to)); // map bearing → world (Z = south)
    const len = 7 + Math.min(25, windMph) * 0.7;
    const color = windMph < 8 ? 0x8fd3ff : windMph < 15 ? 0xffe066 : 0xff8a3d;
    // A 3D arrow (shaft + head) so it reads from any camera angle; points toward −Z.
    const shaft = new THREE.CylinderGeometry(0.55, 0.55, len - 4, 8);
    shaft.translate(0, -2, 0);
    const head = new THREE.ConeGeometry(1.9, 4.5, 10);
    head.translate(0, len / 2 - 1.75, 0);
    const geo = mergeGeometries([shaft, head])!;
    geo.rotateX(-Math.PI / 2);
    const course = this.currentView === 'course';
    const r = course || !this.current ? { minX: this.course.data.bounds.minX, minY: this.course.data.bounds.minY, maxX: this.course.data.bounds.maxX, maxY: this.course.data.bounds.maxY } : this.current.region;
    this.windSpacing = course ? 110 : 55;
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, depthWrite: false });
    const yaw = Math.atan2(-dir.x, -dir.z);
    for (let yy = r.minY; yy <= r.maxY; yy += this.windSpacing) for (let x = r.minX; x <= r.maxX; x += this.windSpacing) {
      const p: XY = [x + ((yy / this.windSpacing) % 2 ? this.windSpacing / 2 : 0), yy];
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.y = yaw;
      if (course) mesh.scale.setScalar(2.6);
      const base = this.v3(p, course ? 40 : 9);
      mesh.position.copy(base);
      mesh.renderOrder = 8;
      this.windGroup.add(mesh);
      this.windArrows.push({ mesh, base, dir });
    }
    this.render();
  }

  private windPhase = 0;
  private animateWind(dt: number) {
    if (!this.wind) return;
    // Drift at a pace that reads as stronger for stronger wind; loop every grid cell.
    this.windPhase = (this.windPhase + dt * (4 + this.wind.windMph * 0.9)) % this.windSpacing;
    const fade = Math.sin((this.windPhase / this.windSpacing) * Math.PI);
    for (const a of this.windArrows) {
      a.mesh.position.copy(a.base).addScaledVector(a.dir, this.windPhase - this.windSpacing / 2);
      (a.mesh.material as THREE.MeshBasicMaterial).opacity = 0.15 + 0.7 * fade;
    }
  }

  // ---------- compass ----------
  private lastCompass = NaN;
  private updateCompass() {
    const north = new THREE.Vector3(0, 0, -1).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.group.rotation.y);
    const fwd = this.controls.target.clone().sub(this.camera.position).setY(0);
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1).applyQuaternion(this.camera.quaternion).setY(0);
    fwd.normalize();
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const deg = Math.round((Math.atan2(north.dot(right), north.dot(fwd)) * 180) / Math.PI);
    if (deg !== this.lastCompass) { this.lastCompass = deg; this.onCompass(deg); }
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

/** Green slope color: under 1% flat, then gentle, firm and severe. */
export function slopeColor(pct: number) {
  return pct < 1 ? '#7fd1ff' : pct < 2 ? '#ffe066' : pct < 3 ? '#ff9f43' : '#ff5a4f';
}

/** Round map pin for the flag or the tee, drawn at a fixed size on screen. */
function iconSprite(kind: 'flag' | 'tee'): THREE.Sprite {
  const cv = document.createElement('canvas');
  cv.width = 64; cv.height = 64;
  const g = cv.getContext('2d')!;
  g.fillStyle = kind === 'flag' ? '#ffffff' : '#1f7a45';
  g.beginPath(); g.arc(32, 32, 26, 0, Math.PI * 2); g.fill();
  g.lineWidth = 4; g.strokeStyle = kind === 'flag' ? '#e53935' : '#ffffff'; g.stroke();
  if (kind === 'flag') {
    g.fillStyle = '#333'; g.fillRect(25, 15, 3.5, 34);
    g.fillStyle = '#e53935'; g.beginPath(); g.moveTo(28.5, 15); g.lineTo(46, 22); g.lineTo(28.5, 29); g.fill();
  } else {
    g.fillStyle = '#fff'; g.font = '800 26px -apple-system, system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('T', 32, 34);
  }
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, sizeAttenuation: false }));
  sp.userData = { w: 64, h: 64, hpx: 30 };
  sp.renderOrder = 11;
  return sp;
}

function centroidOf(ring: XY[]): XY {
  let x = 0, y = 0;
  for (const p of ring) { x += p[0]; y += p[1]; }
  return [x / ring.length, y / ring.length];
}

function area(f: Feature) {
  const r = f.rings[0];
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
  return Math.abs(a / 2);
}

function mulberry(a: number) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
