import type { GenerateResponse, Layout, RoomProgram } from "./types";

const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} ${res.status}: ${await res.text()}`);
  return res.json();
}

export const generate = (prompt: string, cached = false) =>
  post<GenerateResponse>(`/api/generate${cached ? "?cached=true" : ""}`, { prompt });

export const edit = (program: RoomProgram, layout: Layout, instruction: string) =>
  post<GenerateResponse>("/api/edit", { program, layout, instruction });

export async function sample(): Promise<GenerateResponse> {
  const res = await fetch(`${BASE}/api/sample`);
  if (!res.ok) throw new Error(`sample ${res.status}`);
  return res.json();
}
