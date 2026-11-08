// Server-only Gemini settings for /api/render. GEMINI_API_KEY lives in frontend/.env.local
// (never NEXT_PUBLIC: the key must not reach the browser).
export const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
export const MODELS = {
  main: process.env.GEMINI_IMAGE_MODEL || "gemini-nano-banana-2.1",
  // Cheaper/faster model for the extra turntable frames.
  lite: process.env.GEMINI_IMAGE_MODEL_LITE || "gemini-3.1-flash-lite-image",
} as const;
