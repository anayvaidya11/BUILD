import { GEMINI_KEY, MODELS } from "@/lib/gemini";

export function GET() {
  return Response.json({ ready: Boolean(GEMINI_KEY), model: MODELS.main, lite: MODELS.lite });
}
