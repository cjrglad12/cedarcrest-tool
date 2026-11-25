// Temporary: find the course outline in OpenStreetMap, then print the fetch config.
const q = '[out:json][timeout:60];nwr["leisure"="golf_course"](around:12000,32.63,-97.04);out tags bb;';
let r;
for (const host of ['overpass-api.de', 'overpass.kumi.systems', 'overpass.private.coffee']) {
  try {
    const res = await fetch(`https://${host}/api/interpreter`, { method: 'POST', headers: { 'User-Agent': 'cedarcrest-tool/1.0 (personal golf planner)', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ data: q }) });
    if (!res.ok) throw new Error(res.status);
    r = await res.json(); break;
  } catch (e) { console.error(host, e.message); }
}
for (const e of r.elements) console.error(e.type, e.id, e.tags.name, JSON.stringify(e.bounds));
const c = r.elements.find((e) => /tangle\s*ridge/i.test(e.tags.name ?? ''));
if (!c) throw new Error('Tangle Ridge outline not found');
const b = c.bounds, m = 0.002;
console.log(JSON.stringify({ match: c.type === 'way' ? { way: String(c.id) } : { name: c.tags.name }, search: { minLon: b.minlon - m, minLat: b.minlat - m, maxLon: b.maxlon + m, maxLat: b.maxlat + m } }));
