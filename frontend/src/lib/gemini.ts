// Server-only Gemini settings for /api/render. GEMINI_API_KEY lives in frontend/.env.local
// (never NEXT_PUBLIC: the key must not reach the browser).
export const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
// Measured 2026-11-08 on one 1024x640 house edit: nano-banana-2.1 16 s, 3.1-flash-image 8 s,
// 3.1-flash-lite-image 3.7 s, all photoreal. The hero shot (reference for every other frame) uses the
// model that keeps the framing closest to the input; the turntable frames use the fastest one.
export const MODELS = {
  main: process.env.GEMINI_IMAGE_MODEL || "gemini-3.1-flash-image",
  lite: process.env.GEMINI_IMAGE_MODEL_LITE || "gemini-3.1-flash-lite-image",
} as const;
