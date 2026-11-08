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
  const { image, prompt } = await readBody(req);
  const m = typeof image === "string" && image.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/);
  if (!m || typeof prompt !== "string" || prompt.length > 4000) return send(res, 400, { error: "Expected { image: data URL, prompt }" });
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ inline_data: { mime_type: m[1], data: m[2] } }, { text: prompt }] }],
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
  send(res, 200, { image: `data:${img.mime_type || img.mimeType};base64,${img.data}`, model: MODEL });
}

function send(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === "/api/render" && req.method === "POST") return await render(req, res);
    if (url.pathname === "/api/render/status") return send(res, 200, { ready: Boolean(KEY), model: MODEL });
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
