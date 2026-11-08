// Dev server for the design mockups: static files + POST /api/render (photoreal shots).
//
//   node design-mockups/serve.mjs            -> http://localhost:3102
//
// /api/render takes { image: dataURL, prompt } and returns { image: dataURL } from Gemini's
// image-edit model. The Gemini key stays here on the server: set GEMINI_API_KEY in the
// environment or in design-mockups/.env.local (git-ignored). Optional GEMINI_IMAGE_MODEL.
// No dependencies (Node 18+).
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { extname, join, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3102);

function loadEnvFile() {
  try {
    for (const line of readFileSync(join(ROOT, ".env.local"), "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch { /* optional */ }
}
loadEnvFile();
const KEY = process.env.GEMINI_API_KEY || "";
const MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-nano-banana-2.1";
// Cheaper/faster model for the extra coverage views (sides, back).
const LITE_MODEL = process.env.GEMINI_IMAGE_MODEL_LITE || "gemini-3.1-flash-lite-image";
const MODELS = { main: MODEL, lite: LITE_MODEL };

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".webp": "image/webp", ".png": "image/png",
  ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon",
};
const PRIVATE = new Set([".env.local", "serve.mjs"]);

async function readBody(req, limit = 12 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > limit) throw new Error("Request too large"); chunks.push(c); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function render(req, res) {
  if (!KEY) return send(res, 503, { error: "No GEMINI_API_KEY. Add it to design-mockups/.env.local and restart serve.mjs." });
  const { image, prompt, tier = "main", reference } = await readBody(req);
  const dataUrl = (u) => typeof u === "string" && u.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/);
  const m = dataUrl(image), ref = reference ? dataUrl(reference) : null;
  if (!m || typeof prompt !== "string" || prompt.length > 4000 || !MODELS[tier] || (reference && !ref)) {
    return send(res, 400, { error: "Expected { image: data URL, prompt, tier?: 'main'|'lite', reference?: data URL }" });
  }
  const model = MODELS[tier];
  // Optional reference photo (an already-rendered view) keeps materials consistent across views.
  const reqParts = [{ inline_data: { mime_type: m[1], data: m[2] } }];
  if (ref) reqParts.push({ inline_data: { mime_type: ref[1], data: ref[2] } });
  reqParts.push({ text: prompt });
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: reqParts }],
      generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = data.error?.message || `Gemini HTTP ${r.status}`;
    // Image models have a free-tier quota of 0: the key's project needs billing turned on.
    const friendly = /free_tier/.test(msg) ? "Gemini image models need billing enabled on this key's project (free tier = 0)." : msg;
    return send(res, 502, { error: friendly });
  }
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const img = parts.map((p) => p.inline_data || p.inlineData).find(Boolean);
  if (!img) {
    const why = data.candidates?.[0]?.finishReason || parts.map((p) => p.text).filter(Boolean).join(" ") || "no image returned";
    return send(res, 502, { error: `Gemini: ${why}` });
  }
  send(res, 200, { image: `data:${img.mime_type || img.mimeType};base64,${img.data}`, model });
}

// OpenStreetMap buildings + streets around a point, for orienting the house like its neighbors.
// Proxied (instead of called from the page) because the browser request queues behind hundreds
// of 3D-tile downloads; Node gets it in ~2 s. Cached per rounded location; two public mirrors.
const OSM_MIRRORS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
const osmCache = new Map();
async function osm(req, res, url) {
  const lat = Number(url.searchParams.get("lat")), lon = Number(url.searchParams.get("lon"));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return send(res, 400, { error: "lat/lon required" });
  const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  if (osmCache.has(key)) return send(res, 200, osmCache.get(key));
  const q = `[out:json][timeout:20];(way(around:150,${lat},${lon})["building"];way(around:120,${lat},${lon})["highway"]["highway"!~"footway|path|cycleway|steps|pedestrian|track|service|corridor|bridleway"];);out geom;`;
  // Race the Overpass mirrors (full neighborhood) against a quick Nominatim fallback (just the
  // lot's own building + the nearest street); take Overpass if it answers within ~5 s.
  const UA = { "User-Agent": "Walkthru-hackathon-demo/0.1" };
  const fallback = nominatimFallback(lat, lon, UA).catch((e) => ({ elements: [], source: "none", error: e.message })); // in parallel
  const overpass = Promise.any(OSM_MIRRORS.map(async (m) => {
    const r = await fetch(m, { method: "POST", body: new URLSearchParams({ data: q }), headers: UA, signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    if (!d.elements?.length) throw new Error("empty");
    return { ...d, source: "overpass" };
  }));
  try {
    const data = await overpass;
    osmCache.set(key, data);
    return send(res, 200, data);
  } catch { /* fall through */ }
  const data = await fallback;
  if (!data.elements.length) return send(res, 502, { error: `OSM lookups failed${data.error ? `: ${data.error}` : ""}` });
  osmCache.set(key, data);
  send(res, 200, data);
}

/** Nominatim reverse geocoding with geometry: the building at the point and the nearest road,
 *  returned in Overpass's element shape so the client parses one format. */
async function nominatimFallback(lat, lon, headers) {
  const rev = async (zoom) => {
    const u = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=${zoom}&polygon_geojson=1`;
    const r = await fetch(u, { headers, signal: AbortSignal.timeout(8000) });
    return r.ok ? r.json() : null;
  };
  const toPts = (coords) => coords.map(([x, y]) => ({ lat: y, lon: x }));
  const elements = [];
  const [bld, road] = [await rev(18), await rev(16)]; // sequential: Nominatim asks for <= 1 req/s
  const g = bld?.geojson;
  if (g && (bld.category === "building" || bld.addresstype === "building" || g.type === "Polygon")) {
    const ring = g.type === "Polygon" ? g.coordinates[0] : g.type === "MultiPolygon" ? g.coordinates[0][0] : null;
    if (ring) elements.push({ type: "way", tags: { building: "yes" }, geometry: toPts(ring) });
  }
  const rg = road?.geojson;
  if (rg && road.category === "highway") {
    const lines = rg.type === "LineString" ? [rg.coordinates] : rg.type === "MultiLineString" ? rg.coordinates : [];
    for (const l of lines) elements.push({ type: "way", tags: { highway: road.type || "road", name: road.name }, geometry: toPts(l) });
  }
  return { elements, source: "nominatim" };
}

function send(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === "/api/render" && req.method === "POST") return await render(req, res);
    if (url.pathname === "/api/osm") return await osm(req, res, url);
    if (url.pathname === "/api/render/status") return send(res, 200, { ready: Boolean(KEY), model: MODEL, lite: LITE_MODEL });
    let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
    if (path.endsWith("/")) path += "index.html";
    const file = join(ROOT, path);
    if (!file.startsWith(ROOT) || PRIVATE.has(path.replace(/^\//, ""))) return send(res, 404, { error: "Not found" });
    if ((await stat(file)).isDirectory()) { res.writeHead(302, { Location: url.pathname + "/" }); return res.end(); }
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(await readFile(file));
  } catch (e) {
    if (e.code === "ENOENT") return send(res, 404, { error: "Not found" });
    console.error(e); send(res, 500, { error: String(e.message || e) });
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`mockups on http://localhost:${PORT}  (render: ${KEY ? MODEL : "no GEMINI_API_KEY"})`);
});
