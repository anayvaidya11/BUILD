"use client";
// Role 4: live checker panel. Shows each rule and each fix round.
// TODO(role 4): stream rounds as they happen (SSE) instead of after the fact.
import type { GenerateResponse } from "@/lib/types";

const LABELS: Record<string, string> = {
  no_overlap_in_footprint: "No overlaps, fits footprint",
  all_rooms_reachable: "Every room reachable",
  bedroom_exterior_wall: "Bedrooms: window wall + door",
  public_bathroom: "Bathroom off a common space",
  kitchen_adjacent: "Kitchen next to dining/living",
  min_hall_and_door_width: "Halls ≥ 3 ft, doors ≥ 2'8\"",
  sizes_within_10pct: "Sizes within 10%",
};

export function CheckerPanel({ result }: { result: GenerateResponse | null }) {
  if (!result) return <div className="text-sm text-neutral-500">Rules appear here after generation.</div>;
  return (
    <div className="space-y-3 text-sm">
      <ul className="space-y-1">
        {result.layout.checks.map((c) => (
          <li key={c.rule} className="flex gap-2">
            <span className={c.pass ? "text-green-600" : "text-red-600"}>{c.pass ? "✓" : "✗"}</span>
            <span>{LABELS[c.rule] ?? c.rule}</span>
          </li>
        ))}
      </ul>
      {result.rounds.length > 0 && (
        <div className="space-y-2">
          <div className="font-medium">Fix rounds</div>
          {result.rounds.map((r) => (
            <div key={r.round} className="rounded border border-neutral-200 p-2">
              <div className="text-neutral-500">Round {r.round}: {r.failed.length} failed, sent back to Claude</div>
              {r.failed.map((f) => <div key={f.rule} className="text-red-600">{f.message}</div>)}
            </div>
          ))}
        </div>
      )}
      <div className="text-neutral-500">
        {result.elapsed_s.toFixed(1)} s · {result.rounds.length} fix rounds · attempt {result.attempts}
        {result.cached && <span className="ml-2 font-medium text-amber-600">CACHED BACKUP</span>}
      </div>
    </div>
  );
}
