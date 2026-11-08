import { connection } from "next/server";
import { GEMINI_KEY, MODELS } from "@/lib/gemini";

export async function GET() {
  await connection(); // read the key at request time, not at build time
  return Response.json({ ready: Boolean(GEMINI_KEY), model: MODELS.main, lite: MODELS.lite });
}
