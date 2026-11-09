// Downloads Cedar Crest's layout from OpenStreetMap and its elevation from
// USGS 3DEP, then writes public/data/course.json and public/data/terrain.bin.
// Run with: npm run fetch-course
import { writeFile, mkdir, readFile } from 'node:fs/promises';

const COURSE_NAME = 'Cedar Crest Golf Course';
// Search area (lon/lat) that contains the whole course.
const SEARCH = { minLon: -96.805, minLat: 32.703, maxLon: -96.772, maxLat: 32.742 };
const TILE = 0.012; // degrees per OSM API request
const CELL = 2; // terrain grid spacing in meters
const OUT = new URL('../public/data/', import.meta.url);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, as = 'text', tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'cedarcrest-tool/1.0 (personal golf planner)' } });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return as === 'text' ? await res.text() : Buffer.from(await res.arrayBuffer());
    } catch (e) {
      if (i === tries - 1) throw e;
      console.warn(`  retry ${url.slice(0, 80)}… (${e.message})`);
      await sleep(2000 * 2 ** i);
    }
  }
}

// ---------- OSM XML parsing ----------
const nodes = new Map(); // id -> {lat, lon, tags}
const ways = new Map(); // id -> {nds, tags}
const rels = new Map(); // id -> {members, tags}

function tagsOf(body) {
  const t = {};
  for (const m of body.matchAll(/<tag k="([^"]+)" v="([^"]*)"/g)) t[m[1]] = m[2].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
  return t;
}

function parseOsm(xml) {
  for (const m of xml.matchAll(/<node id="(\d+)"[^>]*?lat="([-\d.]+)" lon="([-\d.]+)"[^>]*?(\/>|>([\s\S]*?)<\/node>)/g)) {
    nodes.set(m[1], { lat: +m[2], lon: +m[3], tags: m[5] ? tagsOf(m[5]) : {} });
  }
  for (const m of xml.matchAll(/<way id="(\d+)"[^>]*>([\s\S]*?)<\/way>/g)) {
    ways.set(m[1], { nds: [...m[2].matchAll(/<nd ref="(\d+)"/g)].map((x) => x[1]), tags: tagsOf(m[2]) });
  }
  for (const m of xml.matchAll(/<relation id="(\d+)"[^>]*>([\s\S]*?)<\/relation>/g)) {
    const members = [...m[2].matchAll(/<member type="(\w+)" ref="(\d+)" role="([^"]*)"/g)].map((x) => ({ type: x[1], ref: x[2], role: x[3] }));
    rels.set(m[1], { members, tags: tagsOf(m[2]) });
  }
}

// ---------- geometry helpers ----------
let origin; // {lat, lon}
let kx, ky; // meters per degree
function toXY(lat, lon) {
  return [round((lon - origin.lon) * kx), round((lat - origin.lat) * ky)];
}
const round = (v) => Math.round(v * 100) / 100;

function wayCoords(way) {
  const pts = [];
  for (const id of way.nds) {
    const n = nodes.get(id);
    if (n) pts.push(n);
  }
  return pts;
}

// Join way fragments into closed rings (for multipolygon relations).
function assembleRings(wayList) {
  const segs = wayList.map((w) => w.nds.slice()).filter((s) => s.length > 1);
  const rings = [];
  while (segs.length) {
    let ring = segs.shift();
    let guard = 0;
    while (ring[0] !== ring[ring.length - 1] && guard++ < 1000) {
      const end = ring[ring.length - 1];
      const i = segs.findIndex((s) => s[0] === end || s[s.length - 1] === end);
      if (i < 0) break;
      const s = segs.splice(i, 1)[0];
      ring = ring.concat(s[0] === end ? s.slice(1) : s.reverse().slice(1));
    }
    if (ring.length > 3) rings.push(ring);
  }
  return rings;
}

function ringXY(ids) {
  return ids.map((id) => nodes.get(id)).filter(Boolean).map((n) => toXY(n.lat, n.lon));
}

function areaRings(elem, type) {
  if (type === 'way') return elem.nds[0] === elem.nds[elem.nds.length - 1] ? [ringXY(elem.nds)] : [];
  const outers = elem.members.filter((m) => m.type === 'way' && m.role !== 'inner').map((m) => ways.get(m.ref)).filter(Boolean);
  const inners = elem.members.filter((m) => m.type === 'way' && m.role === 'inner').map((m) => ways.get(m.ref)).filter(Boolean);
  return { outer: assembleRings(outers).map(ringXY), inner: assembleRings(inners).map(ringXY) };
}

function centroid(ring) {
  let x = 0, y = 0;
  for (const p of ring) { x += p[0]; y += p[1]; }
  return [x / ring.length, y / ring.length];
}

function inside(pt, ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function polyArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return Math.abs(a / 2);
}

function convexHull(points) {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (const q of p.reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

// ---------- TIFF (uncompressed float32) ----------
function readTiffF32(buf) {
  const le = buf.toString('ascii', 0, 2) === 'II';
  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const ifd = u32(4);
  const n = u16(ifd);
  const tags = {};
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
    const size = type === 3 ? 2 : 4;
    const vals = [];
    const base = count * size > 4 ? u32(e + 8) : e + 8;
    for (let k = 0; k < count; k++) vals.push(size === 2 ? u16(base + k * 2) : u32(base + k * 4));
    tags[tag] = vals;
  }
  const width = tags[256][0], height = tags[257][0];
  if ((tags[259]?.[0] ?? 1) !== 1) throw new Error('compressed TIFF not supported');
  const offsets = tags[273] ?? tags[324], counts = tags[279] ?? tags[325];
  const tiled = !!tags[324];
  const out = new Float32Array(width * height);
  const rd = (o) => (le ? buf.readFloatLE(o) : buf.readFloatBE(o));
  if (!tiled) {
    let idx = 0;
    for (let s = 0; s < offsets.length; s++) for (let b = 0; b < counts[s]; b += 4) if (idx < out.length) out[idx++] = rd(offsets[s] + b);
  } else {
    const tw = tags[322][0], th = tags[323][0];
    const across = Math.ceil(width / tw);
    offsets.forEach((off, t) => {
      const tx = (t % across) * tw, ty = Math.floor(t / across) * th;
      for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
        if (tx + x < width && ty + y < height) out[(ty + y) * width + tx + x] = rd(off + (y * tw + x) * 4);
      }
    });
  }
  return { width, height, data: out };
}

// ---------- tree canopy ----------
// Heights in whole meters on the same 2 m grid as the terrain (row 0 = south).
async function fetchCanopy(cols, rows, bounds) {
  const { fromUrl } = await import('geotiff');
  const R = 6378137;
  const merc = (lat, lon) => [(R * lon * Math.PI) / 180, R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))];
  // Tiles are named by zoom-9 quadkey.
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
    out[r * cols + c] = data[py * w + px] ?? 0;
  }
  return out;
}

// ---------- main ----------
async function main() {
  console.log('Downloading OpenStreetMap tiles…');
  for (let lon = SEARCH.minLon; lon < SEARCH.maxLon; lon += TILE) {
    for (let lat = SEARCH.minLat; lat < SEARCH.maxLat; lat += TILE) {
      const b = [lon, lat, Math.min(lon + TILE, SEARCH.maxLon), Math.min(lat + TILE, SEARCH.maxLat)].map((v) => v.toFixed(5)).join(',');
      console.log('  bbox', b);
      parseOsm(await get(`https://api.openstreetmap.org/api/0.6/map?bbox=${b}`));
    }
  }

  // Course boundary
  let boundaryElem = null, boundaryType = null;
  for (const [id, w] of ways) if (w.tags.leisure === 'golf_course' && w.tags.name === COURSE_NAME) { boundaryElem = w; boundaryType = 'way'; }
  for (const [id, r] of rels) if (r.tags.leisure === 'golf_course' && r.tags.name === COURSE_NAME) { boundaryElem = r; boundaryType = 'relation'; }
  if (!boundaryElem) throw new Error('Course boundary not found');

  // Origin = center of boundary nodes
  const bNodes = boundaryType === 'way' ? wayCoords(boundaryElem) : boundaryElem.members.filter((m) => m.type === 'way').flatMap((m) => (ways.get(m.ref) ? wayCoords(ways.get(m.ref)) : []));
  const lats = bNodes.map((n) => n.lat), lons = bNodes.map((n) => n.lon);
  origin = { lat: (Math.min(...lats) + Math.max(...lats)) / 2, lon: (Math.min(...lons) + Math.max(...lons)) / 2 };
  ky = 111132.92 - 559.82 * Math.cos(2 * origin.lat * Math.PI / 180) + 1.175 * Math.cos(4 * origin.lat * Math.PI / 180);
  kx = 111412.84 * Math.cos(origin.lat * Math.PI / 180) - 93.5 * Math.cos(3 * origin.lat * Math.PI / 180);

  const boundaryRings = boundaryType === 'way' ? areaRings(boundaryElem, 'way') : areaRings(boundaryElem, 'relation').outer;
  const inCourse = (pt) => boundaryRings.some((r) => inside(pt, r));

  // Features
  const KIND = { fairway: 'fairway', green: 'green', bunker: 'bunker', tee: 'tee', rough: 'rough', water_hazard: 'water', lateral_water_hazard: 'water', driving_range: 'range', clubhouse: 'building' };
  const features = [];
  const addArea = (elem, type, kind, tags, id) => {
    let outer, inner = [];
    if (type === 'way') outer = areaRings(elem, 'way');
    else ({ outer, inner } = areaRings(elem, 'relation'));
    outer = outer.filter((r) => r.length > 3);
    if (!outer.length) return;
    features.push({ id, kind, rings: outer, holes: inner, ...(tags.ref ? { ref: tags.ref } : {}) });
  };
  for (const [type, map] of [['way', ways], ['relation', rels]]) {
    for (const [id, e] of map) {
      const t = e.tags;
      if (type === 'relation' && t.type !== 'multipolygon') continue;
      let kind = t.golf ? KIND[t.golf] : null;
      if (!kind && (t.natural === 'water' || t.water)) kind = 'water';
      if (!kind && (t.natural === 'wood' || t.landuse === 'forest')) kind = 'wood';
      if (!kind && t.natural === 'scrub') kind = 'wood';
      if (!kind && t.natural === 'sand') kind = 'bunker';
      if (!kind && t.building) kind = 'building';
      if (!kind) continue;
      const rings = type === 'way' ? areaRings(e, 'way') : areaRings(e, 'relation').outer;
      if (!rings.length || !rings[0].length) continue;
      if (!t.golf && !inCourse(centroid(rings[0]))) continue;
      if (t.golf && !inCourse(centroid(rings[0]))) continue;
      addArea(e, type, kind, t, `${type[0]}${id}`);
    }
  }
  // Cart paths (lines)
  const paths = [];
  for (const [id, w] of ways) {
    if (w.tags.golf === 'cartpath' || (w.tags.highway && w.tags.golf_cart === 'designated')) {
      const line = ringXY(w.nds);
      if (line.length > 1 && inCourse(centroid(line))) paths.push(line);
    }
  }
  // Trees
  const trees = [];
  for (const [id, n] of nodes) if (n.tags.natural === 'tree') { const p = toXY(n.lat, n.lon); if (inCourse(p)) trees.push(p); }

  // Holes
  const holeWays = [...ways.values()].filter((w) => w.tags.golf === 'hole' && w.tags.ref && inCourse(centroid(ringXY(w.nds))));
  const pins = [...nodes.values()].filter((n) => n.tags.golf === 'pin').map((n) => ({ p: toXY(n.lat, n.lon), ref: n.tags.ref }));
  const greens = features.filter((f) => f.kind === 'green');
  const tees = features.filter((f) => f.kind === 'tee');
  const holes = [];
  const seen = new Set();
  for (const w of holeWays.sort((a, b) => +a.tags.ref - +b.tags.ref)) {
    const ref = +w.tags.ref;
    if (seen.has(ref)) continue;
    seen.add(ref);
    const line = ringXY(w.nds);
    const start = line[0], end = line[line.length - 1];
    const green = greens.find((g) => g.rings.some((r) => inside(end, r))) ?? greens.slice().sort((a, b) => dist(centroid(a.rings[0]), end) - dist(centroid(b.rings[0]), end))[0];
    const pin = pins.slice().sort((a, b) => dist(a.p, end) - dist(b.p, end))[0];
    const pinPt = pin && dist(pin.p, end) < 40 ? pin.p : end;
    // A tee belongs to this hole if it sits on the line of the first segment
    // (behind or just in front of the start) and no other hole starts closer.
    const second = line[1];
    const seg = [second[0] - start[0], second[1] - start[1]];
    const segLen = Math.hypot(...seg);
    const u = [seg[0] / segLen, seg[1] / segLen];
    const holeTees = [];
    for (const t of tees) {
      const c = centroid(t.rings[0]);
      const d = [c[0] - start[0], c[1] - start[1]];
      const along = d[0] * u[0] + d[1] * u[1];
      const lateral = Math.abs(d[0] * u[1] - d[1] * u[0]);
      if (along < -160 || along > Math.min(90, segLen * 0.5) || lateral > 30 + Math.max(0, -along) * 0.15) continue;
      const mine = dist(c, start);
      const closerElsewhere = holeWays.some((o) => o !== w && o.tags.ref !== w.tags.ref && dist(c, ringXY(o.nds)[0]) < mine - 5);
      if (closerElsewhere) continue;
      holeTees.push({ id: t.id, center: c.map(round), lengthYds: 0 });
    }
    if (!holeTees.some((t) => dist(t.center, start) < 12)) holeTees.push({ id: `line-${ref}`, center: start, lengthYds: 0 });
    // length along hole line with this tee replacing the start point
    const lineLen = (pts) => pts.reduce((s, p, i) => (i ? s + dist(p, pts[i - 1]) : 0), 0);
    for (const t of holeTees) t.lengthYds = Math.round(lineLen([t.center, ...line.slice(1)]) / 0.9144);
    holeTees.sort((a, b) => b.lengthYds - a.lengthYds);
    // Merge tee boxes within 4 yards of each other (split boxes on one deck).
    for (let i = holeTees.length - 1; i > 0; i--) if (holeTees[i - 1].lengthYds - holeTees[i].lengthYds < 4) holeTees.splice(i, 1);
    holes.push({
      ref,
      par: +w.tags.par || null,
      handicap: +w.tags.handicap || null,
      line,
      lengthYds: Math.round(lineLen(line) / 0.9144),
      tees: holeTees,
      greenId: green?.id ?? null,
      pin: pinPt,
    });
  }
  console.log(`Found ${holes.length} holes, ${features.length} areas, ${trees.length} trees, ${paths.length} paths`);

  // Bounds (with margin)
  const allPts = boundaryRings.flat();
  const M = 60;
  const bounds = {
    minX: Math.floor(Math.min(...allPts.map((p) => p[0])) - M),
    minY: Math.floor(Math.min(...allPts.map((p) => p[1])) - M),
    maxX: Math.ceil(Math.max(...allPts.map((p) => p[0])) + M),
    maxY: Math.ceil(Math.max(...allPts.map((p) => p[1])) + M),
  };

  // Landmarks for finding your way: buildings (the clubhouse), parking and named streets
  const inBounds = (pt, m = 0) => pt[0] > bounds.minX - m && pt[0] < bounds.maxX + m && pt[1] > bounds.minY - m && pt[1] < bounds.maxY + m;
  const buildings = [];
  for (const [id, w] of ways) {
    const b = w.tags.building;
    if (!b || ['house', 'garage', 'shed', 'roof'].includes(b) || w.nds[0] !== w.nds[w.nds.length - 1]) continue;
    const ring = ringXY(w.nds);
    if (ring.length < 4 || !inBounds(centroid(ring))) continue;
    buildings.push({ ring, name: w.tags.name || null, levels: +w.tags['building:levels'] || null, area: Math.round(polyArea(ring)) });
  }
  const firstTee = holes[0].tees[0].center, lastGreen = holes[holes.length - 1].pin;
  const club = buildings
    .filter((b) => Math.min(dist(centroid(b.ring), firstTee), dist(centroid(b.ring), lastGreen)) < 150)
    .sort((a, b) => b.area - a.area)[0];
  if (club && !club.name) { club.name = 'Clubhouse'; club.clubhouse = true; }
  const parking = [];
  for (const [type, map] of [['way', ways], ['relation', rels]]) {
    for (const [, e] of map) {
      if (e.tags.amenity !== 'parking') continue;
      const rings = type === 'way' ? areaRings(e, 'way') : areaRings(e, 'relation').outer;
      if (rings[0]?.length > 3 && inBounds(centroid(rings[0]))) parking.push(rings[0]);
    }
  }
  // Lots that are only mapped by their driving lanes: outline the lanes.
  const aisles = [...ways.values()].filter((w) => w.tags.service === 'parking_aisle').map((w) => ringXY(w.nds)).filter((l) => l.length > 1 && inBounds(centroid(l)));
  const groups = [];
  for (const a of aisles) {
    const g = groups.find((grp) => grp.some((b) => dist(centroid(b), centroid(a)) < 40));
    if (g) g.push(a); else groups.push([a]);
  }
  for (const g of groups) {
    const hull = convexHull(g.flat());
    const c = centroid(hull);
    parking.push(hull.map((p) => { const d = dist(p, c) || 1; return [round(p[0] + ((p[0] - c[0]) / d) * 8), round(p[1] + ((p[1] - c[1]) / d) * 8)]; }));
  }
  const ROADS = new Set(['primary', 'secondary', 'tertiary', 'residential', 'unclassified', 'secondary_link', 'tertiary_link', 'living_street']);
  const roads = [];
  for (const [, w] of ways) {
    if (!ROADS.has(w.tags.highway)) continue;
    const line = ringXY(w.nds);
    if (line.length > 1 && line.some((p) => inBounds(p, 30))) roads.push({ name: w.tags.name || '', kind: w.tags.highway, line });
  }
  console.log(`Landmarks: ${buildings.length} buildings${club ? ' (clubhouse found)' : ''}, ${parking.length} parking lots, ${roads.length} streets`);

  // Terrain from USGS 3DEP
  const cols = Math.round((bounds.maxX - bounds.minX) / CELL) + 1;
  const rows = Math.round((bounds.maxY - bounds.minY) / CELL) + 1;
  // Download in small tiles: for large areas the elevation service quietly returns a
  // smoothed, lower-detail surface (it was ~0.75 m off near greens); small tiles come
  // back at full 3DEP lidar detail (~0.15 m from USGS point values).
  const TILE_PX = 48;
  const data = new Float32Array(cols * rows).fill(NaN); // row 0 = south
  const { fromArrayBuffer } = await import('geotiff');
  const tilesX = Math.ceil(cols / TILE_PX), tilesY = Math.ceil(rows / TILE_PX);
  console.log(`Downloading elevation grid ${cols}×${rows} at ${CELL} m in ${tilesX * tilesY} tiles…`);
  for (let ty = 0; ty < tilesY; ty++) for (let tx = 0; tx < tilesX; tx++) {
    const c0 = tx * TILE_PX, r0 = ty * TILE_PX;
    const c1 = Math.min(cols - 1, c0 + TILE_PX - 1), r1 = Math.min(rows - 1, r0 + TILE_PX - 1);
    const w = c1 - c0 + 1, h = r1 - r0 + 1;
    // Ask for a little more than the tile (the service may nudge the edges), then sample
    // each grid point from where the returned image says its pixels really are.
    const PAD = 4;
    const x0 = bounds.minX + (c0 - PAD) * CELL, x1 = bounds.minX + (c1 + PAD) * CELL, y0 = bounds.minY + (r0 - PAD) * CELL, y1 = bounds.minY + (r1 + PAD) * CELL;
    const pw = w + 2 * PAD, ph = h + 2 * PAD;
    const url = 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage?' + new URLSearchParams({
      bbox: [origin.lon + x0 / kx, origin.lat + y0 / ky, origin.lon + x1 / kx, origin.lat + y1 / ky].join(','), bboxSR: '4326', imageSR: '4326',
      size: `${pw},${ph}`, format: 'tiff', pixelType: 'F32', noDataInterpretation: 'esriNoDataMatchAny',
      interpolation: 'RSP_BilinearInterpolation', f: 'image',
    });
    let sample = null;
    for (let attempt = 0; attempt < 5 && !sample; attempt++) {
      try {
        const buf = await get(url, 'buf');
        const img = await (await fromArrayBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))).getImage();
        const [ras] = await img.readRasters();
        const [bx0, , , by1] = img.getBoundingBox();
        const [rx, ry] = img.getResolution();
        const iw = img.getWidth(), ih = img.getHeight();
        sample = (lon, lat) => {
          const fx = (lon - bx0) / rx - 0.5, fy = (lat - by1) / ry - 0.5; // pixel centers
          const cx = Math.max(0, Math.min(iw - 2, Math.floor(fx))), cy = Math.max(0, Math.min(ih - 2, Math.floor(fy)));
          const ax = Math.min(1, Math.max(0, fx - cx)), ay = Math.min(1, Math.max(0, fy - cy));
          const v = (i, j) => ras[j * iw + i];
          return (v(cx, cy) * (1 - ax) + v(cx + 1, cy) * ax) * (1 - ay) + (v(cx, cy + 1) * (1 - ax) + v(cx + 1, cy + 1) * ax) * ay;
        };
      } catch (e) { console.warn(`  tile ${tx},${ty} retry (${e.message})`); await sleep(2000 * (attempt + 1)); }
    }
    if (!sample) throw new Error(`elevation tile ${tx},${ty} failed`);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      const x = bounds.minX + c * CELL, y = bounds.minY + r * CELL;
      data[r * cols + c] = sample(origin.lon + x / kx, origin.lat + y / ky);
    }
  }
  let minH = Infinity, maxH = -Infinity;
  for (const v of data) if (v > -1000) { minH = Math.min(minH, v); maxH = Math.max(maxH, v); }
  const grid = new Uint16Array(cols * rows);
  for (let i = 0; i < data.length; i++) grid[i] = Math.round(((data[i] > -1000 ? data[i] : minH) - minH) * 100);
  console.log(`Elevation ${minH.toFixed(1)}–${maxH.toFixed(1)} m`);

  // Tree canopy height (Meta & WRI 1 m global canopy height map, derived from satellite imagery)
  console.log('Downloading tree canopy heights…');
  const canopy = await fetchCanopy(cols, rows, bounds);
  let treeCells = 0;
  for (const v of canopy) if (v >= 4) treeCells++;
  console.log(`Trees (4 m+) cover ${((100 * treeCells) / canopy.length).toFixed(0)}% of the area`);

  // Scorecard corrections (par, stroke index, tee names and ratings).
  const overrides = JSON.parse(await readFile(new URL('./course-overrides.json', import.meta.url), 'utf8'));
  for (const h of holes) {
    if (overrides.par?.[h.ref]) h.par = overrides.par[h.ref];
    if (overrides.strokeIndex?.[h.ref - 1]) h.handicap = overrides.strokeIndex[h.ref - 1];
  }

  await mkdir(OUT, { recursive: true });
  await writeFile(new URL('terrain.bin', OUT), Buffer.from(grid.buffer));
  await writeFile(new URL('canopy.bin', OUT), Buffer.from(canopy.buffer));
  const course = {
    name: 'Cedar Crest',
    fetched: new Date().toISOString().slice(0, 10),
    source: 'OpenStreetMap contributors (ODbL); USGS 3DEP elevation',
    origin, metersPerDeg: { x: kx, y: ky },
    bounds,
    terrain: { file: 'terrain.bin', cols, rows, cell: CELL, minX: bounds.minX, minY: bounds.minY, minH, maxH, scale: 0.01 },
    canopy: { file: 'canopy.bin', source: 'Meta & World Resources Institute, High Resolution Canopy Height Maps (CC BY 4.0)' },
    boundary: boundaryRings,
    holes, features, paths, trees,
    landmarks: { buildings, parking, roads },
    tees: overrides.tees ?? {},
  };
  await writeFile(new URL('course.json', OUT), JSON.stringify(course));
  console.log('Wrote public/data/course.json and terrain.bin');
}

main().catch((e) => { console.error(e); process.exit(1); });
