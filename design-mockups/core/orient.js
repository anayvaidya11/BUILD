// Orient the generated house like its neighbors.
//
// Uses OpenStreetMap (Overpass API, free, CORS-enabled) around the address:
//   - building footprints within ~150 m: each polygon's dominant edge direction (mod 90 deg) and
//     its long side -> a weighted vote for the neighborhood's long-axis direction (mod 180 deg).
//     Closer buildings count more; very large footprints (schools, stores) are ignored.
//   - streets within ~120 m: the nearest point on a street gives the direction the front door
//     should face.
// Returns directions as unit vectors in the site view's three.js frame (x = WEST, z = NORTH),
// plus counts so callers can tell how much evidence there was.

const OVERPASS = "https://overpass-api.de/api/interpreter";
const M_PER_DEG_LAT = 110540;

function toLocal(lat0, lon0) {
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  return (p) => ({ e: (p.lon - lon0) * kx, n: (p.lat - lat0) * M_PER_DEG_LAT });
}

function polygonArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p.e * q.n - q.e * p.n; }
  return Math.abs(a) / 2;
}

/** Long-axis angle (radians, east-based, mod pi) of a footprint, or null for degenerate shapes. */
function footprintAxis(pts) {
  // dominant edge direction mod 90 deg: average 4*theta weighted by edge length
  let cx = 0, sy = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const de = pts[i + 1].e - pts[i].e, dn = pts[i + 1].n - pts[i].n, len = Math.hypot(de, dn);
    if (len < 0.5) continue;
    const t = Math.atan2(dn, de) * 4;
    cx += Math.cos(t) * len; sy += Math.sin(t) * len;
  }
  if (Math.hypot(cx, sy) < 1e-6) return null;
  const a = Math.atan2(sy, cx) / 4;
  // which of the two perpendicular directions is the long one?
  const ext = (ang) => {
    const ux = Math.cos(ang), uy = Math.sin(ang);
    let lo = Infinity, hi = -Infinity;
    for (const p of pts) { const d = p.e * ux + p.n * uy; lo = Math.min(lo, d); hi = Math.max(hi, d); }
    return hi - lo;
  };
  return ext(a) >= ext(a + Math.PI / 2) ? a : a + Math.PI / 2;
}

export async function neighborhoodOrientation(lat, lon, { signal } = {}) {
  const q = `[out:json][timeout:20];
(
  way(around:150,${lat},${lon})["building"];
  way(around:120,${lat},${lon})["highway"]["highway"!~"footway|path|cycleway|steps|pedestrian|track|service|corridor|bridleway"];
);
out geom;`;
  // Prefer the local proxy in serve.mjs (fast, cached); fall back to Overpass directly.
  let data = null;
  try {
    const r = await fetch(`/api/osm?lat=${lat}&lon=${lon}`, { signal });
    if (r.ok) data = await r.json();
  } catch { /* no proxy: static hosting */ }
  if (!data) {
    const res = await fetch(OVERPASS, { method: "POST", body: new URLSearchParams({ data: q }), signal });
    if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
    data = await res.json();
  }
  const local = toLocal(lat, lon);

  // --- neighborhood long axis (vote with angle doubling: axes are mod 180 deg) ---
  let ax = 0, ay = 0, nBuildings = 0, lot = null;
  for (const w of data.elements ?? []) {
    if (!w.tags?.building || !w.geometry || w.geometry.length < 4) continue;
    const pts = w.geometry.map(local);
    const area = polygonArea(pts);
    if (area < 30 || area > 1500) continue; // skip sheds and big non-houses
    const axis = footprintAxis(pts);
    if (axis === null) continue;
    const c = pts.reduce((s, p) => ({ e: s.e + p.e / pts.length, n: s.n + p.n / pts.length }), { e: 0, n: 0 });
    // the existing house on this lot = nearest footprint to the address point (within ~25 m)
    const dist = Math.hypot(c.e, c.n);
    if (dist < 25 && (!lot || dist < lot.dist)) lot = { dist, pts };
    const wgt = Math.sqrt(area) / (1 + Math.hypot(c.e, c.n) / 40);
    ax += Math.cos(2 * axis) * wgt; ay += Math.sin(2 * axis) * wgt;
    nBuildings++;
  }
  let longAxis = null;
  if (nBuildings >= 1 && Math.hypot(ax, ay) > 1e-6) { // 1 = just the lot's own house (fallback data)
    const a = Math.atan2(ay, ax) / 2; // east-based angle
    longAxis = { x: -Math.cos(a), z: Math.sin(a) }; // three.js: x = west, z = north
  }

  // --- nearest street point -> direction the front should face ---
  let best = null;
  for (const w of data.elements ?? []) {
    if (!w.tags?.highway || !w.geometry || w.geometry.length < 2) continue;
    const pts = w.geometry.map(local);
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1], de = b.e - a.e, dn = b.n - a.n, l2 = de * de + dn * dn;
      const t = l2 ? Math.max(0, Math.min(1, -(a.e * de + a.n * dn) / l2)) : 0;
      const p = { e: a.e + de * t, n: a.n + dn * t }, d = Math.hypot(p.e, p.n);
      if (d > 0.5 && (!best || d < best.d)) best = { d, e: p.e, n: p.n, name: w.tags.name };
    }
  }
  const toStreet = best ? { x: -best.e / best.d, z: best.n / best.d } : null;
  // existing house outline in three.js coords (x = west, z = north), so the lot clearing can cover it
  const lotBuilding = lot ? lot.pts.map((p) => ({ x: -p.e, z: p.n })) : null;
  return { longAxis, toStreet, nBuildings, lotBuilding, street: best?.name ?? null, streetDistance: best?.d ?? null };
}

/**
 * House rotation (radians about +Y). The house is always snapped to the neighborhood grid (its
 * walls parallel/perpendicular to the neighbors'). Then:
 *   mode "street":  pick the grid rotation whose front door faces the street (default; a wide
 *                   house on a street of narrow, deep lots ends up wide-side to the street)
 *   mode "match":   long axis matches the neighbors' long axis; door faces the street side as
 *                   well as it can (may end up sideways)
 * `front` / `long` are the house's local front-normal and long-axis vectors.
 * three's convention for a horizontal vector v: ang(v) = atan2(v.x, v.z); rotating by theta adds theta.
 */
export function houseRotation({ longAxis, toStreet }, front, long, mode = "street") {
  const ang = (v) => Math.atan2(v.x, v.z);
  const faces = (th) => (toStreet ? Math.cos(ang(front) + th - ang(toStreet)) : 0);
  if (longAxis) {
    const base = ang(longAxis) - ang(long);
    const steps = mode === "match" ? [0, 2] : [0, 1, 2, 3];
    return steps.map((k) => base + (k * Math.PI) / 2).reduce((a, b) => (faces(b) > faces(a) ? b : a));
  }
  if (toStreet) return ang(toStreet) - ang(front);
  return null;
}
