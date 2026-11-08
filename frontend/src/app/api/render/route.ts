// Photoreal shots for the site view: { image: dataURL, prompt, tier?, reference? } -> { image: dataURL }
// via Gemini's image-edit model. Ported from design-mockups/serve.mjs. The capture hides the Google
// tiles, so only our house on a plain backdrop is sent to the model.
import { GEMINI_KEY, MODELS } from "@/lib/gemini";

export const maxDuration = 120;
const LIMIT = 12 * 1024 * 1024;
const dataUrl = (u: unknown) => (typeof u === "string" ? u.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/) : null);

export async function POST(request: Request) {
  if (!GEMINI_KEY) {
    return Response.json({ error: "No GEMINI_API_KEY. Add it to frontend/.env.local and restart the dev server." }, { status: 503 });
  }
  const raw = await request.text();
  if (raw.length > LIMIT) return Response.json({ error: "Request too large" }, { status: 413 });
  let body: { image?: unknown; prompt?: unknown; tier?: unknown; reference?: unknown };
  try { body = JSON.parse(raw); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }

  const { image, prompt, tier = "main", reference } = body;
  const m = dataUrl(image);
  const ref = reference ? dataUrl(reference) : null;
  if (!m || typeof prompt !== "string" || prompt.length > 4000 || (tier !== "main" && tier !== "lite") || (reference && !ref)) {
    return Response.json({ error: "Expected { image: data URL, prompt, tier?: 'main'|'lite', reference?: data URL }" }, { status: 400 });
  }
  const model = MODELS[tier];
  const parts: object[] = [{ inline_data: { mime_type: m[1], data: m[2] } }];
  if (ref) parts.push({ inline_data: { mime_type: ref[1], data: ref[2] } });
  parts.push({ text: prompt });

  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": GEMINI_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseModalities: ["TEXT", "IMAGE"] } }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg: string = data.error?.message || `Gemini HTTP ${r.status}`;
    const friendly = /free_tier/.test(msg) ? "Gemini image models need billing enabled on this key's project (free tier = 0)." : msg;
    return Response.json({ error: friendly }, { status: 502 });
  }
  const out = data.candidates?.[0]?.content?.parts ?? [];
  const img = out.map((p: { inline_data?: { mime_type?: string; data: string }; inlineData?: { mimeType?: string; data: string } }) => p.inline_data || p.inlineData).find(Boolean);
  if (!img) {
    const why = data.candidates?.[0]?.finishReason || out.map((p: { text?: string }) => p.text).filter(Boolean).join(" ") || "no image returned";
    return Response.json({ error: `Gemini: ${why}` }, { status: 502 });
  }
  return Response.json({ image: `data:${img.mime_type || img.mimeType};base64,${img.data}`, model });
}
