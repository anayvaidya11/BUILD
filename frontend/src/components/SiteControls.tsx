"use client";
// Sidebar controls for the site view: address search, house rotation, roof style, lot flattening.
import { useState } from "react";
import type { SiteLocation } from "./SiteView";
import type { RoofType } from "./HouseExterior";

export interface SiteSettings { location: SiteLocation | null; rotationDeg: number; roof: RoofType; flatten: boolean }

export function SiteControls({ value, onChange }: { value: SiteSettings; onChange: (v: SiteSettings) => void }) {
  const [q, setQ] = useState(value.location?.label ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function search(e: React.FormEvent) {
    e.preventDefault();
    if (!q.trim()) return;
    setBusy(true); setErr(null);
    try {
      const res = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      onChange({ ...value, location: { lat: data.lat, lon: data.lon, label: data.label } });
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded border border-neutral-200 bg-white p-3 text-sm">
      <div className="font-medium">Site</div>
      <form onSubmit={search} className="flex gap-2">
        <input
          className="min-w-0 flex-1 rounded border border-neutral-300 px-2 py-1"
          placeholder="Address, e.g. 1600 Amphitheatre Pkwy"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button className="rounded bg-neutral-900 px-3 py-1 text-white disabled:opacity-50" disabled={busy}>
          {busy ? "…" : "Place"}
        </button>
      </form>
      {err && <div className="text-xs text-amber-700">{err}</div>}
      {value.location && (
        <div className="text-xs text-neutral-500">
          {value.location.label}
          <br />
          {value.location.lat.toFixed(5)}, {value.location.lon.toFixed(5)}
        </div>
      )}

      <label className="flex flex-col gap-1">
        <span className="text-xs text-neutral-600">Rotate house: {value.rotationDeg}°</span>
        <input type="range" min={-180} max={180} step={5} value={value.rotationDeg}
          onChange={(e) => onChange({ ...value, rotationDeg: Number(e.target.value) })} />
      </label>

      <div className="flex gap-2 text-xs">
        {(["gable", "flat"] as const).map((r) => (
          <button key={r} type="button"
            className={`rounded border px-2 py-1 ${value.roof === r ? "border-blue-600 bg-blue-50 text-blue-700" : "border-neutral-300"}`}
            onClick={() => onChange({ ...value, roof: r })}>
            {r === "gable" ? "Gable roof" : "Flat roof"}
          </button>
        ))}
      </div>

      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" checked={value.flatten} onChange={(e) => onChange({ ...value, flatten: e.target.checked })} />
        Clear the lot (flatten existing buildings and trees)
      </label>
    </div>
  );
}
