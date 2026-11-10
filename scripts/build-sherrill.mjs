// Build Sherrill Park 1 and 2 from the City of Richardson hole maps,
// plus USGS elevation and the same canopy source Cedar Crest uses.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fromUrl, fromArrayBuffer } from 'geotiff';

const CELL = 2;
const YD = 0.9144;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CARDS = {
  sherrill1: {
    name: 'Sherrill Park 1',
    // par, stroke, pro, champ, middle, forward
    rows: [
      [5, 10, 524, 504, 484, 441],
      [4, 2, 389, 345, 303, 274],
      [3, 18, 197, 177, 142, 95],
      [4, 14, 336, 311, 295, 261],
      [5, 6, 541, 504, 466, 440],
      [3, 16, 177, 156, 139, 109],
      [4, 8, 423, 386, 350, 326],
      [4, 4, 437, 407, 321, 298],
      [4, 12, 403, 361, 328, 295],
      [4, 5, 412, 362, 332, 247],
      [5, 3, 524, 488, 459, 408],
      [4, 11, 400, 375, 330, 275],
      [3, 17, 174, 148, 123, 101],
      [5, 9, 599, 564, 515, 412],
      [3, 15, 188, 167, 125, 105],
      [4, 13, 436, 401, 342, 316],
      [4, 1, 433, 411, 351, 326],
      [4, 7, 423, 395, 321, 281],
    ],
  },
  sherrill2: {
    name: 'Sherrill Park 2',
    rows: [
      [4, 8, 373, 347, 325, 247],
      [4, 4, 350, 331, 319, 265],
      [4, 6, 437, 417, 389, 344],
      [3, 17, 189, 170, 152, 120],
      [5, 2, 555, 543, 522, 462],
      [4, 13, 332, 313, 298, 277],
      [4, 9, 378, 363, 337, 262],
      [3, 18, 154, 135, 103, 83],
      [4, 7, 425, 401, 372, 331],
      [4, 11, 356, 338, 322, 282],
      [4, 3, 405, 390, 371, 310],
      [3, 14, 183, 163, 143, 122],
      [4, 10, 390, 325, 310, 270],
      [4, 12, 365, 348, 330, 290],
      [5, 1, 573, 530, 516, 492],
      [3, 15, 187, 157, 129, 112],
      [4, 16, 323, 301, 287, 253],
      [4, 5, 400, 362, 348, 288],
    ],
  },
};

const round = (v) => Math.round(v * 100) / 100;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function ringOf(g) {
  if (!g) return [];
  if (g.type === 'Polygon') return g.coordinates.map((r) => r.map(([lon, lat]) => [lon, lat]));
  if (g.type === 'MultiPolygon') return g.coordinates.flatMap((p) => p.map((r) => r.map(([lon, lat]) => [lon, lat])));
  return [];
}
function outerRing(g) {
  if (!g) return null;
  if (g.type === 'Polygon') return g.coordinates[0];
  if (g.type === 'MultiPolygon') return g.coordinates[0][0];
  return null;
}
function centroidLL(ring) {
  let x = 0, y = 0;
  const n = ring.length || 1;
  for (const p of ring) { x += p[0]; y += p[1]; }
  return [x / n, y / n];
}

async function getBuf(url, tries = 8) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'cedarcrest-tool/1.0 (personal golf planner)' } });
      if (!res.ok) throw new Error(`${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(2000 * (i + 1));
    }
  }
}

function makeProj(lats, lons) {
  const origin = { lat: (Math.min(...lats) + Math.max(...lats)) / 2, lon: (Math.min(...lons) + Math.max(...lons)) / 2 };
  const ky = 111132.92 - 559.82 * Math.cos(2 * origin.lat * Math.PI / 180) + 1.175 * Math.cos(4 * origin.lat * Math.PI / 180);
  const kx = 111412.84 * Math.cos(origin.lat * Math.PI / 180) - 93.5 * Math.cos(3 * origin.lat * Math.PI / 180);
  const toXY = (lon, lat) => [round((lon - origin.lon) * kx), round((lat - origin.lat) * ky)];
  return { origin, kx, ky, toXY };
}

function walkBack(line, yards) {
  let remain = yards * YD;
  for (let i = line.length - 2; i >= 0; i--) {
    const seg = dist(line[i + 1], line[i]);
    if (seg >= remain && seg > 0) {
      const t = remain / seg;
      return [round(line[i + 1][0] + (line[i][0] - line[i + 1][0]) * t), round(line[i + 1][1] + (line[i][1] - line[i + 1][1]) * t)];
    }
    remain -= seg;
  }
  return line[0];
}

function hull(points) {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (const q of p.reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k], k);
    }
  }
  await Promise.all(Array.from({ length: n }, worker));
  return out;
}

async function elevationTile(origin, kx, ky, x0, y0, w, h, cell) {
  const PAD = 4;
  const bx0 = x0 - PAD * cell, by0 = y0 - PAD * cell, bx1 = x0 + (w - 1 + PAD) * cell, by1 = y0 + (h - 1 + PAD) * cell;
  const url = 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage?' + new URLSearchParams({
    bbox: [origin.lon + bx0 / kx, origin.lat + by0 / ky, origin.lon + bx1 / kx, origin.lat + by1 / ky].join(','),
    bboxSR: '4326', imageSR: '4326', size: `${w + 2 * PAD},${h + 2 * PAD}`, format: 'tiff', pixelType: 'F32',
    noDataInterpretation: 'esriNoDataMatchAny', interpolation: 'RSP_BilinearInterpolation', f: 'image',
  });
  const buf = await getBuf(url);
  const img = await (await fromArrayBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))).getImage();
  const [ras] = await img.readRasters();
  const [ix0, , , iy1] = img.getBoundingBox();
  const [rx, ry] = img.getResolution();
  const iw = img.getWidth(), ih = img.getHeight();
  const out = new Float32Array(w * h);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    const lon = origin.lon + (x0 + c * cell) / kx, lat = origin.lat + (y0 + r * cell) / ky;
    const fx = (lon - ix0) / rx - 0.5, fy = (lat - iy1) / ry - 0.5;
    const cx = Math.max(0, Math.min(iw - 2, Math.floor(fx))), cy = Math.max(0, Math.min(ih - 2, Math.floor(fy)));
    const ax = Math.min(1, Math.max(0, fx - cx)), ay = Math.min(1, Math.max(0, fy - cy));
    const v = (i, j) => ras[j * iw + i];
    out[r * w + c] = (v(cx, cy) * (1 - ax) + v(cx + 1, cy) * ax) * (1 - ay) + (v(cx, cy + 1) * (1 - ax) + v(cx + 1, cy + 1) * ax) * ay;
  }
  return out;
}

async function fetchCanopy(origin, kx, ky, cols, rows, bounds) {
  const R = 6378137;
  const merc = (lat, lon) => [(R * lon * Math.PI) / 180, R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))];
  const z = 9, n = 2 ** z;
  const tx = Math.floor(((origin.lon + 180) / 360) * n);
  const ty = Math.floor(((1 - Math.log(Math.tan((origin.lat * Math.PI) / 180) + 1 / Math.cos((origin.lat * Math.PI) / 180)) / Math.PI) / 2) * n);
  let key = '';
  for (let i = z; i > 0; i--) key += String(((tx >> (i - 1)) & 1) + (((ty >> (i - 1)) & 1) << 1));
  const tif = await fromUrl(`https://dataforgood-fb-data.s3.amazonaws.com/forests/v1/alsgedi_global_v6_float/chm/${key}.tif`);
  const img = await tif.getImage();
  const [x0, , , y1] = img.getBoundingBox();
  const res = img.getResolution()[0];
  const ll = (x, y) => [origin.lat + y / ky, origin.lon + x / kx];
  const [ax, ay] = merc(...ll(bounds.minX, bounds.minY));
  const [bx, by] = merc(...ll(bounds.maxX, bounds.maxY));
  const win = [Math.floor((ax - x0) / res) - 2, Math.floor((y1 - by) / res) - 2, Math.ceil((bx - x0) / res) + 2, Math.ceil((y1 - ay) / res) + 2];
  const [data] = await img.readRasters({ window: win });
  const w = win[2] - win[0];
  const out = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const [mx, my] = merc(...ll(bounds.minX + c * CELL, bounds.minY + r * CELL));
    const px = Math.round((mx - x0) / res) - win[0], py = Math.round((y1 - my) / res) - win[1];
    const v = data[py * w + px];
    out[r * cols + c] = Number.isFinite(v) ? Math.max(0, Math.min(255, Math.round(v))) : 0;
  }
  return out;
}

async function loadWater(bbox) {
  const q = new URLSearchParams({
    where: '1=1', outFields: 'NAME', returnGeometry: 'true', outSR: '4326', f: 'geojson',
    geometry: bbox.join(','), geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects',
  });
  const url = `https://services2.arcgis.com/5aVZxf6eblRfH5Yb/ArcGIS/rest/services/SherrillParkGolfCourse_Course1/FeatureServer/8/query?${q}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const json = await res.json();
  return json.features ?? [];
}

async function build(id) {
  const card = CARDS[id];
  const short = id === 'sherrill1' ? 'c1' : 'c2';
  const holesGJ = JSON.parse(await readFile(`/tmp/${short}-holes.geojson`, 'utf8')).features;
  const teesGJ = JSON.parse(await readFile(`/tmp/${short}-tees.geojson`, 'utf8')).features;
  const elsGJ = JSON.parse(await readFile(`/tmp/${short}-els.geojson`, 'utf8')).features;
  const lats = [], lons = [];
  for (const f of [...holesGJ, ...teesGJ, ...elsGJ]) {
    const g = f.geometry;
    const pts = g.type === 'LineString' ? g.coordinates : (outerRing(g) ?? []);
    for (const [lon, lat] of pts) { lons.push(lon); lats.push(lat); }
  }
  const { origin, kx, ky, toXY } = makeProj(lats, lons);
  const xyRing = (ll) => ll.map(([lon, lat]) => toXY(lon, lat));

  const features = [];
  let fid = 0;
  const greensByHole = new Map();
  for (const f of elsGJ) {
    const hole = f.properties.Hole;
    const kind = f.properties.ElementType === 'Green' ? 'green' : f.properties.ElementType === 'Fairway' ? 'fairway' : f.properties.ElementType === 'Sand Pit' ? 'bunker' : null;
    if (!kind) continue;
    const rings = ringOf(f.geometry);
    if (!rings.length) continue;
    const outer = xyRing(rings[0]);
    const holes = rings.slice(1).map(xyRing);
    const feat = { id: `e${fid++}`, kind, rings: [outer], holes, ...(hole ? { ref: String(hole) } : {}) };
    features.push(feat);
    if (kind === 'green' && hole) {
      const list = greensByHole.get(Number(hole)) ?? [];
      list.push(feat);
      greensByHole.set(Number(hole), list);
    }
  }
  const teesByHole = new Map();
  for (const f of teesGJ) {
    const hole = Number(f.properties.Hole);
    const ring = outerRing(f.geometry);
    if (!ring || !hole) continue;
    const outer = xyRing(ring);
    const c = centroidLL(outer);
    const center = [round(c[0]), round(c[1])];
    const feat = { id: `t${fid++}`, kind: 'tee', rings: [outer], holes: [], ref: String(hole) };
    features.push(feat);
    const list = teesByHole.get(hole) ?? [];
    list.push(center);
    teesByHole.set(hole, list);
  }

  const holes = [];
  for (const f of holesGJ.sort((a, b) => a.properties.Hole - b.properties.Hole)) {
    const ref = f.properties.Hole;
    const row = card.rows[ref - 1];
    const line = f.geometry.coordinates.map(([lon, lat]) => toXY(lon, lat));
    const pin = line[line.length - 1];
    const greens = greensByHole.get(ref) ?? [];
    const green = greens.slice().sort((a, b) => dist(centroidLL(a.rings[0]), pin) - dist(centroidLL(b.rings[0]), pin))[0];
    const centers = (teesByHole.get(ref) ?? []).slice().sort((a, b) => dist(b, pin) - dist(a, pin));
    const clusters = [];
    for (const c of centers) {
      const hit = clusters.find((k) => dist(k, c) < 8);
      if (!hit) clusters.push(c);
    }
    clusters.sort((a, b) => dist(b, pin) - dist(a, pin));
    const cardYds = row.slice(2);
    while (clusters.length > 4) {
      let bi = 1, bg = Infinity;
      for (let i = 1; i < clusters.length - 1; i++) {
        const g = Math.min(dist(clusters[i], pin) - dist(clusters[i + 1], pin), dist(clusters[i - 1], pin) - dist(clusters[i], pin));
        if (g < bg) { bg = g; bi = i; }
      }
      clusters.splice(bi, 1);
    }
    const tees = cardYds.map((yds, i) => {
      const have = clusters[i];
      const center = have ?? walkBack(line, yds);
      const lengthYds = Math.round(dist(center, pin) / YD);
      return { id: have ? `box-${ref}-${i}` : `card-${ref}-${i}`, center, lengthYds };
    });
    const lineLen = line.reduce((s, p, i) => (i ? s + dist(p, line[i - 1]) : 0), 0);
    holes.push({
      ref,
      par: row[0],
      handicap: row[1],
      line,
      lengthYds: Math.round(lineLen / YD),
      tees,
      greenId: green?.id ?? null,
      pin: green ? centroidLL(green.rings[0]).map(round) : pin,
    });
    // Pin should sit on the green, not the centroid if the line end is the mapped cup.
    if (green) holes[holes.length - 1].pin = pin;
  }

  const waterPts = [];
  for (const h of holes) waterPts.push(...h.line);
  const minLon = Math.min(...lons) - 0.002, maxLon = Math.max(...lons) + 0.002;
  const minLat = Math.min(...lats) - 0.002, maxLat = Math.max(...lats) + 0.002;
  const waters = await loadWater([minLon, minLat, maxLon, maxLat]);
  for (const f of waters) {
    const rings = ringOf(f.geometry);
    if (!rings[0] || rings[0].length < 4) continue;
    const outer = xyRing(rings[0]);
    const c = centroidLL(outer);
    if (!holes.some((h) => h.line.some((p) => dist(p, c) < 80) || dist(h.pin, c) < 80)) continue;
    features.push({ id: `w${fid++}`, kind: 'water', rings: [outer], holes: rings.slice(1).map(xyRing) });
  }

  const all = [];
  for (const h of holes) all.push(...h.line, ...h.tees.map((t) => t.center));
  for (const f of features) all.push(...f.rings[0]);
  const hring = hull(all);
  const hc = centroidLL(hring);
  const boundary = [hring.map((p) => {
    const d = dist(p, hc) || 1;
    return [round(p[0] + ((p[0] - hc[0]) / d) * 28), round(p[1] + ((p[1] - hc[1]) / d) * 28)];
  })];
  const pad = 40;
  const xs = boundary[0].map((p) => p[0]), ys = boundary[0].map((p) => p[1]);
  const bounds = {
    minX: Math.floor(Math.min(...xs) - pad),
    minY: Math.floor(Math.min(...ys) - pad),
    maxX: Math.ceil(Math.max(...xs) + pad),
    maxY: Math.ceil(Math.max(...ys) + pad),
  };
  const cols = Math.round((bounds.maxX - bounds.minX) / CELL) + 1;
  const rows = Math.round((bounds.maxY - bounds.minY) / CELL) + 1;
  console.log(id, `grid ${cols}x${rows}`, `holes ${holes.length}`, `features ${features.length}`);

  const TILE = 48;
  const tiles = [];
  for (let ty = 0; ty < Math.ceil(rows / TILE); ty++) {
    for (let tx = 0; tx < Math.ceil(cols / TILE); tx++) {
      const c0 = tx * TILE, r0 = ty * TILE;
      tiles.push({ c0, r0, w: Math.min(cols, c0 + TILE) - c0, h: Math.min(rows, r0 + TILE) - r0 });
    }
  }
  console.log(id, `elevation tiles ${tiles.length}`);
  const canopyP = fetchCanopy(origin, kx, ky, cols, rows, bounds);
  const data = new Float32Array(cols * rows);
  let done = 0;
  await pool(tiles, 2, async (t) => {
    const tile = await elevationTile(origin, kx, ky, bounds.minX + t.c0 * CELL, bounds.minY + t.r0 * CELL, t.w, t.h, CELL);
    for (let r = 0; r < t.h; r++) for (let c = 0; c < t.w; c++) data[(t.r0 + r) * cols + t.c0 + c] = tile[r * t.w + c];
    done++;
    if (done % 20 === 0) console.log(id, `tiles ${done}/${tiles.length}`);
  });
  let minH = Infinity, maxH = -Infinity;
  for (const v of data) if (v > -1000 && v < 9000) { minH = Math.min(minH, v); maxH = Math.max(maxH, v); }
  const grid = new Uint16Array(cols * rows);
  for (let i = 0; i < data.length; i++) grid[i] = Math.round(((data[i] > -1000 && data[i] < 9000 ? data[i] : minH) - minH) * 100);

  const greenPatches = [];
  const greenParts = [];
  let gOffset = 0;
  for (const h of holes) {
    const g = features.find((f) => f.id === h.greenId);
    if (!g) continue;
    const gxs = g.rings[0].map((p) => p[0]), gys = g.rings[0].map((p) => p[1]);
    const M = 10;
    const x0 = Math.floor(Math.min(...gxs) - M), y0 = Math.floor(Math.min(...gys) - M);
    const w = Math.ceil(Math.max(...gxs) + M) - x0 + 1, hgt = Math.ceil(Math.max(...gys) + M) - y0 + 1;
    const patch = await elevationTile(origin, kx, ky, x0, y0, w, hgt, 1);
    const u16 = new Uint16Array(w * hgt);
    for (let i = 0; i < patch.length; i++) u16[i] = Math.max(0, Math.round((patch[i] - minH) * 100));
    greenParts.push(u16);
    greenPatches.push({ ref: h.ref, minX: x0, minY: y0, cols: w, rows: hgt, cell: 1, offset: gOffset });
    gOffset += u16.length;
  }
  const greensBin = new Uint16Array(gOffset);
  { let o = 0; for (const part of greenParts) { greensBin.set(part, o); o += part.length; } }
  const canopy = await canopyP;
  const outDir = `/workspace/public/data/${id}`;
  await mkdir(outDir, { recursive: true });
  await writeFile(`${outDir}/terrain.bin`, Buffer.from(grid.buffer));
  await writeFile(`${outDir}/canopy.bin`, Buffer.from(canopy.buffer));
  await writeFile(`${outDir}/greens.bin`, Buffer.from(greensBin.buffer));
  const course = {
    id,
    name: card.name,
    fetched: new Date().toISOString().slice(0, 10),
    source: 'City of Richardson golf maps; USGS 3DEP elevation',
    origin, metersPerDeg: { x: kx, y: ky },
    bounds,
    terrain: { file: 'terrain.bin', cols, rows, cell: CELL, minX: bounds.minX, minY: bounds.minY, minH, maxH, scale: 0.01 },
    greens: { file: 'greens.bin', scale: 0.01, patches: greenPatches },
    canopy: { file: 'canopy.bin', source: 'Meta & World Resources Institute, High Resolution Canopy Height Maps (CC BY 4.0)' },
    boundary,
    holes, features, paths: [], trees: [],
    landmarks: { buildings: [], parking: [], roads: [] },
  };
  await writeFile(`${outDir}/course.json`, JSON.stringify(course));
  console.log('wrote', outDir, 'elev', minH.toFixed(1), maxH.toFixed(1));
}

const which = process.argv[2] ?? 'both';
const ids = which === 'both' ? ['sherrill1', 'sherrill2'] : [which];
for (const id of ids) await build(id);
