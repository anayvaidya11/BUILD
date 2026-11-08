// OpenStreetMap buildings + streets around a point, for orienting the new house like its
// neighbors (see src/build/orient.js). Proxied because the browser request queues behind
// hundreds of 3D-tile downloads. Overpass mirrors race a quick Nominatim fallback (lot building
// + nearest road, same element shape); Overpass wins if it answers within 5 s. Cached per point.
type Pt = { lat: number; lon: number };
type El = { type: string; tags: Record<string, string | undefined>; geometry: Pt[] };
type Res = { elements: El[]; source: string; error?: string };

const MIRRORS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
const UA = { "User-Agent": "Walkthru-hackathon-demo/0.1" }; // Overpass rejects Node's default UA (406)
const cache = new Map<string, Res>();

export async function GET(request: Request) {
  const sp = new URL(request.url).searchParams;
  const lat = Number(sp.get("lat")), lon = Number(sp.get("lon"));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return Response.json({ error: "lat/lon required" }, { status: 400 });
  }
  const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  const hit = cache.get(key);
  if (hit) return Response.json(hit);

  const q = `[out:json][timeout:20];(way(around:150,${lat},${lon})["building"];way(around:120,${lat},${lon})["highway"]["highway"!~"footway|path|cycleway|steps|pedestrian|track|service|corridor|bridleway"];);out geom;`;
  const fallback = nominatim(lat, lon).catch((e): Res => ({ elements: [], source: "none", error: String(e?.message ?? e) }));
  const overpass = Promise.any(MIRRORS.map(async (m): Promise<Res> => {
    const r = await fetch(m, { method: "POST", body: new URLSearchParams({ data: q }), headers: UA, signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    if (!d.elements?.length) throw new Error("empty");
    return { ...d, source: "overpass" };
  }));
  try {
    const data = await overpass;
    cache.set(key, data);
    return Response.json(data);
  } catch { /* fall through to Nominatim */ }
  const data = await fallback;
  if (!data.elements.length) return Response.json({ error: `OSM lookups failed${data.error ? `: ${data.error}` : ""}` }, { status: 502 });
  cache.set(key, data);
  return Response.json(data);
}

async function nominatim(lat: number, lon: number): Promise<Res> {
  const rev = async (zoom: number) => {
    const u = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=${zoom}&polygon_geojson=1`;
    const r = await fetch(u, { headers: UA, signal: AbortSignal.timeout(8000) });
    return r.ok ? r.json() : null;
  };
  const toPts = (c: number[][]) => c.map(([x, y]) => ({ lat: y, lon: x }));
  const elements: El[] = [];
  const bld = await rev(18); // sequential: Nominatim asks for <= 1 request/second
  const road = await rev(16);
  const g = bld?.geojson;
  if (g && (bld.category === "building" || bld.addresstype === "building" || g.type === "Polygon")) {
    const ring = g.type === "Polygon" ? g.coordinates[0] : g.type === "MultiPolygon" ? g.coordinates[0][0] : null;
    if (ring) elements.push({ type: "way", tags: { building: "yes" }, geometry: toPts(ring) });
  }
  const rg = road?.geojson;
  if (rg && road.category === "highway") {
    const lines: number[][][] = rg.type === "LineString" ? [rg.coordinates] : rg.type === "MultiLineString" ? rg.coordinates : [];
    for (const l of lines) elements.push({ type: "way", tags: { highway: road.type || "road", name: road.name }, geometry: toPts(l) });
  }
  return { elements, source: "nominatim" };
}
