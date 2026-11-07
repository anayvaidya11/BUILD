"use client";
// Role 4: corner minimap during the walkthrough.
import type { Layout, Point } from "@/lib/types";
import { PlanView } from "./PlanView";

export function Minimap({ layout, player }: { layout: Layout; player: (Point & { heading: number }) | null }) {
  return (
    <div className="pointer-events-none absolute right-4 top-4 h-40 w-56 rounded bg-white/90 p-1 shadow">
      <PlanView layout={layout} player={player} compact />
    </div>
  );
}
